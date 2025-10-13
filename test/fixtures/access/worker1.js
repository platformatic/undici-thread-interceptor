'use strict'

const fastify = require('fastify')
const { wire } = require('../../../index.js')
const { parentPort } = require('worker_threads')
const { request } = require('undici')

const app = fastify()

app.get('/w1', (_, reply) => {
  reply.send({ from: 'worker-1' })
})

app.get('/w2', async () => {
  const { body } = await request('http://worker-2.local/w2')
  return await body.json()
})

app.get('/w3', async () => {
  const { body } = await request('http://worker-3.local/w3')
  return await body.json()
})

wire({ server: app, port: parentPort, domain: '.local' })
