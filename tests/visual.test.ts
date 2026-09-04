import { describe, expect, it } from "vitest";
import { decodeIdealSymbol } from "../packages/decoder/src/index.js";
import { encodeCircleCode } from "../packages/encoder/src/index.js";
import { decodeBootstrap, encodeBootstrap, LAYOUTS, ORIENTATION_BITS, recoverOrientation } from "../packages/geometry/src/index.js";
import { CircleCodeFlag, CircleCodeMode, equalBytes } from "../packages/protocol/src/index.js";
import { issueEnvelope, privateKeyFromSeed } from "../packages/security/src/index.js";
import { renderSvg } from "../packages/renderer-svg/src/index.js";

const hex = (value: string) => Uint8Array.from(value.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
const seed = hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");

async function inlineEnvelope(payloadLength: number): Promise<Uint8Array> {
  return issueEnvelope({
    mode: CircleCodeMode.INLINE,
    flags: CircleCodeFlag.USER_CONFIRMATION_REQUIRED,
    issuerId: new Uint8Array(16).fill(1),
    keyId: 1,
    messageType: 1,
    messageId: new Uint8Array(16).fill(2),
    issuedAt: 100n,
    expiresAt: 200n,
    nonce: new Uint8Array(16).fill(3),
    payload: Uint8Array.from({ length: payloadLength }, (_, index) => index),
  }, await privateKeyFromSeed(seed));
}

describe("visual protocol", () => {
  it("decodes BCH bootstrap with bit damage", () => {
    const bits = encodeBootstrap(LAYOUTS.C2, 7);
    bits[1] ^= 1; bits[9] ^= 1; bits[19] ^= 1;
    expect(decodeBootstrap(bits)).toMatchObject({ layout: LAYOUTS.C2, mask: 7, correctedBits: 0 });
  });

  it("recovers all cyclic rotations", () => {
    for (let offset = 0; offset < 63; offset++) {
      const rotated = Uint8Array.from({ length: 63 }, (_, index) => ORIENTATION_BITS[(index + offset) % 63]!);
      expect(recoverOrientation(rotated).offset).toBe(offset);
    }
  });

  it.each([[32, "C1"], [50, "C2"], [300, "C3"]] as const)("round trips payload %i through %s", async (payloadLength, expectedLayout) => {
    const envelope = await inlineEnvelope(payloadLength);
    const symbol = encodeCircleCode(envelope);
    expect(symbol.layout.id).toBe(expectedLayout);
    expect(equalBytes(decodeIdealSymbol(symbol).envelopeBytes, envelope)).toBe(true);
    const svg = renderSvg(symbol);
    expect(svg).toContain("<svg");
    expect(svg).not.toContain("<rect");
    expect(svg).toContain('stroke-linecap="round"');
    expect(svg).toContain("#79A987");
    expect(svg).toContain("#356147");
    const logoSvg = renderSvg(symbol, { center: { mode: "logo", imageHref: "/mark.svg", scale: 0.72 } });
    expect(logoSvg).toContain('<image href="/mark.svg"');
    expect(logoSvg).toContain("#F1F3F2");
  });
});
