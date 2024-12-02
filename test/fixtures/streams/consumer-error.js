'use strict'

const { workerData, parentPort } = require('node:worker_threads')
const { MessagePortReadable } = require('../../../lib/message-port-streams')

const readable = new MessagePortReadable({
  port: workerData.port
})

readable.destroy(new Error('kaboom'))
readable.on('error', () => {})
