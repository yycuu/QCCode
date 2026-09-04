import type { CircleCodeSymbol } from "@circlecode/geometry";

export type CanvasRenderOptions = {
  size?: number;
  foreground?: string;
  background?: string;
  dataBackground?: string;
  levels?: readonly [string, string, string, string];
  center?: { mode: "none" } | { mode: "logo"; image: CanvasImageSource; scale?: number };
};

function drawRing(ctx: CanvasRenderingContext2D, bits: ArrayLike<number>, inner: number, outer: number, levels?: readonly [string, string, string, string], zeroStyle?: string): void {
  const pitch = Math.PI * 2 / bits.length;
  ctx.lineCap = "round";
  ctx.lineWidth = Math.min(outer - inner, ((inner + outer) / 2) * pitch * 0.72);
  const binaryStyle = String(ctx.fillStyle);
  for (let slot = 0; slot < bits.length; slot++) {
    if (bits[slot] === 0 && !zeroStyle) continue;
    ctx.strokeStyle = bits[slot] === 0 ? zeroStyle! : levels?.[bits[slot]!] ?? binaryStyle;
    const start = -Math.PI / 2 + (slot + 0.42) * pitch;
    const end = -Math.PI / 2 + (slot + 0.58) * pitch;
    ctx.beginPath();
    ctx.arc(128, 128, (inner + outer) / 2, start, end);
    ctx.stroke();
  }
}

function drawRadialMarkers(ctx: CanvasRenderingContext2D, bits: ArrayLike<number>, inner: number, outer: number, levels: readonly [string, string, string, string]): void {
  const radius = (inner + outer) / 2;
  const radialSize = (outer - inner) * 0.90;
  const pitch = Math.PI * 2 / bits.length;
  const tangentialSize = radius * pitch * 0.72;
  for (let slot = 0; slot < bits.length; slot++) {
    const value = bits[slot]!;
    if (value === 0) continue;
    const angle = -Math.PI / 2 + (slot + 0.5) * pitch;
    ctx.save();
    ctx.translate(128 + radius * Math.cos(angle), 128 + radius * Math.sin(angle));
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.ellipse(0, 0, radialSize / 2, tangentialSize / 2, 0, 0, Math.PI * 2);
    ctx.fillStyle = levels[value]!;
    ctx.fill();
    ctx.restore();
  }
}

export function renderCanvas(symbol: CircleCodeSymbol, canvas: HTMLCanvasElement | OffscreenCanvas, options: CanvasRenderOptions = {}): void {
  const size = options.size ?? 512;
  const foreground = options.foreground ?? "#000000";
  const background = options.background ?? "#FFFFFF";
  const dataBackground = options.dataBackground ?? "#F1F3F2";
  const levels = options.levels ?? [dataBackground, "#79A987", "#356147", foreground] as const;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D Canvas is unavailable");
  const ctx = context as CanvasRenderingContext2D;
  ctx.save();
  ctx.scale(size / 256, size / 256);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, 256, 256);
  ctx.fillStyle = dataBackground;
  ctx.beginPath();
  ctx.arc(128, 128, 87, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = foreground;
  ctx.beginPath();
  ctx.arc(128, 128, 109.5, 0, Math.PI * 2);
  ctx.lineWidth = 7;
  ctx.strokeStyle = ctx.fillStyle;
  ctx.stroke();
  drawRing(ctx, symbol.orientation, 97, 104, undefined, "#DCE3DE");
  drawRing(ctx, symbol.bootstrap, 89, 95, undefined, "#DCE3DE");
  const inner = symbol.layout.centerRadius * 113;
  const pitch = (87 - inner) / symbol.dataRings.length;
  symbol.dataRings.forEach((bits, ring) => drawRadialMarkers(ctx, bits, inner + ring * pitch + pitch * 0.09, inner + (ring + 1) * pitch - pitch * 0.09, levels));
  const center = options.center ?? { mode: "none" };
  if (center.mode === "logo") {
    const diameter = inner * 2 * Math.min(center.scale ?? 0.82, 0.82);
    ctx.save();
    ctx.beginPath();
    ctx.arc(128, 128, diameter / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(center.image, 128 - diameter / 2, 128 - diameter / 2, diameter, diameter);
    ctx.restore();
  }
  ctx.restore();
}
