'use strict'

const { parentPort } = require('worker_threads')
const { setTimeout: sleep } = require('node:timers/promises')
const fastify = require('fastify')
const { wire } = require('../../')

const app = fastify()

app.get('*', async () => {
  await sleep(10000)
  return { hello: 'world' }
})

wire({ port: parentPort, domain: '.local', server: app })
