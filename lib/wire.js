'use strict'

const inject = require('light-my-request')
const { threadId } = require('node:worker_threads')
const { getGlobalDispatcher, setGlobalDispatcher } = require('undici')
const diagnosticsChannel = require('node:diagnostics_channel')

const { addRoute: commonAddRoute, setAddress, removeRoute } = require('./common')
const { MessagePortWritable, MessagePortReadable } = require('./message-port-streams')
const {
  debug,
  kHasInject,
  kHooks,
  kInflightIncoming,
  kInflightOutgoing,
  kRoutes,
  kServer,
  kThread,
  MAX_BODY,
  MESSAGE_ADDRESS,
  MESSAGE_CLOSE,
  MESSAGE_REQUEST,
  MESSAGE_RESPONSE,
  MESSAGE_ROUTE_ADD,
  MESSAGE_ROUTE_REMOVE,
  MESSAGE_ROUTE_REMOVED,
  waitMessage,
  withResolvers
} = require('./utils')

const CHANNEL_NAME_REQUEST_START = 'http.server.request.start'
const CHANNEL_NAME_RESPONSE_FINISH = 'http.server.response.finish'
const channelStart = diagnosticsChannel.channel(CHANNEL_NAME_REQUEST_START)
const channelFinish = diagnosticsChannel.channel(CHANNEL_NAME_RESPONSE_FINISH)

async function collectBody (stream) {
  const data = []

  for await (const chunk of stream) {
    data.push(chunk)
  }

  /* c8 ignore next 7 */
  if (data[0] instanceof Buffer || data[0] instanceof Uint8Array || data.length === 0) {
    return Buffer.concat(data)
  } else {
    throw new Error('Cannot transfer streams of strings or objects')
  }
}

async function onInject (interceptor, port, id, resolve, injectOpts, error, res) {
  if (error) {
    channelFinish.publish({
      request: injectOpts,
      response: res,
      server: interceptor[kServer]
    })

    interceptor[kHooks].fireOnServerError(injectOpts, res, error)
    port.postMessage({ type: MESSAGE_RESPONSE, id, error })

    resolve()
    return
  }

  const length = res.headers['content-length']
  const parsedLength = length === undefined ? MAX_BODY : Number(length)

  let responseMessage = {
    type: MESSAGE_RESPONSE,
    id,
    res: { headers: res.headers, statusCode: res.statusCode }
  }
  let transferList = []

  try {
    if (parsedLength < MAX_BODY) {
      responseMessage.res.body = await collectBody(res.stream())
    } else {
      const transferable = MessagePortWritable.asTransferable({ body: res.stream() })
      responseMessage.res.port = transferable.port
      transferList = transferable.transferList
    }
  } catch (error) {
    responseMessage = { type: MESSAGE_RESPONSE, id, error }
  }

  channelFinish.publish({
    request: injectOpts,
    response: res,
    server: interceptor[kServer]
  })

  interceptor[kHooks].fireOnServerResponse(injectOpts, responseMessage)
  port.postMessage(responseMessage, transferList)
  resolve()
}

function onWireMessage (interceptor, port, message) {
  debug('onWireMessage', message)

  switch (message.type) {
    case MESSAGE_REQUEST:
      onRequest(interceptor, port, message)
      break
    case MESSAGE_RESPONSE:
      // eslint-disable-next-line no-case-declarations
      const inflight = port[kInflightOutgoing].get(message.id)

      if (inflight) {
        const { id, res, error } = message

        port[kInflightOutgoing].delete(id)
        inflight(error, res)
      }

      break
    case MESSAGE_ROUTE_ADD:
      message.port[kThread] = message.threadId
      message.port.on('message', onWireMessage.bind(null, interceptor, message.port))

      interceptor.route(message.url, message.port)
      break
    case MESSAGE_ROUTE_REMOVE:
      removeRoute(interceptor, message.threadId)
      port.postMessage({ type: MESSAGE_ROUTE_REMOVED, threadId: message.threadId })
      break
    case MESSAGE_ADDRESS:
      setAddress(interceptor, message.url, message.threadId, message.address)
      break
    case MESSAGE_CLOSE:
      interceptor.close()
      break
  }
}

function onRequest (interceptor, port, message) {
  const { id, opts, port: bodyPort } = message
  let bodyReadable

  if (bodyPort) {
    bodyReadable = new MessagePortReadable({
      port: bodyPort
    })
  }

  const headers = {}
  const { promise, resolve } = withResolvers()

  // Autoclean from the list
  promise.finally(() => {
    interceptor[kInflightIncoming].delete(id)
  })

  interceptor[kInflightIncoming].set(id, promise)

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

  channelStart.publish({
    request: injectOpts,
    server: interceptor[kServer]
  })

  interceptor[kHooks].fireOnServerRequest(injectOpts, function () {
    if (!interceptor[kServer]) {
      port.postMessage({
        type: MESSAGE_RESPONSE,
        id,
        error: new Error(`No responding server found for ${injectOpts.headers.host} in thread ${threadId}.`)
      })

      resolve()
      return
    }

    const boundOnInject = onInject.bind(null, interceptor, port, id, resolve, injectOpts)

    if (!Buffer.isBuffer(injectOpts.body) && injectOpts.body instanceof Uint8Array) {
      injectOpts.body = Buffer.from(injectOpts.body)
    }

    if (interceptor[kHasInject]) {
      interceptor[kServer].inject(injectOpts, boundOnInject)
    } else {
      inject(interceptor[kServer], injectOpts, boundOnInject)
    }
  })
}

function addRoute (interceptor, url, ports) {
  if (!Array.isArray(ports)) {
    ports = [ports]
  }

  for (const port of ports) {
    commonAddRoute(interceptor, url, port, onWireMessage)
  }
}

async function close (interceptor, port) {
  // Notify the root, it will take care of propagating the message
  port.postMessage({ type: MESSAGE_ROUTE_REMOVE, threadId })

  // Wait for the root thread to acknowledge the propagation.
  // This is needed to make sure all inflight requests are recorded.
  await waitMessage(port, function (message) {
    return message.type === MESSAGE_ROUTE_REMOVED
  })

  // Paolo: This is impossible to test, as it is almost impossible to produce
  // out of order dispatch of messages sharded between different MessagePorts.
  // We have observed this behavior to happen under high load and therefore
  // we are introducing the while loop as an additional safety measure.
  /* c8 ignore next 4 */
  while (interceptor[kInflightIncoming].size > 0) {
    // Wait for all inflight requests to finish
    await Promise.all(Array.from(interceptor[kInflightIncoming].values()))
  }

  // Notify the parent we have exited
  port.postMessage({ type: MESSAGE_CLOSE })

  // Close all the ports
  for (const [, roundRobin] of interceptor[kRoutes]) {
    for (const otherPort of roundRobin) {
      otherPort.close()
    }
  }
}

function replaceServer (interceptor, port, server) {
  interceptor[kServer] = server

  if (typeof server === 'string') {
    interceptor[kHasInject] = false
    port.postMessage({ type: MESSAGE_ADDRESS, address: server, threadId })
  } else {
    interceptor[kHasInject] = typeof server?.inject === 'function'
  }
}

function createWire (interceptor, newServer, port) {
  setGlobalDispatcher(getGlobalDispatcher().compose(interceptor))

  interceptor[kHasInject] = false
  interceptor[kServer] = undefined
  interceptor[kInflightIncoming] = new Map()

  replaceServer(interceptor, port, newServer)
  interceptor.route = addRoute.bind(null, interceptor)
  interceptor.close = close.bind(null, interceptor, port)

  port.on('message', onWireMessage.bind(null, interceptor, port))

  return {
    interceptor,
    replaceServer: replaceServer.bind(null, interceptor, port),
    close: close.bind(null, interceptor, port)
  }
}

module.exports = { createWire }
