import { createServer as createHttpServer } from 'node:http'
import { parentPort, workerData } from 'node:worker_threads'
import { WebSocketServer } from 'ws'

import { createServer } from '../../src/index.ts'

const kind: string = workerData.kind ?? 'echo'

let target: any
let upgrade: (() => void) | undefined

if (kind === 'handler-only') {
  target = (_req: any, res: any) => {
    res.end('plain')
  }
} else if (kind === 'blackhole') {
  target = (_req: any, res: any) => {
    res.end('plain')
  }
  upgrade = () => {}
} else {
  const httpServer = createHttpServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ hello: 'http' }))
  })

  const wss = new WebSocketServer({
    server: httpServer,
    path: kind === 'path-restricted' ? '/ws' : undefined
  })

  wss.on('connection', socket => {
    socket.on('message', (data, isBinary) => {
      if (!isBinary && data.toString() === 'whoami') {
        socket.send(JSON.stringify({ serverId: server.serverId }))
        return
      }

      socket.send(data as Buffer, { binary: isBinary })
    })
  })

  target = httpServer
}

const server = createServer({
  meshId: workerData.meshId,
  coordinatorThreadId: workerData.coordinatorThreadId,
  serverId: workerData.serverId,
  domain: workerData.domain,
  server: target,
  paused: workerData.paused,
  upgrade,
  upgradeDrainTimeout: workerData.upgradeDrainTimeout
})

await server.ready
parentPort?.postMessage({ type: 'ready', serverId: server.serverId })

parentPort?.on('message', message => {
  if (message === 'close') {
    server.close().then(() => parentPort?.postMessage({ type: 'closed' }))
  }
})
