import { deepStrictEqual, ok, strictEqual } from 'node:assert'
import { once } from 'node:events'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'
import { threadId, type MessagePort, Worker } from 'node:worker_threads'
import { Agent, request } from 'undici'

import { createInterceptor } from '../src/index.ts'
import { createRequestQueue } from '../src/request-queue.ts'
import { normalizeOrigin, sanitizeHeaders, sendThreadMessage } from '../src/utils.ts'
import { createMesh, waitForMeshServers, workerURL } from './helper.ts'

test('yields the worker event loop under high request load', async t => {
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
  const getIntervalCount = async (): Promise<number> => {
    const intervalCountPromise = new Promise<number>(resolve => {
      const onMessage = (message: { type?: string; count: number }) => {
        if (message.type === 'interval-count') {
          intervalPort.off('message', onMessage)
          resolve(message.count)
        }
      }
      intervalPort.on('message', onMessage)
      intervalPort.postMessage({ type: 'get-interval-count' })
    })

    return intervalCountPromise
  }

  const testResponse = await request('http://slowapi.local', {
    dispatcher: agent,
    headers: { 'x-delay': '1' }
  })
  strictEqual(testResponse.statusCode, 200)
  await testResponse.body.json()
  const beforeIntervalCount = await getIntervalCount()

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

  const intervalCount = await getIntervalCount()

  ok(
    intervalCount > beforeIntervalCount,
    `Worker event loop executed ${intervalCount - beforeIntervalCount} intervals during heavy load`
  )
})

test('reports queue size while draining and covers utility edge branches', async () => {
  strictEqual(normalizeOrigin('https://Example.com/path'), 'https:example.com')
  strictEqual(normalizeOrigin('http:already.local'), 'http:already.local')
  deepStrictEqual(sanitizeHeaders(undefined, 'headers.local'), { host: 'headers.local' })
  deepStrictEqual(
    sanitizeHeaders(
      [
        ['Connection', 'keep-alive'],
        ['Transfer-Encoding', 'chunked'],
        ['x-foo', 'bar']
      ],
      'headers.local'
    ),
    { host: 'headers.local', 'x-foo': 'bar' }
  )
  deepStrictEqual(
    sanitizeHeaders({ Connection: 'keep-alive', 'Transfer-Encoding': 'chunked', host: 'old.local', 'x-foo': 'bar' }, 'headers.local'),
    { host: 'headers.local', 'x-foo': 'bar' }
  )
  const headers = { host: 'headers.local', 'x-foo': 'bar' }
  strictEqual(sanitizeHeaders(headers, 'headers.local'), headers)

  const blocker = Promise.withResolvers<void>()
  const queue = createRequestQueue('queue-edge', async callback => {
    callback()
    await blocker.promise
  })
  const release = Promise.withResolvers<void>()
  queue.push(release.resolve)
  strictEqual(queue.size(), 1)
  const drained = queue.drained()
  ok(drained instanceof Promise)
  release.resolve()
  blocker.resolve()
  await drained

  process.once('workerMessage', () => {
    throw new Error('worker message failed')
  })
  await sendThreadMessage(threadId, {}).catch(error => {
    strictEqual(error.message, 'worker message failed')
  })

  process.once('workerMessage', () => {
    // eslint-disable-next-line no-throw-literal
    throw 'worker message failed'
  })
  await sendThreadMessage(threadId, {}).catch(error => {
    strictEqual(error.message, 'worker message failed')
  })

  const failingQueue = createRequestQueue('callback-error', () => {
    throw new Error('callback failed')
  })
  failingQueue.push(undefined)
  await failingQueue.drained()
})

test('emits a warning when queue processing fails outside the callback', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(performance.nodeTiming, 'uvMetricsInfo')
  t.after(() => {
    if (descriptor) {
      Object.defineProperty(performance.nodeTiming, 'uvMetricsInfo', descriptor)
    }
  })
  Object.defineProperty(performance.nodeTiming, 'uvMetricsInfo', {
    configurable: true,
    get () {
      throw new Error('metrics failed')
    }
  })

  const emitWarning = process.emitWarning
  const warning = Promise.withResolvers<string | Error>()
  process.emitWarning = ((value: string | Error) => {
    warning.resolve(value)
    return true
  }) as typeof process.emitWarning
  t.after(() => {
    process.emitWarning = emitWarning
  })

  const queue = createRequestQueue('warning-edge', () => {})
  queue.push(undefined)
  const message = await warning.promise

  strictEqual(message, 'Request queue warning-edge failed: metrics failed')
})
