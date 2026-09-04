# @qccode/server-sdk

Production server SDK for issuing, verifying, resolving, revoking, and atomically redeeming QCCode envelopes.

```bash
npm install @qccode/server-sdk
```

Protocol and security APIs are re-exported, so no other `@qccode/*` server dependency is required.

```ts
import {
  QCCodeMode,
  QCCodeServer,
  encodeReferencePayload,
  fromBase64Url,
} from "@qccode/server-sdk";

const server = new QCCodeServer({
  issuerId: fromBase64Url(process.env.QCCODE_ISSUER_ID!),
  keyId: 1,
  privateKeyPkcs8,
  publicKey,
  keyNotBefore,
  keyNotAfter,
}, {
  storage: transactionalStorage,
  policy: { maxTTLSeconds: 300, maxEnvelopeBytes: 1024 },
});

const resourceId = crypto.getRandomValues(new Uint8Array(16));
await server.putResource(7, resourceId, { action: "login" });
const issued = await server.issue({
  mode: QCCodeMode.REFERENCE,
  messageType: 1001,
  payload: encodeReferencePayload(7, resourceId),
  expiresIn: 300,
  singleUse: true,
});
```

Implement `QCCodeStorage` with the existing application database so claim, resource access, and the business resolver share one transaction. A `sign` callback supports KMS/HSM signing, and `verificationKeys` supports key rotation.

See the [production integration guide](https://github.com/yycuu/QCCode/blob/main/docs/production-integration.md).
