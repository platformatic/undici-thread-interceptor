'use strict'

const { MessageChannel } = require('node:worker_threads')

const {
  addRoute: commonAddRoute,
  normalizeUrl,
  removeRoute: commonRemoveRoute,
  setAddress: commonSetAddress
} = require('./common')
const {
  debug,
  kAddress,
  kClosed,
  kInflightOutgoing,
  kRoutes,
  kThread,
  MESSAGE_ADDRESS,
  MESSAGE_CLOSE,
  MESSAGE_RESPONSE,
  MESSAGE_ROUTE_ADD,
  MESSAGE_ROUTE_REMOVE,
  MESSAGE_ROUTE_REMOVED,
  waitMessage
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
    case MESSAGE_ADDRESS:
      setAddress(interceptor, url, port[kThread], message.address)
      break
    case MESSAGE_ROUTE_REMOVE:
      notifyPortRemoval(port, commonRemoveRoute(interceptor, message.threadId), message.threadId)
      break
  }
}

function notifyPortRemoval (removedPort, otherPorts, thread) {
  const promises = []

  // Notify all ports in the roundRobin that the route has been removed
  for (const otherPort of otherPorts) {
    otherPort.postMessage({ type: MESSAGE_ROUTE_REMOVE, threadId: thread })
    promises.push(waitMessage(otherPort, m => m.type === MESSAGE_ROUTE_REMOVED && m.threadId === thread))
  }

  Promise.all(promises).then(function () {
    removedPort.postMessage({ type: MESSAGE_ROUTE_REMOVED })
  })
}

function setAddress (interceptor, url, threadId, address) {
  commonSetAddress(interceptor, url, threadId, address)

  for (const [, roundRobin] of interceptor[kRoutes]) {
    for (const otherPort of roundRobin) {
      // Avoid loops, do not send the message to the source
      if (otherPort[kThread] !== threadId) {
        otherPort.postMessage({ type: MESSAGE_ADDRESS, url, address, threadId })
      }
    }
  }
}

function addRoute (interceptor, url, ports) {
  if (interceptor[kClosed]) {
    throw new Error('The dispatcher has been closed.')
  }

  if (!Array.isArray(ports)) {
    ports = [ports]
  }

  let modified = false
  const routes = interceptor[kRoutes]
  for (const port of ports) {
    if (!commonAddRoute(interceptor, url, port, onCoordinatorMessage)) {
      continue
    }

    modified = true

    for (const [key, roundRobin] of routes) {
      for (const other of roundRobin) {
        if (other === port) {
          continue
        }

        const { port1, port2 } = new MessageChannel()

        port.postMessage({ type: MESSAGE_ROUTE_ADD, url: key, port: port1, threadId: other[kThread] }, [port1])
        other.postMessage({ type: MESSAGE_ROUTE_ADD, url, port: port2, threadId: port[kThread] }, [port2])

        // If we have a real address for the other port, we need to forward it
        if (other[kAddress]) {
          port.postMessage({ type: MESSAGE_ADDRESS, url: key, address: other[kAddress], threadId: other[kThread] })
        }
      }
    }
  }

  return modified
}

function removeRoute (interceptor, url, ports, force = false) {
  url = normalizeUrl(interceptor, url)

  if (interceptor[kClosed] && !force) {
    throw new Error('The dispatcher has been closed.')
  }

  if (!Array.isArray(ports)) {
    ports = [ports]
  }

  const routes = interceptor[kRoutes]
  const roundRobin = routes.get(url)
  let modified = false

  if (roundRobin) {
    for (const port of ports) {
      if (roundRobin.delete(port)) {
        modified = true
      }
    }

    if (roundRobin.length === 0) {
      routes.delete(url)
    }
  }

  if (modified) {
    const allPorts = new Set(
      Array.from(routes.values())
        .map(r => r.ports)
        .flat()
    )

    for (const port of ports) {
      notifyPortRemoval(port, allPorts, port[kThread])
    }
  }

  return modified
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
