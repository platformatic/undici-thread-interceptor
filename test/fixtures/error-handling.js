'use strict'

const { parentPort } = require('worker_threads')
const { wire } = require('../../')
const fastify = require('fastify')

const app = fastify()
wire({ server: app, port: parentPort, domain: '.local' })

setTimeout(() => {
  parentPort.removeAllListeners('message')
}, 10)
