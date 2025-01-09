'use strict'

const { parentPort } = require('node:worker_threads')
const { MessagePortReadable } = require('../../../lib/message-port-streams')

parentPort.once('message', ({ port }) => {
  const readable = new MessagePortReadable({
    port
  })

  const chunks = []
  readable.on('data', (chunk) => {
    chunks.push(chunk)
  })

  readable.on('end', () => {
    parentPort.postMessage({ chunks })
  })
})
