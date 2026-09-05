import { arcRuns, type QCCodeSymbol } from "@qccode/geometry";

export type SvgRenderOptions = {
  size?: number;
  foreground?: string;
  background?: string;
  dataBackground?: string;
  levels?: readonly [string, string, string, string];
  center?: { mode: "none" } | { mode: "logo"; imageHref: string; scale?: number; background?: string };
  title?: string;
};

function point(radius: number, angle: number): [number, number] {
  return [128 + radius * Math.cos(angle), 128 + radius * Math.sin(angle)];
}

function roundedArcPaths(bits: ArrayLike<number>, inner: number, outer: number, includeZero = false): Array<{ d: string; width: number; value: number }> {
  const pitch = Math.PI * 2 / bits.length;
  const radius = (inner + outer) / 2;
  const paths: Array<{ d: string; width: number; value: number }> = [];
  for (let slot = 0; slot < bits.length; slot++) {
    if (bits[slot] === 0 && !includeZero) continue;
    const start = -Math.PI / 2 + (slot + 0.42) * pitch;
    const end = -Math.PI / 2 + (slot + 0.58) * pitch;
    const [x1, y1] = point(radius, start), [x2, y2] = point(radius, end);
    paths.push({ d: `M${x1.toFixed(3)} ${y1.toFixed(3)}A${radius.toFixed(3)} ${radius.toFixed(3)} 0 0 1 ${x2.toFixed(3)} ${y2.toFixed(3)}`, width: Math.min(outer - inner, radius * pitch * 0.72), value: bits[slot]! });
  }
  return paths;
}

function dataArcBlocks(bits: ArrayLike<number>, inner: number, outer: number, tangential: number, levels: readonly string[]): string[] {
  const radius = (inner + outer) / 2;
  const radialSize = outer - inner;
  const pitch = Math.PI * 2 / bits.length;
  const markers: string[] = [];
  for (let slot = 0; slot < bits.length; slot++) {
    const value = bits[slot]!;
    if (value === 0) continue;
    const angle = -Math.PI / 2 + (slot + 0.5) * pitch;
    const [cx, cy] = point(radius, angle);
    markers.push(`<ellipse cx="${cx.toFixed(3)}" cy="${cy.toFixed(3)}" rx="${(radialSize / 2).toFixed(3)}" ry="${(tangential / 2).toFixed(3)}" transform="rotate(${(angle * 180 / Math.PI).toFixed(3)} ${cx.toFixed(3)} ${cy.toFixed(3)})" fill="${escapeXml(levels[value] ?? levels[3]!)}"/>`);
  }
  return markers;
}

function dataArcDashes(bits: ArrayLike<number>, inner: number, outer: number, levels: readonly string[]): string[] {
  const radius = (inner + outer) / 2;
  const pitch = Math.PI * 2 / bits.length;
  const markers: string[] = [];
  for (const run of arcRuns(bits)) {
    const value = run.value;
    if (value === 0) continue;
    const start = -Math.PI / 2 + (run.start + 0.42) * pitch;
    const end = -Math.PI / 2 + (run.end + 0.58) * pitch;
    const [x1, y1] = point(radius, start), [x2, y2] = point(radius, end);
    markers.push(`<path d="M${x1.toFixed(3)} ${y1.toFixed(3)}A${radius.toFixed(3)} ${radius.toFixed(3)} 0 0 1 ${x2.toFixed(3)} ${y2.toFixed(3)}" fill="none" stroke="${escapeXml(levels[value] ?? levels[3]!)}" stroke-width="${(outer - inner).toFixed(3)}" stroke-linecap="round"/>`);
  }
  return markers;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function colorLuminance(color: string): number | null {
  const match = /^#([0-9a-f]{6})$/iu.exec(color);
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 16);
  const channels = [value >>> 16, (value >>> 8) & 255, value & 255].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

export function renderSvg(symbol: QCCodeSymbol, options: SvgRenderOptions = {}): string {
  const size = options.size ?? 512;
  const foreground = options.foreground ?? "#000000";
  const background = options.background ?? "#FFFFFF";
  const dataBackground = options.dataBackground ?? (symbol.layout.visualVersion === 2 ? "#FFFFFF" : "#F1F3F2");
  const levels = options.levels ?? [dataBackground, symbol.layout.visualVersion === 2 ? "#BBBBBB" : "#C6CCC8", symbol.layout.visualVersion === 2 ? "#808080" : "#737A76", foreground] as const;
  const fgLum = colorLuminance(foreground), bgLum = colorLuminance(background);
  if (fgLum !== null && bgLum !== null) {
    const ratio = (Math.max(fgLum, bgLum) + 0.05) / (Math.min(fgLum, bgLum) + 0.05);
    if (ratio < 7) throw new Error(`QCCode contrast ratio ${ratio.toFixed(2)} is below 7:1`);
  }
  const levelLuminance = levels.map(colorLuminance);
  if (levelLuminance.every((value): value is number => value !== null)) {
    for (let index = 1; index < levelLuminance.length; index++) {
      if (levelLuminance[index - 1]! <= levelLuminance[index]! || levelLuminance[index - 1]! - levelLuminance[index]! < 0.06) throw new Error("QCCode levels must have four ordered, distinguishable luminances");
    }
  }
  const paths: string[] = [];
  paths.push(`<circle cx="128" cy="128" r="128" fill="${escapeXml(background)}"/>`);
  paths.push(`<circle cx="128" cy="128" r="87" fill="${escapeXml(dataBackground)}"/>`);
  paths.push(`<circle cx="128" cy="128" r="109.5" fill="none" stroke="${escapeXml(foreground)}" stroke-width="7"/>`);
  for (const path of roundedArcPaths(symbol.orientation, 97, 104, true)) paths.push(`<path d="${path.d}" fill="none" stroke="${escapeXml(path.value === 0 ? "#DCE3DE" : foreground)}" stroke-width="${path.width}" stroke-linecap="round"/>`);
  for (const path of roundedArcPaths(symbol.bootstrap, 89, 95, true)) paths.push(`<path d="${path.d}" fill="none" stroke="${escapeXml(path.value === 0 ? "#DCE3DE" : foreground)}" stroke-width="${path.width}" stroke-linecap="round"/>`);
  const inner = symbol.layout.centerRadius * 113;
  const outer = 87;
  const pitch = (outer - inner) / symbol.dataRings.length;
  const outerCount = symbol.dataRings[symbol.dataRings.length - 1]!.length;
  const tangential = (Math.PI * 2 * (outer - 0.17) / outerCount) * 0.9;
  symbol.dataRings.forEach((bits, ring) => {
    const ringInner = inner + ring * pitch + 0.17;
    const ringOuter = inner + (ring + 1) * pitch - 0.17;
    if (symbol.layout.visualVersion === 2) paths.push(...dataArcDashes(bits, ringInner, ringOuter, levels));
    else paths.push(...dataArcBlocks(bits, ringInner, ringOuter, tangential, levels));
  });
  const center = options.center ?? { mode: "none" };
  if (center.mode === "logo") {
    const scale = Math.min(center.scale ?? 0.82, 0.82);
    const diameter = inner * 2 * scale;
    const clipId = `qccode-logo-${crypto.getRandomValues(new Uint32Array(4)).join("-")}`;
    paths.push(`<defs><clipPath id="${clipId}" clipPathUnits="userSpaceOnUse"><circle cx="128" cy="128" r="${diameter / 2}"/></clipPath></defs>`);
    if (center.background) paths.push(`<circle cx="128" cy="128" r="${inner * 0.9}" fill="${escapeXml(center.background)}"/>`);
    paths.push(`<image href="${escapeXml(center.imageHref)}" x="${128 - diameter / 2}" y="${128 - diameter / 2}" width="${diameter}" height="${diameter}" preserveAspectRatio="xMidYMid meet" clip-path="url(#${clipId})"/>`);
  }
  const title = escapeXml(options.title ?? "QCCode");
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${title}" width="${size}" height="${size}" viewBox="0 0 256 256"><title>${title}</title><g fill="${escapeXml(foreground)}">${paths.join("")}</g></svg>`;
}
