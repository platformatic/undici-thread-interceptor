'use strict'

const { test } = require('node:test')
const { strictEqual } = require('node:assert')
const { Readable } = require('node:stream')
const { MessageChannel } = require('node:worker_threads')
const { createThreadInterceptor, wire } = require('../')
const { MessagePortWritable } = require('../lib/message-port-streams')
const {
  MESSAGE_REQUEST,
  MESSAGE_RESPONSE,
  MESSAGE_ROUTE_ADD,
  MESSAGE_ROUTE_ADDED,
  MESSAGE_WIRE
} = require('../lib/utils')

const requestOpts = { origin: 'http://orphaned.local', path: '/', method: 'GET', headers: {} }

// An orphaned port shows up as a promise that never settles, so every wait in
// this file has a deadline: an unbounded await would turn a failure into a hang.
function bounded (promise, description) {
  let handle

  const deadline = new Promise((resolve, reject) => {
    handle = setTimeout(() => reject(new Error(`Timeout while waiting for ${description}`)), 2000)
    handle.unref()
  })

  return Promise.race([promise, deadline]).finally(() => clearTimeout(handle))
}

// The handler methods are invoked unconditionally, so all of them must exist.
// They only ever hand what they observed back to the test: onResponseError is
// called from inside the interceptor's own try block, so an assertion throwing
// in there is caught and delivered back to onResponseError as a new error,
// which reports the failure as a diff of a diff. The assertions live in the
// tests below instead.
function handler (overrides) {
  return {
    onRequestStart () {},
    onResponseStart () {},
    onResponseData () {},
    onResponseEnd () {},
    onResponseError () {},
    ...overrides
  }
}

// The response body is streamed from a source that never ends: the sending side
// keeps buffering until the receiving side tears the port down, so the source
// being destroyed is the observable proof that the teardown propagated.
function orphanedBody (t) {
  const source = new Readable({ read () {} })
  source.push('never delivered')

  // The teardown destroys the source with an error: swallow it and observe
  // 'close', which is emitted on both the error and the plain close path.
  source.on('error', () => {})

  // A failing subtest would otherwise leave its orphaned channel open, which
  // keeps the event loop alive and turns a red subtest into a hanging one.
  t.after(() => source.destroy())

  const closed = new Promise(resolve => source.once('close', resolve))
  const transferable = MessagePortWritable.asTransferable({ body: source })

  return { sourceClosed: bounded(closed, 'the response body source to be torn down'), transferable }
}

// A peer that speaks just enough of the mesh protocol to be routable: it answers
// the wire handshake and disposes of the loopback channels that are opened for a
// thread registered under its own hostname.
function meshPeer (t, port) {
  const received = []
  const waiting = []

  port.on('message', message => {
    if (message.type === MESSAGE_WIRE) {
      port.postMessage({ type: MESSAGE_WIRE, ready: true, address: null })
    } else if (message.type === MESSAGE_ROUTE_ADD) {
      message.port.close()
      port.postMessage({ type: MESSAGE_ROUTE_ADDED, threadId: message.threadId })
    } else if (message.type === MESSAGE_REQUEST) {
      const waiter = waiting.shift()

      if (waiter) {
        waiter(message)
      } else {
        received.push(message)
      }
    }
  })

  t.after(() => port.close())

  return {
    nextRequest () {
      if (received.length > 0) {
        return Promise.resolve(received.shift())
      }

      return bounded(new Promise(resolve => waiting.push(resolve)), 'the request to reach the peer')
    },
    respondWith (id, transferable) {
      port.postMessage(
        { type: MESSAGE_RESPONSE, id, res: { statusCode: 200, headers: {}, port: transferable.port } },
        transferable.transferList
      )
    }
  }
}

// A coordinator thread: its routes dispatch the inbound responses in
// lib/coordinator.js.
async function coordinatorMesh (t, timeout, alias) {
  const channel = new MessageChannel()
  const peer = meshPeer(t, channel.port2)

  const interceptor = createThreadInterceptor({ domain: '.local', timeout, meshTimeout: 1000 })
  t.after(() => channel.port1.close())

  await bounded(interceptor.route('orphaned', channel.port1), 'the wire handshake')

  if (alias) {
    await bounded(interceptor.route(alias, channel.port1), 'the wire handshake of the second hostname')
  }

  return { dispatch: interceptor(() => false), peer }
}

// A wired thread: its routes dispatch the inbound responses in lib/wire.js,
// which carries a second copy of the same handling. A fix applied to only one of
// the two leaves the other one leaking.
async function wiredMesh (t, timeout) {
  const parent = new MessageChannel()
  const route = new MessageChannel()
  const peer = meshPeer(t, route.port2)

  // wire() composes the global dispatcher of this thread, which is harmless
  // here: every request below is dispatched explicitly.
  const { interceptor } = wire({ port: parent.port2, domain: '.local', timeout })
  t.after(() => {
    parent.port1.close()
    parent.port2.close()
  })

  const routed = bounded(
    new Promise(resolve => {
      parent.port1.on('message', message => {
        if (message.type === MESSAGE_ROUTE_ADDED) {
          resolve()
        }
      })
    }),
    'the route to be registered in the wired thread'
  )

  parent.port1.postMessage(
    {
      type: MESSAGE_ROUTE_ADD,
      url: 'orphaned.local',
      port: route.port1,
      ready: true,
      address: null,
      threadId: 42
    },
    [route.port1]
  )

  await routed

  return { dispatch: interceptor(() => false), peer }
}

// A delivered response carries a body port that its reader owns: the checks
// above must not reach for it.
function deliveredBody (t) {
  const source = new Readable({ read () {} })
  source.push('the response body')
  source.push(null)
  t.after(() => source.destroy())

  return MessagePortWritable.asTransferable({ body: source })
}

async function lateResponseHasNoConsumer (t, createMesh) {
  const { dispatch, peer } = await createMesh(t, 100)

  const timedOut = Promise.withResolvers()
  dispatch({ ...requestOpts }, handler({
    onResponseError (controller, error) {
      timedOut.resolve(error)
    }
  }))

  const request = await peer.nextRequest()

  // Waiting for the timeout first is what leaves the response without a
  // consumer: it is the timeout that drops the inflight entry.
  const error = await bounded(timedOut.promise, 'the request to time out')
  strictEqual(error.message, 'Timeout while waiting from a response from orphaned.local')

  const { sourceClosed, transferable } = orphanedBody(t)
  peer.respondWith(request.id, transferable)
  await sourceClosed
}

test('closes orphaned response body ports so the sender can release buffered data', async t => {
  await t.test('a response that arrives after the request timed out has no consumer', async t => {
    await lateResponseHasNoConsumer(t, coordinatorMesh)
    await lateResponseHasNoConsumer(t, wiredMesh)
  })

  await t.test('a response for a request that was aborted before the body started', async t => {
    const { dispatch, peer } = await coordinatorMesh(t)

    const aborted = Promise.withResolvers()
    dispatch({ ...requestOpts }, handler({
      onRequestStart (controller) {
        controller.abort(new Error('aborted before response'))
      },
      onResponseError (controller, error) {
        aborted.resolve(error)
      }
    }))

    const request = await peer.nextRequest()

    const { sourceClosed, transferable } = orphanedBody(t)
    peer.respondWith(request.id, transferable)
    await sourceClosed
    const error = await bounded(aborted.promise, 'the abort to reach the handler')
    strictEqual(error.message, 'aborted before response')
  })

  await t.test('an abort while the body is streaming tears the stream down', async t => {
    const { dispatch, peer } = await coordinatorMesh(t)

    const errored = Promise.withResolvers()
    dispatch({ ...requestOpts }, handler({
      onResponseData (controller) {
        controller.abort(new Error('aborted mid-stream'))
      },
      onResponseError (controller, error) {
        errored.resolve(error)
      }
    }))

    const request = await peer.nextRequest()

    const { sourceClosed, transferable } = orphanedBody(t)
    peer.respondWith(request.id, transferable)
    const error = await bounded(errored.promise, 'the abort to reach the handler')
    strictEqual(error.message, 'aborted mid-stream')
    await sourceClosed
  })

  await t.test('an abort with a reason that cannot be structured-cloned', async t => {
    const { dispatch, peer } = await coordinatorMesh(t)

    // Abort reasons come from the caller: failing to forward one over the port
    // must not leave the port, and the body buffered behind it, alive. The error
    // the handler receives is deliberately not asserted, it is the one the
    // failed clone produces until the reason can be forwarded again.
    const reason = new Error('aborted with an unclonable reason', { cause: { notCloneable: () => {} } })
    const errored = Promise.withResolvers()
    dispatch({ ...requestOpts }, handler({
      onResponseData (controller) {
        controller.abort(reason)
      },
      onResponseError () {
        errored.resolve()
      }
    }))

    const request = await peer.nextRequest()

    const { sourceClosed, transferable } = orphanedBody(t)
    peer.respondWith(request.id, transferable)
    await bounded(errored.promise, 'the abort to reach the handler')
    await sourceClosed
  })
})

test('a delivered response keeps its body port when the target has a second hostname', async t => {
  // Registering the same port under a second hostname attaches the inbound
  // response handling once per hostname: only the first invocation finds the
  // request, and the others must leave the body port to the reader.
  const { dispatch, peer } = await coordinatorMesh(t, undefined, 'aliased')

  const chunks = []
  const ended = Promise.withResolvers()
  dispatch({ ...requestOpts }, handler({
    onResponseData (controller, chunk) {
      chunks.push(chunk.toString())
    },
    onResponseEnd () {
      ended.resolve()
    },
    onResponseError (controller, error) {
      ended.reject(error)
    }
  }))

  const request = await peer.nextRequest()
  peer.respondWith(request.id, deliveredBody(t))

  await bounded(ended.promise, 'the response body to be delivered')
  strictEqual(chunks.join(''), 'the response body')
})
