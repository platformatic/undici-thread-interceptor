'use strict'

const { test } = require('node:test')
const { join } = require('node:path')
const { once } = require('node:events')
const { deepStrictEqual, ok, rejects, strictEqual } = require('node:assert')
const { Worker } = require('node:worker_threads')
const { Agent, request } = require('undici')
const { createThreadInterceptor } = require('../')
const { isTargetGone, waitMessage } = require('../lib/utils')

// Simulate a worker which exited before the route cleanup listeners installed by
// addRoute could run: the route is left in the mesh pointing at a dead thread.
async function createStaleWorker (t, interceptor, url) {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  await interceptor.route(url, worker)

  worker.removeAllListeners('exit')
  worker.removeAllListeners('close')

  await worker.terminate()
  strictEqual(worker.threadId, -1)

  return worker
}

test('close resolves promptly when a route points to an already exited worker', async t => {
  const interceptor = createThreadInterceptor({ domain: '.local' })

  await createStaleWorker(t, interceptor, 'stale')

  const healthy = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => healthy.terminate())
  await interceptor.route('healthy', healthy)

  const agent = new Agent().compose(interceptor)

  {
    const { statusCode, body } = await request('http://healthy.local', { dispatcher: agent })
    strictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { hello: 'world' })
  }

  const start = Date.now()
  await interceptor.close()
  const elapsed = Date.now() - start

  ok(elapsed < 2000, `close() took ${elapsed}ms, it should not wait for the mesh timeout`)

  // The healthy worker has been closed as well
  await rejects(() => request('http://healthy.local', { dispatcher: agent }), {
    message: 'No target found for healthy.local in thread 0.'
  })
})

test('close still closes the other routes when one of them is unresponsive', async t => {
  const unresponsive = new Worker(join(__dirname, 'fixtures', 'unresponsive-worker.js'), {
    workerData: { blockMessageType: 'MESSAGE_CLOSE' }
  })
  t.after(() => unresponsive.terminate())

  const healthy = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => healthy.terminate())

  const interceptor = createThreadInterceptor({ domain: '.local', meshTimeout: 1000 })

  // The unresponsive worker is registered first, so with a serial close the
  // healthy one would never receive MESSAGE_CLOSE.
  await interceptor.route('unresponsive', unresponsive)
  await interceptor.route('healthy', healthy)

  const agent = new Agent().compose(interceptor)

  await rejects(
    interceptor.close(),
    error => error.message.includes('Worker (threadId:') && error.message.includes('[MESSAGE_CLOSE]')
  )

  // The healthy worker has been closed anyway
  await rejects(() => request('http://healthy.local', { dispatcher: agent }), {
    message: 'No target found for healthy.local in thread 0.'
  })
})

test('close sends a single MESSAGE_CLOSE to a worker registered under multiple hostnames', async t => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({ domain: '.local' })

  await interceptor.route('first', worker)
  await interceptor.route('second', worker)

  const agent = new Agent().compose(interceptor)

  {
    const { statusCode } = await request('http://second.local', { dispatcher: agent })
    strictEqual(statusCode, 200)
  }

  const start = Date.now()
  await interceptor.close()
  const elapsed = Date.now() - start

  ok(elapsed < 2000, `close() took ${elapsed}ms, it should not wait for the mesh timeout`)

  await rejects(() => request('http://first.local', { dispatcher: agent }), {
    message: 'No target found for first.local in thread 0.'
  })
})

test('addRoute settles when the worker has already exited', async t => {
  const dead = new Worker('', { eval: true })
  await once(dead, 'exit')
  strictEqual(dead.threadId, -1)

  const interceptor = createThreadInterceptor({ domain: '.local' })

  const start = Date.now()
  await interceptor.route('dead', dead)
  const elapsed = Date.now() - start

  ok(elapsed < 2000, `route() took ${elapsed}ms, it should not hang on an exited worker`)

  const agent = new Agent().compose(interceptor)

  await rejects(() => request('http://dead.local', { dispatcher: agent }), {
    message: 'No target found for dead.local in thread 0.'
  })

  await interceptor.close()
})

test('unroute is not blocked by a route pointing to an already exited worker', async t => {
  const interceptor = createThreadInterceptor({ domain: '.local' })

  await createStaleWorker(t, interceptor, 'stale')

  const healthy = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => healthy.terminate())
  await interceptor.route('healthy', healthy)

  const start = Date.now()
  await interceptor.unroute('healthy', healthy)
  const elapsed = Date.now() - start

  ok(elapsed < 2000, `unroute() took ${elapsed}ms, it should not wait for the mesh timeout`)

  await interceptor.close()
})

test('waitMessage resolves null when the target has already exited', async t => {
  const dead = new Worker('', { eval: true })
  await once(dead, 'exit')

  strictEqual(isTargetGone(dead), true)

  const start = Date.now()
  const message = await waitMessage(dead, { timeout: 5000, description: 'MESSAGE_CLOSE' }, () => true)
  const elapsed = Date.now() - start

  strictEqual(message, null)
  ok(elapsed < 2000, `waitMessage() took ${elapsed}ms, it should not arm the timer`)
})
