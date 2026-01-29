'use strict'

const { test } = require('node:test')
const { join } = require('node:path')
const { once } = require('node:events')
const { Readable } = require('node:stream')
const { readFile } = require('node:fs/promises')
const { deepStrictEqual, strictEqual, rejects, ifError, ok } = require('node:assert')
const { Worker } = require('node:worker_threads')
const { setTimeout: sleep } = require('node:timers/promises')
const { Agent, request } = require('undici')
const Fastify = require('fastify')
const { requestWithTimeout } = require('./helper')
const { createThreadInterceptor } = require('../')

test('basic', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local', {
    dispatcher: agent
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'world' })
})

test('two service in a mesh', async (t) => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'worker1.js'), {
    workerData: { message: 'mesh' }
  })
  t.after(() => worker1.terminate())
  const worker2 = new Worker(join(__dirname, 'fixtures', 'worker2.js'))
  t.after(() => worker2.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('myserver', worker1)
  await interceptor.route('myserver2', worker2)

  const agent = new Agent().compose(interceptor)

  const { body } = await request('http://myserver2.local', {
    dispatcher: agent
  })

  deepStrictEqual(await body.json(), { hello: 'mesh' })
})

test('two service in a mesh, one is terminated with an inflight message', async (t) => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'worker1.js'), {
    workerData: { message: 'mesh' }
  })
  t.after(() => worker1.terminate())
  const worker2 = new Worker(join(__dirname, 'fixtures', 'worker2.js'))
  t.after(() => worker2.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('myserver', worker1)
  await interceptor.route('myserver2', worker2)

  const agent = new Agent().compose(interceptor)

  const promise = request('http://myserver2.local', {
    dispatcher: agent
  })

  worker1.terminate()

  const res = await promise
  strictEqual(res.statusCode, 500)
  deepStrictEqual(await res.body.json(), {
    error: 'Internal Server Error',
    message: 'The target worker thread has exited before sending a response.',
    statusCode: 500
  })
})

test('two service in a mesh, one is terminated, then a message is sent', async (t) => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'worker1.js'), {
    workerData: { message: 'mesh' }
  })
  t.after(() => worker1.terminate())
  const worker2 = new Worker(join(__dirname, 'fixtures', 'worker2.js'))
  t.after(() => worker2.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('myserver', worker1)
  await interceptor.route('myserver2', worker2)

  const agent = new Agent().compose(interceptor)

  worker1.terminate()

  await once(worker1, 'exit')
  await sleep(1000)

  const res = await request('http://myserver2.local', {
    dispatcher: agent
  })

  strictEqual(res.statusCode, 500)
  deepStrictEqual(await res.body.json(), {
    error: 'Internal Server Error',
    message: `No target found for myserver.local in thread ${worker2.threadId}.`,
    statusCode: 500
  })
})

test('buffer', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local/buffer', {
    dispatcher: agent
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(Buffer.from(await body.arrayBuffer()), Buffer.from('hello'))
})

test('no response headers', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, headers, body } = await request('http://myserver.local/no-headers', {
    dispatcher: agent
  })

  strictEqual(statusCode, 200)
  ifError(headers['content-type'])
  deepStrictEqual(await body.text(), 'text')
})

test('handle errors from inject', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'error.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  await rejects(request('http://myserver.local', {
    dispatcher: agent
  }), new Error('kaboom'))
})

test('throws an error when no server is wired', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'no-server.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  interceptor.route('myserver', worker)
  await sleep(1000)

  const agent = new Agent().compose(interceptor)

  await rejects(request('http://myserver.local', {
    dispatcher: agent
  }), new Error('No target found for myserver.local in thread 0.'))
})

test('pass through with domain', async (t) => {
  const app = Fastify()
  app.get('/', async () => {
    return { hello: 'world' }
  })
  await app.listen({ port: 0 })
  t.after(() => app.close())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request(app.listeningOrigin, {
    dispatcher: agent
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'world' })
})

test('unwanted headers are removed', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local/echo-headers', {
    headers: {
      'x-foo': 'bar',
      connection: 'keep-alive',
      'transfer-encoding': 'chunked'
    },
    dispatcher: agent
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), {
    'user-agent': 'lightMyRequest',
    host: 'myserver.local',
    'x-foo': 'bar'
  })
})

// TODO: enable this test when undici v7 adds support for multiple headers
test('multiple headers', { skip: true }, async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body, headers } = await request('http://myserver.local/headers', {
    dispatcher: agent
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(headers['x-foo'], ['bar', 'baz'])
  await body.json()
})

test('case-insensitive hostnames', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('mySERver', worker)
  await interceptor.route('MySeRvEr2', worker)

  const agent = new Agent().compose(interceptor)

  const urls = [
    'http://myserver.local',
    'http://MYSERVER.local',
    'http://MYserVER.locAL',
    'http://myserver2.local',
    'http://MYSERVER2.local',
    'http://MYserVER2.locAL'
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
    domain: '.local'
  })
  await interceptor.route('myserver', worker1)
  await interceptor.route('myserver2', worker2)

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
    domain: '.local'
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local/echo-body', {
    dispatcher: agent,
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({ hello: 'world' })
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'world' })
})

test('POST with Stream', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local/echo-body', {
    dispatcher: agent,
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: Readable.from(JSON.stringify({ hello: 'world' }))
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'world' })
})

test('POST with buffer', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local/echo-body', {
    dispatcher: agent,
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: Buffer.from(JSON.stringify({ hello: 'world' }))
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'world' })
})

test('Get binary file', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local/public/test.ttf', {
    dispatcher: agent
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
    domain: '.local'
  })
  await interceptor.route('myserver', worker)

  const abortController = new AbortController()

  const agent = new Agent().compose(interceptor)
  abortController.abort()

  await rejects(request('http://myserver.local', {
    dispatcher: agent,
    signal: abortController.signal
  }))
})

test('empty header', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'empty-headers.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('myserver', worker)

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
    domain: '.local'
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local/big', {
    dispatcher: agent
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
    domain: '.local'
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  await rejects(request('http://myserver.local/stream-error', {
    dispatcher: agent
  }))
})

test('handle an error with a stream response response without content length', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const res = await request('http://myserver.local/stream-error-2', {
    dispatcher: agent
  })

  strictEqual(res.statusCode, 200)
  await rejects(res.body.text())
})

test('empty-stream', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local/empty-stream', {
    dispatcher: agent
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.text(), '')
})

test('should not use port that does not have server', async (t) => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'timeout.js'), {
    workerData: { id: 1 }
  })
  const worker2 = new Worker(join(__dirname, 'fixtures', 'timeout.js'), {
    workerData: { id: 2 }
  })
  const worker3 = new Worker(join(__dirname, 'fixtures', 'timeout.js'), {
    workerData: { id: 3 }
  })

  t.after(() => {
    worker1.terminate()
    worker2.terminate()
    worker3.terminate()
  })

  const interceptor = createThreadInterceptor({ domain: '.local' })

  worker1.postMessage('test-wire')
  worker2.postMessage('test-wire')
  worker3.postMessage('test-wire')

  const p1 = interceptor.route('app1', worker1)
  const p2 = interceptor.route('app1', worker2)
  const p3 = interceptor.route('app2', worker3)

  worker1.postMessage('test-replace-server')
  worker3.postMessage('test-replace-server')
  await Promise.all([p1, p3])

  const agent = new Agent().compose(interceptor)

  // Request Main -> App1
  // App1 has two workers: Worker1 and Worker2
  // Worker1 has server
  // Worker2 doesn't have server
  for (let i = 0; i < 4; i++) {
    const { statusCode, body } = await requestWithTimeout(
      'http://app1.local/id',
      {
        dispatcher: agent,
        timeout: 1000
      }
    )

    strictEqual(statusCode, 200)

    const { id } = await body.json()
    strictEqual(id, 1)
  }

  // Request Main -> App2 -> App1
  // App1 has two workers: Worker1 and Worker2
  // Worker1 has server
  // Worker2 doesn't have server
  for (let i = 0; i < 4; i++) {
    const { statusCode, body } = await requestWithTimeout(
      'http://app2.local/request',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'http://app1.local/id' }),
        dispatcher: agent,
        timeout: 1000
      }
    )

    strictEqual(statusCode, 200)

    const { data } = await body.json()
    const { id } = JSON.parse(data)
    strictEqual(id, 1)
  }

  // Set server for Worker2
  worker2.postMessage('test-replace-server')
  await p2
  await sleep(1000)

  // Request Main -> App1
  // App1 has two workers: Worker1 and Worker2
  // Worker1 has server
  // Worker2 has server
  let expected = null
  for (let i = 0; i < 4; i++) {
    const { statusCode, body } = await requestWithTimeout(
      'http://app1.local/id',
      {
        dispatcher: agent,
        timeout: 1000
      }
    )

    strictEqual(statusCode, 200)

    const { id } = await body.json()
    if (i === 0) {
      expected = id
      continue
    }

    expected = expected === 1 ? 2 : 1
    strictEqual(id, expected)
  }

  // Request Main -> App2 -> App1
  // App1 has two workers: Worker1 and Worker2
  // Worker1 has server
  // Worker2 has server
  for (let i = 0; i < 7; i++) {
    const { statusCode, body } = await requestWithTimeout(
      'http://app2.local/request',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'http://app1.local/id' }),
        dispatcher: agent,
        timeout: 1000
      }
    )

    strictEqual(statusCode, 200)

    const { data } = await body.json()
    const { id } = JSON.parse(data)
    if (i === 0) {
      expected = id
      continue
    }
    expected = expected === 1 ? 2 : 1
    strictEqual(id, expected)
  }
})

test('should not use port that does not have server', async (t) => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'timeout.js'), {
    workerData: { id: 1 }
  })
  const worker2 = new Worker(join(__dirname, 'fixtures', 'timeout.js'), {
    workerData: { id: 2 }
  })
  const worker3 = new Worker(join(__dirname, 'fixtures', 'timeout.js'), {
    workerData: { id: 3 }
  })

  t.after(() => {
    worker1.terminate()
    worker2.terminate()
    worker3.terminate()
  })

  const interceptor = createThreadInterceptor({ domain: '.local' })

  worker1.postMessage('test-wire')
  worker2.postMessage('test-wire')
  worker3.postMessage('test-wire')

  worker1.postMessage('test-replace-server')
  worker3.postMessage('test-replace-server')

  const p1 = interceptor.route('app1', worker1)
  const p2 = interceptor.route('app1', worker2)
  const p3 = interceptor.route('app2', worker3)
  await Promise.all([p1, p3])

  const agent = new Agent().compose(interceptor)

  // Request Main -> App1
  // App1 has two workers: Worker1 and Worker2
  // Worker1 has server
  // Worker2 doesn't have server
  for (let i = 0; i < 2; i++) {
    const { statusCode, body } = await requestWithTimeout(
      'http://app1.local/id',
      {
        dispatcher: agent,
        timeout: 1000
      }
    )

    strictEqual(statusCode, 200)

    const { id } = await body.json()
    strictEqual(id, 1)
  }

  // Request Main -> App2 -> App1
  // App1 has two workers: Worker1 and Worker2
  // Worker1 has server
  // Worker2 doesn't have server
  for (let i = 0; i < 2; i++) {
    const { statusCode, body } = await requestWithTimeout(
      'http://app2.local/request',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'http://app1.local/id' }),
        dispatcher: agent,
        timeout: 1000
      }
    )

    strictEqual(statusCode, 200)

    const { data } = await body.json()
    const { id } = JSON.parse(data)
    strictEqual(id, 1)
  }

  // Set server for Worker2
  worker2.postMessage('test-replace-server')
  await p2

  // Request Main -> App1
  // App1 has two workers: Worker1 and Worker2
  // Worker1 has server
  // Worker2 has server
  let expected = null
  for (let i = 0; i < 4; i++) {
    const { statusCode, body } = await requestWithTimeout(
      'http://app1.local/id',
      {
        dispatcher: agent,
        timeout: 1000
      }
    )

    strictEqual(statusCode, 200)

    const { id } = await body.json()
    if (i === 0) {
      expected = id
      continue
    }
    expected = expected === 1 ? 2 : 1
    strictEqual(id, expected)
  }

  // Request Main -> App2 -> App1
  // App1 has two workers: Worker1 and Worker2
  // Worker1 has server
  // Worker2 has server
  for (let i = 0; i < 4; i++) {
    const { statusCode, body } = await requestWithTimeout(
      'http://app2.local/request',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'http://app1.local/id' }),
        dispatcher: agent,
        timeout: 1000
      }
    )

    strictEqual(statusCode, 200)

    const { data } = await body.json()
    const { id } = JSON.parse(data)
    if (i === 0) {
      expected = id
      continue
    }
    expected = expected === 1 ? 2 : 1
    strictEqual(id, expected)
  }
})

test('mesh connections should work after removing and re-adding routes', async (t) => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'timeout.js'), {
    workerData: { id: 1 }
  })
  const worker2 = new Worker(join(__dirname, 'fixtures', 'timeout.js'), {
    workerData: { id: 2 }
  })

  t.after(() => {
    worker1.terminate()
    worker2.terminate()
  })

  const interceptor = createThreadInterceptor({ domain: '.local' })

  worker1.postMessage('test-wire')
  worker2.postMessage('test-wire')
  worker1.postMessage('test-replace-server')
  worker2.postMessage('test-replace-server')

  const agent = new Agent().compose(interceptor)

  // STEP 1: Add routes and test mesh works
  await interceptor.route('app1', worker1)
  await interceptor.route('app2', worker2)

  {
    const { statusCode, body } = await requestWithTimeout(
      'http://app2.local/request',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'http://app1.local/id' }),
        dispatcher: agent,
        timeout: 1000
      }
    )
    strictEqual(statusCode, 200)
    const { data } = await body.json()
    const { id } = JSON.parse(data)
    strictEqual(id, 1)
  }

  // STEP 2: Remove route and test it fails
  await interceptor.unroute('app1', worker1)

  {
    const { statusCode, body } = await requestWithTimeout(
      'http://app2.local/request',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'http://app1.local/id' }),
        dispatcher: agent,
        timeout: 1000
      }
    )
    strictEqual(statusCode, 500, 'should get error status after route removal')

    const error = await body.json()
    strictEqual(error.statusCode, 500)
    strictEqual(error.error, 'Internal Server Error')
    ok(error.message.includes('No target found for app1.local in thread'))
  }

  // STEP 3: Re-add route and test mesh works again
  await interceptor.route('app1', worker1)

  {
    const { statusCode, body } = await requestWithTimeout(
      'http://app2.local/request',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'http://app1.local/id' }),
        dispatcher: agent,
        timeout: 1000
      }
    )
    strictEqual(statusCode, 200)
    const { data } = await body.json()
    const { id } = JSON.parse(data)
    strictEqual(id, 1)
  }
})

test('should not wire a port that has been removed', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'timeout.js'), {
    workerData: { id: 1 }
  })
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({ domain: '.local' })

  worker.postMessage('test-wire')

  const routePromise = interceptor.route('app1', worker)
  const unroutePromise = interceptor.unroute('app1', worker)

  worker.postMessage('test-replace-server')
  // Wait to be sure that replaceServer is called
  await sleep(1000)

  await routePromise
  await unroutePromise

  const agent = new Agent().compose(interceptor)

  await rejects(request('http://app1.local/id', {
    dispatcher: agent
  }), new Error('No target found for app1.local in thread 0.'))
})

test('should not wire a port that has been closed', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'timeout.js'), {
    workerData: { id: 1 }
  })
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({ domain: '.local' })

  worker.postMessage('test-wire')

  const routePromise = interceptor.route('app1', worker)
  const closePromise = interceptor.close()

  worker.postMessage('test-replace-server')
  // Wait to be sure that replaceServer is called
  await sleep(1000)

  await routePromise
  await closePromise

  const agent = new Agent().compose(interceptor)

  await rejects(request('http://app1.local/id', {
    dispatcher: agent
  }), new Error('No target found for app1.local in thread 0.'))
})

test('replaceServer throws when called with undefined', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'replace-server-validation.js'))
  t.after(() => worker.terminate())

  const messagePromise = once(worker, 'message')
  worker.postMessage('test-replace-server-undefined')
  const [message] = await messagePromise

  strictEqual(message.error, 'server argument is required')
})

test('replaceServer throws when called with no arguments', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'replace-server-validation.js'))
  t.after(() => worker.terminate())

  const messagePromise = once(worker, 'message')
  worker.postMessage('test-replace-server-no-args')
  const [message] = await messagePromise

  strictEqual(message.error, 'server argument is required')
})
