'use strict'

const { strictEqual } = require('node:assert')
const { AsyncLocalStorage } = require('node:async_hooks')
const { test } = require('node:test')
const { join } = require('node:path')
const { Worker } = require('node:worker_threads')
const { Agent, request } = require('undici')
const { createThreadInterceptor } = require('../')

const createTestInterceptor = (interceptorOpts) => {
  return dispatch => {
    return function InterceptedDispatch (opts, handler) {
      const onRequestStart = handler.onRequestStart.bind(handler)
      const onResponseStart = handler.onResponseStart.bind(handler)

      handler.onRequestStart = (...args) => {
        interceptorOpts.onRequestStart()
        return onRequestStart(...args)
      }

      handler.onResponseStart = (...args) => {
        interceptorOpts.onResponseStart()
        return onResponseStart(...args)
      }

      return dispatch(opts, handler)
    }
  }
}

test('basic', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  await interceptor.route('myserver', worker)

  const as = new AsyncLocalStorage()

  let onRequestContextId = null
  let onResponseContextId = null

  const testInterceptor = createTestInterceptor({
    onRequestStart () {
      onRequestContextId = as.getStore()
    },
    onResponseStart () {
      onResponseContextId = as.getStore()
    },
  })

  const agent = new Agent().compose([
    interceptor,
    testInterceptor,
  ])

  const contextId = 42
  await as.run(contextId, async () => {
    const { statusCode } = await request('http://myserver.local', {
      dispatcher: agent,
    })
    strictEqual(statusCode, 200)
  })

  strictEqual(onRequestContextId, contextId)
  strictEqual(onResponseContextId, contextId)
})
