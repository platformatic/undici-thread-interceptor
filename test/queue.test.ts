import { ok, strictEqual } from 'node:assert'
import { once } from 'node:events'
import { test } from 'node:test'
import { type MessagePort, Worker } from 'node:worker_threads'
import { Agent, request } from 'undici'

import { createInterceptor } from '../src/index.ts'
import {
  createMesh,
  waitForMeshServers,
  workerURL
} from './helper.ts'

test('v2 yields the worker event loop under high request load', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'event-loop-yielding')
  const worker = new Worker(workerURL('slow-worker.ts'), {
    workerData: {
      meshId,
      coordinatorThreadId,
      serverId: 'server-1',
      domain: 'slowapi.local'
    }
  })
  t.after(() => worker.terminate())
  const [{ port: intervalPort }] = (await once(worker, 'message')) as Array<{ port: MessagePort }>
  t.after(() => {
    intervalPort.postMessage({ type: 'stop-interval' })
    intervalPort.close()
  })
  await once(worker, 'message')
  const interceptor = createInterceptor({ meshId, coordinatorThreadId, domain: '.local', connectTimeout: 10000 })
  t.after(() => interceptor.close())
  await interceptor.ready
  const agent = new Agent().compose(interceptor)
  await waitForMeshServers(interceptor, 'http:slowapi.local', 1)

  const testResponse = await request('http://slowapi.local', {
    dispatcher: agent,
    headers: { 'x-delay': '1' }
  })
  strictEqual(testResponse.statusCode, 200)
  await testResponse.body.json()

  const responses = await Promise.all(
    Array.from({ length: 101 }, () => {
      return request('http://slowapi.local', {
        dispatcher: agent,
        headers: { 'x-delay': '50' }
      })
    })
  )

  for (const response of responses) {
    strictEqual(response.statusCode, 200)
    const body = await response.body.json()
    strictEqual(body.hello, 'world')
  }

  const intervalCountPromise = new Promise<number>(resolve => {
    intervalPort.on('message', message => {
      if (message.type === 'interval-count') {
        resolve(message.count)
      }
    })
    intervalPort.postMessage({ type: 'get-interval-count' })
  })
  const intervalCount = await intervalCountPromise

  ok(intervalCount > 2, `Worker event loop executed ${intervalCount} intervals during heavy load`)
})
