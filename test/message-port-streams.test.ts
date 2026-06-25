import { deepStrictEqual, strictEqual } from 'node:assert'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { MessageChannel, Worker } from 'node:worker_threads'

import { MessagePortReadable, MessagePortWritable } from '../src/message-port-streams.ts'
import { workerURL } from './helper.ts'

test('v2 MessagePortWritable writes to MessagePortReadable', async () => {
  const channel = new MessageChannel()
  const readable = new MessagePortReadable({ port: channel.port1 })
  const writable = new MessagePortWritable({ port: channel.port2 })
  const chunks: Buffer[] = []

  readable.on('data', chunk => chunks.push(Buffer.from(chunk)))
  writable.write('Hello, ')
  writable.end('World!')
  await once(readable, 'end')

  deepStrictEqual(Buffer.concat(chunks), Buffer.from('Hello, World!'))
})

test('v2 MessagePortReadable reports producer errors', async () => {
  const channel = new MessageChannel()
  const readable = new MessagePortReadable({ port: channel.port1 })
  channel.port2.postMessage({ err: new Error('kaboom') })

  const [error] = await once(readable, 'error')

  strictEqual(error.message, 'kaboom')
})

test('v2 MessagePortWritable reports consumer errors', async () => {
  const channel = new MessageChannel()
  const writable = new MessagePortWritable({ port: channel.port1 })
  channel.port2.postMessage({ err: new Error('kaboom') })

  const [error] = await once(writable, 'error')

  strictEqual(error.message, 'kaboom')
})

test('v2 MessagePortReadable closes after producer errors', async () => {
  const channel = new MessageChannel()
  const readable = new MessagePortReadable({ port: channel.port1 })
  const closed = new Promise<void>(resolve => readable.on('close', resolve))
  channel.port2.postMessage({ err: new Error('kaboom') })

  const [error] = await once(readable, 'error')
  await closed

  strictEqual(error.message, 'kaboom')
})

test('v2 MessagePortWritable closes after consumer errors', async () => {
  const channel = new MessageChannel()
  const writable = new MessagePortWritable({ port: channel.port1 })
  const closed = new Promise<void>(resolve => writable.on('close', resolve))
  channel.port2.postMessage({ err: new Error('kaboom') })

  const [error] = await once(writable, 'error')
  await closed

  strictEqual(error.message, 'kaboom')
})

test('v2 MessagePortWritable batches corked writes', async () => {
  const channel = new MessageChannel()
  const readable = new MessagePortReadable({ port: channel.port1 })
  const writable = new MessagePortWritable({ port: channel.port2 })
  const chunks: Buffer[] = []

  readable.on('data', chunk => chunks.push(Buffer.from(chunk)))
  writable.cork()
  writable.write('Hello, ')
  writable.write('batched ')
  writable.end('World!')
  writable.uncork()
  await once(readable, 'end')

  deepStrictEqual(Buffer.concat(chunks), Buffer.from('Hello, batched World!'))
})

test('v2 MessagePortReadable receives data written before reading starts', async () => {
  const channel = new MessageChannel()
  const readable = new MessagePortReadable({ port: channel.port1 })
  const writable = new MessagePortWritable({ port: channel.port2 })
  const chunks: Buffer[] = []

  writable.end('Hello, delayed World!')
  await sleep(50)
  readable.on('data', chunk => chunks.push(Buffer.from(chunk)))
  await once(readable, 'end')

  deepStrictEqual(Buffer.concat(chunks), Buffer.from('Hello, delayed World!'))
})

test('v2 MessagePortReadable reports remote port closure', async () => {
  const channel = new MessageChannel()
  const readable = new MessagePortReadable({ port: channel.port1 })
  const worker = new Worker(new URL('data:text/javascript,throw new Error("kaboom")'), {
    workerData: { port: channel.port2 },
    transferList: [channel.port2]
  })
  const workerError = once(worker, 'error')

  const [error] = await once(readable, 'error')
  await workerError

  strictEqual(error.message, 'message port closed')
})

test('v2 MessagePortWritable reports remote port closure', async () => {
  const channel = new MessageChannel()
  const writable = new MessagePortWritable({ port: channel.port1 })
  const worker = new Worker(new URL('data:text/javascript,throw new Error("kaboom")'), {
    workerData: { port: channel.port2 },
    transferList: [channel.port2]
  })
  const workerError = once(worker, 'error')

  const [error] = await once(writable, 'error')
  await workerError

  strictEqual(error.message, 'message port closed')
})

test('v2 MessagePortWritable.asTransferable streams body data', async () => {
  const { port } = MessagePortWritable.asTransferable(Readable.from(['Hello, World!']))
  const readable = new MessagePortReadable({ port })
  const chunks: Buffer[] = []

  readable.on('data', chunk => chunks.push(Buffer.from(chunk)))
  await once(readable, 'end')

  deepStrictEqual(Buffer.concat(chunks), Buffer.from('Hello, World!'))
})

test('v2 MessagePortWritable.asTransferable streams body data to a worker', async () => {
  const worker = new Worker(workerURL('stream-consumer.ts'))
  const { port, transferList } = MessagePortWritable.asTransferable(Readable.from(['Hello, Worker!']))

  worker.postMessage({ port }, transferList)
  const [{ chunks }] = (await once(worker, 'message')) as Array<{ chunks: Buffer[] }>
  await worker.terminate()

  deepStrictEqual(chunks.map(chunk => Buffer.from(chunk)), [Buffer.from('Hello, Worker!')])
})
