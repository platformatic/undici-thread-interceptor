'use strict'

const { parentPort, workerData } = require('worker_threads')
const fastify = require('fastify')
const { wire } = require('../..')
const diagnosticsChannel = require('node:diagnostics_channel')

const app = fastify()

// Track events within the worker
const events = {
  start: [],
  finish: []
}

// Subscribe to diagnostics channels in the worker
const channelStart = diagnosticsChannel.channel('http.server.request.start')
const channelFinish = diagnosticsChannel.channel('http.server.response.finish')

channelStart.subscribe((event) => {
  events.start.push({
    method: event.request.method,
    url: event.request.url,
    headers: event.request.headers,
    hasServer: !!event.server
  })
})

channelFinish.subscribe((event) => {
  events.finish.push({
    method: event.request.method,
    url: event.request.url,
    statusCode: event.response?.statusCode,
    hasServer: !!event.server
  })
})

app.get('/', (_req, reply) => {
  reply.send({ hello: workerData?.message || 'world' })
})

app.get('/events', (_req, reply) => {
  reply.send(events)
})

app.get('/error', (_req, reply) => {
  throw new Error('test error')
})

wire({ server: app, port: parentPort })
