'use strict'

const { test } = require('node:test')
const { deepStrictEqual, strictEqual } = require('node:assert')
const { join } = require('node:path')
const { Worker } = require('node:worker_threads')
const { createThreadInterceptor } = require('../')
const { Agent, request } = require('undici')

test('hooks - onRequest', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())
  let hookCalled = null

  const interceptor = createThreadInterceptor({
    domain: '.local',
    onRequest: (opts) => {
      hookCalled = opts
    }
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode } = await request('http://myserver.local', {
    dispatcher: agent,
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(hookCalled, {
    headers: {
      host: 'myserver.local',
    },
    method: 'GET',
    origin: 'http://myserver.local',
    path: '/'
  })
})

test('hooks - multiple onRequests', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())
  const hookCalled = []

  const firstHook = (opts) => {
    hookCalled.push({ first: opts })
  }

  const secondHook = (opts) => {
    hookCalled.push({ second: opts })
  }

  const interceptor = createThreadInterceptor({
    domain: '.local',
    onRequest: [firstHook, secondHook]
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode } = await request('http://myserver.local', {
    dispatcher: agent,
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(hookCalled, [
    {
      first: {
        headers: {
          host: 'myserver.local',
        },
        method: 'GET',
        origin: 'http://myserver.local',
        path: '/'
      }
    }, {
      second: {
        headers: {
          host: 'myserver.local',
        },
        method: 'GET',
        origin: 'http://myserver.local',
        path: '/'
      }
    }
  ])
})

test('hooks - onResponse', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())
  let hookCalled = null

  const interceptor = createThreadInterceptor({
    domain: '.local',
    onResponse: (opts) => {
      hookCalled = Buffer.from(opts.rawPayload).toString()
    }
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)
  const { statusCode } = await request('http://myserver.local', {
    dispatcher: agent,
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(hookCalled, '{"hello":"world"}')
})

test('hooks - multiple onResponses', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())
  const hookCalled = []

  const onResponse1 = (opts) => {
    hookCalled.push({ res1: Buffer.from(opts.rawPayload).toString() })
  }

  const onResponse2 = (opts) => {
    hookCalled.push({ res2: Buffer.from(opts.rawPayload).toString() })
  }

  const interceptor = createThreadInterceptor({
    domain: '.local',
    onResponse: [onResponse1, onResponse2]
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)
  const { statusCode } = await request('http://myserver.local', {
    dispatcher: agent,
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(hookCalled, [{ res1: '{"hello":"world"}' }, { res2: '{"hello":"world"}' }])
})

test('hooks - onError', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'error.js'))
  t.after(() => worker.terminate())
  let hookCalled = null

  const interceptor = createThreadInterceptor({
    domain: '.local',
    onError: (error) => {
      hookCalled = error
    }
  })
  interceptor.route('myserver', worker)

  try {
    const agent = new Agent().compose(interceptor)
    await request('http://myserver.local', {
      dispatcher: agent,
    })
    throw new Error('should not be here')
  } catch (err) {
    strictEqual(err.message, 'kaboom')
    deepStrictEqual(hookCalled.message, 'kaboom')
  }
})

test('hooks - multiple onErrors', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'error.js'))
  t.after(() => worker.terminate())
  const hookCalled = []

  const onError1 = (error) => {
    hookCalled.push({ error1: error.message })
  }

  const onError2 = (error) => {
    hookCalled.push({ error2: error.message })
  }

  const interceptor = createThreadInterceptor({
    domain: '.local',
    onError: [onError1, onError2]
  })
  interceptor.route('myserver', worker)

  try {
    const agent = new Agent().compose(interceptor)
    await request('http://myserver.local', {
      dispatcher: agent,
    })
    throw new Error('should not be here')
  } catch (err) {
    strictEqual(err.message, 'kaboom')
    deepStrictEqual(hookCalled, [{ error1: 'kaboom' }, { error2: 'kaboom' }])
  }
})

test('hooks - should throw if handler not a function', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  try {
    createThreadInterceptor({
      domain: '.local',
      onResponse: 'nor a function',
    })
    throw new Error('should not be here')
  } catch (err) {
    strictEqual(err.message, 'Expected a function, got string')
  }
})
