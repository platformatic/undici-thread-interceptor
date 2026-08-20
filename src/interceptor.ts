import hyperid from 'hyperid'
import { AsyncResource } from 'node:async_hooks'
import { Agent as HttpAgent } from 'node:http'
import { connect as netConnect } from 'node:net'
import type { Duplex, Readable } from 'node:stream'
import type { MessagePort } from 'node:worker_threads'
import { MessageChannel, threadId } from 'node:worker_threads'
import type { Dispatcher } from 'undici'

import {
  channels,
  getWrappedRequest,
  kWrappedRequest,
  publishRequestHeaders,
  type PeerDiagnosticsPayload
} from './diagnostics.ts'
import { ConnectTimeoutError, NoAvailableTargetError } from './errors.ts'
import { FakeSocket } from './fake-socket.ts'
import {
  HttpRequestHeadParser,
  HttpResponseHeadParser,
  type ParsedRequestHead,
  type ParsedResponseHead
} from './http-head-parser.ts'
import { MessagePortDuplex, MessagePortReadable, MessagePortWritable, toBufferChunk } from './message-port-streams.ts'
import {
  Message,
  type CoordinatorConnectMessage,
  type ErrorMessage,
  type Mesh,
  type MeshServer,
  type PeerConnectMessage,
  type RequestMessage,
  type ResponseMessage,
  type UpgradeMessage
} from './protocol.ts'
import {
  createId,
  executeWithTimeout,
  kTimeout,
  normalizeHooks,
  normalizeOrigin,
  runHooks,
  sanitizeHeaders,
  sendThreadMessage,
  type Hooks
} from './utils.ts'

export interface InterceptorOptions {
  meshId: string
  interceptorId?: string
  domain?: string
  connectTimeout?: number
  coordinatorThreadId?: number
  bootstrapTimeout?: number
  metadata?: unknown
  onRequest?: Hooks<(req: any, ctx: Record<PropertyKey, unknown>) => void>
  allowTarget?: Hooks<(req: any, target: MeshServer, ctx: Record<PropertyKey, unknown>) => boolean | void>
  onResponse?: Hooks<(req: any, res: any, ctx: Record<PropertyKey, unknown>) => void>
  onResponseEnd?: Hooks<(req: any, res: any, ctx: Record<PropertyKey, unknown>) => void>
  onError?: Hooks<(req: any, res: any, ctx: Record<PropertyKey, unknown>, error: Error) => void>
}

interface InterceptorHooks {
  onRequest: Array<(req: any, ctx: Record<PropertyKey, unknown>) => void>
  allowTarget: Array<(req: any, target: MeshServer, ctx: Record<PropertyKey, unknown>) => boolean | void>
  onResponse: Array<(req: any, res: any, ctx: Record<PropertyKey, unknown>) => void>
  onResponseEnd: Array<(req: any, res: any, ctx: Record<PropertyKey, unknown>) => void>
  onError: Array<(req: any, res: any, ctx: Record<PropertyKey, unknown>, error: Error) => void>
}

export interface InterceptorFunction extends Dispatcher.DispatcherComposeInterceptor {
  interceptorId: string
  ready: Promise<void>
  close: () => void
  updateMetadata: (metadata: unknown) => void
  getMesh: () => Mesh | null
  createUpgradeAgent: () => HttpAgent
}

type Dispatch = Dispatcher.Dispatch
type DispatchOptions = Dispatcher.DispatchOptions
type DispatchHandler = Dispatcher.DispatchHandler

interface PendingRequest {
  request: DispatchOptions
  handler: DispatchHandler
  context: Record<PropertyKey, unknown>
  controller: any
  resolve: () => void
  reject: (error: Error) => void
  onMessage: (value: unknown) => void
  pauseResponse?: () => void
  resumeResponse?: () => void
  abortResponse?: (reason: Error) => void
}

interface Peer {
  port: MessagePort
  pending: Map<string, PendingRequest>
  tunnels: Set<MessagePortDuplex>
  closed: boolean
  diagnostics: PeerDiagnosticsPayload
  // Highest dispatchIndex assigned to a message sent on this peer.
  lastDispatchIndex: number
  draining: boolean
}

interface UpgradeController {
  aborted: boolean
  paused: boolean
  reason: Error | null
  // Undici's fetch layer builds the response HeadersList exclusively from
  // controller.rawHeaders, so the parsed head must be exposed here.
  rawHeaders: Buffer[] | null
  abort: (reason: Error) => void
  pause: () => void
  resume: () => void
}

class HookHandler {
  #handler: DispatchHandler
  #hooks: InterceptorHooks
  #request: DispatchOptions
  #context: Record<PropertyKey, unknown>
  #statusCode: number | undefined

  constructor (
    handler: DispatchHandler,
    hooks: InterceptorHooks,
    request: DispatchOptions,
    context: Record<PropertyKey, unknown>
  ) {
    this.#handler = handler
    this.#hooks = hooks
    this.#request = request
    this.#context = context
  }

  onRequestStart (controller: any, context: any): void {
    this.#handler.onRequestStart?.(controller, context)
  }

  onResponseStart (controller: any, statusCode: number, headers: any, statusMessage?: string): void {
    this.#statusCode = statusCode
    const response = { statusCode, headers, statusMessage }
    runHooks(this.#hooks.onResponse, this.#request, response, this.#context)
    this.#handler.onResponseStart?.(controller, statusCode, headers, statusMessage)
  }

  onResponseData (controller: any, chunk: Buffer): void {
    this.#handler.onResponseData?.(controller, chunk)
  }

  onResponseEnd (controller: any, trailers: any): void {
    runHooks(this.#hooks.onResponseEnd, this.#request, { statusCode: this.#statusCode }, this.#context)
    this.#handler.onResponseEnd?.(controller, trailers)
  }

  onResponseError (controller: any, error: Error): void {
    runHooks(this.#hooks.onError, this.#request, null, this.#context, error)
    this.#handler.onResponseError?.(controller, error)
  }

  onRequestUpgrade (controller: any, statusCode: number, headers: any, socket: any): void {
    runHooks(this.#hooks.onResponse, this.#request, { statusCode, headers }, this.#context)
    this.#handler.onRequestUpgrade?.(controller, statusCode, headers, socket)
  }
}

function respondInBand (port: MessagePort, statusCode: number, statusMessage: string): void {
  port.postMessage({
    chunks: [Buffer.from(`HTTP/1.1 ${statusCode} ${statusMessage}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)]
  })
  port.postMessage({ fin: true })
  setImmediate(() => port.close())
}

function isStreamBody (body: unknown): body is Readable {
  return (
    typeof (body as Readable)?.pipe === 'function' ||
    typeof (body as AsyncIterable<unknown>)?.[Symbol.asyncIterator] === 'function'
  )
}

export function createInterceptor (options: InterceptorOptions): InterceptorFunction {
  return new Interceptor(options).asFunction()
}

export class Interceptor {
  readonly interceptorId: string
  readonly ready: Promise<void>

  #options: InterceptorOptions
  #hooks: InterceptorHooks
  #domain?: string
  #connectTimeout: number
  #port: MessagePort
  #mesh: Mesh | null
  #cursors: Map<string, number>
  #peers: Map<string, Peer>
  #requestId: () => string
  #closed: boolean

  constructor (options: InterceptorOptions) {
    this.#options = options
    this.#hooks = {
      onRequest: normalizeHooks(options.onRequest),
      allowTarget: normalizeHooks(options.allowTarget),
      onResponse: normalizeHooks(options.onResponse),
      onResponseEnd: normalizeHooks(options.onResponseEnd),
      onError: normalizeHooks(options.onError)
    }
    this.interceptorId = options.interceptorId ?? createId()
    this.#domain = options.domain?.toLowerCase()
    this.#connectTimeout = options.connectTimeout ?? 5000
    this.#mesh = null
    this.#cursors = new Map()
    this.#peers = new Map()
    this.#requestId = hyperid()
    this.#closed = false

    const channel = new MessageChannel()
    this.#port = channel.port1
    this.#port.on('message', value => this.#onCoordinatorMessage(value))
    this.#port.start()

    const coordinatorThreadId = options.coordinatorThreadId ?? 0
    const bootstrapTimeout = options.bootstrapTimeout ?? 100
    const connectMessage: CoordinatorConnectMessage = {
      type: Message.COORDINATOR_CONNECT,
      meshId: options.meshId,
      role: 'interceptor' as const,
      threadId,
      port: channel.port2,
      metadata: options.metadata,
      interceptor: {
        id: this.interceptorId
      }
    }

    this.ready = sendThreadMessage(coordinatorThreadId, connectMessage, [channel.port2], bootstrapTimeout)
    this.ready.catch(error => runHooks(this.#hooks.onError, null, null, {}, error as Error))
  }

  asFunction (): InterceptorFunction {
    const fn = ((dispatch: Dispatch): Dispatch => {
      return (opts: DispatchOptions, handler: DispatchHandler): boolean => this.dispatch(dispatch, opts, handler)
    }) as InterceptorFunction

    fn.interceptorId = this.interceptorId
    fn.ready = this.ready
    fn.close = this.close.bind(this)
    fn.updateMetadata = this.updateMetadata.bind(this)
    fn.getMesh = this.getMesh.bind(this)
    fn.createUpgradeAgent = this.createUpgradeAgent.bind(this)
    return fn
  }

  getMesh (): Mesh | null {
    return this.#mesh
  }

  close (): void {
    if (this.#closed) {
      return
    }

    this.#closed = true
    this.#port.postMessage({
      type: Message.INTERCEPTOR_LEAVE,
      meshId: this.#options.meshId,
      interceptorId: this.interceptorId
    })
    this.#port.close()

    for (const peer of this.#peers.values()) {
      peer.port.postMessage({ type: Message.PEER_DISCONNECT })
      peer.port.close()
    }
  }

  updateMetadata (metadata: unknown): void {
    this.#port.postMessage({
      type: Message.INTERCEPTOR_UPDATE,
      meshId: this.#options.meshId,
      interceptorId: this.interceptorId,
      metadata
    })
  }

  dispatch (dispatch: Dispatch, opts: DispatchOptions, handler: DispatchHandler): boolean {
    if (!opts.origin) {
      return dispatch(opts, handler)
    }

    /* c8 ignore next - else */
    const url = opts.origin instanceof URL ? opts.origin : new URL(opts.path, opts.origin)
    const key = normalizeOrigin(url)

    if (this.#domain === undefined || !url.hostname.toLowerCase().endsWith(this.#domain)) {
      return dispatch(opts, handler)
    }

    const meshOrigin = this.#mesh?.origins[key]
    if (!meshOrigin) {
      return dispatch(opts, handler)
    }

    if (opts.method === 'CONNECT') {
      throw new Error('CONNECT is not supported for mesh targets')
    }

    const context: Record<PropertyKey, unknown> = {}
    const request = {
      ...opts,
      headers: sanitizeHeaders(opts.headers as any, url.host)
    } as DispatchOptions
    runHooks(this.#hooks.onRequest, request, context)

    const server = this.#selectServer(key, meshOrigin.servers, request, context, Boolean(opts.upgrade))
    if (!server) {
      throw new NoAvailableTargetError(key)
    }

    if (server.mode === 'tcp') {
      return dispatch(
        { ...request, origin: server.address } as DispatchOptions,
        new HookHandler(handler, this.#hooks, request, context)
      )
    }

    if (opts.upgrade) {
      this.#dispatchUpgradeViaMessagePort(server, url, request, context, handler).catch(error => {
        this.#publishRequestError(request, context, error as Error)
        runHooks(this.#hooks.onError, request, null, context, error as Error)
        handler.onResponseError?.(null as any, error as Error)
      })

      return true
    }

    if (channels.requestCreate.hasSubscribers) {
      channels.requestCreate.publish({ request: getWrappedRequest(request, context) })
    }

    this.#dispatchViaMessagePort(server, url, request, context, handler).catch(error => {
      this.#publishRequestError(request, context, error as Error)
      runHooks(this.#hooks.onError, request, null, context, error as Error)
      handler.onResponseError?.(null as any, error as Error)
    })

    return true
  }

  #onCoordinatorMessage (value: unknown): void {
    const message = value as { type?: string; mesh?: Mesh }

    /* c8 ignore next 3 - hard to test */
    if (message.type !== Message.MESH || !message.mesh) {
      return
    }

    /* c8 ignore next 3 - hard to test */
    if (this.#mesh && message.mesh.version <= this.#mesh.version) {
      return
    }

    this.#mesh = message.mesh
    this.#cursors.clear()
  }

  #selectServer (
    origin: string,
    serverIds: string[],
    request: DispatchOptions,
    context: Record<PropertyKey, unknown>,
    needsUpgrade = false
  ): MeshServer | null {
    const cursor = this.#cursors.get(origin) ?? Math.floor(Math.random() * serverIds.length)

    for (let i = 0; i < serverIds.length; i++) {
      const index = (cursor + i) % serverIds.length
      const server = this.#mesh?.servers[serverIds[index]]

      if (
        server?.state === 'available' &&
        (!needsUpgrade || server.capabilities?.upgrade !== false) &&
        this.#isTargetAllowed(request, server, context)
      ) {
        this.#cursors.set(origin, (index + 1) % serverIds.length)
        return server
      }
    }

    return null
  }

  async #dispatchViaMessagePort (
    server: Extract<MeshServer, { mode: 'thread' }>,
    url: URL,
    request: DispatchOptions,
    context: Record<PropertyKey, unknown>,
    handler: DispatchHandler
  ): Promise<void> {
    const peer = await this.#ensurePeerMessagePort(server)
    const id = this.#requestId()
    const { promise: responsePromise, resolve, reject } = Promise.withResolvers<void>()

    const pending: PendingRequest = {
      request,
      handler,
      context,
      controller: {
        aborted: false,
        paused: false,
        reason: null as Error | null,
        abort (reason: Error) {
          this.aborted = true
          this.reason = reason
          pending.abortResponse?.(reason)
        },
        pause () {
          this.paused = true
          pending.pauseResponse?.()
        },
        resume () {
          this.paused = false
          pending.resumeResponse?.()
        }
      },
      resolve,
      reject,
      onMessage: AsyncResource.bind((value: unknown) => this.#handlePeerMessage(pending, value))
    }
    peer.pending.set(id, pending)

    let responseTimeout: ReturnType<typeof setTimeout> | null = null
    if (this.#connectTimeout > 0) {
      responseTimeout = setTimeout(() => {
        peer.pending.delete(id)
        pending.reject(new ConnectTimeoutError(`Timeout while waiting for response from ${server.serverId}.`))
      }, this.#connectTimeout)
    }
    responseTimeout?.unref()

    const message: RequestMessage = {
      type: Message.REQUEST,
      id,
      dispatchIndex: ++peer.lastDispatchIndex,
      meshId: this.#options.meshId,
      interceptorId: this.interceptorId,
      origin: server.origin,
      path: url.pathname + url.search,
      method: request.method,
      headers: request.headers as Record<string, string | string[] | number | undefined>
    }
    const transferList: MessagePort[] = []

    if (request.body) {
      if (isStreamBody(request.body)) {
        const transferable = MessagePortWritable.asTransferable(request.body)
        message.bodyPort = transferable.port
        transferList.push(...transferable.transferList)
      } else {
        message.body = request.body as RequestMessage['body']
      }
    }

    if ((request as any).query !== undefined) {
      message.query = (request as any).query
    }

    try {
      handler.onRequestStart?.(pending.controller as any, {})
      peer.port.postMessage(message, transferList)
      await responsePromise
    } catch (error) {
      peer.pending.delete(id)
      throw error
    } finally {
      if (responseTimeout !== null) {
        clearTimeout(responseTimeout)
      }
    }
  }

  async #dispatchUpgradeViaMessagePort (
    server: Extract<MeshServer, { mode: 'thread' }>,
    url: URL,
    request: DispatchOptions,
    context: Record<PropertyKey, unknown>,
    handler: DispatchHandler
  ): Promise<void> {
    const peer = await this.#ensurePeerMessagePort(server)
    const id = this.#requestId()
    const channel = new MessageChannel()
    const { promise, resolve, reject } = Promise.withResolvers<void>()

    const controller: UpgradeController = {
      aborted: false,
      paused: false,
      reason: null,
      rawHeaders: null,
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

    const parser = new HttpResponseHeadParser()
    let head: ParsedResponseHead | null = null
    let replaying = false
    let settled = false
    let responseTimeout: ReturnType<typeof setTimeout> | null = null

    const upgradeDiagnostics = {
      meshId: this.#options.meshId,
      origin: server.origin,
      interceptorId: this.interceptorId,
      serverId: server.serverId,
      method: request.method,
      path: url.pathname + url.search
    }

    const finish = (error?: Error): void => {
      if (settled) {
        return
      }

      settled = true
      peer.pending.delete(id)

      if (responseTimeout !== null) {
        clearTimeout(responseTimeout)
      }

      if (error) {
        channel.port1.close()
        reject(error)
      } else {
        resolve()
      }
    }

    const endReplay = (): void => {
      try {
        handler.onResponseEnd?.(controller as any, {})
      } catch (error) {
        finish(error as Error)
        return
      }

      runHooks(this.#hooks.onResponseEnd, request, { statusCode: head?.statusCode }, context)
      channel.port1.close()
      finish()
    }

    const onPortClose = (): void => {
      if (settled) {
        return
      }

      if (replaying) {
        // Connection-close terminated response body.
        endReplay()
      } else {
        finish(new Error('connection closed before response head'))
      }
    }

    const establish = (parsedHead: ParsedResponseHead, remainingChunks: unknown[]): void => {
      channel.port1.off('message', onPortMessage)
      channel.port1.off('close', onPortClose)

      const socket = new MessagePortDuplex({ port: channel.port1 })

      if (parsedHead.rest.length > 0) {
        socket.push(parsedHead.rest)
      }

      for (const chunk of remainingChunks) {
        socket.push(toBufferChunk(chunk))
      }

      peer.tunnels.add(socket)
      socket.on('close', () => {
        peer.tunnels.delete(socket)

        if (channels.upgradeClosed.hasSubscribers) {
          channels.upgradeClosed.publish({ ...upgradeDiagnostics })
        }
      })

      if (channels.upgradeEstablished.hasSubscribers) {
        channels.upgradeEstablished.publish({ ...upgradeDiagnostics, statusCode: parsedHead.statusCode })
      }

      controller.rawHeaders = parsedHead.rawHeaders
      runHooks(this.#hooks.onResponse, request, parsedHead, context)
      handler.onRequestUpgrade?.(controller as any, parsedHead.statusCode, parsedHead.headers as any, socket)
      finish()
    }

    const onPortMessage = (control: { chunks?: unknown[]; fin?: boolean; err?: Error }): void => {
      if (settled) {
        return
      }

      try {
        if (control.err) {
          finish(control.err)
          return
        }

        if (control.fin) {
          if (replaying) {
            endReplay()
          } else {
            finish(new Error('connection closed before response head'))
          }
          return
        }

        if (!Array.isArray(control.chunks)) {
          return
        }

        for (let i = 0; i < control.chunks.length; i++) {
          const raw = toBufferChunk(control.chunks[i])
          const buffer = typeof raw === 'string' ? Buffer.from(raw) : raw

          if (replaying) {
            handler.onResponseData?.(controller as any, buffer)
            continue
          }

          head = parser.feed(buffer)

          if (!head) {
            continue
          }

          if (responseTimeout !== null) {
            clearTimeout(responseTimeout)
            responseTimeout = null
          }

          peer.pending.delete(id)

          if (head.statusCode === 101) {
            establish(head, control.chunks.slice(i + 1))
            return
          }

          // Non-101 handshake rejection: replay it as a regular HTTP
          // response so it surfaces exactly like a network response would.
          replaying = true

          if (channels.upgradeRejected.hasSubscribers) {
            channels.upgradeRejected.publish({ ...upgradeDiagnostics, statusCode: head.statusCode })
          }

          runHooks(this.#hooks.onResponse, request, head, context)
          handler.onResponseStart?.(controller as any, head.statusCode, head.headers as any, head.statusMessage)

          if (head.rest.length > 0) {
            handler.onResponseData?.(controller as any, Buffer.from(head.rest))
          }
        }

        // Grant write credit so the server keeps sending head or body bytes.
        channel.port1.postMessage({ more: true })
      } catch (error) {
        finish(error as Error)
      }
    }

    channel.port1.on('message', onPortMessage)
    channel.port1.on('close', onPortClose)

    peer.pending.set(id, {
      request,
      handler,
      context,
      controller,
      resolve: () => finish(),
      reject: (error: Error) => finish(error),
      onMessage: AsyncResource.bind((value: unknown) => {
        const message = value as { type?: string }

        if (message.type === Message.ERROR) {
          finish((value as ErrorMessage).error)
        }
      })
    } as unknown as PendingRequest)

    if (this.#connectTimeout > 0) {
      responseTimeout = setTimeout(() => {
        finish(new ConnectTimeoutError(`Timeout while waiting for upgrade from ${server.serverId}.`))
      }, this.#connectTimeout)
      responseTimeout.unref()
    }

    const message: UpgradeMessage = {
      type: Message.UPGRADE,
      id,
      dispatchIndex: ++peer.lastDispatchIndex,
      meshId: this.#options.meshId,
      interceptorId: this.interceptorId,
      origin: server.origin,
      path: url.pathname + url.search,
      method: request.method,
      protocol: typeof request.upgrade === 'string' ? request.upgrade : 'websocket',
      headers: request.headers as Record<string, string | string[] | number | undefined>,
      socketPort: channel.port2
    }

    if (channels.upgradeStart.hasSubscribers) {
      channels.upgradeStart.publish({ ...upgradeDiagnostics })
    }

    handler.onRequestStart?.(controller as any, {})
    peer.port.postMessage(message, [channel.port2])
    await promise
  }

  /**
   * A node:http Agent that routes HTTP upgrade requests for mesh domains
   * through the mesh. This makes node:http-based WebSocket clients — most
   * notably the ws package, and therefore @fastify/http-proxy's WebSocket
   * proxying via wsClientOptions — work against mesh targets. Non-mesh
   * hosts fall back to a real TCP connection, so the agent is safe to use
   * for mixed upstreams.
   */
  createUpgradeAgent (): HttpAgent {
    const agent = new HttpAgent({ keepAlive: false })

    ;(agent as any).createConnection = (options: any, callback?: (err: Error | null, stream?: Duplex) => void) => {
      const socket = this.#createUpgradeConnection(options) ?? netConnect(options)

      if (callback) {
        callback(null, socket)
        return
      }

      return socket
    }

    return agent
  }

  #createUpgradeConnection (options: { host?: string }): Duplex | null {
    const hostname = String(options.host ?? '').toLowerCase()

    if (this.#domain === undefined || !hostname.endsWith(this.#domain)) {
      return null
    }

    const key = normalizeOrigin(hostname)

    if (!this.#mesh?.origins[key]) {
      return null
    }

    const channel = new MessageChannel()
    const clientSocket = new FakeSocket({ port: channel.port1 })
    const port = channel.port2
    const parser = new HttpRequestHeadParser()

    const onMessage = (control: { chunks?: unknown[]; fin?: boolean; err?: Error }): void => {
      if (control.err || control.fin) {
        port.off('message', onMessage)
        port.close()
        return
      }

      if (!Array.isArray(control.chunks)) {
        return
      }

      try {
        for (let i = 0; i < control.chunks.length; i++) {
          const raw = toBufferChunk(control.chunks[i])
          const head = parser.feed(typeof raw === 'string' ? Buffer.from(raw) : raw)

          if (!head) {
            continue
          }

          port.off('message', onMessage)

          const rest = Buffer.concat([
            head.rest,
            ...control.chunks.slice(i + 1).map(chunk => {
              const value = toBufferChunk(chunk)
              return typeof value === 'string' ? Buffer.from(value) : value
            })
          ])

          this.#routeAgentUpgrade(clientSocket, port, key, hostname, head, rest).catch(() => {
            respondInBand(port, 502, 'Bad Gateway')
          })

          return
        }

        // Head incomplete: grant write credit so node:http can keep writing.
        port.postMessage({ more: true })
      } catch {
        port.off('message', onMessage)
        respondInBand(port, 400, 'Bad Request')
      }
    }

    port.on('message', onMessage)
    return clientSocket
  }

  async #routeAgentUpgrade (
    clientSocket: FakeSocket,
    port: MessagePort,
    key: string,
    host: string,
    head: ParsedRequestHead,
    rest: Buffer
  ): Promise<void> {
    const upgradeHeader = head.headers.upgrade

    if (!upgradeHeader) {
      respondInBand(port, 501, 'Not Implemented')
      return
    }

    const request = {
      origin: `http://${host}`,
      method: head.method,
      path: head.path,
      headers: sanitizeHeaders(head.headers, host),
      upgrade: Array.isArray(upgradeHeader) ? upgradeHeader[0] : upgradeHeader
    }
    const context: Record<PropertyKey, unknown> = {}
    runHooks(this.#hooks.onRequest, request, context)

    const meshOrigin = this.#mesh?.origins[key]
    const server = meshOrigin
      ? this.#selectServer(key, meshOrigin.servers, request as unknown as DispatchOptions, context, true)
      : null

    if (!server) {
      respondInBand(port, 503, 'Service Unavailable')
      return
    }

    if (server.mode === 'tcp') {
      this.#spliceAgentUpgradeToTcp(port, server.address, head, rest)
      return
    }

    const peer = await this.#ensurePeerMessagePort(server)
    const id = this.#requestId()

    const upgradeDiagnostics = {
      meshId: this.#options.meshId,
      origin: server.origin,
      interceptorId: this.interceptorId,
      serverId: server.serverId,
      method: head.method,
      path: head.path
    }

    peer.tunnels.add(clientSocket)
    clientSocket.on('close', () => {
      peer.tunnels.delete(clientSocket)

      if (channels.upgradeClosed.hasSubscribers) {
        channels.upgradeClosed.publish({ ...upgradeDiagnostics })
      }
    })

    let responseTimeout: ReturnType<typeof setTimeout> | null = null
    const settle = (): void => {
      peer.pending.delete(id)

      if (responseTimeout !== null) {
        clearTimeout(responseTimeout)
        responseTimeout = null
      }
    }

    // After the port transfer the response bytes flow straight to the
    // client, so the first readable data doubles as the "response started"
    // signal that disarms the timeout and the pending ERROR entry.
    clientSocket.once('data', settle)
    clientSocket.once('close', settle)

    peer.pending.set(id, {
      request,
      handler: {},
      context,
      controller: null,
      resolve: settle,
      reject: (error: Error) => {
        settle()
        clientSocket.destroy(error)
      },
      onMessage: AsyncResource.bind((value: unknown) => {
        const message = value as { type?: string }

        if (message.type === Message.ERROR) {
          settle()
          clientSocket.destroy((value as ErrorMessage).error)
        }
      })
    } as unknown as PendingRequest)

    if (this.#connectTimeout > 0) {
      responseTimeout = setTimeout(() => {
        settle()
        clientSocket.destroy(new ConnectTimeoutError(`Timeout while waiting for upgrade from ${server.serverId}.`))
      }, this.#connectTimeout)
      responseTimeout.unref()
    }

    const message: UpgradeMessage = {
      type: Message.UPGRADE,
      id,
      dispatchIndex: ++peer.lastDispatchIndex,
      meshId: this.#options.meshId,
      interceptorId: this.interceptorId,
      origin: server.origin,
      path: head.path,
      method: head.method,
      protocol: request.upgrade,
      headers: request.headers as Record<string, string | string[] | number | undefined>,
      socketPort: port
    }

    if (rest.length > 0) {
      message.head = rest
    }

    if (channels.upgradeStart.hasSubscribers) {
      channels.upgradeStart.publish({ ...upgradeDiagnostics })
    }

    // Transferring the port turns the client socket into a direct pipe to
    // the server thread; the handshake response and all frames flow through
    // without another hop in this thread.
    peer.port.postMessage(message, [port])
  }

  #spliceAgentUpgradeToTcp (port: MessagePort, address: string, head: ParsedRequestHead, rest: Buffer): void {
    const url = new URL(address)
    const tcp = netConnect({ host: url.hostname, port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80) })
    const local = new MessagePortDuplex({ port })

    local.on('error', () => {})
    tcp.on('error', () => {})
    tcp.on('connect', () => {
      tcp.write(head.raw)

      if (rest.length > 0) {
        tcp.write(rest)
      }

      local.pipe(tcp)
      tcp.pipe(local)
    })
    tcp.on('close', () => local.destroy())
    local.on('close', () => tcp.destroy())
  }

  async #ensurePeerMessagePort (server: Extract<MeshServer, { mode: 'thread' }>): Promise<Peer> {
    const key = `${server.serverId}:${server.origin}`
    const existing = this.#peers.get(key)

    if (existing && !existing.closed && !existing.draining) {
      return existing
    }

    if (existing?.draining) {
      throw new Error('message port is draining')
    }

    if (this.#connectTimeout <= 0) {
      return this.#getPeerMessagePort(server.serverId, server.origin, server.threadId)
    }

    const peer = await executeWithTimeout(
      this.#getPeerMessagePort(server.serverId, server.origin, server.threadId),
      this.#connectTimeout,
      kTimeout
    )

    /* c8 ignore next 3 - hard to test */
    if (peer === kTimeout) {
      throw new ConnectTimeoutError(`Timeout while connecting to ${server.serverId}.`)
    }

    return peer
  }

  async #getPeerMessagePort (serverId: string, origin: string, serverThreadId: number): Promise<Peer> {
    const key = `${serverId}:${origin}`
    const channel = new MessageChannel()
    const diagnostics = {
      meshId: this.#options.meshId,
      origin,
      interceptorId: this.interceptorId,
      serverId,
      role: 'interceptor' as const,
      threadId
    }

    const peer: Peer = {
      port: channel.port1,
      pending: new Map(),
      tunnels: new Set(),
      closed: false,
      diagnostics,
      lastDispatchIndex: 0,
      draining: false
    }
    this.#peers.set(key, peer)

    channel.port1.on('message', value => this.#onPeerMessage(peer, value))
    channel.port1.on('close', () => {
      peer.closed = true

      if (channels.peerDisconnect.hasSubscribers) {
        channels.peerDisconnect.publish(diagnostics)
      }

      for (const pending of peer.pending.values()) {
        pending.reject(new Error('message port closed'))
      }

      peer.pending.clear()

      for (const tunnel of peer.tunnels) {
        tunnel.destroy(new Error('message port closed'))
      }

      peer.tunnels.clear()
    })
    channel.port1.start()

    const connectMessage: PeerConnectMessage = {
      type: Message.PEER_CONNECT,
      meshId: this.#options.meshId,
      origin,
      interceptorId: this.interceptorId,
      serverId,
      port: channel.port2
    }

    await sendThreadMessage(
      serverThreadId,
      connectMessage,
      [channel.port2],
      this.#connectTimeout > 0 ? this.#connectTimeout : undefined
    )

    if (channels.peerConnect.hasSubscribers) {
      channels.peerConnect.publish(diagnostics)
    }

    return peer
  }

  #onPeerMessage (peer: Peer, value: unknown): void {
    const message = value as { type?: string; id?: string }

    if (message.type === Message.PEER_DRAIN) {
      peer.draining = true
      peer.port.postMessage({ type: Message.PEER_DRAIN_ACK, lastDispatchIndex: peer.lastDispatchIndex })
      return
    }

    if (!message.id) {
      return
    }

    const pending = peer.pending.get(message.id)
    if (!pending) {
      // A response that arrives after its request timed out has no consumer:
      // close its body port so the sending side can release buffered data.
      if (message.type === Message.RESPONSE) {
        const { bodyPort } = value as ResponseMessage
        bodyPort?.close()
      }
      return
    }

    peer.pending.delete(message.id)
    pending.onMessage(value)
  }

  #handlePeerMessage (pending: PendingRequest, value: unknown): void {
    const message = value as { type?: string }

    if (message.type === Message.ERROR) {
      const error = (value as ErrorMessage).error
      this.#publishRequestError(pending.request, pending.context, error)

      runHooks(this.#hooks.onError, pending.request, null, pending.context, error)

      pending.handler.onResponseError?.(pending.controller, error)
      pending.resolve()

      return
    }

    if (message.type === Message.RESPONSE) {
      this.#handleResponse(pending, value as ResponseMessage)
    }
  }

  #handleResponse (pending: PendingRequest, response: ResponseMessage): void {
    publishRequestHeaders(pending.request, response, pending.context)
    runHooks(this.#hooks.onResponse, pending.request, response, pending.context)

    try {
      if (pending.controller.aborted) {
        response.bodyPort?.close()
        pending.handler.onResponseError?.(pending.controller, pending.controller.reason as Error)
        pending.resolve()
        return
      }

      pending.handler.onResponseStart?.(
        pending.controller as any,
        response.statusCode,
        response.headers as any,
        response.statusMessage
      )

      if (pending.controller.aborted) {
        response.bodyPort?.close()
        pending.handler.onResponseError?.(pending.controller, pending.controller.reason as Error)
        pending.resolve()
        return
      }
    } catch (error) {
      response.bodyPort?.close()
      this.#publishRequestError(pending.request, pending.context, error as Error)
      pending.handler.onResponseError?.(pending.controller, error as Error)
      pending.resolve()
      return
    }

    if (response.bodyPort) {
      const body = new MessagePortReadable({ port: response.bodyPort })
      pending.pauseResponse = () => body.pause()
      pending.resumeResponse = () => body.resume()
      pending.abortResponse = reason => {
        // Tear down the body stream: this notifies the sending side and
        // closes the port, so buffered data can be released.
        body.destroy(reason)
      }

      body.on('data', chunk => {
        try {
          pending.handler.onResponseData?.(pending.controller as any, Buffer.from(chunk))
        } catch (error) {
          response.bodyPort?.close()
          this.#publishRequestError(pending.request, pending.context, error as Error)
          pending.handler.onResponseError?.(pending.controller, error as Error)
          pending.resolve()
        }
      })

      body.on('end', () => {
        // The body is complete: a later abort must not tear down a stream whose
        // terminal event was already delivered.
        pending.abortResponse = undefined

        try {
          pending.handler.onResponseEnd?.(pending.controller as any, {})
        } catch (error) {
          response.bodyPort?.close()
          this.#publishRequestError(pending.request, pending.context, error as Error)
          pending.handler.onResponseError?.(pending.controller, error as Error)
          pending.resolve()
          return
        }

        this.#finishResponse(pending, response)
      })

      body.on('error', error => {
        this.#publishRequestError(pending.request, pending.context, error)
        pending.handler.onResponseError?.(pending.controller as any, error)
        pending.resolve()
      })

      return
    }

    try {
      if (response.body !== undefined) {
        const body =
          typeof response.body === 'string'
            ? Buffer.from(response.body)
            : Buffer.from(response.body.buffer, response.body.byteOffset, response.body.byteLength)
        pending.handler.onResponseData?.(pending.controller as any, body)
      }

      pending.handler.onResponseEnd?.(pending.controller as any, {})
    } catch (error) {
      this.#publishRequestError(pending.request, pending.context, error as Error)
      pending.handler.onResponseError?.(pending.controller, error as Error)
      pending.resolve()
      return
    }

    this.#finishResponse(pending, response)
  }

  #finishResponse (pending: PendingRequest, response: ResponseMessage): void {
    runHooks(this.#hooks.onResponseEnd, pending.request, response, pending.context)

    if (channels.requestTrailers.hasSubscribers && pending.context[kWrappedRequest]) {
      const wrappedRequest = pending.context[kWrappedRequest] as { completed?: boolean } | undefined

      if (wrappedRequest) {
        wrappedRequest.completed = true
        channels.requestTrailers.publish({ request: wrappedRequest, trailers: [] })
      }
    }

    pending.resolve()
  }

  #isTargetAllowed (request: DispatchOptions, target: MeshServer, context: Record<PropertyKey, unknown>): boolean {
    for (const hook of this.#hooks.allowTarget) {
      if (hook(request, target, context) === false) {
        return false
      }
    }

    return true
  }

  #publishRequestError (request: any, context: Record<PropertyKey, unknown>, error: Error): void {
    if (!channels.requestError.hasSubscribers) {
      return
    }

    channels.requestError.publish({ request: getWrappedRequest(request, context), error })
  }
}
