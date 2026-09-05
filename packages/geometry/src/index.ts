export type LayoutId = "C1" | "C2" | "C3" | "S1";

export type QCCodeLayout = {
  id: LayoutId;
  numericId: 1 | 2 | 3;
  visualVersion: 1 | 2;
  rsBlocks: 1 | 2 | 3;
  ringSlots: readonly number[];
  totalSlots: number;
  bitsPerSlot: 2;
  permutationMultiplier: number;
  centerRadius: number;
  rsDataBytes: number;
  rsParityBytes: number;
  rsCodewordBytes: number;
};

export const LAYOUTS: Readonly<Record<LayoutId, QCCodeLayout>> = {
  C1: {
    id: "C1", numericId: 1, visualVersion: 1, rsBlocks: 1,
    ringSlots: [140, 152, 164, 176, 188, 200],
    totalSlots: 1020, bitsPerSlot: 2, permutationMultiplier: 509, centerRadius: 0.38,
    rsDataBytes: 191, rsParityBytes: 64, rsCodewordBytes: 255,
  },
  C2: {
    id: "C2", numericId: 2, visualVersion: 1, rsBlocks: 2,
    ringSlots: [194, 202, 210, 218, 226, 234, 242, 250, 264],
    totalSlots: 2040, bitsPerSlot: 2, permutationMultiplier: 1031, centerRadius: 0.34,
    rsDataBytes: 191, rsParityBytes: 64, rsCodewordBytes: 255,
  },
  C3: {
    id: "C3", numericId: 3, visualVersion: 1, rsBlocks: 3,
    ringSlots: [222, 228, 234, 240, 246, 252, 258, 264, 270, 276, 282, 288],
    totalSlots: 3060, bitsPerSlot: 2, permutationMultiplier: 1543, centerRadius: 0.30,
    rsDataBytes: 191, rsParityBytes: 64, rsCodewordBytes: 255,
  },
  S1: {
    id: "S1", numericId: 1, visualVersion: 2, rsBlocks: 1,
    ringSlots: [40, 48, 55, 61, 68, 72],
    totalSlots: 344, bitsPerSlot: 2, permutationMultiplier: 171, centerRadius: 0.38,
    rsDataBytes: 54, rsParityBytes: 32, rsCodewordBytes: 86,
  },
};

for (const layout of Object.values(LAYOUTS)) {
  const actual = layout.ringSlots.reduce((sum, count) => sum + count, 0);
  if (actual !== layout.totalSlots || actual * layout.bitsPerSlot !== layout.rsBlocks * layout.rsCodewordBytes * 8) throw new Error(`invalid ${layout.id} capacity`);
}

export const ORIENTATION_BITS = Uint8Array.from(
  "111111000001000011000101001111010001110010010110111011001101010",
  Number,
);

export type PhysicalSlot = { ring: number; slot: number };

export function physicalIndexToSlot(layout: QCCodeLayout, physicalIndex: number): PhysicalSlot {
  if (!Number.isInteger(physicalIndex) || physicalIndex < 0 || physicalIndex >= layout.totalSlots) throw new Error("physical index out of range");
  let offset = physicalIndex;
  for (let ring = 0; ring < layout.ringSlots.length; ring++) {
    const count = layout.ringSlots[ring]!;
    if (offset < count) return { ring, slot: offset };
    offset -= count;
  }
  throw new Error("unreachable physical slot");
}

export function logicalToPhysicalIndex(layout: QCCodeLayout, logicalIndex: number): number {
  return (logicalIndex * layout.permutationMultiplier) % layout.totalSlots;
}

function extendedGcd(a: number, b: number): [number, number, number] {
  if (b === 0) return [a, 1, 0];
  const [gcd, x, y] = extendedGcd(b, a % b);
  return [gcd, y, x - Math.floor(a / b) * y];
}

export function physicalToLogicalIndex(layout: QCCodeLayout, physicalIndex: number): number {
  const [gcd, inverse] = extendedGcd(layout.permutationMultiplier, layout.totalSlots);
  if (gcd !== 1) throw new Error("layout permutation is not invertible");
  return (physicalIndex * ((inverse % layout.totalSlots + layout.totalSlots) % layout.totalSlots)) % layout.totalSlots;
}

const BCH_GENERATOR = 0x8faf;

function bchRemainder(value: number): number {
  let working = value;
  for (let bit = 30; bit >= 15; bit--) {
    if ((working & (1 << bit)) !== 0) working ^= BCH_GENERATOR << (bit - 15);
  }
  return working & 0x7fff;
}

function popcount32(value: number): number {
  let current = value >>> 0;
  current -= (current >>> 1) & 0x55555555;
  current = (current & 0x33333333) + ((current >>> 2) & 0x33333333);
  return (((current + (current >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function encodeBootstrap(layout: QCCodeLayout, mask: number): Uint8Array {
  if (!Number.isInteger(mask) || mask < 0 || mask > 7) throw new Error("invalid mask");
  const preamble = layout.visualVersion === 2 ? 0b10111 : 0b10110;
  const message = (preamble << 11) | (layout.numericId << 9) | (0b01 << 7) | (mask << 4);
  const code31 = ((message << 15) ^ bchRemainder(message << 15)) >>> 0;
  const parity = popcount32(code31) & 1;
  const code32 = ((code31 << 1) | parity) >>> 0;
  const result = new Uint8Array(64);
  for (let index = 0; index < 32; index++) result[index] = result[index + 32] = (code32 >>> (31 - index)) & 1;
  return result;
}

export function decodeBootstrap(bits: ArrayLike<number>): { layout: QCCodeLayout; mask: number; correctedBits: number } {
  if (bits.length !== 64) throw new Error("bootstrap ring must contain 64 bits");
  const copies = [0, 32].map((offset) => {
    let received = 0;
    for (let index = 0; index < 32; index++) received = (received * 2 + (bits[offset + index]! & 1)) >>> 0;
    let bestMessage = -1, bestDistance = 33;
    for (let message = 0; message <= 0xffff; message++) {
      const preamble = message >>> 11;
      if ((preamble !== 0b10110 && preamble !== 0b10111) || (message & 0xf) !== 0) continue;
      const layoutId = (message >>> 9) & 3;
      const ecc = (message >>> 7) & 3;
      if (ecc !== 1 || !layoutForMessage(preamble, layoutId)) continue;
      const code31 = ((message << 15) ^ bchRemainder(message << 15)) >>> 0;
      const code32 = ((code31 << 1) | (popcount32(code31) & 1)) >>> 0;
      const distance = popcount32(received ^ code32);
      if (distance < bestDistance) { bestDistance = distance; bestMessage = message; }
    }
    return { message: bestMessage, distance: bestDistance };
  });
  const valid = copies.filter((copy) => copy.message >= 0 && copy.distance <= 3).sort((a, b) => a.distance - b.distance);
  if (valid.length === 0) throw new Error("BOOTSTRAP_INVALID");
  if (valid.length === 2 && valid[0]!.message !== valid[1]!.message && valid[0]!.distance === valid[1]!.distance) throw new Error("BOOTSTRAP_AMBIGUOUS");
  const selected = valid[0]!;
  const preamble = selected.message >>> 11;
  const numericId = (selected.message >>> 9) & 3;
  const layout = layoutForMessage(preamble, numericId);
  if (!layout) throw new Error("BOOTSTRAP_INVALID");
  return { layout, mask: (selected.message >>> 4) & 7, correctedBits: selected.distance };
}

function layoutForMessage(preamble: number, numericId: number): QCCodeLayout | undefined {
  return Object.values(LAYOUTS).find((candidate) =>
    (preamble === 0b10110 ? candidate.visualVersion === 1 : candidate.visualVersion === 2) && candidate.numericId === numericId,
  );
}

export function recoverOrientation(sampled: ArrayLike<number>): { offset: number; mirrored: boolean; confidence: number; margin: number } {
  if (sampled.length !== 63) throw new Error("orientation ring must contain 63 samples");
  const candidates: Array<{ matches: number; offset: number; mirrored: boolean }> = [];
  for (const mirrored of [false, true]) {
    for (let offset = 0; offset < 63; offset++) {
      let matches = 0;
      for (let index = 0; index < 63; index++) {
        const sourceIndex = mirrored ? (offset - index + 126) % 63 : (index + offset) % 63;
        if ((sampled[index]! & 1) === ORIENTATION_BITS[sourceIndex]) matches++;
      }
      candidates.push({ matches, offset, mirrored });
    }
  }
  candidates.sort((a, b) => b.matches - a.matches);
  const best = candidates[0]!, second = candidates[1]!;
  const confidence = best.matches / 63;
  const margin = (best.matches - second.matches) / 63;
  if (confidence < 0.70 || margin < 0.16) throw new Error("ORIENTATION_AMBIGUOUS");
  return { offset: best.offset, mirrored: best.mirrored, confidence, margin };
}

export type QCCodeSymbol = {
  visualVersion: 1 | 2;
  layout: QCCodeLayout;
  eccId: 1;
  mask: number;
  orientation: Uint8Array;
  bootstrap: Uint8Array;
  dataRings: Uint8Array[];
};

/** Merge adjacent equal samples without moving their angular sampling centers. */
export function arcRuns(bits: ArrayLike<number>): Array<{ start: number; end: number; value: number }> {
  const runs: Array<{ start: number; end: number; value: number }> = [];
  let boundary = 0;
  while (boundary < bits.length && bits[boundary] === bits[(boundary + bits.length - 1) % bits.length]) boundary++;
  if (boundary === bits.length) return bits.length ? [{ start: 0, end: bits.length - 1, value: bits[0]! }] : [];
  for (let offset = 0; offset < bits.length; offset++) {
    const slot = boundary + offset;
    const value = bits[slot % bits.length]!;
    const last = runs[runs.length - 1];
    if (last && last.value === value) last.end = slot;
    else runs.push({ start: slot, end: slot, value });
  }
  return runs;
}
