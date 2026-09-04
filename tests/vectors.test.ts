import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { decodeIdealSymbol } from "../packages/decoder/src/index.js";
import { encodeCircleCode } from "../packages/encoder/src/index.js";
import { equalBytes, fromBase64Url } from "../packages/protocol/src/index.js";

const vectorNames = ["inline-hello", "reference-token", "challenge-login", "expired", "invalid-signature", "modified-payload", "wrong-issuer", "wrong-kid", "replay"];

describe("committed V1 golden vectors", () => {
  it.each(vectorNames)("reproduces visual layout for %s", async (name) => {
    const directory = new URL(`./vectors/v1/${name}/`, import.meta.url);
    const envelope = fromBase64Url((await readFile(new URL("envelope.base64url.txt", directory), "utf8")).trim());
    const expected = JSON.parse(await readFile(new URL("expected.json", directory), "utf8"));
    const symbol = encodeCircleCode(envelope);
    const decoded = decodeIdealSymbol(symbol);
    expect(symbol.layout.id).toBe(expected.layout);
    expect(symbol.mask).toBe(expected.mask);
    expect(symbol.layout.totalSlots * 2).toBe(expected.visualBits);
    expect(equalBytes(decoded.envelopeBytes, envelope)).toBe(true);
  });
});
