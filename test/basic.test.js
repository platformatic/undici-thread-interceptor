'use strict'

const { test } = require('node:test')
const { Readable } = require('node:stream')
const { deepStrictEqual, strictEqual, rejects, ifError } = require('node:assert')
const { join } = require('node:path')
const { Worker } = require('node:worker_threads')
const { once } = require('node:events')
const { setTimeout: sleep } = require('node:timers/promises')
const { createThreadInterceptor } = require('../')
const { Agent, request } = require('undici')
const { readFile } = require('node:fs').promises
const Fastify = require('fastify')

test('basic', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local', {
    dispatcher: agent,
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'world' })
})

test('two service in a mesh', async (t) => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'worker1.js'), {
    workerData: { message: 'mesh' },
  })
  t.after(() => worker1.terminate())
  const worker2 = new Worker(join(__dirname, 'fixtures', 'worker2.js'))
  t.after(() => worker2.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker1)
  interceptor.route('myserver2', worker2)

  const agent = new Agent().compose(interceptor)

  const { body } = await request('http://myserver2.local', {
    dispatcher: agent,
  })

  deepStrictEqual(await body.json(), { hello: 'mesh' })
})

test('two service in a mesh, one is terminated with an inflight message', async (t) => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'worker1.js'), {
    workerData: { message: 'mesh' },
  })
  t.after(() => worker1.terminate())
  const worker2 = new Worker(join(__dirname, 'fixtures', 'worker2.js'))
  t.after(() => worker2.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker1)
  interceptor.route('myserver2', worker2)

  const agent = new Agent().compose(interceptor)

  worker1.terminate()

  const res = await request('http://myserver2.local', {
    dispatcher: agent,
  })

  strictEqual(res.statusCode, 500)
  deepStrictEqual(await res.body.json(), {
    error: 'Internal Server Error',
    message: 'Worker exited',
    statusCode: 500,
  })
})

test('two service in a mesh, one is terminated, then a message is sent', async (t) => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'worker1.js'), {
    workerData: { message: 'mesh' },
  })
  t.after(() => worker1.terminate())
  const worker2 = new Worker(join(__dirname, 'fixtures', 'worker2.js'))
  t.after(() => worker2.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker1)
  interceptor.route('myserver2', worker2)

  const agent = new Agent().compose(interceptor)

  worker1.terminate()

  await once(worker1, 'exit')
  await sleep(1000)

  const res = await request('http://myserver2.local', {
    dispatcher: agent,
  })

  strictEqual(res.statusCode, 500)
  deepStrictEqual(await res.body.json(), {
    error: 'Internal Server Error',
    message: `No server found for myserver.local in ${worker2.threadId}`,
    statusCode: 500,
  })
})

test('buffer', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local/buffer', {
    dispatcher: agent,
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(Buffer.from(await body.arrayBuffer()), Buffer.from('hello'))
})

test('no response headers', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, headers, body } = await request('http://myserver.local/no-headers', {
    dispatcher: agent,
  })

  strictEqual(statusCode, 200)
  ifError(headers['content-type'])
  deepStrictEqual(await body.text(), 'text')
})

test('handle errors from inject', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'error.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  await rejects(request('http://myserver.local', {
    dispatcher: agent,
  }), new Error('kaboom'))
})

test('throws an error when no server is wired', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'no-server.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  await rejects(request('http://myserver.local', {
    dispatcher: agent,
  }), new Error(`No server found for myserver.local in ${worker.threadId}`))
})

test('pass through with domain', async (t) => {
  const app = Fastify()
  app.get('/', async () => {
    return { hello: 'world' }
  })
  await app.listen({ port: 0 })
  t.after(() => app.close())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request(app.listeningOrigin, {
    dispatcher: agent,
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'world' })
})

test('unwanted headers are removed', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local/echo-headers', {
    headers: {
      'x-foo': 'bar',
      connection: 'keep-alive',
      'transfer-encoding': 'chunked',
    },
    dispatcher: agent,
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), {
    'user-agent': 'lightMyRequest',
    host: 'myserver.local',
    'x-foo': 'bar',
  })
})

// TODO: enable this test when undici v7 adds support for multiple headers
test('multiple headers', { skip: true }, async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body, headers } = await request('http://myserver.local/headers', {
    dispatcher: agent,
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(headers['x-foo'], ['bar', 'baz'])
  await body.json()
})

test('case-insensitive hostnames', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('mySERver', worker)
  interceptor.route('MySeRvEr2', worker)

  const agent = new Agent().compose(interceptor)

  const urls = [
    'http://myserver.local',
    'http://MYSERVER.local',
    'http://MYserVER.locAL',
    'http://myserver2.local',
    'http://MYSERVER2.local',
    'http://MYserVER2.locAL',
  ]

  for (const url of urls) {
    const { statusCode, body } = await request(url, { dispatcher: agent })

    strictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { hello: 'world' })
  }
})

test('close', async (t) => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'close.js'))
  const worker2 = new Worker(join(__dirname, 'fixtures', 'close.js'))

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker1)
  interceptor.route('myserver2', worker2)

  const agent = new Agent().compose(interceptor)

  {
    const { statusCode, body } = await request('http://myserver.local', { dispatcher: agent })

    strictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { hello: 'world' })
  }

  {
    const { statusCode, body } = await request('http://myserver2.local', { dispatcher: agent })

    strictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { hello: 'world' })
  }

  setTimeout(() => {
    worker1.postMessage('close')
    worker2.postMessage('close')
  }, 500)

  await Promise.all([once(worker1, 'exit'), once(worker2, 'exit')])
})

test('POST', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local/echo-body', {
    dispatcher: agent,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ hello: 'world' }),
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'world' })
})

test('POST with Stream', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local/echo-body', {
    dispatcher: agent,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: Readable.from(JSON.stringify({ hello: 'world' })),
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'world' })
})

test('Get binary file', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local/public/test.ttf', {
    dispatcher: agent,
  })

  strictEqual(statusCode, 200)
  const read = Buffer.from(await body.arrayBuffer())

  const expected = await readFile(join(__dirname, 'fixtures', 'public', 'test.ttf'))

  deepStrictEqual(read, expected)
})

test('aborting a request', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker)

  const abortController = new AbortController()

  const agent = new Agent().compose(interceptor)
  abortController.abort()

  await rejects(request('http://myserver.local', {
    dispatcher: agent,
    signal: abortController.signal,
  }))
})

test('empty header', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'empty-headers.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local', {
    dispatcher: agent,
    headers: { foo: undefined }
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.text(), 'hello world')
})

test('big stream using backpressure', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local/big', {
    dispatcher: agent,
  })

  strictEqual(statusCode, 200)
  let size = 0

  body.on('readable', () => {
    let chunk
    while ((chunk = body.read()) !== null) {
      size += chunk.length
    }
  })

  await once(body, 'end')
  strictEqual(size, 1024 * 1024 * 100)
})

test('handles an error within a stream response with a content length', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  await rejects(request('http://myserver.local/stream-error', {
    dispatcher: agent,
  }))
})

test('handle an error with a stream response response without content length', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const res = await request('http://myserver.local/stream-error-2', {
    dispatcher: agent,
  })

  strictEqual(res.statusCode, 200)
  await rejects(res.body.text())
})

test.only('empty-stream', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local/empty-stream', {
    dispatcher: agent,
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.text(), '')
})
