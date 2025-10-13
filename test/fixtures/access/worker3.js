'use strict'

const fastify = require('fastify')
const { wire } = require('../../../index.js')
const { parentPort } = require('worker_threads')
const { request } = require('undici')

const app = fastify()

app.get('/w1', async () => {
  const { body } = await request('http://worker-1.local/w1')
  return await body.json()
})

app.get('/w2', async () => {
  const { body } = await request('http://worker-2.local/w2')
  return await body.json()
})

app.get('/w3', (_, reply) => {
  reply.send({ from: 'worker-3' })
})

wire({ server: app, port: parentPort, domain: '.local' })
