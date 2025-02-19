'use strict'

const { parentPort } = require('worker_threads')
const fastify = require('fastify')
const { wire } = require('../../')
const { MESSAGE_ROUTE_REMOVE } = require('../../lib/utils')

async function waitForClose (message) {
  if (message.type === MESSAGE_ROUTE_REMOVE) {
    process.exit(1)
  }
}

const app = fastify()

app.get('/ping', function (_, reply) {
  reply.send({ ok: true })
})

app.get('/*', function (_, reply) {
  reply.send({ deadlock: true })
})

wire({ server: app, port: parentPort })
parentPort.on('message', waitForClose)
