export const ENVELOPE_MAGIC = new Uint8Array([0xc7, 0x43, 0x43, 0x01]);
export const PROTOCOL_VERSION_V1 = 0x10;
export const ED25519_ALGORITHM = 0x01;
export const ENVELOPE_FIXED_PREFIX_BYTES = 81;
export const ED25519_SIGNATURE_BYTES = 64;
export const ENVELOPE_OVERHEAD_BYTES = 145;

export enum CircleCodeMode {
  INLINE = 0x01,
  REFERENCE = 0x02,
  CHALLENGE = 0x03,
}

export enum CircleCodeFlag {
  SINGLE_USE = 1 << 0,
  SERVER_RESOLUTION_REQUIRED = 1 << 1,
  USER_CONFIRMATION_REQUIRED = 1 << 2,
  AUDITABLE = 1 << 3,
}

export const V1_KNOWN_FLAGS = 0x000f;

export type EnvelopeUnsignedV1 = {
  version?: number;
  mode: CircleCodeMode;
  flags: number;
  issuerId: Uint8Array;
  keyId: number;
  messageType: number;
  messageId: Uint8Array;
  issuedAt: bigint;
  expiresAt: bigint;
  nonce: Uint8Array;
  payload: Uint8Array;
  signatureAlgorithm?: number;
};

export type EnvelopeV1 = Required<EnvelopeUnsignedV1> & {
  signature: Uint8Array;
  signedBytes: Uint8Array;
  bytes: Uint8Array;
};

export class CircleCodeProtocolError extends Error {
  constructor(
    public readonly code:
      | "PROTOCOL_INVALID"
      | "UNSUPPORTED_VERSION"
      | "UNSUPPORTED_FLAGS",
    message: string,
  ) {
    super(message);
    this.name = "CircleCodeProtocolError";
  }
}

function requireLength(name: string, value: Uint8Array, length: number): void {
  if (value.length !== length) {
    throw new CircleCodeProtocolError("PROTOCOL_INVALID", `${name} must be ${length} bytes`);
  }
}

function requireUint(name: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new CircleCodeProtocolError("PROTOCOL_INVALID", `${name} is out of range`);
  }
}

export function validateUnsignedEnvelope(input: EnvelopeUnsignedV1): void {
  const version = input.version ?? PROTOCOL_VERSION_V1;
  const algorithm = input.signatureAlgorithm ?? ED25519_ALGORITHM;
  if (version !== PROTOCOL_VERSION_V1) {
    throw new CircleCodeProtocolError("UNSUPPORTED_VERSION", `unsupported version 0x${version.toString(16)}`);
  }
  if (!Object.values(CircleCodeMode).includes(input.mode)) {
    throw new CircleCodeProtocolError("PROTOCOL_INVALID", "invalid mode");
  }
  if ((input.flags & ~V1_KNOWN_FLAGS) !== 0) {
    throw new CircleCodeProtocolError("UNSUPPORTED_FLAGS", "reserved flags must be zero");
  }
  if (input.mode === CircleCodeMode.REFERENCE && !(input.flags & CircleCodeFlag.SERVER_RESOLUTION_REQUIRED)) {
    throw new CircleCodeProtocolError("PROTOCOL_INVALID", "REFERENCE requires server resolution");
  }
  const challengeFlags = CircleCodeFlag.SINGLE_USE | CircleCodeFlag.SERVER_RESOLUTION_REQUIRED | CircleCodeFlag.USER_CONFIRMATION_REQUIRED;
  if (input.mode === CircleCodeMode.CHALLENGE && (input.flags & challengeFlags) !== challengeFlags) {
    throw new CircleCodeProtocolError("PROTOCOL_INVALID", "CHALLENGE requires single-use, server resolution, and confirmation");
  }
  if (algorithm !== ED25519_ALGORITHM) {
    throw new CircleCodeProtocolError("PROTOCOL_INVALID", "unsupported signature algorithm");
  }
  requireLength("issuerId", input.issuerId, 16);
  requireLength("messageId", input.messageId, 16);
  requireLength("nonce", input.nonce, 16);
  requireUint("keyId", input.keyId, 0xffff_ffff);
  requireUint("messageType", input.messageType, 0xffff);
  if (input.payload.length > 0xffff) {
    throw new CircleCodeProtocolError("PROTOCOL_INVALID", "payload is too large");
  }
  if (input.issuedAt < 0n || input.issuedAt > 0xffff_ffff_ffff_ffffn || input.expiresAt <= input.issuedAt || input.expiresAt > 0xffff_ffff_ffff_ffffn) {
    throw new CircleCodeProtocolError("PROTOCOL_INVALID", "invalid validity interval");
  }
  if (input.mode === CircleCodeMode.REFERENCE && input.payload.length !== 18) {
    throw new CircleCodeProtocolError("PROTOCOL_INVALID", "REFERENCE payload must be 18 bytes");
  }
  if (input.mode === CircleCodeMode.CHALLENGE && input.payload.length !== 50) {
    throw new CircleCodeProtocolError("PROTOCOL_INVALID", "CHALLENGE payload must be 50 bytes");
  }
}

export function encodeSignedBytes(input: EnvelopeUnsignedV1): Uint8Array {
  validateUnsignedEnvelope(input);
  const version = input.version ?? PROTOCOL_VERSION_V1;
  const algorithm = input.signatureAlgorithm ?? ED25519_ALGORITHM;
  const bytes = new Uint8Array(ENVELOPE_FIXED_PREFIX_BYTES + input.payload.length);
  const view = new DataView(bytes.buffer);
  bytes.set(ENVELOPE_MAGIC, 0);
  view.setUint8(4, version);
  view.setUint8(5, input.mode);
  view.setUint16(6, input.flags, false);
  view.setUint8(8, algorithm);
  bytes.set(input.issuerId, 9);
  view.setUint32(25, input.keyId, false);
  view.setUint16(29, input.messageType, false);
  bytes.set(input.messageId, 31);
  view.setBigUint64(47, input.issuedAt, false);
  view.setBigUint64(55, input.expiresAt, false);
  bytes.set(input.nonce, 63);
  view.setUint16(79, input.payload.length, false);
  bytes.set(input.payload, 81);
  return bytes;
}

export function attachSignature(signedBytes: Uint8Array, signature: Uint8Array): Uint8Array {
  requireLength("signature", signature, ED25519_SIGNATURE_BYTES);
  const result = new Uint8Array(signedBytes.length + signature.length);
  result.set(signedBytes);
  result.set(signature, signedBytes.length);
  return result;
}

function equalAt(bytes: Uint8Array, expected: Uint8Array, offset: number): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

export function parseEnvelope(bytes: Uint8Array): EnvelopeV1 {
  if (bytes.length < ENVELOPE_OVERHEAD_BYTES || !equalAt(bytes, ENVELOPE_MAGIC, 0)) {
    throw new CircleCodeProtocolError("PROTOCOL_INVALID", "invalid envelope magic or length");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const payloadLength = view.getUint16(79, false);
  const signedLength = ENVELOPE_FIXED_PREFIX_BYTES + payloadLength;
  if (bytes.length !== signedLength + ED25519_SIGNATURE_BYTES) {
    throw new CircleCodeProtocolError("PROTOCOL_INVALID", "payload length does not match envelope length");
  }
  const unsigned: Required<EnvelopeUnsignedV1> = {
    version: view.getUint8(4),
    mode: view.getUint8(5) as CircleCodeMode,
    flags: view.getUint16(6, false),
    signatureAlgorithm: view.getUint8(8),
    issuerId: bytes.slice(9, 25),
    keyId: view.getUint32(25, false),
    messageType: view.getUint16(29, false),
    messageId: bytes.slice(31, 47),
    issuedAt: view.getBigUint64(47, false),
    expiresAt: view.getBigUint64(55, false),
    nonce: bytes.slice(63, 79),
    payload: bytes.slice(81, signedLength),
  };
  validateUnsignedEnvelope(unsigned);
  return {
    ...unsigned,
    signature: bytes.slice(signedLength),
    signedBytes: bytes.slice(0, signedLength),
    bytes: bytes.slice(),
  };
}

export function encodeReferencePayload(resourceType: number, resourceId: Uint8Array): Uint8Array {
  requireUint("resourceType", resourceType, 0xffff);
  requireLength("resourceId", resourceId, 16);
  const result = new Uint8Array(18);
  new DataView(result.buffer).setUint16(0, resourceType, false);
  result.set(resourceId, 2);
  return result;
}

export function decodeReferencePayload(payload: Uint8Array): { resourceType: number; resourceId: Uint8Array } {
  requireLength("REFERENCE payload", payload, 18);
  return { resourceType: new DataView(payload.buffer, payload.byteOffset, 2).getUint16(0, false), resourceId: payload.slice(2) };
}

export function encodeChallengePayload(challengeType: number, challengeId: Uint8Array, contextHash = new Uint8Array(32)): Uint8Array {
  requireUint("challengeType", challengeType, 0xffff);
  requireLength("challengeId", challengeId, 16);
  requireLength("contextHash", contextHash, 32);
  const result = new Uint8Array(50);
  new DataView(result.buffer).setUint16(0, challengeType, false);
  result.set(challengeId, 2);
  result.set(contextHash, 18);
  return result;
}

export function toBase64Url(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64url");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) throw new CircleCodeProtocolError("PROTOCOL_INVALID", "invalid base64url");
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64url"));
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
