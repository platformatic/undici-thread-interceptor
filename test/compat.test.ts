import { deepStrictEqual, strictEqual } from 'node:assert'
import { test } from 'node:test'
import Fastify from 'fastify'
import { request } from 'undici'

import { createServer } from '../src/index.ts'
import { createAgent, createMesh, createWorkerServer, waitForMeshServers } from './helper.ts'

test('supports express apps', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'express')
  await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'express-1',
    domain: 'express.local',
    kind: 'express'
  })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:express.local', 1)

  const { statusCode, body } = await request('http://express.local', { dispatcher: agent })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'world' })
})

test('supports koa apps', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'koa')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'koa-1', domain: 'koa.local', kind: 'koa' })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:koa.local', 1)

  const { statusCode, body } = await request('http://koa.local', { dispatcher: agent })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'world' })
})

test('supports Fastify instances through inject', async t => {
  const app = Fastify()
  app.get('/', async () => ({ hello: 'fastify-inject' }))
  t.after(() => app.close())
  const originalInject = app.inject.bind(app)
  let injectCalled = false
  ;(app as any).inject = (opts: any, callback: any) => {
    injectCalled = true
    return originalInject(opts, callback)
  }
  const { meshId, coordinatorThreadId } = await createMesh(t, 'fastify-inject')
  const server = createServer({
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'fastify-inject.local',
    server: app
  })
  t.after(() => server.close())
  await server.ready
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:fastify-inject.local', 1)

  const { statusCode, body } = await request('http://fastify-inject.local', { dispatcher: agent })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'fastify-inject' })
  strictEqual(injectCalled, true)
})
