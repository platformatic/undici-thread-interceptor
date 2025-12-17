'use strict'

const { test } = require('node:test')
const { deepStrictEqual } = require('node:assert')
const { join } = require('path')
const { Worker } = require('worker_threads')
const { createThreadInterceptor } = require('../')
const { Agent, request } = require('undici')

test('express', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'express1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { body } = await request('http://myserver.local', {
    dispatcher: agent,
  })

  deepStrictEqual(await body.json(), { hello: 'world' })
})

test('koa', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'koa1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { body } = await request('http://myserver.local', {
    dispatcher: agent,
  })

  deepStrictEqual(await body.json(), { hello: 'world' })
})
