import type { QCCodeSymbol } from "@qccode/geometry";

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

function drawDataArcBlocks(ctx: CanvasRenderingContext2D, bits: ArrayLike<number>, inner: number, outer: number, levels: readonly [string, string, string, string]): void {
  const pitch = Math.PI * 2 / bits.length;
  for (let slot = 0; slot < bits.length; slot++) {
    const value = bits[slot]!;
    if (value === 0) continue;
    const start = -Math.PI / 2 + (slot + 0.03) * pitch;
    const end = -Math.PI / 2 + (slot + 0.97) * pitch;
    ctx.beginPath();
    ctx.arc(128, 128, outer, start, end);
    ctx.arc(128, 128, inner, end, start, true);
    ctx.closePath();
    ctx.fillStyle = levels[value]!;
    ctx.fill();
    ctx.lineWidth = 0.3;
    ctx.lineJoin = "round";
    ctx.strokeStyle = ctx.fillStyle;
    ctx.stroke();
  }
}

export function renderCanvas(symbol: QCCodeSymbol, canvas: HTMLCanvasElement | OffscreenCanvas, options: CanvasRenderOptions = {}): void {
  const size = options.size ?? 512;
  const foreground = options.foreground ?? "#000000";
  const background = options.background ?? "#FFFFFF";
  const dataBackground = options.dataBackground ?? "#F1F3F2";
  const levels = options.levels ?? [dataBackground, "#C6CCC8", "#737A76", foreground] as const;
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
  symbol.dataRings.forEach((bits, ring) => drawDataArcBlocks(ctx, bits, inner + ring * pitch + 0.17, inner + (ring + 1) * pitch - 0.17, levels));
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
