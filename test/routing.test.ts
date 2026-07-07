import { deepStrictEqual, rejects, strictEqual } from 'node:assert'
import { test } from 'node:test'
import Fastify from 'fastify'
import { Agent, getGlobalDispatcher, request, setGlobalDispatcher } from 'undici'

import { Interceptor, createCoordinator, createInterceptor, createServer } from '../src/index.ts'
import { createAgent, createMesh, createWorkerServer, waitForMeshServers } from './helper.ts'

test('dispatches to a thread server', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'basic')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'myserver.local' })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:myserver.local', 1)

  const { statusCode, body } = await request('http://myserver.local', { dispatcher: agent })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'world' })
})

test('routes multiple origins in one mesh', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'multiple-origins')
  await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'myserver.local',
    message: 'one'
  })
  await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-2',
    domain: 'myserver2.local',
    message: 'two'
  })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:myserver.local', 1)
  await waitForMeshServers(interceptor, 'http:myserver2.local', 1)

  const { body } = await request('http://myserver2.local', { dispatcher: agent })

  deepStrictEqual(await body.json(), { hello: 'two' })
})

test('delegates non-matching domains to undici', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'pass-through')
  const app = Fastify()
  app.get('/', async () => ({ hello: 'world' }))
  await app.listen({ port: 0 })
  t.after(() => app.close())
  const { agent } = await createAgent(t, meshId, coordinatorThreadId)

  const { statusCode, body } = await request(app.listeningOrigin, { dispatcher: agent })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'world' })
})

test('treats configured domains case-insensitively', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'case-insensitive')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'case.local' })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId, { domain: '.LOCAL' })
  await waitForMeshServers(interceptor, 'http:case.local', 1)

  const { statusCode, body } = await request('http://case.local', { dispatcher: agent })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'world' })
})

test('delegates absent origins to undici', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'absent')
  const { agent } = await createAgent(t, meshId, coordinatorThreadId)

  await rejects(request('http://missing.local', { dispatcher: agent }))
})

test('supports fetch through a global dispatcher', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'fetch')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'fetch.local' })
  const { interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:fetch.local', 1)
  const previous = getGlobalDispatcher()
  setGlobalDispatcher(new Agent().compose(interceptor))
  t.after(() => setGlobalDispatcher(previous))

  const response = await fetch('http://fetch.local/echo-body', {
    method: 'POST',
    body: new Uint8Array(Buffer.from('hello world'))
  })

  strictEqual(response.status, 200)
  strictEqual(await response.text(), 'hello world')
})

test('supports same-thread coordinator server and interceptor', async t => {
  const meshId = 'v2-same-thread'
  const coordinator = createCoordinator({ meshId })
  t.after(() => coordinator.destroy())
  const server = createServer({
    meshId,
    serverId: 'server-1',
    domain: 'self.local',
    server (_req: any, res: any) {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ hello: 'self' }))
    }
  })
  t.after(() => server.close())
  await server.ready
  const interceptor = createInterceptor({ meshId, domain: '.local' })
  t.after(() => interceptor.close())
  await interceptor.ready
  await waitForMeshServers(interceptor, 'http:self.local', 1)

  const { statusCode, body } = await request('http://self.local', { dispatcher: new Agent().compose(interceptor) })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'self' })
})

test('interceptor delegates requests without an origin and close is idempotent', async () => {
  const interceptor = new Interceptor({ meshId: 'v2-routing-direct-delegate', domain: '.local' })
  try {
    await interceptor.ready
    let delegated = false

    const handled = interceptor.dispatch(
      (_opts, _handler) => {
        delegated = true
        return false
      },
      { path: '/', method: 'GET' } as any,
      {}
    )

    strictEqual(handled, false)
    strictEqual(delegated, true)
  } finally {
    interceptor.close()
    interceptor.close()
  }
})

test('interceptor updates metadata in the coordinator mesh', async t => {
  const meshId = 'v2-routing-interceptor-metadata'
  const coordinator = createCoordinator({ meshId })
  t.after(() => coordinator.destroy())
  const interceptor = new Interceptor({ meshId, domain: '.local', interceptorId: 'interceptor-1' })
  t.after(() => interceptor.close())
  await interceptor.ready

  interceptor.updateMetadata({ updated: true })

  for (let i = 0; i < 50; i++) {
    if (coordinator.getMesh().interceptors['interceptor-1']?.metadata) {
      break
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }

  deepStrictEqual(coordinator.getMesh().interceptors['interceptor-1'].metadata, { updated: true })
})
