<p align="center">
  <img src="https://ota.renbo.site/og.png" alt="Edge OTA" width="100%">
</p>

<h1 align="center">
  <code>edge-ota</code>
</h1>

<p align="center">
  <strong>Zero-SDK, self-hostable OTA update CLI for Expo React Native</strong><br>
  Push signed JavaScript bundles to any EdgeOTA server.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@renbostudios/edge-ota"><img src="https://img.shields.io/npm/v/@renbostudios/edge-ota?style=flat-square&color=81C784" alt="npm version"></a>
  <a href="https://github.com/renbostudios/edge-ota-cli/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@renbostudios/edge-ota?style=flat-square&color=FFAA00" alt="license"></a>
  <a href="https://www.npmjs.com/package/@renbostudios/edge-ota"><img src="https://img.shields.io/npm/dm/@renbostudios/edge-ota?style=flat-square&color=81C784" alt="downloads"></a>
</p>

<p align="center">
  <a href="https://github.com/renbostudios/edge-ota-cli">GitHub</a> · <a href="https://ota.renbo.site">Dashboard</a> · <a href="https://ota.renbo.site/docs">Docs</a> · <a href="https://pd1mvpk7lt.ufs.sh/f/6uDGWrRxa3ipmhByNjc2TlHph0oA4dsWRFUuqZMan18Gwb7g">Video Tutorial</a>
</p>

---

<br>

```
 ╔══════════════════════════════════════════════════════════════════╗
 ║                                                                ║
 ║   ┌─┐┬┌─┬┌┬┐┌─┐┌─┐┬ ┬┌─┐┌┐┌┌┬┐┌─┐                          ║
 ║   └─┐││ ┤│││├┤ │ ┬├─┤├─┤│││ │ ┤ └─┐                         ║
 ║   └─┘┴└─┴┴ ┴└  └─┘┴ ┴┴ ┴┘└┘─┴┘└─┘└─┘                         ║
 ║                                                                ║
 ║   Push signed OTA bundles to the edge.                         ║
 ║   Zero SDK. Zero egress. Full control.                         ║
 ║                                                                ║
 ╚══════════════════════════════════════════════════════════════════╝
```

<br>

## ⚡ Quick Start

```
 ┌──────────────────────────────────────────────────────────────┐
 │  STEP 01                                                     │
 │  Install the CLI globally                                    │
 └──────────────────────────────────────────────────────────────┘
```

```bash
npm install -g @renbostudios/edge-ota
```

```
 ┌──────────────────────────────────────────────────────────────┐
 │  STEP 02                                                     │
 │  Log in to your EdgeOTA account                              │
 └──────────────────────────────────────────────────────────────┘
```

```bash
edge-ota login
```

```
 ┌──────────────────────────────────────────────────────────────┐
 │  STEP 03                                                     │
 │  Register your project & generate signing keys               │
 └──────────────────────────────────────────────────────────────┘
```

```bash
edge-ota init
```

```
 ┌──────────────────────────────────────────────────────────────┐
 │  STEP 04                                                     │
 │  ⚠  REBUILD YOUR NATIVE APP (required!)                     │
 └──────────────────────────────────────────────────────────────┘
```

```bash
npx expo prebuild --clean
npx expo run:ios
npx expo run:android
```

```
 ┌──────────────────────────────────────────────────────────────┐
 │  STEP 05                                                     │
 │  Push an OTA update 🚀                                       │
 └──────────────────────────────────────────────────────────────┘
```

```bash
edge-ota push
```

> **📹 Prefer video?** Watch the full setup tutorial below:

<p align="center">
  <video src="https://pd1mvpk7lt.ufs.sh/f/6uDGWrRxa3ipmhByNjc2TlHph0oA4dsWRFUuqZMan18Gwb7g" controls width="100%" style="max-width: 640px; border: 1px solid #333; border-radius: 4px; background: #000;">
    Your browser does not support the video tag.
  </video>
</p>

<br>

---

<br>

## 📦 Commands

### `edge-ota login`

Authenticate with your EdgeOTA account. Credentials are stored globally — no per-project `.env` files needed.

```bash
edge-ota login                                    # default server
edge-ota login --server https://my-server.com     # custom server
```

```
 ┌──────────────────────────────────────────────┐
 │  📁 Stored at:                               │
 │  ~/.config/edge-ota/config.json              │
 │                                              │
 │  Contains: auth token, email, server URL     │
 └──────────────────────────────────────────────┘
```

---

### `edge-ota logout`

Remove stored credentials from this machine.

```bash
edge-ota logout
```

---

### `edge-ota init`

The all-in-one setup command. Registers your project, generates ECDSA P-256 signing keys, and configures `app.json`.

```bash
edge-ota init                                    # interactive setup
edge-ota init --server https://my-server.com     # override server
```

**What happens under the hood:**

```
  ① Fetches your existing projects from the server
  ② Lets you select an existing project or create a new one
  ③ Generates an ECDSA P-256 key pair
  ④ Registers the project with your public key
  ⑤ Saves private key → ~/.config/edge-ota/keys/<projectId>.key
  ⑥ Updates app.json with server URL, public key, and headers
```

> ⚠ **After `init`, you MUST rebuild your native app.** See [Rebuild Required](#-rebuild-required) below.

---

### `edge-ota push`

Export your Expo bundle and publish an OTA update.

```bash
edge-ota push                                     # all platforms, production channel
edge-ota push --channel staging                   # deploy to staging
edge-ota push --platform ios                      # iOS only
edge-ota push --platform android                  # Android only
edge-ota push --skip-export                       # use existing ./dist
edge-ota push --dry-run                           # build & sign, don't upload
```

**What happens under the hood:**

```
  ① Runs `npx expo export` to create the JS bundle
  ② Collects all assets from ./dist
  ③ For each platform (ios/android):
       → Locates the platform-specific bundle
       → Signs the payload with your ECDSA private key
       → Uploads bundle + signature to the server
  ④ Server verifies the signature before storing
```

**How it reads your config:**

| Source | What it reads |
|---|---|
| `expo.updates.url` | Server URL + Project ID |
| `expo.runtimeVersion` | Runtime version (string or policy) |
| `~/.config/edge-ota/keys/<id>.key` | ECDSA private key |
| `expo.extra.edgeOtaServer` | Server URL override |

---

### `edge-ota status`

List recent deployments for the current project.

```bash
edge-ota status
edge-ota status --limit 20                       # show more releases
```

---

### `edge-ota keygen`

Generate a new ECDSA P-256 key pair and print it to stdout. Does not write any files.

```bash
edge-ota keygen
```

Useful for manual key rotation or generating keys for server-side signing.

<br>

---

<br>

## 🔄 Rebuild Required

After running `edge-ota init`, you **must** rebuild your native app. The `expo-updates` native module reads its config from the **native binary**, not from `app.json` at runtime.

```bash
npx expo prebuild --clean
npx expo run:ios
npx expo run:android

# or via EAS
eas build --profile production
```

```
 ╔══════════════════════════════════════════════════════════════════╗
 ║  ⚠  SKIP THIS STEP AND YOU'LL SEE:                            ║
 ║                                                                ║
 ║  "Failed to check for update"                                  ║
 ║                                                                ║
 ║  The native module has no valid server URL to reach because    ║
 ║  it was never embedded in the binary.                          ║
 ╚══════════════════════════════════════════════════════════════════╝
```

You must also rebuild after any change to `expo.updates.url` or `expo.runtimeVersion` in `app.json`.

<br>

---

<br>

## 🔁 How It Works

```
  Developer Machine                EdgeOTA Server                User's Phone
  ─────────────────                ──────────────                ────────────

  edge-ota push ──────────────►   POST /api/updates
                                   (ECDSA verified ✓)
                                   (stores bundle)
                                                   ◄──────────── GET /api/updates
                                                                 (expo-updates SDK)
                                                   ────────────► signed manifest
                                                   ◄──────────── GET /api/assets/:hash
                                                                 (downloads bundle)
                                                                 (reloads app ✓)
```

1. `edge-ota push` runs `expo export` and uploads the Hermes bundle + ECDSA signature
2. The server **verifies** the ECDSA P-256 signature before storing anything
3. When users open the app, `expo-updates` checks for a new manifest
4. The server responds with a signed multipart manifest (Expo Updates Protocol v1)
5. `expo-updates` downloads and applies the update automatically

<br>

---

<br>

## ⚙ What `init` Writes to `app.json`

```json
{
  "expo": {
    "updates": {
      "url": "https://your-server.com/api/projects/<projectId>/updates",
      "checkAutomatically": "ON_LOAD",
      "fallbackToCacheTimeout": 30000,
      "requestHeaders": {
        "expo-channel-name": "production"
      }
    },
    "runtimeVersion": "1.0.0",
    "extra": {
      "edgeOtaServer": "https://your-server.com",
      "edgeOtaPublicKey": "-----BEGIN PUBLIC KEY-----\n..."
    }
  }
}
```

> `runtimeVersion` is **not modified** by the CLI — it must already exist in your `app.json`. Supports both static strings and policy objects:

```json
"runtimeVersion": "1.0.0"
```
```json
"runtimeVersion": { "policy": "appVersion" }
```

<br>

---

<br>

## 🗂 Global Storage

All credentials and keys are stored **outside** your project directory:

```
 ~/.config/edge-ota/
 ├── config.json                    ← auth token, email, server URL
 ├── keys/
 │   └── <projectId>.key            ← ECDSA private key (per-project)
 └── update-check.json              ← auto-update check timestamp
```

```
 ┌──────────────────────────────────────────────────────────────┐
 │  🔒 Nothing sensitive is ever stored in your project repo.   │
 └──────────────────────────────────────────────────────────────┘
```

<br>

---

<br>

## 🧪 Environment Variables

| Variable | Purpose |
|---|---|
| `EDGE_OTA_TOKEN` | Override the auth token (for CI/CD pipelines) |
| `EDGE_OTA_UPDATING` | Internal — prevents recursive auto-updates |

<br>

---

<br>

## 🔄 Auto-Update

The CLI checks for newer versions on npm every 15 minutes. If a newer version is found, it auto-installs globally. This happens silently in the background and never blocks command execution.

To disable: set `EDGE_OTA_UPDATING=true` in your environment.

<br>

---

<br>

## 🔐 Security

```
 ┌──────────────────────────────────────────────────────────────┐
 │                                                              │
 │  ✅  ECDSA P-256 signing on every bundle upload             │
 │  ✅  Server rejects invalid or missing signatures            │
 │  ✅  Private keys stored with 0600 permissions               │
 │  ✅  Session tokens expire after 24 hours                    │
 │  ✅  Private keys never leave your machine                   │
 │                                                              │
 └──────────────────────────────────────────────────────────────┘
```

<br>

---

<br>

## 🖥 Server Setup

The EdgeOTA server is a standard Node.js/Express app. Self-host it or use the managed cloud service at [ota.renbo.site](https://ota.renbo.site).

### Docker

```bash
docker pull ghcr.io/itskodaaa/edge-ota-backend:latest
docker run -p 3000:3000 -e DATABASE_URL=... ghcr.io/itskodaaa/edge-ota-backend
```

### Docker Compose

```bash
git clone https://github.com/renbostudios/edge-ota-cli
cd edge-ota
docker-compose up -d
```

### Manual

```bash
git clone https://github.com/renbostudios/edge-ota-cli
cd edge-ota
pnpm install
pnpm --filter @renbostudios/edge-ota-server-node dev
```

<br>

---

<br>

## 🐛 Troubleshooting

<details>
<summary><strong>"Failed to check for update" on app launch</strong></summary>

<br>

The `expo-updates` native module can't reach your server because the URL was never embedded in the binary.

```bash
npx expo prebuild --clean
npx expo run:ios
npx expo run:android
```

</details>

<details>
<summary><strong>Updates work on iOS but not Android</strong></summary>

<br>

The Android native project may still have the default Expo Updates URL. Regenerate and rebuild:

```bash
npx expo prebuild --clean
npx expo run:android
```

Verify by checking `android/app/src/main/AndroidManifest.xml` for the `EXPO_UPDATE_URL` meta-data entry.

</details>

<details>
<summary><strong>Updates stopped working after a version bump</strong></summary>

<br>

If `runtimeVersion` uses the `appVersion` policy, every version bump changes the runtime version. Push a new update after bumping, or switch to a static string.

</details>

<details>
<summary><strong>"No signing key found" error on push</strong></summary>

<br>

Run `edge-ota init` to generate keys, or use `edge-ota keygen` to generate a new pair and register it manually.

</details>

<br>

---

<br>

## 📂 Project Structure

```
 edge-ota-cli/
 ├── apps/
 │   ├── cli/            ← CLI tool (you are here)
 │   ├── server-node/    ← Express + TypeScript API
 │   ├── worker-oss/     ← Cloudflare Worker (open source)
 │   ├── dashboard/      ← SvelteKit frontend
 │   └── core/           ← Shared crypto/manifest logic
 └── packages/
     └── core/           ← @renbostudios/edge-ota-core
```

<br>

---

<br>

<p align="center">
  <strong>Built by</strong><br>
  <a href="https://renbostudios.com">Renbo Studios</a> — Mobile App Development Studio
</p>

<p align="center">
  <sub>MIT License · <code>@renbostudios/edge-ota</code></sub>
</p>
