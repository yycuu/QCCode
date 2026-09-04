import {
  CircleCodeFlag,
  CircleCodeMode,
  fromBase64Url,
  parseEnvelope,
  toBase64Url,
  type EnvelopeUnsignedV1,
} from "@circlecode/protocol";
import {
  MemoryTrustStore,
  issueEnvelope,
  verifyEnvelopeOffline,
  type CircleCodePublicKeyRecord,
} from "@circlecode/security";

export type RedeemStatus = "ACCEPTED" | "REPLAYED" | "EXPIRED" | "REVOKED" | "INVALID" | "SERVER_REJECTED";

export interface ReplayStore {
  redeem<T>(issuerId: Uint8Array, messageId: Uint8Array, nonce: Uint8Array, expiresAt: bigint, operation: () => Promise<T>): Promise<{ status: "accepted"; result: T } | { status: "already-used" | "expired" }>;
}

function id(bytes: Uint8Array): string {
  return toBase64Url(bytes);
}

export class MemoryReplayStore implements ReplayStore {
  readonly #claims = new Map<string, { nonce: string; expiresAt: bigint; state: "pending" | "complete" }>();

  async redeem<T>(issuerId: Uint8Array, messageId: Uint8Array, nonce: Uint8Array, expiresAt: bigint, operation: () => Promise<T>): Promise<{ status: "accepted"; result: T } | { status: "already-used" | "expired" }> {
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (expiresAt <= now) return { status: "expired" };
    const key = `${id(issuerId)}:${id(messageId)}`;
    if (this.#claims.has(key)) return { status: "already-used" };
    // The claim is installed synchronously before the first await, making this atomic
    // within one JS process. Production adapters use a DB unique constraint or Redis Lua.
    this.#claims.set(key, { nonce: id(nonce), expiresAt, state: "pending" });
    try {
      const result = await operation();
      this.#claims.set(key, { nonce: id(nonce), expiresAt, state: "complete" });
      return { status: "accepted", result };
    } catch (error) {
      this.#claims.delete(key);
      throw error;
    }
  }
}

export type IssuerConfiguration = {
  issuerId: Uint8Array;
  keyId: number;
  privateKeyPkcs8: Uint8Array;
  publicKey: Uint8Array;
  keyNotBefore: bigint;
  keyNotAfter: bigint;
};

export class CircleCodeServer {
  readonly trustStore: MemoryTrustStore;
  readonly #revokedMessages = new Set<string>();
  readonly #resources = new Map<string, unknown>();

  constructor(readonly issuer: IssuerConfiguration, readonly replayStore: ReplayStore = new MemoryReplayStore()) {
    this.trustStore = new MemoryTrustStore([this.keyRecord]);
  }

  get keyRecord(): CircleCodePublicKeyRecord {
    return { issuerId: this.issuer.issuerId, keyId: this.issuer.keyId, publicKey: this.issuer.publicKey, status: "CURRENT", notBefore: this.issuer.keyNotBefore, notAfter: this.issuer.keyNotAfter };
  }

  async issue(input: {
    mode: CircleCodeMode;
    messageType: number;
    payload: Uint8Array;
    expiresIn: number;
    singleUse?: boolean;
    requireConfirmation?: boolean;
    now?: bigint;
  }): Promise<{ envelope: Uint8Array; envelopeBase64Url: string }> {
    if (!Number.isInteger(input.expiresIn) || input.expiresIn < 1 || input.expiresIn > 86_400) throw new Error("expiresIn must be 1..86400 seconds");
    const now = input.now ?? BigInt(Math.floor(Date.now() / 1000));
    let flags = input.singleUse || input.mode === CircleCodeMode.CHALLENGE ? CircleCodeFlag.SINGLE_USE : 0;
    if (input.mode !== CircleCodeMode.INLINE) flags |= CircleCodeFlag.SERVER_RESOLUTION_REQUIRED;
    if (input.requireConfirmation || input.mode === CircleCodeMode.CHALLENGE) flags |= CircleCodeFlag.USER_CONFIRMATION_REQUIRED;
    const unsigned: EnvelopeUnsignedV1 = {
      mode: input.mode,
      flags,
      issuerId: this.issuer.issuerId,
      keyId: this.issuer.keyId,
      messageType: input.messageType,
      messageId: crypto.getRandomValues(new Uint8Array(16)),
      issuedAt: now,
      expiresAt: now + BigInt(input.expiresIn),
      nonce: crypto.getRandomValues(new Uint8Array(16)),
      payload: input.payload,
    };
    const envelope = await issueEnvelope(unsigned, this.issuer.privateKeyPkcs8);
    return { envelope, envelopeBase64Url: toBase64Url(envelope) };
  }

  registerResource(resourceId: Uint8Array, value: unknown): void {
    this.#resources.set(id(resourceId), value);
  }

  revoke(messageId: Uint8Array): void {
    this.#revokedMessages.add(id(messageId));
  }

  async redeem(envelopeInput: Uint8Array | string): Promise<{ status: RedeemStatus; result?: unknown }> {
    try {
      const bytes = typeof envelopeInput === "string" ? fromBase64Url(envelopeInput) : envelopeInput;
      const now = BigInt(Math.floor(Date.now() / 1000));
      const verified = await verifyEnvelopeOffline(bytes, this.trustStore, { now, clockSkewSeconds: 0n });
      if (verified.error === "EXPIRED" || verified.envelope.expiresAt <= now) return { status: "EXPIRED" };
      if (!verified.signatureValid || verified.notYetValid) return { status: "INVALID" };
      const envelope = verified.envelope;
      if (this.#revokedMessages.has(id(envelope.messageId))) return { status: "REVOKED" };
      const operation = async (): Promise<unknown> => {
        if (envelope.mode === CircleCodeMode.REFERENCE) return this.#resources.get(id(envelope.payload.slice(2))) ?? null;
        return { mode: CircleCodeMode[envelope.mode], messageType: envelope.messageType, payload: toBase64Url(envelope.payload) };
      };
      if (envelope.flags & CircleCodeFlag.SINGLE_USE) {
        const result = await this.replayStore.redeem(envelope.issuerId, envelope.messageId, envelope.nonce, envelope.expiresAt, operation);
        return result.status === "accepted" ? { status: "ACCEPTED", result: result.result } : { status: result.status === "expired" ? "EXPIRED" : "REPLAYED" };
      }
      return { status: "ACCEPTED", result: await operation() };
    } catch {
      return { status: "INVALID" };
    }
  }

  parse(envelope: string): ReturnType<typeof parseEnvelope> {
    return parseEnvelope(fromBase64Url(envelope));
  }
}
