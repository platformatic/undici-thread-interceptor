'use strict'

const { parentPort, workerData } = require('worker_threads')
const fastify = require('fastify')
const { wire } = require('../../')
const { requestWithTimeout } = require('../helper')

const { id } = workerData

const app = fastify()

app.get('/id', () => {
  return { id }
})

app.post('/request', async (req, res) => {
  const { url, params } = req.body
  const { statusCode, body } = await requestWithTimeout(url, params, 1000)

  const data = await body.text()
  res.send({ statusCode, data })
})

let dispatcher = null

parentPort.on('message', (message) => {
  if (message === 'test-wire') {
    dispatcher = wire({ port: parentPort, domain: '.local' })
  }
  if (message === 'test-replace-server') {
    dispatcher.replaceServer(app)
  }
})
