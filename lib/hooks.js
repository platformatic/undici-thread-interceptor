'use strict'

const supportedHooks = [
  'onServerRequest',
  'onServerResponse',
  'onServerError',
  'onClientRequest',
  'onClientResponse',
  'onClientResponseEnd',
  'onClientError'
]

const noop = function () {}

class Hooks {
  onServerRequest = function (_req, cb) {
    cb()
  }

  onServerResponse = noop
  onServerError = noop
  onClientRequest = noop
  onClientResponse = noop
  onClientResponseEnd = noop
  onClientError = noop

  constructor (opts) {
    for (const hook of supportedHooks) {
      const value = opts?.[hook]
      if (value) {
        this.#validateHook(value)
        this[`${hook}`] = value
      }
    }
  }

  #validateHook (hook) {
    if (typeof hook !== 'function') throw new Error(`Expected a function, got ${typeof hook}`)
    const isAsync = hook.constructor.name === 'AsyncFunction'
    if (isAsync) throw new Error('Async hooks are not supported')
  }

  fireOnServerRequest (req, cb) {
    return this.onServerRequest(req, cb)
  }

  fireOnServerResponse (req, res) {
    return this.onServerResponse(req, res)
  }

  fireOnServerError (req, res, error) {
    return this.onServerError(req, res, error)
  }

  fireOnClientRequest (req, ctx) {
    return this.onClientRequest(req, ctx)
  }

  fireOnClientResponse (req, res, ctx) {
    return this.onClientResponse(req, res, ctx)
  }

  fireOnClientResponseEnd (req, res, ctx) {
    return this.onClientResponseEnd(req, res, ctx)
  }

  fireOnClientError (req, res, ctx, error) {
    return this.onClientError(req, res, ctx, error)
  }
}

module.exports = { Hooks }
