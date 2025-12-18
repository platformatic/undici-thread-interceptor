'use strict'

const { parentPort } = require('worker_threads')
const fastify = require('fastify')
const { wire } = require('../../')

const app = fastify()

// Simulates distributed tracing behavior:
// - Receives x-trace-id header from client
// - Creates a new span-id for the server
// - Returns both the original trace-id and the new server span-id
app.get('/', (req, reply) => {
  const clientTraceId = req.headers['x-trace-id'] || 'no-trace'
  const clientSpanId = req.headers['x-span-id'] || 'no-span'

  // Server creates its own span-id (simulating what a tracing library would do)
  const serverSpanId = 'server-span-' + Date.now()

  reply
    .header('x-trace-id', clientTraceId) // Echo back the trace-id (should be shared)
    .header('x-server-span-id', serverSpanId) // Server's own span
    .header('x-parent-span-id', clientSpanId) // Client's span becomes parent
    .send({
      receivedTraceId: clientTraceId,
      receivedSpanId: clientSpanId,
      serverSpanId
    })
})

const { replaceServer } = wire({ port: parentPort })
app.listen({ port: 0 }).then(replaceServer)
