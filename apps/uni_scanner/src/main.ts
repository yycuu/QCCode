import {
  decodeReferencePayload,
  QCCodeFlag,
  QCCodeMode,
  toBase64Url,
} from "@qccode/protocol";
import { QCCodeScanner, VisionDecodeError, type QCCodeScanResult } from "@qccode/scanner";
import { MemoryTrustStore, verifyBearerEnvelope, verifyEnvelopeOffline } from "@qccode/security";
import "./style.css";

const root = document.querySelector<HTMLElement>("#app")!;
root.innerHTML = `
  <header>
    <h1>QCCode</h1>
    <p>对准圆环码，自动识别</p>
  </header>
  <section id="frame" class="frame">
    <video id="camera" autoplay playsinline muted></video>
    <span class="corner tl"></span><span class="corner tr"></span>
    <span class="corner bl"></span><span class="corner br"></span>
    <div class="scanline"></div>
  </section>
  <div id="status" class="status busy">正在启动摄像头…</div>
  <section id="result" class="result" hidden>
    <div class="head">
      <span id="badge" class="badge"></span>
      <button id="copy" type="button">复制数据</button>
    </div>
    <pre id="data"></pre>
    <details>
      <summary>查看字段</summary>
      <table id="fields"></table>
    </details>
    <button id="rescan" class="primary" type="button">继续扫描</button>
  </section>`;

const frame = document.querySelector<HTMLElement>("#frame")!;
const video = document.querySelector<HTMLVideoElement>("#camera")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;
const resultEl = document.querySelector<HTMLElement>("#result")!;
const badgeEl = document.querySelector<HTMLElement>("#badge")!;
const dataEl = document.querySelector<HTMLElement>("#data")!;
const fieldsEl = document.querySelector<HTMLElement>("#fields")!;

const trustStore = new MemoryTrustStore();
const scanner = new QCCodeScanner(trustStore);
let cameraActive = false;
let loopHandle = 0;
let scanning = false;
let lastAttempt = 0;
let lastData = "";

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const escapeHtml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const formatTime = (value: bigint | number): string => new Date(Number(value) * 1000).toLocaleString();
const modeLabel = (mode: QCCodeMode): string => QCCodeMode[mode] ?? String(mode);

function flagLabels(flags: number): string[] {
  const labels: string[] = [];
  if (flags & QCCodeFlag.SINGLE_USE) labels.push("SINGLE_USE");
  if (flags & QCCodeFlag.SERVER_RESOLUTION_REQUIRED) labels.push("SERVER_RESOLUTION");
  if (flags & QCCodeFlag.USER_CONFIRMATION_REQUIRED) labels.push("USER_CONFIRMATION");
  if (flags & QCCodeFlag.AUDITABLE) labels.push("AUDITABLE");
  return labels;
}

function challengeFields(payload: Uint8Array): string | null {
  if (payload.length < 18) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return JSON.stringify({ challengeType: view.getUint16(0, false), challengeId: hex(payload.slice(2, 18)), contextHash: hex(payload.slice(18)) });
}

function safeJson(text: string): string | null {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return null; }
}

function setStatus(text: string, kind: "idle" | "ok" | "busy" | "err" = "idle"): void {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof VisionDecodeError) {
    const labels: Record<VisionDecodeError["stage"], string> = {
      detection: "未找到 QCCode",
      orientation: "定位失败，请对准圆环码",
      bootstrap: "引导环解析失败",
      data: "数据校验失败，请靠近一些",
    };
    return labels[error.stage];
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

function showResult(result: QCCodeScanResult): void {
  const { envelopeBytes, layout, mask } = result.decoded;
  const security = result.security;
  const confidence = (result.visual.confidence * 100).toFixed(0);
  setStatus(`已识别 · ${layout} · 置信度 ${confidence}%`, "ok");

  if (security.kind === "bearer") {
    const bearer = security.envelope;
    badgeEl.textContent = "Bearer · 需服务端核销";
    badgeEl.className = "badge warn";
    lastData = JSON.stringify({ resourceType: bearer.resourceType, resourceId: hex(bearer.resourceId), messageType: bearer.messageType });
    dataEl.textContent = lastData;
    fieldsEl.innerHTML = [
      ["模式", modeLabel(bearer.mode)],
      ["标志", flagLabels(bearer.flags).join(", ") || "无"],
      ["Issuer ID", hex(bearer.issuerId)],
      ["Message Type", String(bearer.messageType)],
      ["Message ID", hex(bearer.messageId)],
      ["签发时间", formatTime(bearer.issuedAt)],
      ["过期时间", formatTime(bearer.expiresAt)],
      ["Resource Type", String(bearer.resourceType)],
      ["Resource ID", hex(bearer.resourceId)],
      ["Envelope", toBase64Url(envelopeBytes)],
    ].map(([key, value]) => `<tr><th>${escapeHtml(key!)}</th><td>${escapeHtml(value!)}</td></tr>`).join("");
  } else {
    const signed = security.envelope;
    badgeEl.textContent = security.signatureValid && security.issuerTrusted ? "签名有效" : "签名未验证";
    badgeEl.className = `badge ${security.signatureValid && security.issuerTrusted ? "ok" : "warn"}`;
    if (signed.mode === QCCodeMode.REFERENCE) {
      try {
        const reference = decodeReferencePayload(signed.payload);
        lastData = JSON.stringify({ resourceType: reference.resourceType, resourceId: hex(reference.resourceId) }, null, 2);
      } catch { lastData = hex(signed.payload); }
    } else if (signed.mode === QCCodeMode.CHALLENGE) {
      lastData = challengeFields(signed.payload) ?? hex(signed.payload);
    } else {
      const text = new TextDecoder().decode(signed.payload);
      lastData = safeJson(text) ?? text;
    }
    dataEl.textContent = lastData;
    fieldsEl.innerHTML = [
      ["模式", modeLabel(signed.mode)],
      ["标志", flagLabels(signed.flags).join(", ") || "无"],
      ["Issuer ID", hex(signed.issuerId)],
      ["Key ID", String(signed.keyId)],
      ["Message Type", String(signed.messageType)],
      ["Message ID", hex(signed.messageId)],
      ["签发时间", formatTime(signed.issuedAt)],
      ["过期时间", formatTime(signed.expiresAt)],
      ["Nonce", hex(signed.nonce)],
      ["Payload 长度", `${signed.payload.length} B`],
      ["掩码", String(mask)],
      ["Envelope", toBase64Url(envelopeBytes)],
    ].map(([key, value]) => `<tr><th>${escapeHtml(key!)}</th><td>${escapeHtml(value!)}</td></tr>`).join("");
  }

  frame.classList.add("found");
  resultEl.hidden = false;
  resultEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function cameraLoop(timestamp: number): void {
  if (!cameraActive) return;
  loopHandle = requestAnimationFrame(cameraLoop);
  if (scanning || timestamp - lastAttempt < 200) return;
  lastAttempt = timestamp;
  scanning = true;
  void (async () => {
    try {
      const result = await scanner.scanVideoFrame(video);
      cameraActive = false;
      cancelAnimationFrame(loopHandle);
      showResult(result);
    } catch (error) {
      if (!(error instanceof Error && error.message === "VIDEO_FRAME_UNAVAILABLE")) setStatus(errorMessage(error), "err");
    } finally {
      scanning = false;
    }
  })();
}

async function startCamera(): Promise<void> {
  setStatus("正在启动摄像头…", "busy");
  try {
    await scanner.startCamera(video);
    cameraActive = true;
    lastAttempt = 0;
    loopHandle = requestAnimationFrame(cameraLoop);
  } catch (error) {
    setStatus(`摄像头启动失败：${errorMessage(error)}`, "err");
  }
}

document.querySelector<HTMLButtonElement>("#rescan")!.addEventListener("click", () => {
  resultEl.hidden = true;
  frame.classList.remove("found");
  cameraActive = true;
  lastAttempt = 0;
  loopHandle = requestAnimationFrame(cameraLoop);
});

document.querySelector<HTMLButtonElement>("#copy")!.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(lastData); } catch { /* clipboard unavailable */ }
});

void startCamera();
