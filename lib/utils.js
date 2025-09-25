'use strict'

const { threadId } = require('node:worker_threads')
const { debuglog } = require('node:util')

// When we fully switch to Node 22, this can be removed and directly replaced with Promise.withResolvers
function withResolvers () {
  let resolve
  let reject

  const promise = new Promise((_resolve, _reject) => {
    resolve = _resolve
    reject = _reject
  })

  return { promise, resolve, reject }
}

function waitMessage (target, test) {
  return new Promise(function (resolve) {
    function onMessage (message) {
      if (test(message)) {
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

module.exports = {
  debug: debuglog('undici-thread-interceptor').bind(null, `currentThread: ${threadId}`),
  kAddress: Symbol('undici-thread-interceptor.address'),
  kClosed: Symbol('undici-thread-interceptor.closed'),
  kDomain: Symbol('undici-thread-interceptor.domain'),
  kHasInject: Symbol('undici-thread-interceptor.hasInject'),
  kHooks: Symbol('undici-thread-interceptor.hooks'),
  kInflightIncoming: Symbol('undici-thread-interceptor.inflight.incoming'),
  kInflightOutgoing: Symbol('undici-thread-interceptor.inflight.outgoing'),
  kRoutes: Symbol('undici-thread-interceptor.routes'),
  kServer: Symbol('undici-thread-interceptor.server'),
  kThread: Symbol('undici-thread-interceptor.thread'),
  kQueue: Symbol('undici-thread-interceptor.queue'),
  // Max queue is set to 8 because that's the number of immediates
  // that libuv process before yielding to the event loop.
  MAX_QUEUE: 8,
  MAX_BODY: 32 * 1024,
  MESSAGE_ADDRESS: 'undici-thread-interceptor.address',
  MESSAGE_CLOSE: 'undici-thread-interceptor.close',
  MESSAGE_REQUEST: 'undici-thread-interceptor.request',
  MESSAGE_RESPONSE: 'undici-thread-interceptor.response',
  MESSAGE_ROUTE_ADD: 'undici-thread-interceptor.route.add',
  MESSAGE_ROUTE_REMOVE: 'undici-thread-interceptor.route.remove',
  MESSAGE_ROUTE_REMOVED: 'undici-thread-interceptor.route.removed',
  waitMessage,
  withResolvers
}
