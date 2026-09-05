import { encodeQCCode, type LayoutId } from "@qccode/encoder";
import { fromBase64Url, isBearerEnvelope, parseBearerEnvelope, parseEnvelope, toBase64Url } from "@qccode/protocol";
import { renderCanvas } from "@qccode/renderer-canvas";
import { renderSvg } from "@qccode/renderer-svg";
import { QCCodeScanner } from "@qccode/scanner";
import { MemoryTrustStore } from "@qccode/security";
import "./style.css";

const api = "http://localhost:8787";
const root = document.querySelector<HTMLElement>("#app")!;
root.innerHTML = `
  <header><div class="eyebrow">QCCODE / V1</div><h1>Signed data,<br><em>drawn in circles.</em></h1><p>服务端签名，显示端只编码。每一次验证都保留原始 Envelope。</p></header>
  <section class="workspace">
    <form id="issue"><h2>01 / Server Control</h2><label>Mode<select name="mode"><option>REFERENCE</option><option>CHALLENGE</option><option>INLINE</option></select></label><label>Layout<select name="layout"><option value="auto">AUTO</option><option>C1</option><option>C2</option><option>C3</option><option>S1</option></select></label><label>Message Type<input name="messageType" type="number" value="1001"></label><label>Payload<textarea name="payload">{"action":"demo","device":"display-01"}</textarea></label><label>Center Logo URL · optional<input name="logo" value="/qccode-mark.svg"></label><label>上传中心图标<input id="logo-upload" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml"></label><div class="row"><label>Expires in seconds<input name="expiresIn" type="number" value="300"></label><label class="check"><input name="singleUse" type="checkbox" checked> Single use</label></div><button>Issue QCCode</button></form>
    <article class="display"><div class="section-head"><h2>02 / Display Client</h2><span id="socket">CONNECTING</span></div><div id="symbol" class="symbol"><div class="placeholder">Waiting for<br>signed envelope</div></div><div id="meta" class="meta"></div></article>
    <article class="scanner"><h2>03 / Scanner Verification</h2><div class="checks"><div>Visual decode <b id="visual">—</b></div><div>Cryptographic signature <b id="signature">—</b></div><div>Issuer trust <b id="issuer">—</b></div><div>Time validation <b id="time">—</b></div></div><video id="camera" playsinline muted></video><div class="scanner-actions"><button id="camera-start" type="button">Start camera</button><button id="camera-scan" type="button" disabled>Scan frame</button></div><label class="upload">Scan image<input id="image-upload" type="file" accept="image/*"></label><button id="redeem" disabled>Submit original Envelope</button></article>
    <article class="result"><h2>04 / Result</h2><strong id="result">NO RESULT</strong><pre id="details"></pre></article>
  </section>`;

let currentEnvelope = "";
let currentLayout: "auto" | LayoutId = "auto";
let currentLogo = "/qccode-mark.svg";
let scannerPromise: Promise<QCCodeScanner> | undefined;

function getScanner(): Promise<QCCodeScanner> {
  scannerPromise ??= fetch(`${api}/qccode/v1/keys`).then(async (response) => {
    const body = await response.json();
    const issuerId = fromBase64Url(body.issuerId);
    const records = body.keys.map((key: { kid: number; publicKey: string; status: "CURRENT" | "PREVIOUS" | "REVOKED"; notBefore: number; notAfter: number }) => ({
      issuerId,
      keyId: key.kid,
      publicKey: fromBase64Url(key.publicKey),
      status: key.status,
      notBefore: BigInt(key.notBefore),
      notAfter: BigInt(key.notAfter),
    }));
    return new QCCodeScanner(new MemoryTrustStore(records));
  });
  return scannerPromise;
}

async function showScan(scan: Awaited<ReturnType<QCCodeScanner["scanCanvas"]>>): Promise<void> {
  currentEnvelope = toBase64Url(scan.decoded.envelopeBytes);
  document.querySelector("#visual")!.textContent = `PASS ${(scan.visual.confidence * 100).toFixed(0)}%`;
  if (scan.security.kind === "bearer") {
    document.querySelector("#signature")!.textContent = "SERVER";
    document.querySelector("#issuer")!.textContent = "SERVER";
    document.querySelector("#time")!.textContent = scan.security.expired ? "EXPIRED" : scan.security.notYetValid ? "NOT YET VALID" : "PASS";
    (document.querySelector("#redeem") as HTMLButtonElement).disabled = scan.security.expired || scan.security.notYetValid;
  } else {
    document.querySelector("#signature")!.textContent = scan.security.signatureValid ? "VALID" : "INVALID";
    document.querySelector("#issuer")!.textContent = scan.security.issuerTrusted ? "TRUSTED" : "UNKNOWN";
    document.querySelector("#time")!.textContent = scan.security.expired ? "EXPIRED" : scan.security.notYetValid ? "NOT YET VALID" : "PASS";
    (document.querySelector("#redeem") as HTMLButtonElement).disabled = !scan.security.signatureValid;
  }
}

async function display(envelopeBase64Url: string, force = false): Promise<void> {
  if (!force && currentEnvelope === envelopeBase64Url) return;
  currentEnvelope = envelopeBase64Url;
  const bytes = fromBase64Url(envelopeBase64Url);
  const envelope = isBearerEnvelope(bytes) ? parseBearerEnvelope(bytes) : parseEnvelope(bytes);
  const symbol = encodeQCCode(bytes, { layout: currentLayout });
  document.querySelector("#symbol")!.innerHTML = renderSvg(symbol, { size: 560, title: "QCCode", center: currentLogo ? { mode: "logo", imageHref: currentLogo, scale: 0.72 } : { mode: "none" } });
  document.querySelector("#meta")!.textContent = `${symbol.layout.id} · ${symbol.layout.ringSlots.length} rings · mask ${symbol.mask} · ${bytes.length} envelope bytes · expires ${new Date(Number(envelope.expiresAt) * 1000).toLocaleTimeString()}`;
  document.querySelector("#visual")!.textContent = "SCANNING";
  const canvas = document.createElement("canvas");
  renderCanvas(symbol, canvas, { size: 768 });
  try {
    await showScan(await (await getScanner()).scanCanvas(canvas));
  } catch (error) {
    document.querySelector("#visual")!.textContent = "FAILED";
    throw error;
  }
}

document.querySelector("#issue")!.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(event.target as HTMLFormElement);
  currentLayout = String(data.get("layout")) as "auto" | LayoutId;
  currentLogo = String(data.get("logo") ?? "").trim();
  const payloadText = String(data.get("payload"));
  let payload: unknown = payloadText;
  try { payload = JSON.parse(payloadText); } catch { /* text payload */ }
  const response = await fetch(`${api}/qccode/v1/issue`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: data.get("mode"), layout: data.get("layout"), messageType: Number(data.get("messageType")), expiresIn: Number(data.get("expiresIn")), singleUse: data.get("singleUse") === "on", payload }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  await display(body.envelopeBase64Url, true);
});

document.querySelector("#redeem")!.addEventListener("click", async () => {
  const response = await fetch(`${api}/qccode/v1/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ envelope: currentEnvelope }) });
  const body = await response.json();
  document.querySelector("#result")!.textContent = body.status;
  document.querySelector("#result")!.className = body.status === "ACCEPTED" ? "accepted" : "rejected";
  document.querySelector("#details")!.textContent = JSON.stringify(body.result ?? body, null, 2);
});

const socket = new WebSocket("ws://localhost:8787/qccode/v1/ws");
socket.addEventListener("open", () => { document.querySelector("#socket")!.textContent = "LIVE"; });
socket.addEventListener("message", (event) => { const message = JSON.parse(String(event.data)); if (message.type === "qccode.envelope") void display(message.envelope); });
socket.addEventListener("close", () => { document.querySelector("#socket")!.textContent = "OFFLINE"; });

const camera = document.querySelector<HTMLVideoElement>("#camera")!;
document.querySelector("#camera-start")!.addEventListener("click", async () => {
  await (await getScanner()).startCamera(camera);
  camera.classList.add("active");
  (document.querySelector("#camera-scan") as HTMLButtonElement).disabled = false;
});
document.querySelector("#camera-scan")!.addEventListener("click", async () => showScan(await (await getScanner()).scanVideoFrame(camera)));
document.querySelector<HTMLInputElement>("#image-upload")!.addEventListener("change", async (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  await showScan(await (await getScanner()).scanCanvas(canvas));
});

const logoInput = document.querySelector<HTMLInputElement>('input[name="logo"]')!;
logoInput.addEventListener("change", () => {
  currentLogo = logoInput.value.trim();
  if (currentEnvelope) void display(currentEnvelope, true);
});
document.querySelector<HTMLInputElement>("#logo-upload")!.addEventListener("change", async (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    currentLogo = String(reader.result);
    logoInput.value = currentLogo;
    if (currentEnvelope) void display(currentEnvelope, true);
  });
  reader.readAsDataURL(file);
});

document.querySelector<HTMLSelectElement>('select[name="layout"]')!.addEventListener("change", async (event) => {
  const selected = (event.target as HTMLSelectElement).value as "auto" | LayoutId;
  const previous = currentLayout;
  currentLayout = selected;
  if (!currentEnvelope) return;
  try { await display(currentEnvelope, true); }
  catch (error) {
    currentLayout = previous;
    document.querySelector("#details")!.textContent = error instanceof Error ? error.message : String(error);
  }
});
