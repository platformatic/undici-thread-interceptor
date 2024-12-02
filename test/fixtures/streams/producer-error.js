'use strict'

const { workerData } = require('node:worker_threads')
const { MessagePortWritable } = require('../../../lib/message-port-streams')

const writable = new MessagePortWritable({
  port: workerData.port
})

writable.destroy(new Error('kaboom'))
writable.on('error', () => {})
