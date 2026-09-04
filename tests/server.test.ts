import { describe, expect, it } from "vitest";
import { QCCodeMode, encodeReferencePayload } from "../packages/protocol/src/index.js";
import { privateKeyFromSeed } from "../packages/security/src/index.js";
import { QCCodeServer } from "../packages/server-sdk/src/index.js";

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
    instance.registerResource(resourceId, { name: "protected resource" });
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
});
