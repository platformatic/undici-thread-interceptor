'use strict'

const { test } = require('node:test')
const { strictEqual } = require('node:assert')
const { join } = require('node:path')
const { Worker } = require('node:worker_threads')
const { createThreadInterceptor } = require('../')
const { setTimeout: sleep } = require('node:timers/promises')

test('mesh wire timeout is non-fatal and does not propagate via onError', async t => {
  let onErrorCalled = false

  const interceptor = createThreadInterceptor({
    domain: '.local',
    meshTimeout: 1000,
    onError () {
      onErrorCalled = true
    }
  })

  const worker1 = new Worker(join(__dirname, 'fixtures', 'error-handling.js'))
  t.after(() => worker1.terminate())
  await interceptor.route('myserver1', worker1)

  await sleep(500)

  const worker2 = new Worker(join(__dirname, 'fixtures', 'error-handling.js'))
  t.after(() => worker2.terminate())
  await interceptor.route('myserver2', worker2)

  // Wait for the mesh timeout to expire
  await sleep(1500)

  strictEqual(onErrorCalled, false, 'onError should not be called for mesh wire timeouts')
})
