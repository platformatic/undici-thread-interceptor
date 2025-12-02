'use strict'

const { test } = require('node:test')
const { strictEqual, deepStrictEqual, rejects } = require('node:assert')
const { join } = require('node:path')
const { Worker } = require('node:worker_threads')
const { createThreadInterceptor, LoadSheddingError } = require('../')
const { Agent, request } = require('undici')

test('load shedding - canAccept returns false should reject with LoadSheddingError', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
    canAccept: () => false
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  await rejects(
    request('http://myserver.local', { dispatcher: agent }),
    (err) => {
      strictEqual(err.name, 'LoadSheddingError')
      strictEqual(err.code, 'UND_ERR_LOAD_SHEDDING')
      strictEqual(err.statusCode, 503)
      return true
    }
  )
})

test('load shedding - canAccept returns true should allow request', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
    canAccept: () => true
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local', {
    dispatcher: agent
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'world' })
})

test('load shedding - canAccept receives correct context', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  let receivedContext = null

  const interceptor = createThreadInterceptor({
    domain: '.local',
    canAccept: (ctx) => {
      receivedContext = ctx
      return true
    }
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  await request('http://myserver.local/test-path', {
    dispatcher: agent,
    method: 'POST',
    headers: { 'x-custom': 'value' }
  })

  strictEqual(receivedContext.hostname, 'myserver.local')
  strictEqual(receivedContext.method, 'POST')
  strictEqual(receivedContext.path, '/test-path')
  strictEqual(receivedContext.headers['x-custom'], 'value')
  strictEqual(typeof receivedContext.port, 'object') // MessagePort
})

test('load shedding - multiple workers, tries all before shedding', async (t) => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  const worker2 = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker1.terminate())
  t.after(() => worker2.terminate())

  const checkedPorts = []

  const interceptor = createThreadInterceptor({
    domain: '.local',
    canAccept: (ctx) => {
      checkedPorts.push(ctx.port)
      return false // All reject
    }
  })
  interceptor.route('myserver', worker1)
  interceptor.route('myserver', worker2)

  const agent = new Agent().compose(interceptor)

  await rejects(
    request('http://myserver.local', { dispatcher: agent }),
    (err) => err.name === 'LoadSheddingError'
  )

  // Should have checked both workers
  strictEqual(checkedPorts.length, 2)
})

test('load shedding - routes to first accepting worker', async (t) => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  const worker2 = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker1.terminate())
  t.after(() => worker2.terminate())

  let acceptingPort = null
  const checkedPorts = []

  const interceptor = createThreadInterceptor({
    domain: '.local',
    canAccept: (ctx) => {
      checkedPorts.push(ctx.port)
      // Only second worker accepts
      if (checkedPorts.length === 2) {
        acceptingPort = ctx.port
        return true
      }
      return false
    }
  })
  interceptor.route('myserver', worker1)
  interceptor.route('myserver', worker2)

  const agent = new Agent().compose(interceptor)

  const { statusCode } = await request('http://myserver.local', {
    dispatcher: agent
  })

  strictEqual(statusCode, 200)
  strictEqual(checkedPorts.length, 2)
  strictEqual(acceptingPort, checkedPorts[1])
})

test('load shedding - no canAccept hook uses normal round-robin', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
    // No canAccept hook
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local', {
    dispatcher: agent
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'world' })
})

test('load shedding - should throw if canAccept is async', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  try {
    createThreadInterceptor({
      domain: '.local',
      canAccept: async () => true
    })
    throw new Error('should not be here')
  } catch (err) {
    strictEqual(err.message, 'Async hooks are not supported')
  }
})

test('load shedding - LoadSheddingError is exported', async (t) => {
  strictEqual(typeof LoadSheddingError, 'function')
  const err = new LoadSheddingError()
  strictEqual(err.name, 'LoadSheddingError')
  strictEqual(err.code, 'UND_ERR_LOAD_SHEDDING')
  strictEqual(err.statusCode, 503)
  strictEqual(err.message, 'Service Unavailable - Load Shedding')

  const customErr = new LoadSheddingError('Custom message')
  strictEqual(customErr.message, 'Custom message')
})

test('load shedding - conditional acceptance based on context', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
    canAccept: (ctx) => {
      // Only accept GET requests
      return ctx.method === 'GET'
    }
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  // GET should work
  const { statusCode } = await request('http://myserver.local', {
    dispatcher: agent,
    method: 'GET'
  })
  strictEqual(statusCode, 200)

  // POST should be shed
  await rejects(
    request('http://myserver.local/echo-body', {
      dispatcher: agent,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    }),
    (err) => err.name === 'LoadSheddingError'
  )
})

test('load shedding - route with metadata', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  let receivedMeta = null

  const interceptor = createThreadInterceptor({
    domain: '.local',
    canAccept: (ctx) => {
      receivedMeta = ctx.meta
      return true
    }
  })
  interceptor.route('myserver', worker, { id: 'worker-1', maxLoad: 100 })

  const agent = new Agent().compose(interceptor)

  await request('http://myserver.local', { dispatcher: agent })

  deepStrictEqual(receivedMeta, { id: 'worker-1', maxLoad: 100 })
})

test('load shedding - metadata per worker for load decisions', async (t) => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  const worker2 = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker1.terminate())
  t.after(() => worker2.terminate())

  const workerLoad = new Map()
  workerLoad.set('worker-1', 15) // Over limit
  workerLoad.set('worker-2', 5)  // Under limit

  let acceptedWorker = null

  const interceptor = createThreadInterceptor({
    domain: '.local',
    canAccept: (ctx) => {
      const load = workerLoad.get(ctx.meta.id) ?? 0
      const canAccept = load < ctx.meta.maxLoad
      if (canAccept) {
        acceptedWorker = ctx.meta.id
      }
      return canAccept
    }
  })
  interceptor.route('myserver', worker1, { id: 'worker-1', maxLoad: 10 })
  interceptor.route('myserver', worker2, { id: 'worker-2', maxLoad: 10 })

  const agent = new Agent().compose(interceptor)

  const { statusCode } = await request('http://myserver.local', {
    dispatcher: agent
  })

  strictEqual(statusCode, 200)
  strictEqual(acceptedWorker, 'worker-2')
})

test('load shedding - meta is undefined when not provided', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  let receivedMeta = 'not-set'

  const interceptor = createThreadInterceptor({
    domain: '.local',
    canAccept: (ctx) => {
      receivedMeta = ctx.meta
      return true
    }
  })
  interceptor.route('myserver', worker) // No metadata

  const agent = new Agent().compose(interceptor)

  await request('http://myserver.local', { dispatcher: agent })

  strictEqual(receivedMeta, undefined)
})
