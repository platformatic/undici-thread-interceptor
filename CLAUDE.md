# CLAUDE.md

This file provides guidance when working with this repository.

## Development Commands

- `npm run build` - Compile `src/**` to `dist/**`.
- `npm run lint` - Run ESLint with the TypeScript neostandard config.
- `npm run typecheck` - Typecheck source, scripts, and tests.
- `npm test` - Run the TypeScript test suite with coverage.

## Architecture Overview

This package provides a v2-only Undici interceptor that routes HTTP requests to servers registered from worker threads or TCP addresses.

### Core Components

- `src/index.ts` - Public exports.
- `src/coordinator.ts` - Owns mesh membership, lifecycle commands, and mesh snapshot publication.
- `src/server.ts` - Registers one domain target, handles thread-mode requests, supports TCP target registration, and drains on close.
- `src/interceptor.ts` - Undici compose interceptor that routes matching requests to mesh targets.
- `src/protocol.ts` - Message enum, mesh data structures, and request/response message types.
- `src/message-port-streams.ts` - `MessagePort` readable/writable streams for request and response bodies.
- `src/request-queue.ts` - Fair request queue that yields under high same-loop load.
- `src/diagnostics.ts` - Undici-compatible, server-side, and mesh diagnostics channels.
- `src/utils.ts` - IDs, domain normalization, header sanitization, hook validation, timeouts, and thread messaging.

### Request Flow

1. A coordinator is created with a `meshId`.
2. Servers register with the coordinator via `createServer()`.
3. Interceptors register with the coordinator via `createInterceptor()`.
4. The coordinator publishes mesh snapshots to members.
5. The interceptor checks the configured domain suffix and mesh domain.
6. A ready server is selected with round-robin semantics.
7. `allowTarget` hooks may reject selected targets; selection continues until one target is accepted or none remain.
8. Thread-mode targets use a lazy peer `MessageChannel`; TCP targets dispatch directly to their address.
9. Large or unknown-length bodies stream through transferable `MessagePort`s.

### Public API

- `createCoordinator(options)` / `Coordinator`
- `createServer(options)` / `Server`
- `createInterceptor(options)` / `Interceptor`
- `NoAvailableTargetError`
- `ConnectTimeoutError`
- Mesh protocol types: `Mesh`, `MeshOrigin`, `MeshServer`, `ThreadServer`, `TcpServer`, `MeshInterceptor`

### Behavior Notes

- The repository is v2-only. The v1 CommonJS entrypoint, `lib/**`, and legacy JavaScript tests were removed.
- Public runtime source lives in `src/**` and builds to `dist/**`.
- Tests are native TypeScript/ESM and live under `test/**`.
- Fixtures live under `test/fixtures/**`.
- Fixtures and tests must use ESM imports, not `require()` or `createRequire()`.
- Use root-relative test imports such as `../src/index.ts` from `test/*.test.ts` and `../../src/index.ts` from `test/fixtures/*.ts`.
- Absent domains are delegated to Undici. Domains present in the mesh without available targets fail with `NoAvailableTargetError`.
- Paused servers remain in the mesh but are skipped by target selection.
- `Server.close()` removes the target from the mesh immediately, then drains queued and in-flight requests.
- Same-thread coordinator/server/interceptor dispatch is supported through `sendThreadMessage()`.

## Testing

- Keep behavior tests grouped by topic: routing, lifecycle, selection, payloads, resilience, compatibility, hooks, diagnostics, OpenTelemetry, handler lifecycle, queue behavior, and message-port streams.
- Add fixture behavior to `test/fixtures/worker.ts` only when it is shared by multiple tests; otherwise keep one-off servers inside the test.
- Run `npm run lint`, `npm run typecheck`, and `npm test` before considering functional changes complete.
- Run `npm run build` when source files under `src/**` change.

## Migration Context

See `MIGRATION.md` for v1-to-v2 behavior changes. Do not reintroduce v1 APIs such as `wire()`, `route()`, `unroute()`, or `createThreadInterceptor()` unless the public migration plan changes.
