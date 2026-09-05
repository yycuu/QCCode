import { decodeBootstrap, ORIENTATION_BITS, type QCCodeSymbol } from "@qccode/geometry";

import { decodeSampledSymbol } from "@qccode/decoder";

export type VisionDecodeResult = { symbol: QCCodeSymbol; rotation: number; mirrored: boolean; confidence: number; unknownPhysicalSlots: number[] };

function grayscale(image: ImageData): Uint8Array {
  const result = new Uint8Array(image.width * image.height);
  for (let index = 0; index < result.length; index++) {
    const offset = index * 4;
    result[index] = Math.round(image.data[offset]! * 0.2126 + image.data[offset + 1]! * 0.7152 + image.data[offset + 2]! * 0.0722);
  }
  return result;
}

function otsu(values: Uint8Array): number {
  const histogram = new Uint32Array(256);
  for (const value of values) histogram[value] = histogram[value]! + 1;
  let sum = 0;
  for (let value = 0; value < 256; value++) sum += value * histogram[value]!;
  let backgroundWeight = 0, backgroundSum = 0, bestVariance = -1, threshold = 127;
  for (let value = 0; value < 256; value++) {
    backgroundWeight += histogram[value]!;
    if (backgroundWeight === 0) continue;
    const foregroundWeight = values.length - backgroundWeight;
    if (foregroundWeight === 0) break;
    backgroundSum += value * histogram[value]!;
    const meanBackground = backgroundSum / backgroundWeight;
    const meanForeground = (sum - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (meanBackground - meanForeground) ** 2;
    if (variance > bestVariance) { bestVariance = variance; threshold = value; }
  }
  return threshold;
}

function sampleCandidate(image: ImageData, gray: Uint8Array, bounds: Bounds, correction: Correction, threshold: number): VisionDecodeResult {
  const { x, y, width, height } = bounds;
  const cx = x + (width - 1) / 2, cy = y + (height - 1) / 2;
  const rx = width / 2, ry = height / 2;
  const sampleGray = (radius: number, angle: number): number => {
    const u = radius * Math.cos(angle), v = radius * Math.sin(angle);
    const denominator = 1 + correction.q * v;
    const px = cx + rx * (u * Math.sqrt(1 - correction.q ** 2) / denominator + correction.shear * v);
    const py = cy + ry * (v + correction.q) / denominator;
    const x = Math.round(px), y = Math.round(py);
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return 255;
    return gray[y * image.width + x]!;
  };
  const sample = (radius: number, angle: number): number => sampleGray(radius, angle) <= threshold ? 1 : 0;
  let best = { matches: -1, phase: 0, mirrored: false };
  for (const mirrored of [false, true]) {
    const direction = mirrored ? -1 : 1;
    for (let step = 0; step < 252; step++) {
      const phase = -Math.PI / 2 + step * Math.PI * 2 / 252;
      let matches = 0;
      for (let slot = 0; slot < 63; slot++) if (sample(100.5 / 113, phase + direction * (slot + 0.5) * Math.PI * 2 / 63) === ORIENTATION_BITS[slot]) matches++;
      if (matches > best.matches) best = { matches, phase, mirrored };
    }
  }
  const confidence = best.matches / 63;
  if (confidence < 0.70) throw new Error("ORIENTATION_AMBIGUOUS");
  const direction = best.mirrored ? -1 : 1;
  const ringBits = (count: number, radius: number): Uint8Array => Uint8Array.from({ length: count }, (_, slot) => sample(radius, best.phase + direction * (slot + 0.5) * Math.PI * 2 / count));
  const bootstrapBits = ringBits(64, 92 / 113);
  const bootstrap = decodeBootstrap(bootstrapBits);
  const inner = bootstrap.layout.centerRadius;
  const outer = 87 / 113;
  const radialPitch = (outer - inner) / bootstrap.layout.ringSlots.length;
  const samples = bootstrap.layout.ringSlots.map((count, ring) => Array.from({ length: count }, (_, slot) => sampleGray(inner + (ring + 0.5) * radialPitch, best.phase + direction * (slot + 0.5) * Math.PI * 2 / count)));
  const unique = [...new Set(samples.flat())].sort((a, b) => a - b);
  let centers: number[] = [];
  if (unique.length > 0) centers.push(unique[unique.length - 1]!);
  while (centers.length < 4) {
    let candidate = -1;
    let bestDistance = -1;
    for (const value of unique) {
      let nearest = Number.POSITIVE_INFINITY;
      for (const center of centers) nearest = Math.min(nearest, Math.abs(value - center));
      if (nearest > bestDistance) { bestDistance = nearest; candidate = value; }
    }
    if (candidate < 0 || bestDistance <= 0) break;
    centers.push(candidate);
  }
  while (centers.length < 4) centers.push(unique[0] ?? 0);
  for (let iteration = 0; iteration < 12; iteration++) {
    const groups = centers.map(() => [] as number[]);
    for (const value of samples.flat()) {
      let nearest = 0;
      for (let index = 1; index < centers.length; index++) if (Math.abs(value - centers[index]!) < Math.abs(value - centers[nearest]!)) nearest = index;
      groups[nearest]!.push(value);
    }
    centers = centers.map((center, index) => groups[index]!.length ? groups[index]!.reduce((sum, value) => sum + value, 0) / groups[index]!.length : center).sort((a, b) => b - a);
  }
  const unknownPhysicalSlots: number[] = [];
  let physicalOffset = 0;
  const dataRings = samples.map((ring) => {
    const values = Uint8Array.from(ring, (value, slot) => {
      const distances = centers.map((center, index) => ({ index, distance: Math.abs(value - center) })).sort((a, b) => a.distance - b.distance);
      if (distances[1]!.distance - distances[0]!.distance < 12) unknownPhysicalSlots.push(physicalOffset + slot);
      return distances[0]!.index;
    });
    physicalOffset += ring.length;
    return values;
  });
  return {
    symbol: { visualVersion: bootstrap.layout.visualVersion, layout: bootstrap.layout, eccId: 1, mask: bootstrap.mask, orientation: ORIENTATION_BITS.slice(), bootstrap: bootstrapBits, dataRings },
    rotation: best.phase + Math.PI / 2,
    mirrored: best.mirrored,
    confidence,
    unknownPhysicalSlots,
  };
}

export type Bounds = { x: number; y: number; width: number; height: number };
export type Correction = { q: number; shear: number };
export type VisionDecodeOptions = {
  /** Bounded hypotheses per candidate; default 12, maximum 81. */
  maxCorrections?: number;
  correctionOffset?: number;
  previousCorrection?: Correction;
};
export type VisionStage = "detection" | "orientation" | "bootstrap" | "data";
export class VisionDecodeError extends Error {
  constructor(readonly stage: VisionStage, readonly candidates: number, readonly attempts: number, cause?: unknown) {
    super(stage === "detection" ? "VISUAL_CANDIDATE_NOT_FOUND" : `VISUAL_${stage.toUpperCase()}_FAILED`, { cause });
    this.name = "VisionDecodeError";
  }
}

// Separate connected components prevent text and monitor borders from changing
// a symbol's bounds. Detection is capped at 960px on the longest image edge.
function candidates(gray: Uint8Array, width: number, height: number): Bounds[] {
  const step = Math.max(1, Math.ceil(Math.max(width, height) / 960));
  const w = Math.ceil(width / step), h = Math.ceil(height / step);
  const small = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) small[y * w + x] = gray[y * step * width + x * step]!;
  const found: Bounds[] = [];
  const seen = new Uint8Array(w * h), queue = new Int32Array(w * h);
  for (const threshold of new Set([otsu(small), 70, 150])) {
    seen.fill(0);
    for (let p = 0; p < small.length; p++) {
      if (seen[p] || small[p]! > threshold) continue;
      let head = 0, tail = 1, minX = w, minY = h, maxX = 0, maxY = 0;
      queue[0] = p; seen[p] = 1;
      while (head < tail) {
        const pixel = queue[head++]!, x = pixel % w, y = Math.floor(pixel / w);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy, next = ny * w + nx;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h || seen[next] || small[next]! > threshold) continue;
          seen[next] = 1; queue[tail++] = next;
        }
      }
      const bw = maxX - minX + 1, bh = maxY - minY + 1, density = tail / (bw * bh);
      if (Math.min(bw, bh) * step < 60 || Math.max(bw, bh) / Math.min(bw, bh) > 2.5 || density < 0.025 || density > 0.30) continue;
      const bound = { x: minX * step, y: minY * step, width: Math.min(width - minX * step, bw * step), height: Math.min(height - minY * step, bh * step) };
      if (!found.some(b => Math.abs(b.x - bound.x) + Math.abs(b.y - bound.y) + Math.abs(b.width - bound.width) + Math.abs(b.height - bound.height) < 8 * step)) found.push(bound);
    }
  }
  return found.sort((a, b) => b.width * b.height - a.width * a.height).slice(0, 6);
}

const CORRECTIONS: Correction[] = [0, .04, .06, .08, -.04, -.06, -.08, .12, -.12].flatMap(q =>
  [0, -.025, .025, -.05, .05, -.1, .1, -.2, .2].map(shear => ({ q, shear })));

/** Locate independent rings, then accept only samples with valid ECC and CRC. */
export function decodeImageData(image: ImageData, options: VisionDecodeOptions = {}): VisionDecodeResult & { bounds: Bounds; correction: Correction } {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width <= 0 || image.height <= 0 || image.data.length !== image.width * image.height * 4) throw new Error("INVALID_IMAGE_DATA");
  const limit = options.maxCorrections ?? 12, offset = options.correctionOffset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 81 || !Number.isInteger(offset) || offset < 0) throw new Error("INVALID_VISION_OPTIONS");
  if (options.previousCorrection && (!Number.isFinite(options.previousCorrection.q) || Math.abs(options.previousCorrection.q) > .12 || !Number.isFinite(options.previousCorrection.shear) || Math.abs(options.previousCorrection.shear) > .2)) throw new Error("INVALID_VISION_OPTIONS");
  const gray = grayscale(image), regions = candidates(gray, image.width, image.height);
  const thresholds = regions.map(({ x, y, width, height }) => {
    const local = new Uint8Array(width * height);
    for (let row = 0; row < height; row++) local.set(gray.subarray((y + row) * image.width + x, (y + row) * image.width + x + width), row * width);
    return otsu(local);
  });
  let attempts = 0, stage: VisionStage = "detection", cause: unknown;
  const trials = [CORRECTIONS[0]!, ...(options.previousCorrection ? [options.previousCorrection] : []), ...Array.from({ length: limit }, (_, i) => CORRECTIONS[(offset + i) % CORRECTIONS.length]!)];
  // Try all uncorrected candidates before spending the budget on perspective.
  for (const correction of trials.filter((c, i) => trials.findIndex(t => t.q === c.q && t.shear === c.shear) === i)) {
    for (const [index, bounds] of regions.entries()) {
      attempts++;
      try {
        const visual = sampleCandidate(image, gray, bounds, correction, thresholds[index]!);
        try { decodeSampledSymbol(visual.symbol, visual.unknownPhysicalSlots); }
        catch (error) { stage = "data"; cause = error; continue; }
        return { ...visual, bounds, correction };
      } catch (error) {
        const next = error instanceof Error && error.message.startsWith("BOOTSTRAP") ? "bootstrap" : "orientation";
        if (stage !== "data" && (stage !== "bootstrap" || next === "bootstrap")) { stage = next; cause = error; }
      }
    }
  }
  throw new VisionDecodeError(stage, regions.length, attempts, cause);
}
