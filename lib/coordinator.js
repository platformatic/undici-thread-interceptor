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
  kMeta,
  kPaused,
  kRoutes,
  kThread,
  kWired,
  kReady,
  kOnReadyHook,
  MESSAGE_WIRE,
  MESSAGE_WIRE_ACK,
  MESSAGE_CLOSE,
  MESSAGE_RESPONSE,
  MESSAGE_ROUTE_ADD,
  MESSAGE_ROUTE_REMOVE,
  MESSAGE_ROUTE_UPDATE,
  MESSAGE_ROUTE_ADDED,
  MESSAGE_ROUTE_REMOVED,
  MESSAGE_ROUTE_UPDATED,
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
        .then(() => port.postMessage({ type: MESSAGE_WIRE_ACK, ready: message.ready }))
      break
    case MESSAGE_ROUTE_REMOVE:
      removeThreadRoutes(interceptor, message.threadId)
        .then(() => port.postMessage({ type: MESSAGE_ROUTE_REMOVED }))
      break
  }
}

async function addRoute (interceptor, url, ports, meta) {
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

    // Store metadata on the port if provided
    if (meta !== undefined) {
      port[kMeta] = meta
    }

    port[kWired] = false
    port[kReady] = false
    port[kAddress] = null
    port.postMessage({ type: MESSAGE_WIRE })

    const promise = new Promise(resolve => {
      port[kOnReadyHook] = resolve
    })
    promises.push(promise)
  }

  await Promise.all(promises)
}

async function wire (interceptor, port, url, ready, address) {
  /* c8 ignore next 1 */
  if (interceptor[kClosed]) return

  // Don't update ready state for explicitly paused workers
  // (they can still receive mesh setup but won't become ready)
  /* c8 ignore next - kPaused is set during pauseWorker and tested via race condition */
  const effectiveReady = port[kPaused] ? false : ready

  if (
    port[kWired] === true &&
    port[kReady] === effectiveReady &&
    port[kAddress] === address
  ) {
    return
  }

  const routes = interceptor[kRoutes]
  const threadId = port[kThread]

  // Check if route was not removed
  // while was waiting to wire the port
  const isExists = routes.get(url)?.ports?.includes(port)
  if (!isExists) return

  const wired = port[kWired]
  port[kWired] = true

  commonUpdateRoute(interceptor, url, threadId, effectiveReady, address)

  const promises = []

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
        promises.push(waitMessage(other, { timeout: 5000 }, m =>
          m.type === MESSAGE_ROUTE_UPDATED &&
          m.threadId === port[kThread]
        ))
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
      promises.push(waitMessage(port, { timeout: 5000 }, m =>
        m.type === MESSAGE_ROUTE_ADDED &&
        m.threadId === other[kThread]
      ))
      promises.push(waitMessage(other, { timeout: 5000 }, m =>
        m.type === MESSAGE_ROUTE_ADDED &&
        m.threadId === port[kThread]
      ))

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

  await Promise.all(promises)

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
    for (const port of roundRobin) {
      if (port[kThread] === threadId) {
        port[kOnReadyHook]?.()
        port[kOnReadyHook] = null
        continue
      }
      if (port[kWired]) {
        otherPorts.add(port)
      }
    }
  }

  const promises = [commonRemoveRoute(interceptor, threadId)]

  // Notify all ports in the roundRobin that the route has been removed
  for (const otherPort of otherPorts) {
    promises.push(waitMessage(otherPort, { timeout: 5000 }, m =>
      m.type === MESSAGE_ROUTE_REMOVED &&
      m.threadId === threadId
    ))
    otherPort.postMessage({ type: MESSAGE_ROUTE_REMOVE, threadId })
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

    const closedPromise = waitMessage(
      port,
      { timeout: 5000 },
      message => message.type === MESSAGE_CLOSE
    )

    port.postMessage({ type: MESSAGE_CLOSE })

    await closedPromise
  }
}

function restart (interceptor) {
  interceptor[kClosed] = false
}

async function pauseWorker (interceptor, port) {
  const routes = interceptor[kRoutes]
  const threadId = port[kThread]

  // Mark as explicitly paused to prevent MESSAGE_WIRE from resetting ready state
  port[kPaused] = true
  port[kReady] = false

  // Find the URL for this port
  let portUrl = null
  for (const [url, roundRobin] of routes) {
    if (roundRobin.ports?.includes(port)) {
      portUrl = url
      break
    }
  }

  /* c8 ignore next - defensive check for race condition where port is removed before pause */
  if (!portUrl) return

  // Update the route state
  commonUpdateRoute(interceptor, portUrl, threadId, false, port[kAddress])

  // Propagate to all other workers in the mesh
  const promises = []
  for (const [, roundRobin] of routes) {
    for (const otherPort of roundRobin) {
      if (otherPort === port || !otherPort[kWired]) continue

      promises.push(waitMessage(otherPort, { timeout: 5000 }, m =>
        m.type === MESSAGE_ROUTE_UPDATED && m.threadId === threadId
      ))
      otherPort.postMessage({
        type: MESSAGE_ROUTE_UPDATE,
        url: portUrl,
        ready: false,
        threadId,
        address: port[kAddress]
      })
    }
  }
  await Promise.all(promises)
}

async function resumeWorker (interceptor, port) {
  const routes = interceptor[kRoutes]
  const threadId = port[kThread]

  // Clear the paused flag and update ready state
  port[kPaused] = false
  port[kReady] = true

  // Find the URL for this port
  let portUrl = null
  for (const [url, roundRobin] of routes) {
    if (roundRobin.ports?.includes(port)) {
      portUrl = url
      break
    }
  }

  /* c8 ignore next - defensive check for race condition where port is removed before resume */
  if (!portUrl) return

  // Update the route state
  commonUpdateRoute(interceptor, portUrl, threadId, true, port[kAddress])

  // Propagate to all other workers in the mesh
  const promises = []
  for (const [, roundRobin] of routes) {
    for (const otherPort of roundRobin) {
      if (otherPort === port || !otherPort[kWired]) continue

      promises.push(waitMessage(otherPort, { timeout: 5000 }, m =>
        m.type === MESSAGE_ROUTE_UPDATED && m.threadId === threadId
      ))
      otherPort.postMessage({
        type: MESSAGE_ROUTE_UPDATE,
        url: portUrl,
        ready: true,
        threadId,
        address: port[kAddress]
      })
    }
  }
  await Promise.all(promises)
}

function createCoordinator (interceptor) {
  interceptor.close = close.bind(null, interceptor)
  interceptor.restart = restart.bind(null, interceptor)

  // New interface
  interceptor.addRoute = addRoute.bind(null, interceptor)
  interceptor.removeRoute = removeRoute.bind(null, interceptor)

  // Flow control
  interceptor.pauseWorker = pauseWorker.bind(null, interceptor)
  interceptor.resumeWorker = resumeWorker.bind(null, interceptor)

  // Old interface, should be deprecated at some point
  interceptor.route = addRoute.bind(null, interceptor)
  interceptor.unroute = removeRoute.bind(null, interceptor)

  return interceptor
}

module.exports = { createCoordinator, addRoute }
