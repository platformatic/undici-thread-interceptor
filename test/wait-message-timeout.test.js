'use strict'

const { test } = require('node:test')
const { join } = require('node:path')
const { rejects } = require('node:assert')
const { Worker } = require('node:worker_threads')
const { createThreadInterceptor } = require('../')

test('should timeout when worker does not respond to MESSAGE_CLOSE', async (t) => {
  const unresponsiveWorker = new Worker(join(__dirname, 'fixtures', 'unresponsive-worker.js'), {
    workerData: { blockMessageType: 'MESSAGE_CLOSE' }
  })
  t.after(() => unresponsiveWorker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })

  await interceptor.route('server1', unresponsiveWorker)

  const timeout = setTimeout(() => {
    t.fail('Timeout waiting for message')
  }, 10000).unref()

  t.after(() => clearTimeout(timeout))

  await rejects(
    interceptor.close(),
    error => error.message === 'Timeout waiting for message'
  )
})

test('should timeout with multiple workers when close is called', async (t) => {
  const unresponsiveWorker = new Worker(join(__dirname, 'fixtures', 'unresponsive-worker.js'), {
    workerData: { blockMessageType: 'MESSAGE_CLOSE' }
  })
  t.after(() => unresponsiveWorker.terminate())

  const normalWorker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => normalWorker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })

  await interceptor.route('server1', normalWorker)
  await interceptor.route('server2', unresponsiveWorker)

  const timeout = setTimeout(() => {
    t.fail('Timeout waiting for message')
  }, 10000).unref()

  t.after(() => clearTimeout(timeout))

  await rejects(
    interceptor.close(),
    error => error.message === 'Timeout waiting for message'
  )
})

test('should timeout when worker does not respond to MESSAGE_ROUTE_REMOVED during unroute', async (t) => {
  const unresponsiveWorker = new Worker(join(__dirname, 'fixtures', 'unresponsive-worker.js'), {
    workerData: { blockMessageType: 'MESSAGE_ROUTE_REMOVED' }
  })
  t.after(() => unresponsiveWorker.terminate())

  const normalWorker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => normalWorker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })

  await interceptor.route('server1', unresponsiveWorker)
  await interceptor.route('server2', normalWorker)

  const timeout = setTimeout(() => {
    t.fail('Timeout waiting for message')
  }, 10000).unref()

  t.after(() => clearTimeout(timeout))

  await rejects(
    interceptor.unroute('server2', normalWorker),
    error => error.message === 'Timeout waiting for message'
  )
})
