'use strict'

const { test } = require('node:test')
const { strictEqual, rejects } = require('node:assert')
const { join } = require('node:path')
const { Worker } = require('node:worker_threads')
const { createThreadInterceptor } = require('../')
const { Agent, request } = require('undici')

// Phase 1: Worker Self-Reporting (setAccepting)

// Helper to wait for a specific message type
async function waitForMessage (worker, predicate) {
  return new Promise((resolve) => {
    const handler = (msg) => {
      if (predicate(msg)) {
        worker.off('message', handler)
        resolve(msg)
      }
    }
    worker.on('message', handler)
  })
}

test('wire() returns setAccepting function', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker-set-accepting.js'))
  t.after(() => worker.terminate())

  // Worker should expose setAccepting (skip internal MESSAGE_WIRE messages)
  const result = await waitForMessage(worker, msg => 'hasSetAccepting' in msg)
  strictEqual(typeof result.hasSetAccepting, 'boolean')
  strictEqual(result.hasSetAccepting, true)
})

test('setAccepting(false) stops routing to worker', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker-set-accepting.js'))
  t.after(() => worker.terminate())

  // Wait for worker to be ready (skip internal MESSAGE_WIRE messages)
  await waitForMessage(worker, msg => 'hasSetAccepting' in msg)

  const interceptor = createThreadInterceptor({ domain: '.local' })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  // First request should succeed
  const res1 = await request('http://myserver.local', { dispatcher: agent })
  strictEqual(res1.statusCode, 200)
  await res1.body.json()

  // Tell worker to stop accepting
  worker.postMessage({ type: 'setAccepting', value: false })
  await waitForMessage(worker, msg => msg.type === 'setAccepting' && msg.done)

  // Next request should fail (no ready workers)
  await rejects(
    request('http://myserver.local', { dispatcher: agent }),
    /No target found/
  )
})

test('setAccepting(true) resumes routing to worker', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker-set-accepting.js'))
  t.after(() => worker.terminate())

  // Wait for worker to be ready (skip internal MESSAGE_WIRE messages)
  await waitForMessage(worker, msg => 'hasSetAccepting' in msg)

  const interceptor = createThreadInterceptor({ domain: '.local' })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  // Stop accepting
  worker.postMessage({ type: 'setAccepting', value: false })
  await waitForMessage(worker, msg => msg.type === 'setAccepting' && msg.done)

  // Resume accepting
  worker.postMessage({ type: 'setAccepting', value: true })
  await waitForMessage(worker, msg => msg.type === 'setAccepting' && msg.done)

  // Request should succeed again
  const res = await request('http://myserver.local', { dispatcher: agent })
  strictEqual(res.statusCode, 200)
  await res.body.json()
})

test('setAccepting(false) propagates to other workers in mesh', async (t) => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'worker-set-accepting.js'))
  const worker2 = new Worker(join(__dirname, 'fixtures', 'worker-mesh-client.js'))
  t.after(() => {
    worker1.terminate()
    worker2.terminate()
  })

  // Wait for worker1 to be ready (skip internal MESSAGE_WIRE messages)
  await waitForMessage(worker1, msg => 'hasSetAccepting' in msg)

  const interceptor = createThreadInterceptor({ domain: '.local' })
  await interceptor.route('server1', worker1)
  await interceptor.route('server2', worker2)

  // worker2 makes request to worker1 - should succeed
  worker2.postMessage({ type: 'request', url: 'http://server1.local' })
  const res1 = await waitForMessage(worker2, msg => 'statusCode' in msg || 'error' in msg)
  strictEqual(res1.statusCode, 200)

  // worker1 stops accepting
  worker1.postMessage({ type: 'setAccepting', value: false })
  await waitForMessage(worker1, msg => msg.type === 'setAccepting' && msg.done)

  // worker2 makes request to worker1 - should fail
  worker2.postMessage({ type: 'request', url: 'http://server1.local' })
  const res2 = await waitForMessage(worker2, msg => 'statusCode' in msg || 'error' in msg)
  strictEqual(res2.error, true)
})

test('setAccepting returns promise that resolves after propagation', async (t) => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'worker-set-accepting.js'))
  const worker2 = new Worker(join(__dirname, 'fixtures', 'worker-mesh-client.js'))
  t.after(() => {
    worker1.terminate()
    worker2.terminate()
  })

  // Wait for worker1 to be ready (skip internal MESSAGE_WIRE messages)
  await waitForMessage(worker1, msg => 'hasSetAccepting' in msg)

  const interceptor = createThreadInterceptor({ domain: '.local' })
  await interceptor.route('server1', worker1)
  await interceptor.route('server2', worker2)

  // Tell worker1 to stop accepting and wait for promise
  worker1.postMessage({ type: 'setAccepting', value: false })
  const result = await waitForMessage(worker1, msg => msg.type === 'setAccepting' && msg.done)
  strictEqual(result.done, true)

  // By the time promise resolves, worker2 should already know
  // No need to wait - make request immediately
  worker2.postMessage({ type: 'request', url: 'http://server1.local' })
  const res = await waitForMessage(worker2, msg => 'statusCode' in msg || 'error' in msg)
  strictEqual(res.error, true) // Should fail immediately, no race condition
})

test('round-robin skips workers that called setAccepting(false)', async (t) => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'worker-set-accepting.js'))
  const worker2 = new Worker(join(__dirname, 'fixtures', 'worker-set-accepting.js'))
  t.after(() => {
    worker1.terminate()
    worker2.terminate()
  })

  // Wait for workers to be ready in parallel (must be done immediately to avoid race condition)
  await Promise.all([
    waitForMessage(worker1, msg => 'hasSetAccepting' in msg),
    waitForMessage(worker2, msg => 'hasSetAccepting' in msg)
  ])

  const interceptor = createThreadInterceptor({ domain: '.local' })
  await interceptor.route('myserver', worker1)
  await interceptor.route('myserver', worker2)

  const agent = new Agent().compose(interceptor)

  // worker1 stops accepting
  worker1.postMessage({ type: 'setAccepting', value: false })
  await waitForMessage(worker1, msg => msg.type === 'setAccepting' && msg.done)

  // All requests should go to worker2
  for (let i = 0; i < 5; i++) {
    const res = await request('http://myserver.local', { dispatcher: agent })
    strictEqual(res.statusCode, 200)
    const body = await res.body.json()
    strictEqual(body.workerId, worker2.threadId)
  }
})

// Phase 2: Coordinator-Initiated Control (pauseWorker / resumeWorker)

test('interceptor exposes pauseWorker and resumeWorker', async (t) => {
  const interceptor = createThreadInterceptor({ domain: '.local' })

  strictEqual(typeof interceptor.pauseWorker, 'function')
  strictEqual(typeof interceptor.resumeWorker, 'function')
})

test('pauseWorker stops routing to specified worker', async (t) => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  const worker2 = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => {
    worker1.terminate()
    worker2.terminate()
  })

  const interceptor = createThreadInterceptor({ domain: '.local' })
  await interceptor.route('myserver', worker1)
  await interceptor.route('myserver', worker2)

  const agent = new Agent().compose(interceptor)

  // Pause worker1
  await interceptor.pauseWorker(worker1)

  // All requests should go to worker2
  for (let i = 0; i < 5; i++) {
    const res = await request('http://myserver.local/whoami', { dispatcher: agent })
    strictEqual(res.statusCode, 200)
    const body = await res.body.json()
    strictEqual(body.threadId, worker2.threadId)
  }
})

test('resumeWorker resumes routing to specified worker', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({ domain: '.local' })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  // Pause then resume
  await interceptor.pauseWorker(worker)
  await interceptor.resumeWorker(worker)

  // Request should succeed
  const res = await request('http://myserver.local', { dispatcher: agent })
  strictEqual(res.statusCode, 200)
  await res.body.json()
})

test('pauseWorker propagates to all workers in mesh', async (t) => {
  const server = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  const client = new Worker(join(__dirname, 'fixtures', 'worker-mesh-client.js'))
  t.after(() => {
    server.terminate()
    client.terminate()
  })

  const interceptor = createThreadInterceptor({ domain: '.local' })
  await interceptor.route('server', server)
  await interceptor.route('client', client)

  // client makes request to server - should succeed
  client.postMessage({ type: 'request', url: 'http://server.local' })
  const res1 = await waitForMessage(client, msg => 'statusCode' in msg || 'error' in msg)
  strictEqual(res1.statusCode, 200)

  // Coordinator pauses server
  await interceptor.pauseWorker(server)

  // client makes request to server - should fail
  client.postMessage({ type: 'request', url: 'http://server.local' })
  const res2 = await waitForMessage(client, msg => 'statusCode' in msg || 'error' in msg)
  strictEqual(res2.error, true)
})

test('multiple pause/resume cycles work correctly', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({ domain: '.local' })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  for (let i = 0; i < 3; i++) {
    // Pause
    await interceptor.pauseWorker(worker)
    await rejects(request('http://myserver.local', { dispatcher: agent }), /No target found/)

    // Resume
    await interceptor.resumeWorker(worker)
    const res = await request('http://myserver.local', { dispatcher: agent })
    strictEqual(res.statusCode, 200)
    await res.body.json()
  }
})

test('pausing all workers returns appropriate error', async (t) => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  const worker2 = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => {
    worker1.terminate()
    worker2.terminate()
  })

  const interceptor = createThreadInterceptor({ domain: '.local' })
  await interceptor.route('myserver', worker1)
  await interceptor.route('myserver', worker2)

  const agent = new Agent().compose(interceptor)

  // Pause both workers
  await interceptor.pauseWorker(worker1)
  await interceptor.pauseWorker(worker2)

  // Request should fail with "No target found"
  await rejects(
    request('http://myserver.local', { dispatcher: agent }),
    /No target found/
  )
})

test('resumeWorker propagates to all workers in mesh', async (t) => {
  const server = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  const client = new Worker(join(__dirname, 'fixtures', 'worker-mesh-client.js'))
  t.after(() => {
    server.terminate()
    client.terminate()
  })

  const interceptor = createThreadInterceptor({ domain: '.local' })
  await interceptor.route('server', server)
  await interceptor.route('client', client)

  // Pause server
  await interceptor.pauseWorker(server)

  // client makes request to server - should fail
  client.postMessage({ type: 'request', url: 'http://server.local' })
  const res1 = await waitForMessage(client, msg => 'statusCode' in msg || 'error' in msg)
  strictEqual(res1.error, true)

  // Resume server
  await interceptor.resumeWorker(server)

  // client makes request to server - should succeed
  client.postMessage({ type: 'request', url: 'http://server.local' })
  const res2 = await waitForMessage(client, msg => 'statusCode' in msg || 'error' in msg)
  strictEqual(res2.statusCode, 200)
})

test('setAccepting with same value is a no-op', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker-set-accepting.js'))
  t.after(() => worker.terminate())

  await waitForMessage(worker, msg => 'hasSetAccepting' in msg)

  const interceptor = createThreadInterceptor({ domain: '.local' })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  // Request should succeed initially
  const res1 = await request('http://myserver.local', { dispatcher: agent })
  strictEqual(res1.statusCode, 200)
  await res1.body.json()

  // Set accepting to true when already true (no-op)
  worker.postMessage({ type: 'setAccepting', value: true })
  await waitForMessage(worker, msg => msg.type === 'setAccepting' && msg.done)

  // Request should still succeed
  const res2 = await request('http://myserver.local', { dispatcher: agent })
  strictEqual(res2.statusCode, 200)
  await res2.body.json()

  // Set to false
  worker.postMessage({ type: 'setAccepting', value: false })
  await waitForMessage(worker, msg => msg.type === 'setAccepting' && msg.done)

  // Set accepting to false when already false (no-op)
  worker.postMessage({ type: 'setAccepting', value: false })
  await waitForMessage(worker, msg => msg.type === 'setAccepting' && msg.done)

  // Request should still fail
  await rejects(
    request('http://myserver.local', { dispatcher: agent }),
    /No target found/
  )
})
