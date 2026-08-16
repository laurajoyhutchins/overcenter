import { createGitHubAppJwt, verifyGitHubAppJwtSelfTest } from "lib/github-app-poc.js";

export const access = "admin";
export const methods = ["GET"];

const TEST_PKCS8_B64 = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDBBN5/CmSysO9IlViYF/iYyEeUmeYEt7Ib4i4vn9tZLtdjKcY+JijjDuvV/3cXcqAOk/bdSt3XcYj2k+FTTcQJcRAcq2rxxcTPkOAOQcYW62QBE48Ib9DUt6zjMGPnd1lwOIz+KrNOFYzwjZYRTMLDjCfJlvJxlAw/M0MBoeaRML+AewHpQRtzV4Fph2FgRJxXShC4QSN2hw1RJBYBPHB7QvvHqsF8C01NwhpXeU4zwzXYq8sG7se7l+cPkX3n2CywyfMla2DjuOQ239cbobjQwgie1qWYeW/ZfwZhIFwX5BxZVlJ1hvWP8G8qzBnndxpkArgheZ7nd95L5pzNnwTDAgMBAAECggEAFSeiS9HeS9gTlGTLSHl8Gsv8oxSjqV8Ja3/vKEjAzYtSOlaWQ90tJwb4IcS1j0GAubL4NV8iuvMBHBFaJVCvzInH8R8iggF3JXlkl9DCqWQUL6qunFybn+zKSz4pp5v6QU/uuAlYYer/vvpYTmjCLJTRuYj3OoE2PxOwY4np5NNTpyXEIGLk8PFv4qEIPRv3Y3n9WBxRzSQ+OElP5q49h655GY3yYGCb7HtFHIckQu9cb75bvwS/he5+AlvfxkJGWNvY2UWThad2JxANI3ms2IWU/aZa5KhoycTCy2RtJnfa9qIJnjW298YapvFW1Ed9lgXhWOb2FyWJuwC6vfR5lQKBgQDqFV2xkCuxxx2Fl9hbgEZ/CgF2MScAm6JHM2dHBsTeuDzA+lmaTzwNWOxZbfArSoeGdlMevaL/4sOdeKsRITT8FBx08bE+875ht2taMS5neiXQJgEoageZsE3rbT65MkK4P4F+rQHLtSvkfVXrn6MW4CS6YuIuYBai7040Y+BSlQKBgQDTFz/Q5d/4UudefM8G5EGZkhF32hRM2NAjE9cXuJGRTSAWuI+ISK/aBvUMb5CUs950PCcpqAFHUJxPZ3d6JG+GcQju6Tef0Uff2fgBl7q/a0Euri/3heVQVhRONEgqqtvnQKZZWWenGguBMIk0AKqZKcx9iRJ+pQKlc0IZ/cs79wKBgH4ekOKQWNpp+3/09f8mt9TOoUb66JatQ9u02FouTXfqL+GRgSFgu2w9kuoED7hjaW2K5vHTHrVbiiWX1CNgjtmaRFLFvce7L8IaPt7TTLs31pO1Rj5uEjY+BV1o+LhzWftHTA/iSutka4ep99cBpa83iNJbYJ2367pR0QLtJPmZAoGAcxS8vNVl+kqwSqn+cAJm5SNmFJI2+QJGzqjVXeBItA95DAoIbkM6Y8HhPKtiBj/daj8VFre6IrgGz59X2qYciw360c0hfyaoaZi6hZvDuvHtMlbSXb6Imviiz1PfeCt4AaYUSqfcQ5SGayMb2db3KtNH4bSl+ZdaTvr8MZFUiFcCgYEAukdSv576NpON3+vGE7ggMyy7DzQCMb2J8MA4gXRai8P0dwrKCRZq74CywElMJmkVbGOmcIC6vF40DHyVg7WjZR9GJ2sQcXz2DUCC2UaBGZ9TE5fhbcHzZOjuVNFkgQECID0eJOMdIxk31U2/6dg/HvYzpuXID4kx8+mYMAaVel0=";

export default async function (req, res) {
  try {
    const pem = `-----BEGIN PRIVATE KEY-----\n${TEST_PKCS8_B64}\n-----END PRIVATE KEY-----`;
    const jwt = await createGitHubAppJwt({ appId: "123456", privateKeyPem: pem, nowSeconds: 1_800_000_000 });
    const verified = await verifyGitHubAppJwtSelfTest(jwt, pem);
    const payloadPart = jwt.split(".")[1];
    const normalized = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    const payload = JSON.parse(atob(padded));
    res.json({
      ok: verified,
      algorithm: "RS256",
      signature_verified_mathematically: verified,
      iat_backdated_seconds: 60,
      maximum_jwt_window_seconds: payload.exp - payload.iat,
      production_crypto_claim: false,
      note: "POC-only RSA implementation; native Hatchable GitHub App auth should own signing in production."
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: "CRYPTO_SELFTEST_FAILED", message: error.message });
  }
}