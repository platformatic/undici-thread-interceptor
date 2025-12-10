'use strict'

const { deepStrictEqual } = require('node:assert')
const { join } = require('node:path')
const { test } = require('node:test')
const { Worker } = require('node:worker_threads')
const { createThreadInterceptor } = require('../')
const { Agent, request } = require('undici')

test('should not forward routes if asked to via hooks', async t => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'access', 'worker1.js'))
  t.after(() => worker1.terminate())

  const worker2 = new Worker(join(__dirname, 'fixtures', 'access', 'worker2.js'))
  t.after(() => worker2.terminate())

  const worker3 = new Worker(join(__dirname, 'fixtures', 'access', 'worker3.js'))
  t.after(() => worker3.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
    onChannelCreation (first, second) {
      return [first, second].includes('worker-3')
    }
  })

  await interceptor.route('worker-1', worker1)
  await interceptor.route('worker-2', worker2)
  await interceptor.route('worker-3', worker3)

  const agent = new Agent().compose(interceptor)

  {
    const { statusCode, body } = await request('http://worker-1.local/w1', { dispatcher: agent })
    deepStrictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { from: 'worker-1' })
  }

  {
    const { statusCode, body } = await request('http://worker-2.local/w2', { dispatcher: agent })
    deepStrictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { from: 'worker-2' })
  }

  {
    const { statusCode, body } = await request('http://worker-3.local/w3', { dispatcher: agent })
    deepStrictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { from: 'worker-3' })
  }

  {
    const { statusCode, body } = await request('http://worker-1.local/w2', { dispatcher: agent })
    deepStrictEqual(statusCode, 500)
    deepStrictEqual(await body.json(), {
      error: 'Internal Server Error',
      message: `No target found for worker-2.local in thread ${worker1.threadId}.`,
      statusCode: 500
    })
  }

  {
    const { statusCode, body } = await request('http://worker-2.local/w1', { dispatcher: agent })
    deepStrictEqual(statusCode, 500)
    deepStrictEqual(await body.json(), {
      error: 'Internal Server Error',
      message: `No target found for worker-1.local in thread ${worker2.threadId}.`,
      statusCode: 500
    })
  }

  {
    const { statusCode, body } = await request('http://worker-1.local/w3', { dispatcher: agent })
    deepStrictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { from: 'worker-3' })
  }

  {
    const { statusCode, body } = await request('http://worker-2.local/w3', { dispatcher: agent })
    deepStrictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { from: 'worker-3' })
  }

  {
    const { statusCode, body } = await request('http://worker-3.local/w1', { dispatcher: agent })
    deepStrictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { from: 'worker-1' })
  }

  {
    const { statusCode, body } = await request('http://worker-3.local/w2', { dispatcher: agent })
    deepStrictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { from: 'worker-2' })
  }
})
