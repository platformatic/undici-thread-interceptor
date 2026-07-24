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
  interceptor.close()
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

The connection is tunneled between threads over a dedicated `MessagePort` as raw bytes: the server performs its real handshake, so subprotocols, ping/pong, close codes, and `permessage-deflate` behave exactly as over TCP. TCP targets upgrade over their real address. Routing, `allowTarget` hooks, and `connectTimeout` apply to upgrades the same way they apply to requests.

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

`server.close()` drains established connections: it waits up to `upgradeDrainTimeout` milliseconds (default `30000`) for them to close on their own, then destroys the remainder. Use `0` to destroy them immediately. Paused servers keep established connections but reject new upgrades. `CONNECT` requests to mesh targets are rejected.

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

## Metadata

Servers and interceptors can publish arbitrary metadata into the mesh:

```js
const server = createServer({
  meshId: 'app',
  domain: 'api.local',
  server: app,
  metadata: { region: 'eu-west-1' }
})

server.updateMetadata({ region: 'eu-west-1', disabled: true })
```

Interceptor target hooks can use server metadata for routing decisions.

## Lifecycle

Servers can be paused, resumed, replaced, and closed:

```js
server.pause()
server.resume()
server.replaceServer(nextApp)
server.updateMetadata(nextMetadata)
server.close().catch(error => {
  throw error
})
```

Paused servers remain visible in mesh snapshots but are skipped by selection. Closing a server removes it from the mesh immediately, then drains queued and in-flight thread-mode requests.

Interceptors expose lifecycle and mesh inspection helpers:

```js
interceptor.ready
  .then(() => {
    console.log(interceptor.interceptorId)
    console.log(interceptor.getMesh())
    interceptor.updateMetadata({ role: 'client' })
    interceptor.close()
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

- `NoAvailableTargetError` is thrown when a domain exists in the mesh but no available target can serve it.
- `ConnectTimeoutError` is thrown when the interceptor times out waiting for a thread-mode response.

## Migration

See [MIGRATION.md](./MIGRATION.md) for v1-to-v2 changes.

## License

MIT
