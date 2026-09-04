import { describe, expect, it } from "vitest";
import { MemoryQCCodeStorage, QCCodeMode, QCCodeServer, encodeReferencePayload, privateKeyFromSeed, signEd25519 } from "../packages/server-sdk/src/index.js";

const hex = (value: string) => Uint8Array.from(value.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
const seed = hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
const publicKey = hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");

async function server(): Promise<QCCodeServer> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  return new QCCodeServer({ issuerId: new Uint8Array(16).fill(4), keyId: 1, privateKeyPkcs8: await privateKeyFromSeed(seed), publicKey, keyNotBefore: now - 100n, keyNotAfter: now + 10_000n });
}

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
});
