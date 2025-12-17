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

test('hooks - should throw if array contains non-function', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  try {
    createThreadInterceptor({
      domain: '.local',
      onServerRequest: ['not a function'],
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
  await interceptor.route('myserver', worker)

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

test('hooks - onClientResponse', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())
  let hookCalled = null

  const interceptor = createThreadInterceptor({
    domain: '.local',
    onClientResponse: (req) => {
      hookCalled = req.path
    }
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)
  const { statusCode } = await request('http://myserver.local', {
    dispatcher: agent,
  })

  strictEqual(statusCode, 200)
  strictEqual(hookCalled, '/')
})

test('hooks - onClientResponseEnd', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())
  let hookCalled = null

  const interceptor = createThreadInterceptor({
    domain: '.local',
    onClientResponseEnd: (_req, res) => {
      hookCalled = true
    }
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)
  const { statusCode } = await request('http://myserver.local', {
    dispatcher: agent,
  })

  strictEqual(statusCode, 200)
  strictEqual(hookCalled, true)
})

test('hooks - onClientError', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'error.js'))
  t.after(() => worker.terminate())
  let hookCalled = null

  const interceptor = createThreadInterceptor({
    domain: '.local',
    onClientError: (_req, _rep, _ctx, error) => {
      hookCalled = error
    }
  })
  await interceptor.route('myserver', worker)

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

test('hooks - onServerRequest', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'server-hooks', 'worker-server-request-hook.js'), { stdout: true })
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  await interceptor.route('myserver', worker)

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
  deepStrictEqual(lines, ['onServerRequest called {"method":"GET","url":"/","headers":{"host":"myserver.local"},"payloadAsStream":true}'])
})

test('hooks - onServerResponse', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'server-hooks', 'worker-server-response-hook.js'), { stdout: true })
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  await interceptor.route('myserver', worker)

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
  deepStrictEqual(lines, ['onServerResponse called /'])
})

test('hooks - onServerError', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'server-hooks', 'worker-server-error-hook.js'), { stdout: true })
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  await interceptor.route('myserver', worker)

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

test('hooks - request propagation between onServerRequest and onServerResponse', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'server-hooks', 'worker-server-hooks.js'), { stdout: true })
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  await interceptor.route('myserver', worker)

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
  deepStrictEqual(lines, ['onServerRequest called {"method":"GET","url":"/","headers":{"host":"myserver.local"},"payloadAsStream":true}', 'onServerResponse called: propagated'])
})

test('hooks - request propagation between onClientRequest and onClientResponse', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())
  let hookCalledClient

  const interceptor = createThreadInterceptor({
    domain: '.local',
    onClientRequest: (req) => {
      req.dataInRequest = 'propagated'
    },
    onClientResponse: (req, res) => {
      hookCalledClient = req.dataInRequest
    }
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode } = await request('http://myserver.local', {
    dispatcher: agent,
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(hookCalledClient, 'propagated')
})

test('hooks - context propagation between onClientRequest and onClientResponse', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())
  let hookCalledClient

  const interceptor = createThreadInterceptor({
    domain: '.local',
    onClientRequest: (_req, ctx) => {
      ctx.data = 'propagated'
    },
    onClientResponse: (req, _res, ctx) => {
      hookCalledClient = ctx.data
    }
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode } = await request('http://myserver.local', {
    dispatcher: agent,
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(hookCalledClient, 'propagated')
})

test('hooks - array of onClientRequest hooks', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())
  const calls = []

  const interceptor = createThreadInterceptor({
    domain: '.local',
    onClientRequest: [
      (_req, ctx) => {
        calls.push('first')
        ctx.first = true
      },
      (_req, ctx) => {
        calls.push('second')
        ctx.second = true
      },
      (_req, ctx) => {
        calls.push('third')
        ctx.third = true
      }
    ]
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode } = await request('http://myserver.local', {
    dispatcher: agent,
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(calls, ['first', 'second', 'third'])
})

test('hooks - array of onServerRequest hooks with proper chaining', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'server-hooks', 'worker-server-request-array.js'), { stdout: true })
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  await interceptor.route('myserver', worker)

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
  deepStrictEqual(lines, [
    'First hook called',
    'Second hook called',
    'Third hook called'
  ])
})

test('hooks - array of onClientResponse hooks', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())
  const calls = []

  const interceptor = createThreadInterceptor({
    domain: '.local',
    onClientResponse: [
      (req, res, ctx) => {
        calls.push(`first: ${res.statusCode}`)
      },
      (req, res, ctx) => {
        calls.push(`second: ${res.statusCode}`)
      }
    ]
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode } = await request('http://myserver.local', {
    dispatcher: agent,
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(calls, ['first: 200', 'second: 200'])
})

test('hooks - mixed single and array hooks', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())
  const requestCalls = []
  const responseCalls = []

  const interceptor = createThreadInterceptor({
    domain: '.local',
    onClientRequest: (req, ctx) => {
      requestCalls.push('single')
    },
    onClientResponse: [
      (req, res, ctx) => {
        responseCalls.push('array1')
      },
      (req, res, ctx) => {
        responseCalls.push('array2')
      }
    ]
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode } = await request('http://myserver.local', {
    dispatcher: agent,
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(requestCalls, ['single'])
  deepStrictEqual(responseCalls, ['array1', 'array2'])
})
