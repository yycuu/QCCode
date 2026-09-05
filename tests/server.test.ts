import { describe, expect, it, vi } from "vitest";
import { MemoryQCCodeStorage, QCCodeMode, QCCodeServer, createQCCodeStorage, encodeReferencePayload, parseBearerEnvelope, parseEnvelope, privateKeyFromSeed, signEd25519 } from "../packages/server-sdk/src/index.js";

const hex = (value: string) => Uint8Array.from(value.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
const seed = hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
const publicKey = hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");

async function server(): Promise<QCCodeServer> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return new QCCodeServer({ issuerId: new Uint8Array(16).fill(4), keyId: 1, privateKeyPkcs8: await privateKeyFromSeed(seed), publicKey, keyNotBefore: now - 100n, keyNotAfter: now + 10_000n });
}

describe("server SDK format deprecation", () => {
  it.each(["issue", "redeem", "parse"] as const)("warns once when using the legacy %s entry point", async (method) => {
    const base = await server();
    const input = { mode: QCCodeMode.INLINE, messageType: 1, payload: new Uint8Array(), expiresIn: 60 };
    const issued = await base.issue(input);
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { QCCodeServer: FreshServer } = await import("../packages/server-sdk/src/index.js");
      const instance = new FreshServer(base.issuer);
      const bearer = await instance.issueBearer({ resourceType: 1, messageType: 1, expiresIn: 60 });
      expect((await instance.redeemBearer(bearer.envelope)).status).toBe("ACCEPTED");
      expect(warn).not.toHaveBeenCalled();
      for (let attempt = 0; attempt < 2; attempt++) {
        if (method === "issue") expect((await instance.issue(input)).envelope).toBeInstanceOf(Uint8Array);
        else if (method === "redeem") expect((await instance.redeem(issued.envelope)).status).toBe("ACCEPTED");
        else expect(instance.parse(issued.envelopeBase64Url).bytes).toEqual(issued.envelope);
      }
      expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/C1\/C2\/C3.*deprecated.*v0\.3\.5.*removed in a future release.*Migrate to S1.*issueBearer\(\).*redeemBearer\(\)/));
    } finally { warn.mockRestore(); }
  });
});

describe("reference server replay policy", () => {
  it("allows exactly one concurrent redemption", async () => {
    const instance = await server();
    const resourceId = new Uint8Array(16).fill(7);
    await instance.putResource(1, resourceId, { name: "protected resource" });
    const issued = await instance.issue({ mode: QCCodeMode.REFERENCE, messageType: 4, payload: encodeReferencePayload(1, resourceId), expiresIn: 60, singleUse: true });
    const results = await Promise.all(Array.from({ length: 20 }, () => instance.redeem(issued.envelope)));
    expect(results.filter((result) => result.status === "ACCEPTED")).toHaveLength(1);
    expect(results.filter((result) => result.status === "REPLAYED")).toHaveLength(19);
  });

  it("forces CHALLENGE to be single use", async () => {
    const instance = await server();
    const payload = new Uint8Array(50);
    const issued = await instance.issue({ mode: QCCodeMode.CHALLENGE, messageType: 9, payload, expiresIn: 60 });
    expect((await instance.redeem(issued.envelope)).status).toBe("ACCEPTED");
    expect((await instance.redeem(issued.envelope)).status).toBe("REPLAYED");
  });

  it("rolls back a claim when the transactional business handler fails", async () => {
    let attempts = 0;
    const base = await server();
    const instance = new QCCodeServer(base.issuer, {
      resolver: async () => {
        attempts++;
        if (attempts === 1) throw new Error("temporary database failure");
        return { ok: true };
      },
    });
    const issued = await instance.issue({ mode: QCCodeMode.CHALLENGE, messageType: 9, payload: new Uint8Array(50), expiresIn: 60 });
    expect((await instance.redeem(issued.envelope)).status).toBe("SERVER_REJECTED");
    expect((await instance.redeem(issued.envelope)).status).toBe("ACCEPTED");
  });

  it("enforces production issuance policy", async () => {
    const base = await server();
    const instance = new QCCodeServer(base.issuer, { policy: { maxTTLSeconds: 30, allowedMessageTypes: [7] } });
    await expect(instance.issue({ mode: QCCodeMode.INLINE, messageType: 8, payload: new Uint8Array(), expiresIn: 20 })).rejects.toThrow("messageType");
    await expect(instance.issue({ mode: QCCodeMode.INLINE, messageType: 7, payload: new Uint8Array(), expiresIn: 31 })).rejects.toThrow("expiresIn");
  });

  it("does not consume a single-use claim when a reference is missing", async () => {
    const instance = await server();
    const resourceId = new Uint8Array(16).fill(3);
    const issued = await instance.issue({ mode: QCCodeMode.REFERENCE, messageType: 4, payload: encodeReferencePayload(5, resourceId), expiresIn: 60, singleUse: true });
    expect((await instance.redeem(issued.envelope)).status).toBe("NOT_FOUND");
    await instance.putResource(5, resourceId, { recovered: true });
    expect((await instance.redeem(issued.envelope)).status).toBe("ACCEPTED");
  });

  it("supports external KMS signing and previous verification keys", async () => {
    const old = await server();
    const issued = await old.issue({ mode: QCCodeMode.INLINE, messageType: 1, payload: new Uint8Array([1]), expiresIn: 60 });
    const now = BigInt(Math.floor(Date.now() / 1000));
    const storage = new MemoryQCCodeStorage();
    const current = new QCCodeServer({
      issuerId: old.issuer.issuerId,
      keyId: 2,
      publicKey,
      keyNotBefore: now - 100n,
      keyNotAfter: now + 10_000n,
      sign: (bytes) => signEd25519(bytes, old.issuer.privateKeyPkcs8!),
    }, { storage, verificationKeys: [old.keyRecord] });
    expect((await current.redeem(issued.envelope)).status).toBe("ACCEPTED");
    expect((await current.issue({ mode: QCCodeMode.INLINE, messageType: 1, payload: new Uint8Array(), expiresIn: 60 })).envelope).toBeInstanceOf(Uint8Array);
    expect(current.publicKeys.map((key) => key.keyId)).toEqual([2, 1]);
  });

  it("revokes signed envelopes without changing their issuer namespace", async () => {
    const instance = await server();
    const issued = await instance.issue({ mode: QCCodeMode.INLINE, messageType: 1, payload: new Uint8Array(), expiresIn: 60 });
    await instance.revoke(parseEnvelope(issued.envelope).messageId);
    expect((await instance.redeem(issued.envelope)).status).toBe("REVOKED");
    await expect(instance.revoke(new Uint8Array(8))).rejects.toThrow("messageId");
  });
});

describe("bearer server policy", () => {
  it("allows exactly one concurrent redemption", async () => {
    const instance = await server();
    const issued = await instance.issueBearer({ resourceType: 1, messageType: 4, expiresIn: 60, resourceValue: { protected: true } });
    const results = await Promise.all(Array.from({ length: 20 }, () => instance.redeemBearer(issued.envelopeBase64Url)));
    expect(results.filter((result) => result.status === "ACCEPTED")).toEqual([{ status: "ACCEPTED", result: { protected: true } }]);
    expect(results.filter((result) => result.status === "REPLAYED")).toHaveLength(19);
  });

  it.each([
    ["single-use flag", 3],
    ["message type", 4],
    ["message ID", 14],
    ["issued-at", 29],
    ["expires-at", 33],
  ] as const)("rejects a modified %s without bypassing replay protection", async (_field, offset) => {
    const instance = await server();
    const issued = await instance.issueBearer({ resourceType: 1, messageType: 4, expiresIn: 60, resourceValue: "test resource" });
    expect((await instance.redeemBearer(issued.envelope)).status).toBe("ACCEPTED");
    const modified = issued.envelope.slice();
    modified[offset] = modified[offset]! ^ 1;
    expect((await instance.redeemBearer(modified)).status).toBe(offset === 14 ? "NOT_FOUND" : "INVALID");
    expect((await instance.redeemBearer(issued.envelope)).status).toBe("REPLAYED");
  });

  it("rejects a forged expiry and respects the original validity interval", async () => {
    const base = await server();
    let now = 1_700_000_000n;
    const instance = new QCCodeServer(base.issuer, { clock: () => now });
    const issued = await instance.issueBearer({ resourceType: 1, messageType: 4, expiresIn: 60, resourceValue: "test resource" });
    now -= 1n;
    expect((await instance.redeemBearer(issued.envelope)).status).toBe("INVALID");
    now += 61n;
    expect((await instance.redeemBearer(issued.envelope)).status).toBe("EXPIRED");
    const modified = issued.envelope.slice();
    new DataView(modified.buffer).setUint32(30, Number(now) + 3600, false);
    expect((await instance.redeemBearer(modified)).status).toBe("INVALID");
  });

  it.each([true, false])("revokes bearer envelopes with singleUse=%s", async (singleUse) => {
    const instance = await server();
    const issued = await instance.issueBearer({ resourceType: 1, messageType: 4, expiresIn: 60, singleUse, resourceValue: "test resource" });
    await instance.revoke(parseBearerEnvelope(issued.envelope).messageId);
    expect((await instance.redeemBearer(issued.envelope)).status).toBe("REVOKED");
    const modified = issued.envelope.slice();
    modified[14] = modified[14]! ^ 1;
    expect((await instance.redeemBearer(modified)).status).toBe("NOT_FOUND");
  });

  it("preserves explicitly reusable tokens and resources without a value", async () => {
    const instance = await server();
    const issued = await instance.issueBearer({ resourceType: 1, messageType: 4, expiresIn: 60, singleUse: false });
    const first = await instance.redeemBearer(issued.envelope);
    expect(first).toMatchObject({ status: "ACCEPTED", result: { mode: "REFERENCE", resourceType: 1 } });
    expect(await instance.redeemBearer(issued.envelope)).toEqual(first);
  });

  it.each([8, 16])("fails closed for resource-only entries under a %s-byte issuer", async (issuerLength) => {
    const base = await server();
    const issued = await base.issueBearer({ resourceType: 1, messageType: 4, expiresIn: 60, resourceValue: "test resource" });
    const instance = new QCCodeServer(base.issuer);
    const envelope = parseBearerEnvelope(issued.envelope);
    await instance.storage.transaction((tx) => instance.storage.putResource(tx, instance.issuer.issuerId.slice(0, issuerLength), envelope.resourceType, envelope.resourceId, { legacy: true }));
    expect((await instance.redeemBearer(issued.envelope)).status).toBe("NOT_FOUND");
  });

  it("keeps separate tokens for the same resource independently redeemable and revocable", async () => {
    const instance = await server();
    const input = { resourceType: 1, messageType: 4, resourceId: new Uint8Array(12).fill(7), expiresIn: 60, resourceValue: "test resource" };
    const first = await instance.issueBearer(input);
    const second = await instance.issueBearer(input);
    expect((await instance.redeemBearer(first.envelope)).status).toBe("ACCEPTED");
    expect((await instance.redeemBearer(second.envelope)).status).toBe("ACCEPTED");
    expect((await instance.redeemBearer(first.envelope)).status).toBe("REPLAYED");
    expect((await instance.redeemBearer(second.envelope)).status).toBe("REPLAYED");
    const reusable = await instance.issueBearer({ ...input, singleUse: false });
    const revoked = await instance.issueBearer(input);
    await instance.revoke(parseBearerEnvelope(revoked.envelope).messageId);
    expect((await instance.redeemBearer(reusable.envelope)).status).toBe("ACCEPTED");
    expect((await instance.redeemBearer(revoked.envelope)).status).toBe("REVOKED");
    expect((await instance.redeemBearer(reusable.envelope)).status).toBe("ACCEPTED");
  });

  it("snapshots Buffer input before asynchronous storage access", async () => {
    const instance = await server();
    const issued = await instance.issueBearer({ resourceType: 1, messageType: 4, expiresIn: 60, resourceValue: "test resource" });
    expect((await instance.redeemBearer(issued.envelope)).status).toBe("ACCEPTED");
    const buffer = Buffer.from(issued.envelope);
    buffer[3] = buffer[3]! ^ 1;
    const result = instance.redeemBearer(buffer);
    buffer.set(issued.envelope);
    expect((await result).status).toBe("INVALID");
    expect((await instance.redeemBearer(issued.envelope)).status).toBe("REPLAYED");
  });

  it("persists JSON-safe authority using the adapter transaction and survives server recreation", async () => {
    const base = await server();
    const memory = new MemoryQCCodeStorage();
    const client = { active: true };
    const storage = createQCCodeStorage({
      transaction: <T>(operation: (tx: typeof client) => Promise<T>) => memory.transaction(() => operation(client)),
      putResource: async (tx, issuerId, resourceType, resourceId, value) => {
        expect(tx).toBe(client);
        await memory.putResource(tx, issuerId, resourceType, resourceId, JSON.parse(JSON.stringify(value)));
      },
      getResource: async (tx, ...args) => { expect(tx).toBe(client); return memory.getResource(tx, ...args); },
      claimRedemption: async (tx, claim) => { expect(tx).toBe(client); return memory.claimRedemption(tx, claim); },
      completeRedemption: async (tx, claim, result) => { expect(tx).toBe(client); await memory.completeRedemption(tx, claim, result); },
      isRevoked: async (tx, ...args) => { expect(tx).toBe(client); return memory.isRevoked(tx, ...args); },
      revoke: async (tx, issuerId, messageId) => { expect(tx).toBe(client); await memory.revoke(tx, issuerId, messageId); },
    });
    const instance = new QCCodeServer(base.issuer, { storage });
    const issued = await instance.issueBearer({ resourceType: 1, messageType: 4, expiresIn: 60, resourceValue: { protected: true } });
    const restarted = new QCCodeServer(base.issuer, { storage });
    expect(await restarted.redeemBearer(issued.envelope)).toEqual({ status: "ACCEPTED", result: { protected: true } });
    expect((await instance.redeemBearer(issued.envelope)).status).toBe("REPLAYED");
  });

  it("rolls back bearer issuance if the resource write fails", async () => {
    const instance = await server();
    const putResource = instance.storage.putResource.bind(instance.storage);
    const resourceId = new Uint8Array(12).fill(7);
    let storedId: Uint8Array | undefined;
    vi.spyOn(instance.storage, "putResource").mockImplementationOnce(async (...args) => {
      storedId = args[3];
      await putResource(...args);
      throw new Error("write failed");
    });
    await expect(instance.issueBearer({ resourceType: 1, resourceId, messageType: 4, expiresIn: 60, resourceValue: "test resource" })).rejects.toThrow("write failed");
    expect(storedId).toHaveLength(24);
    expect(await instance.storage.getResource(undefined, instance.issuer.issuerId, 1, storedId!)).toBeNull();
  });
});
