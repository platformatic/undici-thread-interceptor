'use strict'

const { parentPort, threadId } = require('worker_threads')
const fastify = require('fastify')
const { wire } = require('../../')
const { request } = require('undici')

const app = fastify()

app.get('/', (req, reply) => {
  reply.send({ workerId: threadId })
})

wire({ server: app, port: parentPort, domain: '.local' })

// Handle control messages to make requests to other workers
parentPort.on('message', async (msg) => {
  if (msg.type === 'request') {
    try {
      const res = await request(msg.url)
      const body = await res.body.json()
      parentPort.postMessage({ statusCode: res.statusCode, body })
    } catch (err) {
      parentPort.postMessage({ error: true, message: err.message })
    }
  }
})
