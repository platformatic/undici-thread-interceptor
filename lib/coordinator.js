'use strict'

const { MessageChannel } = require('node:worker_threads')

const {
  addRoute: commonAddRoute,
  normalizeUrl,
  removeRoute: commonRemoveRoute,
  updateRoute: commonUpdateRoute
} = require('./common')
const {
  debug,
  kAddress,
  kClosed,
  kInflightOutgoing,
  kRoutes,
  kThread,
  kWired,
  kReady,
  kOnReadyHook,
  MESSAGE_WIRE,
  MESSAGE_CLOSE,
  MESSAGE_RESPONSE,
  MESSAGE_ROUTE_ADD,
  MESSAGE_ROUTE_REMOVE,
  MESSAGE_ROUTE_UPDATE,
  MESSAGE_ROUTE_REMOVED,
  waitMessage,
  kDomain,
  kHooks
} = require('./utils')

function onCoordinatorMessage (interceptor, port, url, message) {
  debug('onCoordinatorMessage', message)

  switch (message.type) {
    case MESSAGE_RESPONSE:
      // eslint-disable-next-line no-case-declarations
      const inflight = port[kInflightOutgoing].get(message.id)

      if (inflight) {
        const { id, res, error } = message

        port[kInflightOutgoing].delete(id)
        inflight(error, res)
      }

      break
    case MESSAGE_WIRE:
      wire(interceptor, port, url, message.ready, message.address)
      break
    case MESSAGE_ROUTE_REMOVE:
      removeThreadRoutes(interceptor, message.threadId)
        .then(() => port.postMessage({ type: MESSAGE_ROUTE_REMOVED }))
      break
  }
}

async function addRoute (interceptor, url, ports) {
  if (interceptor[kClosed]) {
    throw new Error('The dispatcher has been closed.')
  }

  if (!Array.isArray(ports)) {
    ports = [ports]
  }

  const promises = []

  for (const port of ports) {
    const added = commonAddRoute(interceptor, url, port, onCoordinatorMessage)
    if (!added) continue

    port[kWired] = false
    port[kReady] = false
    port.postMessage({ type: MESSAGE_WIRE })

    const promise = new Promise(resolve => {
      port[kOnReadyHook] = resolve
    })
    promises.push(promise)
  }

  await Promise.all(promises)
}

function wire (interceptor, port, url, ready, address) {
  /* c8 ignore next 4 */
  if (interceptor[kClosed]) {
    throw new Error('The dispatcher has been closed.')
  }

  const wired = port[kWired]
  port[kWired] = true

  const routes = interceptor[kRoutes]
  const threadId = port[kThread]

  commonUpdateRoute(interceptor, url, threadId, ready, address)

  for (const [key, roundRobin] of routes) {
    const url1 = key.replace(interceptor[kDomain], '').toLowerCase()
    const url2 = url.replace(interceptor[kDomain], '').toLowerCase()

    if (url1 === url2) continue

    const isAllowed = interceptor[kHooks].fireOnChannelCreation(url1, url2)
    if (isAllowed === false) continue

    for (const other of roundRobin) {
      if (other === port || !other[kWired]) {
        continue
      }

      if (wired) {
        other.postMessage(
          {
            type: MESSAGE_ROUTE_UPDATE,
            url,
            ready: port[kReady],
            threadId: port[kThread],
            address: port[kAddress]
          }
        )
        continue
      }

      const { port1, port2 } = new MessageChannel()
      port.postMessage(
        {
          type: MESSAGE_ROUTE_ADD,
          url: url1,
          port: port1,
          ready: other[kReady],
          address: other[kAddress],
          threadId: other[kThread]
        },
        [port1]
      )

      other.postMessage(
        {
          type: MESSAGE_ROUTE_ADD,
          url: url2,
          port: port2,
          ready: port[kReady],
          address: port[kAddress],
          threadId: port[kThread]
        },
        [port2]
      )
    }
  }

  if (ready) {
    port[kOnReadyHook]?.()
    port[kOnReadyHook] = null
  }
}

async function removeRoute (interceptor, url, ports, force = false) {
  url = normalizeUrl(interceptor, url)

  if (interceptor[kClosed] && !force) {
    throw new Error('The dispatcher has been closed.')
  }

  if (!Array.isArray(ports)) {
    ports = [ports]
  }

  const routes = interceptor[kRoutes]
  const roundRobin = routes.get(url)
  if (!roundRobin) return

  const threadIds = []
  for (const port of ports) {
    if (roundRobin.ports?.includes(port)) {
      threadIds.push(port[kThread])
    }
  }

  const promises = []
  for (const threadId of threadIds) {
    promises.push(removeThreadRoutes(interceptor, threadId))
  }
  await Promise.all(promises)
}

async function removeThreadRoutes (interceptor, threadId) {
  const routes = interceptor[kRoutes]
  const otherPorts = new Set()

  for (const roundRobin of routes.values()) {
    for (const otherPort of roundRobin) {
      if (otherPort[kThread] !== threadId) {
        otherPorts.add(otherPort)
      }
    }
  }

  const promises = [commonRemoveRoute(interceptor, threadId)]

  // Notify all ports in the roundRobin that the route has been removed
  for (const otherPort of otherPorts) {
    otherPort.postMessage({ type: MESSAGE_ROUTE_REMOVE, threadId })
    promises.push(waitMessage(otherPort, m =>
      m.type === MESSAGE_ROUTE_REMOVED &&
      m.threadId === threadId
    ))
  }

  await Promise.all(promises)
}

async function close (interceptor) {
  interceptor[kClosed] = true

  const routes = interceptor[kRoutes]
  const ports = []

  // Important: do not call the messages inside the loop as if the collection is mutated some entries might be skipped
  for (const [url, roundRobin] of routes) {
    for (const port of roundRobin) {
      ports.push([url, port])
    }
  }

  for (const [url, port] of ports) {
    /* c8 ignore next 4 - This is hard to test but under high load it might happen */
    // If the port has been removed in the meanwhile, skip it
    if (!routes.get(url)?.ports?.includes(port)) {
      continue
    }

    port.postMessage({ type: MESSAGE_CLOSE })
    await waitMessage(port, message => message.type === MESSAGE_CLOSE)
  }
}

function restart (interceptor) {
  interceptor[kClosed] = false
}

function createCoordinator (interceptor) {
  interceptor.close = close.bind(null, interceptor)
  interceptor.restart = restart.bind(null, interceptor)

  // New interface
  interceptor.addRoute = addRoute.bind(null, interceptor)
  interceptor.removeRoute = removeRoute.bind(null, interceptor)

  // Old interface, should be deprecated at some point
  interceptor.route = addRoute.bind(null, interceptor)
  interceptor.unroute = removeRoute.bind(null, interceptor)

  return interceptor
}

module.exports = { createCoordinator, addRoute }
