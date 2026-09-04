import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bytesToBits } from "../packages/core/src/index.js";
import { createVisualFrame, encodeQCCode, encodeVisualCodewords } from "../packages/encoder/src/index.js";
import {
  QCCodeFlag,
  QCCodeMode,
  encodeChallengePayload,
  encodeReferencePayload,
  encodeSignedBytes,
  parseEnvelope,
  toBase64Url,
  type EnvelopeUnsignedV1,
} from "../packages/protocol/src/index.js";
import { issueEnvelope, privateKeyFromSeed } from "../packages/security/src/index.js";

const out = new URL("../tests/vectors/v1/", import.meta.url).pathname;
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const fromHex = (value: string) => Uint8Array.from(value.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
const seed = fromHex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
const publicKey = fromHex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
const privateKey = await privateKeyFromSeed(seed);
const base = {
  flags: QCCodeFlag.USER_CONFIRMATION_REQUIRED,
  issuerId: fromHex("00112233445566778899aabbccddeeff"),
  keyId: 27,
  messageType: 1001,
  messageId: fromHex("102132435465768798a9bacbdcedfe0f"),
  issuedAt: 1_700_000_000n,
  expiresAt: 1_700_000_300n,
  nonce: fromHex("ffeeddccbbaa99887766554433221100"),
};

const definitions: Array<{ name: string; input: EnvelopeUnsignedV1; mutation?: (bytes: Uint8Array) => void; expected: string }> = [
  { name: "inline-hello", input: { ...base, mode: QCCodeMode.INLINE, payload: new TextEncoder().encode("Hello") }, expected: "VALID" },
  { name: "reference-token", input: { ...base, mode: QCCodeMode.REFERENCE, flags: QCCodeFlag.SERVER_RESOLUTION_REQUIRED | QCCodeFlag.SINGLE_USE, payload: encodeReferencePayload(7, fromHex("0123456789abcdeffedcba9876543210")) }, expected: "VALID" },
  { name: "challenge-login", input: { ...base, mode: QCCodeMode.CHALLENGE, flags: QCCodeFlag.SINGLE_USE | QCCodeFlag.SERVER_RESOLUTION_REQUIRED | QCCodeFlag.USER_CONFIRMATION_REQUIRED, payload: encodeChallengePayload(1, fromHex("abcdef0123456789abcdef0123456789"), fromHex("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")) }, expected: "VALID_THEN_REPLAYED" },
  { name: "expired", input: { ...base, mode: QCCodeMode.INLINE, issuedAt: 1_600_000_000n, expiresAt: 1_600_000_030n, payload: new TextEncoder().encode("expired") }, expected: "EXPIRED" },
  { name: "invalid-signature", input: { ...base, mode: QCCodeMode.INLINE, payload: new TextEncoder().encode("signature") }, mutation: (bytes) => { bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; }, expected: "SIGNATURE_INVALID" },
  { name: "modified-payload", input: { ...base, mode: QCCodeMode.INLINE, payload: new TextEncoder().encode("payload") }, mutation: (bytes) => { bytes[81] = bytes[81]! ^ 1; }, expected: "SIGNATURE_INVALID" },
  { name: "wrong-issuer", input: { ...base, mode: QCCodeMode.INLINE, payload: new Uint8Array() }, mutation: (bytes) => { bytes[9] = bytes[9]! ^ 1; }, expected: "UNKNOWN_ISSUER" },
  { name: "wrong-kid", input: { ...base, mode: QCCodeMode.INLINE, payload: new Uint8Array() }, mutation: (bytes) => { bytes[28] = bytes[28]! ^ 1; }, expected: "UNKNOWN_KEY" },
  { name: "replay", input: { ...base, mode: QCCodeMode.CHALLENGE, flags: 7, payload: encodeChallengePayload(1, new Uint8Array(16).fill(9)) }, expected: "ACCEPTED_THEN_REPLAYED" },
];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await writeFile(join(out, "test-key.json"), JSON.stringify({ warning: "TEST KEY ONLY", privateSeedHex: hex(seed), publicKeyHex: hex(publicKey) }, null, 2) + "\n");

for (const definition of definitions) {
  const cleanSigned = encodeSignedBytes(definition.input);
  const envelope = await issueEnvelope(definition.input, privateKey);
  definition.mutation?.(envelope);
  const parsed = parseEnvelope(envelope);
  const symbol = encodeQCCode(envelope);
  const frame = createVisualFrame(envelope, symbol.layout, symbol.mask);
  const codewords = encodeVisualCodewords(frame, symbol.layout);
  const directory = join(out, definition.name);
  await mkdir(directory, { recursive: true });
  const fields = {
    mode: QCCodeMode[parsed.mode], flags: parsed.flags, issuerIdHex: hex(parsed.issuerId), keyId: parsed.keyId,
    messageType: parsed.messageType, messageIdHex: hex(parsed.messageId), issuedAt: parsed.issuedAt.toString(),
    expiresAt: parsed.expiresAt.toString(), nonceHex: hex(parsed.nonce), payloadHex: hex(parsed.payload),
  };
  await Promise.all([
    writeFile(join(directory, "fields.json"), JSON.stringify(fields, null, 2) + "\n"),
    writeFile(join(directory, "canonical-signed-bytes.hex"), hex(parsed.signedBytes) + "\n"),
    writeFile(join(directory, "original-canonical-signed-bytes.hex"), hex(cleanSigned) + "\n"),
    writeFile(join(directory, "signature.hex"), hex(parsed.signature) + "\n"),
    writeFile(join(directory, "envelope.hex"), hex(envelope) + "\n"),
    writeFile(join(directory, "envelope.base64url.txt"), toBase64Url(envelope) + "\n"),
    writeFile(join(directory, "visual-frame-before-padding.hex"), hex(frame.slice(0, 12 + envelope.length)) + "\n"),
    writeFile(join(directory, "rs-source.hex"), hex(frame) + "\n"),
    writeFile(join(directory, "rs-codewords.hex"), hex(codewords) + "\n"),
    writeFile(join(directory, "bootstrap-bits.txt"), Array.from(symbol.bootstrap).join("") + "\n"),
    writeFile(join(directory, "expected-ring-slots.txt"), symbol.dataRings.map((ring) => Array.from(ring).join("")).join("\n") + "\n"),
    writeFile(join(directory, "expected.json"), JSON.stringify({ result: definition.expected, layout: symbol.layout.id, mask: symbol.mask, envelopeBytes: envelope.length, visualBits: bytesToBits(codewords).length }, null, 2) + "\n"),
  ]);
}

console.log(`Generated ${definitions.length} QCCode V1 vectors in ${out}`);
