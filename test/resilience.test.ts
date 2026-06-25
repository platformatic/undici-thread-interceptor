import { deepStrictEqual, rejects, strictEqual } from 'node:assert'
import { test } from 'node:test'
import { Agent, interceptors, request } from 'undici'

import { ConnectTimeoutError, createInterceptor } from '../src/index.ts'
import { createAgent, createMesh, createWorkerServer, requestWithTimeout, waitForMeshServers } from './helper.ts'

test('v2 composes with undici retry interceptor on 503 responses', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'retry')
  await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'retry.local',
    whoamiReturn503: true
  })
  const second = await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-2',
    domain: 'retry.local'
  })
  const { interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:retry.local', 2)
  const originalRandom = Math.random
  Math.random = () => 0
  t.after(() => {
    Math.random = originalRandom
  })
  const agent = new Agent().compose(interceptor, interceptors.retry())

  for (let i = 0; i < 2; i++) {
    const { statusCode, body } = await request('http://retry.local/whoami', { dispatcher: agent })

    strictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { threadId: second.threadId })
  }
})

test('v2 times out unfinished responses', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'timeout')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'timeout.local' })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:timeout.local', 1)

  await rejects(requestWithTimeout(request('http://timeout.local/unfinished-business', { dispatcher: agent }), 500))
})

test('v2 applies connectTimeout while waiting for a response', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'response-timeout')
  await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'response-timeout.local'
  })
  const interceptor = createInterceptor({
    meshId,
    coordinatorThreadId,
    domain: '.local',
    connectTimeout: 100
  })
  t.after(() => interceptor.close())
  await interceptor.ready
  await waitForMeshServers(interceptor, 'http:response-timeout.local', 1)
  const agent = new Agent().compose(interceptor)

  await rejects(
    request('http://response-timeout.local/unfinished-business', { dispatcher: agent }),
    ConnectTimeoutError
  )
})
