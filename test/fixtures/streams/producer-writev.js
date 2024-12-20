'use strict'

const { workerData } = require('node:worker_threads')
const { MessagePortWritable } = require('../../../lib/message-port-streams')

const writable = new MessagePortWritable({
  port: workerData.port
})

writable.cork()
writable.write('Hello, A!')
writable.write('Hello, B!')
writable.write('Hello, C!')
writable.uncork()
writable.write('Hello, D!')
writable.cork()
writable.write('Hello, E!')
writable.write('Hello, F!')
writable.write('Hello, G!')
writable.uncork()
writable.end()
