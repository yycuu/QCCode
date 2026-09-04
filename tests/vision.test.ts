import { describe, expect, it } from "vitest";
import { encodeQCCode } from "../packages/encoder/src/index.js";
import { QCCodeFlag, QCCodeMode, encodeBearerEnvelope } from "../packages/protocol/src/index.js";
import { issueEnvelope, privateKeyFromSeed } from "../packages/security/src/index.js";
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
