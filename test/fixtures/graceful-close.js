'use strict'

const { parentPort } = require('worker_threads')
const fastify = require('fastify')
const { wire } = require('../../')

async function waitForClose (message) {
  if (message === 'close') {
    await interceptor.close()
    process.exit(1)
  }
}

const app = fastify()

app.get('/ping', function (_, reply) {
  reply.send({ ok: true })
})

app.get('/*', function (_, reply) {
  setTimeout(function () {
    reply.send({ delayed: true })
  }, 1000)
})

const { interceptor } = wire({ server: app, port: parentPort })

parentPort.on('message', waitForClose)
