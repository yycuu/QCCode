# @qccode/sdk

Browser SDK for encoding, rendering, scanning, and offline verification of QCCode.

## C1/C2/C3 deprecation in v0.3.5

C1/C2/C3 formats are deprecated and will be removed in a future release. Migrate to S1. Encoding or successfully decoding a C1/C2/C3 symbol (including camera scans) emits an English `console.warn` once per encoder/decoder module, without changing existing output or verification behavior. Importing the SDK or using only S1 does not emit this warning.

For an existing bearer envelope, use `encodeQCCode(bytes, { layout: "S1" })` or the default `auto` layout. Signed envelopes cannot fit S1: reissue them with the server SDK's `issueBearer()`, keep application data on the server, and redeem through `redeemBearer()`. S1 requires online server verification and does not support offline signatures. INLINE/CHALLENGE workflows must be redesigned around server-side resources and authorization, not merely switched to another layout.

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
