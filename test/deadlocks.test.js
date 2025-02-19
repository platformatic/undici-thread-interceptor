'use strict'

const { test } = require('node:test')
const { deepStrictEqual, strictEqual } = require('node:assert')
const { join } = require('node:path')
const { Worker } = require('node:worker_threads')
const { createThreadInterceptor } = require('../')
const { Agent, request } = require('undici')

test('should not deadlock if a thread exits while the coordinator is issuing close', async t => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  {
    const { statusCode, body } = await request('http://myserver.local', {
      dispatcher: agent
    })

    strictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { hello: 'world' })
  }

  // Do not wait and terminate the thread
  const closePromise = interceptor.close()
  setImmediate(() => worker.terminate())

  await closePromise
})

test('should not deadlock if a thread exits before sending remove acknowledgement', async t => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker1.terminate())
  const worker2 = new Worker(join(__dirname, 'fixtures', 'deadlock-on-remove.js'))
  t.after(() => worker2.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  interceptor.route('myserver', worker1)
  interceptor.route('myserver2', worker2)

  const agent = new Agent().compose(interceptor)

  {
    const { statusCode, body } = await request('http://myserver.local', {
      dispatcher: agent
    })

    strictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { hello: 'world' })
  }

  {
    const { statusCode, body } = await request('http://myserver2.local', {
      dispatcher: agent
    })

    strictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { deadlock: true })
  }

  await interceptor.close()
})
