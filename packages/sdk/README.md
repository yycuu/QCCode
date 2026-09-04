# @qccode/sdk

Browser SDK for encoding, rendering, scanning, and offline verification of QCCode.

```bash
npm install @qccode/sdk
```

```ts
import {
  MemoryTrustStore,
  QCCodeScanner,
  encodeQCCode,
  fromBase64Url,
  renderSvg,
} from "@qccode/sdk";

const symbol = encodeQCCode(fromBase64Url(envelopeBase64Url));
document.querySelector("#qccode")!.innerHTML = renderSvg(symbol, {
  size: 560,
  dataBackground: "#F1F3F2",
  center: { mode: "logo", imageHref: "/logo.svg", scale: 0.72 },
});

const scanner = new QCCodeScanner(new MemoryTrustStore(trustedKeys));
const result = await scanner.scanCanvas(canvas);
```

The signing private key stays on the server. Bootstrap trusted issuer keys through application configuration or another authenticated channel.

See the [production integration guide](https://github.com/yycuu/QCCode/blob/main/docs/production-integration.md).
