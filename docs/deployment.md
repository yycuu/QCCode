# Reference deployment

The demo server accepts these environment variables:

```text
CIRCLECODE_PRIVATE_KEY_FILE       raw PKCS#8 DER file path
CIRCLECODE_PUBLIC_KEY_BASE64URL   matching 32-byte raw Ed25519 public key
CIRCLECODE_ISSUER_ID              16-byte Base64URL issuer ID
CIRCLECODE_KEY_ID                 unsigned decimal key ID
PORT                              HTTP port, default 8787
```

Private key files, `.env`, `*.pem`, and `*.key` are ignored by Git. Production issue endpoints require application authentication and authorization in front of the reference handlers. Terminate TLS at the service boundary and replace `MemoryReplayStore` with shared durable storage.

Run locally in two terminals:

```bash
pnpm server
pnpm dev
```

The UI is then available from Vite's printed URL. The HTTP server listens on `http://localhost:8787` and WebSocket push uses `/circlecode/v1/ws`.
