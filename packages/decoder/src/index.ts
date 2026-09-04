import { bitsToBytes, crc32c, maskSymbol, reedSolomonDecode, RS_DATA_BYTES } from "@circlecode/core";
import { decodeBootstrap, logicalToPhysicalIndex, physicalIndexToSlot, physicalToLogicalIndex, type CircleCodeSymbol } from "@circlecode/geometry";
import { equalBytes, parseEnvelope, type EnvelopeV1 } from "@circlecode/protocol";

export type IdealDecodeResult = {
  envelopeBytes: Uint8Array;
  envelope: EnvelopeV1;
  layout: "C1" | "C2" | "C3";
  mask: number;
  correctedErrors: number;
  erasures: number;
};

function decodeSymbol(symbol: CircleCodeSymbol, unknownPhysicalSlots: readonly number[]): IdealDecodeResult {
  const bootstrap = decodeBootstrap(symbol.bootstrap);
  if (bootstrap.layout.id !== symbol.layout.id || bootstrap.mask !== symbol.mask) throw new Error("BOOTSTRAP_FRAME_MISMATCH");
  if (symbol.dataRings.length !== symbol.layout.ringSlots.length) throw new Error("VISUAL_DECODE_FAILED");
  const logicalBits = new Uint8Array(symbol.layout.totalSlots * 2);
  for (let logical = 0; logical < symbol.layout.totalSlots; logical++) {
    const { ring, slot } = physicalIndexToSlot(symbol.layout, logicalToPhysicalIndex(symbol.layout, logical));
    const visual = symbol.dataRings[ring]?.[slot];
    if (visual === undefined) throw new Error("VISUAL_DECODE_FAILED");
    const value = visual ^ maskSymbol(symbol.mask, ring, slot);
    logicalBits[logical * 2] = value >>> 1;
    logicalBits[logical * 2 + 1] = value & 1;
  }
  const visualBytes = bitsToBytes(logicalBits);
  const blocks = Array.from({ length: symbol.layout.rsBlocks }, () => new Uint8Array(255));
  for (let index = 0; index < visualBytes.length; index++) blocks[index % symbol.layout.rsBlocks]![Math.floor(index / symbol.layout.rsBlocks)] = visualBytes[index]!;
  const blockErasures = Array.from({ length: symbol.layout.rsBlocks }, () => new Set<number>());
  for (const physical of unknownPhysicalSlots) {
    const logical = physicalToLogicalIndex(symbol.layout, physical);
    const visualByte = Math.floor((logical * 2) / 8);
    blockErasures[visualByte % symbol.layout.rsBlocks]!.add(Math.floor(visualByte / symbol.layout.rsBlocks));
  }
  const decoded = blocks.map((block, index) => reedSolomonDecode(block, [...blockErasures[index]!]));
  const frame = new Uint8Array(symbol.layout.rsBlocks * RS_DATA_BYTES);
  for (let index = 0; index < frame.length; index++) frame[index] = decoded[index % symbol.layout.rsBlocks]!.data[Math.floor(index / symbol.layout.rsBlocks)]!;
  if (frame[0] !== 0xa7 || frame[1] !== 0x3c || frame[2] !== 1 || frame[3] !== symbol.layout.numericId || frame[4] !== 1 || frame[5] !== symbol.mask) throw new Error("PROTOCOL_INVALID");
  const envelopeLength = new DataView(frame.buffer).getUint16(6, false);
  if (envelopeLength > frame.length - 12) throw new Error("PROTOCOL_INVALID");
  const expectedCrc = new DataView(frame.buffer).getUint32(8 + envelopeLength, false);
  if (crc32c(frame.slice(0, 8 + envelopeLength)) !== expectedCrc) throw new Error("CRC_FAILED");
  if (!frame.slice(12 + envelopeLength).every((byte) => byte === 0)) throw new Error("PROTOCOL_INVALID");
  const envelopeBytes = frame.slice(8, 8 + envelopeLength);
  const envelope = parseEnvelope(envelopeBytes);
  if (!equalBytes(envelope.bytes, envelopeBytes)) throw new Error("PROTOCOL_INVALID");
  return {
    envelopeBytes,
    envelope,
    layout: symbol.layout.id,
    mask: symbol.mask,
    correctedErrors: decoded.reduce((sum, block) => sum + block.correctedErrors, 0),
    erasures: decoded.reduce((sum, block) => sum + block.erasures, 0),
  };
}

export function decodeIdealSymbol(symbol: CircleCodeSymbol): IdealDecodeResult {
  return decodeSymbol(symbol, []);
}

export function decodeSampledSymbol(symbol: CircleCodeSymbol, unknownPhysicalSlots: readonly number[]): IdealDecodeResult {
  return decodeSymbol(symbol, unknownPhysicalSlots);
}
