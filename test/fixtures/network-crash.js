'use strict'

const { parentPort } = require('worker_threads')
const fastify = require('fastify')
const { wire } = require('../../')

const app = fastify()

app.get('/example', async (request, reply) => {
  return { hello: 'world' }
})

app.get('/crash', async (request, reply) => {
  process.exit(1)
})

// TODO(mcollina): there is a race condition here
const { replaceServer } = wire({ port: parentPort })
app.listen({ port: 0 }).then((url) => {
  replaceServer(url)
})
