'use strict'

const { test } = require('node:test')
const { join } = require('node:path')
const { Worker, MessageChannel } = require('node:worker_threads')
const { MessagePortWritable, MessagePortReadable } = require('../lib/message-port-streams')
const { once } = require('node:events')
const { Readable } = require('node:stream')
const { setTimeout: sleep } = require('node:timers/promises')

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

test('producer error', async (t) => {
  const channel = new MessageChannel()
  const readable = new MessagePortReadable({
    port: channel.port1
  })

  const worker = new Worker(join(__dirname, 'fixtures', 'streams', 'producer-error.js'), {
    workerData: { port: channel.port2 },
    transferList: [channel.port2]
  })

  let closeEmitted = false
  readable.on('close', () => {
    closeEmitted = true
  })

  const exited = once(worker, 'exit')

  const [err] = await once(readable, 'error')
  t.assert.equal(err.message, 'kaboom')
  t.assert.equal(closeEmitted, true)

  await exited
})

test('consumer error', async (t) => {
  const channel = new MessageChannel()

  const worker = new Worker(join(__dirname, 'fixtures', 'streams', 'consumer-error.js'), {
    workerData: { port: channel.port1 },
    transferList: [channel.port1]
  })
  const writable = new MessagePortWritable({ port: channel.port2, worker })

  let closeEmitted = false
  writable.on('close', () => {
    closeEmitted = true
  })

  const exited = once(worker, 'exit')

  const [err] = await once(writable, 'error')
  t.assert.equal(err.message, 'kaboom')
  t.assert.equal(closeEmitted, true)

  await exited
})

test('readable crash', async (t) => {
  const channel = new MessageChannel()

  const worker = new Worker(join(__dirname, 'fixtures', 'streams', 'crash.js'), {
    workerData: { port: channel.port2 },
    transferList: [channel.port2]
  })

  const readable = new MessagePortReadable({
    port: channel.port1
  })

  const exited = once(worker, 'exit').catch((err) => {
    t.assert.strictEqual(err.message, 'kaboom')
  })

  const err = await once(readable, 'error')
  t.assert.strictEqual(err[0].message, 'message port closed')

  await exited
})

test('writable crash', async (t) => {
  const channel = new MessageChannel()

  const worker = new Worker(join(__dirname, 'fixtures', 'streams', 'crash.js'), {
    workerData: { port: channel.port2 },
    transferList: [channel.port2]
  })

  const writable = new MessagePortWritable({
    port: channel.port1
  })

  const exited = once(worker, 'exit').catch((err) => {
    t.assert.strictEqual(err.message, 'kaboom')
  })

  const err = await once(writable, 'error')
  t.assert.strictEqual(err[0].message, 'message port closed')

  await exited
})

test('MessagePortWritable.asTransferable(stream, worker)', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'streams', 'consumer-transferable.js'))

  const body = new Readable({
    read () {
      this.push('Hello, World!')
      this.push(null)
    }
  })

  const { port, transferList } = MessagePortWritable.asTransferable({
    body,
    worker
  })

  worker.postMessage({ port }, transferList)

  const [{ chunks }] = await once(worker, 'message')
  t.assert.deepEqual(chunks, [Buffer.from('Hello, World!')])

  await once(worker, 'exit')
})

test('delayed read', async (t) => {
  const channel = new MessageChannel()
  const readable = new MessagePortReadable({
    port: channel.port1
  })

  const worker = new Worker(join(__dirname, 'fixtures', 'streams', 'producer.js'), {
    workerData: { port: channel.port2 },
    transferList: [channel.port2]
  })

  const exited = once(worker, 'exit')

  // We must wait a bit to ensure that the producer has sent the data
  // as there is a race condition between the producer sending the data
  await sleep(1000)

  for await (const chunk of readable) {
    t.assert.equal(chunk.toString(), 'Hello, World!')
  }

  await exited
})
