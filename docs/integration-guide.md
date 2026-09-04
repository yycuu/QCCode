# QCCode V1 完整集成指南

本文面向需要签发、显示、扫描和兑换 QCCode 的前端、后端及移动 Web 团队。内容对应当前仓库实现，不以早期设计草案中的示例 API 为准。

生产部署请优先阅读[生产环境完整集成指南](./production-integration.md)。服务端只需安装 `@qccode/server-sdk`，客户端只需安装 `@qccode/sdk`。

## 阅读路线

- 首次评估：阅读[系统边界](#1-系统边界)、[模式选择](#3-模式选择)、[容量](#4-容量)和[当前视觉识别边界](#25-当前视觉识别边界)。
- 服务端接入：阅读[服务端密钥](#5-服务端密钥)、[Server SDK](#6-使用-server-sdk-签发)、[HTTP API](#7-http-api)、[Replay Store](#17-replay-store)和[Key Rotation](#19-key-rotation)。
- 显示端接入：阅读[WebSocket](#8-websocket-display-client)、[SVG](#9-svg-显示集成)和[Canvas](#10-canvas-显示集成)。
- 扫描端接入：阅读[Trust Store](#11-scanner-trust-store)、[图片扫描](#12-扫描图片和-canvas)、[Camera](#13-camera-集成)、[离线验签](#14-offline-verification)和[原始 Envelope 提交](#16-提交原始-envelope)。
- 上线验收：阅读[部署](#23-部署)、[测试](#24-golden-vector-与测试)、[端到端顺序](#26-最小端到端接入顺序)和[验收清单](#27-集成验收清单)。

## 1. 系统边界

QCCode 的标准数据流是：

```text
Server
  → canonical binary envelope
  → Ed25519 signature
  → signed envelope bytes
  → HTTPS / WebSocket
Display Client
  → visual encoding only
  → SVG / Canvas QCCode
Scanner Client
  → visual decode
  → RS + CRC
  → envelope parse
  → offline Ed25519 verification
  → submit original envelope
Server
  → repeat every verification
  → replay/revocation/application policy
  → authoritative result
```

必须遵守以下边界：

- Ed25519 私钥只存在于服务端。
- Display Client 只接收完整的 Signed Envelope，不在客户端重新签名。
- Scanner 必须保留视觉解码得到的原始 Envelope bytes。
- Scanner 提交服务端时发送原始 Envelope，不能只发送解析后的 `messageId` 或 `valid`。
- 扫描内容属于不可信输入。不要 `eval`、写入 `innerHTML`、自动打开 URL 或自动执行敏感操作。
- 签名防止伪造和篡改，但无法阻止截图复制。一次性行为由短有效期与服务端原子兑换实现。

## 2. 仓库与包

当前项目是 pnpm TypeScript monorepo。`@qccode/*` 0.1.0 已发布到公共 npm registry；仓库中的生产集成接口版本为 0.2.0。仓库内部通过 `workspace:*` 引用。

| 包 | 用途 |
|---|---|
| `@qccode/protocol` | Envelope 类型、二进制编解码、Payload helper、Base64URL |
| `@qccode/security` | Ed25519、Trust Store、离线验证 |
| `@qccode/core` | CRC-32C、RS(255,191)、bit、mask |
| `@qccode/geometry` | C1/C2/C3、Orientation、Bootstrap、Slot 坐标 |
| `@qccode/encoder` | Envelope 到 `QCCodeSymbol` |
| `@qccode/decoder` | 理想 Symbol 和带 erasure Symbol 解码 |
| `@qccode/renderer-svg` | SVG 输出、主题和中心 Logo |
| `@qccode/renderer-canvas` | Canvas/OffscreenCanvas 输出 |
| `@qccode/vision` | ImageData 候选检测、极坐标采样、四级亮度分类 |
| `@qccode/scanner` | 图片、Canvas、Video、Camera 扫描与离线验证 |
| `@qccode/sdk` | 浏览器常用 API 汇总出口 |
| `@qccode/server-sdk` | 签发、资源解析、撤销、Replay Store |

仓库内安装和验证：

```bash
pnpm install
pnpm build
pnpm test
```

启动参考服务器和 Demo，需要两个终端：

```bash
# terminal 1
pnpm server

# terminal 2
pnpm dev
```

默认地址：

```text
Demo:             http://127.0.0.1:5173
Reference Server: http://localhost:8787
```

从 npm 集成时，业务服务只安装 `@qccode/server-sdk`，浏览器应用只安装 `@qccode/sdk`。不要从 `src/` 深层路径导入内部实现。

## 3. 模式选择

### 3.1 REFERENCE

REFERENCE 是默认推荐模式。码内只保存：

```text
resourceType: uint16
resourceId:   16-byte opaque random ID
```

适合登录入口、业务对象、领取链接、活动配置、设备记录以及任何可能敏感或需要撤销的数据。实际业务内容留在服务器。

优点：

- C1 容量足够，视觉密度最低。
- 服务器可以撤销、更新内容、限制次数和记录扫码。
- 不会把敏感业务数据直接暴露在图片中。

需要更简洁、更易扫的视觉时，REFERENCE 还可以使用稀疏布局 S1：数据环改为和定位环一样的粗圆头短弧，码内只放 48 字节 Bearer Envelope（12 字节随机 resourceId，无签名）。S1 依赖 96 位随机 ID 和服务端原子一次性核销，不支持离线验签；V1 签名布局保持不变。服务端通过 `QCCodeServer.issueBearer` / `redeemBearer` 签发与核销。

### 3.2 CHALLENGE

CHALLENGE 用于登录、配对、授权和确认操作。Payload 固定为：

```text
challengeType: uint16
challengeId:   16 bytes
contextHash:   32-byte SHA-256
```

CHALLENGE 自动强制：

- `singleUse`
- `serverResolutionRequired`
- `userConfirmationRequired`

CHALLENGE 应使用短有效期，通常 30–300 秒。不要把密码、session secret 或加密密钥放进 Payload。

### 3.3 INLINE

INLINE 保存任意 `Uint8Array`，适合公开且很小的数据。离线扫描可以读取并验签，但无法离线判断服务器是否已经撤销该码。

C1 最多容纳 34-byte 通用 INLINE Payload。更大的内容会自动进入 C2/C3，超过 C3 时 Encoder 会要求改用 REFERENCE。

## 4. 容量

当前视觉 Slot 使用四级有序亮度，每个 Slot 保存 2 bit。

| Layout | Data Rings | Slots | Raw bytes | 最大 Envelope | 最大通用 Payload |
|---|---:|---:|---:|---:|---:|
| C1 | 6 | 1,020 × 2 bit | 255 | 179 | 34 bytes |
| C2 | 9 | 2,040 × 2 bit | 510 | 370 | 225 bytes |
| C3 | 12 | 3,060 × 2 bit | 765 | 561 | 416 bytes |

常见结果：

```text
REFERENCE 18-byte payload → 163-byte Envelope → C1
INLINE 32-byte payload    → 177-byte Envelope → C1
CHALLENGE 50-byte payload → 195-byte Envelope → C2
```

使用 `version: "auto"` 让 Encoder 选择最小 Layout。

## 5. 服务端密钥

### 5.1 生成开发密钥

`generateEd25519KeyPair()` 返回 PKCS#8 DER 私钥和 32-byte raw public key：

```ts
import { writeFile } from "node:fs/promises";
import { generateEd25519KeyPair } from "@qccode/security";
import { toBase64Url } from "@qccode/protocol";

const pair = await generateEd25519KeyPair();

await writeFile("private-keys/qccode.pk8", pair.privateKeyPkcs8, {
  mode: 0o600,
});

console.log("QCCODE_PUBLIC_KEY_BASE64URL=", toBase64Url(pair.publicKey));
console.log(
  "QCCODE_ISSUER_ID=",
  toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
);
```

仓库已忽略 `.env`、`*.pem`、`*.key` 和 `private-keys/`。仍应确认部署系统不会把私钥打进镜像公开层、前端 bundle 或日志。

### 5.2 参考服务器环境变量

```text
QCCODE_PRIVATE_KEY_FILE       PKCS#8 DER 文件路径
QCCODE_PUBLIC_KEY_BASE64URL   对应的 32-byte raw public key
QCCODE_ISSUER_ID              16-byte Base64URL issuer ID
QCCODE_KEY_ID                 uint32 十进制 key ID
PORT                              默认 8787
```

示例：

```bash
export QCCODE_PRIVATE_KEY_FILE=/run/secrets/qccode.pk8
export QCCODE_PUBLIC_KEY_BASE64URL='...'
export QCCODE_ISSUER_ID='...'
export QCCODE_KEY_ID=27
export PORT=8787
pnpm server
```

如果没有配置密钥，参考服务器会生成临时 Ed25519 身份。服务重启后旧码无法再由新的临时公钥验证，因此临时身份只能用于本地演示。

生产环境建议使用 KMS/HSM 或受保护的 secret volume。若 KMS 不直接支持 Ed25519，应在受控签名服务中完成签名，Display Client 仍不能接触私钥。

## 6. 使用 Server SDK 签发

### 6.1 初始化

```ts
import { readFile } from "node:fs/promises";
import { QCCodeServer, fromBase64Url } from "@qccode/server-sdk";

const now = BigInt(Math.floor(Date.now() / 1000));

const qcCode = new QCCodeServer({
  issuerId: fromBase64Url(process.env.QCCODE_ISSUER_ID!),
  keyId: Number(process.env.QCCODE_KEY_ID),
  privateKeyPkcs8: new Uint8Array(
    await readFile(process.env.QCCODE_PRIVATE_KEY_FILE!),
  ),
  publicKey: fromBase64Url(process.env.QCCODE_PUBLIC_KEY_BASE64URL!),
  keyNotBefore: now - 60n,
  keyNotAfter: now + 31_536_000n,
});
```

### 6.2 REFERENCE

```ts
import {
  QCCodeMode,
  encodeReferencePayload,
} from "@qccode/server-sdk";

const resourceId = crypto.getRandomValues(new Uint8Array(16));

await qcCode.putResource(7, resourceId, {
  action: "open-device",
  deviceId: "display-01",
});

const issued = await qcCode.issue({
  mode: QCCodeMode.REFERENCE,
  messageType: 1001,
  payload: encodeReferencePayload(7, resourceId),
  expiresIn: 300,
  singleUse: true,
  requireConfirmation: true,
});

console.log(issued.envelopeBase64Url);
```

`resourceId` 必须由 CSPRNG 生成。不要使用数据库自增 ID。

### 6.3 CHALLENGE

```ts
import {
  QCCodeMode,
  encodeChallengePayload,
} from "@qccode/server-sdk";

const challengeId = crypto.getRandomValues(new Uint8Array(16));
const context = new TextEncoder().encode(
  JSON.stringify({ action: "login", displayId: "display-01" }),
);
const contextHash = new Uint8Array(
  await crypto.subtle.digest("SHA-256", context),
);

const issued = await qcCode.issue({
  mode: QCCodeMode.CHALLENGE,
  messageType: 2001,
  payload: encodeChallengePayload(1, challengeId, contextHash),
  expiresIn: 90,
});
```

即使调用方没有传 `singleUse`，Server SDK 也会对 CHALLENGE 强制设置。

### 6.4 INLINE

```ts
import { QCCodeMode } from "@qccode/server-sdk";

const issued = await qcCode.issue({
  mode: QCCodeMode.INLINE,
  messageType: 3001,
  payload: new TextEncoder().encode("public-device-label"),
  expiresIn: 3600,
  requireConfirmation: false,
});
```

`expiresIn` 当前允许 1–86,400 秒。应用层可以设置更严格上限。

## 7. HTTP API

参考服务器需要由调用方在生产环境外加认证、授权、限流和审计。

### 7.1 `POST /qccode/v1/issue`

REFERENCE 请求：

```http
POST /qccode/v1/issue
Content-Type: application/json

{
  "mode": "REFERENCE",
  "messageType": 1001,
  "resourceType": 7,
  "payload": {
    "action": "open-device",
    "deviceId": "display-01"
  },
  "expiresIn": 300,
  "singleUse": true,
  "requireConfirmation": true
}
```

参考服务器会生成随机 Resource ID，并把请求中的 `payload` 注册为演示资源。

CHALLENGE 请求：

```json
{
  "mode": "CHALLENGE",
  "messageType": 2001,
  "challengeType": 1,
  "payload": {
    "action": "login",
    "displayId": "display-01"
  },
  "expiresIn": 90
}
```

INLINE 请求：

```json
{
  "mode": "INLINE",
  "messageType": 3001,
  "payload": "public label",
  "expiresIn": 3600
}
```

成功响应：

```json
{
  "envelopeBase64Url": "..."
}
```

Display Client 必须原样使用 `envelopeBase64Url`，不能解析后重建 Envelope。

### 7.2 `GET /qccode/v1/keys`

响应：

```json
{
  "issuerId": "16-byte-base64url",
  "keys": [
    {
      "kid": 27,
      "algorithm": "Ed25519",
      "publicKey": "32-byte-base64url",
      "status": "CURRENT",
      "notBefore": 1788000000,
      "notAfter": 1819536000
    }
  ]
}
```

通过 HTTPS 下载 key set 并不自动表示信任该 issuer。应用必须通过预置 issuer、固定公钥根、MDM 配置或其他可信引导决定哪些 issuer 可以加入 Trust Store。

### 7.3 `POST /qccode/v1/redeem`

```http
POST /qccode/v1/redeem
Content-Type: application/json

{
  "envelope": "original-envelope-base64url"
}
```

成功：

```json
{
  "status": "ACCEPTED",
  "result": {
    "action": "open-device",
    "deviceId": "display-01"
  }
}
```

失败状态包括：

```text
REPLAYED
EXPIRED
REVOKED
INVALID
SERVER_REJECTED
```

当前参考服务器对非 ACCEPTED 返回 HTTP 400。接入端应同时检查 HTTP status 和 JSON `status`。

### 7.4 `POST /qccode/v1/resolve`

请求格式与 redeem 相同。当前参考实现复用同一验证和处理路径。生产系统通常会让 REFERENCE resolve 与敏感 CHALLENGE redeem 使用不同权限、审计及业务 handler。

### 7.5 `GET /health`

参考服务器返回：

```json
{
  "ok": true
}
```

该 endpoint 只表示 HTTP 进程存活，不验证密钥文件、持久化 Replay Store、时钟同步或下游业务依赖。生产部署应提供独立的 readiness 检查，并限制跨域来源；参考服务器当前启用了宽松 CORS，仅适合本地开发。

## 8. WebSocket Display Client

连接：

```text
ws://localhost:8787/qccode/v1/ws
```

生产环境必须使用 `wss://`。

服务端签发后推送：

```json
{
  "type": "qccode.envelope",
  "sequence": 1788517492000,
  "envelope": "base64url"
}
```

Display Client：

```ts
const socket = new WebSocket("wss://issuer.example/qccode/v1/ws");

socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.type !== "qccode.envelope") return;
  displayEnvelope(message.envelope);
});
```

动态码必须由服务器周期性重新签发。客户端不能修改 `issuedAt`、`expiresAt`、`messageId` 或 `nonce`。

## 9. SVG 显示集成

```ts
import {
  encodeQCCode,
  fromBase64Url,
  renderSvg,
} from "@qccode/sdk";

function displayEnvelope(envelopeBase64Url: string): void {
  const envelopeBytes = fromBase64Url(envelopeBase64Url);
  const symbol = encodeQCCode(envelopeBytes, { version: "auto" });

  const svg = renderSvg(symbol, {
    size: 560,
    foreground: "#000000",
    background: "#FFFFFF",
    dataBackground: "#F1F3F2",
    title: "Signed QCCode",
    center: { mode: "none" },
  });

  document.querySelector("#qccode")!.innerHTML = svg;
}
```

这里的 `innerHTML` 只写入由本地 Renderer 生成的 SVG。不要把扫码 Payload 或服务器返回的任意 HTML 传入它。

### 9.1 Center Logo

无 Logo：

```ts
renderSvg(symbol, {
  center: { mode: "none" },
});
```

有 Logo：

```ts
renderSvg(symbol, {
  center: {
    mode: "logo",
    imageHref: "/assets/company-mark.svg",
    scale: 0.72,
  },
});
```

`scale` 最大会限制为 0.82。Logo 不保存数据，不参与定位，也不能覆盖最内层数据环。远程 Logo URL 需要考虑 CSP、缓存、隐私和跨域策略；生产显示建议使用同源静态资源或经过审核的 data URL。

### 9.2 四级主题

默认等级：

```text
00 #F1F3F2  淡灰背景/空 Slot
01 #C6CCC8  浅灰
10 #737A76  深灰
11 #000000  深色
```

自定义：

```ts
renderSvg(symbol, {
  dataBackground: "#F4F2EE",
  levels: ["#F4F2EE", "#B0A98E", "#6D654B", "#17150F"],
});
```

四个颜色必须按 relative luminance 从亮到暗严格排列，相邻等级差至少 0.06。Renderer 会检查可解析的六位 Hex 色值。打印和相机环境应在真实材料上重新验证色阶。

## 10. Canvas 显示集成

```ts
import {
  encodeQCCode,
  fromBase64Url,
  renderCanvas,
} from "@qccode/sdk";

const canvas = document.querySelector<HTMLCanvasElement>("#qccode-canvas")!;
const symbol = encodeQCCode(fromBase64Url(envelopeBase64Url));

renderCanvas(symbol, canvas, {
  size: 768,
  foreground: "#000000",
  background: "#FFFFFF",
  dataBackground: "#F1F3F2",
  center: { mode: "none" },
});
```

Canvas Logo 使用已经加载的 `CanvasImageSource`：

```ts
const image = new Image();
image.src = "/assets/company-mark.svg";
await image.decode();

renderCanvas(symbol, canvas, {
  size: 768,
  center: {
    mode: "logo",
    image,
    scale: 0.72,
  },
});
```

Renderer 会把 Logo 裁剪到中心圆形安全区。Canvas 用于相机扫描时建议至少 512×512；C2/C3 或远距离显示建议 768×768 以上。

## 11. Scanner Trust Store

内置公钥：

```ts
import {
  MemoryTrustStore,
  fromBase64Url,
} from "@qccode/sdk";

const trustStore = new MemoryTrustStore([
  {
    issuerId: fromBase64Url(APPROVED_ISSUER_ID),
    keyId: 27,
    publicKey: fromBase64Url(APPROVED_PUBLIC_KEY),
    status: "CURRENT",
    notBefore: 1788000000n,
    notAfter: 1819536000n,
  },
]);
```

从已受信 endpoint 更新：

```ts
const response = await fetch("https://issuer.example/qccode/v1/keys");
const body = await response.json();
const issuerId = fromBase64Url(body.issuerId);

assertIssuerIsAlreadyApproved(issuerId);

for (const key of body.keys) {
  trustStore.add({
    issuerId,
    keyId: key.kid,
    publicKey: fromBase64Url(key.publicKey),
    status: key.status,
    notBefore: BigInt(key.notBefore),
    notAfter: BigInt(key.notAfter),
  });
}
```

持久化 Trust Store 时，应保存 issuer、kid、public key、状态和有效期，并保护更新通道免受降级和替换攻击。

## 12. 扫描图片和 Canvas

```ts
import { QCCodeScanner } from "@qccode/sdk";

const scanner = new QCCodeScanner(trustStore);
const result = await scanner.scanCanvas(canvas);

console.log(result.visual.confidence);
console.log(result.visual.rotation);
console.log(result.visual.mirrored);
console.log(result.visual.unknownPhysicalSlots.length);

console.log(result.decoded.layout);
console.log(result.decoded.correctedErrors);
console.log(result.decoded.erasures);

console.log(result.security.signatureValid);
console.log(result.security.issuerTrusted);
console.log(result.security.expired);
```

从上传图片扫描：

```ts
const file = fileInput.files?.[0];
if (!file) return;

const bitmap = await createImageBitmap(file);
const canvas = document.createElement("canvas");
canvas.width = bitmap.width;
canvas.height = bitmap.height;
canvas.getContext("2d")!.drawImage(bitmap, 0, 0);

const result = await scanner.scanCanvas(canvas);
```

低置信度四级 Slot 会变成 erasure，再映射到对应的 RS symbol。RS 支持 unknown errors 与 erasures，边界为：

```text
2 × errors + erasures ≤ 64 per RS block
```

## 13. Camera 集成

HTML：

```html
<video id="camera" playsinline muted></video>
<button id="start-camera">Start camera</button>
<button id="scan-frame">Scan</button>
```

TypeScript：

```ts
const video = document.querySelector<HTMLVideoElement>("#camera")!;

document.querySelector("#start-camera")!.addEventListener("click", async () => {
  await scanner.startCamera(video);
});

document.querySelector("#scan-frame")!.addEventListener("click", async () => {
  try {
    const result = await scanner.scanVideoFrame(video);
    showVerification(result);
  } catch (error) {
    showScanError(error);
  }
});

window.addEventListener("pagehide", () => scanner.stopCamera());
```

`startCamera()` 请求：

```ts
navigator.mediaDevices.getUserMedia({
  video: { facingMode: { ideal: "environment" } },
  audio: false,
});
```

浏览器摄像头通常要求 HTTPS 或 localhost。应在页面隐藏、路由离开或扫描完成后调用 `stopCamera()`。

实时循环不需要每帧完整解码。建议：

- Camera 预览保持流畅。
- 每 150–300ms 尝试一次完整解码。
- 连续失败时复用 ROI 或降低输入尺寸。
- 成功后暂停扫描，显示独立的视觉、签名、信任、时间状态。
- 用户确认后才向服务器提交。

## 14. Offline Verification

如果视觉层之外已经取得 Envelope bytes，可以直接验签：

```ts
import { verifyEnvelopeOffline } from "@qccode/security";

const verification = await verifyEnvelopeOffline(
  envelopeBytes,
  trustStore,
  {
    now: BigInt(Math.floor(Date.now() / 1000)),
    clockSkewSeconds: 120n,
  },
);
```

结果字段：

```ts
type OfflineVerificationResult = {
  envelope: EnvelopeV1;
  signatureValid: boolean;
  issuerTrusted: boolean;
  keyStatus: "CURRENT" | "PREVIOUS" | "REVOKED" | "UNKNOWN";
  expired: boolean;
  notYetValid: boolean;
  offlineVerified: boolean;
  error?:
    | "UNKNOWN_ISSUER_OR_KEY"
    | "KEY_REVOKED"
    | "KEY_OUTSIDE_VALIDITY"
    | "SIGNATURE_INVALID"
    | "EXPIRED"
    | "NOT_YET_VALID";
};
```

`offlineVerified=true` 表示签名已经在本地验证，不表示服务器仍会接受。服务器可能返回 REPLAYED、REVOKED 或业务拒绝。

## 15. Scanner UI

推荐分别显示：

```text
Visual decode             PASS / FAILED
Error correction          corrected errors / erasures
Cryptographic signature   VALID / INVALID
Issuer trust              TRUSTED / UNKNOWN / REVOKED
Time validation           PASS / EXPIRED / NOT YET VALID
Server status             ACCEPTED / REPLAYED / REVOKED / ...
```

不要把所有状态合并成一个模糊的 “Valid”。签名有效和业务可用是不同结论。

涉及登录、付款、配对、授权等操作时，确认页面应显示发行者名称、操作类型、目标设备/账户和过期时间。不要自动兑换。

## 16. 提交原始 Envelope

```ts
import {
  toBase64Url,
  type QCCodeScanResult,
} from "@qccode/sdk";

async function submit(result: QCCodeScanResult) {
  if (!result.security.signatureValid || !result.security.issuerTrusted) {
    throw new Error("QCCode is not locally trusted");
  }

  const response = await fetch("https://issuer.example/qccode/v1/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      envelope: toBase64Url(result.decoded.envelopeBytes),
    }),
  });

  const body = await response.json();
  showServerStatus(body.status, body.result);
}
```

不要发送以下结构作为授权依据：

```json
{
  "messageId": "...",
  "payload": "...",
  "valid": true
}
```

这些字段都可能由恶意客户端伪造。

## 17. Replay Store

`MemoryQCCodeStorage` 和兼容用的 `MemoryReplayStore` 只适合单进程 Demo。生产环境应实现事务型 `QCCodeStorage`，让资源读取、撤销检查、一次性 claim 和业务操作共享事务；完整适配器见[生产环境指南](./production-integration.md)。

生产表结构示例：

```sql
CREATE TABLE qccode_redemptions (
  issuer_id  BYTEA       NOT NULL,
  message_id BYTEA       NOT NULL,
  nonce      BYTEA       NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  state      TEXT        NOT NULL,
  result     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer_id, message_id),
  UNIQUE (issuer_id, nonce)
);
```

事务流程：

```text
BEGIN
  → verify signature and authoritative server time
  → INSERT redemption row
     ON CONFLICT → REPLAYED
  → apply business state change or insert durable outbox row
  → mark redemption complete
COMMIT
```

不要实现为：

```text
SELECT/GET
→ if absent
→ perform business operation
→ INSERT/SET used
```

这会产生竞态条件。

Redis 可以用 `SET key value NX EX ttl` 或 Lua script 原子占位，但占位与业务操作之间仍可能遇到进程崩溃。业务操作必须使用相同 message ID 作为 idempotency key，或使用可恢复的 durable workflow/outbox。

## 18. 撤销

Server SDK Demo：

```ts
const envelope = qcCode.parse(envelopeBase64Url);
qcCode.revoke(envelope.messageId);
```

签名有效的码仍可能被服务器撤销。生产系统应持久化以下业务状态：

```text
ACTIVE
REDEEMED
REVOKED
EXPIRED
```

撤销状态不属于离线签名，Scanner 离线时无法得知。

## 19. Key Rotation

推荐 key set：

```text
kid 28  CURRENT   用于所有新签发
kid 27  PREVIOUS  仅验证有效期内旧码
kid 26  REVOKED   始终拒绝
```

轮换步骤：

1. 生成新 key pair 和新 kid。
2. 先把新公钥发布到 key endpoint。
3. 等待 Scanner 获取并缓存新 key。
4. 把新 key 切换为 CURRENT，旧 key 变成 PREVIOUS。
5. 保留旧公钥直到所有合法旧码过期。
6. 私钥疑似泄露时立即标记 REVOKED，并由在线服务器拒绝。

不要重复使用 kid 指向不同公钥。新签发永远使用 CURRENT key。

## 20. 错误处理

协议/视觉层可能抛出：

```text
VISUAL_CANDIDATE_NOT_FOUND
ORIENTATION_AMBIGUOUS
BOOTSTRAP_INVALID
BOOTSTRAP_AMBIGUOUS
VISUAL_DECODE_FAILED
ECC_FAILED
CRC_FAILED
PROTOCOL_INVALID
UNSUPPORTED_VERSION
UNSUPPORTED_FLAGS
UNKNOWN_ISSUER
UNKNOWN_KEY
KEY_REVOKED
SIGNATURE_INVALID
NOT_YET_VALID
EXPIRED
REPLAYED
REVOKED
SERVER_REJECTED
```

当前部分内部错误以 `Error.message` 表达；`QCCodeProtocolError` 提供结构化 `code`。应用集成层应把底层异常映射到稳定的产品错误枚举，不要把内部 stack trace 返回给终端用户。

建议重试策略：

| 错误 | 建议 |
|---|---|
| Candidate/Orientation/Bootstrap | 调整距离、角度和光线后继续扫描 |
| ECC/CRC | 重新取帧，不提交服务器 |
| Unknown issuer/key | 仅从已受信渠道刷新 key set |
| Signature invalid | 立即拒绝 |
| Not yet valid | 检查本地时钟；服务器仍需判断 |
| Expired | 请求显示端获取新码 |
| Replayed | 显示已经使用，禁止自动重试操作 |
| Server rejected | 展示服务器给出的安全业务结果 |

## 21. Browser 兼容性

安全包使用 Web Crypto Ed25519：

```ts
crypto.subtle.importKey(..., { name: "Ed25519" }, ...)
```

部署前必须对目标浏览器矩阵测试 Ed25519、`BigInt`、`ImageData`、Canvas、`createImageBitmap` 和 Camera API。若旧浏览器不支持 Ed25519，只能引入经过审查的成熟密码学库 fallback，不能自行实现 Ed25519 数学。

Camera 需要安全上下文。iOS WebView、企业内嵌浏览器和权限受限环境应单独验证。

## 22. CSP 与前端安全

建议 CSP 起点：

```text
default-src 'self';
script-src 'self';
style-src 'self';
img-src 'self' data:;
connect-src 'self' https://issuer.example wss://issuer.example;
media-src 'self' blob:;
object-src 'none';
base-uri 'none';
frame-ancestors 'none';
```

如果 Logo 来自远程地址，需要把精确域名加入 `img-src`。不要使用任意用户 URL 通配符。

## 23. 部署

生产部署至少需要：

- HTTPS/WSS。
- Issue endpoint 的认证与授权。
- Issue 速率限制和 message type allowlist。
- 持久化资源、撤销和 Replay Store。
- 稳定 issuer ID 和可轮换 key ID。
- 私钥 secret management。
- Key endpoint 缓存策略和可信引导。
- 多实例共享 replay state。
- 服务器权威 UTC 时间和时钟监控。
- 审计日志中避免记录完整敏感 Payload。
- 对 Envelope 请求体设置大小上限。
- 对不同模式设置最大 TTL。

参考服务器当前把资源和 replay state 存在内存中，不应直接用于多实例生产部署。

## 24. Golden Vector 与测试

生成向量：

```bash
pnpm build
pnpm vectors
```

目录：

```text
tests/vectors/v1/
  inline-hello/
  reference-token/
  challenge-login/
  expired/
  invalid-signature/
  modified-payload/
  wrong-issuer/
  wrong-kid/
  replay/
```

每个向量包含：

```text
fields.json
canonical-signed-bytes.hex
signature.hex
envelope.hex
envelope.base64url.txt
visual-frame-before-padding.hex
rs-source.hex
rs-codewords.hex
bootstrap-bits.txt
expected-ring-slots.txt
expected.json
```

运行全部测试：

```bash
pnpm test
```

当前测试覆盖：

- CRC-32C 标准检查值。
- RS 32 个 unknown errors。
- RS 64 个 erasures。
- `2e+s=64` 混合边界。
- Ed25519 签名与所有安全字段篡改。
- 过期、尾随数据和严格解析。
- C1/C2/C3 理想视觉往返。
- Bootstrap 与全部 Orientation rotations。
- 20 个并发兑换只能成功一次。
- 9 组已提交 Golden Vector 重现。

## 25. 当前视觉识别边界

当前 `@qccode/vision` 是可运行的浏览器基线，已支持：

- `ImageData`、Canvas、Video frame。
- 环形候选边界。
- 轴对齐椭圆归一化。
- 任意码面旋转搜索。
- 镜像方向。
- Orientation 与 Bootstrap。
- 四级亮度聚类。
- 低置信度 Slot 到 RS erasure。

它尚不是完整的生产级计算机视觉管线。复杂旋转椭圆拟合、强透视、局部反光、移动模糊、屏幕摩尔纹、弯曲打印介质、多候选 ROI 和持续目标跟踪需要继续扩展，并用真实设备数据验证。

生产上线前至少建立这些数据集：

```text
rotation 0–359°
perspective and affine tilt
brightness, shadow, glare, gamma
Gaussian and motion blur
JPEG compression
scale and resampling
partial occlusion and ring damage
screen capture and screen-camera moiré
printed code and curved paper
logo / no logo
QR, Aztec, Data Matrix, clocks, records, circular logos, random rings
```

False positive 的代价高于扫不到。低置信度候选必须拒绝，不能为了扫描速度猜测结果。

## 26. 最小端到端接入顺序

1. 为生产 issuer 分配固定 16-byte issuer ID。
2. 生成 Ed25519 current key 和唯一 kid。
3. 部署 key endpoint。
4. 在 Scanner 中建立可信 issuer 引导。
5. 实现持久化 Resource、Revocation 和 Replay Store。
6. 只在服务端调用 `qcCode.issue()`。
7. 通过 HTTPS/WSS 向 Display Client 发送 Signed Envelope。
8. Display Client 调用 `encodeQCCode()` 和 Renderer。
9. Scanner 完成视觉解码和离线验签。
10. UI 分别显示视觉、签名、信任和时间结果。
11. 用户确认后提交原始 Envelope。
12. 服务器重新验签并执行原子兑换。
13. 对真实屏幕、相机和打印流程运行视觉测试集。
14. 演练 key rotation、revocation、replay 和服务重启恢复。

## 27. 集成验收清单

服务端：

- [ ] 私钥不在 Git、浏览器、日志或普通配置响应中。
- [ ] Issue endpoint 已认证、授权和限流。
- [ ] message ID、nonce、resource ID 均来自 CSPRNG。
- [ ] TTL 有模式级上限。
- [ ] Redeem 使用服务器时间。
- [ ] 每次 Redeem 重新解析和验签原始 Envelope。
- [ ] Replay claim 与业务操作具备事务或幂等恢复能力。
- [ ] 支持 ACTIVE、REDEEMED、REVOKED、EXPIRED。
- [ ] Key rotation 和 compromised-key revocation 已演练。

Display Client：

- [ ] 只接收已签名 Envelope。
- [ ] 不持有任何签名私钥。
- [ ] 不修改 Envelope 字段。
- [ ] 使用 SVG 或 Canvas 原生圆形 Renderer。
- [ ] 自定义四级颜色通过真实相机测试。
- [ ] Logo 保持在中心安全区。

Scanner：

- [ ] issuer 信任来源经过固定或可信引导。
- [ ] 保留原始 Envelope bytes。
- [ ] 分开显示视觉、签名、信任、时间和服务器状态。
- [ ] 不自动执行 Payload。
- [ ] 敏感操作要求用户确认。
- [ ] 向服务器提交原始 Envelope。
- [ ] 对低置信度和未知版本采取拒绝策略。
- [ ] 页面离开时释放 Camera。

运维：

- [ ] HTTPS/WSS 与 CSP 已配置。
- [ ] 多实例共享 replay/revocation state。
- [ ] 服务器时钟和 key expiry 有监控。
- [ ] 审计日志可关联 issuer/message ID，但不泄露敏感 Payload。
- [ ] 已验证截图重放、并发兑换、过期和撤销场景。

更底层的逐字节格式、RS、Bootstrap、Mask 和几何参数见[协议规范](./specification-v1.md)，安全假设见[安全模型](./security-model.md)，部署示例见[部署说明](./deployment.md)。
