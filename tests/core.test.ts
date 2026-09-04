import { describe, expect, it } from "vitest";
import { crc32c, reedSolomonDecode, reedSolomonEncode } from "../packages/core/src/index.js";

describe("CRC-32C", () => {
  it("matches the Castagnoli check value", () => {
    expect(crc32c(new TextEncoder().encode("123456789"))).toBe(0xe3069283);
  });
});

describe("RS(255,191)", () => {
  const source = Uint8Array.from({ length: 191 }, (_, index) => (index * 73 + 19) & 255);

  it("round trips without corruption", () => {
    expect(reedSolomonDecode(reedSolomonEncode(source)).data).toEqual(source);
  });

  it("corrects 32 unknown byte errors", () => {
    const damaged = reedSolomonEncode(source);
    for (let index = 0; index < 32; index++) damaged[(index * 7) % 255] ^= (index + 1);
    const result = reedSolomonDecode(damaged);
    expect(result.data).toEqual(source);
    expect(result.correctedErrors).toBe(32);
  });

  it("corrects 64 known erasures", () => {
    const damaged = reedSolomonEncode(source);
    const positions = Array.from({ length: 64 }, (_, index) => (index * 11) % 255);
    for (const position of positions) damaged[position] = 0;
    const result = reedSolomonDecode(damaged, positions);
    expect(result.data).toEqual(source);
    expect(result.erasures).toBe(64);
  });

  it("corrects mixed errors and erasures at the 2e+s bound", () => {
    const damaged = reedSolomonEncode(source);
    const erasures = Array.from({ length: 44 }, (_, index) => (index * 5) % 255);
    for (const position of erasures) damaged[position] = 0;
    const errorPositions = Array.from({ length: 10 }, (_, index) => 221 + index * 3).filter((position) => !erasures.includes(position));
    for (let index = 0; index < 10; index++) damaged[errorPositions[index]!] ^= 0xa5 ^ index;
    const result = reedSolomonDecode(damaged, erasures);
    expect(result.data).toEqual(source);
    expect(result.correctedErrors).toBe(10);
    expect(result.erasures).toBe(44);
  });
});
