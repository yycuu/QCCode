import { describe, expect, it } from "vitest";
import { decodeIdealSymbol, decodeSampledSymbol } from "../packages/decoder/src/index.js";
import { encodeQCCode } from "../packages/encoder/src/index.js";
import { decodeBootstrap, encodeBootstrap, LAYOUTS, physicalIndexToSlot } from "../packages/geometry/src/index.js";
import { encodeBearerEnvelope, equalBytes, parseBearerEnvelope } from "../packages/protocol/src/index.js";
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
      damaged.dataRings[ring]![slot] ^= 3;
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
