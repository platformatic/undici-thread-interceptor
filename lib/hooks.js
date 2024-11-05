'use strict'

const supportedHooks = [
  'onServerRequest',
  'onServerResponse',
  'onServerError',
  'onClientRequest',
  'onClientResponse',
  'onClientError']

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

  fireOnServerRequest (...args) {
    return this.run(this.onServerRequest, ...args)
  }

  fireOnServerResponse (...args) {
    return this.run(this.onServerResponse, ...args)
  }

  fireOnServerError (...args) {
    return this.run(this.onServerError, ...args)
  }

  fireOnClientRequest (...args) {
    return this.run(this.onClientRequest, ...args)
  }

  fireOnClientResponse (...args) {
    return this.run(this.onClientResponse, ...args)
  }

  fireOnClientError (...args) {
    return this.run(this.onClientError, ...args)
  }
}

module.exports = Hooks
