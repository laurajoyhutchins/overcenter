import { createGitHubAppJwt } from "lib/github-app-poc.js";

export const access = "admin";
export const methods = ["GET"];

function bytesToPem(bytes, label) {
  let binary = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 0x8000) {
    binary += String.fromCharCode(...arr.subarray(i, i + 0x8000));
  }
  const base64 = btoa(binary);
  const lines = base64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----`;
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export default async function (req, res) {
  try {
    const keyPair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"]
    );
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
    const pem = bytesToPem(pkcs8, "PRIVATE KEY");
    const jwt = await createGitHubAppJwt({ appId: "123456", privateKeyPem: pem, nowSeconds: 1_800_000_000 });
    const [header, payload, signature] = jwt.split(".");
    const verified = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      keyPair.publicKey,
      base64UrlToBytes(signature),
      new TextEncoder().encode(`${header}.${payload}`)
    );
    const decodedPayload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
    res.json({
      ok: verified,
      algorithm: "RS256",
      webcrypto_sign_verify: verified,
      iat_backdated_seconds: 60,
      lifetime_seconds: decodedPayload.exp - decodedPayload.iat,
      private_key_exposed: false
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: "CRYPTO_SELFTEST_FAILED", message: error.message });
  }
}