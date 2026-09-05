import { QCCodeFlag, QCCodeMode, attachSignature, decodeReferencePayload, encodeBearerEnvelope, encodeSignedBytes, fromBase64Url, parseBearerEnvelope, parseEnvelope, toBase64Url, type BearerEnvelope, type EnvelopeUnsignedV1, type EnvelopeV1 } from "@qccode/protocol";
import { MemoryTrustStore, signEd25519, verifyEnvelopeOffline, type QCCodePublicKeyRecord } from "@qccode/security";

export * from "@qccode/protocol";
export * from "@qccode/security";

export type RedeemStatus = "ACCEPTED" | "REPLAYED" | "EXPIRED" | "REVOKED" | "NOT_FOUND" | "INVALID" | "SERVER_REJECTED";
export type RedeemResult = { status: RedeemStatus; result?: unknown };
export type RedemptionClaim = { issuerId: Uint8Array; messageId: Uint8Array; nonce: Uint8Array; expiresAt: bigint; now: bigint };
type BearerResourceRecord = { kind: "qccode-bearer-v1"; envelopeBase64Url: string; value: unknown };

export interface ReplayStore {
  redeem<T>(issuerId: Uint8Array, messageId: Uint8Array, nonce: Uint8Array, expiresAt: bigint, operation: () => Promise<T>): Promise<{ status: "accepted"; result: T } | { status: "already-used" | "expired" }>;
}

const id = (bytes: Uint8Array): string => toBase64Url(bytes);
const bearerRecordId = (resourceId: Uint8Array, messageId: Uint8Array): Uint8Array => new Uint8Array([...resourceId, ...messageId]);

export class MemoryReplayStore implements ReplayStore {
  readonly #claims = new Map<string, { nonce: string; expiresAt: bigint }>();
  async redeem<T>(issuerId: Uint8Array, messageId: Uint8Array, nonce: Uint8Array, expiresAt: bigint, operation: () => Promise<T>): Promise<{ status: "accepted"; result: T } | { status: "already-used" | "expired" }> {
    if (expiresAt <= BigInt(Math.floor(Date.now() / 1000))) return { status: "expired" };
    const key = `${id(issuerId)}:${id(messageId)}`;
    if (this.#claims.has(key)) return { status: "already-used" };
    this.#claims.set(key, { nonce: id(nonce), expiresAt });
    try { return { status: "accepted", result: await operation() }; }
    catch (error) { this.#claims.delete(key); throw error; }
  }
}

export type IssuerConfiguration = {
  issuerId: Uint8Array;
  keyId: number;
  privateKeyPkcs8?: Uint8Array;
  publicKey: Uint8Array;
  keyNotBefore: bigint;
  keyNotAfter: bigint;
  sign?: (signedBytes: Uint8Array) => Promise<Uint8Array>;
};

export interface QCCodeStorage {
  transaction<T>(operation: (transaction: unknown) => Promise<T>): Promise<T>;
  claimRedemption(transaction: unknown, claim: RedemptionClaim): Promise<"claimed" | "replayed" | "expired">;
  completeRedemption?(transaction: unknown, claim: RedemptionClaim, result: unknown): Promise<void>;
  getResource(transaction: unknown, issuerId: Uint8Array, resourceType: number, resourceId: Uint8Array): Promise<unknown | null>;
  putResource(transaction: unknown, issuerId: Uint8Array, resourceType: number, resourceId: Uint8Array, value: unknown): Promise<void>;
  isRevoked(transaction: unknown, issuerId: Uint8Array, messageId: Uint8Array): Promise<boolean>;
  revoke(transaction: unknown, issuerId: Uint8Array, messageId: Uint8Array, expiresAt?: bigint): Promise<void>;
}

export type QCCodeStorageAdapter<T> = {
  transaction<R>(operation: (transaction: T) => Promise<R>): Promise<R>;
  claimRedemption(transaction: T, claim: RedemptionClaim): Promise<"claimed" | "replayed" | "expired">;
  completeRedemption?(transaction: T, claim: RedemptionClaim, result: unknown): Promise<void>;
  getResource(transaction: T, issuerId: Uint8Array, resourceType: number, resourceId: Uint8Array): Promise<unknown | null>;
  putResource(transaction: T, issuerId: Uint8Array, resourceType: number, resourceId: Uint8Array, value: unknown): Promise<void>;
  isRevoked(transaction: T, issuerId: Uint8Array, messageId: Uint8Array): Promise<boolean>;
  revoke(transaction: T, issuerId: Uint8Array, messageId: Uint8Array, expiresAt?: bigint): Promise<void>;
};

export function createQCCodeStorage<T>(adapter: QCCodeStorageAdapter<T>): QCCodeStorage { return adapter as QCCodeStorage; }

export class MemoryQCCodeStorage implements QCCodeStorage {
  #resources = new Map<string, unknown>();
  #revocations = new Set<string>();
  #claims = new Map<string, { nonce: string; expiresAt: bigint; result?: unknown }>();
  #tail: Promise<void> = Promise.resolve();

  async transaction<T>(operation: (transaction: unknown) => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const snapshot = [new Map(this.#resources), new Set(this.#revocations), new Map(this.#claims)] as const;
    try { return await operation(undefined); }
    catch (error) { [this.#resources, this.#revocations, this.#claims] = snapshot; throw error; }
    finally { release(); }
  }
  async claimRedemption(_tx: unknown, claim: RedemptionClaim): Promise<"claimed" | "replayed" | "expired"> {
    if (claim.expiresAt <= claim.now) return "expired";
    const key = `${id(claim.issuerId)}:${id(claim.messageId)}`;
    if (this.#claims.has(key)) return "replayed";
    this.#claims.set(key, { nonce: id(claim.nonce), expiresAt: claim.expiresAt });
    return "claimed";
  }
  async completeRedemption(_tx: unknown, claim: RedemptionClaim, result: unknown): Promise<void> {
    const key = `${id(claim.issuerId)}:${id(claim.messageId)}`;
    const stored = this.#claims.get(key);
    if (stored) this.#claims.set(key, { ...stored, result });
  }
  async getResource(_tx: unknown, issuerId: Uint8Array, type: number, resourceId: Uint8Array): Promise<unknown | null> { return this.#resources.get(`${id(issuerId)}:${type}:${id(resourceId)}`) ?? this.#resources.get(`${id(issuerId)}:-1:${id(resourceId)}`) ?? null; }
  async putResource(_tx: unknown, issuerId: Uint8Array, type: number, resourceId: Uint8Array, value: unknown): Promise<void> { this.#resources.set(`${id(issuerId)}:${type}:${id(resourceId)}`, value); }
  async isRevoked(_tx: unknown, issuerId: Uint8Array, messageId: Uint8Array): Promise<boolean> { return this.#revocations.has(`${id(issuerId)}:${id(messageId)}`); }
  async revoke(_tx: unknown, issuerId: Uint8Array, messageId: Uint8Array): Promise<void> { this.#revocations.add(`${id(issuerId)}:${id(messageId)}`); }
}

export type QCCodeResolverContext = { envelope: EnvelopeV1; transaction: unknown; resource?: { resourceType: number; resourceId: Uint8Array; value: unknown } };
export type QCCodeServerPolicy = { maxTTLSeconds: number; maxEnvelopeBytes: number; clockSkewSeconds: bigint; allowedModes?: readonly QCCodeMode[]; allowedMessageTypes?: readonly number[] };
export type QCCodeServerOptions = {
  storage?: QCCodeStorage;
  verificationKeys?: readonly QCCodePublicKeyRecord[];
  resolver?: (context: QCCodeResolverContext) => Promise<unknown>;
  clock?: () => bigint;
  randomBytes?: (length: number) => Uint8Array;
  policy?: Partial<QCCodeServerPolicy>;
  onError?: (error: unknown) => void;
  replayStore?: ReplayStore;
};

const isReplayStore = (value: ReplayStore | QCCodeServerOptions): value is ReplayStore => typeof (value as ReplayStore).redeem === "function";

export class QCCodeServer {
  readonly trustStore: MemoryTrustStore;
  readonly storage: QCCodeStorage;
  readonly replayStore: ReplayStore | undefined;
  readonly #options: Required<Pick<QCCodeServerOptions, "clock" | "randomBytes">> & QCCodeServerOptions;
  readonly #policy: QCCodeServerPolicy;
  readonly #keys: readonly QCCodePublicKeyRecord[];

  constructor(readonly issuer: IssuerConfiguration, replayStoreOrOptions: ReplayStore | QCCodeServerOptions = {}) {
    const supplied = isReplayStore(replayStoreOrOptions) ? { replayStore: replayStoreOrOptions } : replayStoreOrOptions;
    this.#options = { ...supplied, clock: supplied.clock ?? (() => BigInt(Math.floor(Date.now() / 1000))), randomBytes: supplied.randomBytes ?? ((length) => crypto.getRandomValues(new Uint8Array(length))) };
    this.#policy = { maxTTLSeconds: 86_400, maxEnvelopeBytes: 4096, clockSkewSeconds: 0n, ...supplied.policy };
    this.storage = supplied.storage ?? new MemoryQCCodeStorage();
    this.replayStore = supplied.replayStore;
    this.#keys = [this.keyRecord, ...(supplied.verificationKeys ?? [])];
    const keyIds = new Set<number>();
    for (const key of this.#keys) {
      if (id(key.issuerId) !== id(this.issuer.issuerId)) throw new Error("all verification keys must belong to the configured issuer");
      if (keyIds.has(key.keyId)) throw new Error(`duplicate verification key ID ${key.keyId}`);
      keyIds.add(key.keyId);
    }
    this.trustStore = new MemoryTrustStore([...this.#keys]);
  }

  get keyRecord(): QCCodePublicKeyRecord { return { issuerId: this.issuer.issuerId, keyId: this.issuer.keyId, publicKey: this.issuer.publicKey, status: "CURRENT", notBefore: this.issuer.keyNotBefore, notAfter: this.issuer.keyNotAfter }; }
  get publicKeys(): readonly QCCodePublicKeyRecord[] { return this.#keys.map((key) => ({ ...key, issuerId: key.issuerId.slice(), publicKey: key.publicKey.slice() })); }

  async issue(input: { mode: QCCodeMode; messageType: number; payload: Uint8Array; expiresIn: number; singleUse?: boolean; requireConfirmation?: boolean; now?: bigint }): Promise<{ envelope: Uint8Array; envelopeBase64Url: string }> {
    if (!Number.isInteger(input.expiresIn) || input.expiresIn < 1 || input.expiresIn > this.#policy.maxTTLSeconds) throw new Error(`expiresIn must be 1..${this.#policy.maxTTLSeconds} seconds`);
    if (this.#policy.allowedModes && !this.#policy.allowedModes.includes(input.mode)) throw new Error("mode is not allowed by server policy");
    if (this.#policy.allowedMessageTypes && !this.#policy.allowedMessageTypes.includes(input.messageType)) throw new Error("messageType is not allowed by server policy");
    const now = input.now ?? this.#options.clock();
    if (now < this.issuer.keyNotBefore || now >= this.issuer.keyNotAfter) throw new Error("current signing key is outside its validity window");
    let flags = input.singleUse || input.mode === QCCodeMode.CHALLENGE ? QCCodeFlag.SINGLE_USE : 0;
    if (input.mode !== QCCodeMode.INLINE) flags |= QCCodeFlag.SERVER_RESOLUTION_REQUIRED;
    if (input.requireConfirmation || input.mode === QCCodeMode.CHALLENGE) flags |= QCCodeFlag.USER_CONFIRMATION_REQUIRED;
    const unsigned: EnvelopeUnsignedV1 = { mode: input.mode, flags, issuerId: this.issuer.issuerId, keyId: this.issuer.keyId, messageType: input.messageType, messageId: this.#options.randomBytes(16), issuedAt: now, expiresAt: now + BigInt(input.expiresIn), nonce: this.#options.randomBytes(16), payload: input.payload };
    const signedBytes = encodeSignedBytes(unsigned);
    if (!this.issuer.sign && !this.issuer.privateKeyPkcs8) throw new Error("privateKeyPkcs8 or sign callback is required");
    const signature = this.issuer.sign ? await this.issuer.sign(signedBytes) : await signEd25519(signedBytes, this.issuer.privateKeyPkcs8!);
    const envelope = attachSignature(signedBytes, signature);
    return { envelope, envelopeBase64Url: toBase64Url(envelope) };
  }

  async issueBearer(input: { resourceType: number; messageType: number; expiresIn: number; singleUse?: boolean; resourceId?: Uint8Array; resourceValue?: unknown; now?: bigint }): Promise<{ envelope: Uint8Array; envelopeBase64Url: string }> {
    if (!Number.isInteger(input.expiresIn) || input.expiresIn < 1 || input.expiresIn > this.#policy.maxTTLSeconds) throw new Error(`expiresIn must be 1..${this.#policy.maxTTLSeconds} seconds`);
    if (!Number.isInteger(input.resourceType) || input.resourceType < 0 || input.resourceType > 0xffff) throw new Error("resourceType is out of range");
    if (this.#policy.allowedMessageTypes && !this.#policy.allowedMessageTypes.includes(input.messageType)) throw new Error("messageType is not allowed by server policy");
    const now = input.now ?? this.#options.clock();
    const resourceId = new Uint8Array(input.resourceId ?? this.#options.randomBytes(12));
    if (resourceId.length !== 12) throw new Error("bearer resourceId must be 12 bytes");
    const bearerIssuerId = this.issuer.issuerId.slice(0, 8);
    const messageId = this.#options.randomBytes(12);
    const envelope = encodeBearerEnvelope({
      issuerId: bearerIssuerId,
      messageType: input.messageType,
      messageId,
      issuedAt: Number(now),
      expiresAt: Number(now) + input.expiresIn,
      resourceType: input.resourceType,
      resourceId,
      flags: (input.singleUse !== false ? QCCodeFlag.SINGLE_USE : 0) | QCCodeFlag.SERVER_RESOLUTION_REQUIRED,
    });
    const envelopeBase64Url = toBase64Url(envelope);
    // Bind every unsigned field to the issued token, not to client-supplied policy.
    const record: BearerResourceRecord = { kind: "qccode-bearer-v1", envelopeBase64Url, value: input.resourceValue ?? null };
    // Keep authority in the full issuer namespace, separate from legacy bearer values.
    await this.storage.transaction((tx) => this.storage.putResource(tx, this.issuer.issuerId, input.resourceType, bearerRecordId(resourceId, messageId), record));
    return { envelope, envelopeBase64Url };
  }

  async redeemBearer(input: Uint8Array | string): Promise<RedeemResult> {
    let envelope: BearerEnvelope;
    try {
      if (typeof input === "string" && input.length > Math.ceil(this.#policy.maxEnvelopeBytes * 4 / 3) + 4) return { status: "INVALID" };
      const bytes = typeof input === "string" ? fromBase64Url(input) : input;
      if (bytes.length > this.#policy.maxEnvelopeBytes) return { status: "INVALID" };
      envelope = parseBearerEnvelope(bytes);
      const bearerIssuerId = this.issuer.issuerId.slice(0, 8);
      if (id(envelope.issuerId) !== id(bearerIssuerId)) return { status: "INVALID" };
    } catch { return { status: "INVALID" }; }

    const operation = async (): Promise<RedeemResult> => this.storage.transaction(async (tx) => {
      const record = await this.storage.getResource(tx, this.issuer.issuerId, envelope.resourceType, bearerRecordId(envelope.resourceId, envelope.messageId)) as Partial<BearerResourceRecord> | null;
      if (record === null) return { status: "NOT_FOUND" };
      // Legacy resource-only entries cannot establish expiry or single-use policy.
      if (record.kind !== "qccode-bearer-v1" || record.envelopeBase64Url !== toBase64Url(envelope.bytes)) return { status: "INVALID" };
      const now = this.#options.clock();
      if (BigInt(envelope.expiresAt) <= now) return { status: "EXPIRED" };
      if (BigInt(envelope.issuedAt) > now + this.#policy.clockSkewSeconds) return { status: "INVALID" };
      if (await this.storage.isRevoked(tx, this.issuer.issuerId, envelope.messageId)) return { status: "REVOKED" };
      const claim: RedemptionClaim = { issuerId: this.issuer.issuerId, messageId: envelope.messageId, nonce: envelope.messageId, expiresAt: BigInt(envelope.expiresAt), now };
      if (envelope.flags & QCCodeFlag.SINGLE_USE) {
        const state = await this.storage.claimRedemption(tx, claim);
        if (state === "expired") return { status: "EXPIRED" };
        if (state === "replayed") return { status: "REPLAYED" };
      }
      const result = record.value ?? { mode: QCCodeMode[envelope.mode], resourceType: envelope.resourceType, resourceId: toBase64Url(envelope.resourceId) };
      if (envelope.flags & QCCodeFlag.SINGLE_USE) await this.storage.completeRedemption?.(tx, claim, result);
      return { status: "ACCEPTED", result };
    });
    try { return await operation(); }
    catch (error) { this.#options.onError?.(error); return { status: "SERVER_REJECTED" }; }
  }

  async putResource(type: number, resourceId: Uint8Array, value: unknown): Promise<void> { await this.storage.transaction((tx) => this.storage.putResource(tx, this.issuer.issuerId, type, resourceId, value)); }
  registerResource(resourceId: Uint8Array, value: unknown, type = -1): Promise<void> { return this.putResource(type, resourceId, value); }
  async revoke(messageId: Uint8Array, expiresAt?: bigint): Promise<void> {
    if (messageId.length !== 12 && messageId.length !== 16) throw new Error("messageId must be 12 bearer bytes or 16 signed bytes");
    await this.storage.transaction((tx) => this.storage.revoke(tx, this.issuer.issuerId, messageId, expiresAt));
  }

  async redeem(input: Uint8Array | string): Promise<RedeemResult> {
    let envelope: EnvelopeV1;
    try {
      const now = this.#options.clock();
      if (typeof input === "string" && input.length > Math.ceil(this.#policy.maxEnvelopeBytes * 4 / 3) + 4) return { status: "INVALID" };
      const bytes = typeof input === "string" ? fromBase64Url(input) : input;
      if (bytes.length > this.#policy.maxEnvelopeBytes) return { status: "INVALID" };
      const verified = await verifyEnvelopeOffline(bytes, this.trustStore, { now, clockSkewSeconds: this.#policy.clockSkewSeconds });
      envelope = verified.envelope;
      if (verified.error === "EXPIRED" || envelope.expiresAt <= now) return { status: "EXPIRED" };
      if (!verified.signatureValid || verified.notYetValid) return { status: "INVALID" };
    } catch { return { status: "INVALID" }; }

    const operation = async (): Promise<RedeemResult> => this.storage.transaction(async (tx) => {
      const now = this.#options.clock();
      if (envelope.expiresAt <= now) return { status: "EXPIRED" };
      if (await this.storage.isRevoked(tx, envelope.issuerId, envelope.messageId)) return { status: "REVOKED" };
      let resource: QCCodeResolverContext["resource"];
      if (envelope.mode === QCCodeMode.REFERENCE) {
        const reference = decodeReferencePayload(envelope.payload);
        const value = await this.storage.getResource(tx, envelope.issuerId, reference.resourceType, reference.resourceId);
        if (value === null) return { status: "NOT_FOUND" };
        resource = { ...reference, value };
      }
      const claim: RedemptionClaim = { issuerId: envelope.issuerId, messageId: envelope.messageId, nonce: envelope.nonce, expiresAt: envelope.expiresAt, now };
      if (envelope.flags & QCCodeFlag.SINGLE_USE) {
        const state = await this.storage.claimRedemption(tx, claim);
        if (state === "expired") return { status: "EXPIRED" };
        if (state === "replayed") return { status: "REPLAYED" };
      }
      const result = this.#options.resolver ? await this.#options.resolver({ envelope, transaction: tx, ...(resource ? { resource } : {}) }) : resource?.value ?? { mode: QCCodeMode[envelope.mode], messageType: envelope.messageType, payload: toBase64Url(envelope.payload) };
      if (envelope.flags & QCCodeFlag.SINGLE_USE) await this.storage.completeRedemption?.(tx, claim, result);
      return { status: "ACCEPTED", result };
    });
    try {
      if (this.replayStore && (envelope.flags & QCCodeFlag.SINGLE_USE)) {
        const replay = await this.replayStore.redeem(envelope.issuerId, envelope.messageId, envelope.nonce, envelope.expiresAt, operation);
        return replay.status === "accepted" ? replay.result : { status: replay.status === "expired" ? "EXPIRED" : "REPLAYED" };
      }
      return await operation();
    } catch (error) { this.#options.onError?.(error); return { status: "SERVER_REJECTED" }; }
  }

  parse(envelope: string): ReturnType<typeof parseEnvelope> { return parseEnvelope(fromBase64Url(envelope)); }
}
