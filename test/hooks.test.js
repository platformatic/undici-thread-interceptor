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
  interceptor.route('myserver', worker)

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
  interceptor.route('myserver', worker)

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
  deepStrictEqual(lines, ['onServerRequest called {"method":"GET","url":"/","headers":{"host":"myserver.local"},"payloadAsStream":true}'])
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
  deepStrictEqual(lines, ['onServerResponse called /'])
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

test('hooks - request propagation between onServerRequest and onServerResponse', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'server-hooks', 'worker-server-hooks.js'), { stdout: true })
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
  interceptor.route('myserver', worker)

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
  interceptor.route('myserver', worker)

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
  interceptor.route('myserver', worker)

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
  interceptor.route('myserver', worker)

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
  interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  const { statusCode } = await request('http://myserver.local', {
    dispatcher: agent,
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(requestCalls, ['single'])
  deepStrictEqual(responseCalls, ['array1', 'array2'])
})

// Tests for hooks with network address dispatch path (when port[kAddress] is set)
const { once } = require('node:events')

test('hooks - onClientRequest with network address', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'network.js'), {
    workerData: { network: true }
  })
  t.after(() => worker.terminate())
  let hookCalledClient

  const interceptor = createThreadInterceptor({
    domain: '.local',
    onClientRequest: (opts) => {
      hookCalledClient = opts
    }
  })
  interceptor.route('myserver', worker)

  // Wait for worker to advertise its network address
  await once(worker, 'message')

  const agent = new Agent().compose(interceptor)

  const { statusCode } = await request('http://myserver.local', {
    dispatcher: agent
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(hookCalledClient.method, 'GET')
  deepStrictEqual(hookCalledClient.path, '/')
  deepStrictEqual(hookCalledClient.headers.host, 'myserver.local')
})

test('hooks - onClientResponse with network address', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'network.js'), {
    workerData: { network: true }
  })
  t.after(() => worker.terminate())
  let hookCalled = null

  const interceptor = createThreadInterceptor({
    domain: '.local',
    onClientResponse: (req, res) => {
      hookCalled = { path: req.path, statusCode: res.statusCode }
    }
  })
  interceptor.route('myserver', worker)

  await once(worker, 'message')

  const agent = new Agent().compose(interceptor)
  const { statusCode } = await request('http://myserver.local', {
    dispatcher: agent
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(hookCalled, { path: '/', statusCode: 200 })
})

test('hooks - onClientResponseEnd with network address', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'network.js'), {
    workerData: { network: true }
  })
  t.after(() => worker.terminate())
  let hookCalled = null

  const interceptor = createThreadInterceptor({
    domain: '.local',
    onClientResponseEnd: (req, res) => {
      hookCalled = { path: req.path, statusCode: res.statusCode }
    }
  })
  interceptor.route('myserver', worker)

  await once(worker, 'message')

  const agent = new Agent().compose(interceptor)
  const { statusCode, body } = await request('http://myserver.local', {
    dispatcher: agent
  })

  // Consume the body to trigger onClientResponseEnd
  await body.json()

  strictEqual(statusCode, 200)
  deepStrictEqual(hookCalled, { path: '/', statusCode: 200 })
})

test('hooks - onClientError with network address', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'network-crash.js'))
  t.after(() => worker.terminate())
  let hookCalled = null

  const interceptor = createThreadInterceptor({
    domain: '.local',
    onClientError: (req, res, ctx, error) => {
      hookCalled = { path: req.path, error }
    }
  })
  interceptor.route('myserver', worker)

  await once(worker, 'message')

  const agent = new Agent().compose(interceptor)

  try {
    await request('http://myserver.local/crash', {
      dispatcher: agent
    })
    throw new Error('should not be here')
  } catch (err) {
    strictEqual(hookCalled.path, '/crash')
    strictEqual(hookCalled.error.code, 'UND_ERR_SOCKET')
  }
})

test('hooks - header injection and server round-trip with network address', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'network-tracing.js'))
  t.after(() => worker.terminate())

  const clientTraceId = 'trace-12345'
  const clientSpanId = 'client-span-67890'
  let responseFromHook = null

  const interceptor = createThreadInterceptor({
    domain: '.local',
    onClientRequest: (opts) => {
      // Inject tracing headers (simulating what OpenTelemetry would do)
      opts.headers['x-trace-id'] = clientTraceId
      opts.headers['x-span-id'] = clientSpanId
    },
    onClientResponse: (req, res) => {
      // Capture response headers from the server
      responseFromHook = {
        traceId: res.headers['x-trace-id'],
        serverSpanId: res.headers['x-server-span-id'],
        parentSpanId: res.headers['x-parent-span-id']
      }
    }
  })
  interceptor.route('myserver', worker)

  await once(worker, 'message')

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local', {
    dispatcher: agent
  })

  const responseBody = await body.json()

  strictEqual(statusCode, 200)

  // Verify the server received our injected headers
  strictEqual(responseBody.receivedTraceId, clientTraceId)
  strictEqual(responseBody.receivedSpanId, clientSpanId)

  // Verify the server created its own span (different from client's)
  strictEqual(typeof responseBody.serverSpanId, 'string')
  strictEqual(responseBody.serverSpanId.startsWith('server-span-'), true)

  // Verify we can access response headers in onClientResponse hook
  strictEqual(responseFromHook.traceId, clientTraceId) // Trace ID should be echoed
  strictEqual(responseFromHook.parentSpanId, clientSpanId) // Our span is now the parent
  strictEqual(responseFromHook.serverSpanId, responseBody.serverSpanId) // Server's span
})

test('hooks - context propagation for non-serializable data with network address', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures', 'network-tracing.js'))
  t.after(() => worker.terminate())

  // Non-serializable data that can't go through headers
  const spanObject = { traceId: 'trace-abc', startTime: Date.now(), end: () => {} }
  let capturedContext = null

  const interceptor = createThreadInterceptor({
    domain: '.local',
    onClientRequest: (opts, ctx) => {
      // Store non-serializable span object in context
      ctx.span = spanObject
      // Inject serializable trace ID into headers
      opts.headers['x-trace-id'] = spanObject.traceId
    },
    onClientResponse: (req, res, ctx) => {
      // Access both: context (non-serializable) and response headers (from server)
      capturedContext = {
        spanFromContext: ctx.span,
        serverSpanFromHeaders: res.headers['x-server-span-id']
      }
    }
  })
  interceptor.route('myserver', worker)

  await once(worker, 'message')

  const agent = new Agent().compose(interceptor)

  const { statusCode, body } = await request('http://myserver.local', {
    dispatcher: agent
  })

  await body.json()

  strictEqual(statusCode, 200)

  // Verify context preserved the non-serializable span object
  strictEqual(capturedContext.spanFromContext, spanObject)
  strictEqual(typeof capturedContext.spanFromContext.end, 'function')

  // Verify we also got the server's response header
  strictEqual(typeof capturedContext.serverSpanFromHeaders, 'string')
  strictEqual(capturedContext.serverSpanFromHeaders.startsWith('server-span-'), true)
})
