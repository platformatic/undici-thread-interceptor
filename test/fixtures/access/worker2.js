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

app.get('/w2', (_, reply) => {
  reply.send({ from: 'worker-2' })
})

app.get('/w3', async () => {
  const { body } = await request('http://worker-3.local/w3')
  return await body.json()
})

wire({ server: app, port: parentPort, domain: '.local' })
