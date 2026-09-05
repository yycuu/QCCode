import { bitsToBytes, crc32c, maskSymbol, reedSolomonDecode } from "@qccode/core";
import { decodeBootstrap, logicalToPhysicalIndex, physicalIndexToSlot, physicalToLogicalIndex, type QCCodeSymbol } from "@qccode/geometry";
import { BEARER_ENVELOPE_BYTES, equalBytes, isBearerEnvelope, parseBearerEnvelope, parseEnvelope, type BearerEnvelope, type EnvelopeV1 } from "@qccode/protocol";

export type IdealDecodeResult = {
  envelopeBytes: Uint8Array;
  envelope: EnvelopeV1 | BearerEnvelope;
  /** C1/C2/C3 are deprecated and will be removed in a future release. Migrate to S1. */
  layout: "C1" | "C2" | "C3" | "S1";
  mask: number;
  correctedErrors: number;
  erasures: number;
};

let warnedDeprecatedLayout = false;

function decodeSymbol(symbol: QCCodeSymbol, unknownPhysicalSlots: readonly number[]): IdealDecodeResult {
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
  const blocks = Array.from({ length: symbol.layout.rsBlocks }, () => new Uint8Array(symbol.layout.rsCodewordBytes));
  for (let index = 0; index < visualBytes.length; index++) blocks[index % symbol.layout.rsBlocks]![Math.floor(index / symbol.layout.rsBlocks)] = visualBytes[index]!;
  const blockErasures = Array.from({ length: symbol.layout.rsBlocks }, () => new Set<number>());
  for (const physical of unknownPhysicalSlots) {
    const logical = physicalToLogicalIndex(symbol.layout, physical);
    const visualByte = Math.floor((logical * 2) / 8);
    blockErasures[visualByte % symbol.layout.rsBlocks]!.add(Math.floor(visualByte / symbol.layout.rsBlocks));
  }
  const decoded = blocks.map((block, index) => reedSolomonDecode(block, [...blockErasures[index]!], symbol.layout.rsParityBytes));
  const frame = new Uint8Array(symbol.layout.rsBlocks * symbol.layout.rsDataBytes);
  for (let index = 0; index < frame.length; index++) frame[index] = decoded[index % symbol.layout.rsBlocks]!.data[Math.floor(index / symbol.layout.rsBlocks)]!;
  let envelopeBytes: Uint8Array;
  let envelope: EnvelopeV1 | BearerEnvelope;
  if (symbol.layout.visualVersion === 2) {
    const expectedCrc = new DataView(frame.buffer).getUint32(BEARER_ENVELOPE_BYTES, false);
    if (crc32c(frame.slice(0, BEARER_ENVELOPE_BYTES)) !== expectedCrc) throw new Error("CRC_FAILED");
    if (!frame.slice(BEARER_ENVELOPE_BYTES + 4).every((byte) => byte === 0)) throw new Error("PROTOCOL_INVALID");
    envelopeBytes = frame.slice(0, BEARER_ENVELOPE_BYTES);
    envelope = parseBearerEnvelope(envelopeBytes);
  } else {
    if (frame[0] !== 0xa7 || frame[1] !== 0x3c || frame[2] !== 1 || frame[3] !== symbol.layout.numericId || frame[4] !== 1 || frame[5] !== symbol.mask) throw new Error("PROTOCOL_INVALID");
    const envelopeLength = new DataView(frame.buffer).getUint16(6, false);
    if (envelopeLength > frame.length - 12) throw new Error("PROTOCOL_INVALID");
    const expectedCrc = new DataView(frame.buffer).getUint32(8 + envelopeLength, false);
    if (crc32c(frame.slice(0, 8 + envelopeLength)) !== expectedCrc) throw new Error("CRC_FAILED");
    if (!frame.slice(12 + envelopeLength).every((byte) => byte === 0)) throw new Error("PROTOCOL_INVALID");
    envelopeBytes = frame.slice(8, 8 + envelopeLength);
    envelope = isBearerEnvelope(envelopeBytes) ? parseBearerEnvelope(envelopeBytes) : parseEnvelope(envelopeBytes);
  }
  if (!equalBytes(envelope.bytes, envelopeBytes)) throw new Error("PROTOCOL_INVALID");
  if (symbol.layout.visualVersion === 1 && !warnedDeprecatedLayout) {
    warnedDeprecatedLayout = true;
    console.warn("[QCCode] C1/C2/C3 formats are deprecated as of v0.3.5 and will be removed in a future release. Migrate to S1 using server-issued bearer envelopes and online redemption; S1 does not support signed envelopes or offline verification.");
  }
  return {
    envelopeBytes,
    envelope,
    layout: symbol.layout.id,
    mask: symbol.mask,
    correctedErrors: decoded.reduce((sum, block) => sum + block.correctedErrors, 0),
    erasures: decoded.reduce((sum, block) => sum + block.erasures, 0),
  };
}

export function decodeIdealSymbol(symbol: QCCodeSymbol): IdealDecodeResult {
  return decodeSymbol(symbol, []);
}

export function decodeSampledSymbol(symbol: QCCodeSymbol, unknownPhysicalSlots: readonly number[]): IdealDecodeResult {
  return decodeSymbol(symbol, unknownPhysicalSlots);
}
