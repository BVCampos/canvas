import { describe, it, expect, beforeAll } from "vitest";

// asset-sign reads SUPABASE_SECRET_KEY at module load, so set a deterministic
// key BEFORE importing it.
beforeAll(() => {
  process.env.SUPABASE_SECRET_KEY ||= "test-secret-key-for-asset-signing";
});

const ASSET = "11111111-2222-4333-8444-555555555555";

async function mod() {
  return await import("../src/lib/canvas/asset-sign");
}

function parse(query: string) {
  const p = new URLSearchParams(query);
  return { exp: p.get("exp"), sig: p.get("sig") };
}

describe("asset-sign", () => {
  it("round-trips a freshly signed asset URL", async () => {
    const { assetSigQuery, verifyAssetSig } = await mod();
    const now = 1_000_000_000_000;
    const { exp, sig } = parse(assetSigQuery(ASSET, now));
    expect(verifyAssetSig(ASSET, exp, sig, now)).toBe(true);
  });

  it("rejects a tampered signature", async () => {
    const { assetSigQuery, verifyAssetSig } = await mod();
    const now = 1_000_000_000_000;
    const { exp, sig } = parse(assetSigQuery(ASSET, now));
    const tampered = (sig ?? "").slice(0, -1) + (sig?.endsWith("A") ? "B" : "A");
    expect(verifyAssetSig(ASSET, exp, tampered, now)).toBe(false);
  });

  it("rejects a signature minted for a different asset id", async () => {
    const { assetSigQuery, verifyAssetSig } = await mod();
    const now = 1_000_000_000_000;
    const { exp, sig } = parse(assetSigQuery(ASSET, now));
    const other = "99999999-2222-4333-8444-555555555555";
    expect(verifyAssetSig(other, exp, sig, now)).toBe(false);
  });

  it("rejects an expired signature", async () => {
    const { assetSigQuery, verifyAssetSig } = await mod();
    const now = 1_000_000_000_000;
    const { exp, sig } = parse(assetSigQuery(ASSET, now));
    // exp is rounded ~1-2h ahead; jump well past it.
    expect(verifyAssetSig(ASSET, exp, sig, now + 3 * 60 * 60 * 1000)).toBe(false);
  });

  it("rejects missing exp or sig", async () => {
    const { verifyAssetSig } = await mod();
    const now = 1_000_000_000_000;
    expect(verifyAssetSig(ASSET, null, "x", now)).toBe(false);
    expect(verifyAssetSig(ASSET, "9999999999999", null, now)).toBe(false);
  });
});
