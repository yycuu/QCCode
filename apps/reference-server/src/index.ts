import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import cors from "cors";
import express from "express";
import { WebSocketServer } from "ws";
import {
  CircleCodeMode,
  encodeChallengePayload,
  encodeReferencePayload,
  fromBase64Url,
  toBase64Url,
} from "@circlecode/protocol";
import { generateEd25519KeyPair } from "@circlecode/security";
import { CircleCodeServer } from "@circlecode/server-sdk";

async function loadKeys(): Promise<{ privateKeyPkcs8: Uint8Array; publicKey: Uint8Array }> {
  const privatePath = process.env.CIRCLECODE_PRIVATE_KEY_FILE;
  const publicValue = process.env.CIRCLECODE_PUBLIC_KEY_BASE64URL;
  if (privatePath && publicValue) return { privateKeyPkcs8: new Uint8Array(await readFile(privatePath)), publicKey: fromBase64Url(publicValue) };
  console.warn("CircleCode demo is using an ephemeral Ed25519 key; set CIRCLECODE_PRIVATE_KEY_FILE and CIRCLECODE_PUBLIC_KEY_BASE64URL to retain identity.");
  return generateEd25519KeyPair();
}

const issuerId = process.env.CIRCLECODE_ISSUER_ID ? fromBase64Url(process.env.CIRCLECODE_ISSUER_ID) : crypto.getRandomValues(new Uint8Array(16));
if (issuerId.length !== 16) throw new Error("CIRCLECODE_ISSUER_ID must encode 16 bytes");
const keys = await loadKeys();
const now = BigInt(Math.floor(Date.now() / 1000));
const circleCode = new CircleCodeServer({ issuerId, keyId: Number(process.env.CIRCLECODE_KEY_ID ?? 1), ...keys, keyNotBefore: now - 60n, keyNotAfter: now + 31_536_000n });

const app = express();
app.use(cors());
app.use(express.json({ limit: "64kb" }));
const httpServer = createServer(app);
const sockets = new WebSocketServer({ server: httpServer, path: "/circlecode/v1/ws" });

app.get("/circlecode/v1/keys", (_request, response) => {
  const key = circleCode.keyRecord;
  response.json({ issuerId: toBase64Url(key.issuerId), keys: [{ kid: key.keyId, algorithm: "Ed25519", publicKey: toBase64Url(key.publicKey), status: key.status, notBefore: Number(key.notBefore), notAfter: Number(key.notAfter) }] });
});

app.post("/circlecode/v1/issue", async (request, response) => {
  try {
    const mode = CircleCodeMode[String(request.body.mode ?? "REFERENCE").toUpperCase() as keyof typeof CircleCodeMode];
    if (typeof mode !== "number") throw new Error("invalid mode");
    let payload: Uint8Array;
    if (mode === CircleCodeMode.REFERENCE) {
      const resourceId = crypto.getRandomValues(new Uint8Array(16));
      payload = encodeReferencePayload(Number(request.body.resourceType ?? 1), resourceId);
      circleCode.registerResource(resourceId, request.body.payload ?? null);
    } else if (mode === CircleCodeMode.CHALLENGE) {
      const challengeId = crypto.getRandomValues(new Uint8Array(16));
      const context = new TextEncoder().encode(JSON.stringify(request.body.payload ?? null));
      payload = encodeChallengePayload(Number(request.body.challengeType ?? 1), challengeId, new Uint8Array(await crypto.subtle.digest("SHA-256", context)));
    } else {
      payload = new TextEncoder().encode(typeof request.body.payload === "string" ? request.body.payload : JSON.stringify(request.body.payload ?? null));
    }
    const issued = await circleCode.issue({ mode, messageType: Number(request.body.messageType ?? 1), payload, expiresIn: Number(request.body.expiresIn ?? 300), singleUse: Boolean(request.body.singleUse), requireConfirmation: Boolean(request.body.requireConfirmation) });
    const message = JSON.stringify({ type: "circlecode.envelope", sequence: Date.now(), envelope: issued.envelopeBase64Url });
    for (const socket of sockets.clients) if (socket.readyState === socket.OPEN) socket.send(message);
    response.json({ envelopeBase64Url: issued.envelopeBase64Url });
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "invalid request" });
  }
});

app.post(["/circlecode/v1/redeem", "/circlecode/v1/resolve"], async (request, response) => {
  const result = await circleCode.redeem(String(request.body.envelope ?? ""));
  response.status(result.status === "ACCEPTED" ? 200 : 400).json(result);
});

app.get("/health", (_request, response) => response.json({ ok: true }));

const port = Number(process.env.PORT ?? 8787);
httpServer.listen(port, () => console.log(`CircleCode reference server listening on http://localhost:${port}`));
