import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import diagnosticsChannel from 'node:diagnostics_channel'
import { once } from 'node:events'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { MessageChannel, Worker } from 'node:worker_threads'
import { request } from 'undici'

import { createCoordinator, createServer } from '../src/index.ts'
import { channels, getWrappedRequest, publishRequestHeaders } from '../src/diagnostics.ts'
import { Message } from '../src/protocol.ts'
import { createAgent, createMesh, createWorkerServer, waitForMeshServers, workerURL } from './helper.ts'

test('publishes undici diagnostics for thread-mode requests', async t => {
  const events: Array<{ channel: string; message: any }> = []
  subscribe(t, 'undici:request:create', events)
  subscribe(t, 'undici:request:headers', events)
  subscribe(t, 'undici:request:trailers', events)
  const { meshId, coordinatorThreadId } = await createMesh(t, 'diagnostics-request')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'diagnostics.local' })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:diagnostics.local', 1)

  const { statusCode, body } = await request('http://diagnostics.local', { dispatcher: agent })
  await body.json()

  strictEqual(statusCode, 200)
  const createEvent = events.find(event => event.channel === 'undici:request:create')?.message
  const headersEvent = events.find(event => event.channel === 'undici:request:headers')?.message
  const trailersEvent = events.find(event => event.channel === 'undici:request:trailers')?.message
  strictEqual(createEvent.request.method, 'GET')
  strictEqual(createEvent.request.path, '/')
  strictEqual(createEvent.request.host, 'diagnostics.local')
  strictEqual(headersEvent.request, createEvent.request)
  strictEqual(headersEvent.response.statusCode, 200)
  strictEqual(trailersEvent.request, createEvent.request)
  strictEqual(trailersEvent.request.completed, true)
})

test('publishes undici diagnostics errors for thread-mode request failures', async t => {
  const events: Array<{ channel: string; message: any }> = []
  subscribe(t, 'undici:request:error', events)
  const { meshId, coordinatorThreadId } = await createMesh(t, 'diagnostics-error')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'diagnostics-error.local' })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:diagnostics-error.local', 1)

  await request('http://diagnostics-error.local/error', { dispatcher: agent }).catch(() => {})

  const errorEvent = events.find(event => event.channel === 'undici:request:error')?.message
  strictEqual(errorEvent.request.path, '/error')
  strictEqual(errorEvent.error.message, 'kaboom')
})

test('skips synthetic undici diagnostics for tcp-mode targets', async t => {
  const events: Array<{ channel: string; message: any }> = []
  subscribe(t, 'undici:request:create', events)
  const app = await import('fastify').then(({ default: Fastify }) => Fastify())
  app.get('/', async () => ({ ok: true }))
  t.after(() => app.close())
  await app.listen({ port: 0 })
  const address = app.listeningOrigin
  const { meshId, coordinatorThreadId } = await createMesh(t, 'diagnostics-tcp')
  const server = createServer({
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'diagnostics-tcp.local',
    server: address
  })
  t.after(() => server.close())
  await server.ready
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:diagnostics-tcp.local', 1)

  const { statusCode, body } = await request('http://diagnostics-tcp.local', { dispatcher: agent })
  await body.json()

  strictEqual(statusCode, 200)
  ok(events.every(event => event.message.request.origin !== 'http://diagnostics-tcp.local'))
})

test('publishes mesh update diagnostics in the coordinator thread', async t => {
  const meshId = 'v2-diagnostics-mesh'
  const coordinator = new Worker(workerURL('coordinator.ts'), { workerData: { meshId, diagnostics: true } })
  t.after(() => coordinator.terminate())
  await once(coordinator, 'message')
  const server = await createWorkerServer(t, {
    meshId,
    coordinatorThreadId: coordinator.threadId,
    serverId: 'server-1',
    domain: 'diagnostics-mesh.local'
  })
  ok(server.threadId > 0)

  const [message] = (await waitForWorkerMessage(coordinator, value => {
    return value.type === 'diagnostics' && value.channel === 'mesh:update' && value.message.mesh.servers['server-1']
  })) as any[]
  strictEqual(message.message.meshId, meshId)
  strictEqual(message.message.mesh.servers['server-1'].origin, 'http:diagnostics-mesh.local')
})

test('publishes peer connect and disconnect diagnostics', async t => {
  const events: Array<{ channel: string; message: any }> = []
  subscribe(t, 'undici-thread-interceptor:peer:connect', events)
  subscribe(t, 'undici-thread-interceptor:peer:disconnect', events)
  const { meshId, coordinatorThreadId } = await createMesh(t, 'diagnostics-peer')
  const worker = await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'diagnostics-peer.local',
    diagnostics: true
  })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:diagnostics-peer.local', 1)

  const { body } = await request('http://diagnostics-peer.local', { dispatcher: agent })
  await body.text()
  await waitForDiagnosticsCount(worker, 'peer:connect', 1)
  strictEqual(
    events.find(event => event.channel === 'undici-thread-interceptor:peer:connect')?.message.serverId,
    'server-1'
  )
  strictEqual(worker.diagnostics.find(event => event.channel === 'peer:connect')?.message.serverId, 'server-1')

  interceptor.close()
  await waitForDiagnosticsCount(worker, 'peer:disconnect', 1)
  ok(
    events.some(
      event => event.channel === 'undici-thread-interceptor:peer:disconnect' && event.message.serverId === 'server-1'
    )
  )
})

test('publishes server diagnostics for thread-mode requests', async t => {
  const events: Array<{ channel: string; message: any }> = []
  subscribe(t, 'http.server.request.start', events)
  subscribe(t, 'http.server.response.finish', events)
  const meshId = 'v2-diagnostics-server'
  const coordinator = createCoordinator({ meshId })
  t.after(() => coordinator.destroy())
  const server = createServer({
    meshId,
    serverId: 'server-1',
    domain: 'diagnostics-server.local',
    server (_req: any, res: any) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ hello: 'world' }))
    }
  })
  t.after(() => server.close())
  await server.ready
  const { agent, interceptor } = await createAgent(t, meshId, 0)
  await waitForMeshServers(interceptor, 'http:diagnostics-server.local', 1)

  const { statusCode, body } = await request('http://diagnostics-server.local', { dispatcher: agent })
  await body.json()

  strictEqual(statusCode, 200)
  const start = events.find(event => event.channel === 'http.server.request.start')?.message
  const finish = events.find(event => event.channel === 'http.server.response.finish')?.message
  strictEqual(start.request.url, '/')
  strictEqual(start.request.headers.host, 'diagnostics-server.local')
  strictEqual(finish.request, start.request)
  strictEqual(finish.response.statusCode, 200)
})

test('converts array request and response headers in diagnostics payloads', async () => {
  const context: Record<PropertyKey, unknown> = {}
  const diagnosticRequest = {
    origin: 'http://diagnostics.local',
    method: 'GET',
    path: '/',
    headers: {
      accept: ['text/plain', 'application/json'],
      empty: undefined
    }
  }

  const wrapped = getWrappedRequest(diagnosticRequest, context)
  deepStrictEqual(wrapped.headers, ['accept', 'text/plain', 'accept', 'application/json'])

  const { promise, resolve } = Promise.withResolvers<{ response: { headers: Array<string | number> } }>()
  const subscriber = (message: unknown) => resolve(message as { response: { headers: Array<string | number> } })
  channels.requestHeaders.subscribe(subscriber)
  try {
    publishRequestHeaders(
      diagnosticRequest,
      { statusCode: 200, headers: { vary: ['accept', 'origin'], empty: undefined } },
      context
    )
  } finally {
    channels.requestHeaders.unsubscribe(subscriber)
  }

  const message = await promise
  deepStrictEqual(message.response.headers, ['vary', 'accept', 'vary', 'origin'])
})

test('converts missing response headers to an empty diagnostics header list', async () => {
  const context: Record<PropertyKey, unknown> = {}
  const diagnosticRequest = {
    origin: 'http://diagnostics.local',
    method: 'GET',
    path: '/',
    headers: {}
  }

  const { promise, resolve } = Promise.withResolvers<{ response: { headers: Array<string | number> } }>()
  const subscriber = (message: unknown) => resolve(message as { response: { headers: Array<string | number> } })
  channels.requestHeaders.subscribe(subscriber)
  try {
    publishRequestHeaders(diagnosticRequest, { statusCode: 204 }, context)
  } finally {
    channels.requestHeaders.unsubscribe(subscriber)
  }

  const message = await promise
  deepStrictEqual(message.response.headers, [])
})

test('wraps diagnostics requests with defaults and caches the wrapper', () => {
  const context: Record<PropertyKey, unknown> = {}
  const diagnosticRequest = {
    origin: new URL('https://Diagnostics.local/path'),
    path: '/path'
  }

  const wrapped = getWrappedRequest(diagnosticRequest, context)
  strictEqual(wrapped.origin, 'https://diagnostics.local/path')
  strictEqual(wrapped.method, 'GET')
  strictEqual(wrapped.host, 'diagnostics.local')
  strictEqual(wrapped.idempotent, true)
  strictEqual(wrapped.contentLength, null)
  strictEqual(wrapped.contentType, null)
  strictEqual(wrapped.body, null)
  strictEqual(getWrappedRequest(diagnosticRequest, context), wrapped)
})

test('publishes peer disconnect diagnostics from a direct server peer', async t => {
  const meshId = 'v2-diagnostics-direct-peer'
  const coordinator = createCoordinator({ meshId })
  t.after(() => coordinator.destroy())
  const server = createServer({
    meshId,
    serverId: 'server-1',
    domain: 'diagnostics-direct-peer.local',
    server (_req: any, res: any) {
      res.end('ok')
    }
  })
  t.after(() => server.close())
  await server.ready

  const peerDisconnect = Promise.withResolvers<unknown>()
  const subscriber = (message: unknown) => peerDisconnect.resolve(message)
  channels.peerDisconnect.subscribe(subscriber)
  const diagnosticsPeer = new MessageChannel()
  server.addPeer(diagnosticsPeer.port1, 'interceptor-1')
  diagnosticsPeer.port2.postMessage({ type: Message.PEER_DISCONNECT })
  await Promise.race([peerDisconnect.promise, sleep(20)])
  channels.peerDisconnect.unsubscribe(subscriber)
  diagnosticsPeer.port2.close()

  const closeEvent = Promise.withResolvers<unknown>()
  const closeSubscriber = (message: unknown) => closeEvent.resolve(message)
  channels.peerDisconnect.subscribe(closeSubscriber)
  const closingPeer = new MessageChannel()
  server.addPeer(closingPeer.port1, 'interceptor-2')
  closingPeer.port1.close()
  await Promise.race([closeEvent.promise, sleep(20)])
  channels.peerDisconnect.unsubscribe(closeSubscriber)
  closingPeer.port2.close()
})

function subscribe (t: test.TestContext, name: string, events: Array<{ channel: string; message: any }>): void {
  const channel = diagnosticsChannel.channel(name)
  const listener = (message: any) => events.push({ channel: name, message })
  channel.subscribe(listener)
  t.after(() => channel.unsubscribe(listener))
}

function waitForWorkerMessage (worker: Worker, predicate: (message: any) => boolean): Promise<any[]> {
  return new Promise(resolve => {
    const listener = (message: any) => {
      if (predicate(message)) {
        worker.off('message', listener)
        resolve([message])
      }
    }
    worker.on('message', listener)
  })
}

async function waitForDiagnosticsCount (
  worker: Worker & { diagnostics: Array<{ channel: string; message: any }> },
  channel: string,
  count: number
): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (worker.diagnostics.filter(event => event.channel === channel).length >= count) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }

  throw new Error(`worker did not collect ${count} ${channel} diagnostics events`)
}
