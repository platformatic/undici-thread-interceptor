'use strict'

const { test } = require('node:test')
const { Readable } = require('node:stream')
const { deepStrictEqual, strictEqual, rejects } = require('node:assert')
const { join } = require('node:path')
const { Worker } = require('node:worker_threads')
const { createThreadInterceptor } = require('../')
const { Agent, request } = require('undici')

test('POST', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local/echo-body', {
    dispatcher: agent,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ hello: 'world' }),
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'world' })
})

test('POST with Stream', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local/echo-body', {
    dispatcher: agent,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: Readable.from(JSON.stringify({ hello: 'world' })),
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'world' })
})

test('POST with Stream that errors', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const res = await request('http://myserver.local/echo-body', {
    dispatcher: agent,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: new Readable({
      read () {
        this.destroy(new Error('kaboom'))
      },
    }),
  })

  strictEqual(res.statusCode, 400)
  deepStrictEqual(await res.body.json(), {
    statusCode: 400,
    error: 'Bad Request',
    message: 'kaboom',
  })
})

test('POST with buffer stream', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local/echo-body', {
    dispatcher: agent,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: Readable.from(Buffer.from(JSON.stringify({ hello: 'world' }))),
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'world' })
})

// Unskip when https://github.com/nodejs/node/pull/55270 is released
test.skip('POST errors with streams of objects', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  await rejects(request('http://myserver.local/echo-body', {
    dispatcher: agent,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: Readable.from([{ hello: 'world' }])
  }))
})
