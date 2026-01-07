'use strict'

const hyperid = require('hyperid')
const { AsyncResource } = require('node:async_hooks')
const { threadId } = require('node:worker_threads')

const { DispatchController } = require('./dispatch-controller')
const { Hooks } = require('./hooks')
const { MessagePortWritable, MessagePortReadable } = require('./message-port-streams')
const { WrapHandler } = require('./wrap-handler')
const { MESSAGE_REQUEST, LoadSheddingError, kAddress, kDomain, kHooks, kInflightOutgoing, kRoutes } = require('./utils')

// Handler wrapper that fires client hooks for network address dispatch path
class HookHandler {
  #handler
  #hooks
  #opts
  #ctx
  #statusCode

  constructor (handler, hooks, opts, ctx) {
    this.#handler = handler
    this.#hooks = hooks
    this.#opts = opts
    this.#ctx = ctx
  }

  onRequestStart (controller, context) {
    this.#handler.onRequestStart?.(controller, context)
  }

  onResponseStart (controller, statusCode, headers, statusMessage) {
    this.#statusCode = statusCode
    this.#hooks.fireOnClientResponse(this.#opts, { statusCode, headers }, this.#ctx)
    this.#handler.onResponseStart?.(controller, statusCode, headers, statusMessage)
  }

  onResponseData (controller, data) {
    this.#handler.onResponseData?.(controller, data)
  }

  onResponseEnd (controller, trailers) {
    this.#hooks.fireOnClientResponseEnd(this.#opts, { statusCode: this.#statusCode }, this.#ctx)
    this.#handler.onResponseEnd?.(controller, trailers)
  }

  onResponseError (controller, err) {
    this.#hooks.fireOnClientError(this.#opts, null, this.#ctx, err)
    this.#handler.onResponseError?.(controller, err)
  }
}

function createInterceptor (opts) {
  let { domain, timeout } = opts

  if (domain) {
    domain = domain.toLowerCase()
  }

  if (timeout === true) {
    timeout = 5000
  }

  const routes = new Map()
  const hooks = new Hooks(opts)
  const nextId = hyperid()

  const interceptor = function threadInterceptor (dispatch) {
    return function dispatcher (opts, handler) {
      let url = opts.origin
      if (!(url instanceof URL)) {
        url = new URL(opts.path, url)
      }

      const hostname = url.hostname.toLowerCase()

      // No hostname name, proceed with the next dispatcher
      if (domain === undefined || !hostname.endsWith(domain)) {
        return dispatch(opts, handler)
      }

      // Hostnames are case-insensitive
      const route = routes.get(hostname)
      if (!route || route.length === 0) {
        queueMicrotask(() => handler.onError(new Error(`No target found for ${hostname} in thread ${threadId}.`)))
        return true
      }

      let port
      if (hooks.canAccept) {
        // Build context for canAccept check
        const acceptContext = {
          hostname,
          method: opts.method,
          path: opts.path,
          headers: opts.headers
        }
        port = route.findAccepting(hooks.canAccept, acceptContext)
        if (!port) {
          // All workers rejected - shed load immediately
          queueMicrotask(() => handler.onError(new LoadSheddingError()))
          return true
        }
      } else {
        port = route.next()
        if (!port) {
          queueMicrotask(() => handler.onError(new Error(`No target found for ${hostname} in thread ${threadId}.`)))
          return true
        }
      }

      /* c8 ignore next - else */
      handler = handler.onRequestStart ? handler : new WrapHandler(handler)

      if (port[kAddress]) {
        const headers = { ...opts?.headers, host: url.host }
        const newOpts = { ...opts, headers }
        const clientContext = { skipDiagnosticsChannel: true }
        hooks.fireOnClientRequest(newOpts, clientContext)

        const hookHandler = new HookHandler(handler, hooks, newOpts, clientContext)
        return dispatch({ ...newOpts, origin: port[kAddress] }, hookHandler)
      }

      const id = nextId()
      const headers = { ...opts?.headers, host: url.host }
      const newOpts = { ...opts, headers }
      delete headers.connection
      delete headers['transfer-encoding']
      delete newOpts.dispatcher

      const controller = new DispatchController()

      // We use it as client context where hooks can add non-serializable properties
      const clientContext = {}
      hooks.fireOnClientRequest(newOpts, clientContext)

      const requestMessage = { type: MESSAGE_REQUEST, id, opts: newOpts, threadId }
      let transferList = []

      // Send the body as a transferable if it is a stream or an async iterable
      if (typeof newOpts.body?.resume === 'function' || newOpts.body?.[Symbol.asyncIterator]) {
        const transferable = MessagePortWritable.asTransferable({ body: newOpts.body })
        delete newOpts.body

        requestMessage.port = transferable.port
        transferList = transferable.transferList
      }

      let handle

      if (typeof timeout === 'number') {
        handle = setTimeout(function () {
          port[kInflightOutgoing].delete(id)
          handler.onResponseError(controller, new Error(`Timeout while waiting from a response from ${url.hostname}`))
        }, timeout)
      }

      port[kInflightOutgoing].set(
        id,
        AsyncResource.bind(function handleInflightResponse (error, res) {
          clearTimeout(handle)

          if (error) {
            hooks.fireOnClientError(newOpts, res, clientContext, error)
            handler.onResponseError(controller, error)
            return
          }
          hooks.fireOnClientResponse(newOpts, res, clientContext)

          try {
            handler.onRequestStart(controller, {})

            if (controller.aborted) {
              handler.onResponseError(controller, controller.reason)
              return
            }

            handler.onResponseStart(controller, res.statusCode, res.headers, res.statusMessage)
            // TODO(mcollina): I don't think this can be triggered,
            // but we should consider adding a test for this in the future
            /* c8 ignore next 6 */
            if (controller.aborted) {
              res.port?.close()
              handler.onResponseError(controller, controller.reason)
              return
            }
            /* c8 ignore next 6 */
          } catch (error) {
            // No need to close the transferable port here, because it cannot happen
            // for requests with a body
            handler.onResponseError(controller, error)
            return
          }

          if (res.port) {
            const body = new MessagePortReadable({
              port: res.port
            })

            controller.on('resume', function () {
              body.resume()
            })

            controller.on('pause', function () {
              body.pause()
            })

            body.on('data', function (chunk) {
              try {
                handler.onResponseData(controller, chunk)
                /* c8 ignore next 4 */
              } catch (error) {
                res.port.close()
                handler.onResponseError(controller, error)
              }
            })

            body.on('end', function () {
              try {
                handler.onResponseEnd(controller, [])
                /* c8 ignore next 4 */
              } catch (error) {
                res.port.close()
                handler.onResponseError(controller, error)
              }

              hooks.fireOnClientResponseEnd(newOpts, res, clientContext)
            })

            body.on('error', function (error) {
              handler.onResponseError(controller, error)
            })
          } else {
            try {
              handler.onResponseData(controller, res.body)
              handler.onResponseEnd(controller, [])
            } catch (error) {
              handler.onResponseError(controller, error)
            }

            hooks.fireOnClientResponseEnd(newOpts, res, clientContext)
          }
        })
      )

      port.postMessage(requestMessage, transferList)
      return true
    }
  }

  interceptor[kDomain] = domain
  interceptor[kRoutes] = routes
  interceptor[kHooks] = hooks

  return interceptor
}

module.exports = { createInterceptor }
