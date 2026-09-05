import { describe, expect, it } from "vitest";
import { decodeIdealSymbol } from "../packages/decoder/src/index.js";
import { encodeQCCode } from "../packages/encoder/src/index.js";
import { decodeBootstrap, encodeBootstrap, LAYOUTS, ORIENTATION_BITS, recoverOrientation } from "../packages/geometry/src/index.js";
import { QCCodeFlag, QCCodeMode, equalBytes } from "../packages/protocol/src/index.js";
import { issueEnvelope, privateKeyFromSeed } from "../packages/security/src/index.js";
import { renderSvg } from "../packages/renderer-svg/src/index.js";

const hex = (value: string) => Uint8Array.from(value.match(/../gu) ?? [], (pair) => Number.parseInt(pair, 16));
const seed = hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");

async function inlineEnvelope(payloadLength: number): Promise<Uint8Array> {
  return issueEnvelope({
    mode: QCCodeMode.INLINE,
    flags: QCCodeFlag.USER_CONFIRMATION_REQUIRED,
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
    const symbol = encodeQCCode(envelope);
    expect(symbol.layout.id).toBe(expectedLayout);
    expect(equalBytes(decodeIdealSymbol(symbol).envelopeBytes, envelope)).toBe(true);
    const svg = renderSvg(symbol);
    expect(svg).toContain("<svg");
    expect(svg).not.toContain("<rect");
    expect(svg).toContain('stroke-linecap="round"');
    expect(svg).toContain("#C6CCC8");
    expect(svg).toContain("#737A76");
    expect(svg).toContain("<ellipse");
    const logoSvg = renderSvg(symbol, { center: { mode: "logo", imageHref: "/mark.svg", scale: 0.72 } });
    expect(logoSvg).toContain('<image href="/mark.svg"');
    expect(logoSvg).toContain("#F1F3F2");
  });
});

it("honors signed layout selection and rejects incompatible capacity", async () => {
  const envelope = await inlineEnvelope(32);
  for (const layout of ["C1", "C2", "C3"] as const) {
    const symbol = encodeQCCode(envelope, { layout });
    expect(symbol.layout.id).toBe(layout);
    expect(decodeIdealSymbol(symbol).envelopeBytes).toEqual(envelope);
  }
  expect(() => encodeQCCode(envelope, { layout: "S1" })).toThrow("S1 requires a bearer");
  expect(() => encodeQCCode(new Uint8Array(), { layout: "C1" })).toThrow();
  expect(() => encodeQCCode(envelope, { layout: "invalid" as "C1" })).toThrow("unknown layout");
  expect(() => encodeQCCode(envelope, { layout: "C1", version: "C2" })).toThrow("conflicting");
  expect(() => encodeQCCode(envelope, { layout: "auto" })).not.toThrow();
  const larger = await inlineEnvelope(50);
  expect(() => encodeQCCode(larger, { layout: "C1" })).toThrow("does not fit");
});
