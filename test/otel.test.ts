import { ok, strictEqual } from 'node:assert'
import { test } from 'node:test'
import { SpanKind, propagation, trace } from '@opentelemetry/api'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { Agent, request } from 'undici'

import { createMesh, createWorkerServer, waitForMeshServers } from './helper.ts'
import { createInterceptor } from '../src/index.ts'

test('undici OTel instrumentation creates client spans for thread-mode requests', async t => {
  const { memoryExporter, provider, instrumentation } = setupOtel(t)
  const { meshId, coordinatorThreadId } = await createMesh(t, 'otel-span')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'otel-span.local' })
  const interceptor = createInterceptor({ meshId, coordinatorThreadId, domain: '.local' })
  t.after(() => interceptor.close())
  await interceptor.ready
  await waitForMeshServers(interceptor, 'http:otel-span.local', 1)

  const { statusCode, body } = await request('http://otel-span.local', { dispatcher: new Agent().compose(interceptor) })
  await body.json()
  await provider.forceFlush()

  strictEqual(statusCode, 200)
  ok(instrumentation)
  const clientSpan = memoryExporter.getFinishedSpans().find(span => span.kind === SpanKind.CLIENT)
  ok(clientSpan, 'should create a CLIENT span')
  ok(clientSpan.attributes['http.request.method'] || clientSpan.attributes['http.method'])
  ok(clientSpan.attributes['url.full'] || clientSpan.attributes['http.url'])
  ok(clientSpan.attributes['http.response.status_code'] || clientSpan.attributes['http.status_code'])
})

test('undici OTel instrumentation injects trace context headers', async t => {
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())
  setupOtel(t)
  const { meshId, coordinatorThreadId } = await createMesh(t, 'otel-trace')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'otel-trace.local' })
  const interceptor = createInterceptor({ meshId, coordinatorThreadId, domain: '.local' })
  t.after(() => interceptor.close())
  await interceptor.ready
  await waitForMeshServers(interceptor, 'http:otel-trace.local', 1)
  const agent = new Agent().compose(interceptor)
  const tracer = trace.getTracer('undici-thread-interceptor-test')

  await tracer.startActiveSpan('parent', async parentSpan => {
    try {
      const { statusCode, body } = await request('http://otel-trace.local/echo-headers', { dispatcher: agent })
      const headers = await body.json()

      strictEqual(statusCode, 200)
      ok(headers.traceparent || headers.tracestate)
    } finally {
      parentSpan.end()
    }
  })
})

test('undici OTel instrumentation records request errors', async t => {
  const { memoryExporter, provider } = setupOtel(t)
  const { meshId, coordinatorThreadId } = await createMesh(t, 'otel-error')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'otel-error.local' })
  const interceptor = createInterceptor({ meshId, coordinatorThreadId, domain: '.local' })
  t.after(() => interceptor.close())
  await interceptor.ready
  await waitForMeshServers(interceptor, 'http:otel-error.local', 1)

  await request('http://otel-error.local/error', { dispatcher: new Agent().compose(interceptor) }).catch(error => {
    strictEqual(error.message, 'kaboom')
  })
  await provider.forceFlush()

  const errorSpan = memoryExporter.getFinishedSpans().find(span => span.kind === SpanKind.CLIENT)
  ok(errorSpan, 'should create a CLIENT span for errored request')
  ok(errorSpan.status.code === 2 || errorSpan.events.some(event => event.name.includes('exception')))
})

function setupOtel (t: test.TestContext): {
  memoryExporter: InMemorySpanExporter
  provider: BasicTracerProvider
  instrumentation: UndiciInstrumentation
} {
  const memoryExporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memoryExporter)] })
  trace.setGlobalTracerProvider(provider)
  const instrumentation = new UndiciInstrumentation()
  instrumentation.setTracerProvider(provider)
  instrumentation.enable()
  t.after(() => {
    instrumentation.disable()
    provider.shutdown()
  })

  return { memoryExporter, provider, instrumentation }
}
