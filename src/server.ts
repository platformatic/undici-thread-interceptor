import inject from 'light-my-request'
import type { Readable } from 'node:stream'
import type { MessagePort } from 'node:worker_threads'
import { MessageChannel, threadId } from 'node:worker_threads'

import { channels } from './diagnostics.ts'
import { buildFakeRequest, FakeSocket, type FakeIncomingMessage } from './fake-socket.ts'
import { MessagePortDuplex, MessagePortReadable, MessagePortWritable } from './message-port-streams.ts'
import {
  MAX_BODY,
  Message,
  type CoordinatorConnectMessage,
  type MeshServer,
  type PeerConnectMessage,
  type RequestMessage,
  type ResponseMessage,
  type State,
  type UpgradeMessage
} from './protocol.ts'
import { createRequestQueue, type RequestQueue } from './request-queue.ts'
import { createId, normalizeHooks, normalizeOrigin, runHooks, sendThreadMessage, type Hooks } from './utils.ts'

export interface ServerOptions {
  meshId: string
  serverId?: string
  domain: string
  server: any
  paused?: boolean
  metadata?: unknown
  coordinatorThreadId?: number
  bootstrapTimeout?: number
  // Explicit HTTP upgrade handler. When omitted, upgrades are emitted on the
  // registered server's 'upgrade' event (or its .server property for Fastify).
  upgrade?: (req: FakeIncomingMessage, socket: FakeSocket, head: Buffer) => void
  onRequest?: Hooks<(req: any) => void>
  onResponse?: Hooks<(req: any, res: any) => void>
  onError?: Hooks<(req: any, res: any, error: Error) => void>
}

interface ServerHooks {
  onRequest: Array<(req: any) => void>
  onResponse: Array<(req: any, res: any) => void>
  onError: Array<(req: any, res: any, error: Error) => void>
}

interface QueuedRequest {
  port: MessagePort
  message: RequestMessage
  rejected: boolean
}

export class Server {
  readonly serverId: string
  readonly ready: Promise<void>

  #options: ServerOptions
  #hooks: ServerHooks
  #origin: string
  #port: MessagePort
  #server: any
  #metadata: unknown
  #state: State
  #peers: Map<MessagePort, string>
  #queue: RequestQueue<QueuedRequest>
  #activeRequests: Set<Promise<void>>
  #activeSockets: Set<FakeSocket>
  #closed: boolean
  #draining: boolean
  #boundWorkerMessageListener: (value: unknown) => void

  constructor (options: ServerOptions) {
    if (options.domain.includes('://') || /^[a-z][a-z0-9+.-]*:/i.test(options.domain)) {
      throw new Error('domain must not include a protocol')
    }

    this.serverId = options.serverId ?? createId()

    this.#options = options
    this.#hooks = {
      onRequest: normalizeHooks(options.onRequest),
      onResponse: normalizeHooks(options.onResponse),
      onError: normalizeHooks(options.onError)
    }
    this.#origin = normalizeOrigin(options.domain)
    this.#server = options.server
    this.#metadata = options.metadata
    this.#state = options.paused ? 'paused' : 'available'
    this.#peers = new Map()
    this.#queue = createRequestQueue(this.serverId, this.#processQueuedRequest.bind(this))
    this.#activeRequests = new Set()
    this.#activeSockets = new Set()
    this.#closed = false
    this.#draining = false
    this.#boundWorkerMessageListener = this.#onWorkerMessage.bind(this)

    const channel = new MessageChannel()
    this.#port = channel.port1
    this.#port.on('message', value => this.#onCoordinatorMessage(value))
    this.#port.start()

    process.on('workerMessage', this.#boundWorkerMessageListener)

    const coordinatorThreadId = options.coordinatorThreadId ?? 0
    const bootstrapTimeout = options.bootstrapTimeout ?? 100
    const connectMessage: CoordinatorConnectMessage = {
      type: Message.COORDINATOR_CONNECT,
      meshId: options.meshId,
      role: 'server' as const,
      threadId,
      port: channel.port2,
      metadata: this.#metadata,
      server: {
        id: this.serverId,
        origin: this.#origin,
        state: this.#state,
        mode: this.#getMode(),
        address: this.#getAddress()
      }
    }

    this.ready = sendThreadMessage(coordinatorThreadId, connectMessage, [channel.port2], bootstrapTimeout)
    this.ready.catch(error => runHooks(this.#hooks.onError, null, null, error as Error))
  }

  pause (): void {
    if (this.#closed || this.#state === 'paused') {
      return
    }

    this.#state = 'paused'
    this.#update()
  }

  resume (): void {
    if (this.#closed || this.#state === 'available') {
      return
    }

    this.#state = 'available'
    this.#update()
  }

  async close (): Promise<void> {
    if (this.#closed) {
      return
    }

    this.#closed = true
    this.#draining = true
    this.#state = 'closed'
    this.#port.postMessage({ type: Message.SERVER_LEAVE, meshId: this.#options.meshId, serverId: this.serverId })
    this.#port.close()

    await this.#queue.drained()
    await Promise.allSettled(this.#activeRequests)

    for (const socket of this.#activeSockets) {
      socket.destroy(new Error('server closed'))
    }
    this.#activeSockets.clear()

    this.#draining = false

    process.off('workerMessage', this.#boundWorkerMessageListener)
  }

  replaceServer (server: any): void {
    if (server == null) {
      if (this.#getMode() === 'tcp') {
        return
      }

      throw new Error('server argument is required')
    }

    this.#server = server
    this.#update()
  }

  updateMetadata (metadata: unknown): void {
    this.#metadata = metadata
    this.#update()
  }

  addPeer (port: MessagePort, interceptorId = 'unknown'): void {
    if (this.#peers.has(port)) {
      return
    }

    const diagnostics = {
      meshId: this.#options.meshId,
      origin: this.#origin,
      interceptorId,
      serverId: this.serverId,
      role: 'server',
      threadId
    }

    this.#peers.set(port, interceptorId)
    port.on('message', value => this.#onPeerMessage(port, value))
    port.on('close', () => {
      const interceptorId = this.#peers.get(port)
      if (!interceptorId) {
        return
      }
      this.#peers.delete(port)
      if (channels.peerDisconnect.hasSubscribers) {
        channels.peerDisconnect.publish(diagnostics)
      }
    })
    port.start()

    if (channels.peerConnect.hasSubscribers) {
      channels.peerConnect.publish(diagnostics)
    }
  }

  #update (): void {
    this.#port.postMessage({
      type: Message.SERVER_UPDATE,
      meshId: this.#options.meshId,
      serverId: this.serverId,
      origin: this.#origin,
      state: this.#state,
      metadata: this.#metadata,
      mode: this.#getMode(),
      address: this.#getAddress()
    })
  }

  #getMode (): MeshServer['mode'] {
    return typeof this.#server === 'string' || this.#server instanceof URL ? 'tcp' : 'thread'
  }

  #getAddress (): string | undefined {
    return typeof this.#server === 'string' || this.#server instanceof URL ? String(this.#server) : undefined
  }

  #onCoordinatorMessage (value: unknown): void {
    const message = value as { type?: string }

    switch (message.type) {
      case Message.PAUSE:
        this.pause()
        break
      case Message.RESUME:
        this.resume()
        break
      case Message.CLOSE:
        this.close().catch(error => runHooks(this.#hooks.onError, null, null, error as Error))
        break
    }
  }

  #onPeerMessage (port: MessagePort, value: unknown): void {
    const message = value as { type?: string }

    if (message.type === Message.PEER_DISCONNECT) {
      /* c8 ignore next - else */
      const interceptorId = this.#peers.get(port) ?? 'unknown'
      this.#peers.delete(port)

      if (channels.peerDisconnect.hasSubscribers) {
        channels.peerDisconnect.publish({
          meshId: this.#options.meshId,
          origin: this.#origin,
          interceptorId,
          serverId: this.serverId,
          role: 'server',
          threadId
        })
      }

      port.close()
      return
    }

    if (message.type === Message.UPGRADE) {
      // Upgrades bypass the request queue: it exists for fairness of
      // short-lived work, and a long-lived connection would distort it.
      this.#handleUpgrade(value as UpgradeMessage)
      return
    }

    if (message.type !== Message.REQUEST) {
      return
    }

    this.#queue.push({ port, message: value as RequestMessage, rejected: this.#closed })
  }

  #handleUpgrade (message: UpgradeMessage): void {
    if (this.#closed || this.#state !== 'available' || !this.#server || this.#getMode() === 'tcp') {
      this.#rejectUpgradeInBand(message.socketPort, 503, 'Service Unavailable')
      return
    }

    const emitter = this.#resolveUpgradeEmitter()

    if (!emitter) {
      this.#rejectUpgradeInBand(message.socketPort, 501, 'Not Implemented')
      return
    }

    const socket = new FakeSocket({ port: message.socketPort })
    // Guard against 'error' with no listeners attached yet, which would
    // otherwise crash the thread; upgrade consumers add their own listeners.
    socket.on('error', () => {})
    this.#activeSockets.add(socket)
    socket.on('close', () => this.#activeSockets.delete(socket))

    const headers: Record<string, string | string[]> = {
      connection: 'Upgrade',
      upgrade: message.protocol
    }

    for (const [name, value] of Object.entries(message.headers)) {
      if (value !== undefined && value !== null) {
        headers[name.toLowerCase()] = Array.isArray(value) ? value : String(value)
      }
    }

    const req = buildFakeRequest(message.method, message.path, headers, socket)
    const head = message.head ? Buffer.from(message.head.buffer, message.head.byteOffset, message.head.byteLength) : Buffer.alloc(0)

    try {
      runHooks(this.#hooks.onRequest, req)
      emitter(req, socket, head)
    } catch (error) {
      runHooks(this.#hooks.onError, req, null, error as Error)
      socket.destroy(error as Error)
    }
  }

  #resolveUpgradeEmitter (): ((req: FakeIncomingMessage, socket: FakeSocket, head: Buffer) => void) | null {
    if (this.#options.upgrade) {
      return this.#options.upgrade
    }

    const target = this.#server

    if (typeof target?.emit === 'function' && typeof target?.listenerCount === 'function' && target.listenerCount('upgrade') > 0) {
      return (req, socket, head) => target.emit('upgrade', req, socket, head)
    }

    // Fastify exposes its http.Server (where @fastify/websocket listens) as .server.
    const inner = target?.server

    if (typeof inner?.emit === 'function' && typeof inner?.listenerCount === 'function' && inner.listenerCount('upgrade') > 0) {
      return (req, socket, head) => inner.emit('upgrade', req, socket, head)
    }

    return null
  }

  #rejectUpgradeInBand (port: MessagePort, statusCode: number, statusMessage: string): void {
    // The response travels through the socket port as raw HTTP bytes, the
    // same way a real server would answer before hanging up.
    const socket = new MessagePortDuplex({ port })
    socket.on('error', () => {})
    socket.resume()
    // Hang up once the rejection has been flushed, like a real server would.
    socket.once('finish', () => socket.destroy())
    socket.end(`HTTP/1.1 ${statusCode} ${statusMessage}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
  }

  #processQueuedRequest ({ port, message, rejected }: QueuedRequest): void {
    const request = this.#handleRequest(port, message, rejected)
    this.#activeRequests.add(request)

    request
      .catch(error => {
        port.postMessage({ type: Message.ERROR, id: message.id, error })
      })
      .finally(() => {
        this.#activeRequests.delete(request)
      })
  }

  async #handleRequest (port: MessagePort, message: RequestMessage, rejected: boolean): Promise<void> {
    if (rejected || (!this.#draining && this.#state !== 'available') || !this.#server || this.#getMode() === 'tcp') {
      port.postMessage({
        type: Message.RESPONSE,
        id: message.id,
        statusCode: 503,
        statusMessage: 'Service Unavailable',
        headers: {},
        body: Buffer.alloc(0)
      })

      return
    }

    const body = message.bodyPort ? new MessagePortReadable({ port: message.bodyPort }) : message.body
    const headers: Record<string, string | string[] | number> = {}

    for (const [key, value] of Object.entries(message.headers)) {
      if (value !== undefined && value !== null) {
        headers[key] = value
      }
    }

    const req = {
      method: message.method,
      url: message.path,
      headers,
      query: message.query,
      body: !Buffer.isBuffer(body) && body instanceof Uint8Array ? Buffer.from(body) : body,
      payloadAsStream: true
    }

    if (channels.serverRequestStart.hasSubscribers) {
      channels.serverRequestStart.publish({ request: req, server: this.#server })
    }

    await new Promise<void>(resolve => {
      let completed = false
      const next = () => {
        const onInject = async (error: Error | undefined, res: any) => {
          if (completed) {
            return
          }
          completed = true

          if (error) {
            runHooks(this.#hooks.onError, req, res, error)
            port.postMessage({ type: Message.ERROR, id: message.id, error })
            resolve()
            return
          }

          try {
            runHooks(this.#hooks.onResponse, req, res)
            await this.#sendResponse(port, message.id, res)
            if (channels.serverResponseFinish.hasSubscribers) {
              channels.serverResponseFinish.publish({ request: req, response: res, server: this.#server })
            }
          } catch (error) {
            runHooks(this.#hooks.onError, req, res, error as Error)
            port.postMessage({ type: Message.ERROR, id: message.id, error })
          }
          resolve()
        }

        if (typeof this.#server?.inject === 'function') {
          this.#server.inject(req, onInject)
        } else {
          inject(this.#server, req as any, onInject)
        }
      }

      runHooks(this.#hooks.onRequest, req)
      next()
    })
  }

  #onWorkerMessage (value: unknown): void {
    const message = value as Partial<PeerConnectMessage>
    if (message?.type !== Message.PEER_CONNECT || message.serverId !== this.serverId || !message.port) {
      return
    }

    this.addPeer(message.port, message.interceptorId)
  }

  async #sendResponse (port: MessagePort, id: string, res: any): Promise<void> {
    const headers = res.headers ?? {}
    const message: ResponseMessage = {
      type: Message.RESPONSE,
      id,
      statusCode: res.statusCode,
      statusMessage: res.statusMessage,
      headers
    }
    const contentLength = headers['content-length']
    const length = contentLength === undefined ? undefined : Number(contentLength)
    const transferList: MessagePort[] = []

    if (length !== undefined && length >= 0 && length < MAX_BODY) {
      message.body = await this.#collectBody(res.stream())
    } else {
      const transferable = MessagePortWritable.asTransferable(res.stream())
      message.bodyPort = transferable.port
      transferList.push(...transferable.transferList)
    }

    port.postMessage(message, transferList)
  }

  async #collectBody (stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = []

    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }

    return Buffer.concat(chunks)
  }
}

export function createServer (options: ServerOptions): Server {
  return new Server(options)
}
