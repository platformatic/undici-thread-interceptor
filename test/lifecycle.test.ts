import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert'
import { once } from 'node:events'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { MessageChannel, threadId, type MessagePort } from 'node:worker_threads'
import Fastify from 'fastify'
import { Agent, request } from 'undici'

import { Coordinator, createCoordinator, createInterceptor, createServer } from '../src/index.ts'
import { Message, type CoordinatorConnectMessage, type State } from '../src/protocol.ts'
import {
  createAgent,
  createMesh,
  createWorkerServer,
  waitForMeshServerAddress,
  waitForMeshServerCount,
  waitForMeshOriginRemoved,
  waitForMeshServers,
  requestWithTimeout
} from './helper.ts'

let directCounter = 0

function directMeshId (name: string): string {
  return `v2-lifecycle-direct-${name}-${directCounter++}`
}

function connectServer (
  coordinator: Coordinator,
  id: string,
  state: State = 'available'
): { local: MessagePort; remote: MessagePort } {
  const channel = new MessageChannel()
  coordinator.connectMember({
    type: Message.COORDINATOR_CONNECT,
    operationId: `connect-${id}`,
    meshId: coordinator.getMesh().meshId,
    role: 'server',
    threadId,
    port: channel.port1,
    server: {
      id,
      origin: `http:${id}.local`,
      state,
      mode: 'thread'
    }
  })
  return { local: channel.port1, remote: channel.port2 }
}

test('removes a worker server from the mesh when it exits', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'worker-exit')
  const worker = await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'gone.local'
  })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:gone.local', 1)

  const { statusCode, body } = await request('http://gone.local', { dispatcher: agent })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'world' })

  await worker.terminate()
  await waitForMeshOriginRemoved(interceptor, 'http:gone.local')

  await rejects(request('http://gone.local', { dispatcher: agent }))
})

test('replaces a worker server implementation and validates replacement input', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'replace-server')
  const worker = await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'replace.local'
  })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:replace.local', 1)

  {
    const { body } = await request('http://replace.local', { dispatcher: agent })
    deepStrictEqual(await body.json(), { hello: 'world' })
  }

  worker.postMessage('replace-server')
  await once(worker, 'message')

  {
    const { body } = await request('http://replace.local', { dispatcher: agent })
    deepStrictEqual(await body.json(), { hello: 'replaced' })
  }

  worker.postMessage('replace-server-invalid')
  const [{ message }] = (await once(worker, 'message')) as Array<{ message: string }>
  strictEqual(message, 'server argument is required')
})

test('closes and re-adds a server for the same origin', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'close-read')
  const first = await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'read.local',
    message: 'first'
  })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:read.local', 1)

  {
    const { body } = await request('http://read.local', { dispatcher: agent })
    deepStrictEqual(await body.json(), { hello: 'first' })
  }

  first.postMessage('close')
  await once(first, 'message')
  await waitForMeshOriginRemoved(interceptor, 'http:read.local')

  await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server:2',
    domain: 'read.local',
    message: 'second'
  })
  await waitForMeshServers(interceptor, 'http:read.local', 1)

  const { body } = await request('http://read.local', { dispatcher: agent })
  deepStrictEqual(await body.json(), { hello: 'second' })
})

test('server close drains in-flight requests and removes new routing targets', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'graceful-close')
  const worker = await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'graceful-close.local',
    kind: 'graceful-close'
  })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:graceful-close.local', 1)

  const responses = [
    request('http://graceful-close.local', { dispatcher: agent }),
    request('http://graceful-close.local', { dispatcher: agent }),
    request('http://graceful-close.local', { dispatcher: agent })
  ]
  while (true) {
    const [message] = (await once(worker, 'message')) as Array<{ type?: string; count?: number }>
    if (message.type === 'graceful-close-active' && message.count === 3) {
      break
    }
  }

  worker.postMessage('close')
  await once(worker, 'message')
  await waitForMeshOriginRemoved(interceptor, 'http:graceful-close.local')

  await rejects(request('http://graceful-close.local', { dispatcher: agent }))

  for (const response of responses) {
    const { statusCode, body } = await response
    strictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { delayed: true })
  }
})

test('server close releases direct peers and lets its worker exit', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'close-peer')
  const worker = await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'close-peer.local',
    diagnostics: true,
    terminateOnCleanup: false
  })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:close-peer.local', 1)

  const { body } = await request('http://close-peer.local', { dispatcher: agent })
  await body.text()

  const exited = once(worker, 'exit')
  worker.postMessage('close-and-exit')
  await requestWithTimeout(exited, 1000)

  strictEqual(worker.diagnostics.filter(event => event.channel === 'peer:disconnect').length, 1)
})

test('concurrent server close calls share completion and wait for active requests', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'close-concurrent')
  const worker = await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'close-concurrent.local',
    kind: 'graceful-close'
  })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:close-concurrent.local', 1)

  const responses = [
    request('http://close-concurrent.local', { dispatcher: agent }),
    request('http://close-concurrent.local', { dispatcher: agent }),
    request('http://close-concurrent.local', { dispatcher: agent })
  ]
  while (true) {
    const [message] = (await once(worker, 'message')) as Array<{ type?: string; count?: number }>
    if (message.type === 'graceful-close-active' && message.count === 3) {
      break
    }
  }

  let closed = false
  const closedMessage = new Promise<void>(resolve => {
    worker.on('message', message => {
      if ((message as { type?: string }).type === 'closed') {
        closed = true
        resolve()
      }
    })
  })
  worker.postMessage('close-concurrent')

  const [{ same }] = (await once(worker, 'message')) as Array<{ same: boolean }>
  strictEqual(same, true)
  strictEqual(closed, false)

  for (const response of responses) {
    const { statusCode, body } = await response
    strictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { delayed: true })
  }

  await closedMessage
})

test('repeated close races drain queued and MessagePort-boundary requests', async t => {
  for (let iteration = 0; iteration < 5; iteration++) {
    const { meshId, coordinatorThreadId } = await createMesh(t, `close-race-${iteration}`)
    const worker = await createWorkerServer(t, {
      meshId,
      coordinatorThreadId,
      serverId: `server-${iteration}`,
      domain: `close-race-${iteration}.local`,
      kind: 'graceful-close'
    })
    const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
    await waitForMeshServers(interceptor, `http:close-race-${iteration}.local`, 1)

    const responses = Array.from({ length: 32 }, () => request(`http://close-race-${iteration}.local`, { dispatcher: agent }))
    while (true) {
      const [message] = (await once(worker, 'message')) as Array<{ type?: string; count?: number }>
      if (message.type === 'graceful-close-active') {
        break
      }
    }

    const closed = new Promise<void>(resolve => {
      const onMessage = (message: { type?: string }): void => {
        if (message.type === 'closed') {
          worker.off('message', onMessage)
          resolve()
        }
      }
      worker.on('message', onMessage)
    })
    worker.postMessage('close')
    const completed = await Promise.all(responses)
    for (const response of completed) {
      strictEqual(response.statusCode, 200)
      deepStrictEqual(await response.body.json(), { delayed: true })
    }

    await closed
  }
})

test('server rejects peers that arrive after close starts', async t => {
  const id = directMeshId('late-peer')
  const coordinator = createCoordinator({ meshId: id })
  t.after(() => coordinator.destroy())
  const server = createServer({
    meshId: id,
    serverId: 'server-1',
    domain: 'late-peer.local',
    server (_req: any, res: any) {
      res.end('ok')
    }
  })
  await server.ready
  await server.close()

  const channel = new MessageChannel()
  const message = once(channel.port2, 'message')
  const closed = once(channel.port2, 'close')
  server.addPeer(channel.port1, 'late-interceptor')

  const [{ type }] = (await message) as Array<{ type: string }>
  strictEqual(type, Message.PEER_DISCONNECT)
  await closed
  channel.port2.close()
})

test('server answers a request delivered after close with shutdown response', async t => {
  const id = directMeshId('late-request')
  const coordinator = createCoordinator({ meshId: id })
  t.after(() => coordinator.destroy())
  const server = createServer({
    meshId: id,
    serverId: 'server-1',
    domain: 'late-request.local',
    server (_req: any, res: any) {
      res.end('ok')
    }
  })
  await server.ready

  const channel = new MessageChannel()
  server.addPeer(channel.port2, 'late-interceptor')
  const response = new Promise<number>(resolve => {
    const onMessage = (message: { statusCode?: number }): void => {
      if (message.statusCode !== undefined) {
        channel.port1.off('message', onMessage)
        resolve(message.statusCode)
      }
    }
    channel.port1.on('message', onMessage)
  })
  const close = server.close()
  strictEqual(close, server.close())
  channel.port1.postMessage({
    type: Message.REQUEST,
    id: 'late-request',
    meshId: id,
    interceptorId: 'late-interceptor',
    origin: 'http:late-request.local',
    path: '/',
    method: 'GET',
    headers: {},
    sequence: 1
  })

  strictEqual(await response, 503)
  await close
  channel.port1.close()
})

test('keeps routing when one worker exits and another serves the same origin', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'worker-exit-active')
  const worker = await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server:1',
    domain: 'survive.local',
    message: 'gone'
  })
  await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server:2',
    domain: 'survive.local',
    message: 'survived'
  })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:survive.local', 2)

  await worker.terminate()
  await waitForMeshServerCount(interceptor, 'http:survive.local', 1)

  const { body } = await request('http://survive.local', { dispatcher: agent })
  deepStrictEqual(await body.json(), { hello: 'survived' })
})

test('restarts a tcp server by replacing its address', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'tcp-restart')
  const first = Fastify()
  first.get('/', async () => ({ hello: 'first' }))
  await first.listen({ port: 0 })
  t.after(() => first.close())

  const second = Fastify()
  second.get('/', async () => ({ hello: 'second' }))
  await second.listen({ port: 0 })
  t.after(() => second.close())

  const server = createServer({
    meshId,
    coordinatorThreadId,
    serverId: 'tcp-1',
    domain: 'tcp-restart.local',
    server: first.listeningOrigin
  })
  t.after(() => server.close())
  await server.ready
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:tcp-restart.local', 1)

  {
    const { body } = await request('http://tcp-restart.local', { dispatcher: agent })
    deepStrictEqual(await body.json(), { hello: 'first' })
  }

  server.replaceServer(second.listeningOrigin)
  await waitForMeshServerAddress(interceptor, 'tcp-1', second.listeningOrigin)

  const { body } = await request('http://tcp-restart.local', { dispatcher: agent })
  deepStrictEqual(await body.json(), { hello: 'second' })
})

test('ignores nullish replaceServer values for tcp servers', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'tcp-nullish-replace')
  const app = Fastify()
  app.get('/', async () => ({ hello: 'tcp' }))
  await app.listen({ port: 0 })
  t.after(() => app.close())

  const server = createServer({
    meshId,
    coordinatorThreadId,
    serverId: 'tcp-1',
    domain: 'tcp-nullish-replace.local',
    server: app.listeningOrigin
  })
  t.after(() => server.close())
  await server.ready
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:tcp-nullish-replace.local', 1)

  server.replaceServer(null)
  server.replaceServer(undefined)

  strictEqual(interceptor.getMesh()?.servers['tcp-1']?.address, app.listeningOrigin)

  const { body } = await request('http://tcp-nullish-replace.local', { dispatcher: agent })
  deepStrictEqual(await body.json(), { hello: 'tcp' })
})

test('coordinator can close and restart with a fresh mesh', async t => {
  const meshId = 'v2-coordinator-restart'
  const coordinator = createCoordinator({ meshId })
  t.after(() => coordinator.destroy())
  const first = createServer({
    meshId,
    serverId: 'server-1',
    domain: 'restart.local',
    server (_req: any, res: any) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ hello: 'first' }))
    }
  })
  await first.ready
  const firstInterceptor = createInterceptor({ meshId, domain: '.local' })
  await firstInterceptor.ready
  await waitForMeshServers(firstInterceptor, 'http:restart.local', 1)

  {
    const { body } = await request('http://restart.local', { dispatcher: new Agent().compose(firstInterceptor) })
    deepStrictEqual(await body.json(), { hello: 'first' })
  }

  firstInterceptor.close()
  await first.close()
  coordinator.close()
  coordinator.restart()
  const second = createServer({
    meshId,
    serverId: 'server-2',
    domain: 'restart.local',
    server (_req: any, res: any) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ hello: 'second' }))
    }
  })
  t.after(() => second.close())
  await second.ready
  const secondInterceptor = createInterceptor({ meshId, domain: '.local' })
  t.after(() => secondInterceptor.close())
  await secondInterceptor.ready
  await waitForMeshServers(secondInterceptor, 'http:restart.local', 1)

  const { statusCode, body } = await request('http://restart.local', {
    dispatcher: new Agent().compose(secondInterceptor)
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'second' })
})

test('coordinator handles member validation and lifecycle edge messages', async () => {
  const id = directMeshId('coordinator-edges')
  const events: string[] = []
  const errors: string[] = []
  const coordinator = createCoordinator({
    meshId: id,
    onServerAvailable: server => events.push(`available:${server.serverId}`),
    onServerUnavailable: server => events.push(`unavailable:${server.serverId}`),
    onServerPaused: server => events.push(`paused:${server.serverId}`),
    onServerResumed: server => events.push(`resumed:${server.serverId}`),
    onServerClosed: server => events.push(`closed:${server.serverId}`),
    onServerUpdate: server => {
      events.push(`updated:${server.serverId}`)
      throw new Error('update failed')
    },
    onError: error => errors.push(error.message)
  })
  try {
    const invalid = new MessageChannel()
    invalid.port2.close()
    coordinator.connectMember({
      type: Message.COORDINATOR_CONNECT,
      meshId: id,
      role: 'server',
      threadId,
      port: invalid.port1
    } as CoordinatorConnectMessage)

    const missingServer = new MessageChannel()
    missingServer.port2.close()
    coordinator.connectMember({
      type: Message.COORDINATOR_CONNECT,
      meshId: id,
      role: 'server',
      threadId,
      port: missingServer.port1,
      server: undefined
    } as unknown as CoordinatorConnectMessage)

    const missingInterceptor = new MessageChannel()
    missingInterceptor.port2.close()
    coordinator.connectMember({
      type: Message.COORDINATOR_CONNECT,
      meshId: id,
      role: 'interceptor',
      threadId,
      port: missingInterceptor.port1,
      interceptor: undefined
    } as unknown as CoordinatorConnectMessage)

    const missingOrigin = new MessageChannel()
    missingOrigin.port2.close()
    coordinator.connectMember({
      type: Message.COORDINATOR_CONNECT,
      meshId: id,
      role: 'server',
      threadId,
      port: missingOrigin.port1,
      server: { id: 'missing-origin' } as any
    })

    const { remote } = connectServer(coordinator, 'server-1')
    await once(remote, 'message')

    remote.postMessage({ type: Message.GET_MESH })
    const [{ mesh }] = (await once(remote, 'message')) as Array<{ mesh: { meshId: string } }>
    strictEqual(mesh.meshId, id)

    remote.postMessage({ type: Message.SERVER_UPDATE, operationId: 'server-update-1', state: 'paused' })
    remote.postMessage({ type: Message.SERVER_UPDATE, operationId: 'server-update-2', state: 'available' })
    remote.postMessage({ type: Message.SERVER_UPDATE, operationId: 'server-update-3', state: 'unavailable' })
    remote.postMessage({ type: Message.SERVER_UPDATE, operationId: 'server-update-4', state: 'closed' })
    remote.postMessage({ type: Message.SERVER_UPDATE, operationId: 'server-update-5', state: 'available' })
    remote.postMessage({ type: Message.SERVER_UPDATE, operationId: 'server-update-6', state: 'unavailable' })
    remote.postMessage({ type: Message.SERVER_UPDATE, operationId: 'server-update-7', state: 'unavailable' })
    await sleep(20)

    deepStrictEqual(events, [
      'available:server-1',
      'paused:server-1',
      'resumed:server-1',
      'unavailable:server-1',
      'closed:server-1',
      'resumed:server-1',
      'unavailable:server-1',
      'updated:server-1'
    ])
    deepStrictEqual(errors, [
      'Coordinator connect requires an operationId.',
      'Coordinator connect requires an operationId.',
      'Coordinator connect requires an operationId.',
      'Coordinator connect requires an operationId.',
      'update failed'
    ])

    coordinator.close('missing')
    coordinator.close('server-1')
    coordinator.pause('missing')
    coordinator.resume('missing')
    remote.postMessage({ type: Message.SERVER_LEAVE, operationId: 'server-leave-1' })
    remote.postMessage({ type: Message.SERVER_LEAVE, operationId: 'server-leave-2' })
    await sleep(20)
    ok(events.includes('closed:server-1'))
    remote.close()
  } finally {
    coordinator.destroy()
  }
})

test('coordinator accepts interceptor updates and ignores invalid worker messages', async () => {
  const id = directMeshId('coordinator-interceptor')
  const closed: string[] = []
  const coordinator = createCoordinator({
    meshId: id,
    onInterceptorClosed: interceptor => closed.push(interceptor.interceptorId)
  })
  try {
    const channel = new MessageChannel()
    process.emit('workerMessage', {
      type: Message.COORDINATOR_CONNECT,
      operationId: 'interceptor-connect',
      meshId: id,
      role: 'interceptor',
      threadId,
      port: channel.port1,
      interceptor: { id: 'interceptor-1' }
    } as CoordinatorConnectMessage)
    await once(channel.port2, 'message')

    channel.port2.postMessage({ type: Message.INTERCEPTOR_UPDATE, operationId: 'interceptor-update', metadata: { updated: true } })
    await once(channel.port2, 'message')
    channel.port2.postMessage({ type: Message.INTERCEPTOR_LEAVE, operationId: 'interceptor-leave' })
    await sleep(20)

    deepStrictEqual(coordinator.getMesh().interceptors, {})
    deepStrictEqual(closed, ['interceptor-1'])
    channel.port2.close()
    process.emit('workerMessage', { type: Message.COORDINATOR_CONNECT, meshId: 'other' })
  } finally {
    coordinator.destroy()
  }
})

test('coordinator rejects mesh mutations without operation IDs', async t => {
  const id = directMeshId('missing-operation-id')
  const errors: Array<{ message: string; code?: string }> = []
  const coordinator = createCoordinator({ meshId: id, onError: error => errors.push({ message: error.message, code: (error as Error & { code?: string }).code }) })
  t.after(() => coordinator.destroy())

  const channel = new MessageChannel()
  coordinator.connectMember({
    type: Message.COORDINATOR_CONNECT,
    operationId: 'server-connect',
    meshId: id,
    role: 'server',
    threadId,
    port: channel.port1,
    server: {
      id: 'server-1',
      origin: 'http:missing-operation.local',
      state: 'available',
      mode: 'thread'
    }
  })
  await once(channel.port2, 'message')

  channel.port2.postMessage({ type: Message.SERVER_UPDATE, state: 'paused' })
  await sleep(10)

  strictEqual(coordinator.getMesh().servers['server-1'].state, 'available')
  deepStrictEqual(errors, [{ message: 'Server update requires an operationId.', code: 'UND_TI_OPERATION_ID_REQUIRED' }])
  channel.port2.close()
})

test('coordinator rejects duplicate mesh ids and destroyed restarts', () => {
  const id = directMeshId('coordinator-duplicates')
  const coordinator = createCoordinator({ meshId: id })

  try {
    strictEqual(coordinator.getMesh().meshId, id)
    throws(() => new Coordinator({ meshId: id }), {
      message: `A coordinator already exists for mesh ${id}.`
    })
  } finally {
    coordinator.destroy()
  }

  coordinator.destroy()
  strictEqual(coordinator.restart.bind(coordinator).length, 0)
  try {
    coordinator.restart()
  } catch (error) {
    strictEqual((error as Error).message, `Coordinator ${id} has been destroyed.`)
  }
})

test('coordinator close is idempotent and rejects new members while closed', async () => {
  const id = directMeshId('coordinator-closed')
  const coordinator = createCoordinator({ meshId: id })
  const channel = new MessageChannel()

  coordinator.close()
  coordinator.close()
  coordinator.connectMember({
    type: Message.COORDINATOR_CONNECT,
    operationId: 'closed-connect',
    meshId: id,
    role: 'server',
    threadId,
    port: channel.port1,
    server: {
      id: 'server-1',
      origin: 'http:closed.local',
      state: 'available',
      mode: 'thread'
    }
  })
  await once(channel.port1, 'close')
  channel.port2.close()
  coordinator.destroy()
})

test('coordinator closes inconsistent connect messages', () => {
  const id = directMeshId('coordinator-inconsistent')
  const coordinator = createCoordinator({ meshId: id })
  try {
    const serverChannel = new MessageChannel()
    let serverReads = 0
    const inconsistentServer = {
      type: Message.COORDINATOR_CONNECT,
      operationId: 'inconsistent-server-connect',
      meshId: id,
      role: 'server',
      threadId,
      port: serverChannel.port1,
      get server () {
        serverReads++
        return serverReads === 1 ? { id: 'server-1' } : undefined
      }
    }
    coordinator.connectMember(inconsistentServer as unknown as CoordinatorConnectMessage)
    serverChannel.port2.close()

    const interceptorChannel = new MessageChannel()
    let interceptorReads = 0
    const inconsistentInterceptor = {
      type: Message.COORDINATOR_CONNECT,
      operationId: 'inconsistent-interceptor-connect',
      meshId: id,
      role: 'interceptor',
      threadId,
      port: interceptorChannel.port1,
      get interceptor () {
        interceptorReads++
        return interceptorReads === 1 ? { id: 'interceptor-1' } : undefined
      }
    }
    coordinator.connectMember(inconsistentInterceptor as unknown as CoordinatorConnectMessage)
    interceptorChannel.port2.close()
  } finally {
    coordinator.destroy()
  }
})

test('server responds to coordinator pause resume and close commands', async t => {
  const id = directMeshId('server-coordinator-commands')
  const coordinator = createCoordinator({ meshId: id })
  t.after(() => coordinator.destroy())
  const server = createServer({
    meshId: id,
    serverId: 'server-1',
    domain: 'commands.local',
    server (_req: any, res: any) {
      res.end('ok')
    }
  })
  t.after(() => server.close())
  await server.ready

  coordinator.pause('server-1')
  await sleep(20)
  strictEqual(coordinator.getMesh().servers['server-1'].state, 'paused')
  coordinator.resume('server-1')
  await sleep(20)
  strictEqual(coordinator.getMesh().servers['server-1'].state, 'available')
  coordinator.close('server-1')
  await sleep(20)
  strictEqual(coordinator.getMesh().servers['server-1'], undefined)
})

test('server ignores redundant resume and updates metadata', async t => {
  const id = directMeshId('server-guards')
  const coordinator = createCoordinator({ meshId: id })
  t.after(() => coordinator.destroy())
  const server = createServer({
    meshId: id,
    serverId: 'server-1',
    domain: 'guards.local',
    server (_req: any, res: any) {
      res.end('ok')
    }
  })
  t.after(() => server.close())
  await server.ready

  server.resume()
  server.pause()
  server.pause()
  await sleep(20)
  strictEqual(coordinator.getMesh().servers['server-1'].state, 'paused')
  server.resume()
  server.updateMetadata({ updated: true })
  await sleep(20)
  strictEqual(coordinator.getMesh().servers['server-1'].state, 'available')
  deepStrictEqual(coordinator.getMesh().servers['server-1'].metadata, { updated: true })
})

test('server readiness waits for interceptor mesh acknowledgement', async t => {
  const id = directMeshId('ready-ack')
  const coordinator = createCoordinator({ meshId: id })
  t.after(() => coordinator.destroy())

  const channel = new MessageChannel()
  const received: Array<{ type?: string; operationId?: string }> = []
  channel.port2.on('message', message => {
    received.push(message as { type?: string; operationId?: string })
  })
  channel.port2.start()
  coordinator.connectMember({
    type: Message.COORDINATOR_CONNECT,
    operationId: 'interceptor-join',
    meshId: id,
    role: 'interceptor',
    threadId,
    port: channel.port1,
    interceptor: { id: 'interceptor-1' }
  })

  await sleep(10)
  const initial = received.find(message => message.type === Message.MESH)
  ok(initial?.operationId)
  channel.port2.postMessage({ type: Message.MESH_ACK, operationId: initial.operationId })

  const server = createServer({
    meshId: id,
    serverId: 'server-1',
    domain: 'ready-ack.local',
    server (_req: any, res: any) {
      res.end('ok')
    }
  })
  t.after(() => server.close())

  let applied = false
  server.ready.then(() => {
    applied = true
  })

  for (let i = 0; i < 50 && received.length < 2; i++) {
    await sleep(1)
  }

  strictEqual(applied, false)
  for (const message of received) {
    if (message.type === Message.MESH && message.operationId) {
      channel.port2.postMessage({ type: Message.MESH_ACK, operationId: message.operationId })
    }
  }
  await server.ready
  strictEqual(applied, true)
  channel.port2.close()
})
