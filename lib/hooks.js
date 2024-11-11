'use strict'

const supportedHooks = [
  'onServerRequest',
  'onServerResponse',
  'onServerError',
  'onClientRequest',
  'onClientResponse',
  'onClientError'
]

class Hooks {
  onServerRequest = []
  onServerResponse = []
  onServerError = []
  onClientRequest = []
  onClientResponse = []
  onClientError = []

  constructor (opts) {
    for (const hook of supportedHooks) {
      const value = opts?.[hook]
      if (value) {
        const hooks = Array.isArray(value) ? value : [value]
        this.#validate(hooks)
        this[`${hook}`].push(...hooks)
      }
    }
  }

  #validate (hooks) {
    for (const hook of hooks) {
      if (typeof hook !== 'function') throw new Error(`Expected a function, got ${typeof hook}`)
      const isAsync = hook.constructor.name === 'AsyncFunction'
      if (isAsync) throw new Error('Async hooks are not supported')
    }
  }

  run (hooks, ...args) {
    for (const fn of hooks) {
      fn(...args)
    }
  }

  fireOnServerRequest (req, cb) {
    this.run(this.onServerRequest, req, cb)
    cb()
  }

  fireOnServerResponse (req, res) {
    this.run(this.onServerResponse, req, res)
  }

  fireOnServerError (req, res, error) {
    this.run(this.onServerError, req, res, error)
  }

  fireOnClientRequest (req, clientCtx) {
    this.run(this.onClientRequest, req, clientCtx)
  }

  fireOnClientResponse (req, res, clientCtx) {
    this.run(this.onClientResponse, req, res, clientCtx)
  }

  fireOnClientError (req, res, clientCtx, error) {
    this.run(this.onClientError, req, res, clientCtx, error)
  }
}

module.exports = Hooks
