'use strict'

const { test } = require('node:test')
const { deepStrictEqual, strictEqual } = require('node:assert')
const { join } = require('node:path')
const { Worker } = require('node:worker_threads')
const { createThreadInterceptor } = require('../')
const { getGlobalDispatcher, setGlobalDispatcher } = require('undici')

test('POST with Uint8Array body (fetch)', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  await interceptor.route('myserver', worker)

  const originalDispatcher = getGlobalDispatcher()
  setGlobalDispatcher(originalDispatcher.compose(interceptor))

  const textEncoder = new TextEncoder()
  const response = await fetch('http://myserver.local/echo-body', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: textEncoder.encode(JSON.stringify({ hello: 'world' })),
  })

  strictEqual(response.status, 200)
  deepStrictEqual(await response.json(), { hello: 'world' })
  setGlobalDispatcher(originalDispatcher)
})
