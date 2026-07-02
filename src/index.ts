#!/usr/bin/env node

/**
 * edge-ota CLI
 *
 * Phase 1: Build / Upload
 * ─────────────────────────────────────────────────────────────────────────
 * 1. `edge-ota init`   – Generate ECDSA P-256 key pair, write config + private key.
 * 2. `edge-ota push`   – Run `expo export`, collect JS bundle + assets, compute
 *                        per-asset SHA-256 hashes, sign the upload payload with the
 *                        private key, POST a multipart/form-data to /api/updates.
 * 3. `edge-ota status` – List recent releases and their channel assignments.
 *
 * The server verifies the ECDSA signature before accepting the bundle,
 * then stores assets on disk (server-node) or R2 (worker-oss) and
 * records the update in the database.
 *
 * From that point the Expo Updates SDK handshake is:
 *   GET /api/updates
 *   expo-platform: ios | android
 *   expo-runtime-version: <semver>
 *   expo-channel-name: production | staging | …
 *
 * The server responds with an Expo Updates v1 manifest JSON (signed if a
 * public key is configured) and the SDK fetches launchAsset.url to swap
 * the active bundle.
 */

import { Command } from "commander";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { createWriteStream } from "fs";
import archiver from "archiver";
import readline from "readline";
import {
  generateECDSAKeyPair,
  signPayload,
  sha256Hex
} from "./core/index.js";

// ─── Auto-load .env from the project root ────────────────────────────────────
// Lets users store EDGE_OTA_TOKEN in a .env file without shell exports.
try {
  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = val;
    }
  }
} catch { /* silently skip if .env is unreadable */ }

// ─── ANSI Styling Helpers ───────────────────────────────────────────────────

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  underline: "\x1b[4m",
  
  // Foreground Colors
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

function printBanner() {
  const line = `${colors.dim}${"-".repeat(48)}${colors.reset}`;
  console.log(`\n${line}`);
  console.log(`  ${colors.bold}${colors.white}edge-ota${colors.reset}  ${colors.dim}v0.2.4 · Zero-SDK OTA for Expo${colors.reset}`);
  console.log(`  ${colors.dim}by Renbo Studios · renbostudios.com${colors.reset}`);
  console.log(`${line}\n`);
}

// ─── Config helpers ──────────────────────────────────────────────────────────

interface EdgeOTAConfig {
  serverUrl: string;
  projectId?: string;
  publicKey: string;
}

function askQuestion(query: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(query, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function updateAppJson(cwd: string, serverUrl: string, projectId?: string) {
  const appJsonPath = path.resolve(cwd, "app.json");
  if (!fs.existsSync(appJsonPath)) {
    console.log("⚠️   app.json not found in this directory. Skipping auto-update.");
    return;
  }

  try {
    const raw = fs.readFileSync(appJsonPath, "utf-8");
    const data = JSON.parse(raw);

    if (!data.expo) data.expo = {};
    if (!data.expo.updates) data.expo.updates = {};

    const updateUrl = projectId
      ? `${serverUrl.replace(/\/$/, "")}/api/projects/${projectId}/updates`
      : `${serverUrl.replace(/\/$/, "")}/api/updates`;
    data.expo.updates.url = updateUrl;

    fs.writeFileSync(appJsonPath, JSON.stringify(data, null, 2), "utf-8");
    console.log(`  ${colors.dim}app.json${colors.reset}  updates.url set`);
  } catch (error: any) {
    console.error(`  ${colors.red}error${colors.reset}  Failed to update app.json: ${error.message}`);
  }
}

function loadConfig(cwd: string): EdgeOTAConfig {
  const configPath = path.resolve(cwd, "edge-ota.config.json");
  if (!fs.existsSync(configPath)) {
    console.error(
      "❌  edge-ota.config.json not found. Run `edge-ota init` first."
    );
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configPath, "utf-8")) as EdgeOTAConfig;
}

function loadPrivateKey(cwd: string): string {
  const keyPath = path.resolve(cwd, ".edge-ota.private.key");
  if (!fs.existsSync(keyPath)) {
    console.error(
      "❌  .edge-ota.private.key not found. Run `edge-ota init` first."
    );
    process.exit(1);
  }
  return fs.readFileSync(keyPath, "utf-8");
}

// ─── Archive helper ──────────────────────────────────────────────────────────

function zipDirectory(sourceDir: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const archive = archiver("zip", { zlib: { level: 9 } });
    const stream  = createWriteStream(outPath);
    archive.directory(sourceDir, false);
    archive.on("error", reject);
    stream.on("close", resolve);
    archive.pipe(stream);
    archive.finalize();
  });
}

// ─── SHA-256 of a file ───────────────────────────────────────────────────────

async function hashFile(filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);
  return sha256Hex(buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer);
}

// ─── Collect Expo export assets ──────────────────────────────────────────────

interface AssetEntry {
  /** Path on disk */
  localPath: string;
  /** Key used in the manifest (relative to the dist dir) */
  key: string;
  contentType: string;
  hash: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".js":    "application/javascript",
  ".hbc":   "application/javascript",
  ".json":  "application/json",
  ".png":   "image/png",
  ".jpg":   "image/jpeg",
  ".jpeg":  "image/jpeg",
  ".gif":   "image/gif",
  ".svg":   "image/svg+xml",
  ".ttf":   "font/ttf",
  ".otf":   "font/otf",
  ".woff":  "font/woff",
  ".woff2": "font/woff2",
  ".mp4":   "video/mp4",
  ".webm":  "video/webm"
};

async function collectAssets(distDir: string): Promise<AssetEntry[]> {
  const entries: AssetEntry[] = [];

  function walk(dir: string) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else {
        const ext  = path.extname(name).toLowerCase();
        const ct   = CONTENT_TYPES[ext] || "application/octet-stream";
        const key  = path.relative(distDir, full).replace(/\\/g, "/");
        entries.push({ localPath: full, key, contentType: ct, hash: "" });
      }
    }
  }

  walk(distDir);

  // Hash all assets in parallel
  await Promise.all(
    entries.map(async (e) => {
      e.hash = await hashFile(e.localPath);
    })
  );

  return entries;
}

// ─── Detect the JS bundle within the Expo export output ──────────────────────

function findBundle(distDir: string, platform: string): string | null {
  // Expo SDK 50+ writes: dist/_expo/static/js/<platform>/<hash>.js (or .hbc)
  const expoStaticJs = path.join(distDir, "_expo", "static", "js", platform);
  if (fs.existsSync(expoStaticJs)) {
    const files = fs.readdirSync(expoStaticJs).filter(f => f.endsWith(".js") || f.endsWith(".hbc"));
    if (files.length) return path.join(expoStaticJs, files[0]);
  }

  // Fallback: older SDK flat layout
  const flatJs = path.join(distDir, `index.${platform}.js`);
  if (fs.existsSync(flatJs)) return flatJs;
  const flatHbc = path.join(distDir, `index.${platform}.hbc`);
  if (fs.existsSync(flatHbc)) return flatHbc;

  // Any .js or .hbc at root
  const rootJs = fs.readdirSync(distDir).find(f => f.endsWith(".js") || f.endsWith(".hbc"));
  if (rootJs) return path.join(distDir, rootJs);

  return null;
}

// ─── CLI definition ──────────────────────────────────────────────────────────

const program = new Command();

program
  .name("edge-ota")
  .description("Zero-SDK, self-hostable OTA update platform for Expo")
  .version("0.2.0");

// ──────────────────────────────────────────────────────
// edge-ota init
// ──────────────────────────────────────────────────────
program
  .command("init")
  .description(
    "Generate an ECDSA P-256 key pair and write edge-ota.config.json"
  )
  .option(
    "-s, --server <url>",
    "EdgeOTA server URL"
  )
  .option(
    "--project <id>",
    "EdgeOTA Project ID (optional)"
  )
  .action(async (options) => {
    printBanner();
    let serverUrl = options.server;
    let projectId = options.project;

    if (!serverUrl) {
      console.log(`  ${colors.dim}no --server flag provided${colors.reset}`);
      const answer = await askQuestion(`  server url [http://localhost:3000]: `);
      if (!answer) {
        serverUrl = "http://localhost:3000";
      } else if (answer.toLowerCase().includes("host")) {
        console.log(`  ${colors.yellow}hint${colors.reset}  use your hosted EdgeOTA instance (e.g. https://api.edge-ota.renbo.site)`);
        const hostedAnswer = await askQuestion(`  hosted server url: `);
        serverUrl = hostedAnswer.trim() || "http://localhost:3000";
      } else {
        serverUrl = answer;
      }
    }

    if (!projectId && !options.server) {
      const pAnswer = await askQuestion(`  project id (optional, press Enter to skip): `);
      if (pAnswer.trim()) projectId = pAnswer.trim();
    }

    serverUrl = serverUrl.replace(/\/$/, "");

    console.log(`  ${colors.dim}generating ECDSA P-256 key pair...${colors.reset}`);
    const keys = await generateECDSAKeyPair();

    const config: EdgeOTAConfig = { serverUrl, publicKey: keys.publicKey };
    if (projectId) config.projectId = projectId;

    const cwd = process.cwd();
    fs.writeFileSync("edge-ota.config.json", JSON.stringify(config, null, 2));
    fs.writeFileSync(".edge-ota.private.key", keys.privateKey, { mode: 0o600 });

    const gitignorePath = ".gitignore";
    const gitignoreEntry = ".edge-ota.private.key";
    if (fs.existsSync(gitignorePath)) {
      const current = fs.readFileSync(gitignorePath, "utf-8");
      if (!current.includes(gitignoreEntry)) {
        fs.appendFileSync(gitignorePath, `\n${gitignoreEntry}\n`);
      }
    } else {
      fs.writeFileSync(gitignorePath, `${gitignoreEntry}\n`);
    }

    updateAppJson(cwd, serverUrl, projectId);

    const targetUrlStr = projectId
      ? `${serverUrl}/api/projects/${projectId}/updates`
      : `${serverUrl}/api/updates`;

    const sep = `${colors.dim}${"-".repeat(48)}${colors.reset}`;
    console.log(`\n  ${colors.green}✓${colors.reset}  ${colors.bold}initialised${colors.reset}`);
    console.log(sep);
    console.log(`  config   ${colors.cyan}edge-ota.config.json${colors.reset}`);
    console.log(`  key      ${colors.yellow}.edge-ota.private.key${colors.reset}  ${colors.dim}(keep secret)${colors.reset}`);
    console.log(`  endpoint ${colors.dim}${targetUrlStr}${colors.reset}`);
    console.log(sep);
    console.log(`\n  ${colors.bold}public key${colors.reset}  ${colors.dim}paste into dashboard → Settings → General${colors.reset}\n`);
    console.log(`${colors.dim}${keys.publicKey}${colors.reset}\n`);
  });

// ──────────────────────────────────────────────────────
// edge-ota push
// ──────────────────────────────────────────────────────
program
  .command("push")
  .description(
    "Export the Expo bundle, compute per-asset hashes, sign & upload to the EdgeOTA server"
  )
  .option("-c, --channel <channel>", "Deployment channel", "production")
  .option("-r, --runtime <version>", "React Native runtime version (semver)", "1.0.0")
  .option(
    "-p, --platform <platform>",
    "Target platform: ios | android | all",
    "all"
  )
  .option("--project <id>", "Project ID (optional, overrides config)")
  .option("-t, --token <token>", "Deploy key token (or set EDGE_OTA_TOKEN env var)")
  .option("--skip-export", "Skip expo export (use existing ./dist directory)")
  .option("--dry-run", "Build and sign the payload but do NOT upload")
  .action(async (options) => {
    const cwd = process.cwd();
    const config     = loadConfig(cwd);
    const privateKey = loadPrivateKey(cwd);

    // Resolve token — CLI flag > env var
    const token = options.token || process.env.EDGE_OTA_TOKEN;
    if (!token) {
      console.error(`${colors.bold}${colors.red}❌  Auth token required. Use --token <token> or set EDGE_OTA_TOKEN env var.${colors.reset}`);
      console.error(`   Generate a deploy key from your dashboard → Keys page.`);
      process.exit(1);
    }

    // Resolve project ID — CLI flag > config file
    const projectId = options.project || config.projectId;

    // Build the correct upload URL
    const uploadUrl = projectId
      ? `${config.serverUrl}/api/projects/${projectId}/updates`
      : `${config.serverUrl}/api/updates`;

    // ── Step 1: Build ────────────────────────────────────────────────────────
    printBanner();
    const distDir = path.resolve(cwd, "dist");

    if (!options.skipExport) {
      console.log(`  ${colors.dim}running expo export...${colors.reset}`);
      try {
        execSync("npx expo export", { stdio: "inherit", cwd });
      } catch {
        console.error(`  ${colors.red}error${colors.reset}  expo export failed`);
        process.exit(1);
      }
    } else {
      console.log(`  ${colors.dim}skipping expo export (--skip-export)${colors.reset}`);
    }

    if (!fs.existsSync(distDir)) {
      console.error(`  ${colors.red}error${colors.reset}  ./dist not found after export`);
      process.exit(1);
    }

    console.log(`  ${colors.dim}collecting assets...${colors.reset}`);
    const assets = await collectAssets(distDir);
    console.log(`  ${colors.dim}found ${assets.length} asset(s)${projectId ? ` · project ${projectId}` : ""}${colors.reset}`);

    const platforms = options.platform === "all" ? ["ios", "android"] : [options.platform];
    const sep = `${colors.dim}${"-".repeat(48)}${colors.reset}`;

    for (const platform of platforms) {
      console.log(`\n${sep}`);
      console.log(`  ${colors.bold}${platform}${colors.reset}`);
      console.log(sep);

      const bundlePath = findBundle(distDir, platform);
      if (!bundlePath) {
        console.warn(`  ${colors.yellow}warn${colors.reset}  no bundle found for ${platform}, skipping`);
        continue;
      }

      const bundleHash = await hashFile(bundlePath);

      const payloadObj = {
        channel:        options.channel,
        runtimeVersion: options.runtime,
        platform,
        bundleHash,
        timestamp:      Date.now(),
        assetCount:     assets.length
      };
      const payloadStr = JSON.stringify(payloadObj);

      console.log(`  signing    ECDSA P-256`);
      const signature = await signPayload(payloadStr, privateKey);
      console.log(`  sig        ${colors.dim}${signature.slice(0, 24)}…${colors.reset}`);

      if (options.dryRun) {
        console.log(`  ${colors.yellow}dry-run${colors.reset}   upload skipped`);
        console.log("  payload   ", payloadObj);
        continue;
      }

      const zipPath = path.resolve(cwd, `update-bundle-${platform}.zip`);
      console.log(`  packing    bundle → zip`);
      await zipDirectory(distDir, zipPath);

      const zipBuffer = fs.readFileSync(zipPath);
      const form = new FormData();
      form.append("bundle",    new Blob([zipBuffer], { type: "application/zip" }), `bundle-${platform}.zip`);
      form.append("payload",   payloadStr);
      form.append("signature", signature);
      form.append("platform",  platform);

      console.log(`  uploading  ${colors.dim}${uploadUrl}${colors.reset}`);
      const response = await fetch(uploadUrl, {
        method:  "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          ...(projectId ? { "X-Project-Id": projectId } : {})
        },
        body: form
      });

      fs.unlinkSync(zipPath);

      if (response.ok) {
        const body = await response.json().catch(() => ({})) as any;
        const updateId = body.updateId || "unknown";
        console.log(`  ${colors.green}✓${colors.reset}  deployed`);
        console.log(`  id         ${colors.dim}${updateId}${colors.reset}`);
        console.log(`  channel    ${options.channel}`);
        console.log(`  runtime    ${options.runtime}`);
        console.log(`  bundle     ${colors.dim}${bundleHash.slice(0, 16)}…${colors.reset}`);
      } else {
        const text = await response.text();
        console.error(`  ${colors.red}error${colors.reset}  upload failed (HTTP ${response.status}): ${text}`);
        process.exit(1);
      }
    }

    console.log(`\n${colors.dim}${"-".repeat(48)}${colors.reset}`);
    console.log(`  ${colors.green}✓${colors.reset}  ${colors.bold}done${colors.reset}  update will be applied on next OTA sync`);
    console.log(`${colors.dim}${"-".repeat(48)}${colors.reset}\n`);
  });

// ──────────────────────────────────────────────────────
// edge-ota status
// ──────────────────────────────────────────────────────
program
  .command("status")
  .description("List recent releases from the EdgeOTA server")
  .option("-t, --token <token>", "Auth token (or set EDGE_OTA_TOKEN env var)")
  .option("-n, --limit <n>", "Number of releases to show", "10")
  .option("--project <id>", "Project ID (optional)")
  .action(async (options) => {
    const cwd    = process.cwd();
    const config = loadConfig(cwd);
    const token  = options.token || process.env.EDGE_OTA_TOKEN;
    const projectId = options.project || config.projectId;

    if (!token) {
      console.error(`  ${colors.red}error${colors.reset}  token required — set EDGE_OTA_TOKEN in .env or use -t`);
      process.exit(1);
    }

    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (projectId) headers["x-project-id"] = projectId;

    const res = await fetch(`${config.serverUrl}/api/releases`, { headers });

    if (!res.ok) {
      console.error(`  ${colors.red}error${colors.reset}  failed to fetch releases (HTTP ${res.status})`);
      process.exit(1);
    }

    const releases = (await res.json()) as any[];
    if (!releases.length) {
      console.log(`  ${colors.dim}no releases found${colors.reset}`);
      return;
    }

    const rows = releases.slice(0, parseInt(options.limit)).map((r: any) => ({
      ID:        r.id.slice(0, 8),
      Channel:   r.channel,
      Runtime:   r.runtime,
      Status:    r.status,
      Published: r.published,
      By:        r.publisher
    }));

    console.table(rows);
  });

// ──────────────────────────────────────────────────────
// edge-ota keygen
// ──────────────────────────────────────────────────────
program
  .command("keygen")
  .description("Generate a fresh ECDSA key pair (prints to stdout, does not write files)")
  .action(async () => {
    const keys = await generateECDSAKeyPair();
    const sep = `${colors.dim}${"-".repeat(48)}${colors.reset}`;
    console.log(`\n${sep}`);
    console.log(`  ${colors.bold}private key${colors.reset}  ${colors.dim}keep secret — never commit${colors.reset}`);
    console.log(sep);
    console.log(keys.privateKey);
    console.log(`\n${sep}`);
    console.log(`  ${colors.bold}public key${colors.reset}   ${colors.dim}paste into dashboard → Settings → General${colors.reset}`);
    console.log(sep);
    console.log(keys.publicKey);
  });

program.parse(process.argv);
