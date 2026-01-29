'use strict'

const { threadId } = require('node:worker_threads')
const { debuglog } = require('node:util')

function waitMessage (target, options, test) {
  if (typeof options === 'function') {
    test = options
    options = {}
  }

  return new Promise(function (resolve, reject) {
    let timeout = null

    if (options.timeout) {
      timeout = setTimeout(() => {
        target.removeListener('message', onMessage)
        target.removeListener('close', onTargetClosed)
        target.removeListener('exit', onTargetClosed)

        const description = options.description ? ` [${options.description}]` : ''
        const error = new Error(`Timeout waiting for message from ${target.constructor?.name || 'unknown'} (threadId: ${target.threadId ?? 'N/A'})${description}`)
        reject(error)
      }, options.timeout)
    }

    function onMessage (message) {
      if (test(message)) {
        clearTimeout(timeout)
        target.removeListener('message', onMessage)
        target.removeListener('close', onTargetClosed)
        target.removeListener('exit', onTargetClosed)
        resolve(message)
      }
    }

    function onTargetClosed () {
      target.removeListener('message', onMessage)
      target.removeListener('close', onTargetClosed)
      target.removeListener('exit', onTargetClosed)
      resolve(null)
    }

    target.addListener('message', onMessage)
    target.addListener('close', onTargetClosed)
    target.addListener('exit', onTargetClosed)
  })
}

class LoadSheddingError extends Error {
  constructor (message = 'Service Unavailable - Load Shedding') {
    super(message)
    this.name = 'LoadSheddingError'
    this.code = 'UND_ERR_LOAD_SHEDDING'
    this.statusCode = 503
  }
}

module.exports = {
  LoadSheddingError,
  debug: debuglog('undici-thread-interceptor').bind(null, `currentThread: ${threadId}`),
  kAddress: Symbol('undici-thread-interceptor.address'),
  kWired: Symbol('undici-thread-interceptor.wired'),
  kReady: Symbol('undici-thread-interceptor.ready'),
  kPaused: Symbol('undici-thread-interceptor.paused'),
  kClosed: Symbol('undici-thread-interceptor.closed'),
  kDomain: Symbol('undici-thread-interceptor.domain'),
  kHasInject: Symbol('undici-thread-interceptor.hasInject'),
  kHooks: Symbol('undici-thread-interceptor.hooks'),
  kOnReadyHook: Symbol('undici-thread-interceptor.onReadyHook'),
  kInflightIncoming: Symbol('undici-thread-interceptor.inflight.incoming'),
  kInflightOutgoing: Symbol('undici-thread-interceptor.inflight.outgoing'),
  kMeta: Symbol('undici-thread-interceptor.meta'),
  kRoutes: Symbol('undici-thread-interceptor.routes'),
  kServer: Symbol('undici-thread-interceptor.server'),
  kThread: Symbol('undici-thread-interceptor.thread'),
  kQueue: Symbol('undici-thread-interceptor.queue'),
  // Max queue is set to 8 because that's the number of immediates
  // that libuv process before yielding to the event loop.
  MAX_QUEUE: 8,
  MAX_BODY: 32 * 1024,
  MESSAGE_CLOSE: 'undici-thread-interceptor.close',
  MESSAGE_REQUEST: 'undici-thread-interceptor.request',
  MESSAGE_RESPONSE: 'undici-thread-interceptor.response',
  MESSAGE_WIRE: 'undici-thread-interceptor.wire',
  MESSAGE_ROUTE_ADD: 'undici-thread-interceptor.route.add',
  MESSAGE_ROUTE_REMOVE: 'undici-thread-interceptor.route.remove',
  MESSAGE_ROUTE_UPDATE: 'undici-thread-interceptor.route.update',
  MESSAGE_ROUTE_ADDED: 'undici-thread-interceptor.route.added',
  MESSAGE_ROUTE_REMOVED: 'undici-thread-interceptor.route.removed',
  MESSAGE_ROUTE_UPDATED: 'undici-thread-interceptor.route.updated',
  MESSAGE_WIRE_ACK: 'undici-thread-interceptor.wire.ack',
  waitMessage
}
