'use strict'

const { AsyncResource } = require('node:async_hooks')
const RoundRobin = require('./lib/roundrobin')
const hyperid = require('hyperid')
const { getGlobalDispatcher, setGlobalDispatcher } = require('undici')
const { threadId, MessageChannel, parentPort } = require('worker_threads')
const inject = require('light-my-request')
const Hooks = require('./lib/hooks')
const DispatchController = require('./lib/dispatch-controller')
const WrapHandler = require('./lib/wrap-handler')
const { MessagePortWritable, MessagePortReadable } = require('./lib/message-port-streams')

const kAddress = Symbol('undici-thread-interceptor.address')

const MAX_BODY = 32 * 1024

function createThreadInterceptor (opts) {
  const routes = new Map()
  const portInflights = new Map()
  const forwarded = new Map()
  const nextId = hyperid()
  const domain = opts?.domain
  const hooks = new Hooks(opts)
  let timeout = opts?.timeout

  if (timeout === true) {
    timeout = 5000
  }

  const res = (dispatch) => {
    return (opts, handler) => {
      let url = opts.origin
      if (!(url instanceof URL)) {
        url = new URL(opts.path, url)
      }

      handler = handler.onRequestStart ? handler : new WrapHandler(handler)

      // Hostnames are case-insensitive
      const roundRobin = routes.get(url.hostname.toLowerCase())
      if (!roundRobin) {
        if (dispatch && (domain === undefined || !url.hostname.endsWith(domain))) {
          return dispatch(opts, handler)
        } else {
          throw new Error('No server found for ' + url.hostname + ' in ' + threadId)
        }
      }

      const port = roundRobin.next()

      if (port[kAddress]) {
        return dispatch({ ...opts, origin: port[kAddress] }, handler)
      }

      const headers = {
        ...opts?.headers,
      }

      delete headers.connection
      delete headers['transfer-encoding']
      headers.host = url.host

      const id = nextId()
      const newOpts = {
        ...opts,
        headers,
      }

      delete newOpts.dispatcher

      const controller = new DispatchController()

      // We use it as client context where hooks can add non-serializable properties
      const clientCtx = {}
      hooks.fireOnClientRequest(newOpts, clientCtx)

      if (typeof newOpts.body?.resume === 'function' || newOpts.body?.[Symbol.asyncIterator]) {
        const body = newOpts.body
        delete newOpts.body
        const transferable = MessagePortWritable.asTransferable({
          // TODO(mollina): add the parent port here, as we would need to have the worker instead
          body
        })

        port.postMessage({ type: 'request', id, opts: newOpts, port: transferable.port, threadId }, transferable.transferList)
      } else {
        port.postMessage({ type: 'request', id, opts: newOpts, threadId })
      }

      const inflights = portInflights.get(port)

      let handle

      if (typeof timeout === 'number') {
        handle = setTimeout(() => {
          inflights.delete(id)
          const err = new Error(`Timeout while waiting from a response from ${url.hostname}`)
          handler.onResponseError(controller, err)
        }, timeout)
      }

      inflights.set(id, AsyncResource.bind((err, res) => {
        clearTimeout(handle)

        if (err) {
          hooks.fireOnClientError(newOpts, res, clientCtx, err)
          handler.onResponseError(controller, err)
          return
        }
        hooks.fireOnClientResponse(newOpts, res, clientCtx)

        try {
          handler.onRequestStart(controller, {})
          if (controller.aborted) {
            handler.onResponseError(controller, controller.reason)
            return
          }
          handler.onResponseStart(
            controller,
            res.statusCode,
            res.headers,
            res.statusMessage
          )
          // TODO(mcollina): I don't think this can be triggered,
          // but we should consider adding a test for this in the future
          /* c8 ignore next 5 */
          if (controller.aborted) {
            // TODO(mcollina): destroy the port?
            handler.onResponseError(controller, controller.reason)
            return
          }
        } catch (err) {
          // TODO: should we destroy the port?
          handler.onResponseError(controller, err)
          return
        }

        if (res.port) {
          const body = new MessagePortReadable({
            // TODO(mcollina): add reference to worker/parent port here, otherwise we won't know if the other party is dead
            port: res.port
          })

          controller.on('resume', () => {
            body.resume()
          })

          // TODO(mcollina): this is missing a test
          /* c8 ignore next 3 */
          controller.on('pause', () => {
            body.pause()
          })

          body.on('data', (chunk) => {
            handler.onResponseData(controller, chunk)
          })

          body.on('end', () => {
            handler.onResponseEnd(controller, [])
          })

          // TODO(mcollina): this is missing a test
          /* c8 ignore next 3 */
          body.on('error', (err) => {
            handler.onResponseError(controller, err)
          })
        } else {
          handler.onResponseData(controller, res.body)
          handler.onResponseEnd(controller, [])
        }
      }))

      return true
    }
  }

  res.route = (url, port, forward = true) => {
    if (port instanceof Array) {
      for (const p of port) {
        res.route(url, p, forward)
      }
      return
    }

    if (domain && !url.endsWith(domain)) {
      url += domain
    }

    // Hostname are case-insensitive
    url = url.toLowerCase()

    if (!forwarded.has(port)) {
      forwarded.set(port, new Set())
    }

    if (forward) {
      for (const [key, roundRobin] of routes) {
        for (const otherPort of roundRobin) {
          const { port1, port2 } = new MessageChannel()
          forwarded.get(otherPort).add(port2)
          forwarded.get(port).add(port1)
          otherPort.postMessage({ type: 'route', url, port: port2, threadId: port.threadId }, [port2])
          port.postMessage({ type: 'route', url: key, port: port1, threadId: otherPort.threadId }, [port1])
        }
      }
    }

    if (!routes.has(url)) {
      routes.set(url, new RoundRobin())
    }

    const roundRobin = routes.get(url)
    roundRobin.add(port)

    // We must copy the threadId outsise because it can be nulled
    // by Node.js
    const threadId = port.threadId

    function onClose () {
      const roundRobin = routes.get(url)
      roundRobin.remove(port)
      for (const f of forwarded.get(port)) {
        f.close()
      }
      for (const cb of portInflights.get(port).values()) {
        cb(new Error('Worker exited'))
      }

      if (roundRobin.length === 0) {
        routes.delete(url)
      }

      // Notify other threads that any eventual network address for this route is no longer valid
      res.setAddress(url, threadId)
    }

    // If port is a worker, we need to remove it from the routes
    // when it exits
    port.on('exit', onClose)
    port.on('close', onClose)

    const inflights = new Map()
    portInflights.set(port, inflights)
    port.on('message', (msg) => {
      if (msg.type === 'response') {
        const { id, res, err } = msg
        const inflight = inflights.get(id)
        if (inflight) {
          inflights.delete(id)
          inflight(err, res)
        }
      } else if (msg.type === 'address') {
        if (!msg.url) {
          res.setAddress(url, port.threadId, msg.address, forward)
        } else {
          const roundRobin = routes.get(msg.url)
          if (!roundRobin) {
            return
          }

          res.setAddress(msg.url, msg.threadId, msg.address, false)
        }
      }
    })
  }

  res.setAddress = (url, threadId, address, forward = true) => {
    const port = routes.get(url)?.findByThreadId(threadId)

    if (port) {
      port[kAddress] = address
    }

    if (!forward) {
      return
    }

    for (const [, roundRobin] of routes) {
      for (const otherPort of roundRobin) {
        // Avoid loops, do not send the message to the source
        if (otherPort.threadId !== threadId) {
          otherPort.postMessage({ type: 'address', url, address, threadId })
        }
      }
    }
  }

  res.close = () => {
    for (const [, roundRobin] of routes) {
      for (const otherPort of roundRobin) {
        otherPort.close()
      }
    }
  }
  res.hooks = hooks

  return res
}

function wire ({ server: newServer, port, ...undiciOpts }) {
  const interceptor = createThreadInterceptor(undiciOpts)
  setGlobalDispatcher(getGlobalDispatcher().compose(interceptor))

  let server
  let hasInject = false
  replaceServer(newServer)

  function replaceServer (newServer) {
    server = newServer

    if (typeof server === 'string') {
      parentPort.postMessage({ type: 'address', address: server, threadId })
    } else {
      hasInject = typeof server?.inject === 'function'
    }
  }

  function onMessage (msg) {
    if (msg.type === 'request') {
      const { id, opts, port: bodyPort } = msg
      let bodyReadable

      if (bodyPort) {
        bodyReadable = new MessagePortReadable({
          // TODO(mcollina): add reference to worker/parent port here, otherwise we won't know if the other party is dead
          port: bodyPort
        })
      }

      const headers = {}

      for (const [key, value] of Object.entries(opts.headers)) {
        if (value !== undefined && value !== null) {
          headers[key] = value
        }
      }

      const injectOpts = {
        method: opts.method,
        url: opts.path,
        headers,
        query: opts.query,
        body: opts.body || bodyReadable,
        payloadAsStream: true
      }
      interceptor.hooks.fireOnServerRequest(injectOpts, () => {
        const onInject = async (err, res) => {
          if (err) {
            interceptor.hooks.fireOnServerError(injectOpts, res, err)
            port.postMessage({ type: 'response', id, err })
            return
          }

          const length = res.headers['content-length']
          const parsedLength = length === undefined ? MAX_BODY : Number(length)

          let newRes
          let forwardRes
          let transferList

          if (parsedLength < MAX_BODY) {
            // TODO(mcollina): handle errors
            const body = await collectBody(res.stream())

            newRes = {
              headers: res.headers,
              statusCode: res.statusCode,
              body
            }

            forwardRes = {
              type: 'response',
              id,
              res: newRes,
            }
          } else {
            const transferable = MessagePortWritable.asTransferable({
              // TODO(mollina): add the parent port here, as we would need to have the worker instead
              body: res.stream()
            })
            transferList = transferable.transferList

            newRes = {
              headers: res.headers,
              statusCode: res.statusCode,
              port: transferable.port,
            }

            forwardRes = {
              type: 'response',
              id,
              res: newRes,
            }
          }

          interceptor.hooks.fireOnServerResponse(injectOpts, newRes)

          // So we route the message back to the port
          // that sent the request
          this.postMessage(forwardRes, transferList)
        }

        if (!server) {
          port.postMessage({
            type: 'response',
            id,
            err: new Error('No server found for ' + injectOpts.headers.host + ' in ' + threadId),
          })

          return
        }

        if (hasInject) {
          server.inject(injectOpts, onInject)
        } else {
          inject(server, injectOpts, onInject)
        }
      })
    } else if (msg.type === 'route') {
      msg.port.threadId = msg.threadId
      interceptor.route(msg.url, msg.port, false)
      msg.port.on('message', onMessage)
    } else if (msg.type === 'address') {
      interceptor.setAddress(msg.url, msg.threadId, msg.address, false)
    }
  }

  port.on('message', onMessage)
  return { interceptor, replaceServer }
}

async function collectBody (stream) {
  const data = []

  for await (const chunk of stream) {
    data.push(chunk)
  }

  /* c8 ignore next 7 */
  if (data[0] instanceof Buffer || data[0] instanceof Uint8Array) {
    return Buffer.concat(data)
  } else {
    throw new Error('Cannot transfer streams of strings or objects')
  }
}

module.exports.createThreadInterceptor = createThreadInterceptor
module.exports.wire = wire
