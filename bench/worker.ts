import { parentPort, workerData } from 'node:worker_threads'

import { createServer } from '../src/index.ts'

const server = createServer({
  meshId: workerData.meshId,
  coordinatorThreadId: workerData.coordinatorThreadId,
  serverId: workerData.serverId,
  domain: workerData.domain,
  server (_req: any, res: any) {
    res.setHeader('content-type', 'application/json')
    res.end('{"hello":"world"}')
  }
})

await server.ready
parentPort?.postMessage({ type: 'ready' })

parentPort?.on('message', message => {
  if (message === 'close') {
    server.close().then(() => parentPort?.postMessage({ type: 'closed' }))
  }
})
