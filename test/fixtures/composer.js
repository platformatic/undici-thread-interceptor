'use strict'

const { parentPort, workerData } = require('worker_threads')
const fastify = require('fastify')
const { wire } = require('../../')
const { request } = require('undici')

const app = fastify()

wire({ server: app, port: parentPort, domain: '.local' })

app.get('/s1/ping', async function () {
  const { body } = await request('http://myserver.local/ping')
  return await body.json()
})

app.get('/s1/example', async function () {
  const { body } = await request('http://myserver.local/example')
  return await body.json()
})

app.get('/s2/example', async function () {
  const { body } = await request('http://myserver2.local/example')
  return await body.json()
})

app.get('/s1/crash', async function () {
  const { body } = await request('http://myserver.local/crash')
  return await body.json()
})

app.get('/s2/crash', async function () {
  const { body } = await request('http://myserver2.local/crash')
  return await body.json()
})

if (workerData?.network) {
  app.listen({ port: 0 }, err => {
    if (err) {
      throw err
    }

    parentPort.postMessage({ type: 'port', port: app.server.address().port })
  })
}
