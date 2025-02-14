'use strict'

const { MessageChannel } = require('node:worker_threads')

const { addRoute: commonAddRoute, removeRoute, setAddress: commonSetAddress } = require('./common')
const {
  debug,
  kAddress,
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
      notifyPortRemoval(port, removeRoute(interceptor, message.threadId), message.threadId)
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
  if (!Array.isArray(ports)) {
    ports = [ports]
  }

  const routes = interceptor[kRoutes]
  for (const port of ports) {
    commonAddRoute(interceptor, url, port, onCoordinatorMessage)

    for (const [key, roundRobin] of routes) {
      for (const other of roundRobin) {
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
}

async function close (interceptor) {
  for (const [, roundRobin] of interceptor[kRoutes]) {
    for (const otherPort of roundRobin) {
      otherPort.postMessage({ type: MESSAGE_CLOSE })
      await waitMessage(otherPort, message => message.type === MESSAGE_CLOSE)
    }
  }
}

function createCoordinator (interceptor) {
  interceptor.route = addRoute.bind(null, interceptor)
  interceptor.close = close.bind(null, interceptor)

  return interceptor
}

module.exports = { createCoordinator, addRoute }
