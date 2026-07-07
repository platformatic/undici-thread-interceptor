import { deepStrictEqual, rejects, strictEqual } from 'node:assert'
import { once } from 'node:events'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { MessageChannel, threadId, type MessagePort } from 'node:worker_threads'
import { Agent, interceptors, request } from 'undici'

import { ConnectTimeoutError, Interceptor, createCoordinator, createInterceptor, createServer } from '../src/index.ts'
import { MessagePortWritable } from '../src/message-port-streams.ts'
import { Message, type CoordinatorConnectMessage, type RequestMessage } from '../src/protocol.ts'
import { createAgent, createMesh, createWorkerServer, requestWithTimeout, waitForMeshServers } from './helper.ts'

let directCounter = 0

function directMeshId (name: string): string {
  return `v2-resilience-direct-${name}-${directCounter++}`
}

function requestMessage (id: string): RequestMessage {
  return {
    type: Message.REQUEST,
    id,
    meshId: 'mesh',
    interceptorId: 'interceptor',
    origin: 'http:resilience.local',
    path: '/',
    method: 'GET',
    headers: {}
  }
}

async function waitForServer (interceptor: Interceptor, origin: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (interceptor.getMesh()?.origins[origin]) {
      return
    }
    await sleep(20)
  }

  throw new Error(`mesh did not contain ${origin}`)
}

test('composes with undici retry interceptor on 503 responses', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'retry')
  await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'retry.local',
    whoamiReturn503: true
  })
  const second = await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-2',
    domain: 'retry.local'
  })
  const { interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:retry.local', 2)
  const originalRandom = Math.random
  Math.random = () => 0
  t.after(() => {
    Math.random = originalRandom
  })
  const agent = new Agent().compose(interceptor, interceptors.retry())

  for (let i = 0; i < 2; i++) {
    const { statusCode, body } = await request('http://retry.local/whoami', { dispatcher: agent })

    strictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { threadId: second.threadId })
  }
})

test('times out unfinished responses', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'timeout')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'timeout.local' })
  const { agent, interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:timeout.local', 1)

  await rejects(requestWithTimeout(request('http://timeout.local/unfinished-business', { dispatcher: agent }), 500))
})

test('applies connectTimeout while waiting for a response', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'response-timeout')
  await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'response-timeout.local'
  })
  const interceptor = createInterceptor({
    meshId,
    coordinatorThreadId,
    domain: '.local',
    connectTimeout: 100
  })
  t.after(() => interceptor.close())
  await interceptor.ready
  await waitForMeshServers(interceptor, 'http:response-timeout.local', 1)
  const agent = new Agent().compose(interceptor)

  await rejects(
    request('http://response-timeout.local/unfinished-business', { dispatcher: agent }),
    ConnectTimeoutError
  )
})

test('disables response timeout when connectTimeout is zero', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'response-timeout-disabled')
  await createWorkerServer(t, {
    meshId,
    coordinatorThreadId,
    serverId: 'server-1',
    domain: 'response-timeout-disabled.local'
  })
  const interceptor = createInterceptor({
    meshId,
    coordinatorThreadId,
    domain: '.local',
    connectTimeout: 0
  })
  t.after(() => interceptor.close())
  await interceptor.ready
  await waitForMeshServers(interceptor, 'http:response-timeout-disabled.local', 1)
  const agent = new Agent().compose(interceptor)
  const pending = request('http://response-timeout-disabled.local/unfinished-business', { dispatcher: agent })
  pending.catch(() => {})

  await rejects(requestWithTimeout(pending, 200), { message: 'timeout' })
})

test('server direct peer paths handle invalid messages and inject errors', async t => {
  const meshId = directMeshId('server-peer')
  const coordinator = createCoordinator({ meshId })
  t.after(() => coordinator.destroy())

  const tcpServer = createServer({ meshId, serverId: 'tcp-1', domain: 'resilience.local', server: 'http://127.0.0.1' })
  t.after(() => tcpServer.close())
  await tcpServer.ready

  const tcpPeer = new MessageChannel()
  tcpServer.addPeer(tcpPeer.port1, 'interceptor-1')
  tcpServer.addPeer(tcpPeer.port1, 'interceptor-1')
  tcpPeer.port2.postMessage({ type: 'unknown' })
  tcpPeer.port2.postMessage(requestMessage('tcp-rejected'))
  const [tcpResponse] = (await once(tcpPeer.port2, 'message')) as Array<{ statusCode: number }>
  strictEqual(tcpResponse.statusCode, 503)
  tcpPeer.port2.close()

  const completedServer = createServer({
    meshId,
    serverId: 'thread-1',
    domain: 'completed.local',
    server: {
      inject (_req: any, callback: (error: Error | undefined, res: any) => void) {
        const res = {
          statusCode: 200,
          statusMessage: 'OK',
          headers: { 'content-length': '2' },
          stream: () => Readable.from(['ok'])
        }
        callback(undefined, res)
        callback(undefined, res)
      }
    }
  })
  t.after(() => completedServer.close())
  await completedServer.ready

  const completedPeer = new MessageChannel()
  completedServer.addPeer(completedPeer.port1, 'interceptor-1')
  completedPeer.port2.postMessage(requestMessage('completed'))
  const [completedResponse] = (await once(completedPeer.port2, 'message')) as Array<{ body: Buffer }>
  deepStrictEqual(Buffer.from(completedResponse.body), Buffer.from('ok'))
  completedPeer.port2.close()

  const bodyServer = createServer({
    meshId,
    serverId: 'thread-4',
    domain: 'body.local',
    server (req: any, res: any) {
      req.body.resume?.()
      res.setHeader('content-length', '2')
      res.end('ok')
    }
  })
  t.after(() => bodyServer.close())
  await bodyServer.ready

  const bodyPeer = new MessageChannel()
  bodyServer.addPeer(bodyPeer.port1, 'interceptor-1')
  bodyPeer.port2.postMessage({ ...requestMessage('body'), body: new Uint8Array(Buffer.from('hello')) })
  const [bodyResponse] = (await once(bodyPeer.port2, 'message')) as Array<{ body?: Buffer; bodyPort?: MessagePort }>
  bodyResponse.bodyPort?.close()
  bodyPeer.port2.close()

  const noHeadersServer = createServer({
    meshId,
    serverId: 'thread-5',
    domain: 'no-headers.local',
    server: {
      inject (_req: any, callback: (error: Error | undefined, res: any) => void) {
        callback(undefined, {
          statusCode: 204,
          statusMessage: 'No Content',
          stream: () => Readable.from([])
        })
      }
    }
  })
  t.after(() => noHeadersServer.close())
  await noHeadersServer.ready

  const noHeadersPeer = new MessageChannel()
  noHeadersServer.addPeer(noHeadersPeer.port1, 'interceptor-1')
  noHeadersPeer.port2.postMessage(requestMessage('no-headers'))
  const [noHeadersResponse] = (await once(noHeadersPeer.port2, 'message')) as Array<{
    headers: Record<string, unknown>
    bodyPort?: MessagePort
  }>
  deepStrictEqual(noHeadersResponse.headers, {})
  noHeadersResponse.bodyPort?.close()
  noHeadersPeer.port2.close()

  const failingServer = createServer({
    meshId,
    serverId: 'thread-2',
    domain: 'failing.local',
    server: {
      inject (_req: any, callback: (error: Error) => void) {
        callback(new Error('inject failed'))
      }
    }
  })
  t.after(() => failingServer.close())
  await failingServer.ready

  const failingPeer = new MessageChannel()
  failingServer.addPeer(failingPeer.port1, 'interceptor-1')
  failingPeer.port2.postMessage(requestMessage('failed'))
  const [errorMessage] = (await once(failingPeer.port2, 'message')) as Array<{ type: Message; error: Error }>
  strictEqual(errorMessage.type, Message.ERROR)
  strictEqual(errorMessage.error.message, 'inject failed')
  failingPeer.port2.close()

  const bodyErrorServer = createServer({
    meshId,
    serverId: 'thread-3',
    domain: 'body-error.local',
    server: {
      inject (_req: any, callback: (error: Error | undefined, res: any) => void) {
        callback(undefined, {
          statusCode: 200,
          statusMessage: 'OK',
          headers: { 'content-length': '1' },
          stream: () => {
            return new Readable({
              read () {
                this.destroy(new Error('body failed'))
              }
            })
          }
        })
      }
    }
  })
  t.after(() => bodyErrorServer.close())
  await bodyErrorServer.ready

  const bodyErrorPeer = new MessageChannel()
  bodyErrorServer.addPeer(bodyErrorPeer.port1, 'interceptor-1')
  bodyErrorPeer.port2.postMessage(requestMessage('body-failed'))
  const [bodyErrorMessage] = (await once(bodyErrorPeer.port2, 'message')) as Array<{ type: Message; error: Error }>
  strictEqual(bodyErrorMessage.type, Message.ERROR)
  strictEqual(bodyErrorMessage.error.message, 'body failed')
  bodyErrorPeer.port2.close()
})

test('interceptor handles handler aborts and callback exceptions', async t => {
  const meshId = directMeshId('interceptor-handler-errors')
  const coordinator = createCoordinator({ meshId })
  t.after(() => coordinator.destroy())
  const server = createServer({
    meshId,
    serverId: 'server-1',
    domain: 'handler.local',
    server (req: any, res: any) {
      if (req.url === '/stream') {
        res.write('stream')
        setImmediate(() => res.end())
        return
      }

      res.setHeader('content-length', '2')
      res.end('ok')
    }
  })
  t.after(() => server.close())
  await server.ready
  const interceptor = new Interceptor({ meshId, domain: '.local' })
  t.after(() => interceptor.close())
  await interceptor.ready
  await waitForServer(interceptor, 'http:handler.local')

  async function dispatchWithHandler (path: string, handler: any): Promise<void> {
    interceptor.dispatch(
      () => false,
      { origin: 'http://handler.local', path, method: 'GET', headers: {} } as any,
      handler
    )
    await handler.done
  }

  {
    const done = Promise.withResolvers<void>()
    await dispatchWithHandler('/', {
      done: done.promise,
      onRequestStart (controller: any) {
        controller.abort(new Error('abort before start'))
      },
      onResponseError (_controller: any, error: Error) {
        strictEqual(error.message, 'abort before start')
        done.resolve()
      }
    })
  }

  {
    const done = Promise.withResolvers<void>()
    await dispatchWithHandler('/', {
      done: done.promise,
      onResponseStart (controller: any) {
        controller.abort(new Error('abort after start'))
      },
      onResponseError (_controller: any, error: Error) {
        strictEqual(error.message, 'abort after start')
        done.resolve()
      }
    })
  }

  {
    const done = Promise.withResolvers<void>()
    await dispatchWithHandler('/', {
      done: done.promise,
      onResponseStart () {
        throw new Error('start failed')
      },
      onResponseError (_controller: any, error: Error) {
        strictEqual(error.message, 'start failed')
        done.resolve()
      }
    })
  }

  {
    const done = Promise.withResolvers<void>()
    await dispatchWithHandler('/', {
      done: done.promise,
      onResponseData () {
        throw new Error('data failed')
      },
      onResponseError (_controller: any, error: Error) {
        strictEqual(error.message, 'data failed')
        done.resolve()
      }
    })
  }

  {
    const done = Promise.withResolvers<void>()
    await dispatchWithHandler('/stream', {
      done: done.promise,
      onResponseData () {
        throw new Error('stream data failed')
      },
      onResponseError (_controller: any, error: Error) {
        strictEqual(error.message, 'stream data failed')
        done.resolve()
      }
    })
  }
})

test('interceptor ignores peer messages without matching pending requests', async t => {
  const meshId = directMeshId('interceptor-peer-messages')
  const coordinator = createCoordinator({ meshId })
  t.after(() => coordinator.destroy())

  const serverChannel = new MessageChannel()
  coordinator.connectMember({
    type: Message.COORDINATOR_CONNECT,
    meshId,
    role: 'server',
    threadId,
    port: serverChannel.port1,
    server: {
      id: 'server-1',
      origin: 'http:fake.local',
      state: 'available',
      mode: 'thread'
    }
  } as CoordinatorConnectMessage)
  t.after(() => serverChannel.port2.close())

  const interceptor = new Interceptor({ meshId, domain: '.local' })
  t.after(() => interceptor.close())
  await interceptor.ready
  await waitForServer(interceptor, 'http:fake.local')

  const peerReady = Promise.withResolvers<MessagePort>()
  const onWorkerMessage = (value: unknown) => {
    const message = value as { type?: Message; serverId?: string; port?: MessagePort }
    if (message.type === Message.PEER_CONNECT && message.serverId === 'server-1' && message.port) {
      message.port.start()
      peerReady.resolve(message.port)
    }
  }
  process.on('workerMessage', onWorkerMessage)
  t.after(() => process.off('workerMessage', onWorkerMessage))

  const done = Promise.withResolvers<void>()
  interceptor.dispatch(() => false, { origin: 'http://fake.local', path: '/', method: 'GET', headers: {} } as any, {
    onResponseEnd () {
      done.resolve()
    }
  })

  const peer = await peerReady.promise
  t.after(() => peer.close())
  const [peerRequest] = (await once(peer, 'message')) as Array<{ id: string }>
  peer.postMessage({})
  peer.postMessage({ type: Message.RESPONSE, id: 'missing', statusCode: 204, headers: {}, body: Buffer.alloc(0) })
  peer.postMessage({ type: Message.RESPONSE, id: peerRequest.id, statusCode: 204, headers: {}, body: Buffer.alloc(0) })
  await done.promise

  {
    const arrayDone = Promise.withResolvers<void>()
    const chunks: Buffer[] = []
    interceptor.dispatch(() => false, { origin: 'http://fake.local', path: '/', method: 'GET', headers: {} } as any, {
      onResponseData (_controller: any, chunk: Buffer) {
        chunks.push(chunk)
      },
      onResponseEnd () {
        deepStrictEqual(Buffer.concat(chunks), Buffer.from('ok'))
        arrayDone.resolve()
      }
    })
    const [arrayRequest] = (await once(peer, 'message')) as Array<{ id: string }>
    peer.postMessage({
      type: Message.RESPONSE,
      id: arrayRequest.id,
      statusCode: 200,
      headers: {},
      body: new Uint8Array(Buffer.from('ok'))
    })
    await arrayDone.promise
  }

  {
    const stringDone = Promise.withResolvers<void>()
    const chunks: Buffer[] = []
    interceptor.dispatch(() => false, { origin: 'http://fake.local', path: '/', method: 'GET', headers: {} } as any, {
      onResponseData (_controller: any, chunk: Buffer) {
        chunks.push(chunk)
      },
      onResponseEnd () {
        deepStrictEqual(Buffer.concat(chunks), Buffer.from('ok'))
        stringDone.resolve()
      }
    })
    const [stringRequest] = (await once(peer, 'message')) as Array<{ id: string }>
    peer.postMessage({
      type: Message.RESPONSE,
      id: stringRequest.id,
      statusCode: 200,
      headers: {},
      body: 'ok'
    })
    await stringDone.promise
  }

  {
    const streamedDone = Promise.withResolvers<void>()
    const chunks: Buffer[] = []
    interceptor.dispatch(() => false, { origin: 'http://fake.local', path: '/', method: 'GET', headers: {} } as any, {
      onResponseData (controller: any, chunk: Buffer) {
        controller.pause()
        controller.resume()
        chunks.push(chunk)
      },
      onResponseEnd () {
        deepStrictEqual(Buffer.concat(chunks), Buffer.from('ok'))
        streamedDone.resolve()
      }
    })
    const [streamedRequest] = (await once(peer, 'message')) as Array<{ id: string }>
    const transferable = MessagePortWritable.asTransferable(Readable.from(['ok']))
    peer.postMessage(
      { type: Message.RESPONSE, id: streamedRequest.id, statusCode: 200, headers: {}, bodyPort: transferable.port },
      transferable.transferList
    )
    await streamedDone.promise
  }

  {
    const dataErrorDone = Promise.withResolvers<void>()
    interceptor.dispatch(() => false, { origin: 'http://fake.local', path: '/', method: 'GET', headers: {} } as any, {
      onResponseData () {
        throw new Error('stream data failed')
      },
      onResponseError (_controller: any, error: Error) {
        strictEqual(error.message, 'stream data failed')
        dataErrorDone.resolve()
      }
    })
    const [streamedRequest] = (await once(peer, 'message')) as Array<{ id: string }>
    const transferable = MessagePortWritable.asTransferable(Readable.from(['ok']))
    peer.postMessage(
      { type: Message.RESPONSE, id: streamedRequest.id, statusCode: 200, headers: {}, bodyPort: transferable.port },
      transferable.transferList
    )
    await dataErrorDone.promise
  }

  {
    const endErrorDone = Promise.withResolvers<void>()
    interceptor.dispatch(() => false, { origin: 'http://fake.local', path: '/', method: 'GET', headers: {} } as any, {
      onResponseEnd () {
        throw new Error('stream end failed')
      },
      onResponseError (_controller: any, error: Error) {
        strictEqual(error.message, 'stream end failed')
        endErrorDone.resolve()
      }
    })
    const [streamedRequest] = (await once(peer, 'message')) as Array<{ id: string }>
    const transferable = MessagePortWritable.asTransferable(Readable.from(['ok']))
    peer.postMessage(
      { type: Message.RESPONSE, id: streamedRequest.id, statusCode: 200, headers: {}, bodyPort: transferable.port },
      transferable.transferList
    )
    await endErrorDone.promise
  }

  {
    const remoteErrorDone = Promise.withResolvers<void>()
    interceptor.dispatch(() => false, { origin: 'http://fake.local', path: '/', method: 'GET', headers: {} } as any, {
      onResponseError (_controller: any, error: Error) {
        strictEqual(error.message, 'stream body failed')
        remoteErrorDone.resolve()
      }
    })
    const [streamedRequest] = (await once(peer, 'message')) as Array<{ id: string }>
    const channel = new MessageChannel()
    peer.postMessage(
      { type: Message.RESPONSE, id: streamedRequest.id, statusCode: 200, headers: {}, bodyPort: channel.port1 },
      [channel.port1]
    )
    channel.port2.postMessage({ err: new Error('stream body failed') })
    await remoteErrorDone.promise
  }
})
