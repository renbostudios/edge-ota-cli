/**
 * EdgeOTA Core - Cryptographic Utilities
 *
 * Implements ECDSA P-256 + SHA-256 signing and verification,
 * compatible with both Node.js (via globalThis.crypto.subtle) and
 * the Cloudflare Workers runtime (same Web Crypto API).
 *
 * Key format: PKCS#8 private key / SPKI public key — PEM-encoded.
 * Signature format: raw DER bytes → base64 string (NOT base64url,
 * to stay compatible with the existing expo-updates SDK verification).
 */

export interface KeyPairPEM {
  privateKey: string;
  publicKey: string;
}

/** Generate a fresh ECDSA P-256 key pair encoded as PEM. */
export async function generateECDSAKeyPair(): Promise<KeyPairPEM> {
  const keyPair = await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );

  const privateKeyDer = await globalThis.crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const publicKeyDer  = await globalThis.crypto.subtle.exportKey("spki",  keyPair.publicKey);

  return {
    privateKey: derToPem(privateKeyDer, "PRIVATE KEY"),
    publicKey:  derToPem(publicKeyDer,  "PUBLIC KEY")
  };
}

/**
 * Sign an arbitrary string payload with a PEM-encoded ECDSA P-256 private key.
 * Returns the raw signature bytes encoded as base64.
 */
export async function signPayload(payload: string, privateKeyPem: string): Promise<string> {
  const privateKeyDer = pemToDer(privateKeyPem, "PRIVATE KEY");
  const privateKey = await globalThis.crypto.subtle.importKey(
    "pkcs8",
    privateKeyDer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );

  const data      = new TextEncoder().encode(payload);
  const sigBuffer = await globalThis.crypto.subtle.sign(
    { name: "ECDSA", hash: { name: "SHA-256" } },
    privateKey,
    data
  );

  return arrayBufferToBase64(sigBuffer);
}

/**
 * Verify a base64-encoded ECDSA P-256 signature against a payload string
 * using a PEM-encoded public key.
 */
export async function verifyPayload(
  payload:        string,
  signatureBase64: string,
  publicKeyPem:   string
): Promise<boolean> {
  try {
    const publicKeyDer = pemToDer(publicKeyPem, "PUBLIC KEY");
    const publicKey = await globalThis.crypto.subtle.importKey(
      "spki",
      publicKeyDer,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );

    const data      = new TextEncoder().encode(payload);
    const signature = base64ToArrayBuffer(signatureBase64);

    return await globalThis.crypto.subtle.verify(
      { name: "ECDSA", hash: { name: "SHA-256" } },
      publicKey,
      signature,
      data
    );
  } catch {
    return false;
  }
}

/**
 * SHA-256 hash a buffer and return the hex string.
 * Used to produce the per-asset `hash` field in the Expo manifest.
 */
export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Internal PEM / DER utilities ────────────────────────────────────────────

function derToPem(der: ArrayBuffer, label: string): string {
  const base64 = arrayBufferToBase64(der);
  const lines   = base64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}

function pemToDer(pem: string, label: string): ArrayBuffer {
  const cleanPem = pem
    .replace(`-----BEGIN ${label}-----`, "")
    .replace(`-----END ${label}-----`, "")
    .replace(/\s+/g, "");
  return base64ToArrayBuffer(cleanPem);
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes  = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return globalThis.btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = globalThis.atob(base64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
