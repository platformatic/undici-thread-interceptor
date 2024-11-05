'use strict'

const RoundRobin = require('./lib/roundrobin')
const hyperid = require('hyperid')
const { getGlobalDispatcher, setGlobalDispatcher } = require('undici')
const { threadId, MessageChannel, parentPort } = require('worker_threads')
const inject = require('light-my-request')
const Hooks = require('./lib/hooks')

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

      hooks.fireOnRequest(newOpts)

      if (newOpts.body?.[Symbol.asyncIterator]) {
        collectBodyAndDispatch(newOpts, handler).then(() => {
          port.postMessage({ type: 'request', id, opts: newOpts, threadId })
        }, (err) => {
          clearTimeout(handle)
          hooks.fireOnError(err)
          handler.onError(err)
        })
      } else {
        port.postMessage({ type: 'request', id, opts: newOpts, threadId })
      }
      const inflights = portInflights.get(port)

      let handle

      if (typeof timeout === 'number') {
        handle = setTimeout(() => {
          inflights.delete(id)
          handler.onError(new Error(`Timeout while waiting from a response from ${url.hostname}`))
        }, timeout)
      }

      inflights.set(id, (err, res) => {
        clearTimeout(handle)

        if (err) {
          hooks.fireOnError(err)
          handler.onError(err)
          return
        }
        hooks.fireOnResponse(res)

        const headers = []
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) {
            for (const v of value) {
              headers.push(key)
              headers.push(v)
            }
          } else {
            headers.push(key)
            headers.push(value)
          }
        }

        let aborted = false
        handler.onConnect((err) => {
          if (err) {
            handler.onError(err)
          }
          aborted = true
        }, {})
        handler.onHeaders(res.statusCode, headers, () => {}, res.statusMessage)
        if (!aborted) {
          handler.onData(res.rawPayload)
          handler.onComplete([])
        }
      })

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
          otherPort.postMessage({ type: 'route', url, port: port2 }, [port2])
          port.postMessage({ type: 'route', url: key, port: port1 }, [port1])
        }
      }
    }

    if (!routes.has(url)) {
      routes.set(url, new RoundRobin())
    }

    const roundRobinIndex = routes.get(url).add(port)

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
      res.setAddress(url, roundRobinIndex)
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
        res.setAddress(url, roundRobinIndex, msg.address, forward)
      }
    })
  }

  res.setAddress = (url, index, address, forward = true) => {
    const port = routes.get(url)?.get(index)

    if (port) {
      port[kAddress] = address
    }

    if (!forward) {
      return
    }

    for (const [, roundRobin] of routes) {
      for (const otherPort of roundRobin) {
        otherPort.postMessage({ type: 'address', url, index, address })
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
      parentPort.postMessage({ type: 'address', address: server })
    } else {
      hasInject = typeof server?.inject === 'function'
    }
  }

  function onMessage (msg) {
    if (msg.type === 'request') {
      const { id, opts } = msg

      const injectOpts = {
        method: opts.method,
        url: opts.path,
        headers: opts.headers,
        query: opts.query,
        body: opts.body instanceof Uint8Array ? Buffer.from(opts.body) : opts.body,
      }

      const onInject = (err, res) => {
        if (err) {
          port.postMessage({ type: 'response', id, err })
          return
        }

        const newRes = {
          headers: res.headers,
          statusCode: res.statusCode,
        }

        if (res.headers['content-type']?.indexOf('application/json')) {
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
    } else if (msg.type === 'route') {
      interceptor.route(msg.url, msg.port, false)
      msg.port.on('message', onMessage)
    } else if (msg.type === 'address') {
      interceptor.setAddress(msg.url, msg.index, msg.address, false)
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
