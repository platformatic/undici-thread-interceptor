'use strict'

// This is needed to set the nodejs Global Dispatcher
fetch('http://google.com')

const { test } = require('node:test')
const { deepStrictEqual, strictEqual } = require('node:assert')
const { join } = require('node:path')
const { Worker } = require('node:worker_threads')
const { createThreadInterceptor } = require('../')
const { Agent, getGlobalDispatcher, interceptors, request } = require('undici')

class TestHandler {
  #handler

  constructor (handler) {
    this.#handler = handler
  }

  onRequestStart (controller, context) {
    controller.pause()
    strictEqual(controller.paused, true)

    controller.resume()
    strictEqual(controller.paused, false)

    this.#handler.onRequestStart?.(controller, context)
  }

  onRequestUpgrade (controller, statusCode, headers, socket) {
    this.#handler.onRequestUpgrade?.(controller, statusCode, headers, socket)
  }

  onResponseStart (
    controller,
    statusCode,
    statusMessage,
    headers
  ) {
    return this.#handler.onResponseStart?.(
      controller,
      statusCode,
      statusMessage,
      headers
    )
  }

  onResponseData (controller, chunk) {
    this.#handler.onResponseData?.(controller, chunk)
  }

  onResponseEnd (controller, trailers) {
    this.#handler.onResponseEnd?.(controller, trailers)
  }

  onResponseError (controller, err) {
    this.#handler.onResponseError?.(controller, err)
  }
}

test('support undici v7 handler interface', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker)

  const testInterceptor = dispatch => {
    return function TestDispatch (opts, handler) {
      return dispatch(opts, new TestHandler(handler))
    }
  }

  const agent = new Agent()
    .compose(testInterceptor)
    .compose(interceptor)
    .compose(testInterceptor)

  const { statusCode, body } = await request('http://myserver.local', {
    dispatcher: agent
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'world' })
})

test('support undici v6 handler interface', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker)

  const agent = getGlobalDispatcher()
    .compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local', {
    dispatcher: agent
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'world' })
})

test('503 status code re-tries it with undici v6 GD', async (t) => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'worker1.js'), {
    workerData: {
      message: 'mesh',
      whoamiReturn503: true,
    },
  })
  t.after(() => worker1.terminate())
  const worker2 = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker2.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', [worker1, worker2])

  const agent = getGlobalDispatcher().compose(interceptor, interceptors.retry())

  {
    const { body, statusCode } = await request('http://myserver.local/whoami', {
      dispatcher: agent,
    })

    strictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { threadId: worker2.threadId })
  }

  {
    const { body, statusCode } = await request('http://myserver.local/whoami', {
      dispatcher: agent,
    })

    strictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { threadId: worker2.threadId })
  }
})
