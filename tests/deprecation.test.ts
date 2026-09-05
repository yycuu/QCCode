import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QCCodeMode, attachSignature, encodeBearerEnvelope, encodeSignedBytes } from "../packages/protocol/src/index.js";

const bearer = encodeBearerEnvelope({
  issuerId: new Uint8Array(8).fill(1),
  messageType: 1,
  messageId: new Uint8Array(12).fill(2),
  issuedAt: 1_700_000_000,
  expiresAt: 1_700_000_300,
  resourceType: 1,
  resourceId: new Uint8Array(12).fill(3),
});

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("SDK format deprecation", () => {
  it.each([undefined, "auto", "S1"] as const)("does not warn for imports or S1 with layout %s", async (layout) => {
    const sdk = await import("../packages/sdk/src/index.js");
    const symbol = sdk.encodeQCCode(bearer, layout === undefined ? {} : { layout });
    expect(symbol.layout.id).toBe("S1");
    expect(sdk.decodeIdealSymbol(symbol).envelopeBytes).toEqual(bearer);
    expect(sdk.decodeSampledSymbol(symbol, []).envelopeBytes).toEqual(bearer);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each(["C1", "C2", "C3"] as const)("warns once for %s while preserving bearer round trips", async (layout) => {
    const sdk = await import("../packages/sdk/src/index.js");
    const symbol = sdk.encodeQCCode(bearer, { version: layout });
    expect(symbol.layout.id).toBe(layout);
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(new RegExp(`${layout}.*deprecated.*v0\\.3\\.5.*removed in a future release.*Migrate to S1`)));
    sdk.encodeQCCode(bearer, { layout });
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(sdk.decodeSampledSymbol(symbol, []).envelopeBytes).toEqual(bearer);
    expect(sdk.decodeIdealSymbol(symbol).envelopeBytes).toEqual(bearer);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("warns once for each deprecated layout used in the same runtime", async () => {
    const sdk = await import("../packages/sdk/src/index.js");
    sdk.encodeQCCode(bearer, { layout: "C1" });
    sdk.encodeQCCode(bearer, { layout: "C2" });
    sdk.encodeQCCode(bearer, { layout: "C1" });
    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(console.warn).mock.calls.map(([message]) => message)).toEqual([
      expect.stringMatching(/C1.*deprecated/),
      expect.stringMatching(/C2.*deprecated/),
    ]);
  });

  it.each([[32, "C1"], [50, "C2"], [300, "C3"]] as const)("warns when auto selects %s-byte signed payload layout %s", async (payloadLength, layout) => {
    const sdk = await import("../packages/sdk/src/index.js");
    // A parsing-only fixture: visual encoding does not verify the signature.
    const envelope = attachSignature(encodeSignedBytes({
      mode: QCCodeMode.INLINE, flags: 0, issuerId: new Uint8Array(16).fill(1), keyId: 1,
      messageType: 1, messageId: new Uint8Array(16).fill(2), nonce: new Uint8Array(16).fill(3),
      issuedAt: 1_700_000_000n, expiresAt: 1_700_000_300n, payload: new Uint8Array(payloadLength),
    }), new Uint8Array(64));
    const symbol = sdk.encodeQCCode(envelope);
    expect(symbol.layout.id).toBe(layout);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(sdk.decodeIdealSymbol(symbol).envelopeBytes).toEqual(envelope);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(() => sdk.encodeQCCode(envelope, { layout: "S1" })).toThrow("S1 requires a bearer envelope");
  });

  it("does not warn for failed encoding or decoding attempts", async () => {
    const sdk = await import("../packages/sdk/src/index.js");
    expect(() => sdk.encodeQCCode(new Uint8Array(), { layout: "C1" })).toThrow();
    const symbol = sdk.encodeQCCode(bearer, { layout: "C1" });
    expect(() => sdk.decodeSampledSymbol({ ...symbol, dataRings: [] }, [])).toThrow();
    expect(console.warn).toHaveBeenCalledTimes(1);
    sdk.decodeIdealSymbol(symbol);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});
