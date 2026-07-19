# @renbostudios/edge-ota CLI

Zero-SDK, self-hostable OTA update CLI for Expo React Native. Push signed JavaScript bundles to any EdgeOTA server.

## Install

```bash
npm install -g @renbostudios/edge-ota
```

Requires Node.js 18+ and an Expo project with `expo-updates` installed.

## Quick Start

```bash
# 1. Log in to your EdgeOTA account
edge-ota login

# 2. Register your project and generate signing keys
edge-ota init

# 3. Rebuild your native app (REQUIRED — see below)
npx expo prebuild --clean
npx expo run:ios
npx expo run:android

# 4. Push an OTA update
edge-ota push
```

---

## Commands

### `edge-ota login`

Authenticate with your EdgeOTA account. Credentials are stored globally at `~/.config/edge-ota/config.json`.

```bash
edge-ota login
edge-ota login --server https://my-server.com   # custom server
```

You'll be prompted for your email and password. The session token is saved globally — no per-project `.env` files needed.

### `edge-ota logout`

Remove stored credentials.

```bash
edge-ota logout
```

### `edge-ota init`

Register your project on the EdgeOTA server, generate an ECDSA P-256 signing key pair, and configure `app.json` with the correct update URL.

```bash
edge-ota init
edge-ota init --server https://my-server.com   # override server
```

**What it does:**

1. Fetches your existing projects from the server (if any)
2. Lets you select an existing project or create a new one
3. Generates an ECDSA P-256 key pair
4. Registers the project on the server with your public key
5. Saves the private key to `~/.config/edge-ota/keys/<projectId>.key`
6. Updates your `app.json` with:
   - `expo.updates.url` — points to your EdgeOTA server
   - `expo.updates.checkAutomatically` — set to `"ON_LOAD"`
   - `expo.updates.fallbackToCacheTimeout` — set to `30000`
   - `expo.updates.requestHeaders` — sets `expo-channel-name` to `"production"`
   - `expo.extra.edgeOtaServer` — the server URL for manual override
   - `expo.extra.edgeOtaPublicKey` — the generated public key

**After init, you MUST rebuild your native app.** The CLI will print a prominent warning with instructions. See the [Rebuild Required](#rebuild-required) section below.

### `edge-ota push`

Export your Expo bundle and publish an OTA update to the server.

```bash
edge-ota push                                      # default: all platforms, production channel
edge-ota push --channel staging                    # deploy to staging
edge-ota push --platform ios                       # iOS only
edge-ota push --platform android                   # Android only
edge-ota push --skip-export                        # skip expo export, use existing ./dist
edge-ota push --dry-run                            # build and sign, but don't upload
```

**What it does:**

1. Runs `npx expo export` to create the JavaScript bundle (unless `--skip-export`)
2. Collects all assets from `./dist`
3. For each target platform (ios/android):
   - Locates the platform-specific bundle
   - Signs the payload with your ECDSA private key
   - Uploads the bundle + signature to the server
4. The server verifies the signature before storing the update

**How it reads your config:**

The CLI reads everything from `app.json` — no flags required for standard deploys:
- **Server URL** — from `expo.updates.url` (or `expo.extra.edgeOtaServer`)
- **Project ID** — parsed from the updates URL
- **Runtime version** — from `expo.runtimeVersion` (string or policy object)
- **Private key** — from `~/.config/edge-ota/keys/<projectId>.key`

### `edge-ota status`

List recent deployments for the current project.

```bash
edge-ota status
edge-ota status --limit 20    # show more releases
```

### `edge-ota keygen`

Generate a new ECDSA P-256 key pair and print it to stdout. Does not write any files.

```bash
edge-ota keygen
```

Useful for manual key rotation or generating keys for server-side signing.

---

## Rebuild Required

After running `edge-ota init`, you **must** rebuild your native app. The `expo-updates` native module reads its configuration (server URL, runtime version) from the **native binary**, not from `app.json` at runtime.

```bash
# Regenerate native projects with fresh config
npx expo prebuild --clean

# Rebuild
npx expo run:ios
npx expo run:android

# Or via EAS
eas build --profile production
```

**If you skip this step**, the app will fail with:

```
Failed to check for update
```

The native module has no valid server URL to reach because it was never embedded in the binary.

You must also rebuild after any change to `expo.updates.url` or `expo.runtimeVersion` in `app.json`.

---

## How It Works

```
Developer Machine              EdgeOTA Server               User's Phone
─────────────────              ──────────────               ────────────
edge-ota push ─────────────►   POST /api/updates
                               (ECDSA verified)
                               stores bundle
                                              ◄──────────── GET /api/updates
                                                            (expo-updates SDK)
                                              ────────────► multipart manifest
                                              ◄──────────── GET /api/assets/:hash
                                                            download bundle
                                                            reload app ✓
```

1. `edge-ota push` runs `expo export` and uploads the Hermes bundle + ECDSA signature to your server
2. The server verifies the ECDSA P-256 signature before storing anything
3. When users open the app, `expo-updates` checks your server for a new manifest
4. The server responds with a signed multipart manifest (Expo Updates Protocol v1)
5. `expo-updates` downloads and applies the update automatically

---

## What `init` Writes to `app.json`

After running `edge-ota init`, your `app.json` will contain:

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

The `runtimeVersion` field is **not modified** by the CLI — it must already exist in your `app.json`. It supports both static strings and policy objects:

```json
// Static (recommended)
"runtimeVersion": "1.0.0"

// Policy-based (auto-increments with expo.version)
"runtimeVersion": { "policy": "appVersion" }
```

---

## Global Storage

All credentials and keys are stored outside your project directory:

| File | Contents |
|---|---|
| `~/.config/edge-ota/config.json` | Auth token, email, default server URL |
| `~/.config/edge-ota/keys/<projectId>.key` | Private ECDSA signing key (per-project) |
| `~/.config/edge-ota/update-check.json` | Auto-update check timestamp |

Nothing sensitive is ever stored in your project repository.

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `EDGE_OTA_TOKEN` | Override the auth token (useful for CI/CD) |
| `EDGE_OTA_UPDATING` | Internal — prevents recursive auto-updates |

---

## Auto-Update

The CLI checks for newer versions on npm every 15 minutes. If a newer version is found, it auto-installs globally. This check happens silently in the background and never blocks command execution.

To disable: set `EDGE_OTA_UPDATING=true` in your environment.

---

## Security

- All bundles are signed with ECDSA P-256 before upload
- The server rejects any bundle with an invalid or missing signature
- Private keys are stored with `0600` permissions (owner read/write only)
- Session tokens expire after 24 hours
- Private keys never leave your machine

---

## Server Setup

The EdgeOTA server is a standard Node.js/Express app. You can self-host it or use the managed cloud service.

### Docker

```bash
docker pull renbostudios/edge-ota-server:latest
docker run -p 3000:3000 -e DATABASE_URL=... renbostudios/edge-ota-server
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

---

## Troubleshooting

### "Failed to check for update" on app launch

The `expo-updates` native module can't reach your server because the URL was never embedded in the binary. Fix: rebuild the native app after `edge-ota init`.

```bash
npx expo prebuild --clean
npx expo run:ios
npx expo run:android
```

### Updates work on iOS but not Android

The Android native project may still have the default Expo Updates URL. Fix: regenerate and rebuild.

```bash
npx expo prebuild --clean
npx expo run:android
```

Verify by checking `android/app/src/main/AndroidManifest.xml` for the `EXPO_UPDATE_URL` meta-data entry — it should point to your EdgeOTA server.

### Updates stopped working after a version bump

If `runtimeVersion` uses the `appVersion` policy, every version bump changes the runtime version. Push a new update after bumping, or switch to a static string.

### "No signing key found" error on push

Run `edge-ota init` to generate keys, or use `edge-ota keygen` to generate a new pair and register it manually.

---

## Built by Renbo Studios

[renbostudios.com](https://renbostudios.com) — Mobile App Development Studio

MIT License
