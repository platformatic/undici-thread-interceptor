import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert'
import { test } from 'node:test'
import { Agent, request } from 'undici'

import { createInterceptor, NoAvailableTargetError } from '../src/index.ts'
import {
  createAgent,
  createMesh,
  createWorkerServer,
  waitForMeshServers
} from './helper.ts'

test('v2 only selects available servers during load balancing', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'available-balancing')
  await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'available.local',
    message: 'paused',
    paused: true
  })
  await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-2',
    domain: 'available.local',
    message: 'available'
  })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:available.local', 2)

  for (let i = 0; i < 3; i++) {
    const { body } = await request('http://available.local', { dispatcher: agent })
    deepStrictEqual(await body.json(), { hello: 'available' })
  }
})

test('v2 allowTarget can deny a selected server', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'allow-target-deny')
  await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'deny.local'
  })
  const interceptor = createInterceptor({
    meshId,
    coordinatorThreadId,
    domain: '.local',
    allowTarget (_req, target) {
      return target.serverId !== 'server-1'
    }
  })
  t.after(() => interceptor.close())
  await interceptor.ready
  await waitForMeshServers(interceptor, 'http:deny.local', 1)

  await rejects(request('http://deny.local', { dispatcher: new Agent().compose(interceptor) }), NoAvailableTargetError)
})

test('v2 allowTarget skips denied servers and selects another available target', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'allow-target-skip')
  await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'skip.local',
    message: 'denied'
  })
  await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-2',
    domain: 'skip.local',
    message: 'allowed'
  })
  const interceptor = createInterceptor({
    meshId,
    coordinatorThreadId,
    domain: '.local',
    allowTarget (req, target, ctx) {
      ctx.seen = req.path
      return target.serverId !== 'server-1'
    }
  })
  t.after(() => interceptor.close())
  await interceptor.ready
  await waitForMeshServers(interceptor, 'http:skip.local', 2)
  const originalRandom = Math.random
  Math.random = () => 0
  t.after(() => {
    Math.random = originalRandom
  })

  const { statusCode, body } = await request('http://skip.local', { dispatcher: new Agent().compose(interceptor) })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'allowed' })
})

test('v2 paused server is not selected', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'paused')
  await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'paused.local',
    paused: true
  })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:paused.local', 1)

  await rejects(request('http://paused.local', { dispatcher: agent }), NoAvailableTargetError)
})

test('v2 fails when origin exists without available servers', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'unavailable')
  await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'unavailable.local',
    paused: true
  })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:unavailable.local', 1)

  await rejects(request('http://unavailable.local', { dispatcher: agent }), NoAvailableTargetError)
})

test('v2 initializes round-robin cursor from a randomized position', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'round-robin')
  await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'rr.local',
    message: 'one'
  })
  await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-2',
    domain: 'rr.local',
    message: 'two'
  })

  const values = new Set<string>()
  const originalRandom = Math.random
  Math.random = () => 0.75
  t.after(() => {
    Math.random = originalRandom
  })

  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:rr.local', 2)

  for (let i = 0; i < 2; i++) {
    const { body } = await request('http://rr.local', { dispatcher: agent })
    values.add(((await body.json()) as { hello: string }).hello)
  }

  ok(values.has('one'))
  ok(values.has('two'))
})
