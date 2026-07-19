#!/usr/bin/env node

/**
 * edge-ota CLI  — Zero-SDK, self-hostable OTA updates for Expo
 * by Renbo Studios  —  Mobile App Development Studio
 * https://renbostudios.com
 *
 * Commands:
 *   edge-ota login    — Authenticate and save credentials globally
 *   edge-ota logout   — Remove stored credentials
 *   edge-ota init     — Register project, generate signing keys, configure app.json
 *   edge-ota push     — Export bundle and publish an OTA update
 *   edge-ota status   — List recent deployments for this project
 *   edge-ota keygen   — Generate a new ECDSA key pair (prints to stdout)
 */

import { Command } from "commander";
import { execSync, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";
import {
  generateECDSAKeyPair,
  signPayload,
  sha256Hex
} from "./core/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Global Config Paths ─────────────────────────────────────────────────────

const GLOBAL_CONFIG_DIR  = path.join(os.homedir(), ".config", "edge-ota");
const GLOBAL_CONFIG_FILE = path.join(GLOBAL_CONFIG_DIR, "config.json");
const GLOBAL_KEYS_DIR    = path.join(GLOBAL_CONFIG_DIR, "keys");

interface GlobalConfig {
  token:     string;
  email:     string;
  serverUrl: string;
}

function loadGlobalConfig(): GlobalConfig | null {
  try {
    if (fs.existsSync(GLOBAL_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(GLOBAL_CONFIG_FILE, "utf-8")) as GlobalConfig;
    }
  } catch { /* ignore */ }
  return null;
}

function saveGlobalConfig(config: GlobalConfig): void {
  fs.mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(GLOBAL_CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

function clearGlobalConfig(): void {
  try { fs.rmSync(GLOBAL_CONFIG_FILE); } catch { /* ignore */ }
}

function loadPrivateKey(projectId: string): string | null {
  // 1. Global key store (new location)
  const globalKeyPath = path.join(GLOBAL_KEYS_DIR, `${projectId}.key`);
  if (fs.existsSync(globalKeyPath)) {
    return fs.readFileSync(globalKeyPath, "utf-8").trim();
  }
  // 2. Legacy local file (backward compat with deprecation notice)
  const localKeyPath = path.resolve(process.cwd(), ".edge-ota.private.key");
  if (fs.existsSync(localKeyPath)) {
    spin.stop();
    console.log(`  ${c.yellow}⚠${c.reset}  Using legacy ${c.dim}.edge-ota.private.key${c.reset} in project directory.`);
    console.log(`     Move it to ${c.dim}${globalKeyPath}${c.reset} and delete the local copy.`);
    return fs.readFileSync(localKeyPath, "utf-8").trim();
  }
  return null;
}

function savePrivateKey(projectId: string, key: string): void {
  fs.mkdirSync(GLOBAL_KEYS_DIR, { recursive: true });
  const keyPath = path.join(GLOBAL_KEYS_DIR, `${projectId}.key`);
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
}

// ─── Auto-load .env ───────────────────────────────────────────────────────────

try {
  const envPath = path.resolve(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(k in process.env)) process.env[k] = v;
    }
  }
} catch { /* silently skip */ }

// ─── ANSI Colors ─────────────────────────────────────────────────────────────

const c = {
  reset:     "\x1b[0m",
  bold:      "\x1b[1m",
  dim:       "\x1b[2m",
  underline: "\x1b[4m",
  red:       "\x1b[31m",
  green:     "\x1b[32m",
  yellow:    "\x1b[33m",
  blue:      "\x1b[34m",
  cyan:      "\x1b[36m",
  white:     "\x1b[37m",
  gray:      "\x1b[90m",
};

// ─── Spinner ─────────────────────────────────────────────────────────────────

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const spin = (() => {
  let timer: ReturnType<typeof setInterval> | null = null;
  let frame = 0;
  let label = "";

  return {
    start(text: string) {
      label = text;
      frame = 0;
      if (!process.stdout.isTTY) {
        process.stdout.write(`  ${text}...\n`);
        return;
      }
      timer = setInterval(() => {
        const f = `${c.cyan}${FRAMES[frame % FRAMES.length]}${c.reset}`;
        process.stdout.write(`\r  ${f}  ${c.dim}${label}${c.reset}   `);
        frame++;
      }, 80);
    },
    update(text: string) {
      label = text;
    },
    stop(successMsg?: string) {
      if (timer) { clearInterval(timer); timer = null; }
      if (process.stdout.isTTY) {
        process.stdout.write("\r\x1b[K"); // clear line
      }
      if (successMsg) {
        console.log(`  ${c.green}✓${c.reset}  ${successMsg}`);
      }
    },
    fail(errMsg: string) {
      if (timer) { clearInterval(timer); timer = null; }
      if (process.stdout.isTTY) process.stdout.write("\r\x1b[K");
      console.error(`  ${c.red}✗${c.reset}  ${errMsg}`);
    }
  };
})();

// ─── Package version ─────────────────────────────────────────────────────────

let packageVersion = "0.3.0";
try {
  const pkgPath = path.join(__dirname, "..", "package.json");
  if (fs.existsSync(pkgPath)) {
    packageVersion = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
  }
} catch { /* fallback */ }

// ─── Auto Update Check ────────────────────────────────────────────────────────

const UPDATE_CHECK_FILE = path.join(GLOBAL_CONFIG_DIR, "update-check.json");

function isNewerVersion(current: string, latest: string): boolean {
  const cParts = current.split(".").map(Number);
  const lParts = latest.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const cNum = cParts[i] || 0;
    const lNum = lParts[i] || 0;
    if (lNum > cNum) return true;
    if (lNum < cNum) return false;
  }
  return false;
}

async function checkAndAutoUpdate() {
  if (process.env.EDGE_OTA_UPDATING === "true") return;

  try {
    const now = Date.now();
    if (fs.existsSync(UPDATE_CHECK_FILE)) {
      try {
        const cache = JSON.parse(fs.readFileSync(UPDATE_CHECK_FILE, "utf-8"));
        // Only check npm once every 15 minutes to keep CLI commands extremely fast
        if (now - (cache.lastChecked || 0) < 15 * 60 * 1000) {
          return;
        }
      } catch { /* ignore */ }
    }

    // Save timestamp immediately to prevent concurrent requests
    fs.mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
    fs.writeFileSync(UPDATE_CHECK_FILE, JSON.stringify({ lastChecked: now }));

    // Fetch latest version from registry with a short 1s timeout
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), 1000);

    const res = await fetch("https://registry.npmjs.org/@renbostudios/edge-ota/latest", {
      signal: controller.signal
    });
    clearTimeout(timerId);

    if (!res.ok) return;
    const data = (await res.json()) as { version: string };
    const latestVersion = data.version;

    if (latestVersion && isNewerVersion(packageVersion, latestVersion)) {
      console.log(`\n  ${c.yellow}${c.reset}  New version of ${c.bold}edge-ota${c.reset} available: ${c.green}${latestVersion}${c.reset} (current: ${c.dim}${packageVersion}${c.reset})`);
      console.log(`  ${c.blue}➜${c.reset}  Auto-updating globally...`);

      try {
        execSync("npm install -g @renbostudios/edge-ota", {
          stdio: "inherit",
          env: { ...process.env, EDGE_OTA_UPDATING: "true" }
        });
        console.log(`  ${c.green}✓${c.reset}  Successfully auto-updated to ${c.bold}${latestVersion}${c.reset}!\n`);
      } catch (err: any) {
        console.error(`  ${c.red}✗${c.reset}  Auto-update failed: ${err.message}`);
        console.error(`     Please update manually: ${c.cyan}npm install -g @renbostudios/edge-ota${c.reset}\n`);
      }
    }
  } catch {
    // Fail silently so CLI works offline
  }
}

// ─── Banner ───────────────────────────────────────────────────────────────────

function printBanner() {
  const sep = `${c.dim}${"─".repeat(52)}${c.reset}`;
  console.log(`\n${sep}`);
  console.log(`  ${c.bold}${c.white}edge-ota${c.reset}  ${c.dim}v${packageVersion} · Zero-SDK OTA for Expo${c.reset}`);
  console.log(`  ${c.dim}by ${c.reset}${c.bold}Renbo Studios${c.reset}${c.dim} — Mobile App Development Studio${c.reset}`);
  console.log(`  ${c.dim}renbostudios.com${c.reset}`);
  console.log(`${sep}\n`);
}

// ─── app.json helpers ────────────────────────────────────────────────────────

const DEFAULT_SERVER = "https://api.ota.renbo.site";

interface AppJsonConfig {
  serverUrl:      string;
  projectId:      string | null;
  runtimeVersion: string;
  publicKey?:     string;
}

function readAppJson(cwd: string): AppJsonConfig {
  const appJsonPath = path.resolve(cwd, "app.json");
  if (!fs.existsSync(appJsonPath)) {
    console.error(`\n  ${c.red}✗${c.reset}  ${c.bold}app.json not found${c.reset} in ${cwd}`);
    console.error(`     Run this command from your Expo project root.\n`);
    process.exit(1);
  }

  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(appJsonPath, "utf-8"));
  } catch {
    console.error(`  ${c.red}✗${c.reset}  Failed to parse app.json`);
    process.exit(1);
  }

  const expo = data?.expo ?? {};

  // ── Runtime version ──
  let runtimeVersion = expo.runtimeVersion;
  if (!runtimeVersion) {
    console.error(`  ${c.red}✗${c.reset}  ${c.bold}expo.runtimeVersion${c.reset} is not set in app.json`);
    console.error(`     Add: ${c.dim}"runtimeVersion": "1.0.0"${c.reset} under the expo key.\n`);
    process.exit(1);
  }

  // Resolve runtimeVersion object (e.g. policy helper) to string
  if (typeof runtimeVersion === "object" && runtimeVersion !== null) {
    const policy = (runtimeVersion as any).policy;
    if (policy === "appVersion") {
      runtimeVersion = expo.version;
    } else if (policy === "sdkVersion") {
      runtimeVersion = expo.sdkVersion;
    } else {
      runtimeVersion = expo.version || expo.sdkVersion;
    }
  }

  if (!runtimeVersion || typeof runtimeVersion !== "string") {
    console.error(`  ${c.red}✗${c.reset}  Could not resolve ${c.bold}expo.runtimeVersion${c.reset} to a valid string in app.json`);
    if (typeof expo.runtimeVersion === "object") {
      console.error(`     Since you are using a policy, please ensure either ${c.bold}expo.version${c.reset} or ${c.bold}expo.sdkVersion${c.reset} is defined.\n`);
    }
    process.exit(1);
  }

  // ── Updates URL ──
  const updatesUrl: string = expo?.updates?.url ?? "";
  if (!updatesUrl) {
    console.error(`  ${c.red}✗${c.reset}  ${c.bold}expo.updates.url${c.reset} is not configured in app.json`);
    console.error(`     Run ${c.cyan}edge-ota init${c.reset} to set this up.\n`);
    process.exit(1);
  }

  // Parse serverUrl and projectId from the updates URL.
  // Expected format: https://<host>/api/projects/<uuid>/updates
  //              or: https://<host>/api/updates
  let serverUrl: string;
  let projectId: string | null = null;

  try {
    const u = new URL(updatesUrl);
    const projectMatch = u.pathname.match(/\/api\/projects\/([^/]+)\/updates/);
    if (projectMatch) {
      projectId = projectMatch[1];
      serverUrl = `${u.protocol}//${u.host}`;
    } else {
      serverUrl = `${u.protocol}//${u.host}`;
    }
  } catch {
    console.error(`  ${c.red}✗${c.reset}  Could not parse ${c.dim}expo.updates.url${c.reset} in app.json`);
    process.exit(1);
  }

  // ── Project-level server override ──
  // expo.extra.edgeOtaServer lets users point a specific project at a
  // different (self-hosted) EdgeOTA instance without re-logging in.
  const projectServer: string | undefined = expo?.extra?.edgeOtaServer;
  if (projectServer) {
    serverUrl = projectServer.replace(/\/$/, "");
  }

  return { serverUrl, projectId, runtimeVersion, publicKey: expo?.extra?.edgeOtaPublicKey };
}

function updateAppJson(cwd: string, serverUrl: string, projectId?: string, publicKey?: string) {
  const appJsonPath = path.resolve(cwd, "app.json");
  if (!fs.existsSync(appJsonPath)) return;

  try {
    const data = JSON.parse(fs.readFileSync(appJsonPath, "utf-8"));
    if (!data.expo) data.expo = {};
    if (!data.expo.updates) data.expo.updates = {};
    if (!data.expo.extra) data.expo.extra = {};

    const cleanUrl = serverUrl.replace(/\/$/, "");
    data.expo.updates.url = projectId
      ? `${cleanUrl}/api/projects/${projectId}/updates`
      : `${cleanUrl}/api/updates`;
    data.expo.updates.checkAutomatically = data.expo.updates.checkAutomatically ?? "ON_LOAD";
    data.expo.updates.fallbackToCacheTimeout = data.expo.updates.fallbackToCacheTimeout ?? 30000;
    data.expo.updates.requestHeaders = data.expo.updates.requestHeaders ?? { "expo-channel-name": "production" };

    // Store the server URL in expo.extra.edgeOtaServer so users can easily
    // override which EdgeOTA instance this project points to without re-running
    // `edge-ota login`. They can edit this value directly in app.json.
    data.expo.extra.edgeOtaServer = cleanUrl;

    if (publicKey) {
      data.expo.extra.edgeOtaPublicKey = publicKey;
    }

    fs.writeFileSync(appJsonPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    console.log(`  ${c.dim}app.json${c.reset}    updated ${c.dim}expo.updates.url${c.reset} + ${c.dim}expo.extra.edgeOtaServer${c.reset}`);
  } catch (e: any) {
    console.error(`  ${c.yellow}⚠${c.reset}   Could not update app.json: ${e.message}`);
  }
}

// ─── Readline helper ─────────────────────────────────────────────────────────

function ask(query: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(query, a => { rl.close(); resolve(a.trim()); }));
}

function askSecret(query: string): Promise<string> {
  return new Promise(resolve => {
    if (process.stdin.isTTY) {
      process.stdout.write(query);
      let input = "";
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", function onData(ch: string) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          resolve(input);
        } else if (ch === "\u0003") {
          process.exit(0);
        } else if (ch === "\u007f") {
          if (input.length > 0) { input = input.slice(0, -1); process.stdout.write("\b \b"); }
        } else {
          input += ch;
          process.stdout.write("•");
        }
      });
    } else {
      ask(query).then(resolve);
    }
  });
}

interface SelectOptionItem<T> {
  label: string;
  value: T;
}

function selectOption<T>(
  question: string,
  options: SelectOptionItem<T>[]
): Promise<T> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      console.log(`  ${c.bold}${question}${c.reset}`);
      options.forEach((opt, idx) => {
        console.log(`  [${idx + 1}] ${opt.label}`);
      });
      ask(`  selection (1-${options.length}): `).then((choice) => {
        const idx = parseInt(choice) - 1;
        if (!isNaN(idx) && idx >= 0 && idx < options.length) {
          resolve(options[idx].value);
        } else {
          resolve(options[0].value);
        }
      });
      return;
    }

    let cursor = 0;
    const hideCursor = "\u001b[?25l";
    const showCursor = "\u001b[?25h";
    let hasRendered = false;

    console.log(`  ${c.bold}${question}${c.reset}`);

    function render() {
      if (hasRendered) {
        for (let i = 0; i < options.length; i++) {
          process.stdout.write("\r\u001b[K\u001b[A");
        }
        process.stdout.write("\r\u001b[K");
      }
      hasRendered = true;

      options.forEach((opt, idx) => {
        const isSelected = idx === cursor;
        const marker = isSelected ? `${c.cyan}❯${c.reset}` : " ";
        const text = isSelected ? `${c.bold}${c.cyan}${opt.label}${c.reset}` : `${c.dim}${opt.label}${c.reset}`;
        process.stdout.write(`  ${marker} ${text}\n`);
      });
    }

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write(hideCursor);
    render();

    function onKeypress(str: string, key: any) {
      if (key.ctrl && key.name === "c") {
        process.stdout.write(showCursor);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.exit(0);
      }

      if (key.name === "up" || key.name === "k") {
        cursor = (cursor - 1 + options.length) % options.length;
        render();
      } else if (key.name === "down" || key.name === "j") {
        cursor = (cursor + 1) % options.length;
        render();
      } else if (key.name === "return" || key.name === "enter") {
        process.stdout.write(showCursor);
        process.stdin.setRawMode(false);
        process.stdin.removeListener("keypress", onKeypress);
        process.stdin.pause();
        resolve(options[cursor].value);
      }
    }

    process.stdin.on("keypress", onKeypress);
  });
}

// ─── Asset collection ─────────────────────────────────────────────────────────

interface AssetEntry {
  localPath:   string;
  key:         string;
  contentType: string;
  hash:        string;
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
  ".webm":  "video/webm",
};

async function hashFile(filePath: string): Promise<string> {
  const buffer = fs.readFileSync(filePath);
  return sha256Hex(buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer);
}

async function collectAssets(distDir: string): Promise<AssetEntry[]> {
  const entries: AssetEntry[] = [];

  function walk(dir: string) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) {
        walk(full);
      } else {
        const ext = path.extname(name).toLowerCase();
        entries.push({
          localPath:   full,
          key:         path.relative(distDir, full).replace(/\\/g, "/"),
          contentType: CONTENT_TYPES[ext] || "application/octet-stream",
          hash:        ""
        });
      }
    }
  }

  walk(distDir);
  await Promise.all(entries.map(async e => { e.hash = await hashFile(e.localPath); }));
  return entries;
}

function findBundle(distDir: string, platform: string): string | null {
  const expoStaticJs = path.join(distDir, "_expo", "static", "js", platform);
  if (fs.existsSync(expoStaticJs)) {
    const files = fs.readdirSync(expoStaticJs).filter(f => f.endsWith(".js") || f.endsWith(".hbc"));
    if (files.length) return path.join(expoStaticJs, files[0]);
  }
  const flatJs = path.join(distDir, `index.${platform}.js`);
  if (fs.existsSync(flatJs)) return flatJs;
  const flatHbc = path.join(distDir, `index.${platform}.hbc`);
  if (fs.existsSync(flatHbc)) return flatHbc;
  const rootJs = fs.readdirSync(distDir).find(f => f.endsWith(".js") || f.endsWith(".hbc"));
  if (rootJs) return path.join(distDir, rootJs);
  return null;
}

// ─── Auth token resolution ────────────────────────────────────────────────────

function resolveToken(): string | null {
  // 1. Global config
  const cfg = loadGlobalConfig();
  if (cfg?.token) return cfg.token;
  // 2. Env var fallback
  return process.env.EDGE_OTA_TOKEN || null;
}

// ─── Program ─────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("edge-ota")
  .description("Zero-SDK OTA update platform for Expo — by Renbo Studios")
  .version(packageVersion);

// Show help + auth status when called with no arguments
program.action(() => {
  printBanner();
  const cfg = loadGlobalConfig();
  if (cfg?.email) {
    console.log(`  ${c.green}●${c.reset}  Logged in as ${c.bold}${cfg.email}${c.reset}  ${c.dim}(${cfg.serverUrl})${c.reset}`);
  } else {
    console.log(`  ${c.dim}○  Not logged in — run ${c.reset}${c.cyan}edge-ota login${c.reset}`);
  }
  console.log();
  console.log(`  ${c.bold}Commands${c.reset}`);
  const cmds = [
    ["login",   "Authenticate and save credentials globally"],
    ["logout",  "Remove stored credentials"],
    ["init",    "Register project, generate signing keys, configure app.json"],
    ["push",    "Export bundle and publish an OTA update"],
    ["status",  "List recent deployments for this project"],
    ["keygen",  "Generate a new ECDSA key pair (prints to stdout)"],
  ];
  for (const [cmd, desc] of cmds) {
    console.log(`  ${c.cyan}${cmd.padEnd(10)}${c.reset}  ${c.dim}${desc}${c.reset}`);
  }
  console.log();
  console.log(`  Run ${c.cyan}edge-ota <command> --help${c.reset} for command-specific options.`);
  console.log();
});

// ──────────────────────────────────────────────────────────────────────────────
// edge-ota login
// ──────────────────────────────────────────────────────────────────────────────

program
  .command("login")
  .description("Authenticate with your EdgeOTA account")
  .option("-s, --server <url>", `EdgeOTA server URL (default: ${DEFAULT_SERVER})`)
  .action(async (options) => {
    printBanner();

    const usingCustomServer = options.server && options.server !== DEFAULT_SERVER;
    console.log(`  ${c.bold}Sign in to EdgeOTA${c.reset}`);
    if (usingCustomServer) {
      console.log(`  ${c.dim}server: ${options.server}${c.reset}`);
    }
    console.log();

    const serverUrl = (options.server || DEFAULT_SERVER).replace(/\/$/, "");
    const email    = await ask(`  ${c.dim}email:${c.reset}    `);
    const password = await askSecret(`  ${c.dim}password:${c.reset} `);

    spin.start("authenticating");

    try {
      const res = await fetch(`${serverUrl}/api/auth/login`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const text = await res.text();
        spin.fail(`Login failed: ${text || res.statusText}`);
        process.exit(1);
      }

      const data = await res.json() as { token: string; email: string };
      saveGlobalConfig({ token: data.token, email: data.email, serverUrl });

      spin.stop();
      const sep = `${c.dim}${"─".repeat(52)}${c.reset}`;
      console.log(sep);
      console.log(`  ${c.green}✓${c.reset}  Logged in as ${c.bold}${data.email}${c.reset}`);
      console.log(`  ${c.dim}credentials saved to ${GLOBAL_CONFIG_FILE}${c.reset}`);
      console.log(sep + "\n");
      process.exit(0);
    } catch (e: any) {
      spin.fail(`Connection failed: ${e.message}`);
      process.exit(1);
    }
  });

// ──────────────────────────────────────────────────────────────────────────────
// edge-ota logout
// ──────────────────────────────────────────────────────────────────────────────

program
  .command("logout")
  .description("Remove stored credentials")
  .action(() => {
    printBanner();
    const cfg = loadGlobalConfig();
    clearGlobalConfig();
    if (cfg?.email) {
      console.log(`  ${c.green}✓${c.reset}  Logged out from ${c.bold}${cfg.email}${c.reset}\n`);
    } else {
      console.log(`  ${c.dim}Already logged out.${c.reset}\n`);
    }
    process.exit(0);
  });

// ──────────────────────────────────────────────────────────────────────────────
// edge-ota init
// ──────────────────────────────────────────────────────────────────────────────

program
  .command("init")
  .description("Register project on EdgeOTA, generate signing keys, configure app.json")
  .option("-s, --server <url>", "EdgeOTA server URL (overrides logged-in server)")
  .action(async (options) => {
    printBanner();

    const token = resolveToken();
    if (!token) {
      console.error(`  ${c.red}✗${c.reset}  Not logged in. Run ${c.cyan}edge-ota login${c.reset} first.\n`);
      process.exit(1);
    }

    const globalCfg = loadGlobalConfig();
    const serverUrl = (options.server || globalCfg?.serverUrl || DEFAULT_SERVER).replace(/\/$/, "");
    const cwd       = process.cwd();

    // Fetch existing projects
    spin.start("fetching existing projects from server");
    let projects: any[] = [];
    try {
      const res = await fetch(`${serverUrl}/api/projects`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        projects = await res.json() as any[];
      }
      spin.stop();
    } catch (e: any) {
      spin.fail(`Failed to fetch projects: ${e.message}`);
      // Continue with creation if list fails
    }

    let projectId: string | null = null;
    let projectName = "";

    if (projects.length > 0) {
      const options = projects.map(p => ({
        label: `${p.name} ${c.dim}(id: ${p.id.slice(0, 8)}...)${c.reset}`,
        value: p
      }));
      options.push({
        label: `${c.green}Create a new project...${c.reset}`,
        value: null
      });

      const selected = await selectOption(
        "Select a project to associate with this app:",
        options
      );

      if (selected) {
        projectId = selected.id;
        projectName = selected.name;
      }
    }

    const keys = await generateECDSAKeyPair();

    if (projectId) {
      // Re-initialize existing project: update public key on the server
      spin.start(`associating project "${projectName}"`);
      try {
        const res = await fetch(`${serverUrl}/api/projects/${projectId}`, {
          method:  "PUT",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body:    JSON.stringify({ name: projectName, publicKey: keys.publicKey }),
        });

        if (!res.ok) {
          const text = await res.text();
          spin.fail(`Failed to update project public key on server: ${text}`);
          process.exit(1);
        }
        spin.stop(`associated project "${projectName}"`);
      } catch (e: any) {
        spin.fail(`Connection error: ${e.message}`);
        process.exit(1);
      }
    } else {
      // Create new project
      let suggestedName = path.basename(cwd);
      try {
        const data = JSON.parse(fs.readFileSync(path.resolve(cwd, "app.json"), "utf-8"));
        suggestedName = data?.expo?.name || suggestedName;
      } catch { /* ignore */ }

      projectName = (await ask(`  ${c.dim}project name [${suggestedName}]:${c.reset} `)) || suggestedName;

      spin.start("registering project on server");
      try {
        const res = await fetch(`${serverUrl}/api/projects`, {
          method:  "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body:    JSON.stringify({ name: projectName, publicKey: keys.publicKey }),
        });

        if (!res.ok) {
          const text = await res.text();
          spin.fail(`Failed to register project: ${text}`);
          process.exit(1);
        }

        const data = await res.json() as { id: string };
        projectId = data.id;
        spin.stop("project registered");
      } catch (e: any) {
        spin.fail(`Connection error: ${e.message}`);
        process.exit(1);
      }
    }

    // Save private key globally
    if (projectId) {
      savePrivateKey(projectId, keys.privateKey);
      // Update app.json
      updateAppJson(cwd, serverUrl, projectId, keys.publicKey);

      const sep = `${c.dim}${"─".repeat(52)}${c.reset}`;
      console.log(`\n${sep}`);
      console.log(`  ${c.green}✓${c.reset}  ${c.bold}Initialised${c.reset}`);
      console.log(sep);
      console.log(`  project    ${c.dim}${projectId}${c.reset}`);
      console.log(`  server     ${c.dim}${serverUrl}${c.reset}`);
      console.log(`  key file   ${c.dim}${path.join(GLOBAL_KEYS_DIR, `${projectId}.key`)}${c.reset}`);
      console.log(sep);

      console.log(`\n${c.bold}${c.yellow}  ⚠  REBUILD REQUIRED${c.reset}`);
      console.log(sep);
      console.log(`  ${c.bold}Your native app MUST be rebuilt for OTA updates${c.reset}`);
      console.log(`  ${c.bold}to work.${c.reset} The server URL is baked into the native`);
      console.log(`  binary at build time — not read from app.json.`);
      console.log();
      console.log(`  Run these commands in order:`);
      console.log();
      console.log(`    ${c.cyan}npx expo prebuild --clean${c.reset}`);
      console.log(`    ${c.cyan}npx expo run:ios${c.reset}`);
      console.log(`    ${c.cyan}npx expo run:android${c.reset}`);
      console.log();
      console.log(`  Or via EAS:`);
      console.log(`    ${c.cyan}eas build --profile production${c.reset}`);
      console.log();
      console.log(`  ${c.red}Skipping this WILL cause "Failed to check for${c.reset}`);
      console.log(`  ${c.red}update" errors on app launch.${c.reset}`);
      console.log(sep + "\n");

      console.log(`  Then run ${c.cyan}edge-ota push${c.reset} to publish your first update.\n`);
      process.exit(0);
    }
  });

// ──────────────────────────────────────────────────────────────────────────────
// edge-ota push
// ──────────────────────────────────────────────────────────────────────────────

program
  .command("push")
  .description("Export your Expo bundle and publish an OTA update")
  .option("-c, --channel <channel>",  "Deployment channel",                       "production")
  .option("-p, --platform <platform>","Target platform: ios | android | all",     "all")
  .option("--skip-export",            "Skip expo export (use existing ./dist directory)")
  .option("--dry-run",                "Build and sign the payload but do NOT upload")
  .action(async (options) => {
    const cwd   = process.cwd();
    const token = resolveToken();

    printBanner();

    if (!token) {
      console.error(`  ${c.red}✗${c.reset}  Not logged in. Run ${c.cyan}edge-ota login${c.reset} first.`);
      console.error(`     Or set ${c.dim}EDGE_OTA_TOKEN${c.reset} environment variable.\n`);
      process.exit(1);
    }

    // Auto-detect from app.json
    const appCfg = readAppJson(cwd);
    const { serverUrl, projectId, runtimeVersion } = appCfg;

    // Load private signing key
    const privateKey = projectId ? loadPrivateKey(projectId) : null;
    if (!privateKey) {
      console.error(`  ${c.red}✗${c.reset}  No signing key found for this project.`);
      if (projectId) {
        console.error(`     Expected at: ${c.dim}${path.join(GLOBAL_KEYS_DIR, `${projectId}.key`)}${c.reset}`);
      }
      console.error(`     Run ${c.cyan}edge-ota init${c.reset} to set up code signing.\n`);
      process.exit(1);
    }

    const uploadUrl = projectId
      ? `${serverUrl}/api/projects/${projectId}/updates`
      : `${serverUrl}/api/updates`;

    const distDir = path.resolve(cwd, "dist");

    // ── Step 1: Expo export ──────────────────────────────────────────────────
    if (!options.skipExport) {
      spin.start("running expo export");

      await new Promise<void>((resolve, reject) => {
        const proc = spawn("npx", ["expo", "export"], {
          cwd,
          stdio: ["inherit", "pipe", "pipe"],
          shell: process.platform === "win32",
        });

        // Filter stdout: only show platform bundle lines
        proc.stdout?.on("data", (chunk: Buffer) => {
          const text = chunk.toString();
          for (const line of text.split("\n")) {
            const t = line.trim();
            // Show platform bundle summary lines only
            if (t.startsWith("_expo/static/js/") || t.match(/\.(hbc|js)\s+\(\d/)) {
              spin.stop();
              console.log(`  ${c.dim}${t}${c.reset}`);
              spin.start("running expo export");
            }
            // Update spinner with bundling progress
            if (t.match(/Bundled \d+ms/)) {
              spin.update("expo export — " + t.replace("Bundled", "").trim());
            }
          }
        });

        // Suppress stderr noise but capture real errors
        let stderrBuf = "";
        proc.stderr?.on("data", (chunk: Buffer) => { stderrBuf += chunk.toString(); });

        proc.on("close", code => {
          if (code === 0) {
            spin.stop("expo export complete");
            resolve();
          } else {
            spin.fail("expo export failed");
            // Print last few lines of stderr for context
            const lines = stderrBuf.split("\n").filter(Boolean);
            for (const l of lines.slice(-10)) console.error(`  ${c.dim}${l}${c.reset}`);
            reject(new Error(`expo export exited with code ${code}`));
          }
        });
      }).catch(() => process.exit(1));

    } else {
      console.log(`  ${c.dim}skip-export — using existing ./dist${c.reset}`);
    }

    if (!fs.existsSync(distDir)) {
      console.error(`  ${c.red}✗${c.reset}  ./dist not found after export\n`);
      process.exit(1);
    }

    // ── Step 2: Collect assets ───────────────────────────────────────────────
    spin.start("collecting assets");
    const assets = await collectAssets(distDir);
    spin.stop(`found ${assets.length} asset(s)`);

    const platforms = options.platform === "all" ? ["ios", "android"] : [options.platform];
    const sep = `${c.dim}${"─".repeat(52)}${c.reset}`;

    // ── Step 3: Per-platform upload ──────────────────────────────────────────
    for (const platform of platforms) {
      console.log(`\n${sep}`);
      console.log(`  ${c.bold}${platform}${c.reset}`);
      console.log(sep);

      const bundlePath = findBundle(distDir, platform);
      if (!bundlePath) {
        console.warn(`  ${c.yellow}⚠${c.reset}   no bundle found for ${platform}, skipping`);
        continue;
      }

      const bundleHash = await hashFile(bundlePath);
      const bundleSize = (fs.statSync(bundlePath).size / 1024 / 1024).toFixed(2);
      console.log(`  bundle     ${c.dim}${bundleHash.slice(0, 16)}…  ${bundleSize} MB${c.reset}`);

      const payloadObj = {
        channel:        options.channel,
        runtimeVersion,
        platform,
        bundleHash,
        timestamp:      Date.now(),
        assetCount:     assets.length,
        publicKey:      appCfg.publicKey,
      };
      const payloadStr = JSON.stringify(payloadObj);

      spin.start("signing");
      const signature = await signPayload(payloadStr, privateKey);
      spin.stop(`signed  ${c.dim}${signature.slice(0, 20)}…${c.reset}`);

      if (options.dryRun) {
        console.log(`  ${c.yellow}dry-run${c.reset}   upload skipped`);
        continue;
      }

      spin.start("uploading");
      const bundleBuffer = fs.readFileSync(bundlePath);
      const form = new FormData();
      form.append("bundle",    new Blob([bundleBuffer], { type: "application/javascript" }), `bundle-${platform}.hbc`);
      form.append("payload",   payloadStr);
      form.append("signature", signature);
      form.append("platform",  platform);

      const response = await fetch(uploadUrl, {
        method:  "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(projectId ? { "X-Project-Id": projectId } : {})
        },
        body: form,
      }).catch(e => {
        spin.fail(`Upload failed: ${e.message}`);
        process.exit(1);
      });

      if (!response.ok) {
        const text = await response.text();
        spin.fail(`Upload failed (HTTP ${response.status}): ${text}`);
        process.exit(1);
      }

      const body = await response.json().catch(() => ({})) as any;
      spin.stop("uploaded");

      console.log(`  ${c.green}✓${c.reset}  deployed`);
      console.log(`  id         ${c.dim}${body.updateId || "—"}${c.reset}`);
      console.log(`  channel    ${options.channel}`);
      console.log(`  runtime    ${runtimeVersion}`);
    }

    console.log(`\n${sep}`);
    console.log(`  ${c.green}✓${c.reset}  ${c.bold}done${c.reset}  ${c.dim}update will be applied on next OTA sync${c.reset}`);
    console.log(`${sep}\n`);
    process.exit(0);
  });

// ──────────────────────────────────────────────────────────────────────────────
// edge-ota status
// ──────────────────────────────────────────────────────────────────────────────

program
  .command("status")
  .description("List recent deployments for this project")
  .option("-n, --limit <n>", "Number of releases to show", "10")
  .action(async (options) => {
    printBanner();

    const token = resolveToken();
    if (!token) {
      console.error(`  ${c.red}✗${c.reset}  Not logged in. Run ${c.cyan}edge-ota login${c.reset} first.\n`);
      process.exit(1);
    }

    const cwd    = process.cwd();
    const appCfg = readAppJson(cwd);
    const { serverUrl, projectId } = appCfg;

    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (projectId) headers["x-project-id"] = projectId;

    spin.start("fetching releases");

    const res = await fetch(`${serverUrl}/api/releases`, { headers }).catch(e => {
      spin.fail(`Connection failed: ${e.message}`);
      process.exit(1);
    });

    if (!res.ok) {
      spin.fail(`Failed to fetch releases (HTTP ${res.status})`);
      process.exit(1);
    }

    const releases = await res.json() as any[];
    spin.stop();

    if (!releases.length) {
      console.log(`  ${c.dim}No releases found.${c.reset}\n`);
      process.exit(0);
    }

    const limit = parseInt(options.limit);
    const rows = releases.slice(0, limit).map((r: any) => ({
      ID:        r.id?.slice(0, 8) ?? "—",
      Channel:   r.channel ?? "—",
      Runtime:   r.runtime ?? "—",
      Platform:  r.platform ?? "all",
      Created:   r.created_at ? new Date(r.created_at).toLocaleString() : "—",
    }));

    console.table(rows);
    process.exit(0);
  });

// ──────────────────────────────────────────────────────────────────────────────
// edge-ota keygen
// ──────────────────────────────────────────────────────────────────────────────

program
  .command("keygen")
  .description("Generate a fresh ECDSA P-256 key pair (prints to stdout, does not write files)")
  .action(async () => {
    const keys = await generateECDSAKeyPair();
    const sep  = `${c.dim}${"─".repeat(52)}${c.reset}`;
    console.log(`\n${sep}`);
    console.log(`  ${c.bold}private key${c.reset}  ${c.dim}keep secret — never commit${c.reset}`);
    console.log(sep);
    console.log(keys.privateKey);
    console.log(`\n${sep}`);
    console.log(`  ${c.bold}public key${c.reset}   ${c.dim}paste into dashboard → Settings → General${c.reset}`);
    console.log(sep);
    console.log(keys.publicKey);
    process.exit(0);
  });

await checkAndAutoUpdate();
program.parse(process.argv);
