'use strict'

const { parentPort, threadId } = require('worker_threads')
const fastify = require('fastify')
const { wire } = require('../../')

const app = fastify()

app.get('/', (req, reply) => {
  reply.send({ workerId: threadId })
})

app.get('/whoami', (req, reply) => {
  reply.send({ threadId })
})

const { setAccepting } = wire({ server: app, port: parentPort, domain: '.local' })

// Report that setAccepting is available
parentPort.postMessage({ hasSetAccepting: typeof setAccepting === 'function' })

// Handle control messages
parentPort.on('message', async (msg) => {
  if (msg.type === 'setAccepting') {
    await setAccepting(msg.value)
    parentPort.postMessage({ type: 'setAccepting', done: true })
  }
})
