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
    error => error.message.startsWith('Timeout waiting for message from Worker (threadId:')
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
    error => error.message.startsWith('Timeout waiting for message from Worker (threadId:')
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
    error => error.message.startsWith('Timeout waiting for message from Worker (threadId:')
  )
})

test('waitMessage timeout error includes target information', async (t) => {
  const { waitMessage } = require('../lib/utils')
  const { EventEmitter } = require('node:events')

  // Create a mock target with constructor name and threadId
  const mockTarget = new EventEmitter()
  mockTarget.threadId = 42

  await rejects(
    waitMessage(mockTarget, { timeout: 10 }, () => false),
    error => {
      return error.message === 'Timeout waiting for message from EventEmitter (threadId: 42)'
    }
  )
})

test('waitMessage timeout error handles missing threadId', async (t) => {
  const { waitMessage } = require('../lib/utils')
  const { EventEmitter } = require('node:events')

  // Create a mock target without threadId
  const mockTarget = new EventEmitter()

  await rejects(
    waitMessage(mockTarget, { timeout: 10 }, () => false),
    error => {
      return error.message === 'Timeout waiting for message from EventEmitter (threadId: N/A)'
    }
  )
})

test('waitMessage timeout error handles missing constructor', async (t) => {
  const { waitMessage } = require('../lib/utils')
  const { EventEmitter } = require('node:events')

  // Create a mock target without constructor
  const mockTarget = new EventEmitter()
  Object.defineProperty(mockTarget, 'constructor', { value: undefined })

  await rejects(
    waitMessage(mockTarget, { timeout: 10 }, () => false),
    error => {
      return error.message === 'Timeout waiting for message from unknown (threadId: N/A)'
    }
  )
})
