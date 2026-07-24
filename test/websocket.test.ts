import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert'
import diagnosticsChannel from 'node:diagnostics_channel'
import { once } from 'node:events'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { MessageChannel, Worker, type MessagePort } from 'node:worker_threads'
import { Agent, getGlobalDispatcher, setGlobalDispatcher, WebSocket } from 'undici'
import { WebSocketServer } from 'ws'

import {
  ConnectTimeoutError,
  createCoordinator,
  createInterceptor,
  createServer,
  NoAvailableTargetError,
  type InterceptorFunction
} from '../src/index.ts'
import { Message } from '../src/protocol.ts'
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
    upgradeDrainTimeout?: number
  }
): Promise<Worker> {
  const worker = new Worker(workerURL('websocket-worker.ts'), { workerData: options })
  t.after(() => worker.terminate())
  await once(worker, 'message')
  return worker
}

function waitForClosed (worker: Worker): Promise<void> {
  return new Promise(resolve => {
    worker.on('message', (message: { type?: string }) => {
      if (message.type === 'closed') {
        resolve()
      }
    })
  })
}

async function waitForUpgradeCapability (
  interceptor: InterceptorFunction,
  serverId: string,
  value: boolean
): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (interceptor.getMesh()?.servers[serverId]?.capabilities?.upgrade === value) {
      return
    }
    await sleep(20)
  }
  throw new Error(`server ${serverId} did not reach upgrade capability ${value}`)
}

function waitForOpen (ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener(
      'error',
      (event: any) => reject(event.error ?? new Error(event.message ?? 'websocket error')),
      { once: true }
    )
  })
}

function waitForFailure (ws: WebSocket): Promise<Error> {
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => reject(new Error('expected the websocket to fail')), { once: true })
    ws.addEventListener('error', (event: any) => resolve(event.error ?? new Error(event.message)), { once: true })
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

test('routes websocket connections to a worker server', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'ws-echo')
  await createWebSocketWorker(t, { meshId, coordinatorThreadId, serverId: 'ws-1', domain: 'myserver.local' })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:myserver.local', 1)

  const ws = new WebSocket('ws://myserver.local/echo', { dispatcher: agent })
  ws.binaryType = 'arraybuffer'
  await waitForOpen(ws)

  ws.send('hello mesh')
  const [text] = await once(ws, 'message')
  strictEqual(text.data, 'hello mesh')

  const payload = Buffer.from([0, 1, 2, 3, 255])
  ws.send(payload)
  const [binary] = await once(ws, 'message')
  deepStrictEqual(Buffer.from(binary.data), payload)

  const closed = once(ws, 'close')
  ws.close(1000, 'done')
  const [closeEvent] = await closed
  strictEqual(closeEvent.code, 1000)
  strictEqual(closeEvent.reason, 'done')
})

test('round-robins websocket connections across worker servers', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'ws-rr')
  await createWebSocketWorker(t, { meshId, coordinatorThreadId, serverId: 'ws-a', domain: 'myserver.local' })
  await createWebSocketWorker(t, { meshId, coordinatorThreadId, serverId: 'ws-b', domain: 'myserver.local' })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:myserver.local', 2)

  const seen = new Map<string, number>()

  for (let i = 0; i < 4; i++) {
    const ws = new WebSocket('ws://myserver.local/', { dispatcher: agent })
    await waitForOpen(ws)
    ws.send('whoami')
    const [message] = await once(ws, 'message')
    const { serverId } = JSON.parse(message.data)
    seen.set(serverId, (seen.get(serverId) ?? 0) + 1)
    const closed = once(ws, 'close')
    ws.close(1000)
    await closed
  }

  strictEqual(seen.size, 2)
  strictEqual(seen.get('ws-a'), 2)
  strictEqual(seen.get('ws-b'), 2)
})

test('replays handshake rejections as regular HTTP responses', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'ws-reject')
  await createWebSocketWorker(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'ws-1',
    domain: 'myserver.local',
    kind: 'path-restricted'
  })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:myserver.local', 1)

  // ws only accepts upgrades on /ws in this fixture; /nope gets a 400.
  const failing = new WebSocket('ws://myserver.local/nope', { dispatcher: agent })
  const error = await waitForFailure(failing)
  ok(error instanceof Error)

  // agent.upgrade surfaces the non-101 response as undici's own bad-upgrade error.
  await rejects(agent.upgrade({ origin: 'http://myserver.local', path: '/nope', protocol: 'websocket' }), {
    message: 'bad upgrade'
  })

  // The matching path still upgrades fine afterwards.
  const working = new WebSocket('ws://myserver.local/ws', { dispatcher: agent })
  await waitForOpen(working)
  const closed = once(working, 'close')
  working.close(1000)
  await closed
})

test('websocket upgrade fails with NoAvailableTargetError when all targets are paused', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'ws-paused')
  await createWebSocketWorker(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'ws-1',
    domain: 'myserver.local',
    paused: true
  })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:myserver.local', 1)

  await rejects(
    agent.upgrade({ origin: 'http://myserver.local', path: '/', protocol: 'websocket' }),
    NoAvailableTargetError
  )
})

test('websocket upgrades for absent domains are delegated to undici', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'ws-delegate')
  const { agent } = await createAgent(t, meshId, coordinatorThreadId)
  const { port } = await listenWebSocketEcho(t)

  const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { dispatcher: agent })
  await waitForOpen(ws)

  ws.send('through tcp')
  const [message] = await once(ws, 'message')
  strictEqual(message.data, 'through tcp')

  const closed = once(ws, 'close')
  ws.close(1000)
  await closed
})

test('routes websocket connections to TCP targets', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'ws-tcp')
  const { port } = await listenWebSocketEcho(t)

  const server = createServer({
    meshId,
    coordinatorThreadId,
    domain: 'tcp.local',
    server: `http://127.0.0.1:${port}`
  })
  await server.ready
  t.after(() => server.close())

  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:tcp.local', 1)

  const ws = new WebSocket('ws://tcp.local/', { dispatcher: agent })
  await waitForOpen(ws)

  ws.send('tcp target')
  const [message] = await once(ws, 'message')
  strictEqual(message.data, 'tcp target')

  const closed = once(ws, 'close')
  ws.close(1000)
  await closed
})

test('websocket upgrade fails with NoAvailableTargetError when no target can upgrade', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'ws-no-capability')
  await createWebSocketWorker(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'ws-1',
    domain: 'myserver.local',
    kind: 'handler-only'
  })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:myserver.local', 1)

  // The bare-handler target advertises capabilities.upgrade: false, so
  // selection skips it entirely instead of tunneling into a 501.
  strictEqual(interceptor.getMesh()?.servers['ws-1'].capabilities?.upgrade, false)

  await rejects(
    agent.upgrade({ origin: 'http://myserver.local', path: '/', protocol: 'websocket' }),
    NoAvailableTargetError
  )

  // Regular HTTP requests still reach the target.
  const response = await agent.request({ origin: 'http://myserver.local', path: '/', method: 'GET' })
  strictEqual(response.statusCode, 200)
  await response.body.text()
})

test('upgrades skip non-capable targets while HTTP requests use all of them', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'ws-mixed')
  await createWebSocketWorker(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'ws-plain',
    domain: 'myserver.local',
    kind: 'handler-only'
  })
  await createWebSocketWorker(t, { meshId, coordinatorThreadId, serverId: 'ws-echo', domain: 'myserver.local' })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:myserver.local', 2)

  for (let i = 0; i < 4; i++) {
    const ws = new WebSocket('ws://myserver.local/', { dispatcher: agent })
    await waitForOpen(ws)
    ws.send('whoami')
    const [message] = await once(ws, 'message')
    strictEqual(JSON.parse(message.data).serverId, 'ws-echo')
    const closed = once(ws, 'close')
    ws.close(1000)
    await closed
  }

  const bodies = new Set<string>()
  for (let i = 0; i < 4; i++) {
    const response = await agent.request({ origin: 'http://myserver.local', path: '/', method: 'GET' })
    bodies.add(await response.body.text())
  }
  strictEqual(bodies.size, 2)
})

test('websocket upgrade honors connectTimeout', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'ws-timeout')
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
  const agent = new Agent().compose(interceptor)

  await rejects(
    agent.upgrade({ origin: 'http://myserver.local', path: '/', protocol: 'websocket' }),
    ConnectTimeoutError
  )
})

test('CONNECT requests to mesh targets are rejected', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'ws-connect')
  await createWebSocketWorker(t, { meshId, coordinatorThreadId, serverId: 'ws-1', domain: 'myserver.local' })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:myserver.local', 1)

  await rejects(agent.connect({ origin: 'http://myserver.local', path: '/' }), {
    message: 'CONNECT is not supported for mesh targets'
  })
})

test('same-thread mesh serves websockets', async t => {
  const meshId = `v2-ws-same-thread-${Date.now()}`
  const coordinator = createCoordinator({ meshId })
  t.after(() => coordinator.destroy())

  const httpServer = createHttpServer()
  const wss = new WebSocketServer({ server: httpServer })
  wss.on('connection', socket => {
    socket.on('message', (data, isBinary) => socket.send(data as Buffer, { binary: isBinary }))
  })
  t.after(() => wss.close())

  const server = createServer({ meshId, domain: 'same.local', server: httpServer })
  await server.ready
  t.after(() => server.close())

  const interceptor = createInterceptor({ meshId, domain: '.local' })
  await interceptor.ready
  t.after(() => interceptor.close())
  await waitForMeshServers(interceptor, 'http:same.local', 1)
  const agent = new Agent().compose(interceptor)

  const ws = new WebSocket('ws://same.local/', { dispatcher: agent })
  await waitForOpen(ws)

  ws.send('same thread')
  const [message] = await once(ws, 'message')
  strictEqual(message.data, 'same thread')

  const closed = once(ws, 'close')
  ws.close(1000)
  await closed
})

test('routes the global WebSocket through the mesh via setGlobalDispatcher', async t => {
  const meshId = `v2-ws-global-${Date.now()}`
  const coordinator = createCoordinator({ meshId })
  t.after(() => coordinator.destroy())

  const httpServer = createHttpServer()
  const wss = new WebSocketServer({ server: httpServer })
  wss.on('connection', socket => {
    socket.on('message', (data, isBinary) => socket.send(data as Buffer, { binary: isBinary }))
  })
  t.after(() => wss.close())

  const server = createServer({ meshId, domain: 'global.local', server: httpServer })
  await server.ready
  t.after(() => server.close())

  const interceptor = createInterceptor({ meshId, domain: '.local' })
  await interceptor.ready
  t.after(() => interceptor.close())
  await waitForMeshServers(interceptor, 'http:global.local', 1)

  // Node's bundled WebSocket resolves the dispatcher through the shared
  // Symbol.for global registry, so the npm-undici setGlobalDispatcher is
  // visible to it (bridged through Dispatcher1Wrapper on older Node).
  const previousDispatcher = getGlobalDispatcher()
  setGlobalDispatcher(new Agent().compose(interceptor) as any)
  t.after(() => setGlobalDispatcher(previousDispatcher))

  const ws = new globalThis.WebSocket('ws://global.local/')
  await waitForOpen(ws as unknown as WebSocket)

  ws.send('global client')
  const [message] = await once(ws as any, 'message')
  strictEqual(message.data, 'global client')

  const closed = once(ws as any, 'close')
  ws.close(1000)
  await closed
})

test('interceptor hooks observe websocket upgrades and allowTarget steers them', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'ws-hooks')
  await createWebSocketWorker(t, { meshId, coordinatorThreadId, serverId: 'ws-a', domain: 'myserver.local' })
  await createWebSocketWorker(t, { meshId, coordinatorThreadId, serverId: 'ws-b', domain: 'myserver.local' })

  const requests: string[] = []
  const responses: number[] = []

  const interceptor = createInterceptor({
    meshId,
    coordinatorThreadId,
    domain: '.local',
    onRequest: req => {
      requests.push(`${req.method} ${req.upgrade}`)
    },
    allowTarget: (_req, target) => target.serverId !== 'ws-a',
    onResponse: (_req, res) => {
      responses.push(res.statusCode)
    }
  })
  t.after(() => interceptor.close())
  await interceptor.ready
  await waitForMeshServers(interceptor, 'http:myserver.local', 2)
  const agent = new Agent().compose(interceptor)

  for (let i = 0; i < 2; i++) {
    const ws = new WebSocket('ws://myserver.local/', { dispatcher: agent })
    await waitForOpen(ws)
    ws.send('whoami')
    const [message] = await once(ws, 'message')
    strictEqual(JSON.parse(message.data).serverId, 'ws-b')
    const closed = once(ws, 'close')
    ws.close(1000)
    await closed
  }

  deepStrictEqual(requests, ['GET websocket', 'GET websocket'])
  deepStrictEqual(responses, [101, 101])
})

test('interceptor close destroys established websockets', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'ws-interceptor-close')
  await createWebSocketWorker(t, { meshId, coordinatorThreadId, serverId: 'ws-1', domain: 'myserver.local' })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:myserver.local', 1)

  const ws = new WebSocket('ws://myserver.local/', { dispatcher: agent })
  ws.addEventListener('error', () => {})
  await waitForOpen(ws)

  const closed = once(ws, 'close')
  interceptor.close()
  const [closeEvent] = await closed
  strictEqual(closeEvent.code, 1006)
})

async function collectInBandResponse (port: MessagePort): Promise<Buffer> {
  const chunks: Buffer[] = []

  return new Promise(resolve => {
    port.on('message', (control: { chunks?: unknown[]; fin?: boolean }) => {
      if (Array.isArray(control.chunks)) {
        for (const chunk of control.chunks) {
          chunks.push(Buffer.from(chunk as Uint8Array))
        }
        // Grant write credit, as the interceptor side would.
        port.postMessage({ more: true })
      }

      if (control.fin) {
        resolve(Buffer.concat(chunks))
      }
    })
  })
}

function postUpgrade (port: MessagePort, meshId: string, socketPort: MessagePort): void {
  port.postMessage(
    {
      type: Message.UPGRADE,
      id: 'upgrade-1',
      meshId,
      interceptorId: 'test-interceptor',
      origin: 'http:inband.local',
      path: '/',
      method: 'GET',
      protocol: 'websocket',
      headers: {},
      socketPort
    },
    [socketPort]
  )
}

test('paused servers reject upgrades in-band with 503', async t => {
  const rejections: any[] = []
  const listener = (payload: unknown): number => rejections.push(payload)
  diagnosticsChannel.subscribe('undici-thread-interceptor:server:upgrade:reject', listener)
  t.after(() => diagnosticsChannel.unsubscribe('undici-thread-interceptor:server:upgrade:reject', listener))

  const { meshId, coordinatorThreadId } = await createMesh(t, 'ws-inband-503')
  const server = createServer({
    meshId,
    coordinatorThreadId,
    domain: 'inband.local',
    server: createHttpServer(),
    paused: true
  })
  await server.ready
  t.after(() => server.close())

  const peerChannel = new MessageChannel()
  server.addPeer(peerChannel.port2)
  t.after(() => peerChannel.port1.close())
  const socketChannel = new MessageChannel()

  const response = collectInBandResponse(socketChannel.port1)
  postUpgrade(peerChannel.port1, meshId, socketChannel.port2)

  ok((await response).toString().startsWith('HTTP/1.1 503 Service Unavailable'))
  strictEqual(rejections.length, 1)
  strictEqual(rejections[0].statusCode, 503)
  strictEqual(rejections[0].serverId, server.serverId)
})

test('servers without an upgrade target reject upgrades in-band with 501', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'ws-inband-501')
  const server = createServer({
    meshId,
    coordinatorThreadId,
    domain: 'inband.local',
    server: (_req: any, res: any) => res.end('plain')
  })
  await server.ready
  t.after(() => server.close())

  const peerChannel = new MessageChannel()
  server.addPeer(peerChannel.port2)
  t.after(() => peerChannel.port1.close())
  const socketChannel = new MessageChannel()

  const response = collectInBandResponse(socketChannel.port1)
  postUpgrade(peerChannel.port1, meshId, socketChannel.port2)

  ok((await response).toString().startsWith('HTTP/1.1 501 Not Implemented'))
})

test('server close waits for websockets to close on their own', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'ws-drain-wait')
  const worker = await createWebSocketWorker(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'ws-1',
    domain: 'myserver.local'
  })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:myserver.local', 1)

  const ws = new WebSocket('ws://myserver.local/', { dispatcher: agent })
  ws.addEventListener('error', () => {})
  await waitForOpen(ws)

  const workerClosed = waitForClosed(worker)
  worker.postMessage('close')
  await sleep(150)

  // The connection is still alive mid-drain; the client hangs up cleanly.
  const closed = once(ws, 'close')
  ws.close(1000, 'client done')
  const [closeEvent] = await closed
  strictEqual(closeEvent.code, 1000)

  await workerClosed
})

test('server close destroys websockets after upgradeDrainTimeout', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'ws-drain-timeout')
  const worker = await createWebSocketWorker(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'ws-1',
    domain: 'myserver.local',
    upgradeDrainTimeout: 300
  })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:myserver.local', 1)

  const ws = new WebSocket('ws://myserver.local/', { dispatcher: agent })
  ws.addEventListener('error', () => {})
  await waitForOpen(ws)

  const workerClosed = waitForClosed(worker)
  const closed = once(ws, 'close')
  worker.postMessage('close')

  const [closeEvent] = await closed
  strictEqual(closeEvent.code, 1006)
  await workerClosed
})

test('upgradeDrainTimeout 0 destroys websockets immediately on close', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'ws-drain-zero')
  const worker = await createWebSocketWorker(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'ws-1',
    domain: 'myserver.local',
    upgradeDrainTimeout: 0
  })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:myserver.local', 1)

  const ws = new WebSocket('ws://myserver.local/', { dispatcher: agent })
  ws.addEventListener('error', () => {})
  await waitForOpen(ws)

  const workerClosed = waitForClosed(worker)
  const closed = once(ws, 'close')
  worker.postMessage('close')

  const [closeEvent] = await closed
  strictEqual(closeEvent.code, 1006)
  await workerClosed
})

test('replaceServer updates the upgrade capability in the mesh', async t => {
  const meshId = `v2-ws-replace-${Date.now()}`
  const coordinator = createCoordinator({ meshId })
  t.after(() => coordinator.destroy())

  const server = createServer({ meshId, domain: 'replace.local', server: (_req: any, res: any) => res.end('x') })
  await server.ready
  t.after(() => server.close())

  const interceptor = createInterceptor({ meshId, domain: '.local' })
  await interceptor.ready
  t.after(() => interceptor.close())
  await waitForMeshServers(interceptor, 'http:replace.local', 1)

  strictEqual(interceptor.getMesh()?.servers[server.serverId]?.capabilities?.upgrade, false)
  const agent = new Agent().compose(interceptor)
  await rejects(
    agent.upgrade({ origin: 'http://replace.local', path: '/', protocol: 'websocket' }),
    NoAvailableTargetError
  )

  const httpServer = createHttpServer()
  const wss = new WebSocketServer({ server: httpServer })
  wss.on('connection', socket => {
    socket.on('message', (data, isBinary) => socket.send(data as Buffer, { binary: isBinary }))
  })
  t.after(() => wss.close())

  server.replaceServer(httpServer)
  await waitForUpgradeCapability(interceptor, server.serverId, true)

  const ws = new WebSocket('ws://replace.local/', { dispatcher: agent })
  await waitForOpen(ws)
  ws.send('upgraded')
  const [message] = await once(ws, 'message')
  strictEqual(message.data, 'upgraded')

  const closed = once(ws, 'close')
  ws.close(1000)
  await closed
})

test('publishes upgrade diagnostics on both sides', async t => {
  const events: Array<{ channel: string; payload: any }> = []
  const channelNames = [
    'undici-thread-interceptor:upgrade:start',
    'undici-thread-interceptor:upgrade:established',
    'undici-thread-interceptor:upgrade:rejected',
    'undici-thread-interceptor:upgrade:closed',
    'undici-thread-interceptor:server:upgrade:start',
    'undici-thread-interceptor:server:upgrade:closed'
  ]
  const listeners = channelNames.map(name => {
    const listener = (payload: unknown) => events.push({ channel: name, payload })
    diagnosticsChannel.subscribe(name, listener)
    return { name, listener }
  })
  t.after(() => {
    for (const { name, listener } of listeners) {
      diagnosticsChannel.unsubscribe(name, listener)
    }
  })

  const meshId = `v2-ws-diagnostics-${Date.now()}`
  const coordinator = createCoordinator({ meshId })
  t.after(() => coordinator.destroy())

  const httpServer = createHttpServer()
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' })
  wss.on('connection', socket => {
    socket.on('message', (data, isBinary) => socket.send(data as Buffer, { binary: isBinary }))
  })
  t.after(() => wss.close())

  const server = createServer({ meshId, domain: 'diag.local', server: httpServer })
  await server.ready
  t.after(() => server.close())

  const interceptor = createInterceptor({ meshId, domain: '.local' })
  await interceptor.ready
  t.after(() => interceptor.close())
  await waitForMeshServers(interceptor, 'http:diag.local', 1)
  const agent = new Agent().compose(interceptor)

  const ws = new WebSocket('ws://diag.local/ws', { dispatcher: agent })
  await waitForOpen(ws)
  const closed = once(ws, 'close')
  ws.close(1000)
  await closed

  const rejectedWs = new WebSocket('ws://diag.local/nope', { dispatcher: agent })
  await waitForFailure(rejectedWs)

  for (let i = 0; i < 50 && new Set(events.map(e => e.channel)).size < channelNames.length; i++) {
    await sleep(20)
  }

  const byChannel = (channel: string): any[] =>
    events.filter(event => event.channel === `undici-thread-interceptor:${channel}`).map(event => event.payload)

  deepStrictEqual(new Set(events.map(event => event.channel)), new Set(channelNames))

  const established = byChannel('upgrade:established')
  strictEqual(established.length, 1)
  strictEqual(established[0].statusCode, 101)
  strictEqual(established[0].serverId, server.serverId)
  strictEqual(established[0].meshId, meshId)
  strictEqual(established[0].path, '/ws')

  const rejected = byChannel('upgrade:rejected')
  strictEqual(rejected.length, 1)
  strictEqual(rejected[0].statusCode, 400)
  strictEqual(rejected[0].path, '/nope')

  // Both connections reach the server-side emitter; ws rejects /nope itself.
  const serverStart = byChannel('server:upgrade:start')
  deepStrictEqual(serverStart.map(payload => payload.request.url).sort(), ['/nope', '/ws'])
  strictEqual(serverStart[0].interceptorId, interceptor.interceptorId)
})

test('multiple websockets to the same worker share one peer channel', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'ws-multi')
  await createWebSocketWorker(t, { meshId, coordinatorThreadId, serverId: 'ws-1', domain: 'myserver.local' })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:myserver.local', 1)

  const sockets = await Promise.all(
    Array.from({ length: 5 }, async (_, i) => {
      const ws = new WebSocket('ws://myserver.local/', { dispatcher: agent })
      await waitForOpen(ws)
      ws.send(`hello ${i}`)
      const [message] = await once(ws, 'message')
      strictEqual(message.data, `hello ${i}`)
      return ws
    })
  )

  strictEqual(sockets.length, 5)

  await Promise.all(
    sockets.map(ws => {
      const closed = once(ws, 'close')
      ws.close(1000)
      return closed
    })
  )
})
