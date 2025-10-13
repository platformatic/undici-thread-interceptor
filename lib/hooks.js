'use strict'

const supportedHooks = [
  'onChannelCreation',
  'onServerRequest',
  'onServerResponse',
  'onServerError',
  'onClientRequest',
  'onClientResponse',
  'onClientResponseEnd',
  'onClientError'
]

class Hooks {
  onChannelCreation = []
  onServerRequest = []
  onServerResponse = []
  onServerError = []
  onClientRequest = []
  onClientResponse = []
  onClientResponseEnd = []
  onClientError = []

  constructor (opts) {
    for (const hook of supportedHooks) {
      const value = opts?.[hook]
      if (value) {
        this[hook] = this.#normalizeHook(value)
      }
    }
  }

  #normalizeHook (hook) {
    const hooks = Array.isArray(hook) ? hook : [hook]
    for (const h of hooks) {
      this.#validateHook(h)
    }
    return hooks
  }

  #validateHook (hook) {
    if (typeof hook !== 'function') throw new Error(`Expected a function, got ${typeof hook}`)
    const isAsync = hook.constructor.name === 'AsyncFunction'
    if (isAsync) throw new Error('Async hooks are not supported')
  }

  fireOnChannelCreation (first, second) {
    for (const hook of this.onChannelCreation) {
      if (hook(first, second) === false) {
        return false
      }
    }

    return true
  }

  fireOnServerRequest (req, cb) {
    // Chain onServerRequest hooks properly
    let index = 0
    const hooks = this.onServerRequest

    if (hooks.length === 0) {
      cb()
      return
    }

    const next = () => {
      if (index >= hooks.length) {
        cb()
        return
      }
      const hook = hooks[index++]
      hook(req, next)
    }

    next()
  }

  fireOnServerResponse (req, res) {
    for (const hook of this.onServerResponse) {
      hook(req, res)
    }
  }

  fireOnServerError (req, res, error) {
    for (const hook of this.onServerError) {
      hook(req, res, error)
    }
  }

  fireOnClientRequest (req, ctx) {
    for (const hook of this.onClientRequest) {
      hook(req, ctx)
    }
  }

  fireOnClientResponse (req, res, ctx) {
    for (const hook of this.onClientResponse) {
      hook(req, res, ctx)
    }
  }

  fireOnClientResponseEnd (req, res, ctx) {
    for (const hook of this.onClientResponseEnd) {
      hook(req, res, ctx)
    }
  }

  fireOnClientError (req, res, ctx, error) {
    for (const hook of this.onClientError) {
      hook(req, res, ctx, error)
    }
  }
}

module.exports = { Hooks }
