# Repository Guidelines

## Project Structure & Module Organization

This pnpm workspace contains the QCCode TypeScript implementation. Libraries live in `packages/*`; each package exposes its API from `src/index.ts` and builds to `dist/`. Protocol, security, encoding, decoding, geometry, rendering, scanning, vision, and SDK concerns use separate `@qccode/*` packages. Runnable examples live in `apps/demo` (Vite) and `apps/reference-server` (Express/WebSocket). Vitest suites are in `tests/*.test.ts`, with golden fixtures under `tests/vectors/v1/`. Specifications belong in `docs/`; utilities belong in `scripts/`.

## Build, Test, and Development Commands

- `pnpm install --frozen-lockfile` installs the exact locked dependency graph (Node.js 20+; CI uses Node 24).
- `pnpm build` runs `tsc -b` across all project references.
- `pnpm test` runs the full Vitest suite once; `pnpm test:watch` runs it interactively.
- `pnpm dev` builds the workspace, then starts the Vite demo.
- `pnpm server` builds the workspace, then starts the reference server.
- `pnpm vectors` regenerates V1 golden vectors. Review `git diff -- tests/vectors/v1` and commit intentional changes.

## Coding Style & Naming Conventions

Use strict TypeScript, ES modules, two-space indentation, semicolons, and double quotes, matching the existing source. Keep package APIs in `src/index.ts` and include `.js` extensions in relative TypeScript imports for NodeNext compatibility. Use `camelCase` for functions and variables, `PascalCase` for types and classes, and `UPPER_SNAKE_CASE` for protocol constants. Preserve `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; address type errors instead of weakening compiler settings.

## Testing Guidelines

Write Vitest tests in `tests/<area>.test.ts` with behavior-focused `describe` and `it` names. Add regression coverage for protocol bytes, error correction, security decisions, replay behavior, and rendered output when those areas change. There is no numeric coverage gate; every change should pass `pnpm build` and `pnpm test`. Changes to canonical encoding must also regenerate golden vectors.

## Commit & Pull Request Guidelines

Follow the repository’s Conventional Commit style: `feat:`, `fix:`, or `chore:` followed by a concise imperative summary. Keep commits focused. Pull requests should explain the behavior changed, mention affected packages, link relevant issues, and list validation performed. Include screenshots for demo or rendering changes and call out intentional specification or vector updates. CI must pass build, tests, and the clean-vector check.

## Security & Protocol Changes

Treat `docs/specification-v1.md` and `docs/security-model.md` as required context for wire-format, signature, trust, expiry, or replay changes. Never commit private keys, production credentials, or real bearer tokens; test fixtures must use deterministic test-only material.
