'use strict'

const autocannon = require('autocannon')
const { test } = require('node:test')
const { deepStrictEqual, strictEqual, rejects, throws } = require('node:assert')
const { join } = require('path')
const { Worker } = require('worker_threads')
const { Agent, request } = require('undici')
const { threadId } = require('node:worker_threads')
const { setTimeout: sleep } = require('node:timers/promises')
const { createThreadInterceptor } = require('../')
const { MESSAGE_CLOSE, waitMessage } = require('../lib/utils')

test('graceful close from the main thread', async t => {
  const worker = new Worker(join(__dirname, 'fixtures', 'graceful-close.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  // Start three requests but do not await for the response immediately
  const response1 = request('http://myserver.local', { dispatcher: agent })
  const response2 = request('http://myserver.local', { dispatcher: agent })
  const response3 = request('http://myserver.local', { dispatcher: agent })

  // Close the worker
  worker.postMessage('close')
  await waitMessage(worker, message => message.type === MESSAGE_CLOSE)

  // New responses should be rejected
  await rejects(() => request('http://myserver.local', { dispatcher: agent }), {
    message: `No target found for myserver.local in thread ${threadId}.`
  })

  // Wait for the responses to finish
  for (const response of [response1, response2, response3]) {
    const { statusCode, body } = await response
    strictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { delayed: true })
  }
})

test('graceful close from the different threads', async t => {
  const composer = new Worker(join(__dirname, 'fixtures', 'composer.js'))
  t.after(() => composer.terminate())

  const worker = new Worker(join(__dirname, 'fixtures', 'graceful-close.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  interceptor.route('composer', composer)
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  // Start three requests but do not await for the response immediately
  const response1 = request('http://composer.local/s1/example', { dispatcher: agent })
  const response2 = request('http://composer.local/s1/example', { dispatcher: agent })
  const response3 = request('http://composer.local/s1/example', { dispatcher: agent })

  await sleep(500)

  // Close the worker
  worker.postMessage('close')
  await waitMessage(worker, message => message.type === MESSAGE_CLOSE)

  // New responses should be rejected
  {
    const { statusCode, body } = await request('http://composer.local/s1/example', { dispatcher: agent })
    strictEqual(statusCode, 500)
    deepStrictEqual(await body.json(), {
      statusCode: 500,
      error: 'Internal Server Error',
      message: `No target found for myserver.local in thread ${composer.threadId}.`
    })
  }

  // Wait for the responses to finish
  for (const response of [response1, response2, response3]) {
    const { statusCode, body } = await response
    strictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { delayed: true })
  }

  await interceptor.close()

  await rejects(() => request('http://composer.local/s1/example?foo=bar', { dispatcher: agent }), {
    message: `No target found for composer.local in thread ${threadId}.`
  })
})

test('no requests are lost if two threads are swapped in the same iteration of the event loop', async t => {
  const composer = new Worker(join(__dirname, 'fixtures', 'composer.js'), { workerData: { network: true } })
  t.after(() => composer.terminate())

  const worker = new Worker(join(__dirname, 'fixtures', 'graceful-close.js'))
  t.after(() => worker.terminate())
  const workers = [worker]

  const interceptor = createThreadInterceptor({ domain: '.local' })
  interceptor.route('composer', composer)
  interceptor.route('myserver', workers[0])

  // Hammer the cluster with the requests
  const { port } = await waitMessage(composer, message => message.type === 'port')

  const resultsPromise = autocannon({
    url: `http://127.0.0.1:${port}/s1/ping`,
    connections: 100,
    duration: 10,
    setupClient (client) {
      client.on('body', function (raw) {
        const body = JSON.parse(raw)

        if (!body.ok) {
          console.log(body)
        }
      })
    }
  })

  // Every 500ms, swap the worker
  const interval = setInterval(() => {
    const newWorker = new Worker(join(__dirname, 'fixtures', 'graceful-close.js'))
    t.after(() => newWorker.terminate())
    workers.unshift(newWorker)

    interceptor.route('myserver', workers[0])
    workers[1].postMessage('close')
  }, 500)

  const results = await resultsPromise
  clearInterval(interval)
  deepStrictEqual(results.errors, 0)
  deepStrictEqual(results.non2xx, 0)
})

test('routes are rejected if the dispatcher is closed', async t => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker1.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  interceptor.route('myserver', worker1)

  const agent = new Agent().compose(interceptor)

  {
    const { statusCode, body } = await request('http://myserver.local', { dispatcher: agent })
    strictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { hello: 'world' })
  }

  await interceptor.close()

  await rejects(() => request('http://myserver.local', { dispatcher: agent }), {
    message: 'No target found for myserver.local in thread 0.'
  })

  await throws(() => interceptor.route('myserver', worker1), { message: 'The dispatcher has been closed.' })

  interceptor.restart()

  const worker2 = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker2.terminate())
  interceptor.route('myserver', worker2)

  {
    const { statusCode, body } = await request('http://myserver.local', { dispatcher: agent })
    strictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { hello: 'world' })
  }
})
