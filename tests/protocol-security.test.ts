import { describe, expect, it } from "vitest";
import {
  QCCodeFlag,
  QCCodeMode,
  encodeReferencePayload,
  encodeSignedBytes,
  parseEnvelope,
} from "../packages/protocol/src/index.js";
import {
  MemoryTrustStore,
  issueEnvelope,
  privateKeyFromSeed,
  verifyEnvelopeOffline,
} from "../packages/security/src/index.js";

const hex = (value: string) => Uint8Array.from(value.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
const seed = hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
const publicKey = hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
const issuerId = Uint8Array.from({ length: 16 }, (_, index) => index + 1);

const input = {
  mode: QCCodeMode.REFERENCE,
  flags: QCCodeFlag.SERVER_RESOLUTION_REQUIRED | QCCodeFlag.SINGLE_USE,
  issuerId,
  keyId: 27,
  messageType: 7,
  messageId: Uint8Array.from({ length: 16 }, (_, index) => 0x20 + index),
  issuedAt: 1_700_000_000n,
  expiresAt: 1_700_000_300n,
  nonce: Uint8Array.from({ length: 16 }, (_, index) => 0x40 + index),
  payload: encodeReferencePayload(9, Uint8Array.from({ length: 16 }, (_, index) => 0x60 + index)),
};

describe("binary envelope and Ed25519", () => {
  const trust = () => new MemoryTrustStore([{
    issuerId,
    keyId: 27,
    publicKey,
    status: "CURRENT" as const,
    notBefore: 0n,
    notAfter: 2_000_000_000n,
  }]);

  it("has the specified byte length and verifies", async () => {
    expect(encodeSignedBytes(input)).toHaveLength(99);
    const bytes = await issueEnvelope(input, await privateKeyFromSeed(seed));
    expect(bytes).toHaveLength(163);
    expect(parseEnvelope(bytes).keyId).toBe(27);
    const result = await verifyEnvelopeOffline(bytes, trust(), { now: 1_700_000_100n, clockSkewSeconds: 0n });
    expect(result.signatureValid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("rejects one-bit payload modification", async () => {
    const bytes = await issueEnvelope(input, await privateKeyFromSeed(seed));
    bytes[90] ^= 1;
    expect((await verifyEnvelopeOffline(bytes, trust(), { now: 1_700_000_100n })).error).toBe("SIGNATURE_INVALID");
  });

  it.each([
    ["mode", 5, 3], ["flags", 7, 1], ["issuer", 9, 1], ["keyId", 28, 1], ["messageType", 30, 1],
    ["messageId", 31, 1], ["issuedAt", 54, 1], ["expiresAt", 62, 1], ["nonce", 63, 1], ["payload", 81, 1],
  ] as const)("rejects a signed-field modification: %s", async (_name, offset, delta) => {
    const bytes = await issueEnvelope(input, await privateKeyFromSeed(seed));
    bytes[offset] = bytes[offset]! ^ delta;
    const result = await verifyEnvelopeOffline(bytes, trust(), { now: 1_700_000_100n });
    expect(result.signatureValid).toBe(false);
  });

  it("reports expiration separately from signature validity", async () => {
    const bytes = await issueEnvelope(input, await privateKeyFromSeed(seed));
    const result = await verifyEnvelopeOffline(bytes, trust(), { now: 1_700_001_000n, clockSkewSeconds: 0n });
    expect(result.signatureValid).toBe(true);
    expect(result.error).toBe("EXPIRED");
  });

  it("rejects trailing bytes", async () => {
    const bytes = await issueEnvelope(input, await privateKeyFromSeed(seed));
    expect(() => parseEnvelope(Uint8Array.from([...bytes, 0]))).toThrow(/length/u);
  });
});
