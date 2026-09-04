import {
  attachSignature,
  encodeSignedBytes,
  isBearerEnvelope,
  parseBearerEnvelope,
  parseEnvelope,
  type BearerEnvelope,
  type EnvelopeUnsignedV1,
  type EnvelopeV1,
} from "@qccode/protocol";

export type QCCodeKeyStatus = "CURRENT" | "PREVIOUS" | "REVOKED";

export type QCCodePublicKeyRecord = {
  issuerId: Uint8Array;
  keyId: number;
  publicKey: Uint8Array;
  status: QCCodeKeyStatus;
  notBefore: bigint;
  notAfter: bigint;
};

export interface QCCodeTrustStore {
  getPublicKey(issuerId: Uint8Array, keyId: number): Promise<QCCodePublicKeyRecord | null>;
}

export class MemoryTrustStore implements QCCodeTrustStore {
  readonly #keys = new Map<string, QCCodePublicKeyRecord>();

  constructor(records: QCCodePublicKeyRecord[] = []) {
    for (const record of records) this.add(record);
  }

  add(record: QCCodePublicKeyRecord): void {
    this.#keys.set(keyName(record.issuerId, record.keyId), { ...record, publicKey: record.publicKey.slice(), issuerId: record.issuerId.slice() });
  }

  async getPublicKey(issuerId: Uint8Array, keyId: number): Promise<QCCodePublicKeyRecord | null> {
    return this.#keys.get(keyName(issuerId, keyId)) ?? null;
  }
}

function keyName(issuerId: Uint8Array, keyId: number): string {
  return `${Array.from(issuerId, (byte) => byte.toString(16).padStart(2, "0")).join("")}:${keyId}`;
}

function webCrypto(): Crypto {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto is unavailable");
  return globalThis.crypto;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function pkcs8FromSeed(seed: Uint8Array): Uint8Array {
  if (seed.length !== 32) throw new Error("Ed25519 seed must be 32 bytes");
  const prefix = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
  const result = new Uint8Array(prefix.length + seed.length);
  result.set(prefix);
  result.set(seed, prefix.length);
  return result;
}

export type Ed25519KeyPairBytes = { privateKeyPkcs8: Uint8Array; publicKey: Uint8Array };

export async function generateEd25519KeyPair(): Promise<Ed25519KeyPairBytes> {
  const pair = await webCrypto().subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return {
    privateKeyPkcs8: new Uint8Array(await webCrypto().subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: new Uint8Array(await webCrypto().subtle.exportKey("raw", pair.publicKey)),
  };
}

export async function privateKeyFromSeed(seed: Uint8Array): Promise<Uint8Array> {
  const encoded = pkcs8FromSeed(seed);
  const key = await webCrypto().subtle.importKey("pkcs8", asArrayBuffer(encoded), { name: "Ed25519" }, true, ["sign"]);
  return new Uint8Array(await webCrypto().subtle.exportKey("pkcs8", key));
}

export async function signEd25519(bytes: Uint8Array, privateKeyPkcs8: Uint8Array): Promise<Uint8Array> {
  const key = await webCrypto().subtle.importKey("pkcs8", asArrayBuffer(privateKeyPkcs8), { name: "Ed25519" }, false, ["sign"]);
  return new Uint8Array(await webCrypto().subtle.sign("Ed25519", key, asArrayBuffer(bytes)));
}

export async function verifyEd25519(bytes: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): Promise<boolean> {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  const key = await webCrypto().subtle.importKey("raw", asArrayBuffer(publicKey), { name: "Ed25519" }, false, ["verify"]);
  return webCrypto().subtle.verify("Ed25519", key, asArrayBuffer(signature), asArrayBuffer(bytes));
}

export async function issueEnvelope(input: EnvelopeUnsignedV1, privateKeyPkcs8: Uint8Array): Promise<Uint8Array> {
  const signedBytes = encodeSignedBytes(input);
  return attachSignature(signedBytes, await signEd25519(signedBytes, privateKeyPkcs8));
}

export type OfflineVerificationResult = {
  kind: "signed";
  envelope: EnvelopeV1;
  signatureValid: boolean;
  issuerTrusted: boolean;
  keyStatus: QCCodeKeyStatus | "UNKNOWN";
  expired: boolean;
  notYetValid: boolean;
  offlineVerified: boolean;
  error?: "UNKNOWN_ISSUER_OR_KEY" | "KEY_REVOKED" | "KEY_OUTSIDE_VALIDITY" | "SIGNATURE_INVALID" | "EXPIRED" | "NOT_YET_VALID";
};

export type BearerVerificationResult = {
  kind: "bearer";
  envelope: BearerEnvelope;
  expired: boolean;
  notYetValid: boolean;
  offlineVerified: false;
};

export function verifyBearerEnvelope(bytes: Uint8Array, options: { now?: bigint; clockSkewSeconds?: bigint } = {}): BearerVerificationResult {
  const envelope = parseBearerEnvelope(bytes);
  const now = options.now ?? BigInt(Math.floor(Date.now() / 1000));
  const skew = options.clockSkewSeconds ?? 120n;
  const expiresAt = BigInt(envelope.expiresAt);
  return {
    kind: "bearer",
    envelope,
    expired: expiresAt <= now - skew,
    notYetValid: BigInt(envelope.issuedAt) > now + skew,
    offlineVerified: false,
  };
}

export async function verifyEnvelopeOffline(
  bytes: Uint8Array,
  trustStore: QCCodeTrustStore,
  options: { now?: bigint; clockSkewSeconds?: bigint } = {},
): Promise<OfflineVerificationResult> {
  const envelope = parseEnvelope(bytes);
  const now = options.now ?? BigInt(Math.floor(Date.now() / 1000));
  const skew = options.clockSkewSeconds ?? 120n;
  const key = await trustStore.getPublicKey(envelope.issuerId, envelope.keyId);
  const expired = envelope.expiresAt <= now - skew;
  const notYetValid = envelope.issuedAt > now + skew;
  if (!key) return { kind: "signed", envelope, signatureValid: false, issuerTrusted: false, keyStatus: "UNKNOWN", expired, notYetValid, offlineVerified: false, error: "UNKNOWN_ISSUER_OR_KEY" };
  if (key.status === "REVOKED") return { kind: "signed", envelope, signatureValid: false, issuerTrusted: true, keyStatus: key.status, expired, notYetValid, offlineVerified: false, error: "KEY_REVOKED" };
  if (envelope.issuedAt < key.notBefore || envelope.issuedAt >= key.notAfter) {
    return { kind: "signed", envelope, signatureValid: false, issuerTrusted: true, keyStatus: key.status, expired, notYetValid, offlineVerified: false, error: "KEY_OUTSIDE_VALIDITY" };
  }
  const signatureValid = await verifyEd25519(envelope.signedBytes, envelope.signature, key.publicKey);
  if (!signatureValid) return { kind: "signed", envelope, signatureValid: false, issuerTrusted: true, keyStatus: key.status, expired, notYetValid, offlineVerified: false, error: "SIGNATURE_INVALID" };
  if (notYetValid) return { kind: "signed", envelope, signatureValid: true, issuerTrusted: true, keyStatus: key.status, expired, notYetValid, offlineVerified: true, error: "NOT_YET_VALID" };
  if (expired) return { kind: "signed", envelope, signatureValid: true, issuerTrusted: true, keyStatus: key.status, expired, notYetValid, offlineVerified: true, error: "EXPIRED" };
  return { kind: "signed", envelope, signatureValid: true, issuerTrusted: true, keyStatus: key.status, expired: false, notYetValid: false, offlineVerified: true };
}
