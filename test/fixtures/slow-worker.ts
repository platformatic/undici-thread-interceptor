import { MessageChannel, parentPort, threadId, workerData } from 'node:worker_threads'
import atomicSleep from 'atomic-sleep'

import { createServer } from '../../src/index.ts'

const { port1, port2 } = new MessageChannel()
let intervalCount = 0

const interval = setInterval(() => {
  intervalCount++
}, 10)

parentPort?.postMessage({ type: 'interval-port', port: port2 }, [port2])

port1.on('message', message => {
  if (message.type === 'get-interval-count') {
    port1.postMessage({ type: 'interval-count', count: intervalCount })
  }
  if (message.type === 'stop-interval') {
    clearInterval(interval)
  }
})

const server = createServer({
  meshId: workerData.meshId,
  coordinatorThreadId: workerData.coordinatorThreadId,
  serverId: workerData.serverId,
  domain: workerData.domain,
  server (req: any, res: any) {
    atomicSleep(Number.parseInt(req.headers['x-delay'] ?? '50'))
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ hello: 'world', threadId, timestamp: Date.now() }))
  }
})

await server.ready
parentPort?.postMessage({ type: 'ready', serverId: server.serverId })
