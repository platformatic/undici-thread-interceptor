'use strict'

const { test } = require('node:test')
const { strictEqual, ok } = require('node:assert')
const { Worker } = require('node:worker_threads')
const { join } = require('node:path')
const { createThreadInterceptor } = require('../index.js')
const { Agent, request } = require('undici')

test('event loop yielding under high load', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'slow-worker.js'))

  let intervalPort

  // Wait for the worker to send us the interval tracking port
  const portPromise = new Promise((resolve) => {
    worker.on('message', (message) => {
      if (message.type === 'interval-port') {
        intervalPort = message.port
        resolve()
      }
    })
  })

  await portPromise

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })

  await interceptor.route('slowapi', worker)

  const agent = new Agent().compose(interceptor)

  // Wait for the worker to be fully started by making a test request
  const testResponse = await request('http://slowapi.local', {
    dispatcher: agent,
    headers: { 'x-delay': '1' }
  })

  strictEqual(testResponse.statusCode, 200, 'Worker should be ready')
  await testResponse.body.json() // consume the body

  t.after(async () => {
    // Stop the interval in the worker
    intervalPort?.postMessage({ type: 'stop-interval' })
    intervalPort?.close()
    await interceptor.close()
    worker.terminate()
  })

  // Generate high load to saturate the queue (MAX_QUEUE = 42)
  // Create many concurrent requests to saturate the queue
  const requests = []
  for (let i = 0; i < 101; i++) { // More than MAX_QUEUE (42)
    requests.push(
      request('http://slowapi.local', {
        dispatcher: agent,
        headers: {
          'x-delay': '50' // Each request takes 50ms to process
        }
      })
    )
  }

  const loadTestPromise = Promise.all(requests)

  const results = await loadTestPromise

  // Verify all requests completed successfully
  strictEqual(results.length, 101, 'All requests should complete')
  for (const result of results) {
    strictEqual(result.statusCode, 200, 'All requests should return 200')
    const body = await result.body.json()
    strictEqual(body.hello, 'world', 'Response should have expected content')
  }

  // Get the interval count from the worker thread
  const intervalCountPromise = new Promise((resolve) => {
    intervalPort.on('message', (message) => {
      if (message.type === 'interval-count') {
        resolve(message.count)
      }
    })
    intervalPort.postMessage({ type: 'get-interval-count' })
  })

  const intervalCount = await intervalCountPromise

  // Verify the event loop behavior under heavy load
  // With 100 requests × 50ms atomic-sleep each, we expect some event loop starvation
  // The low count proves the queue yielding mechanism is necessary and working
  ok(intervalCount > 2, `Worker event loop executed ${intervalCount} intervals during heavy load`)
})
