# @qccode/server-sdk

Production server SDK for issuing, verifying, resolving, revoking, and atomically redeeming QCCode envelopes.

## C1/C2/C3 deprecation in v0.3.5

C1/C2/C3 formats are deprecated and will be removed in a future release. Migrate to S1 using `issueBearer()` and `redeemBearer()`. The legacy signed-envelope methods `issue()`, `redeem()`, and `parse()` are marked `@deprecated` and emit an English `console.warn` once per server-sdk module when used. Existing behavior remains available in v0.3.5; imports, server construction, and bearer-only operations do not emit this warning.

S1 carries only bearer envelopes and requires online redemption; it cannot preserve offline signature verification. Store application data in server-side resources and reissue signed tokens as bearer tokens instead of changing only the visual layout. Preserve application-specific authorization and user-confirmation checks when migrating INLINE/CHALLENGE workflows. Existing bearer envelopes can be displayed as S1 without reissuance, subject to the pre-0.3.4 security upgrade requirement below.

```bash
npm install @qccode/server-sdk
```

Protocol and security APIs are re-exported, so no other `@qccode/*` server dependency is required.

```ts
import {
  QCCodeServer,
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

const issued = await server.issueBearer({
  resourceType: 7,
  resourceValue: { action: "login" },
  messageType: 1001,
  expiresIn: 300,
  singleUse: true,
});
// Display issued.envelope with the browser SDK's default S1 layout.
// On redemption, submit the original scanned bytes to the server:
const result = await server.redeemBearer(issued.envelope);
```

Implement `QCCodeStorage` with the existing application database so claim, resource access, and the business resolver share one transaction. A `sign` callback supports KMS/HSM signing, and `verificationKeys` supports key rotation.

## Bearer tokens in 0.3.4

`issueBearer()` atomically stores the original envelope and resource value. `redeemBearer()` accepts only the recorded envelope, so changing unsigned IDs, flags, or timestamps cannot bypass expiry or single-use policy. `revoke(messageId)` supports both 12-byte bearer and 16-byte signed message IDs.

Existing storage adapters need no new methods. They must preserve the SDK's JSON resource record and support a 24-byte resource storage key (`resourceId || messageId`) under the full 16-byte issuer ID. Each token has its own issuance-time resource value and redemption state, even when resource IDs are reused. The bearer wire format still contains a 12-byte resource ID and an 8-byte issuer ID.

**Upgrade requirement:** Reissue all pre-0.3.4 bearer tokens. Legacy records do not contain trusted policy and fail closed; do not migrate their values as authority or retain the old redemption path. Signed V1 tokens are unaffected.

See the [production integration guide](https://github.com/yycuu/QCCode/blob/main/docs/production-integration.md).
