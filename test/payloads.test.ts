import { deepStrictEqual, ifError, rejects, strictEqual } from 'node:assert'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { request } from 'undici'

import { createAgent, createMesh, createWorkerServer, waitForMeshServers } from './helper.ts'

test('returns buffer responses', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'buffer')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'buffer.local' })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:buffer.local', 1)

  const { statusCode, body } = await request('http://buffer.local/buffer', { dispatcher: agent })

  strictEqual(statusCode, 200)
  deepStrictEqual(Buffer.from(await body.arrayBuffer()), Buffer.from('hello'))
})

test('returns binary responses unchanged', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'binary')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'binary.local' })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:binary.local', 1)

  const { statusCode, body } = await request('http://binary.local/binary', { dispatcher: agent })

  strictEqual(statusCode, 200)
  deepStrictEqual(Buffer.from(await body.arrayBuffer()), Buffer.from([0, 1, 2, 3, 255]))
})

test('handles responses without explicit headers', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'no-headers')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'no-headers.local' })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:no-headers.local', 1)

  const { statusCode, headers, body } = await request('http://no-headers.local/no-headers', { dispatcher: agent })

  strictEqual(statusCode, 200)
  ifError(headers['content-type'])
  strictEqual(await body.text(), 'text')
})

test('returns empty streamed responses', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'empty-stream')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'empty-stream.local' })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:empty-stream.local', 1)

  const { statusCode, body } = await request('http://empty-stream.local/empty-stream', { dispatcher: agent })

  strictEqual(statusCode, 200)
  strictEqual(await body.text(), '')
})

test('propagates streamed response errors without content length', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'stream-response-error-no-length')
  await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'stream-response-error-no-length.local'
  })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:stream-response-error-no-length.local', 1)

  const { statusCode, body } = await request('http://stream-response-error-no-length.local/stream-error-2', {
    dispatcher: agent
  })

  strictEqual(statusCode, 200)
  await rejects(body.text(), { message: 'kaboom' })
})

test('removes unwanted hop-by-hop request headers', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'headers')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'headers.local' })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:headers.local', 1)

  const { statusCode, body } = await request('http://headers.local/echo-headers', {
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
    host: 'headers.local',
    'x-foo': 'bar'
  })
})

test('filters nullish headers before server injection', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'nullish-headers')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'nullish-headers.local' })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:nullish-headers.local', 1)

  const response = await rawDispatch(agent, {
    origin: 'http://nullish-headers.local',
    path: '/echo-headers',
    method: 'GET',
    headers: {
      foo: undefined,
      bar: null,
      baz: 'ok'
    }
  })

  strictEqual(response.statusCode, 200)
  const headers = JSON.parse(response.body.toString())
  strictEqual(headers.host, 'nullish-headers.local')
  strictEqual(headers.baz, 'ok')
  strictEqual(headers.foo, undefined)
  strictEqual(headers.bar, undefined)
})

test('propagates dispatcher query options to server injection', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'query')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'query.local' })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:query.local', 1)

  const response = await rawDispatch(agent, {
    origin: 'http://query.local',
    path: '/echo-query',
    method: 'GET',
    query: { hello: 'world' }
  })

  strictEqual(response.statusCode, 200)
  deepStrictEqual(JSON.parse(response.body.toString()), { hello: 'world' })
})

test('returns a bad request response when a stream body errors', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'stream-error')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'stream-error.local' })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:stream-error.local', 1)

  const { statusCode, body } = await request('http://stream-error.local/echo-body', {
    dispatcher: agent,
    method: 'POST',
    body: new Readable({
      read () {
        this.destroy(new Error('kaboom'))
      }
    })
  })

  strictEqual(statusCode, 400)
  deepStrictEqual(await body.json(), { statusCode: 400, error: 'Bad Request', message: 'kaboom' })
})

test('POST string body', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'post-string')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'post-string.local' })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:post-string.local', 1)

  const { statusCode, body } = await request('http://post-string.local/echo-body', {
    dispatcher: agent,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hello: 'world' })
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'world' })
})

test('POST stream body', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'post-stream')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'post-stream.local' })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:post-stream.local', 1)

  const { statusCode, body } = await request('http://post-stream.local/echo-body', {
    dispatcher: agent,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: Readable.from(JSON.stringify({ hello: 'world' }))
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'world' })
})

test('POST buffer stream body', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'post-buffer-stream')
  await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'post-buffer-stream.local'
  })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:post-buffer-stream.local', 1)

  const { statusCode, body } = await request('http://post-buffer-stream.local/echo-body', {
    dispatcher: agent,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: Readable.from(Buffer.from(JSON.stringify({ hello: 'world' })))
  })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'world' })
})

test('correctly handles aborted requests', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'abort-request')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'abort-request.local' })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:abort-request.local', 1)
  const abortController = new AbortController()
  setImmediate(() => abortController.abort())

  await rejects(
    request('http://abort-request.local/unfinished-business', {
      dispatcher: agent,
      signal: abortController.signal,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' })
    })
  )
})

function rawDispatch (dispatcher: any, opts: any): Promise<{ statusCode: number; body: Buffer }> {
  const chunks: Buffer[] = []
  let statusCode = 0

  return new Promise((resolve, reject) => {
    dispatcher.dispatch(opts, {
      onRequestStart () {},
      onResponseStart (_controller: any, code: number) {
        statusCode = code
      },
      onResponseData (_controller: any, chunk: Buffer) {
        chunks.push(Buffer.from(chunk))
      },
      onResponseEnd () {
        resolve({ statusCode, body: Buffer.concat(chunks) })
      },
      onResponseError (_controller: any, error: Error) {
        reject(error)
      }
    })
  })
}
