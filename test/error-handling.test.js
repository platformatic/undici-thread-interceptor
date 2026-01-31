'use strict'

const { test } = require('node:test')
const { deepStrictEqual, ok } = require('node:assert')
const { join } = require('node:path')
const { Worker } = require('node:worker_threads')
const { createThreadInterceptor } = require('../')
const { setTimeout: sleep } = require('node:timers/promises')
const { ThreadInterceptorError } = require('../lib/utils')

test('mesh network error are propagated via onError', async t => {
  let resolve
  let reject
  const timeout = setTimeout(() => {
    reject(new Error('Timeout waiting for onError to be called'))
  }, 10_000)

  const promise = new Promise((_resolve, _reject) => {
    resolve = _resolve
    reject = _reject
  })

  const interceptor = createThreadInterceptor({
    domain: '.local',
    meshTimeout: 1000,
    onError (...args) {
      clearTimeout(timeout)
      resolve(args)
    }
  })

  const worker1 = new Worker(join(__dirname, 'fixtures', 'error-handling.js'))
  t.after(() => worker1.terminate())
  await interceptor.route('myserver1', worker1)

  await sleep(500)

  const worker2 = new Worker(join(__dirname, 'fixtures', 'error-handling.js'))
  t.after(() => worker2.terminate())
  await interceptor.route('myserver2', worker2)

  const [error] = await promise

  ok(error instanceof ThreadInterceptorError)
  deepStrictEqual(error.message, 'Failed to wire a new thread.')
  deepStrictEqual(error.thread, worker2.threadId)
})
