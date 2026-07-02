import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  CredentialDecryptError,
  credentialEncryptionAvailable,
  decryptCredential,
  encryptCredential,
} from "../src/lib/security/credential-crypto";

const originalKey = process.env.CANVAS_CREDENTIAL_ENCRYPTION_KEY;

beforeEach(() => {
  process.env.CANVAS_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
});

afterEach(() => {
  if (originalKey == null) delete process.env.CANVAS_CREDENTIAL_ENCRYPTION_KEY;
  else process.env.CANVAS_CREDENTIAL_ENCRYPTION_KEY = originalKey;
});

describe("credential encryption", () => {
  it("round-trips an API key without storing it in the envelope", () => {
    const plaintext = "sk-or-v1-private-test-value";
    const envelope = encryptCredential(plaintext);
    expect(envelope).toMatch(/^v1\./);
    expect(envelope).not.toContain(plaintext);
    expect(decryptCredential(envelope)).toBe(plaintext);
  });

  it("uses a fresh nonce for every save", () => {
    const first = encryptCredential("same-key");
    const second = encryptCredential("same-key");
    expect(first).not.toBe(second);
    expect(decryptCredential(first)).toBe("same-key");
    expect(decryptCredential(second)).toBe("same-key");
  });

  it("rejects tampering and the wrong encryption key", () => {
    const envelope = encryptCredential("secret");
    process.env.CANVAS_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    expect(() => decryptCredential(envelope)).toThrow();

    process.env.CANVAS_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    const fresh = encryptCredential("secret");
    const parts = fresh.split(".");
    parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
    const tampered = parts.join(".");
    expect(() => decryptCredential(tampered)).toThrow();
  });

  it("throws a typed CredentialDecryptError (not a raw crypto/parse throw)", () => {
    const envelope = encryptCredential("secret");
    // Rotated server key → auth tag fails. Caller can catch one known type.
    process.env.CANVAS_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    expect(() => decryptCredential(envelope)).toThrow(CredentialDecryptError);
    // A garbage envelope normalizes to the same typed error.
    expect(() => decryptCredential("not-an-envelope")).toThrow(CredentialDecryptError);
  });

  it("fails closed when the dedicated server key is absent or malformed", () => {
    delete process.env.CANVAS_CREDENTIAL_ENCRYPTION_KEY;
    expect(credentialEncryptionAvailable()).toBe(false);
    expect(() => encryptCredential("secret")).toThrow(/not configured/);

    process.env.CANVAS_CREDENTIAL_ENCRYPTION_KEY = "not-a-32-byte-key";
    expect(credentialEncryptionAvailable()).toBe(false);
    expect(() => encryptCredential("secret")).toThrow(/32-byte/);
  });
});
