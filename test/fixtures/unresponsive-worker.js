'use strict'

const { parentPort, workerData } = require('worker_threads')
const fastify = require('fastify')
const { wire } = require('../../')
const utils = require('../../lib/utils')

const blockMessageKey = workerData?.blockMessageType
const blockMessageType = utils[blockMessageKey]
if (!blockMessageType) {
  throw new Error(`Invalid blockMessageType: ${blockMessageKey}`)
}

const app = fastify()
app.get('/', (req, reply) => {
  reply.send({ hello: 'world' })
})

// Patch postMessage to prevent specific message responses from being sent
const originalPostMessage = parentPort.postMessage.bind(parentPort)
parentPort.postMessage = function (message, ...args) {
  if (message.type === blockMessageType) {
    // Intentionally don't send the blocked message response
    // This will cause the coordinator's waitMessage to timeout
    return
  }
  return originalPostMessage(message, ...args)
}

// Wire the server normally to set up all proper handlers
wire({ server: app, port: parentPort })
