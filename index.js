'use strict'

const { createCoordinator } = require('./lib/coordinator')
const { createInterceptor } = require('./lib/interceptor')
const { createWire } = require('./lib/wire')
const { LoadSheddingError } = require('./lib/utils')

function createThreadInterceptor (opts) {
  const interceptor = createInterceptor(opts)
  return createCoordinator(interceptor)
}

function wire ({ server, port, ...opts }) {
  const interceptor = createInterceptor(opts)
  return createWire(interceptor, server, port)
}

module.exports = { createThreadInterceptor, wire, LoadSheddingError }
