# CircleCode security model

CircleCode images are public bearer data. Anyone who can see a symbol can copy and decode it. Use REFERENCE for sensitive business data and CHALLENGE with short expiration for authorization.

The server private key is the primary security boundary. Store it outside source control, load it from a protected file or key service, rotate it with explicit key IDs, and publish only public keys. The reference server generates an ephemeral key when no configured key is present; this is convenient for local development and intentionally loses identity on restart.

Display clients receive a complete signed envelope. They do not change timestamps, payloads, nonces, or flags. Scanner clients retain the raw envelope and treat decoded fields as untrusted until verification succeeds. Servers ignore client verification claims and repeat every check.

Signature validity means that a configured issuer signed the bytes. It does not mean the token remains active. Server acceptance additionally depends on key status, current server time, revocation, replay state, authorization, and application policy.

The in-memory replay adapter is atomic only within one JavaScript process. Production deployments must use a shared transactional database or atomic Redis operation and must connect the claim to an idempotent or transactional business operation.
