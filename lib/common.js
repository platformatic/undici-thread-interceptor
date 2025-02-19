'use strict'

const { RoundRobin } = require('./roundrobin')
const { kAddress, kDomain, kInflightOutgoing, kRoutes, kThread } = require('./utils')

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
  setAddress(interceptor, url, port[kThread], null)
}

function addRoute (interceptor, url, port, onMessage) {
  const domain = interceptor[kDomain]
  const routes = interceptor[kRoutes]

  // We must copy the threadId outsise because it can be nulled by Node.js
  if (typeof port[kThread] === 'undefined') {
    port[kThread] = port.threadId
  }

  port[kInflightOutgoing] = new Map()

  if (domain && !url.endsWith(domain)) {
    url += domain
  }

  // Hostname are case-insensitive
  url = url.toLowerCase()

  if (!routes.has(url)) {
    routes.set(url, new RoundRobin())
  }
  routes.get(url).add(port)

  const boundClose = onClose.bind(null, interceptor, port, url)
  port.on('message', onMessage.bind(null, interceptor, port, url))
  port.on('exit', boundClose)
  port.on('close', boundClose)
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

function setAddress (interceptor, url, threadId, address) {
  const port = interceptor[kRoutes].get(url)?.findByThreadId(threadId)

  if (port) {
    port[kAddress] = address
  }
}

module.exports = { addRoute, onClose, removeRoute, setAddress }
