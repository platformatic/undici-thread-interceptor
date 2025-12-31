'use strict'

const { test } = require('node:test')
const { ok, strictEqual } = require('node:assert')
const { join } = require('node:path')
const { Worker } = require('node:worker_threads')
const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base')
const { UndiciInstrumentation } = require('@opentelemetry/instrumentation-undici')
const { SpanKind, trace, propagation } = require('@opentelemetry/api')
const { W3CTraceContextPropagator } = require('@opentelemetry/core')
const { Agent, request } = require('undici')
const { createThreadInterceptor } = require('../')

test('undici OTel instrumentation automatically instruments thread-interceptor requests', async (t) => {
  // Set up OTel provider and exporter BEFORE creating any interceptors
  const memoryExporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(memoryExporter)]
  })
  trace.setGlobalTracerProvider(provider)

  // Enable undici instrumentation BEFORE creating thread interceptor
  const undiciInstrumentation = new UndiciInstrumentation()
  undiciInstrumentation.setTracerProvider(provider)
  undiciInstrumentation.enable()

  t.after(() => {
    undiciInstrumentation.disable()
    provider.shutdown()
  })

  // Set up worker and interceptor
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  // Make a request through the intercepted agent
  const { statusCode, body } = await request('http://myserver.local/', {
    dispatcher: agent
  })

  await body.json()
  strictEqual(statusCode, 200)

  // Force export of any pending spans
  await provider.forceFlush()

  // Get spans from memory exporter
  const spans = memoryExporter.getFinishedSpans()
  console.log('Total spans created:', spans.length)
  console.log('Span names:', spans.map(s => s.name))
  console.log('Span kinds:', spans.map(s => s.kind))

  // Should have at least one CLIENT span from the request
  const clientSpans = spans.filter(s => s.kind === SpanKind.CLIENT)
  ok(clientSpans.length > 0, `Should have created at least one CLIENT span, got ${clientSpans.length}`)

  const clientSpan = clientSpans[0]
  console.log('Client span name:', clientSpan.name)
  console.log('Client span attributes:', clientSpan.attributes)

  // Verify span attributes (check for both new and old semantic conventions)
  ok(
    clientSpan.attributes['http.request.method'] || clientSpan.attributes['http.method'],
    'Should have HTTP method attribute'
  )
  ok(
    clientSpan.attributes['url.full'] || clientSpan.attributes['http.url'],
    'Should have URL attribute'
  )
  ok(
    clientSpan.attributes['http.response.status_code'] || clientSpan.attributes['http.status_code'],
    'Should have response status code attribute'
  )
})

test('undici OTel instrumentation injects trace context headers', async (t) => {
  // Set up W3C Trace Context propagator (required for header injection)
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())

  // Set up OTel provider
  const memoryExporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(memoryExporter)]
  })
  trace.setGlobalTracerProvider(provider)

  const undiciInstrumentation = new UndiciInstrumentation()
  undiciInstrumentation.setTracerProvider(provider)
  undiciInstrumentation.enable()

  t.after(() => {
    undiciInstrumentation.disable()
    provider.shutdown()
  })

  // Set up worker that echoes headers
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  // Create a parent span to establish active context
  const tracer = trace.getTracer('test')
  await tracer.startActiveSpan('parent-span', async (parentSpan) => {
    try {
      // Make a request to the echo-headers endpoint which returns all headers
      const { statusCode, body } = await request('http://myserver.local/echo-headers', {
        dispatcher: agent
      })

      const receivedHeaders = await body.json()
      strictEqual(statusCode, 200)

      // Verify that traceparent header was injected by OTel instrumentation
      console.log('Received headers at server:', receivedHeaders)

      ok(
        receivedHeaders.traceparent || receivedHeaders.tracestate,
        'Should have trace context headers (traceparent or tracestate) injected by OTel'
      )

      console.log('Injected trace headers:', {
        traceparent: receivedHeaders.traceparent,
        tracestate: receivedHeaders.tracestate
      })
    } finally {
      parentSpan.end()
    }
  })
})

test('undici OTel instrumentation records errors', async (t) => {
  // Set up OTel provider
  const memoryExporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(memoryExporter)]
  })
  trace.setGlobalTracerProvider(provider)

  const undiciInstrumentation = new UndiciInstrumentation()
  undiciInstrumentation.setTracerProvider(provider)
  undiciInstrumentation.enable()

  t.after(() => {
    undiciInstrumentation.disable()
    provider.shutdown()
  })

  // Set up worker that throws errors
  const worker = new Worker(join(__dirname, 'fixtures', 'error.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  // Make a request that will error
  try {
    await request('http://myserver.local', {
      dispatcher: agent
    })
    throw new Error('Should have thrown')
  } catch (err) {
    strictEqual(err.message, 'kaboom')
  }

  // Force export
  await provider.forceFlush()

  // Get spans
  const spans = memoryExporter.getFinishedSpans()
  const clientSpans = spans.filter(s => s.kind === SpanKind.CLIENT)

  ok(clientSpans.length > 0, 'Should have created CLIENT span for errored request')

  // Verify span recorded the error
  const errorSpan = clientSpans[0]
  console.log('Error span status:', errorSpan.status)
  console.log('Error span events:', errorSpan.events)

  // The span should have error status or error events
  const hasError = errorSpan.status.code === 2 || // ERROR code
                   errorSpan.events.some(e => e.name.includes('exception'))

  ok(hasError, 'Span should record error information')
})

test('undici OTel instrumentation handles multi-value headers', async (t) => {
  const diagnosticsChannel = require('node:diagnostics_channel')

  let headersPayload = null

  // Only subscribe to headers channel, not create channel
  // This ensures lazy construction happens in fireOnClientResponse, after hooks have modified headers
  const headersChannel = diagnosticsChannel.channel('undici:request:headers')

  const headersSub = headersChannel.subscribe((msg) => {
    headersPayload = msg
  })

  t.after(() => {
    headersChannel.unsubscribe(headersSub)
  })

  // Set up worker
  const worker = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
    hooks: {
      onClientRequest (req) {
        // Add multi-value headers to request
        // Since only headers channel is subscribed, lazy construction will happen in fireOnClientResponse
        // after this hook has run, so these array values will be processed by createRequestWrapper
        req.headers = req.headers || {}
        req.headers.accept = ['application/json', 'text/plain']
        req.headers['x-custom'] = ['value1', 'value2', 'value3']
      },
      onClientResponse (req, res) {
        // Add multi-value header to response
        // This will be processed by convertResponseHeaders
        res.headers = res.headers || {}
        res.headers['set-cookie'] = ['session=abc123', 'token=xyz789']
      }
    }
  })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  // Make a request that will trigger multi-value header processing
  const { statusCode, body } = await request('http://myserver.local/', {
    dispatcher: agent
  })

  await body.json()
  strictEqual(statusCode, 200)

  // Verify headers event was published and received the wrapped request/response
  ok(headersPayload, 'Should have captured headers event')
  ok(headersPayload.request, 'Headers event should have request')
  ok(headersPayload.response, 'Headers event should have response')
  ok(Array.isArray(headersPayload.request.headers), 'Request headers should be in array format')
  ok(Array.isArray(headersPayload.response.headers), 'Response headers should be in array format')

  // The test passing means both createRequestWrapper and convertResponseHeaders successfully
  // processed the array-valued headers without throwing errors
})

test('undici OTel instrumentation produces only one span for network address requests', async (t) => {
  const { setTimeout: sleep } = require('node:timers/promises')

  // Set up OTel provider and exporter BEFORE creating any interceptors
  const memoryExporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(memoryExporter)]
  })
  trace.setGlobalTracerProvider(provider)

  // Enable undici instrumentation BEFORE creating thread interceptor
  const undiciInstrumentation = new UndiciInstrumentation()
  undiciInstrumentation.setTracerProvider(provider)
  undiciInstrumentation.enable()

  t.after(() => {
    undiciInstrumentation.disable()
    provider.shutdown()
  })

  // Set up worker with network address support (routes back to undici dispatcher)
  const worker = new Worker(join(__dirname, 'fixtures', 'network.js'), {
    workerData: { network: true }
  })
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('myserver', worker)

  // Wait for worker to advertise its network address
  await sleep(1000)

  const agent = new Agent().compose(interceptor)

  // Make a request through the intercepted agent with network address
  const { statusCode, body } = await request('http://myserver.local/', {
    dispatcher: agent
  })

  await body.json()
  strictEqual(statusCode, 200)

  // Force export of any pending spans
  await provider.forceFlush()

  // Get spans from memory exporter
  const spans = memoryExporter.getFinishedSpans()
  console.log('Total spans created:', spans.length)
  console.log('Span names:', spans.map(s => s.name))
  console.log('Span kinds:', spans.map(s => s.kind))
  console.log('Span attributes:', spans.map(s => s.attributes))

  // Filter client spans (the request spans created by undici OTel instrumentation)
  const clientSpans = spans.filter(s => s.kind === SpanKind.CLIENT)

  // CRITICAL: Should have exactly ONE CLIENT span, not duplicates
  // Before the fix, we would get 2 spans:
  // 1. From the thread interceptor hooks emitting diagnostics_channel events
  // 2. From undici itself when routing to the network address
  // After the fix, skipDiagnosticsChannel prevents the duplicate
  strictEqual(
    clientSpans.length,
    1,
    `Should have exactly one CLIENT span for network address request, got ${clientSpans.length}`
  )

  const clientSpan = clientSpans[0]
  console.log('Client span name:', clientSpan.name)
  console.log('Client span attributes:', clientSpan.attributes)

  // Verify the span has proper attributes
  ok(
    clientSpan.attributes['http.request.method'] || clientSpan.attributes['http.method'],
    'Should have HTTP method attribute'
  )
  ok(
    clientSpan.attributes['url.full'] || clientSpan.attributes['http.url'],
    'Should have URL attribute'
  )
  ok(
    clientSpan.attributes['http.response.status_code'] || clientSpan.attributes['http.status_code'],
    'Should have response status code attribute'
  )
})

test('undici OTel - network address skips diagnostics_channel events from hooks', async (t) => {
  const { setTimeout: sleep } = require('node:timers/promises')
  const diagnosticsChannel = require('node:diagnostics_channel')

  // Track diagnostics_channel events
  const events = {
    create: [],
    headers: [],
    trailers: [],
    error: []
  }

  const createChannel = diagnosticsChannel.channel('undici:request:create')
  const headersChannel = diagnosticsChannel.channel('undici:request:headers')
  const trailersChannel = diagnosticsChannel.channel('undici:request:trailers')
  const errorChannel = diagnosticsChannel.channel('undici:request:error')

  const createSub = createChannel.subscribe((msg) => events.create.push(msg))
  const headersSub = headersChannel.subscribe((msg) => events.headers.push(msg))
  const trailersSub = trailersChannel.subscribe((msg) => events.trailers.push(msg))
  const errorSub = errorChannel.subscribe((msg) => events.error.push(msg))

  t.after(() => {
    createChannel.unsubscribe(createSub)
    headersChannel.unsubscribe(headersSub)
    trailersChannel.unsubscribe(trailersSub)
    errorChannel.unsubscribe(errorSub)
  })

  // Set up OTel provider
  const memoryExporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(memoryExporter)]
  })
  trace.setGlobalTracerProvider(provider)

  const undiciInstrumentation = new UndiciInstrumentation()
  undiciInstrumentation.setTracerProvider(provider)
  undiciInstrumentation.enable()

  t.after(() => {
    undiciInstrumentation.disable()
    provider.shutdown()
  })

  // Set up worker with network address support
  const worker = new Worker(join(__dirname, 'fixtures', 'network.js'), {
    workerData: { network: true }
  })
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('myserver', worker)

  await sleep(1000)

  const agent = new Agent().compose(interceptor)

  // Make a request through network address
  const { statusCode, body } = await request('http://myserver.local/', {
    dispatcher: agent
  })

  await body.json()
  strictEqual(statusCode, 200)

  await provider.forceFlush()

  // The key assertion: diagnostics_channel events should only be emitted ONCE
  // by undici itself (when it makes the network request), NOT twice
  // (hooks should skip emitting when skipDiagnosticsChannel is true)
  console.log('diagnostics_channel events:', {
    create: events.create.length,
    headers: events.headers.length,
    trailers: events.trailers.length
  })

  // Each event type should appear exactly once (from undici's network request)
  // not twice (would indicate hooks incorrectly emitted events)
  strictEqual(events.create.length, 1, 'Should have exactly one create event')
  strictEqual(events.headers.length, 1, 'Should have exactly one headers event')
  strictEqual(events.trailers.length, 1, 'Should have exactly one trailers event')

  // Verify only one span was created
  const spans = memoryExporter.getFinishedSpans()
  const clientSpans = spans.filter(s => s.kind === SpanKind.CLIENT)
  strictEqual(clientSpans.length, 1, 'Should have exactly one CLIENT span')
})
