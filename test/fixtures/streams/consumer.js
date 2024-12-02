'use strict'

const { workerData, parentPort } = require('node:worker_threads')
const { MessagePortReadable } = require('../../../lib/message-port-streams')

const readable = new MessagePortReadable({
  port: workerData.port
})

const chunks = []
readable.on('data', (chunk) => {
  chunks.push(chunk)
})

readable.on('end', () => {
  parentPort.postMessage({ chunks })
})
