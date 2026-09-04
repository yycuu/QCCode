import { bytesToBits, crc32c, maskSymbol, reedSolomonEncode, RS_DATA_BYTES } from "@qccode/core";
import {
  encodeBootstrap,
  LAYOUTS,
  logicalToPhysicalIndex,
  ORIENTATION_BITS,
  physicalIndexToSlot,
  type QCCodeLayout,
  type QCCodeSymbol,
  type LayoutId,
} from "@qccode/geometry";
import { parseEnvelope } from "@qccode/protocol";

export type EncodeOptions = { version?: "auto" | LayoutId };

export function maximumEnvelopeBytes(layout: QCCodeLayout): number {
  return layout.rsBlocks * RS_DATA_BYTES - 12;
}

export function selectLayout(envelopeLength: number, requested: "auto" | LayoutId = "auto"): QCCodeLayout {
  if (requested !== "auto") {
    const layout = LAYOUTS[requested];
    if (envelopeLength > maximumEnvelopeBytes(layout)) throw new Error(`envelope does not fit ${requested}`);
    return layout;
  }
  const layout = Object.values(LAYOUTS).find((candidate) => envelopeLength <= maximumEnvelopeBytes(candidate));
  if (!layout) throw new Error("envelope exceeds C3; use REFERENCE mode");
  return layout;
}

export function createVisualFrame(envelope: Uint8Array, layout: QCCodeLayout, mask: number): Uint8Array {
  const sourceLength = layout.rsBlocks * RS_DATA_BYTES;
  const frame = new Uint8Array(sourceLength);
  const view = new DataView(frame.buffer);
  frame[0] = 0xa7;
  frame[1] = 0x3c;
  frame[2] = 0x01;
  frame[3] = layout.numericId;
  frame[4] = 0x01;
  frame[5] = mask;
  view.setUint16(6, envelope.length, false);
  frame.set(envelope, 8);
  view.setUint32(8 + envelope.length, crc32c(frame.slice(0, 8 + envelope.length)), false);
  return frame;
}

export function encodeVisualCodewords(frame: Uint8Array, layout: QCCodeLayout): Uint8Array {
  const blocks = Array.from({ length: layout.rsBlocks }, () => new Uint8Array(RS_DATA_BYTES));
  for (let index = 0; index < frame.length; index++) blocks[index % layout.rsBlocks]![Math.floor(index / layout.rsBlocks)] = frame[index]!;
  const encoded = blocks.map(reedSolomonEncode);
  const visual = new Uint8Array(layout.rsBlocks * 255);
  for (let index = 0; index < visual.length; index++) visual[index] = encoded[index % layout.rsBlocks]![Math.floor(index / layout.rsBlocks)]!;
  return visual;
}

function buildDataRings(bits: Uint8Array, layout: QCCodeLayout, mask: number): Uint8Array[] {
  const rings = layout.ringSlots.map((count) => new Uint8Array(count));
  if (bits.length !== layout.totalSlots * 2) throw new Error("visual bit count does not match quaternary layout");
  for (let logical = 0; logical < layout.totalSlots; logical++) {
    const physical = logicalToPhysicalIndex(layout, logical);
    const { ring, slot } = physicalIndexToSlot(layout, physical);
    const value = (bits[logical * 2]! << 1) | bits[logical * 2 + 1]!;
    rings[ring]![slot] = value ^ maskSymbol(mask, ring, slot);
  }
  return rings;
}

function ringPenalty(rings: Uint8Array[]): number {
  const levels = [0, 0, 0, 0];
  let total = 0, penalty = 0;
  for (const ring of rings) {
    for (const value of ring) levels[value] = levels[value]! + 1;
    total += ring.length;
    let run = 1;
    for (let index = 1; index <= ring.length; index++) {
      if (ring[index % ring.length] === ring[(index - 1) % ring.length]) run++;
      else { if (run > 5) penalty += 3 * (run - 5); run = 1; }
    }
  }
  for (const count of levels) penalty += Math.floor(Math.abs(count / total - 0.25) * 100);
  return penalty;
}

export function encodeQCCode(envelope: Uint8Array, options: EncodeOptions = {}): QCCodeSymbol {
  parseEnvelope(envelope);
  const layout = selectLayout(envelope.length, options.version ?? "auto");
  let best: { mask: number; rings: Uint8Array[]; penalty: number } | undefined;
  for (let mask = 0; mask < 8; mask++) {
    const frame = createVisualFrame(envelope, layout, mask);
    const rings = buildDataRings(bytesToBits(encodeVisualCodewords(frame, layout)), layout, mask);
    const penalty = ringPenalty(rings);
    if (!best || penalty < best.penalty) best = { mask, rings, penalty };
  }
  return {
    visualVersion: 1,
    layout,
    eccId: 1,
    mask: best!.mask,
    orientation: ORIENTATION_BITS.slice(),
    bootstrap: encodeBootstrap(layout, best!.mask),
    dataRings: best!.rings,
  };
}
