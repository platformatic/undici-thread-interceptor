'use strict'

const { test } = require('node:test')
const { join } = require('node:path')
const { Worker, MessageChannel } = require('node:worker_threads')
const { MessagePortWritable, MessagePortReadable  } = require('../lib/message-port-streams')
const { once } = require('node:events')

test('producer to consumer', async (t) => {
  const channel = new MessageChannel()
  const readable = new MessagePortReadable({
    port: channel.port1
  })

  const worker = new Worker(join(__dirname, 'fixtures', 'streams', 'producer.js'), {
    workerData: { port: channel.port2 },
    transferList: [channel.port2]
  })

  const exited = once(worker, 'exit')

  for await (const chunk of readable) {
    t.assert.equal(chunk.toString(), 'Hello, World!')
  }

  await exited
})

test('consumer to producer', async (t) => {
  const channel = new MessageChannel()

  const worker = new Worker(join(__dirname, 'fixtures', 'streams', 'consumer.js'), {
    workerData: { port: channel.port1 },
    transferList: [channel.port1]
  })
  const writable = new MessagePortWritable({ port: channel.port2, worker })

  writable.write('Hello, World!')
  writable.end()

  const [{ chunks }] = await once(worker, 'message')
  t.assert.deepEqual(chunks, [Buffer.from('Hello, World!')])

  await once(worker, 'exit')
})

test('writev', async (t) => {
  const channel = new MessageChannel()

  const worker = new Worker(join(__dirname, 'fixtures', 'streams', 'producer-writev.js'), {
    workerData: { port: channel.port2 },
    transferList: [channel.port2]
  })

  const readable = new MessagePortReadable({
    port: channel.port1
  })

  const expected = [
    'Hello, A!Hello, B!Hello, C!',
    'Hello, D!Hello, E!Hello, F!Hello, G!'
  ]

  const exited = once(worker, 'exit')

  for await (const chunk of readable) {
    t.assert.equal(chunk.toString(), expected.shift())
  }

  await exited
})