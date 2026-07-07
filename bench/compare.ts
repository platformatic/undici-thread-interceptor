import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import Fastify from 'fastify'
import { Agent, request, type Dispatcher } from 'undici'

import { createCoordinator, createInterceptor, createServer, type InterceptorFunction } from '../src/index.ts'

const requests = Number(process.env.REQUESTS ?? 100_000)

const app = Fastify()
app.get('/', async () => ({ hello: 'world' }))
await app.listen({ port: 0 })

const threadMeshId = `bench-thread-${process.pid}`
const threadCoordinator = createCoordinator({ meshId: threadMeshId })
const threadWorker = new Worker(new URL('./worker.ts', import.meta.url), {
  workerData: {
    meshId: threadMeshId,
    coordinatorThreadId: 0,
    serverId: 'thread-server-1',
    domain: 'thread.local'
  }
})

const tcpMeshId = `bench-tcp-${process.pid}`
const tcpCoordinator = createCoordinator({ meshId: tcpMeshId })

try {
  await once(threadWorker, 'message')

  const threadInterceptor = createInterceptor({ meshId: threadMeshId, domain: '.local' })
  await threadInterceptor.ready
  await waitForOrigin(threadInterceptor, 'http:thread.local')
  const threadAgent = new Agent().compose(threadInterceptor)

  const tcpServer = createServer({
    meshId: tcpMeshId,
    serverId: 'tcp-server-1',
    domain: 'tcp.local',
    server: app.listeningOrigin
  })
  await tcpServer.ready
  const tcpInterceptor = createInterceptor({ meshId: tcpMeshId, domain: '.local' })
  await tcpInterceptor.ready
  await waitForOrigin(tcpInterceptor, 'http:tcp.local')
  const tcpAgent = new Agent().compose(tcpInterceptor)

  await run('direct undici', app.listeningOrigin, new Agent())
  await run('v2 tcp target', 'http://tcp.local', tcpAgent)
  await run('v2 thread target', 'http://thread.local', threadAgent)

  threadInterceptor.close()
  tcpInterceptor.close()
  await tcpServer.close()
} finally {
  await threadWorker.terminate()
  threadCoordinator.destroy()
  tcpCoordinator.destroy()
  await app.close()
}

async function run (name: string, origin: string, dispatcher: Dispatcher): Promise<void> {
  const start = performance.now()
  const responses = []

  for (let i = 0; i < requests; i++) {
    responses.push(performRequest(origin, dispatcher))
  }

  await Promise.all(responses)

  const elapsed = performance.now() - start
  const seconds = elapsed / 1000
  const rate = Math.round(requests / seconds)
  console.log(`${name}: ${elapsed.toFixed(2)}ms (${rate} req/s)`)
}

async function performRequest (origin: string, dispatcher: Dispatcher): Promise<void> {
  const res = await request(origin, { dispatcher })
  await res.body.text()
}

async function waitForOrigin (interceptor: InterceptorFunction, origin: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (interceptor.getMesh()?.origins[origin]) {
      return
    }
    await sleep(20)
  }

  throw new Error(`mesh did not contain ${origin}`)
}
