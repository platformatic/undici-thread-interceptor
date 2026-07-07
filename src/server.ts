import inject from 'light-my-request'
import type { Readable } from 'node:stream'
import type { MessagePort } from 'node:worker_threads'
import { MessageChannel, threadId } from 'node:worker_threads'

import { channels } from './diagnostics.ts'
import { MessagePortReadable, MessagePortWritable } from './message-port-streams.ts'
import {
  MAX_BODY,
  Message,
  type CoordinatorConnectMessage,
  type MeshServer,
  type PeerConnectMessage,
  type RequestMessage,
  type ResponseMessage,
  type State
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

    if (message.type !== Message.REQUEST) {
      return
    }

    this.#queue.push({ port, message: value as RequestMessage, rejected: this.#closed })
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
