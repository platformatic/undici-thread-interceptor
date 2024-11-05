'use strict'

const supportedHooks = ['onRequest', 'onResponse', 'onError']

class Hooks {
  onRequest = []
  onResponse = []
  onError = []

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
    }
  }

  async run (hooks, ...args) {
    for (const fn of hooks) {
      await fn(...args)
    }
  }

  fireOnRequest (...args) {
    return this.run(this.onRequest, ...args)
  }

  fireOnResponse (...args) {
    return this.run(this.onResponse, ...args)
  }

  fireOnError (...args) {
    return this.run(this.onError, ...args)
  }
}

module.exports = Hooks
