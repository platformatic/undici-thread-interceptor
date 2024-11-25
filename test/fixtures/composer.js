'use strict'

const { parentPort } = require('worker_threads')
const fastify = require('fastify')
const { wire } = require('../../')
const { request } = require('undici')

const app = fastify()

wire({ server: app, port: parentPort, domain: '.local' })

app.get('/s1/example', async (req, reply) => {
  const { body } = await request('http://myserver.local/example')
  return await body.json()
})

app.get('/s2/example', async (req, reply) => {
  const { body } = await request('http://myserver2.local/example')
  return await body.json()
})

app.get('/s1/crash', async (req, reply) => {
  const { body } = await request('http://myserver.local/crash')
  return await body.json()
})

app.get('/s2/crash', async (req, reply) => {
  const { body } = await request('http://myserver2.local/crash')
  return await body.json()
})
