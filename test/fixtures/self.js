'use strict'

const { parentPort } = require('worker_threads')
const fastify = require('fastify')
const { wire } = require('../../')
const { request } = require('undici')

const app = fastify()

wire({ server: app, port: parentPort, domain: '.local' })

app.get('/ping', async function () {
  return { pong: true }
})

app.get('/self', async function () {
  const { statusCode, body } = await request('http://myself.local/ping')
  return { statusCode, response: await body.json() }
})
