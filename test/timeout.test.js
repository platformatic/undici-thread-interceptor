'use strict'

const { test } = require('node:test')
const { rejects } = require('node:assert')
const { join } = require('node:path')
const { Worker } = require('node:worker_threads')
const { createThreadInterceptor } = require('../')
const { Agent, request } = require('undici')

test('timeout', async (t) => {
  const empty = new Worker(join(__dirname, 'fixtures', 'empty.js'))
  t.after(() => empty.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
    timeout: 1000
  })
  await interceptor.route('myserver', empty)

  const agent = new Agent().compose(interceptor)

  await rejects(request('http://myserver.local', {
    dispatcher: agent
  }), new Error('Timeout while waiting from a response from myserver.local'))
})

test('timeout set to a boolean', async (t) => {
  const empty = new Worker(join(__dirname, 'fixtures', 'empty.js'))
  t.after(() => empty.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
    timeout: true
  })
  await interceptor.route('myserver', empty)

  const agent = new Agent().compose(interceptor)

  await rejects(request('http://myserver.local', {
    dispatcher: agent
  }), new Error('Timeout while waiting from a response from myserver.local'))
})
