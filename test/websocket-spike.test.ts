// Phase 0 spike for WebSocket support (see PLAN.md): a real undici WebSocket
// client and a real ws server, connected through a MessagePort byte tunnel
// with hardcoded wiring instead of the mesh. Validates the MessagePortDuplex,
// the HTTP response-head parser, and the fake-socket handover on both sides.
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert'
import { randomFillSync } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type Server as HttpServer } from 'node:http'
import { test } from 'node:test'
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { Agent, WebSocket, type Dispatcher } from 'undici'
import { WebSocketServer } from 'ws'

import { HttpResponseHeadParser } from '../src/http-head-parser.ts'
import { MessagePortDuplex, toBufferChunk } from '../src/message-port-streams.ts'

class FakeSocket extends MessagePortDuplex {
  remoteAddress = '127.0.0.1'
  remotePort = 0

  setTimeout (): this {
    return this
  }

  setNoDelay (): this {
    return this
  }

  setKeepAlive (): this {
    return this
  }

  ref (): this {
    return this
  }

  unref (): this {
    return this
  }
}

function emitUpgrade (server: HttpServer, opts: Dispatcher.DispatchOptions, port: MessagePort): void {
  const socket = new FakeSocket({ port })
  // connection and upgrade are added at the wire level by undici's client, so
  // they are absent from the dispatch options and must be restored here.
  const headers: Record<string, unknown> = { connection: 'Upgrade', upgrade: 'websocket' }

  for (const [name, value] of Object.entries((opts.headers ?? {}) as Record<string, unknown>)) {
    headers[name.toLowerCase()] = value
  }

  const request = {
    method: opts.method,
    url: opts.path,
    headers,
    httpVersion: '1.1',
    socket,
    connection: socket
  }

  server.emit('upgrade', request, socket, Buffer.alloc(0))
}

function createSpikeInterceptor (
  wireServerSide: (opts: Dispatcher.DispatchOptions, port: MessagePort) => void
): Dispatcher.DispatcherComposeInterceptor {
  return dispatch => (opts, handler) => {
    if (!opts.upgrade) {
      return dispatch(opts, handler)
    }

    const { port1, port2 } = new MessageChannel()
    const parser = new HttpResponseHeadParser()
    const controller = {
      aborted: false,
      paused: false,
      reason: null as Error | null,
      rawHeaders: null as Buffer[] | null,
      abort (reason: Error) {
        this.aborted = true
        this.reason = reason
      },
      pause () {
        this.paused = true
      },
      resume () {
        this.paused = false
      }
    }

    const fail = (error: Error): void => {
      port1.off('message', onMessage)
      port1.close()
      handler.onResponseError?.(controller as any, error)
    }

    const onMessage = (control: { chunks?: unknown[]; fin?: boolean; err?: Error }): void => {
      if (control.err) {
        fail(control.err)
        return
      }

      if (control.fin) {
        fail(new Error('connection closed before response head'))
        return
      }

      if (!Array.isArray(control.chunks)) {
        return
      }

      try {
        for (let i = 0; i < control.chunks.length; i++) {
          const chunk = toBufferChunk(control.chunks[i])
          const head = parser.feed(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)

          if (!head) {
            continue
          }

          port1.off('message', onMessage)
          const socket = new MessagePortDuplex({ port: port1 })

          if (head.rest.length > 0) {
            socket.push(head.rest)
          }

          for (let j = i + 1; j < control.chunks.length; j++) {
            socket.push(toBufferChunk(control.chunks[j]))
          }

          controller.rawHeaders = head.rawHeaders
          handler.onRequestUpgrade?.(controller as any, head.statusCode, head.headers as any, socket)
          return
        }

        // Head still incomplete: grant write credit so the server keeps sending.
        port1.postMessage({ more: true })
      } catch (error) {
        fail(error as Error)
      }
    }

    port1.on('message', onMessage)
    wireServerSide(opts, port2)
    handler.onRequestStart?.(controller as any, {})
    return true
  }
}

function waitForOpen (ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', (event: any) => {
      reject(event.error ?? new Error(event.message ?? 'websocket error'))
    }, { once: true })
  })
}

interface EchoSetup {
  agent: Agent.ComposedDispatcher
  wss: WebSocketServer
}

function setupEcho (t: { after: (fn: () => unknown) => void }): EchoSetup {
  const httpServer = createServer()
  const wss = new WebSocketServer({ server: httpServer })

  wss.on('connection', socket => {
    socket.on('message', (data, isBinary) => socket.send(data as Buffer, { binary: isBinary }))
  })

  const agent = new Agent().compose(createSpikeInterceptor((opts, port) => emitUpgrade(httpServer, opts, port)))

  t.after(() => wss.close())
  t.after(() => agent.close())

  return { agent, wss }
}

test('websocket echo through a MessagePort tunnel', async t => {
  const { agent, wss } = setupEcho(t)

  const ws = new WebSocket('ws://myserver.local/echo', { dispatcher: agent })
  ws.binaryType = 'arraybuffer'
  await waitForOpen(ws)

  ws.send('hello')
  const [text] = await once(ws, 'message')
  strictEqual(text.data, 'hello')

  const payload = randomFillSync(Buffer.alloc(1024 * 1024))
  ws.send(payload)
  const [binary] = await once(ws, 'message')
  deepStrictEqual(Buffer.from(binary.data), payload)

  const serverSocket = [...wss.clients][0]
  const serverClosed = once(serverSocket, 'close')
  const closed = once(ws, 'close')
  ws.close(1000, 'done')

  const [closeEvent] = await closed
  strictEqual(closeEvent.code, 1000)
  strictEqual(closeEvent.reason, 'done')
  await serverClosed
})

test('websocket sustains many sequential messages with backpressure credits', async t => {
  const { agent } = setupEcho(t)

  const ws = new WebSocket('ws://myserver.local/echo', { dispatcher: agent })
  ws.binaryType = 'arraybuffer'
  await waitForOpen(ws)

  const total = 100
  const payload = randomFillSync(Buffer.alloc(16 * 1024))
  let received = 0

  const done = new Promise<void>((resolve, reject) => {
    ws.addEventListener('message', event => {
      try {
        deepStrictEqual(Buffer.from(event.data as ArrayBuffer), payload)
      } catch (error) {
        reject(error)
        return
      }

      if (++received === total) {
        resolve()
      }
    })
  })

  for (let i = 0; i < total; i++) {
    ws.send(payload)
  }

  await done
  strictEqual(received, total)

  const closed = once(ws, 'close')
  ws.close(1000)
  await closed
})

test('websocket server-initiated close reaches the client', async t => {
  const httpServer = createServer()
  const wss = new WebSocketServer({ server: httpServer })

  wss.on('connection', socket => {
    socket.close(4001, 'bye')
  })

  const agent = new Agent().compose(createSpikeInterceptor((opts, port) => emitUpgrade(httpServer, opts, port)))
  t.after(() => wss.close())
  t.after(() => agent.close())

  const ws = new WebSocket('ws://myserver.local/echo', { dispatcher: agent })
  await waitForOpen(ws)

  const [closeEvent] = await once(ws, 'close')
  strictEqual(closeEvent.code, 4001)
  strictEqual(closeEvent.reason, 'bye')
})

test('websocket subprotocol negotiation round-trips', async t => {
  const httpServer = createServer()
  const wss = new WebSocketServer({
    server: httpServer,
    handleProtocols: protocols => (protocols.has('chat.v2') ? 'chat.v2' : false)
  })

  wss.on('connection', socket => {
    socket.on('message', data => socket.send(data as Buffer))
  })

  const agent = new Agent().compose(createSpikeInterceptor((opts, port) => emitUpgrade(httpServer, opts, port)))
  t.after(() => wss.close())
  t.after(() => agent.close())

  const ws = new WebSocket('ws://myserver.local/echo', { protocols: ['chat.v1', 'chat.v2'], dispatcher: agent })
  await waitForOpen(ws)

  strictEqual(ws.protocol, 'chat.v2')

  const closed = once(ws, 'close')
  ws.close(1000)
  await closed
})

test('MessagePortDuplex moves bytes in both directions over one port', async () => {
  const channel = new MessageChannel()
  const alpha = new MessagePortDuplex({ port: channel.port1 })
  const beta = new MessagePortDuplex({ port: channel.port2 })

  const fromAlpha: Buffer[] = []
  const fromBeta: Buffer[] = []
  beta.on('data', chunk => fromAlpha.push(chunk))
  alpha.on('data', chunk => fromBeta.push(chunk))

  alpha.write('ping')
  beta.write('pong')
  alpha.end('!')

  await Promise.all([once(alpha, 'close'), once(beta, 'close')])

  deepStrictEqual(Buffer.concat(fromAlpha), Buffer.from('ping!'))
  deepStrictEqual(Buffer.concat(fromBeta), Buffer.from('pong'))
})

test('MessagePortDuplex propagates destroy errors to the other side', async () => {
  const channel = new MessageChannel()
  const alpha = new MessagePortDuplex({ port: channel.port1 })
  const beta = new MessagePortDuplex({ port: channel.port2 })

  const alphaError = once(alpha, 'error')
  alpha.destroy(new Error('kaboom'))

  const [error] = await once(beta, 'error')
  strictEqual(error.message, 'kaboom')
  strictEqual((await alphaError)[0].message, 'kaboom')
})

test('HttpResponseHeadParser handles heads split across arbitrary chunks', () => {
  const raw = Buffer.from(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Set-Cookie: a=1\r\n' +
      'Set-Cookie: b=2\r\n' +
      '\r\n' +
      'FRAMEBYTES'
  )

  for (const size of [1, 3, raw.length]) {
    const parser = new HttpResponseHeadParser()
    let head = null

    for (let offset = 0; offset < raw.length && !head; offset += size) {
      head = parser.feed(raw.subarray(offset, offset + size))
    }

    ok(head)
    strictEqual(head.statusCode, 101)
    strictEqual(head.statusMessage, 'Switching Protocols')
    strictEqual(head.headers.upgrade, 'websocket')
    deepStrictEqual(head.headers['set-cookie'], ['a=1', 'b=2'])

    if (size === raw.length) {
      deepStrictEqual(head.rest, Buffer.from('FRAMEBYTES'))
    }
  }
})

test('HttpResponseHeadParser rejects garbage and oversized heads', () => {
  throws(() => new HttpResponseHeadParser().feed(Buffer.from('NOT HTTP\r\n\r\n')), {
    code: 'UND_TI_INVALID_RESPONSE_HEAD'
  })

  throws(() => new HttpResponseHeadParser().feed(Buffer.from('HTTP/1.1 101 OK\r\nbroken\r\n\r\n')), {
    code: 'UND_TI_INVALID_RESPONSE_HEAD'
  })

  const parser = new HttpResponseHeadParser()
  throws(() => parser.feed(Buffer.alloc(17 * 1024, 'a')), {
    code: 'UND_TI_INVALID_RESPONSE_HEAD'
  })
})
