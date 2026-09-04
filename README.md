# QCCode

QCCode is an independent circular visual-code protocol built around concentric rings and four-level luminance arc slots. It combines a deterministic binary envelope, Ed25519 signatures, CRC-32C, Reed–Solomon error correction, interleaving, and rotation-independent orientation recovery.

The server is the only component that signs messages. Display clients receive an already-signed envelope and only perform visual encoding.

## Install

```bash
npm install @qccode/sdk
```

Server applications only need the server entry point, which also exports protocol and security APIs:

```bash
npm install @qccode/server-sdk
```

See the [production integration guide](docs/production-integration.md) for transactional storage, KMS signing, key rotation, HTTP endpoints, browser trust, and deployment. The [npm integration guide](docs/npm-integration.md) covers publishing and release configuration.

## Development

```bash
pnpm install
pnpm test
pnpm build
pnpm server
pnpm dev
```

The normative V1 format is documented in [docs/specification-v1.md](docs/specification-v1.md). Teams integrating the server, display client, scanner, HTTP/WebSocket APIs, themes, logos, replay storage, and deployment should start with the Chinese [docs/integration-guide.md](docs/integration-guide.md).

V1 data rings use four ordered luminance levels per rounded arc slot, carrying two bits per slot. The common C1 layout uses six data rings and retains one full RS(255,191) codeword. Orientation and bootstrap rings remain binary so scanners can locate and identify a symbol before classifying multilevel data.

Implemented packages cover the canonical envelope, browser Ed25519 verification, trust storage, CRC-32C, RS errors and erasures, interleaving, masks, geometry, ideal and raster decoding, SVG and Canvas rendering, camera/image scanner APIs, browser SDK, server SDK, atomic in-process replay protection, the reference HTTP/WebSocket server, and the demo application.
