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

const kAddress = Symbol('undici-thread-interceptor.address')

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

      if (newOpts.body?.[Symbol.asyncIterator]) {
        collectBodyAndDispatch(newOpts, handler).then(() => {
          port.postMessage({ type: 'request', id, opts: newOpts, threadId })
        }, (err) => {
          clearTimeout(handle)
          hooks.fireOnClientError(newOpts, null, err)
          handler.onResponseError(controller, err)
        })
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
          /* c8 ignore next 4 */
          if (controller.aborted) {
            handler.onResponseError(controller, controller.reason)
            return
          }
        } catch (err) {
          handler.onResponseError(controller, err)
          return
        }

        handler.onResponseData(controller, res.rawPayload)
        handler.onResponseEnd(controller, [])
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
      const { id, opts } = msg

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
        body: opts.body instanceof Uint8Array ? Buffer.from(opts.body) : opts.body,
      }
      interceptor.hooks.fireOnServerRequest(injectOpts, () => {
        const onInject = (err, res) => {
          if (err) {
            interceptor.hooks.fireOnServerError(injectOpts, res, err)
            port.postMessage({ type: 'response', id, err })
            return
          }

          const newRes = {
            headers: res.headers,
            statusCode: res.statusCode,
          }

          if (res.headers['content-type']?.indexOf('application/json') === 0) {
          // TODO(mcollina): maybe use a fast path also for HTML
          // fast path because it's utf-8, use a string
            newRes.rawPayload = res.payload
          } else {
          // slow path, buffer
            newRes.rawPayload = res.rawPayload
          }

          const forwardRes = {
            type: 'response',
            id,
            res: newRes,
          }

          interceptor.hooks.fireOnServerResponse(injectOpts, newRes)

          // So we route the message back to the port
          // that sent the request
          this.postMessage(forwardRes)
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

async function collectBodyAndDispatch (opts) {
  const data = []

  for await (const chunk of opts.body) {
    data.push(chunk)
  }

  if (typeof data[0] === 'string') {
    opts.body = data.join('')
  } else if (data[0] instanceof Buffer || data[0] instanceof Uint8Array) {
    opts.body = Buffer.concat(data)
  } else {
    throw new Error('Cannot transfer streams of objects')
  }
}

module.exports.createThreadInterceptor = createThreadInterceptor
module.exports.wire = wire
