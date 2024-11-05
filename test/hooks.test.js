'use strict'

const { test } = require('node:test')
const { deepStrictEqual, strictEqual, rejects } = require('node:assert')
const { join } = require('node:path')
const { Worker } = require('node:worker_threads')
const { createThreadInterceptor } = require('../')
const { setTimeout: sleep } = require('node:timers/promises')
const { Agent, request } = require('undici')
const split2 = require('split2')

test('hooks - should throw if handler not a function', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  try {
    createThreadInterceptor({
      domain: '.local',
      onClientResponse: 'nor a function',
    })
    throw new Error('should not be here')
  } catch (err) {
    strictEqual(err.message, 'Expected a function, got string')
  }
})

test('hooks - should throw if handler is async', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  try {
    createThreadInterceptor({
      domain: '.local',
      onClientResponse: async () => {},
    })
    throw new Error('should not be here')
  } catch (err) {
    strictEqual(err.message, 'Async hooks are not supported')
  }
})

test('hooks - onClientRequest', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())
  let hookCalledClient

  const interceptor = createThreadInterceptor({
    domain: '.local',
    onClientRequest: (opts) => {
      hookCalledClient = opts
    },
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode } = await request('http://myserver.local', {
    dispatcher: agent,
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(hookCalledClient, {
    headers: {
      host: 'myserver.local',
    },
    method: 'GET',
    origin: 'http://myserver.local',
    path: '/'
  })
})

test('hooks - multiple onClientRequests', async (t) => {
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
    onClientRequest: [firstHook, secondHook]
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

test('hooks - onClientResponse', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())
  let hookCalled = null

  const interceptor = createThreadInterceptor({
    domain: '.local',
    onClientResponse: (opts) => {
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

test('hooks - multiple onClientResponses', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())
  const hookCalled = []

  const onClientResponse1 = (opts) => {
    hookCalled.push({ res1: Buffer.from(opts.rawPayload).toString() })
  }

  const onClientResponse2 = (opts) => {
    hookCalled.push({ res2: Buffer.from(opts.rawPayload).toString() })
  }

  const interceptor = createThreadInterceptor({
    domain: '.local',
    onClientResponse: [onClientResponse1, onClientResponse2]
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)
  const { statusCode } = await request('http://myserver.local', {
    dispatcher: agent,
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(hookCalled, [{ res1: '{"hello":"world"}' }, { res2: '{"hello":"world"}' }])
})

test('hooks - onClientError', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'error.js'))
  t.after(() => worker.terminate())
  let hookCalled = null

  const interceptor = createThreadInterceptor({
    domain: '.local',
    onClientError: (error) => {
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

test('hooks - multiple onClientErrors', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'error.js'))
  t.after(() => worker.terminate())
  const hookCalled = []

  const onClientError1 = (error) => {
    hookCalled.push({ error1: error.message })
  }

  const onClientError2 = (error) => {
    hookCalled.push({ error2: error.message })
  }

  const interceptor = createThreadInterceptor({
    domain: '.local',
    onClientError: [onClientError1, onClientError2]
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

test('hooks - onServerRequest', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'server-hooks', 'worker-server-request-hook.js'), { stdout: true })
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode } = await request('http://myserver.local', {
    dispatcher: agent,
  })

  strictEqual(statusCode, 200)

  const lines = []
  worker.stdout.pipe(split2()).on('data', line => {
    lines.push(line)
  })
  await sleep(300)
  deepStrictEqual(lines, ['onServerRequest called {"method":"GET","url":"/","headers":{"host":"myserver.local"}}'])
})

test('hooks - onServerResponse', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'server-hooks', 'worker-server-response-hook.js'), { stdout: true })
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode } = await request('http://myserver.local', {
    dispatcher: agent,
  })

  strictEqual(statusCode, 200)

  const lines = []
  worker.stdout.pipe(split2()).on('data', line => {
    lines.push(line)
  })
  await sleep(300)
  deepStrictEqual(lines, ['onServerResponse called "{\\"hello\\":\\"world\\"}"'])
})

test('hooks - onServerError', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'server-hooks', 'worker-server-error-hook.js'), { stdout: true })
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  await rejects(request('http://myserver.local', {
    dispatcher: agent,
  }), new Error('kaboom'))

  const lines = []
  worker.stdout.pipe(split2()).on('data', line => {
    lines.push(line)
  })
  await sleep(300)
  deepStrictEqual(lines, ['onServerError called: kaboom'])
})
