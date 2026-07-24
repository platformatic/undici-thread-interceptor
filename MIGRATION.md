# Migration To v2

This guide covers the intentional breaking changes from v1 to v2 and how to update applications.

## Summary

v2 is a TypeScript/ESM rewrite built around explicit mesh roles:

- `createCoordinator()` owns membership for one mesh.
- `createServer()` registers one server target for one domain.
- `createInterceptor()` creates the Undici compose interceptor used by clients.

The v1 implementation, root CommonJS entrypoint, and legacy JavaScript tests have been removed. v2 does not keep compatibility aliases for v1 APIs.

## Package And Module Format

v1 exposed a CommonJS root implementation backed by `lib/**`.

v2 is ESM-first and builds TypeScript source from `src/**` to `dist/**`. Import named exports from the package:

```js
import { createCoordinator, createServer, createInterceptor } from 'undici-thread-interceptor'
```

Do not import from internal `lib/**` paths. Those files no longer exist.

## Replacing The v1 Wiring Model

In v1, `wire()` created a worker-local interceptor and installed it as the global Undici dispatcher. A wired server could call other mesh domains, including itself, without additional setup.

In v2, server and client roles are separate. A worker that serves requests is not automatically a mesh client.

### Before

```js
// v1 style
wire({ domain: '.local' })
route('http:api.local', app)
```

### After

```js
import { createServer } from 'undici-thread-interceptor'

const server = createServer({
  meshId: 'app',
  coordinatorThreadId,
  serverId: 'api-1',
  domain: 'api.local',
  server: app
})

server.ready.catch(error => {
  throw error
})
```

Create an interceptor explicitly anywhere that needs to make mesh requests:

```js
import { Agent, setGlobalDispatcher } from 'undici'
import { createInterceptor } from 'undici-thread-interceptor'

const interceptor = createInterceptor({
  meshId: 'app',
  coordinatorThreadId,
  domain: '.local'
})

interceptor.ready
  .then(() => setGlobalDispatcher(new Agent().compose(interceptor)))
  .catch(error => {
    throw error
  })
```

## Adding A Coordinator

v2 requires one coordinator per mesh. The coordinator is usually created in the main thread:

```js
import { createCoordinator } from 'undici-thread-interceptor'

const coordinator = createCoordinator({ meshId: 'app' })
```

Pass `meshId` and `coordinatorThreadId` to workers so their servers and interceptors can register:

```js
const worker = new Worker(new URL('./worker.js', import.meta.url), {
  workerData: {
    meshId: 'app',
    coordinatorThreadId: 0
  }
})
```

When the coordinator runs in a worker, pass that worker's `threadId` instead.

`coordinatorThreadId` defaults to `0` for both `createServer()` and `createInterceptor()`. You can omit it when the coordinator runs in the main thread.

## Route Registration

v1 route registration was implicit in the wired object. v2 registers each target with `createServer()`.

```js
const server = createServer({
  meshId: 'app',
  coordinatorThreadId,
  serverId: 'api-1',
  domain: 'api.local',
  server: app,
  metadata: { region: 'eu' }
})
```

Use stable `serverId` values when a coordinator or test needs to pause, resume, close, or identify a target. When omitted, `serverId` defaults to a `crypto.randomUUID()` value.

`interceptorId` also defaults to a `crypto.randomUUID()` value when omitted from `createInterceptor()`.

## TCP Targets

v2 can register TCP targets directly:

```js
const server = createServer({
  meshId: 'app',
  serverId: 'api-tcp',
  domain: 'api.local',
  server: 'http://127.0.0.1:3000'
})
```

TCP targets are selected through the same mesh and hooks, then dispatched through Undici to the configured address.

## Domain Behavior

v2 separates interceptor suffix matching from server domain lookup.

- `domain` on the interceptor is a hostname suffix such as `.local`.
- `domain` on the server is the protocol-free mesh domain such as `api.local`.
- Server domains must not include `http:`, `https:`, or `://`.
- Domain matching is case-insensitive.
- Requests outside the configured domain are delegated to the next Undici dispatcher.
- Requests inside the domain but absent from the mesh are also delegated to Undici.
- Requests for domains present in the mesh but without available targets fail with `NoAvailableTargetError`.

This means DNS or the next dispatcher can still handle hosts that are not registered in the mesh.

## Target Availability

v1 allowed some unavailable-route patterns through `replaceServer(null)`.

v2 models availability with server state:

```js
server.pause()
server.resume()
server.close().catch(error => {
  throw error
})
```

Paused servers stay visible in mesh snapshots but are skipped by target selection. Closed servers are removed from the mesh immediately.

For thread-mode servers, `replaceServer(null)` is not supported. Passing `null` or `undefined` to `replaceServer()` throws.

For TCP servers, `replaceServer(null)` and `replaceServer(undefined)` are ignored and keep the previous TCP address unchanged.

Use `replaceServer(nextServer)` only when replacing the application handler or TCP address with another valid target.

## Load Balancing

v2 uses round-robin target selection among available servers for a domain. The cursor starts from a randomized position to avoid always selecting the first target after startup.

If a selected target is denied by `allowTarget`, selection continues with the next available target. If all available targets are denied, the request fails with `NoAvailableTargetError`.

## Access Control And Target Hooks

v1 hook names and semantics are not preserved as aliases.

Use v2 `allowTarget` for target access control:

```js
const interceptor = createInterceptor({
  meshId: 'app',
  domain: '.local',
  allowTarget (req, target) {
    return target.metadata?.tenant === req.headers['x-tenant']
  }
})
```

`allowTarget` may return `false` to deny the target. Any other return value allows it. If an array of hooks is provided, evaluation stops at the first `false`.

## Hook Changes

Hooks in v2 are synchronous and can be provided as a function or array of functions.

Interceptor hooks:

- `onRequest(req, ctx)`
- `allowTarget(req, target, ctx)`
- `onResponse(req, res, ctx)`
- `onResponseEnd(req, res, ctx)`
- `onError(req, res, ctx, error)`

Server hooks:

- `onRequest(req)`
- `onResponse(req, res)`
- `onError(req, res, error)`

Server `onRequest` is notification-style. It does not receive `next` and does not wrap the application handler.

Async hooks are rejected because hook execution is part of the dispatch path and must remain deterministic.

## Undici Handler Lifecycle

v2 targets the Undici 8 dispatcher handler lifecycle:

- `onRequestStart`
- `onResponseStart`
- `onResponseData`
- `onResponseEnd`
- `onResponseError`

The v1 compatibility wrapper for older handlers using `onConnect`, `onHeaders`, `onData`, `onComplete`, and `onError` is not retained.

If application code implements custom Undici dispatch handlers, update them to the Undici 8 lifecycle before composing this interceptor.

## Body And Header Behavior

v2 preserves v1-visible body behavior for common request and response payloads:

- string request bodies
- buffer request bodies
- streamed request bodies
- buffer and binary responses
- empty streamed responses
- response stream errors
- aborted requests

Request bodies with large or unknown length are transferred through `MessagePort` streams.

Hop-by-hop request headers are sanitized before server injection. Nullish headers are filtered before the server receives the request.

Dispatcher query options are propagated to server injection.

## Fastify, Express, And Koa

v2 server registration supports in-process application handlers through `light-my-request`.

- Fastify instances are handled through `.inject()` when available.
- Express-style handlers are supported.
- Koa-style callback handlers are supported.

For Fastify, pass the Fastify instance directly:

```js
const app = Fastify()
app.get('/', async () => ({ ok: true }))

createServer({
  meshId: 'app',
  domain: 'api.local',
  server: app
})
```

## Peer Connections

v1 eagerly built a full mesh of `MessageChannel` connections between route participants.

v2 publishes mesh snapshots from the coordinator and creates peer connections lazily from interceptors to selected thread-mode servers.

Do not depend on every server thread automatically having direct channels to every other server thread. If a worker needs client behavior, create an interceptor in that worker.

## Same-Thread Dispatch

Node's `postMessageToThread()` cannot send directly to the same thread. v2 handles same-thread coordinator/server/interceptor dispatch through an internal `sendThreadMessage()` wrapper.

Applications do not need special setup for same-thread tests or single-thread local usage, but they should still create explicit coordinator, server, and interceptor instances.

## WebSockets

v1 had no WebSocket or HTTP upgrade support; upgrades against thread targets failed. v2 tunnels upgraded connections between threads over dedicated `MessagePort`s.

No client changes are required: undici's `WebSocket` with the composed dispatcher works against mesh domains. On the server side, register a Node `http.Server` (or a Fastify instance with `@fastify/websocket`) instead of a bare request handler, or pass an explicit `upgrade` handler in `createServer()`. Bare handlers advertise `capabilities.upgrade: false` in the mesh and are skipped by upgrade selection.

`server.close()` waits up to `upgradeDrainTimeout` milliseconds (default `30000`) for established connections to close before destroying them. See the README's WebSockets section for details.

## Lifecycle Mapping

Coordinator lifecycle:

```js
coordinator.pause(serverId)
coordinator.resume(serverId)
coordinator.close(serverId)
coordinator.close()
coordinator.restart()
coordinator.destroy()
```

Server lifecycle:

```js
server.pause()
server.resume()
server.replaceServer(nextServer)
server.updateMetadata(nextMetadata)
server.close().catch(error => {
  throw error
})
```

Interceptor lifecycle:

```js
interceptor.ready
  .then(() => {
    interceptor.updateMetadata(nextMetadata)
    const mesh = interceptor.getMesh()
    interceptor.close()
  })
  .catch(error => {
    throw error
  })
```

`coordinator.close(serverId)` sends a close command to one registered server. `coordinator.close()` closes current members and leaves the coordinator reusable after `restart()`. `coordinator.destroy()` is terminal.

## Diagnostics

Thread-mode requests publish Undici-compatible diagnostics:

- `undici:request:create`
- `undici:request:headers`
- `undici:request:trailers`
- `undici:request:error`

Server-side diagnostics:

- `http.server.request.start`
- `http.server.response.finish`

Mesh diagnostics:

- `undici-thread-interceptor:mesh:update`
- `undici-thread-interceptor:peer:connect`
- `undici-thread-interceptor:peer:disconnect`

TCP targets are normal Undici dispatches and do not emit synthetic thread-mode Undici diagnostics.

## OpenTelemetry

v2 keeps Undici-compatible request diagnostics for thread-mode requests so Undici OpenTelemetry instrumentation can create client spans and inject trace context headers.

Errored thread-mode requests are reported through the request error diagnostics path.

## Error Changes

Public errors are:

- `NoAvailableTargetError`
- `ConnectTimeoutError`

`NoTargetError` is not part of the v2 public API.

## Migration Checklist

1. Replace v1 imports with named v2 imports from `undici-thread-interceptor`.
2. Create one `createCoordinator({ meshId })` for each mesh.
3. Pass `meshId` and `coordinatorThreadId` to worker threads.
4. Replace route registration with `createServer({ meshId, coordinatorThreadId, domain, server })`.
5. Replace implicit `wire()` client behavior with explicit `createInterceptor()` usage.
6. Compose the interceptor with an Undici `Agent` or install it with `setGlobalDispatcher()` where needed.
7. Replace `replaceServer(null)` with `pause()` and `resume()`.
8. Replace v1 target access hooks with `allowTarget`.
9. Convert server request hooks to notification-style `onRequest(req)`.
10. Update custom Undici handlers to the Undici 8 lifecycle.
11. Update imports and fixtures to ESM.
12. Verify absent-domain delegation and no-target failures match your expectations.

## Example Migration

Before, a worker might both register a route and implicitly get client behavior through wiring:

```js
// v1 style
wire({ domain: '.local' })
route('http:api.local', app)
```

After, registration and client behavior are explicit:

```js
import { Agent, setGlobalDispatcher } from 'undici'
import { createInterceptor, createServer } from 'undici-thread-interceptor'

const server = createServer({
  meshId,
  coordinatorThreadId,
  serverId: 'api-1',
  domain: 'api.local',
  server: app
})

server.ready
  .then(() => {
    const interceptor = createInterceptor({
      meshId,
      coordinatorThreadId,
      domain: '.local'
    })

    return interceptor.ready.then(() => {
      setGlobalDispatcher(new Agent().compose(interceptor))
    })
  })
  .catch(error => {
    throw error
  })
```

If the worker only serves requests, omit the interceptor. If it also calls mesh domains, create the interceptor explicitly.
