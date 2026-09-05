import { describe, expect, it } from "vitest";
import { encodeQCCode } from "../packages/encoder/src/index.js";
import { QCCodeFlag, QCCodeMode, encodeBearerEnvelope } from "../packages/protocol/src/index.js";
import { issueEnvelope, privateKeyFromSeed } from "../packages/security/src/index.js";
import { decodeSampledSymbol } from "../packages/decoder/src/index.js";
import { decodeImageData } from "../packages/vision/src/index.js";

const hex = (value: string) => Uint8Array.from(value.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
const seed = hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");

const hexToGray = (color: string): number => {
  const value = Number.parseInt(color.slice(1), 16);
  return Math.round(0.2126 * (value >>> 16) + 0.7152 * ((value >>> 8) & 255) + 0.0722 * (value & 255));
};

const WHITE = 255;
const DATA_BACKGROUND = hexToGray("#F1F3F2");
const CALIBRATION = hexToGray("#DCE3DE");
const LEVELS = [DATA_BACKGROUND, hexToGray("#C6CCC8"), hexToGray("#737A76"), 0];

function rasterizeSymbol(symbol: ReturnType<typeof encodeQCCode>): { width: number; height: number; data: Uint8ClampedArray } {
  const scale = 4;
  const size = 920;
  const center = size / 2;
  const guard = 113 * scale;
  const data = new Uint8ClampedArray(size * size * 4);
  const paint = (x: number, y: number, gray: number): void => {
    const offset = (y * size + x) * 4;
    data[offset] = gray;
    data[offset + 1] = gray;
    data[offset + 2] = gray;
    data[offset + 3] = 255;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - center, dy = y - center;
      const distance = Math.hypot(dx, dy);
      if (distance > guard) { paint(x, y, WHITE); continue; }
      const units = distance / scale;
      const angle = (Math.atan2(dy, dx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
      if (units >= 106) { paint(x, y, 0); continue; }
      if (units >= 97) {
        const slot = Math.floor(angle / (Math.PI * 2 / symbol.orientation.length)) % symbol.orientation.length;
        paint(x, y, symbol.orientation[slot] ? 0 : CALIBRATION);
        continue;
      }
      if (units >= 89) {
        const slot = Math.floor(angle / (Math.PI * 2 / symbol.bootstrap.length)) % symbol.bootstrap.length;
        paint(x, y, symbol.bootstrap[slot] ? 0 : CALIBRATION);
        continue;
      }
      if (units >= 87) { paint(x, y, WHITE); continue; }
      paint(x, y, DATA_BACKGROUND);
      const inner = symbol.layout.centerRadius * 113;
      const radialPitch = (87 - inner) / symbol.dataRings.length;
      for (let ring = 0; ring < symbol.dataRings.length; ring++) {
        const bandInner = inner + ring * radialPitch + 0.17;
        const bandOuter = inner + (ring + 1) * radialPitch - 0.17;
        if (units < bandInner || units >= bandOuter) continue;
        const ringBits = symbol.dataRings[ring]!;
        const angularPitch = Math.PI * 2 / ringBits.length;
        const slot = Math.floor(angle / angularPitch) % ringBits.length;
        const fraction = (angle - Math.floor(angle / angularPitch) * angularPitch) / angularPitch;
        const inside = symbol.layout.visualVersion === 2 ? fraction >= 0.42 && fraction < 0.58 : fraction >= 0.03 && fraction < 0.97;
        if (inside) paint(x, y, LEVELS[ringBits[slot]!]!);
        break;
      }
    }
  }
  return { width: size, height: size, data };
}

describe("vision pipeline", () => {
  it("recovers every quaternary level from a rasterized C1 symbol", async () => {
    const envelope = await issueEnvelope({
      mode: QCCodeMode.INLINE,
      flags: QCCodeFlag.USER_CONFIRMATION_REQUIRED,
      issuerId: new Uint8Array(16).fill(1),
      keyId: 1,
      messageType: 1,
      messageId: new Uint8Array(16).fill(2),
      issuedAt: 100n,
      expiresAt: 200n,
      nonce: new Uint8Array(16).fill(3),
      payload: Uint8Array.from({ length: 32 }, (_, index) => index),
    }, await privateKeyFromSeed(seed));
    const symbol = encodeQCCode(envelope);
    expect(symbol.layout.id).toBe("C1");

    const image = rasterizeSymbol(symbol);
    const result = decodeImageData(image as unknown as ImageData);

    expect(result.unknownPhysicalSlots).toHaveLength(0);
    expect(result.symbol.dataRings).toEqual(symbol.dataRings);
    expect(result.confidence).toBeGreaterThan(0.95);
  });

  it("recovers every quaternary level from a rasterized S1 symbol", async () => {
    const envelope = encodeBearerEnvelope({
      issuerId: Uint8Array.from({ length: 8 }, (_, index) => index),
      messageType: 1001,
      messageId: Uint8Array.from({ length: 12 }, (_, index) => 0x10 + index),
      issuedAt: 1_700_000_000,
      expiresAt: 1_700_000_300,
      resourceType: 7,
      resourceId: Uint8Array.from({ length: 12 }, (_, index) => 0xa0 + index),
    });
    const symbol = encodeQCCode(envelope);
    expect(symbol.layout.id).toBe("S1");

    const image = rasterizeSymbol(symbol);
    const result = decodeImageData(image as unknown as ImageData);

    expect(result.unknownPhysicalSlots).toHaveLength(0);
    expect(result.symbol.dataRings).toEqual(symbol.dataRings);
    expect(result.symbol.visualVersion).toBe(2);
  });
});

function bearerFixture() {
  return encodeQCCode(encodeBearerEnvelope({
    issuerId: new Uint8Array(8).fill(1), messageType: 1001,
    messageId: new Uint8Array(12).fill(2), issuedAt: 100, expiresAt: 200,
    resourceType: 7, resourceId: new Uint8Array(12).fill(3),
  }));
}

function cameraScene(q = 0, shear = 0) {
  const source = rasterizeSymbol(bearerFixture());
  const width = 1400, height = 1100;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let gray = 255;
    // Monitor edge, unrelated text-like bars, and dock outside the code.
    if (x < 18 || y > 1060 || (y > 25 && y < 48 && x > 250 && x < 1200)) gray = 0;
    const u = (x - 750) / 452, v = (y - 550) / 452;
    const sy = (v - q) / (1 - q * v);
    const sx = (u - shear * sy) * (1 + q * sy) / Math.sqrt(1 - q * q);
    const px = Math.round(460 + sx * 452), py = Math.round(460 + sy * 452);
    if (px >= 0 && px < source.width && py >= 0 && py < source.height) gray = source.data[(py * source.width + px) * 4]!;
    const offset = (y * width + x) * 4;
    data[offset] = data[offset + 1] = data[offset + 2] = gray;
  }
  return { width, height, data } as ImageData;
}

it("locates an independent ring despite dark monitor edges and text", () => {
  const result = decodeImageData(cameraScene());
  expect(result.symbol.dataRings).toEqual(bearerFixture().dataRings);
  expect(result.bounds.x).toBeGreaterThan(250);
});

it("recovers mild bounded projective distortion with CRC validation", () => {
  const result = decodeImageData(cameraScene(.04), { maxCorrections: 27 });
  expect(decodeSampledSymbol(result.symbol, result.unknownPhysicalSlots).envelopeBytes).toEqual(decodeSampledSymbol(bearerFixture(), []).envelopeBytes);
});

it("rejects blank images and unrelated dark rectangles", () => {
  const width = 200, height = 200;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  expect(() => decodeImageData({ width, height, data } as ImageData)).toThrow("VISUAL_CANDIDATE_NOT_FOUND");
  for (let y = 30; y < 170; y++) for (let x = 30; x < 170; x++) {
    const i = (y * width + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 0;
  }
  expect(() => decodeImageData({ width, height, data } as ImageData)).toThrow("VISUAL_CANDIDATE_NOT_FOUND");
});

it("rejects an unrelated closed ring after candidate detection", () => {
  const width = 200, height = 200;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const radius = Math.hypot(x - 100, y - 100);
    if (radius < 70 || radius > 76) continue;
    const i = (y * width + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 0;
  }
  expect(() => decodeImageData({ width, height, data } as ImageData, { maxCorrections: 1 })).toThrow("VISUAL_ORIENTATION_FAILED");
});
