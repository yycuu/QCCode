export const RS_DATA_BYTES = 191;
export const RS_PARITY_BYTES = 64;
export const RS_CODEWORD_BYTES = 255;

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
let value = 1;
for (let index = 0; index < 255; index++) {
  EXP[index] = value;
  LOG[value] = index;
  value <<= 1;
  if (value & 0x100) value ^= 0x11d;
}
for (let index = 255; index < EXP.length; index++) EXP[index] = EXP[index - 255]!;

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!;
}

function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error("GF division by zero");
  if (a === 0) return 0;
  return EXP[(LOG[a]! - LOG[b]! + 255) % 255]!;
}

function gfPow(a: number, power: number): number {
  if (a === 0) return power === 0 ? 1 : 0;
  return EXP[((LOG[a]! * power) % 255 + 255) % 255]!;
}

// Polynomials are stored highest-degree coefficient first.
function polyTrim(poly: number[]): number[] {
  let first = 0;
  while (first < poly.length - 1 && poly[first] === 0) first++;
  return poly.slice(first);
}

function polyAdd(a: number[], b: number[]): number[] {
  const length = Math.max(a.length, b.length);
  const result = new Array<number>(length).fill(0);
  for (let index = 0; index < a.length; index++) {
    const target = index + length - a.length;
    result[target] = result[target]! ^ a[index]!;
  }
  for (let index = 0; index < b.length; index++) {
    const target = index + length - b.length;
    result[target] = result[target]! ^ b[index]!;
  }
  return polyTrim(result);
}

function polyScale(poly: number[], scalar: number): number[] {
  return poly.map((coefficient) => gfMul(coefficient, scalar));
}

function polyMul(a: number[], b: number[]): number[] {
  const result = new Array<number>(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) result[i + j] = result[i + j]! ^ gfMul(a[i]!, b[j]!);
  }
  return polyTrim(result);
}

function polyEval(poly: ArrayLike<number>, x: number): number {
  let result = 0;
  for (let index = 0; index < poly.length; index++) result = gfMul(result, x) ^ poly[index]!;
  return result;
}

const generators = new Map<number, number[]>();
function rsGenerator(parityBytes: number): number[] {
  const cached = generators.get(parityBytes);
  if (cached) return cached;
  let current = [1];
  for (let index = 0; index < parityBytes; index++) current = polyMul(current, [1, EXP[index]!]);
  generators.set(parityBytes, current);
  return current;
}

export function reedSolomonEncode(data: Uint8Array, parityBytes: number = RS_PARITY_BYTES): Uint8Array {
  if (parityBytes < 1 || parityBytes > RS_PARITY_BYTES) throw new Error(`RS parity must be 1..${RS_PARITY_BYTES} bytes`);
  const result = new Uint8Array(data.length + parityBytes);
  result.set(data);
  const gen = rsGenerator(parityBytes);
  for (let index = 0; index < data.length; index++) {
    const coefficient = result[index]!;
    if (coefficient === 0) continue;
    for (let j = 1; j < gen.length; j++) result[index + j] = result[index + j]! ^ gfMul(gen[j]!, coefficient);
  }
  result.set(data, 0);
  return result;
}

function syndromes(codeword: Uint8Array, parityBytes: number): number[] {
  return Array.from({ length: parityBytes }, (_, index) => polyEval(codeword, EXP[index]!));
}

function solveLinear(matrix: number[][], rhs: number[]): number[] | null {
  const count = rhs.length;
  for (let column = 0; column < count; column++) {
    let pivot = column;
    while (pivot < count && matrix[pivot]![column] === 0) pivot++;
    if (pivot === count) return null;
    [matrix[column], matrix[pivot]] = [matrix[pivot]!, matrix[column]!];
    [rhs[column], rhs[pivot]] = [rhs[pivot]!, rhs[column]!];
    const inverse = gfDiv(1, matrix[column]![column]!);
    for (let j = column; j < count; j++) matrix[column]![j] = gfMul(matrix[column]![j]!, inverse);
    rhs[column] = gfMul(rhs[column]!, inverse);
    for (let row = 0; row < count; row++) {
      if (row === column) continue;
      const factor = matrix[row]![column]!;
      if (factor === 0) continue;
      for (let j = column; j < count; j++) matrix[row]![j] = matrix[row]![j]! ^ gfMul(factor, matrix[column]![j]!);
      rhs[row] = rhs[row]! ^ gfMul(factor, rhs[column]!);
    }
  }
  return rhs;
}

function correctKnownErasures(received: Uint8Array, erasures: number[], parityBytes: number): number {
  if (erasures.length === 0) return 0;
  if (erasures.length > parityBytes) throw new Error("too many RS erasures");
  const syn = syndromes(received, parityBytes);
  const matrix = Array.from({ length: erasures.length }, (_, row) =>
    erasures.map((position) => gfPow(EXP[row]!, RS_CODEWORD_BYTES - 1 - position)),
  );
  const magnitudes = solveLinear(matrix, syn.slice(0, erasures.length));
  if (!magnitudes) throw new Error("singular RS erasure system");
  erasures.forEach((position, index) => { received[position] = received[position]! ^ magnitudes[index]!; });
  return erasures.length;
}

function findErrataLocator(received: Uint8Array, erasures: number[], parityBytes: number): number[] {
  const syn = [0, ...syndromes(received, parityBytes)];
  let locator = [1];
  for (const position of erasures) locator = polyMul(locator, [gfPow(2, received.length - 1 - position), 1]);
  let oldLocator = locator.slice();
  for (let index = 0; index < parityBytes - erasures.length; index++) {
    const syndromeIndex = erasures.length + index + 1;
    let discrepancy = syn[syndromeIndex]!;
    for (let coefficient = 1; coefficient < locator.length; coefficient++) {
      discrepancy ^= gfMul(locator[locator.length - 1 - coefficient]!, syn[syndromeIndex - coefficient]!);
    }
    oldLocator.push(0);
    if (discrepancy === 0) continue;
    if (oldLocator.length > locator.length) {
      const next = polyScale(oldLocator, discrepancy);
      oldLocator = polyScale(locator, gfDiv(1, discrepancy));
      locator = next;
    }
    locator = polyAdd(locator, polyScale(oldLocator, discrepancy));
  }
  locator = polyTrim(locator);
  const errataCount = locator.length - 1;
  if ((errataCount - erasures.length) * 2 + erasures.length > parityBytes) throw new Error("too many RS errors and erasures");
  return locator;
}

function correctErrorsAndErasures(received: Uint8Array, erasures: number[], parityBytes: number): { errors: number; erasures: number } {
  const initialSyndromes = syndromes(received, parityBytes);
  if (initialSyndromes.every((entry) => entry === 0)) return { errors: 0, erasures: 0 };
  const locator = findErrataLocator(received, erasures, parityBytes);
  const locations = findErrorLocations(locator);
  const positions = locations.map((location) => received.length - 1 - LOG[location]!);
  if (positions.some((position) => position < 0) || erasures.some((position) => !positions.includes(position))) throw new Error("invalid RS errata positions");
  const matrix = Array.from({ length: positions.length }, (_, row) => positions.map((position) => gfPow(EXP[row]!, received.length - 1 - position)));
  const magnitudes = solveLinear(matrix, initialSyndromes.slice(0, positions.length));
  if (!magnitudes) throw new Error("singular RS errata system");
  positions.forEach((position, index) => { received[position] = received[position]! ^ magnitudes[index]!; });
  if (!syndromes(received, parityBytes).every((entry) => entry === 0)) throw new Error("uncorrectable RS codeword");
  return { errors: positions.length - erasures.length, erasures: erasures.length };
}

function runEuclideanAlgorithm(aInput: number[], bInput: number[], degree: number): [number[], number[]] {
  let a = aInput;
  let b = bInput;
  if (a.length < b.length) [a, b] = [b, a];
  let rLast = a;
  let r = b;
  let tLast = [0];
  let t = [1];
  while (r.length - 1 >= degree / 2) {
    const rLastLast = rLast;
    const tLastLast = tLast;
    rLast = r;
    tLast = t;
    if (rLast.every((coefficient) => coefficient === 0)) throw new Error("RS Euclidean algorithm failed");
    r = rLastLast;
    let q = [0];
    const denominatorLeadingTerm = rLast[0]!;
    const dltInverse = gfDiv(1, denominatorLeadingTerm);
    while (r.length - 1 >= rLast.length - 1 && !r.every((coefficient) => coefficient === 0)) {
      const degreeDifference = r.length - rLast.length;
      const scale = gfMul(r[0]!, dltInverse);
      const monomial = [...new Array<number>(degreeDifference + 1).fill(0)];
      monomial[0] = scale;
      q = polyAdd(q, monomial);
      r = polyAdd(r, [...polyScale(rLast, scale), ...new Array<number>(degreeDifference).fill(0)]);
    }
    t = polyAdd(polyMul(q, tLast), tLastLast);
  }
  const sigmaTildeAtZero = t[t.length - 1]!;
  if (sigmaTildeAtZero === 0) throw new Error("invalid RS locator");
  const inverse = gfDiv(1, sigmaTildeAtZero);
  return [polyScale(t, inverse), polyScale(r, inverse)];
}

function findErrorLocations(locator: number[]): number[] {
  const count = locator.length - 1;
  if (count === 1) return [locator[0]!];
  const result: number[] = [];
  for (let value = 1; value < 256 && result.length < count; value++) {
    if (polyEval(locator, value) === 0) result.push(gfDiv(1, value));
  }
  if (result.length !== count) throw new Error("could not locate RS errors");
  return result;
}

function findErrorMagnitudes(evaluator: number[], locations: number[]): number[] {
  return locations.map((location, index) => {
    const inverse = gfDiv(1, location);
    let denominator = 1;
    for (let j = 0; j < locations.length; j++) {
      if (index !== j) denominator = gfMul(denominator, 1 ^ gfMul(locations[j]!, inverse));
    }
    return gfMul(polyEval(evaluator, inverse), gfDiv(1, denominator));
  });
}

function correctUnknownErrors(received: Uint8Array, parityBytes: number): number {
  const syn = syndromes(received, parityBytes);
  if (syn.every((entry) => entry === 0)) return 0;
  const syndromePoly = polyTrim(syn.slice().reverse());
  const monomial = [1, ...new Array<number>(parityBytes).fill(0)];
  const [locator, evaluator] = runEuclideanAlgorithm(monomial, syndromePoly, parityBytes);
  const locations = findErrorLocations(locator);
  const magnitudes = findErrorMagnitudes(evaluator, locations);
  for (let index = 0; index < locations.length; index++) {
    const position = received.length - 1 - LOG[locations[index]!]!;
    if (position < 0) throw new Error("invalid RS error position");
    received[position] = received[position]! ^ magnitudes[index]!;
  }
  if (!syndromes(received, parityBytes).every((entry) => entry === 0)) throw new Error("uncorrectable RS codeword");
  return locations.length;
}

export function reedSolomonDecode(codeword: Uint8Array, erasures: number[] = [], parityBytes: number = RS_PARITY_BYTES): { data: Uint8Array; correctedErrors: number; erasures: number } {
  if (parityBytes < 1 || parityBytes > RS_PARITY_BYTES) throw new Error(`RS parity must be 1..${RS_PARITY_BYTES} bytes`);
  if (codeword.length <= parityBytes) throw new Error("RS codeword must exceed its parity length");
  if (new Set(erasures).size !== erasures.length || erasures.some((position) => !Number.isInteger(position) || position < 0 || position >= codeword.length)) {
    throw new Error("invalid RS erasure positions");
  }
  const received = codeword.slice();
  if (erasures.length === 0) {
    const correctedErrors = correctUnknownErrors(received, parityBytes);
    return { data: received.slice(0, codeword.length - parityBytes), correctedErrors, erasures: 0 };
  }
  const corrected = correctErrorsAndErasures(received, erasures, parityBytes);
  return { data: received.slice(0, codeword.length - parityBytes), correctedErrors: corrected.errors, erasures: corrected.erasures };
}

export function crc32c(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

export function bytesToBits(bytes: Uint8Array): Uint8Array {
  const bits = new Uint8Array(bytes.length * 8);
  for (let index = 0; index < bits.length; index++) bits[index] = (bytes[index >>> 3]! >>> (7 - (index & 7))) & 1;
  return bits;
}

export function bitsToBytes(bits: ArrayLike<number>): Uint8Array {
  if (bits.length % 8 !== 0) throw new Error("bit count must be byte aligned");
  const bytes = new Uint8Array(bits.length / 8);
  for (let index = 0; index < bits.length; index++) {
    const target = index >>> 3;
    bytes[target] = bytes[target]! | ((bits[index]! & 1) << (7 - (index & 7)));
  }
  return bytes;
}

export function maskBit(mask: number, ring: number, slot: number): number {
  switch (mask) {
    case 0: return 0;
    case 1: return (ring + slot) & 1;
    case 2: return slot % 3 === 0 ? 1 : 0;
    case 3: return (2 * ring + slot) % 5 < 2 ? 1 : 0;
    case 4: return (ring * slot + ring + slot) & 1;
    case 5: {
      let value = (ring + 1) * (slot + 1), parity = 0;
      while (value) { parity ^= value & 1; value >>>= 1; }
      return parity;
    }
    case 6: return (Math.floor(slot / 3) + ring) & 1;
    case 7: return (slot * slot + 3 * ring + slot) % 7 < 3 ? 1 : 0;
    default: throw new Error("mask must be between 0 and 7");
  }
}

export function maskSymbol(mask: number, ring: number, slot: number): number {
  if (mask === 0) return 0;
  return maskBit(mask, ring, slot) | (maskBit(((mask + 2) % 7) + 1, ring + 1, slot) << 1);
}
