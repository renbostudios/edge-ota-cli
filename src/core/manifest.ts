/**
 * EdgeOTA Core - Expo Updates Protocol v1 Manifest Engine
 *
 * Implements the exact wire format consumed by expo-updates SDK:
 * - EAS Update-compatible manifest structure
 * - Multipart/mixed response body with proper boundary
 * - expo-signature header for ECDSA bundle verification
 * - Structured extension (extra) metadata passthrough
 */

export interface ExpoAsset {
  hash: string;       // SHA-256 hex of the asset bytes
  key: string;        // Unique key within the bundle (e.g. "bundle", "assets/icon")
  fileExtension?: string;
  contentType: string;
  url: string;        // Absolute URL the client will fetch from
}

export interface ExpoManifest {
  id: string;              // Stable UUID for this update
  createdAt: string;       // ISO 8601
  runtimeVersion: string;  // Must exactly match the app's runtimeVersion
  launchAsset: ExpoAsset;
  assets: ExpoAsset[];
  metadata?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

export interface ManifestResponse {
  manifest: ExpoManifest;
  headers: Record<string, string>;
}

/** Parameters required to build a manifest */
export interface ManifestParams {
  updateId: string;
  createdAt: string;
  runtimeVersion: string;
  /** Public-facing HTTPS URL for the JS bundle */
  bundleUrl: string;
  /** SHA-256 hex digest of the raw bundle bytes */
  bundleHash: string;
  assets: ExpoAsset[];
  metadata?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

/**
 * Build the Expo Updates v1 manifest object.
 * The client SDK deserialises this from the `manifest` part of the
 * multipart response (or directly from the response body in non-multipart mode).
 */
function hexToBase64Url(hex: string): string {
  if (hex.length !== 64 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return hex;
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  let binString = "";
  for (let i = 0; i < bytes.length; i++) {
    binString += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binString);
  return base64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function generateExpoManifest(params: ManifestParams): ExpoManifest {
  return {
    id: params.updateId,
    createdAt: params.createdAt,
    runtimeVersion: params.runtimeVersion,
    launchAsset: {
      hash: hexToBase64Url(params.bundleHash),
      key: "bundle",
      contentType: "application/javascript",
      url: params.bundleUrl
    },
    assets: params.assets.map(asset => ({
      ...asset,
      hash: hexToBase64Url(asset.hash)
    })),
    metadata: params.metadata ?? {},
    extra: params.extra ?? {}
  };
}

/**
 * Build the response headers required by the Expo Updates protocol.
 *
 * expo-protocol-version: "1"  — Signals v1 manifest format
 * expo-sfv-version: "0"       — Structured Fields version
 * cache-control               — Updates must never be stale; client always revalidates
 * expo-signature              — ECDSA P-256 + SHA-256 signature over the manifest JSON
 *                               (base64url-encoded DER). Omitted when no key is configured.
 */
export function createExpoHeaders(signature?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "expo-protocol-version": "1",
    "expo-sfv-version": "0",
    "cache-control": "private, max-age=0, must-revalidate",
    "content-type": "application/json"
  };

  if (signature) {
    // EAS format: sig="<base64>", keyid="root", alg="sig-rs256"
    // For ECDSA P-256 we use the simpler bare signature header
    headers["expo-signature"] = `sig="${signature}", keyid="root", alg="ecdsa-p256-sha256"`;
  }

  return headers;
}

/**
 * Build the multipart/mixed response body required when the client sends
 * `Accept: multipart/mixed` (expo-updates >=0.18).
 *
 * Layout:
 *   --<boundary>
 *   Content-Type: application/json
 *   expo-signature: sig="...", keyid="root", alg="ecdsa-p256-sha256"
 *
 *   <manifest JSON>
 *   --<boundary>--
 */
export function buildMultipartManifestBody(
  manifest: ExpoManifest,
  signature?: string
): { body: string; boundary: string } {
  const boundary = "expo-update-boundary-" + Math.random().toString(36).slice(2, 10);
  const manifestJson = JSON.stringify(manifest);

  let partHeaders = "Content-Disposition: inline; name=\"manifest\"\r\n";
  partHeaders += "Content-Type: application/json\r\n";
  if (signature) {
    partHeaders += `expo-signature: sig="${signature}", keyid="root", alg="ecdsa-p256-sha256"\r\n`;
  }

  const body =
    `--${boundary}\r\n` +
    `${partHeaders}\r\n` +
    `${manifestJson}\r\n` +
    `--${boundary}--\r\n`;

  return { body, boundary };
}
