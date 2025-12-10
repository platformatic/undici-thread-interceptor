'use strict'

const { RoundRobin } = require('./roundrobin')
const { kAddress, kReady, kDomain, kInflightOutgoing, kRoutes, kThread } = require('./utils')

function normalizeUrl (interceptor, url) {
  const domain = interceptor[kDomain]

  if (domain && !url.endsWith(domain)) {
    url += domain
  }

  // Hostname are case-insensitive
  return url.toLowerCase()
}

function onClose (interceptor, port, url) {
  const routes = interceptor[kRoutes]

  const roundRobin = routes.get(url)

  if (roundRobin) {
    roundRobin.delete(port)

    if (roundRobin.length === 0) {
      routes.delete(url)
    }
  }

  for (const cb of port[kInflightOutgoing].values()) {
    cb(new Error('The target worker thread has exited before sending a response.'))
  }

  // Notify other threads that any eventual network address for this route is no longer valid
  updateRoute(interceptor, url, port[kThread], false, null)
}

function addRoute (interceptor, url, port, onMessage) {
  const routes = interceptor[kRoutes]

  // We must copy the threadId outsise because it can be nulled by Node.js
  if (typeof port[kThread] === 'undefined') {
    port[kThread] = port.threadId
  }

  port[kInflightOutgoing] = new Map()
  url = normalizeUrl(interceptor, url)

  if (!routes.has(url)) {
    routes.set(url, new RoundRobin())
  }

  const roundRobin = routes.get(url)
  // Already in the round-robin, do nothing
  if (roundRobin.has(port)) {
    return false
  }

  roundRobin.add(port)

  const boundClose = onClose.bind(null, interceptor, port, url)
  port.on('message', onMessage.bind(null, interceptor, port, url))
  port.on('exit', boundClose)
  port.on('close', boundClose)

  return true
}

function removeRoute (interceptor, thread) {
  const routes = interceptor[kRoutes]

  const allPorts = new Set(
    Array.from(routes.values())
      .map(r => r.ports)
      .flat()
  )

  const allUrls = Array.from(routes.keys())

  // Remove all routes for the thread
  for (const url of allUrls) {
    const roundRobin = routes.get(url)
    const port = roundRobin.findByThreadId(thread)

    if (!port) {
      continue
    }

    roundRobin.delete(port)
    allPorts.delete(port)

    if (roundRobin.length === 0) {
      routes.delete(url)
    }
  }

  // Return all the ports that are still alive
  return allPorts
}

function updateRoute (interceptor, url, threadId, ready, address) {
  const port = interceptor[kRoutes].get(url)?.findByThreadId(threadId)
  if (port) {
    port[kReady] = ready

    if (address) {
      port[kAddress] = address
    }
  }
}

module.exports = { normalizeUrl, addRoute, onClose, removeRoute, updateRoute }
