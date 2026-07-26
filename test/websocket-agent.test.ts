// The upgrade agent makes node:http-based WebSocket clients (the ws package,
// and therefore @fastify/http-proxy's WebSocket proxying) work against mesh
// targets: interceptor.createUpgradeAgent() is a node:http Agent whose
// connections parse the outgoing request head, convert it to an UPGRADE
// message, and become a direct inter-thread pipe.
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert'
import { once } from 'node:events'
import { createServer as createHttpServer, get as httpGet, type Server as HttpServer } from 'node:http'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'
import proxyPlugin from '@fastify/http-proxy'
import Fastify from 'fastify'
import { WebSocket as UndiciWebSocket, type Dispatcher } from 'undici'
import { WebSocket as WsClient, WebSocketServer } from 'ws'

import { createInterceptor, createServer, type InterceptorFunction } from '../src/index.ts'
import { createAgent, createMesh, waitForMeshServers, workerURL } from './helper.ts'

async function createWebSocketWorker (
  t: test.TestContext,
  options: {
    meshId: string
    coordinatorThreadId: number
    serverId: string
    domain: string
    kind?: 'echo' | 'path-restricted' | 'handler-only' | 'blackhole'
    paused?: boolean
  }
): Promise<Worker> {
  const worker = new Worker(workerURL('websocket-worker.ts'), { workerData: options })
  t.after(() => worker.terminate())
  await once(worker, 'message')
  return worker
}

async function setupMesh (
  t: test.TestContext,
  name: string,
  workerOptions: { kind?: 'echo' | 'path-restricted' | 'handler-only' | 'blackhole'; paused?: boolean } = {}
): Promise<{ interceptor: InterceptorFunction; agent: Dispatcher }> {
  const { meshId, coordinatorThreadId } = await createMesh(t, name)
  await createWebSocketWorker(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'ws-1',
    domain: 'myserver.local',
    ...workerOptions
  })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:myserver.local', 1)
  return { interceptor, agent }
}

function wsEcho (t: test.TestContext, ws: WsClient): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.on('error', reject)
    ws.on('open', () => ws.send('through the agent'))
    ws.on('message', (data, isBinary) => {
      try {
        strictEqual(isBinary, false)
        strictEqual(data.toString(), 'through the agent')
      } catch (error) {
        reject(error)
        return
      }

      ws.on('close', code => {
        strictEqual(code, 1000)
        resolve()
      })
      ws.close(1000)
    })
  })
}

async function listenWebSocketEcho (t: test.TestContext): Promise<{ httpServer: HttpServer; port: number }> {
  const httpServer = createHttpServer()
  const wss = new WebSocketServer({ server: httpServer })

  wss.on('connection', socket => {
    socket.on('message', (data, isBinary) => socket.send(data as Buffer, { binary: isBinary }))
  })

  httpServer.listen(0, '127.0.0.1')
  await once(httpServer, 'listening')
  t.after(() => {
    wss.close()
    httpServer.close()
  })

  return { httpServer, port: (httpServer.address() as { port: number }).port }
}

test('ws client connects to a worker server through the upgrade agent', async t => {
  const { interceptor } = await setupMesh(t, 'ws-agent-echo')

  const ws = new WsClient('ws://myserver.local/', { agent: interceptor.createUpgradeAgent() })
  await wsEcho(t, ws)
})

test('ws client binary payloads round-trip through the upgrade agent', async t => {
  const { interceptor } = await setupMesh(t, 'ws-agent-binary')

  const ws = new WsClient('ws://myserver.local/', { agent: interceptor.createUpgradeAgent() })
  await once(ws, 'open')

  const payload = Buffer.from([0, 1, 2, 3, 255])
  ws.send(payload)
  const [data, isBinary] = await once(ws, 'message')
  strictEqual(isBinary, true)
  deepStrictEqual(Buffer.from(data), payload)

  const closed = once(ws, 'close')
  ws.close(1000)
  await closed
})

test('upgrade agent falls back to TCP for non-mesh hosts', async t => {
  const { interceptor } = await setupMesh(t, 'ws-agent-fallback')
  const { port } = await listenWebSocketEcho(t)

  const ws = new WsClient(`ws://127.0.0.1:${port}/`, { agent: interceptor.createUpgradeAgent() })
  await wsEcho(t, ws)
})

test('upgrade agent routes ws clients to TCP mesh targets', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'ws-agent-tcp')
  const { port } = await listenWebSocketEcho(t)

  const server = createServer({
    meshId,
    coordinatorThreadId,
    domain: 'tcp.local',
    server: `http://127.0.0.1:${port}`
  })
  await server.ready
  t.after(() => server.close())

  const { interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:tcp.local', 1)

  const ws = new WsClient('ws://tcp.local/', { agent: interceptor.createUpgradeAgent() })
  await wsEcho(t, ws)
})

test('upgrade agent responds 503 when no target can serve the upgrade', async t => {
  const { interceptor } = await setupMesh(t, 'ws-agent-503', { paused: true })

  const ws = new WsClient('ws://myserver.local/', { agent: interceptor.createUpgradeAgent() })
  const [error] = await once(ws, 'error')
  match((error as Error).message, /Unexpected server response: 503/)
})

test('upgrade agent applies connectTimeout to unresponsive targets', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'ws-agent-timeout')
  await createWebSocketWorker(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'ws-1',
    domain: 'myserver.local',
    kind: 'blackhole'
  })

  const interceptor = createInterceptor({ meshId, coordinatorThreadId, domain: '.local', connectTimeout: 300 })
  t.after(() => interceptor.close())
  await interceptor.ready
  await waitForMeshServers(interceptor, 'http:myserver.local', 1)

  const ws = new WsClient('ws://myserver.local/', { agent: interceptor.createUpgradeAgent() })
  const [error] = await once(ws, 'error')
  ok(error instanceof Error)
})

test('non-upgrade requests through the upgrade agent get a 501', async t => {
  const { interceptor } = await setupMesh(t, 'ws-agent-501')

  const statusCode = await new Promise<number>((resolve, reject) => {
    const request = httpGet(
      { host: 'myserver.local', path: '/', agent: interceptor.createUpgradeAgent() },
      response => {
        response.resume()
        resolve(response.statusCode ?? 0)
      }
    )
    request.on('error', reject)
  })

  strictEqual(statusCode, 501)
})

test('@fastify/http-proxy proxies websockets into the mesh', async t => {
  const { interceptor, agent } = await setupMesh(t, 'ws-agent-proxy')

  const proxy = Fastify()
  await proxy.register(proxyPlugin, {
    upstream: 'http://myserver.local',
    websocket: true,
    wsClientOptions: { agent: interceptor.createUpgradeAgent() } as any,
    undici: agent as any
  })
  await proxy.listen({ port: 0, host: '127.0.0.1' })
  t.after(() => proxy.close())
  const port = (proxy.server.address() as { port: number }).port

  // A plain undici WebSocket over real TCP to the proxy, which relays into
  // the mesh through the ws client + upgrade agent.
  const ws = new UndiciWebSocket(`ws://127.0.0.1:${port}/`)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', (event: any) => reject(event.error ?? new Error(event.message)), { once: true })
  })

  ws.send('proxied into the mesh')
  const [message] = await once(ws as any, 'message')
  strictEqual(message.data, 'proxied into the mesh')

  const closed = once(ws as any, 'close')
  ws.close(1000)
  await closed

  // The HTTP path continues to work through the same proxy via undici.
  const response = await fetch(`http://127.0.0.1:${port}/`)
  strictEqual(response.status, 200)
  deepStrictEqual(await response.json(), { hello: 'http' })
})

test('undici dispatch path is unaffected by upgrade agent usage', async t => {
  const { interceptor, agent } = await setupMesh(t, 'ws-agent-mixed')

  const ws = new WsClient('ws://myserver.local/', { agent: interceptor.createUpgradeAgent() })
  await wsEcho(t, ws)

  const response = await (agent as any).request({ origin: 'http://myserver.local', path: '/', method: 'GET' })
  strictEqual(response.statusCode, 200)
  await response.body.text()
})
