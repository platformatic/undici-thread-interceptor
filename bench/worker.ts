import { parentPort, workerData } from 'node:worker_threads'
import Fastify from 'fastify'

import { createServer } from '../src/index.ts'

const app = Fastify()

app.get('/', async () => ({ hello: workerData?.message ?? 'world' }))
await app.ready()

const server = createServer({
  meshId: workerData.meshId,
  coordinatorThreadId: workerData.coordinatorThreadId,
  serverId: workerData.serverId,
  domain: workerData.domain,
  server: app
})

await server.ready
parentPort?.postMessage({ type: 'ready' })

parentPort?.on('message', message => {
  if (message === 'close') {
    server.close().then(() => app.close()).then(() => parentPort?.postMessage({ type: 'closed' }))
  }
})
