'use strict'

const { test } = require('node:test')
const { deepStrictEqual, strictEqual } = require('node:assert')
const { join } = require('node:path')
const { Worker } = require('node:worker_threads')
const { createThreadInterceptor } = require('../')
const { Agent, request } = require('undici')

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
