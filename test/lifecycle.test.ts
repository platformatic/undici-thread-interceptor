import { deepStrictEqual, rejects, strictEqual } from 'node:assert'
import { once } from 'node:events'
import { test } from 'node:test'
import Fastify from 'fastify'
import { Agent, request } from 'undici'

import { createCoordinator, createInterceptor, createServer } from '../src/index.ts'
import {
  createAgent,
  createMesh,
  createWorkerServer,
  waitForMeshServerAddress,
  waitForMeshServerCount,
  waitForMeshOriginRemoved,
  waitForMeshServers
} from './helper.ts'

test('v2 removes a worker server from the mesh when it exits', async t => {
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

test('v2 replaces a worker server implementation and validates replacement input', async t => {
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

test('v2 closes and re-adds a server for the same origin', async t => {
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
    serverId: 'server-2',
    domain: 'read.local',
    message: 'second'
  })
  await waitForMeshServers(interceptor, 'http:read.local', 1)

  const { body } = await request('http://read.local', { dispatcher: agent })
  deepStrictEqual(await body.json(), { hello: 'second' })
})

test('v2 server close drains in-flight requests and removes new routing targets', async t => {
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

test('v2 keeps routing when one worker exits and another serves the same origin', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'worker-exit-active')
  const worker = await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'survive.local',
    message: 'gone'
  })
  await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-2',
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

test('v2 restarts a tcp server by replacing its address', async t => {
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

test('v2 ignores nullish replaceServer values for tcp servers', async t => {
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

test('v2 coordinator can close and restart with a fresh mesh', async t => {
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

  const { statusCode, body } = await request('http://restart.local', { dispatcher: new Agent().compose(secondInterceptor) })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'second' })
})
