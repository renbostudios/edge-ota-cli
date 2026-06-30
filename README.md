# `@renbostudios/edge-ota`

> Zero-SDK, self-hostable OTA update CLI for Expo apps.  
> Push cryptographically signed JS bundles to any EdgeOTA server — no Expo account required.

## Install

```bash
npm install -g @renbostudios/edge-ota
# or use without installing:
npx @renbostudios/edge-ota <command>
```

## Quick Start

Run these commands **inside your Expo project directory**:

```bash
# 1. Generate ECDSA P-256 keys and write config
edge-ota init

# 2. Push your first update
edge-ota push --channel production --runtime 1.0.0

# 3. Check what's deployed
edge-ota status
```

## Commands

### `edge-ota init [options]`

Generates an ECDSA P-256 key pair, writes `edge-ota.config.json` and `.edge-ota.private.key`, auto-adds the private key to `.gitignore`, and automatically updates your Expo `app.json` configuration file with the new updates URL.

If `-s` or `--server` is not specified, you will be prompted interactively to enter the URL of your hosted or local EdgeOTA server.

| Option | Default | Description |
|--------|---------|-------------|
| `-s, --server <url>` | — | Your EdgeOTA server URL (prompts if omitted) |

**Output:**
- `edge-ota.config.json` — server URL + public key (safe to commit)
- `.edge-ota.private.key` — private signing key (**never commit this**)
- **Auto-configured:** `app.json` is modified to point `expo.updates.url` to your server's `/api/updates` endpoint.

---

### `edge-ota push [options]`

Runs `expo export`, hashes every asset with SHA-256, signs the payload with your private key, then uploads the bundle to your server.

| Option | Default | Description |
|--------|---------|-------------|
| `-c, --channel <name>` | `production` | Deployment channel |
| `-r, --runtime <version>` | `1.0.0` | Native runtime version (must match `runtimeVersion` in app.json) |
| `-p, --platform <platform>` | `all` | `ios`, `android`, or `all` |
| `--skip-export` | — | Skip `expo export` — use existing `./dist` |
| `--dry-run` | — | Sign the payload but don't upload |

**Example — CI/CD:**
```bash
edge-ota push \
  --channel production \
  --runtime 1.2.0 \
  --platform all
```

---

### `edge-ota status [options]`

Lists recent releases from the server as a table.

| Option | Default | Description |
|--------|---------|-------------|
| `-t, --token <token>` | `$EDGE_OTA_TOKEN` | Auth token from the dashboard |
| `-n, --limit <n>` | `10` | Number of releases to show |

```bash
export EDGE_OTA_TOKEN="your-dashboard-token"
edge-ota status
```

---

### `edge-ota keygen`

Prints a fresh ECDSA P-256 key pair to stdout without writing any files. Useful for generating secrets to store in CI/CD environment variables.

```bash
edge-ota keygen
```

---

## How it works

1. **Build** — `expo export` produces a JS bundle + assets in `./dist/`
2. **Hash** — every file gets a SHA-256 content hash (enables deduplication on the server)
3. **Sign** — the upload payload (`{ channel, runtimeVersion, bundleHash, ... }`) is signed with your ECDSA P-256 private key
4. **Upload** — `POST /api/updates` with `multipart/form-data` containing the bundle zip, payload JSON, and signature
5. **Serve** — when your app checks for updates, the server verifies the stored signature and returns a signed manifest
6. **Verify** — the Expo SDK verifies the manifest signature and bundle hash before swapping the active bundle

## Expo App Setup

Add to your `app.json`:

```json
{
  "expo": {
    "updates": {
      "url": "https://your-edge-ota-server.com/api/updates",
      "runtimeVersion": { "policy": "nativeVersion" }
    }
  }
}
```

## License

MIT
