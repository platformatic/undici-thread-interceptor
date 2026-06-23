'use strict'

const { deepStrictEqual } = require('node:assert')
const { join } = require('node:path')
const { test } = require('node:test')
const { Worker } = require('node:worker_threads')
const { createThreadInterceptor } = require('../')
const { Agent, request } = require('undici')

test('a thread can request its own hostname', async t => {
  const worker = new Worker(join(__dirname, 'fixtures', 'self.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({ domain: '.local' })
  await interceptor.route('myself', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myself.local/self', { dispatcher: agent })
  deepStrictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { statusCode: 200, response: { pong: true } })
})

test('a thread can request its own hostname when multiple threads serve it', async t => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'self.js'))
  t.after(() => worker1.terminate())

  const worker2 = new Worker(join(__dirname, 'fixtures', 'self.js'))
  t.after(() => worker2.terminate())

  const interceptor = createThreadInterceptor({ domain: '.local' })
  await interceptor.route('myself', worker1)
  await interceptor.route('myself', worker2)

  const agent = new Agent().compose(interceptor)

  // Exercise the round-robin: every request must succeed regardless of
  // whether it lands on the caller itself or on the sibling thread.
  for (let i = 0; i < 4; i++) {
    const { statusCode, body } = await request('http://myself.local/self', { dispatcher: agent })
    deepStrictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { statusCode: 200, response: { pong: true } })
  }
})
