'use strict'

const { test } = require('node:test')
const { deepStrictEqual, strictEqual } = require('node:assert')
const { join } = require('node:path')
const { Worker } = require('node:worker_threads')
const { createThreadInterceptor } = require('../')
const { Agent, request } = require('undici')

test('diagnostics channel - events are published in worker thread', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker-diagnostics-channel.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local', {
    dispatcher: agent
  })
  strictEqual(statusCode, 200)
  await body.json()

  const eventsRes = await request('http://myserver.local/events', {
    dispatcher: agent
  })
  const events = await eventsRes.body.json()

  strictEqual(events.start.length, 2)
  const startEvent = events.start[0]
  strictEqual(startEvent.method, 'GET')
  strictEqual(startEvent.url, '/')
  deepStrictEqual(startEvent.headers, { host: 'myserver.local' })
  strictEqual(startEvent.hasServer, true)

  strictEqual(events.finish.length, 1)
  const finishEvent = events.finish[0]
  strictEqual(finishEvent.method, 'GET')
  strictEqual(finishEvent.url, '/')
  strictEqual(finishEvent.statusCode, 200)
  strictEqual(finishEvent.hasServer, true)
})

test('diagnostics channel - error response', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker-diagnostics-channel.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode } = await request('http://myserver.local/error', {
    dispatcher: agent
  })
  strictEqual(statusCode, 500)

  const eventsRes = await request('http://myserver.local/events', {
    dispatcher: agent
  })
  const events = await eventsRes.body.json()

  const errorStartEvent = events.start.find(e => e.url === '/error')
  strictEqual(errorStartEvent.method, 'GET')
  strictEqual(errorStartEvent.url, '/error')
  strictEqual(errorStartEvent.hasServer, true)

  const errorFinishEvent = events.finish.find(e => e.url === '/error')
  strictEqual(errorFinishEvent.method, 'GET')
  strictEqual(errorFinishEvent.url, '/error')
  strictEqual(errorFinishEvent.statusCode, 500)
  strictEqual(errorFinishEvent.hasServer, true)
})
