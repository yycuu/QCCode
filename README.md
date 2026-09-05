# QCCode

QCCode is an independent circular visual-code protocol built around concentric rings and four-level luminance arc slots. It combines a deterministic binary envelope, Ed25519 signatures, CRC-32C, Reed–Solomon error correction, interleaving, and rotation-independent orientation recovery.

The server is the only component that signs messages. Display clients receive an already-signed envelope and only perform visual encoding.

**v0.3.5 deprecation notice:** C1/C2/C3 formats are deprecated and will be removed in a future release. Migrate to S1 using server-issued bearer envelopes and online redemption. Existing C formats still work, with English console warnings from the SDKs. Signed envelopes cannot simply be rendered as S1, and S1 does not support offline signature verification. See the [migration guidance](packages/sdk/README.md#c1c2c3-deprecation-in-v035).

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

The sparse S1 layout draws the data area with the same guard-weight rounded dashes as the orientation ring: six rings of 40–72 slots, one shortened RS(86,54) codeword, and a 48-byte bearer envelope verified server-side with atomic single-use redemption. S1 trades offline signatures for a visually simpler, denser-to-camera-free symbol; V1 signed layouts remain available for offline verification.

Implemented packages cover the canonical envelope, browser Ed25519 verification, trust storage, CRC-32C, RS errors and erasures, interleaving, masks, geometry, ideal and raster decoding, SVG and Canvas rendering, camera/image scanner APIs, browser SDK, server SDK, atomic in-process replay protection, the reference HTTP/WebSocket server, and the demo application.

## License

[MIT](LICENSE) © 2026 yycuu
