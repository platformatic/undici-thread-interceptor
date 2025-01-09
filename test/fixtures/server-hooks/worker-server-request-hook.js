'use strict'

const { parentPort, workerData } = require('worker_threads')
const fastify = require('fastify')
const { wire } = require('../../..')

const app = fastify()

app.get('/', (_req, reply) => {
  reply.send({ hello: workerData?.message || 'world' })
})
wire({
  server: app,
  port: parentPort,
  onServerRequest: (req, cb) => {
    console.log('onServerRequest called', JSON.stringify(req))
    cb()
  }
})
