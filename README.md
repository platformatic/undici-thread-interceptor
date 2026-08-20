# undici-thread-interceptor

An Undici compose interceptor that routes HTTP requests to servers registered from worker threads or TCP addresses.

## Install

```sh
npm install undici-thread-interceptor
```

## Requirements

- Node.js with worker thread messaging support.
- Undici 8 style dispatcher handlers.
- ESM applications. The package is distributed from TypeScript source built to `dist/**`.

## Concepts

The v2 API has three explicit roles:

- `createCoordinator()` creates a mesh coordinator for one `meshId`.
- `createServer()` registers one server target for one domain.
- `createInterceptor()` creates an Undici compose interceptor that routes matching requests through the mesh.

A request is intercepted only when its hostname matches the configured domain suffix and the requested domain exists in the mesh. If no mesh entry exists, the request is delegated to the next Undici dispatcher. If the mesh entry exists but no target is available, the request fails with `NoAvailableTargetError`.

## Basic Usage

Main thread:

```js
import { Worker } from 'node:worker_threads'
import { Agent, request } from 'undici'
import { createCoordinator, createInterceptor } from 'undici-thread-interceptor'

const meshId = 'app'
const coordinator = createCoordinator({ meshId })

async function main () {
  const worker = new Worker(new URL('./worker.js', import.meta.url), {
    workerData: {
      meshId,
      coordinatorThreadId: 0
    }
  })

  const interceptor = createInterceptor({
    meshId,
    domain: '.local'
  })
  await interceptor.ready

  const agent = new Agent().compose(interceptor)
  const { body } = await request('http://api.local', { dispatcher: agent })

  console.log(await body.json())

  await worker.terminate()
  await interceptor.close()
  coordinator.destroy()
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
```

Worker thread:

```js
import { parentPort, workerData } from 'node:worker_threads'
import Fastify from 'fastify'
import { createServer } from 'undici-thread-interceptor'

const app = Fastify()
app.get('/', async () => ({ hello: 'world' }))

const server = createServer({
  meshId: workerData.meshId,
  coordinatorThreadId: workerData.coordinatorThreadId,
  serverId: 'api-1',
  domain: 'api.local',
  server: app
})

server.ready
  .then(() => parentPort?.postMessage({ ready: true }))
  .catch(error => {
    throw error
  })
```

## Global Fetch

The interceptor is a normal Undici compose interceptor, so it can be installed on a global dispatcher:

```js
import { Agent, setGlobalDispatcher } from 'undici'
import { createInterceptor } from 'undici-thread-interceptor'

async function main () {
  const interceptor = createInterceptor({ meshId: 'app', domain: '.local' })
  await interceptor.ready

  setGlobalDispatcher(new Agent().compose(interceptor))

  const response = await fetch('http://api.local')
  console.log(await response.json())
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
```

## TCP Targets

`createServer()` can register an HTTP address instead of an in-process server. The interceptor dispatches directly to the target address:

```js
import { createServer } from 'undici-thread-interceptor'

const server = createServer({
  meshId: 'app',
  serverId: 'api-tcp',
  domain: 'api.local',
  server: 'http://127.0.0.1:3000'
})

server.ready.catch(error => {
  throw error
})
```

## WebSockets

Mesh targets can serve WebSocket connections. Client code is unmodified: use undici's `WebSocket` with the composed dispatcher and the mesh domain, and register a Node `http.Server` (or a Fastify instance using `@fastify/websocket`) so the mesh can emit its `'upgrade'` event:

```js
// Worker thread
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { createServer as createMeshServer } from 'undici-thread-interceptor'

const httpServer = createServer(app)
const wss = new WebSocketServer({ server: httpServer })
wss.on('connection', socket => socket.on('message', data => socket.send(data)))

createMeshServer({ meshId: 'app', domain: 'api.local', server: httpServer })

// Client thread
import { WebSocket } from 'undici'

const ws = new WebSocket('ws://api.local/updates', { dispatcher: agent })
```

Use `ws://` URLs for mesh domains. Mesh origins are `http:`-based, so a `wss://` URL never matches the mesh — it is delegated to regular Undici dispatch, which will attempt a real TLS connection. There is no TLS inside the mesh; the tunnel runs over `MessagePort`s.

The connection is tunneled between threads over a dedicated `MessagePort` as raw bytes: the server performs its real handshake, so subprotocols, ping/pong, close codes, and `permessage-deflate` behave exactly as over TCP. TCP targets upgrade over their real address. Routing, `allowTarget` hooks, and `connectTimeout` apply to upgrades the same way they apply to requests — `connectTimeout` covers the window from dispatch until the handshake response arrives.

Handshake rejections are transparent: when the server answers an upgrade with a non-101 response (for example `ws` rejecting with a `400`), the response is replayed to the client as a regular HTTP response, exactly as it would arrive over TCP. A target that advertises the upgrade capability but has no `'upgrade'` listener attached at request time answers `501`; a server that is unavailable when the upgrade arrives (a selection race with pause/close) answers `503`.

Supported clients — anything that dispatches through undici:

- undici's `WebSocket` with the `dispatcher` option, as above.
- Node's global `WebSocket` via `setGlobalDispatcher(agent)` from undici — no per-connection options needed. (Passing `{ dispatcher }` to the global `WebSocket` also works on Node ≥ 24; on Node 22 the bundled undici predates the current handler API, so prefer `setGlobalDispatcher` or the undici import there.)
- `dispatcher.upgrade()` for manual HTTP upgrades.

### node:http clients and `@fastify/http-proxy`

Clients that speak `node:http` directly — most notably the `ws` package's client — do not consult undici dispatchers. For those, `interceptor.createUpgradeAgent()` returns a `node:http` `Agent` that routes upgrade requests for mesh domains through the mesh and falls back to real TCP for every other host:

```js
import { WebSocket } from 'ws'

const ws = new WebSocket('ws://api.local/updates', {
  agent: interceptor.createUpgradeAgent()
})
```

This is how `@fastify/http-proxy` WebSocket proxying reaches mesh targets — pass the agent through `wsClientOptions` and the undici dispatcher for the HTTP path:

```js
import proxy from '@fastify/http-proxy'

await app.register(proxy, {
  upstream: 'http://api.local',
  websocket: true,
  wsClientOptions: { agent: interceptor.createUpgradeAgent() },
  undici: agent
})
```

The agent supports upgrade requests only: regular HTTP requests to mesh domains through it receive a `501` (use the undici interceptor for those). Mesh upstreams must use `ws://`/`http://`; interceptor `onRequest`/`allowTarget` hooks and `connectTimeout` apply, while response hooks and the `upgrade:established`/`upgrade:rejected` diagnostics do not fire on this path — after routing, the connection is a direct byte pipe and the handshake response is parsed by the client itself.

Targets advertise an `upgrade` capability in the mesh (`capabilities.upgrade`). Bare request handlers cannot accept upgrades and are skipped by upgrade selection; if no target can upgrade, dispatch fails with `NoAvailableTargetError`. To serve upgrades without an `http.Server`, pass an explicit handler:

```js
createMeshServer({
  meshId: 'app',
  domain: 'api.local',
  server: handler,
  upgrade (req, socket, head) {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
  }
})
```

`server.close()` drains established connections: it waits up to `upgradeDrainTimeout` milliseconds (default `30000`) for them to close on their own, then destroys the remainder. Use `0` to destroy them immediately. Paused servers keep established connections but reject new upgrades. Established connections are never migrated: mesh updates only affect new connections, and `interceptor.close()` or the loss of either thread destroys the tunnel — the peer sees an abnormal closure (WebSocket close code `1006`). `CONNECT` requests to mesh targets are rejected.

## Domains

Server domains must not include a protocol. Use `api.local`, not `http:api.local` or `http://api.local`.

```js
createServer({
  meshId: 'app',
  domain: 'api.local',
  server: app
})

createInterceptor({
  meshId: 'app',
  domain: '.local'
})
```

The interceptor checks the configured domain suffix case-insensitively. Requests outside the configured domain are delegated to Undici.

## Hooks

Hooks can be a function or an array of functions. Hooks must be synchronous. Async hooks are rejected.

### Interceptor Hooks

```js
const interceptor = createInterceptor({
  meshId: 'app',
  domain: '.local',
  onRequest (req, ctx) {
    ctx.started = Date.now()
  },
  allowTarget (req, target, ctx) {
    return target.metadata?.disabled !== true
  },
  onResponse (req, res, ctx) {
    console.log(req.path, res.statusCode, Date.now() - ctx.started)
  },
  onResponseEnd (req, res, ctx) {
    console.log('completed', req.path)
  },
  onError (req, res, ctx, error) {
    console.error(error)
  }
})
```

`allowTarget` is an access-control hook. Returning `false` denies that target and selection continues with the next available target. In hook arrays, evaluation stops on the first `false`.

For WebSocket upgrades, `onRequest` and `allowTarget` run as usual and `onResponse` fires with the handshake response (`statusCode: 101` on establishment, or the rejection status). `onResponseEnd` fires for rejected handshakes but never for established connections — they are long-lived and have no response end. Neither response hook fires on the `createUpgradeAgent()` path, where the handshake response goes straight to the client.

### Server Hooks

```js
const server = createServer({
  meshId: 'app',
  serverId: 'api-1',
  domain: 'api.local',
  server: app,
  onRequest (req) {
    console.log(req.method, req.url)
  },
  onResponse (req, res) {
    console.log(res.statusCode)
  },
  onError (req, res, error) {
    console.error(error)
  }
})
```

Server hooks are notification hooks. `onRequest` does not receive a `next` callback and cannot replace the application handler.

For WebSocket upgrades, server-side `onRequest` fires with the synthetic upgrade request before it is emitted to the upgrade target; `onResponse` does not fire for upgrades because the handshake response is written directly to the socket by the upgrade handler.

## Metadata

Servers and interceptors can publish arbitrary metadata into the mesh:

```js
const server = createServer({
  meshId: 'app',
  domain: 'api.local',
  server: app,
  metadata: { region: 'eu-west-1' }
})

await server.updateMetadata({ region: 'eu-west-1', disabled: true })
```

Interceptor target hooks can use server metadata for routing decisions.

## Lifecycle

Servers can be paused, resumed, replaced, and closed:

```js
await server.pause()
await server.resume()
await server.replaceServer(nextApp)
await server.updateMetadata(nextMetadata)
await server.close().catch(error => {
  throw error
})
```

Paused servers remain visible in mesh snapshots but are skipped by selection. Lifecycle mutation methods resolve only after all relevant interceptors have installed the resulting mesh. Closing a server waits for leave propagation before starting peer draining, so requests selected using a stale snapshot remain admitted through the dispatch boundary.

Interceptors expose lifecycle and mesh inspection helpers:

```js
interceptor.ready
  .then(() => {
    console.log(interceptor.interceptorId)
    console.log(interceptor.getMesh())
    await interceptor.updateMetadata({ role: 'client' })
    await interceptor.close()
  })
  .catch(error => {
    throw error
  })
```

Coordinators can manage server state and their own lifecycle:

```js
coordinator.pause('api-1')
coordinator.resume('api-1')
coordinator.close('api-1')
coordinator.close()
coordinator.restart()
coordinator.destroy()
```

`close(serverId)` asks one registered server to close. `close()` without a server id closes current members and keeps the coordinator reusable after `restart()`. `destroy()` permanently removes the coordinator from the process registry.

## API Reference

### `createCoordinator(options)`

```ts
interface CoordinatorOptions {
  meshId: string
  onMesh?: (mesh: Mesh) => void
  onInterceptorAvailable?: (interceptor: MeshInterceptor) => void
  onInterceptorClosed?: (interceptor: MeshInterceptor) => void
  onServerAvailable?: (server: MeshServer) => void
  onServerUnavailable?: (server: MeshServer) => void
  onServerPaused?: (server: MeshServer) => void
  onServerResumed?: (server: MeshServer) => void
  onServerClosed?: (server: MeshServer) => void
  onServerUpdate?: (server: MeshServer) => void
  onError?: (error: Error) => void
}
```

### `createServer(options)`

```ts
interface ServerOptions {
  meshId: string
  serverId?: string
  domain: string
  server: any
  paused?: boolean
  metadata?: unknown
  coordinatorThreadId?: number
  bootstrapTimeout?: number
  upgrade?: (req, socket, head) => void
  upgradeDrainTimeout?: number
  onRequest?: Hook | Hook[]
  onResponse?: Hook | Hook[]
  onError?: Hook | Hook[]
}
```

`serverId` defaults to a `crypto.randomUUID()` value. `coordinatorThreadId` defaults to `0`. `server` can be a Fastify instance, a Node `http.Server`, an Express/Koa-style handler accepted by `light-my-request`, or a TCP target address string. `upgrade` overrides upgrade delivery; otherwise upgrades are emitted on the registered server's `'upgrade'` event (or its `.server` property for Fastify). `upgradeDrainTimeout` defaults to `30000`.

### `createInterceptor(options)`

```ts
interface InterceptorOptions {
  meshId: string
  interceptorId?: string
  domain?: string
  connectTimeout?: number
  coordinatorThreadId?: number
  bootstrapTimeout?: number
  metadata?: unknown
  onRequest?: Hook | Hook[]
  allowTarget?: Hook | Hook[]
  onResponse?: Hook | Hook[]
  onResponseEnd?: Hook | Hook[]
  onError?: Hook | Hook[]
}
```

The returned value is both an Undici compose interceptor and an object with:

- `interceptorId`
- `ready`
- `close()`
- `updateMetadata(metadata)`
- `getMesh()`
- `createUpgradeAgent()` — a `node:http` `Agent` for routing upgrade requests from node:http clients (e.g. `ws`) through the mesh

`interceptorId` defaults to a `crypto.randomUUID()` value. `coordinatorThreadId` defaults to `0`.

## Diagnostics

Thread-mode requests publish Undici-compatible diagnostics channels:

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

WebSocket upgrade diagnostics (interceptor side):

- `undici-thread-interceptor:upgrade:start`
- `undici-thread-interceptor:upgrade:established`
- `undici-thread-interceptor:upgrade:rejected`
- `undici-thread-interceptor:upgrade:closed`

WebSocket upgrade diagnostics (server side):

- `undici-thread-interceptor:server:upgrade:start`
- `undici-thread-interceptor:server:upgrade:reject`
- `undici-thread-interceptor:server:upgrade:closed`

TCP targets are dispatched through Undici directly and do not emit synthetic thread-mode Undici request diagnostics.

## Errors

- `NoAvailableTargetError` is thrown when a domain exists in the mesh but no available target can serve it — for upgrades, that includes meshes where no target advertises the upgrade capability.
- `ConnectTimeoutError` is thrown when the interceptor times out waiting for a thread-mode response or a WebSocket handshake response, on both the dispatcher and `createUpgradeAgent()` paths.

## Migration

See [MIGRATION.md](./MIGRATION.md) for v1-to-v2 changes.

## License

MIT
