import { decodeBootstrap, LAYOUTS, ORIENTATION_BITS, type QCCodeSymbol } from "@qccode/geometry";

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

export function decodeImageData(image: ImageData): VisionDecodeResult {
  const gray = grayscale(image);
  const threshold = otsu(gray);
  let minX = image.width, minY = image.height, maxX = -1, maxY = -1;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    if (gray[y * image.width + x]! <= threshold) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  }
  if (maxX <= minX || maxY <= minY) throw new Error("VISUAL_CANDIDATE_NOT_FOUND");
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const rx = (maxX - minX + 1) / 2, ry = (maxY - minY + 1) / 2;
  if (Math.min(rx, ry) < 30 || Math.max(rx, ry) / Math.min(rx, ry) > 2.5) throw new Error("VISUAL_CANDIDATE_NOT_FOUND");
  const sampleGray = (radius: number, angle: number): number => {
    const x = Math.max(0, Math.min(image.width - 1, Math.round(cx + rx * radius * Math.cos(angle))));
    const y = Math.max(0, Math.min(image.height - 1, Math.round(cy + ry * radius * Math.sin(angle))));
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
    symbol: { visualVersion: 1, layout: bootstrap.layout, eccId: 1, mask: bootstrap.mask, orientation: ORIENTATION_BITS.slice(), bootstrap: bootstrapBits, dataRings },
    rotation: best.phase + Math.PI / 2,
    mirrored: best.mirrored,
    confidence,
    unknownPhysicalSlots,
  };
}
