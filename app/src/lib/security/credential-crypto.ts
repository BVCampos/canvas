import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const ENVELOPE_VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AAD = Buffer.from("canvas:user-provider-credential:v1", "utf8");

// Thrown when a stored envelope can't be turned back into plaintext — a wrong or
// rotated server key, a corrupt row, or a tampered envelope. A distinct type so a
// caller (e.g. the OpenRouter run route) can tell "your saved key can't be
// decrypted, re-enter it" apart from "no key configured at all".
export class CredentialDecryptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CredentialDecryptError";
  }
}

function encryptionKey(): Buffer {
  const encoded = process.env.CANVAS_CREDENTIAL_ENCRYPTION_KEY?.trim();
  if (!encoded) {
    throw new Error("CANVAS_CREDENTIAL_ENCRYPTION_KEY is not configured");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      "CANVAS_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    );
  }
  return key;
}

// True iff CANVAS_CREDENTIAL_ENCRYPTION_KEY is present and well-formed (a base64
// 32-byte key). NOTE: this proves the key is USABLE, not that it's the SAME key
// the stored ciphertexts were encrypted with — a rotated key passes here yet
// fails every decryptCredential() at use. The readiness gate that calls this
// therefore catches an absent/malformed key, but not a silent key swap; that
// surfaces as a CredentialDecryptError when a turn actually runs.
export function credentialEncryptionAvailable(): boolean {
  try {
    encryptionKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptCredential(plaintext: string): string {
  if (!plaintext) throw new Error("Cannot encrypt an empty credential");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    ENVELOPE_VERSION,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

export function decryptCredential(envelope: string): string {
  try {
    const [version, ivPart, ciphertextPart, tagPart, ...extra] = envelope.split(".");
    if (
      version !== ENVELOPE_VERSION ||
      !ivPart ||
      !ciphertextPart ||
      !tagPart ||
      extra.length > 0
    ) {
      throw new Error("Unsupported credential envelope");
    }

    const iv = Buffer.from(ivPart, "base64url");
    const ciphertext = Buffer.from(ciphertextPart, "base64url");
    const tag = Buffer.from(tagPart, "base64url");
    if (iv.length !== IV_BYTES || tag.length !== 16 || ciphertext.length === 0) {
      throw new Error("Malformed credential envelope");
    }

    const decipher = createDecipheriv(ALGORITHM, encryptionKey(), iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch (cause) {
    // Normalize every failure mode — bad envelope, missing/rotated server key,
    // failed auth tag — into one typed error so callers get an actionable signal
    // instead of a raw OpenSSL / parse throw leaking out.
    throw new CredentialDecryptError(
      "Stored credential could not be decrypted (the server encryption key may be missing or different from when it was saved)",
      { cause },
    );
  }
}

