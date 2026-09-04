# QCCode npm 安装与快速集成

## 当前发布状态

代码库已经按公共 npm 包准备完成，目标包名为：

```text
@qccode/sdk
@qccode/server-sdk
@qccode/protocol
@qccode/security
@qccode/encoder
@qccode/decoder
@qccode/renderer-svg
@qccode/renderer-canvas
@qccode/scanner
@qccode/vision
@qccode/geometry
@qccode/core
```

`@qccode/sdk` 和 `qccode` 在 2026-09-04 查询 npm registry 时没有公开版本。安装命令只有在首次发布完成后才会生效。发布 `@qccode/*` 前，npm 账号必须拥有 `qccode` scope；通常需要先在 npmjs.com 创建同名 organization，或确认该 scope 已属于你的账号。

## 浏览器应用安装

React、Vue、Svelte、Vite 或普通 TypeScript Web 应用只需安装浏览器 SDK：

```bash
npm install @qccode/sdk
```

pnpm 和 Yarn 对应命令：

```bash
pnpm add @qccode/sdk
yarn add @qccode/sdk
```

项目必须支持 ESM、Web Crypto、Canvas、`BigInt` 和 DOM 类型。推荐 Node.js 20 以上用于构建。

### 显示一个服务端签发的码

```ts
import {
  encodeQCCode,
  fromBase64Url,
  renderSvg,
} from "@qccode/sdk";

export function showQCCode(envelopeBase64Url: string): void {
  const symbol = encodeQCCode(fromBase64Url(envelopeBase64Url), {
    version: "auto",
  });

  const svg = renderSvg(symbol, {
    size: 560,
    foreground: "#000000",
    background: "#FFFFFF",
    dataBackground: "#F1F3F2",
    center: {
      mode: "logo",
      imageHref: "/brand/logo.svg",
      scale: 0.72,
    },
    title: "Signed QCCode",
  });

  document.querySelector("#qccode")!.innerHTML = svg;
}
```

页面容器：

```html
<div id="qccode" aria-live="polite"></div>
```

传入的 `envelopeBase64Url` 必须来自签发服务。显示端不能修改 Envelope，也不能持有签名私钥。

### 初始化扫描器

```ts
import {
  MemoryTrustStore,
  QCCodeScanner,
  fromBase64Url,
} from "@qccode/sdk";

const trustStore = new MemoryTrustStore([
  {
    issuerId: fromBase64Url(import.meta.env.VITE_QCCODE_ISSUER_ID),
    keyId: 27,
    publicKey: fromBase64Url(import.meta.env.VITE_QCCODE_PUBLIC_KEY),
    status: "CURRENT",
    notBefore: 1_788_000_000n,
    notAfter: 1_819_536_000n,
  },
]);

export const scanner = new QCCodeScanner(trustStore);
```

扫描 Canvas：

```ts
const result = await scanner.scanCanvas(canvas);

if (!result.security.offlineVerified) {
  throw new Error(result.security.error ?? "QCCode verification failed");
}

console.log(result.security.envelope);
```

摄像头：

```ts
await scanner.startCamera(video);
const result = await scanner.scanVideoFrame(video);
scanner.stopCamera();
```

摄像头页面需要 HTTPS 或 localhost。Issuer ID 和公钥必须通过应用预置、MDM 或已经受信的配置通道获得，不能因为某个 endpoint 返回了公钥就自动信任它。

## Node.js 服务端安装

服务端只安装这两个包：

```bash
npm install @qccode/server-sdk @qccode/protocol
```

初始化：

```ts
import { readFile } from "node:fs/promises";
import { QCCodeServer } from "@qccode/server-sdk";
import { fromBase64Url } from "@qccode/protocol";

const now = BigInt(Math.floor(Date.now() / 1000));

export const qccode = new QCCodeServer({
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

签发 REFERENCE 码：

```ts
import {
  QCCodeMode,
  encodeReferencePayload,
} from "@qccode/protocol";

const resourceId = crypto.getRandomValues(new Uint8Array(16));
qccode.registerResource(resourceId, { accountId: "account-123" });

const issued = await qccode.issue({
  mode: QCCodeMode.REFERENCE,
  messageType: 1001,
  payload: encodeReferencePayload(7, resourceId),
  expiresIn: 300,
  singleUse: true,
  requireConfirmation: true,
});

return issued.envelopeBase64Url;
```

生产环境必须替换内存 Resource、Replay 和 Revocation 状态，并在服务端重新验证 Scanner 提交的原始 Envelope。

## 只安装细分包

如果不需要扫描器，可以减小依赖范围：

```bash
npm install @qccode/protocol @qccode/encoder @qccode/renderer-svg
```

如果只做离线验签：

```bash
npm install @qccode/protocol @qccode/security
```

不要从包内的 `src/` 或 `dist/` 路径导入。所有稳定入口都从包根导入：

```ts
import { parseEnvelope } from "@qccode/protocol";
```

## 本仓库本地打包验证

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm pack:npm
```

生成的 tarball 位于：

```text
artifacts/npm/
```

每个 tarball 只包含 `dist/` 和 `package.json`。发布前可以检查内容：

```bash
npm pack --dry-run ./packages/sdk
```

## 首次发布

公共 scoped package 要求 npm 账号拥有 `@qccode` scope，并在首次发布时指定 public access。先启用 npm 2FA，然后登录：

```bash
npm login
npm whoami
pnpm install --frozen-lockfile
pnpm test
pnpm release:npm
```

`release:npm` 按依赖顺序构建、打包并发布全部 12 个包。首次执行前应确认：

- npm 账号确实拥有 `@qccode`。
- Git 工作区干净且位于准备发布的 commit。
- 12 个包的版本一致。
- `pnpm pack:npm` 产物中没有私钥、`.env`、测试截图或源码外的文件。

首次发布是外部不可逆操作，应在 npm 组织和版本号确认后执行。

## 配置 GitHub OIDC 自动发布

仓库提供 `.github/workflows/publish.yml`。它在 GitHub Release 发布时运行，并要求 tag 为 `v<version>`，例如 `v0.1.0`。

首次发布各包后，在 npmjs.com 的每个 `@qccode/*` package 设置中添加 Trusted Publisher：

```text
Provider:          GitHub Actions
Organization/user: yycuu
Repository:        QCCode
Workflow filename: publish.yml
Allowed action:    npm publish
```

全部 12 个 package 都需要配置，因为 npm 对每个 package 单独维护发布信任关系。工作流使用 `id-token: write` 获取短期 OIDC 身份，不需要保存长期 `NPM_TOKEN`。

后续发布流程：

1. 把所有 `packages/*/package.json` 更新为相同的新版本。
2. 运行 `pnpm install` 更新 lockfile。
3. 执行 `pnpm build && pnpm test && pnpm pack:npm`。
4. 提交版本变更并推送。
5. 创建同版本 tag，例如 `v0.1.1`。
6. 在 GitHub 发布该 tag 对应的 Release。
7. 等待 `Publish npm packages` workflow 完成。

## 安装失败排查

`E404 Not Found`：package 尚未首次发布、scope 不属于当前账号，或私有包账号无读取权限。

`ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`：正在安装仓库源码但没有从 monorepo 根目录运行 `pnpm install`。

`Unsupported URL Type "workspace:"`：直接对源码目录执行了 `npm publish`。使用仓库的 `pnpm release:npm`，它会先生成已把 `workspace:*` 转换成正式版本依赖的 tarball。

浏览器提示 `crypto.subtle`、Camera 或 Canvas 不可用：确认运行于受支持的现代浏览器和 HTTPS 安全上下文；Node.js 服务端不要导入 Scanner 或 Canvas 模块。
