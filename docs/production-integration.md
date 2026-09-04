# QCCode 生产环境完整集成指南

本文对应 `@qccode/server-sdk` 0.2 和 `@qccode/sdk` 0.2。目标依赖结构是：

```bash
# 服务器：QCCode 只安装一个包
npm install @qccode/server-sdk

# Web 客户端：QCCode 只安装一个包
npm install @qccode/sdk
```

`server-sdk` 会传递安装并重新导出 protocol 与 security API，因此服务器无需直接安装其他 `@qccode/*` 包。数据库、HTTP 框架和 KMS client 继续使用现有系统中的驱动，不由 QCCode 强制选择。

## 1. 生产数据流

```text
业务服务器
  -> @qccode/server-sdk 签发 Envelope
  -> HTTPS/WSS 发送原始 Envelope Base64URL
Web 显示端
  -> @qccode/sdk 编码并渲染 SVG/Canvas
Web 扫描端
  -> 图像解码、纠错、本地验签
  -> 用户确认
  -> HTTPS 提交原始 Envelope
业务服务器
  -> 重新解析和验签
  -> 在数据库事务内检查撤销、原子 claim、读取资源、执行业务操作
```

私钥只存在于服务端 KMS/HSM 或受保护的 secret。客户端拿到的是公钥、Signed Envelope 和视觉码。

## 2. 服务端单包导入

以下 API 均从一个入口导入：

```ts
import {
  QCCodeMode,
  QCCodeServer,
  createQCCodeStorage,
  encodeChallengePayload,
  encodeReferencePayload,
  fromBase64Url,
  toBase64Url,
  type QCCodeStorageAdapter,
} from "@qccode/server-sdk";
```

## 3. 数据库表

PostgreSQL 示例：

```sql
CREATE TABLE qccode_resources (
  issuer_id    BYTEA       NOT NULL,
  resource_type INTEGER    NOT NULL,
  resource_id  BYTEA       NOT NULL,
  value         JSONB      NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer_id, resource_type, resource_id)
);

CREATE TABLE qccode_redemptions (
  issuer_id  BYTEA       NOT NULL,
  message_id BYTEA       NOT NULL,
  nonce      BYTEA       NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  state      TEXT        NOT NULL CHECK (state IN ('CLAIMED', 'COMPLETED')),
  result     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer_id, message_id),
  UNIQUE (issuer_id, nonce)
);

CREATE INDEX qccode_redemptions_expiry
  ON qccode_redemptions (expires_at);

CREATE TABLE qccode_revocations (
  issuer_id  BYTEA       NOT NULL,
  message_id BYTEA       NOT NULL,
  expires_at TIMESTAMPTZ,
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (issuer_id, message_id)
);
```

定期删除已经过期且超过审计保留期的 redemption 与 revocation。审计保留策略应由业务和监管要求决定。

## 4. PostgreSQL 事务适配器

以下示例假设现有系统已经使用 `pg`。`transaction` 提供的 client 会原样传入 resolver，因此原子 claim 和业务写入可以使用同一数据库事务。

```ts
import type { Pool, PoolClient } from "pg";
import {
  createQCCodeStorage,
  type QCCodeStorageAdapter,
} from "@qccode/server-sdk";

export function postgresQCCodeStorage(pool: Pool) {
  const adapter: QCCodeStorageAdapter<PoolClient> = {
    async transaction(operation) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await operation(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async claimRedemption(client, claim) {
      if (claim.expiresAt <= claim.now) return "expired";
      const inserted = await client.query(
        `INSERT INTO qccode_redemptions
           (issuer_id, message_id, nonce, expires_at, state)
         VALUES ($1, $2, $3, to_timestamp($4), 'CLAIMED')
         ON CONFLICT DO NOTHING
         RETURNING message_id`,
        [
          Buffer.from(claim.issuerId),
          Buffer.from(claim.messageId),
          Buffer.from(claim.nonce),
          claim.expiresAt.toString(),
        ],
      );
      return inserted.rowCount === 1 ? "claimed" : "replayed";
    },

    async completeRedemption(client, claim, result) {
      await client.query(
        `UPDATE qccode_redemptions
            SET state = 'COMPLETED', result = $3, updated_at = now()
          WHERE issuer_id = $1 AND message_id = $2`,
        [Buffer.from(claim.issuerId), Buffer.from(claim.messageId), result],
      );
    },

    async getResource(client, issuerId, resourceType, resourceId) {
      const selected = await client.query(
        `SELECT value FROM qccode_resources
          WHERE issuer_id = $1 AND resource_type = $2 AND resource_id = $3`,
        [Buffer.from(issuerId), resourceType, Buffer.from(resourceId)],
      );
      return selected.rows[0]?.value ?? null;
    },

    async putResource(client, issuerId, resourceType, resourceId, value) {
      await client.query(
        `INSERT INTO qccode_resources
           (issuer_id, resource_type, resource_id, value)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (issuer_id, resource_type, resource_id)
         DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [Buffer.from(issuerId), resourceType, Buffer.from(resourceId), value],
      );
    },

    async isRevoked(client, issuerId, messageId) {
      const selected = await client.query(
        `SELECT 1 FROM qccode_revocations
          WHERE issuer_id = $1 AND message_id = $2
            AND (expires_at IS NULL OR expires_at > now())`,
        [Buffer.from(issuerId), Buffer.from(messageId)],
      );
      return selected.rowCount === 1;
    },

    async revoke(client, issuerId, messageId, expiresAt) {
      await client.query(
        `INSERT INTO qccode_revocations (issuer_id, message_id, expires_at)
         VALUES ($1, $2, CASE WHEN $3::text IS NULL THEN NULL ELSE to_timestamp($3) END)
         ON CONFLICT (issuer_id, message_id)
         DO UPDATE SET expires_at = EXCLUDED.expires_at`,
        [
          Buffer.from(issuerId),
          Buffer.from(messageId),
          expiresAt?.toString() ?? null,
        ],
      );
    },
  };

  return createQCCodeStorage(adapter);
}
```

MySQL、SQL Server、DynamoDB 或 Redis 可以实现同一个接口。必须保证 `transaction()` 和 `claimRedemption()` 具备真实原子性。仅用 Redis claim 时，业务数据库操作还需要相同 `messageId` 作为幂等键。

## 5. 初始化生产 Server

```ts
import { readFile } from "node:fs/promises";
import {
  QCCodeMode,
  QCCodeServer,
  fromBase64Url,
} from "@qccode/server-sdk";
import { pool } from "./database.js";
import { postgresQCCodeStorage } from "./qccode-storage.js";

const now = BigInt(Math.floor(Date.now() / 1000));

export const qccode = new QCCodeServer(
  {
    issuerId: fromBase64Url(process.env.QCCODE_ISSUER_ID!),
    keyId: Number(process.env.QCCODE_KEY_ID),
    privateKeyPkcs8: new Uint8Array(
      await readFile(process.env.QCCODE_PRIVATE_KEY_FILE!),
    ),
    publicKey: fromBase64Url(process.env.QCCODE_PUBLIC_KEY_BASE64URL!),
    keyNotBefore: BigInt(process.env.QCCODE_KEY_NOT_BEFORE!),
    keyNotAfter: BigInt(process.env.QCCODE_KEY_NOT_AFTER!),
  },
  {
    storage: postgresQCCodeStorage(pool),
    policy: {
      maxTTLSeconds: 300,
      maxEnvelopeBytes: 1024,
      clockSkewSeconds: 30n,
      allowedModes: [QCCodeMode.REFERENCE, QCCodeMode.CHALLENGE],
      allowedMessageTypes: [1001, 2001],
    },
    resolver: async ({ envelope, transaction, resource }) => {
      const client = transaction as import("pg").PoolClient;
      if (envelope.messageType === 2001) {
        await client.query(
          "UPDATE login_challenges SET confirmed_at = now() WHERE challenge_id = $1",
          [Buffer.from(envelope.payload.slice(2, 18))],
        );
        return { confirmed: true };
      }
      return resource?.value;
    },
    onError(error) {
      logger.error({ error }, "QCCode redemption failed");
    },
  },
);
```

## 6. KMS/HSM 签名

`privateKeyPkcs8` 可以由 `sign` 回调替代：

```ts
const qccode = new QCCodeServer({
  issuerId,
  keyId: 42,
  publicKey,
  keyNotBefore,
  keyNotAfter,
  async sign(signedBytes) {
    return kmsEd25519Sign({ keyName: "qccode-production", message: signedBytes });
  },
}, options);
```

回调必须返回 64-byte Ed25519 signature，并对 SDK 提供的原始 `signedBytes` 签名，不能先进行额外哈希，除非 KMS API 的 Ed25519 模式明确要求原始消息。

## 7. 签发 REFERENCE

```ts
import { QCCodeMode, encodeReferencePayload } from "@qccode/server-sdk";

const resourceType = 7;
const resourceId = crypto.getRandomValues(new Uint8Array(16));

await qccode.putResource(resourceType, resourceId, {
  action: "open-device",
  deviceId: "display-01",
});

const issued = await qccode.issue({
  mode: QCCodeMode.REFERENCE,
  messageType: 1001,
  payload: encodeReferencePayload(resourceType, resourceId),
  expiresIn: 300,
  singleUse: true,
  requireConfirmation: true,
});
```

返回的 `issued.envelopeBase64Url` 直接发送给显示端。资源写入成功后再返回 Envelope，避免码已经显示但资源尚不存在。

## 8. HTTP API

建议暴露：

```text
GET  /qccode/v1/keys
POST /qccode/v1/issue
POST /qccode/v1/redeem
POST /qccode/v1/revoke
```

Key endpoint：

```ts
app.get("/qccode/v1/keys", (_request, response) => {
  response.json({
    issuerId: toBase64Url(qccode.issuer.issuerId),
    keys: qccode.publicKeys.map((key) => ({
      kid: key.keyId,
      algorithm: "Ed25519",
      publicKey: toBase64Url(key.publicKey),
      status: key.status,
      notBefore: Number(key.notBefore),
      notAfter: Number(key.notAfter),
    })),
  });
});
```

Redeem endpoint 必须提交原始 Envelope：

```ts
app.post("/qccode/v1/redeem", async (request, response) => {
  const result = await qccode.redeem(String(request.body.envelope ?? ""));
  const httpStatus = result.status === "ACCEPTED" ? 200
    : result.status === "REPLAYED" ? 409
    : result.status === "NOT_FOUND" ? 404
    : result.status === "SERVER_REJECTED" ? 503
    : 400;
  response.status(httpStatus).json(result);
});
```

Issue、redeem 和 revoke endpoint 都需要认证、授权、限流、请求体上限与审计。不要信任客户端提交的 `valid`、解析字段或 message ID。

## 9. 密钥轮换

新签发使用 current key，历史 key 作为 `verificationKeys`：

```ts
const qccode = new QCCodeServer(currentSigningKey, {
  storage,
  verificationKeys: [
    {
      issuerId,
      keyId: 41,
      publicKey: previousPublicKey,
      status: "PREVIOUS",
      notBefore: previousNotBefore,
      notAfter: previousNotAfter,
    },
  ],
});
```

`qccode.publicKeys` 可直接用于 key endpoint。旧公钥至少保留到所有旧 Envelope 过期；私钥疑似泄漏时把对应公钥标为 `REVOKED`。

## 10. 客户端单包集成

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
  toBase64Url,
} from "@qccode/sdk";
```

初始化 Trust Store 后扫描：

```ts
const scanner = new QCCodeScanner(trustStore);
const scan = await scanner.scanCanvas(canvas);
if (!scan.security.offlineVerified) throw new Error(scan.security.error);

const response = await fetch("/qccode/v1/redeem", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ envelope: toBase64Url(scan.decoded.envelopeBytes) }),
});
```

客户端离线验签成功只证明签名和本地时间检查通过。最终状态由服务器事务返回。

## 11. 状态处理

| 状态 | HTTP 建议 | 含义 |
|---|---:|---|
| `ACCEPTED` | 200 | 业务操作已经提交 |
| `REPLAYED` | 409 | 相同 message ID 或 nonce 已使用 |
| `EXPIRED` | 400 | 已超过有效期 |
| `REVOKED` | 400 | 服务端已撤销 |
| `NOT_FOUND` | 404 | REFERENCE 资源不存在 |
| `INVALID` | 400 | 格式、签名、issuer、key 或时间无效 |
| `SERVER_REJECTED` | 503/业务码 | 存储或 resolver 失败，事务已回滚 |

客户端不要自动重试业务操作。对于 `SERVER_REJECTED`，使用相同 Envelope 重试是安全的前提是数据库 adapter 的事务确实回滚，业务 handler 也在同一事务内或使用 message ID 幂等。

## 12. 上线清单

- [ ] 服务端只从 `@qccode/server-sdk` 导入 QCCode API。
- [ ] 客户端只安装 `@qccode/sdk`。
- [ ] issuer ID 固定且备份。
- [ ] 私钥位于 KMS/HSM 或只读 secret volume。
- [ ] current/previous/revoked 公钥均由 key endpoint 发布。
- [ ] `QCCodeStorage.transaction` 使用真实数据库事务。
- [ ] redemption 有 message ID 主键和 nonce 唯一约束。
- [ ] resolver 的业务写入使用同一事务或幂等键。
- [ ] Issue endpoint 有认证、授权、限流和 message type allowlist。
- [ ] TTL 上限按业务设置，登录/授权建议不超过 300 秒。
- [ ] Redeem 使用服务器 UTC 时间并重新验签原始 Envelope。
- [ ] 多实例共享 resource、revocation 和 redemption 数据。
- [ ] 日志不记录私钥或敏感完整 Payload。
- [ ] 演练并发兑换、回滚重试、过期、撤销和密钥轮换。
- [ ] 对真实手机、屏幕、打印和光照环境完成视觉测试。

协议字节格式见[规范](./specification-v1.md)，完整浏览器 API 和视觉限制见[集成指南](./integration-guide.md)。
