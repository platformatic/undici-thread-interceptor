import { deepStrictEqual, rejects, strictEqual, throws } from 'node:assert'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Worker } from 'node:worker_threads'
import Fastify from 'fastify'
import { Agent, request } from 'undici'

import { createInterceptor, createServer } from '../src/index.ts'
import { createMesh, createWorkerServer, waitForMeshServers } from './helper.ts'

test('v2 validates interceptor hook options', () => {
  throwsHook(() => createInterceptor({ meshId: 'hooks-validation', onResponse: 'nope' as any }), 'Expected a function, got string')
  throwsHook(
    () => createInterceptor({ meshId: 'hooks-validation', onRequest: [() => {}, 'nope'] as any }),
    'Expected a function, got string'
  )
  throwsHook(
    () => createInterceptor({ meshId: 'hooks-validation', onError: async () => {} }),
    'Async hooks are not supported'
  )
})

test('v2 validates server hook options', () => {
  throwsHook(
    () => createServer({ meshId: 'hooks-validation', domain: 'validation.local', server: () => {}, onResponse: 'nope' as any }),
    'Expected a function, got string'
  )
  throwsHook(
    () =>
      createServer({
        meshId: 'hooks-validation',
        domain: 'validation.local',
        server: () => {},
        onRequest: [() => {}, 'nope'] as any
      }),
    'Expected a function, got string'
  )
  throwsHook(
    () => createServer({ meshId: 'hooks-validation', domain: 'validation.local', server: () => {}, onError: async () => {} }),
    'Async hooks are not supported'
  )
})

test('v2 rejects server domains that include a protocol', () => {
  throws(
    () => createServer({ meshId: 'domain-validation', domain: 'http:validation.local', server: () => {} }),
    /domain must not include a protocol/
  )
  throws(
    () => createServer({ meshId: 'domain-validation', domain: 'http://validation.local', server: () => {} }),
    /domain must not include a protocol/
  )
})

function throwsHook (fn: () => void, message: string): void {
  try {
    fn()
  } catch (error) {
    strictEqual((error as Error).message, message)
    return
  }

  throw new Error('should not be here')
}

async function waitForHookCount (worker: Worker & { hooks: string[] }, count: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (worker.hooks.length >= count) {
      return
    }
    await sleep(20)
  }

  throw new Error(`worker did not collect ${count} hook messages`)
}

test('v2 interceptor onRequest hook', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'hook-request')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'hook-request.local' })
  let seen: unknown
  const interceptor = createInterceptor({
    meshId,
    coordinatorThreadId,
    domain: '.local',
    onRequest (opts) {
      seen = opts
    }
  })
  t.after(() => interceptor.close())
  await interceptor.ready
  await waitForMeshServers(interceptor, 'http:hook-request.local', 1)

  const { statusCode } = await request('http://hook-request.local', { dispatcher: new Agent().compose(interceptor) })

  strictEqual(statusCode, 200)
  const { origin, path, method, headers } = seen as Record<string, unknown>
  deepStrictEqual({ origin, path, method, headers }, {
    origin: 'http://hook-request.local',
    path: '/',
    method: 'GET',
    headers: { host: 'hook-request.local' }
  })
})

test('v2 interceptor response hooks share context', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'hook-response')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'hook-response.local' })
  const calls: string[] = []
  const interceptor = createInterceptor({
    meshId,
    coordinatorThreadId,
    domain: '.local',
    onRequest (_req, ctx) {
      ctx.value = 'propagated'
    },
    onResponse (_req, res, ctx) {
      calls.push(`${res.statusCode}:${ctx.value as string}`)
    },
    onResponseEnd (_req, res, ctx) {
      calls.push(`end:${res.statusCode}:${ctx.value as string}`)
    }
  })
  t.after(() => interceptor.close())
  await interceptor.ready
  await waitForMeshServers(interceptor, 'http:hook-response.local', 1)

  const { statusCode, body } = await request('http://hook-response.local', { dispatcher: new Agent().compose(interceptor) })
  await body.text()

  strictEqual(statusCode, 200)
  deepStrictEqual(calls.map(String), ['200:propagated', 'end:200:propagated'])
})

test('v2 interceptor hook arrays run in order', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'hook-arrays')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'hook-arrays.local' })
  const calls: string[] = []
  const interceptor = createInterceptor({
    meshId,
    coordinatorThreadId,
    domain: '.local',
    onRequest: [
      (_req, ctx) => {
        calls.push('request:first')
        ctx.value = 'first'
      },
      (_req, ctx) => {
        calls.push(`request:second:${ctx.value as string}`)
      }
    ],
    allowTarget: [
      (_req, target) => {
        calls.push(`allow:first:${target.serverId}`)
      },
      (_req, target) => {
        calls.push(`allow:second:${target.serverId}`)
        return true
      }
    ],
    onResponse: [
      () => calls.push('response:first'),
      () => calls.push('response:second')
    ],
    onResponseEnd: [
      () => calls.push('end:first'),
      () => calls.push('end:second')
    ]
  })
  t.after(() => interceptor.close())
  await interceptor.ready
  await waitForMeshServers(interceptor, 'http:hook-arrays.local', 1)

  const { statusCode, body } = await request('http://hook-arrays.local', { dispatcher: new Agent().compose(interceptor) })
  await body.text()

  strictEqual(statusCode, 200)
  deepStrictEqual(calls, [
    'request:first',
    'request:second:first',
    'allow:first:server-1',
    'allow:second:server-1',
    'response:first',
    'response:second',
    'end:first',
    'end:second'
  ])
})

test('v2 allowTarget hook arrays short-circuit on false', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'allow-short-circuit')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'allow-short-circuit.local' })
  const calls: string[] = []
  const interceptor = createInterceptor({
    meshId,
    coordinatorThreadId,
    domain: '.local',
    allowTarget: [
      () => {
        calls.push('first')
        return false
      },
      () => {
        calls.push('second')
        return true
      }
    ]
  })
  t.after(() => interceptor.close())
  await interceptor.ready
  await waitForMeshServers(interceptor, 'http:allow-short-circuit.local', 1)

  await rejects(request('http://allow-short-circuit.local', { dispatcher: new Agent().compose(interceptor) }))

  deepStrictEqual(calls, ['first'])
})

test('v2 interceptor response hooks run for tcp targets', async t => {
  const app = Fastify()
  app.get('/', async () => ({ hello: 'tcp' }))
  await app.listen({ port: 0 })
  t.after(() => app.close())
  const { meshId, coordinatorThreadId } = await createMesh(t, 'tcp-hooks')
  const server = createServer({
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'tcp-hooks.local',
    server: app.listeningOrigin
  })
  t.after(() => server.close())
  const calls: string[] = []
  const interceptor = createInterceptor({
    meshId,
    coordinatorThreadId,
    domain: '.local',
    onResponse (_req, res, ctx) {
      ctx.value = 'tcp'
      calls.push(`response:${res.statusCode}`)
    },
    onResponseEnd (_req, res, ctx) {
      calls.push(`end:${res.statusCode}:${ctx.value as string}`)
    }
  })
  t.after(() => interceptor.close())
  await server.ready
  await interceptor.ready
  await waitForMeshServers(interceptor, 'http:tcp-hooks.local', 1)

  const { statusCode, body } = await request('http://tcp-hooks.local', { dispatcher: new Agent().compose(interceptor) })
  await body.json()

  strictEqual(statusCode, 200)
  deepStrictEqual(calls, ['response:200', 'end:200:tcp'])
})

test('v2 interceptor error hooks run for tcp target failures', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'tcp-error-hooks')
  const server = createServer({
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'tcp-error-hooks.local',
    server: 'http://127.0.0.1:9'
  })
  t.after(() => server.close())
  let seen: Error | undefined
  const interceptor = createInterceptor({
    meshId,
    coordinatorThreadId,
    domain: '.local',
    onError (_req, _res, _ctx, error) {
      seen = error
    }
  })
  t.after(() => interceptor.close())
  await server.ready
  await interceptor.ready
  await waitForMeshServers(interceptor, 'http:tcp-error-hooks.local', 1)

  await rejects(request('http://tcp-error-hooks.local', { dispatcher: new Agent().compose(interceptor) }))

  strictEqual(seen instanceof Error, true)
})

test('v2 server onResponse hook is called once per response', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'server-response-hook')
  const worker = await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'server-response-hook.local',
    kind: 'server-hooks'
  })
  const interceptor = createInterceptor({ meshId, coordinatorThreadId, domain: '.local' })
  t.after(() => interceptor.close())
  await interceptor.ready
  await waitForMeshServers(interceptor, 'http:server-response-hook.local', 1)

  const { statusCode, body } = await request('http://server-response-hook.local', {
    dispatcher: new Agent().compose(interceptor)
  })
  await body.text()

  strictEqual(statusCode, 200)
  await waitForHookCount(worker, 2)
  deepStrictEqual(worker.hooks, ['request:/', 'response:/'])
})

test('v2 server hook arrays run in order', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'server-hook-arrays')
  const worker = await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'server-hook-arrays.local',
    kind: 'server-hook-arrays'
  })
  const interceptor = createInterceptor({ meshId, coordinatorThreadId, domain: '.local' })
  t.after(() => interceptor.close())
  await interceptor.ready
  await waitForMeshServers(interceptor, 'http:server-hook-arrays.local', 1)

  const { statusCode, body } = await request('http://server-hook-arrays.local', {
    dispatcher: new Agent().compose(interceptor)
  })
  await body.text()

  strictEqual(statusCode, 200)
  deepStrictEqual(worker.hooks, [
    'request:first:/',
    'request:second:first',
    'response:first:first',
    'response:second:first'
  ])
})

test('v2 interceptor onError hook receives server app errors', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'interceptor-error-hook')
  await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'interceptor-error-hook.local'
  })
  let seen: Error | undefined
  const interceptor = createInterceptor({
    meshId,
    coordinatorThreadId,
    domain: '.local',
    onError (_req, _res, _ctx, error) {
      seen = error
    }
  })
  t.after(() => interceptor.close())
  await interceptor.ready
  await waitForMeshServers(interceptor, 'http:interceptor-error-hook.local', 1)

  await rejects(request('http://interceptor-error-hook.local/error', { dispatcher: new Agent().compose(interceptor) }), {
    message: 'kaboom'
  })

  strictEqual(seen?.message, 'kaboom')
})

test('v2 server onError hook arrays run in order', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'server-error-arrays')
  const worker = await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'server-error-arrays.local',
    kind: 'server-error-hooks'
  })
  const interceptor = createInterceptor({ meshId, coordinatorThreadId, domain: '.local' })
  t.after(() => interceptor.close())
  await interceptor.ready
  await waitForMeshServers(interceptor, 'http:server-error-arrays.local', 1)

  await rejects(request('http://server-error-arrays.local', { dispatcher: new Agent().compose(interceptor) }))
  await waitForHookCount(worker, 2)

  deepStrictEqual(worker.hooks, ['error:first:kaboom', 'error:second:kaboom'])
})

test('v2 interceptor onError hook arrays run in order', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'error-hook-arrays')
  await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'error-hook-arrays.local'
  })
  const calls: string[] = []
  const interceptor = createInterceptor({
    meshId,
    coordinatorThreadId,
    domain: '.local',
    onError: [
      (_req, _res, _ctx, error) => calls.push(`first:${error.message}`),
      (_req, _res, _ctx, error) => calls.push(`second:${error.message}`)
    ]
  })
  t.after(() => interceptor.close())
  await interceptor.ready
  await waitForMeshServers(interceptor, 'http:error-hook-arrays.local', 1)

  await rejects(request('http://error-hook-arrays.local/error', { dispatcher: new Agent().compose(interceptor) }))

  deepStrictEqual(calls, ['first:kaboom', 'second:kaboom'])
})
