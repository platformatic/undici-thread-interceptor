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
  onServerRequest: [
    (req, cb) => {
      console.log('First hook called')
      req.firstHook = true
      cb()
    },
    (req, cb) => {
      console.log('Second hook called')
      req.secondHook = true
      cb()
    },
    (req, cb) => {
      console.log('Third hook called')
      req.thirdHook = true
      cb()
    }
  ]
})
