import { describe, expect, it } from "vitest";
import { decodeIdealSymbol, decodeSampledSymbol } from "../packages/decoder/src/index.js";
import { encodeQCCode } from "../packages/encoder/src/index.js";
import { decodeBootstrap, encodeBootstrap, LAYOUTS, physicalIndexToSlot } from "../packages/geometry/src/index.js";
import { QCCodeFlag, encodeBearerEnvelope, equalBytes, parseBearerEnvelope } from "../packages/protocol/src/index.js";
import { renderSvg } from "../packages/renderer-svg/src/index.js";

function bearerEnvelope(): Uint8Array {
  return encodeBearerEnvelope({
    issuerId: Uint8Array.from({ length: 8 }, (_, index) => index),
    messageType: 1001,
    messageId: Uint8Array.from({ length: 12 }, (_, index) => 0x10 + index),
    issuedAt: 1_700_000_000,
    expiresAt: 1_700_000_300,
    resourceType: 7,
    resourceId: Uint8Array.from({ length: 12 }, (_, index) => 0xa0 + index),
  });
}

describe("sparse S1 layout", () => {
  it("round trips a bearer envelope through encoding and decoding", () => {
    const envelope = bearerEnvelope();
    expect(envelope.length).toBe(48);
    const symbol = encodeQCCode(envelope);
    expect(symbol.layout.id).toBe("S1");
    expect(symbol.visualVersion).toBe(2);
    const decoded = decodeIdealSymbol(symbol);
    expect(equalBytes(decoded.envelopeBytes, envelope)).toBe(true);
    const parsed = parseBearerEnvelope(decoded.envelopeBytes);
    expect(parsed.resourceType).toBe(7);
    expect(parsed.messageType).toBe(1001);
  });

  it("round trips the v2 bootstrap for S1", () => {
    for (let mask = 0; mask < 8; mask++) {
      const bits = encodeBootstrap(LAYOUTS.S1, mask);
      expect(decodeBootstrap(bits)).toMatchObject({ layout: LAYOUTS.S1, mask, correctedBits: 0 });
    }
  });

  it("does not confuse the v2 preamble with v1 layouts", () => {
    const bits = encodeBootstrap(LAYOUTS.S1, 3);
    expect(decodeBootstrap(bits).layout.id).toBe("S1");
    const v1 = encodeBootstrap(LAYOUTS.C1, 3);
    expect(decodeBootstrap(v1).layout.id).toBe("C1");
  });

  it("recovers a bearer envelope with unknown erasure slots", () => {
    const envelope = bearerEnvelope();
    const symbol = encodeQCCode(envelope);
    const erasures = Array.from({ length: 20 }, (_, index) => index * 7);
    const damaged = { ...symbol, dataRings: symbol.dataRings.map((ring) => ring.slice()) };
    for (const physical of erasures) {
      const { ring, slot } = physicalIndexToSlot(symbol.layout, physical);
      damaged.dataRings[ring]![slot] = damaged.dataRings[ring]![slot]! ^ 3;
    }
    const decoded = decodeSampledSymbol(damaged, erasures);
    expect(decoded.erasures).toBeGreaterThan(0);
    expect(equalBytes(decoded.envelopeBytes, envelope)).toBe(true);
  });

  it("renders sparse data rings as rounded dash marks", () => {
    const symbol = encodeQCCode(bearerEnvelope());
    const svg = renderSvg(symbol);
    expect(svg).toContain("stroke-linecap=\"round\"");
    expect(svg).toContain("#BBBBBB");
  });
});

it("merges matching samples across the angular seam", async () => {
  const { arcRuns } = await import("../packages/geometry/src/index.js");
  expect(arcRuns([3, 3, 0, 2, 3])).toEqual([
    { start: 2, end: 2, value: 0 },
    { start: 3, end: 3, value: 2 },
    { start: 4, end: 6, value: 3 },
  ]);
});

it.each(["C1", "C2", "C3", "S1"] as const)("honors explicit bearer layout %s", (layout) => {
  const envelope = bearerEnvelope();
  const symbol = encodeQCCode(envelope, { layout });
  expect(symbol.layout.id).toBe(layout);
  expect(decodeIdealSymbol(symbol).envelopeBytes).toEqual(envelope);
  expect(encodeQCCode(envelope, { version: layout }).layout.id).toBe(layout);
});

it("rejects conflicting layout options", () => {
  expect(() => encodeQCCode(bearerEnvelope(), { layout: "C1", version: "S1" })).toThrow("conflicting");
});

describe("strict bearer envelopes", () => {
  it("does not alias Node Buffer input", () => {
    const bytes = Buffer.from(bearerEnvelope());
    const parsed = parseBearerEnvelope(bytes);
    bytes.fill(0);
    expect(parsed.bytes).toEqual(bearerEnvelope());
    expect(parsed.issuerId).toEqual(bearerEnvelope().slice(6, 14));
    expect(parsed.messageId).toEqual(bearerEnvelope().slice(14, 26));
    expect(parsed.resourceId).toEqual(bearerEnvelope().slice(36, 48));
  });

  it.each([0, 1, 3, 255])("rejects mode byte %s", (mode) => {
    const bytes = bearerEnvelope();
    bytes[2] = mode;
    expect(() => parseBearerEnvelope(bytes)).toThrow("must be REFERENCE");
  });

  it("validates the mode at the typed array byte offset", () => {
    const padded = new Uint8Array(60);
    padded.set(bearerEnvelope(), 5);
    expect(parseBearerEnvelope(padded.subarray(5, 53)).resourceType).toBe(7);
    padded[7] = 255;
    expect(() => parseBearerEnvelope(padded.subarray(5, 53))).toThrow("must be REFERENCE");
  });

  it.each(["issuedAt", "expiresAt"] as const)("rejects invalid uint32 values for %s", (field) => {
    const input = parseBearerEnvelope(bearerEnvelope());
    for (const value of [-1, 1.5, NaN, Infinity, 0x1_0000_0000]) {
      expect(() => encodeBearerEnvelope({ ...input, [field]: value })).toThrow(`${field} is out of range`);
    }
  });

  it("accepts uint32 validity boundaries but rejects empty or reversed intervals", () => {
    const input = parseBearerEnvelope(bearerEnvelope());
    expect(parseBearerEnvelope(encodeBearerEnvelope({ ...input, issuedAt: 0, expiresAt: 0xffff_ffff }))).toMatchObject({ issuedAt: 0, expiresAt: 0xffff_ffff });
    expect(() => encodeBearerEnvelope({ ...input, expiresAt: input.issuedAt })).toThrow("validity interval");
    const bytes = bearerEnvelope();
    new DataView(bytes.buffer).setUint32(30, input.issuedAt - 1, false);
    expect(() => parseBearerEnvelope(bytes)).toThrow("validity interval");
  });

  it("rejects invalid flags and requires server resolution", () => {
    const input = parseBearerEnvelope(bearerEnvelope());
    for (const flags of [-1, 1.5, NaN, Infinity, 256, 0x1_0000_0003]) {
      expect(() => encodeBearerEnvelope({ ...input, flags })).toThrow("flags is out of range");
    }
    for (const flags of [0, QCCodeFlag.SINGLE_USE, 0x12]) {
      expect(() => encodeBearerEnvelope({ ...input, flags })).toThrow();
      const bytes = bearerEnvelope();
      bytes[3] = flags;
      expect(() => parseBearerEnvelope(bytes)).toThrow();
    }
  });
});
