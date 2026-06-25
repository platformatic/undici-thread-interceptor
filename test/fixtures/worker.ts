import diagnosticsChannel from 'node:diagnostics_channel'
import { Readable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { parentPort, threadId, workerData } from 'node:worker_threads'
import express from 'express'
import Koa from 'koa'

import { createServer } from '../../src/index.ts'

let gracefulCloseActiveRequests = 0

if (workerData.diagnostics) {
  for (const [channelName, type] of [
    ['undici-thread-interceptor:peer:connect', 'peer:connect'],
    ['undici-thread-interceptor:peer:disconnect', 'peer:disconnect']
  ] as const) {
    diagnosticsChannel.channel(channelName).subscribe(message => {
      parentPort?.postMessage({ type: 'diagnostics', channel: type, message })
    })
  }
}

function basicApp (req: any, res: any): void {
  if (req.url === '/error') {
    throw new Error('kaboom')
  }

  if (req.url === '/buffer') {
    res.setHeader('content-length', '5')
    res.end('hello')
    return
  }

  if (req.url === '/binary') {
    const payload = Buffer.from([0, 1, 2, 3, 255])
    res.setHeader('content-length', String(payload.length))
    res.end(payload)
    return
  }

  if (req.url === '/no-headers') {
    res.end('text')
    return
  }

  if (req.url === '/empty') {
    res.setHeader('content-length', '0')
    res.end()
    return
  }

  if (req.url === '/empty-stream') {
    Readable.from([]).pipe(res)
    return
  }

  if (req.url === '/stream-error-2') {
    res.on('error', () => {})
    const stream = new Readable({ read () {} })
    stream.on('error', error => {
      try {
        res.destroy(error)
      } catch {}
    })
    stream.pipe(res)
    stream.push('hello')
    setImmediate(() => stream.destroy(new Error('kaboom')))
    return
  }

  if (req.url === '/echo-headers') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.headers))
    return
  }

  if (req.url === '/echo-query') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.query))
    return
  }

  if (req.url === '/echo-body') {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      res.setHeader('content-type', req.headers['content-type'] ?? 'text/plain')
      res.end(Buffer.concat(chunks))
    })
    req.on('error', (error: Error) => {
      res.statusCode = 400
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ statusCode: 400, error: 'Bad Request', message: error.message }))
    })
    return
  }

  if (req.url === '/whoami') {
    if (workerData.whoamiReturn503) {
      res.statusCode = 503
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ threadId }))
      return
    }

    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ threadId }))
    return
  }

  if (req.url === '/unfinished-business') {
    return
  }

  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ hello: workerData?.message ?? 'world' }))
}

function createApp (): any {
  if (workerData.kind === 'express') {
    const app = express()
    app.get('/', (_req: any, res: any) => res.json({ hello: 'world' }))
    return app
  }

  if (workerData.kind === 'koa') {
    const app = new Koa()
    app.use((ctx: any) => {
      ctx.body = { hello: 'world' }
    })
    return app.callback()
  }

  if (workerData.kind === 'server-hooks') {
    return function app (_req: any, res: any) {
      res.end('ok')
    }
  }

  if (workerData.kind === 'server-hook-arrays') {
    return function app (_req: any, res: any) {
      res.end('ok')
    }
  }

  if (workerData.kind === 'server-error-hooks') {
    return function app (_req: any, res: any) {
      res.destroy(new Error('kaboom'))
    }
  }

  if (workerData.kind === 'graceful-close') {
    return async function app (req: any, res: any) {
      if (req.url === '/ping') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: true }))
        return
      }

      gracefulCloseActiveRequests++
      parentPort?.postMessage({ type: 'graceful-close-active', count: gracefulCloseActiveRequests })
      await sleep(300)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ delayed: true }))
    }
  }

  return basicApp
}

let onRequest
let onResponse
let onError

if (workerData.kind === 'server-hooks') {
  onRequest = req => {
    parentPort?.postMessage({ type: 'hook', value: `request:${req.url}` })
  }
  onResponse = req => {
    parentPort?.postMessage({ type: 'hook', value: `response:${req.url}` })
  }
}

if (workerData.kind === 'server-hook-arrays') {
  onRequest = [
    req => {
      req.hookValue = 'first'
      parentPort?.postMessage({ type: 'hook', value: `request:first:${req.url}` })
    },
    req => {
      parentPort?.postMessage({ type: 'hook', value: `request:second:${req.hookValue as string}` })
    }
  ]
  onResponse = [
    req => {
      parentPort?.postMessage({ type: 'hook', value: `response:first:${req.hookValue as string}` })
    },
    req => {
      parentPort?.postMessage({ type: 'hook', value: `response:second:${req.hookValue as string}` })
    }
  ]
}

if (workerData.kind === 'server-error-hooks') {
  onError = [
    (_req, _res, error) => {
      parentPort?.postMessage({ type: 'hook', value: `error:first:${error.message}` })
    },
    (_req, _res, error) => {
      parentPort?.postMessage({ type: 'hook', value: `error:second:${error.message}` })
    }
  ]
}

const server = createServer({
  meshId: workerData.meshId,
  coordinatorThreadId: workerData.coordinatorThreadId,
  serverId: workerData.serverId,
  domain: workerData.domain,
  server: createApp(),
  paused: workerData.paused,
  onRequest,
  onResponse,
  onError
})

await server.ready
parentPort?.postMessage({ type: 'ready', serverId: server.serverId })

parentPort?.on('message', message => {
  if (message === 'pause') {
    server.pause()
  }
  if (message === 'resume') {
    server.resume()
  }
  if (message === 'close') {
    server.close().then(() => parentPort?.postMessage({ type: 'closed' }))
  }
  if (message === 'replace-server') {
    server.replaceServer((_req: any, res: any) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ hello: 'replaced' }))
    })
    parentPort?.postMessage({ type: 'replaced' })
  }
  if (message === 'replace-server-invalid') {
    try {
      server.replaceServer(undefined)
    } catch (error) {
      parentPort?.postMessage({ type: 'replace-error', message: (error as Error).message })
    }
  }
})
