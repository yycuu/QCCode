# QCCode security model

QCCode images are public bearer data. Anyone who can see a symbol can copy and decode it. Use REFERENCE for sensitive business data and CHALLENGE with short expiration for authorization.

The server private key is the primary security boundary. Store it outside source control, load it from a protected file or key service, rotate it with explicit key IDs, and publish only public keys. The reference server generates an ephemeral key when no configured key is present; this is convenient for local development and intentionally loses identity on restart.

Display clients receive a complete signed envelope. They do not change timestamps, payloads, nonces, or flags. Scanner clients retain the raw envelope and treat decoded fields as untrusted until verification succeeds. Servers ignore client verification claims and repeat every check.

Signature validity means that a configured issuer signed the bytes. It does not mean the token remains active. Server acceptance additionally depends on key status, current server time, revocation, replay state, authorization, and application policy.

The sparse S1 layout carries a 48-byte bearer envelope without a signature. Its security rests on the 96-bit random resource id, a short lifetime, and atomic server-side single-use redemption; it cannot be verified offline and must never be accepted without a server round trip. Choose S1 for low-density visual requirements and keep V1 signed layouts for offline verification.

Bearer fields, including message ID, flags, and timestamps, are not authenticated by the image or its CRC. The server must persist the exact issued envelope and reject any mismatch before applying its recorded lifetime, revocation, and single-use policy. Since 0.3.4, the SDK stores a JSON-safe authority record and the resource value in one transaction, keyed by the full configured issuer ID, resource type, and the 24-byte concatenation of resource ID and message ID. Claims and revocations also use the full issuer ID; the truncated 8-byte wire issuer ID is not the storage namespace. Separate tokens for one resource have separate records and redemption state.

Upgrading to 0.3.4 requires reissuing existing bearer tokens, including bearer data displayed in C1/C2/C3. Legacy resource-only entries cannot establish trustworthy policy and are not accepted or automatically migrated. Do not fall back to legacy redemption code. Signed V1 envelopes and their storage format are unchanged.

The in-memory replay adapter is atomic only within one JavaScript process. Production deployments must use a shared transactional database or atomic Redis operation and must connect the claim to an idempotent or transactional business operation.
