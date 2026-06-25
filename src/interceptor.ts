import { AsyncResource } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'
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
import { MessagePortReadable, MessagePortWritable } from './message-port-streams.ts'
import {
  Message,
  type CoordinatorConnectMessage,
  type ErrorMessage,
  type Mesh,
  type MeshServer,
  type PeerConnectMessage,
  type RequestMessage,
  type ResponseMessage
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
}

type Dispatch = Dispatcher.Dispatch
type DispatchOptions = Dispatcher.DispatchOptions
type DispatchHandler = Dispatcher.DispatchHandler

interface PendingRequest {
  request: DispatchOptions
  handler: DispatchHandler
  context: Record<PropertyKey, unknown>
  controller: DispatchController
  resolve: () => void
  reject: (error: Error) => void
}

interface Peer {
  port: MessagePort
  pending: Map<string, PendingRequest>
  closed: boolean
  diagnostics: PeerDiagnosticsPayload
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
}

function isStreamBody (body: unknown): body is Readable {
  return (
    typeof (body as Readable)?.pipe === 'function' ||
    typeof (body as AsyncIterable<unknown>)?.[Symbol.asyncIterator] === 'function'
  )
}

class DispatchController extends EventEmitter {
  aborted: boolean
  paused: boolean
  reason: Error | null

  constructor () {
    super()
    this.aborted = false
    this.paused = false
    this.reason = null
  }

  abort (reason: Error): void {
    this.aborted = true
    this.reason = reason
  }

  pause (): void {
    this.paused = true
    this.emit('pause')
  }

  resume (): void {
    this.paused = false
    this.emit('resume')
  }
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

    const url = opts.origin instanceof URL ? opts.origin : new URL(opts.path, opts.origin)
    const key = normalizeOrigin(url)

    if (this.#domain === undefined || !url.hostname.toLowerCase().endsWith(this.#domain)) {
      return dispatch(opts, handler)
    }

    const meshOrigin = this.#mesh?.origins[key]
    if (!meshOrigin) {
      return dispatch(opts, handler)
    }

    const context: Record<PropertyKey, unknown> = {}
    const request = {
      ...opts,
      headers: sanitizeHeaders({ ...(opts.headers as Record<string, string>), host: url.host })
    } as DispatchOptions
    runHooks(this.#hooks.onRequest, request, context)

    const server = this.#selectServer(key, meshOrigin.servers, request, context)
    if (!server) {
      throw new NoAvailableTargetError(key)
    }

    if (server.mode === 'tcp') {
      return dispatch({ ...request, origin: server.address } as DispatchOptions, new HookHandler(handler, this.#hooks, request, context))
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

    if (message.type !== Message.MESH || !message.mesh) {
      return
    }

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
    context: Record<PropertyKey, unknown>
  ): MeshServer | null {
    const available = serverIds
      .map(serverId => this.#mesh?.servers[serverId])
      .filter((server): server is MeshServer => server?.state === 'available')

    if (available.length === 0) {
      return null
    }

    let cursor = this.#cursors.get(origin)
    if (cursor === undefined) {
      cursor = Math.floor(Math.random() * available.length)
    }

    for (let i = 0; i < available.length; i++) {
      const server = available[(cursor + i) % available.length]
      if (!this.#isTargetAllowed(request, server, context)) {
        continue
      }

      this.#cursors.set(origin, (cursor + i + 1) % available.length)
      return server
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
    const peer = await executeWithTimeout(
      this.#getPeerMessagePort(server.serverId, server.origin, server.threadId),
      this.#connectTimeout,
      kTimeout
    )
    if (peer === kTimeout) {
      throw new ConnectTimeoutError(`Timeout while connecting to ${server.serverId}.`)
    }
    const id = createId()
    const controller = new DispatchController()
    const { promise: responsePromise, resolve, reject } = Promise.withResolvers<void>()
    peer.pending.set(id, { request, handler, context, controller, resolve, reject })

    const message: RequestMessage = {
      type: Message.REQUEST,
      id,
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

    handler.onRequestStart?.(controller as any, {})
    peer.port.postMessage(message, transferList)
    const result = await executeWithTimeout(responsePromise, this.#connectTimeout)
    if (result === kTimeout) {
      throw new ConnectTimeoutError(`Timeout while waiting for response from ${server.serverId}.`)
    }
  }

  async #getPeerMessagePort (serverId: string, origin: string, serverThreadId: number): Promise<Peer> {
    const key = `${serverId}:${origin}`
    const existing = this.#peers.get(key)
    if (existing && !existing.closed) {
      return existing
    }

    const channel = new MessageChannel()
    const diagnostics = {
      meshId: this.#options.meshId,
      origin,
      interceptorId: this.interceptorId,
      serverId,
      role: 'interceptor' as const,
      threadId
    }
    const peer: Peer = { port: channel.port1, pending: new Map(), closed: false, diagnostics }
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

    await sendThreadMessage(serverThreadId, connectMessage, [channel.port2], this.#connectTimeout)

    if (channels.peerConnect.hasSubscribers) {
      channels.peerConnect.publish(diagnostics)
    }

    return peer
  }

  #onPeerMessage (peer: Peer, value: unknown): void {
    const message = value as { type?: string; id?: string }
    if (!message.id) {
      return
    }

    const pending = peer.pending.get(message.id)
    if (!pending) {
      return
    }

    peer.pending.delete(message.id)

    const callback = AsyncResource.bind(() => {
      if (message.type === Message.ERROR) {
        const error = (value as ErrorMessage).error
        this.#publishRequestError(pending.request, pending.context, error)
        runHooks(this.#hooks.onError, pending.request, null, pending.context, error)
        pending.handler.onResponseError?.(pending.controller, error)
        pending.reject(error)
        return
      }

      if (message.type === Message.RESPONSE) {
        this.#handleResponse(pending, value as ResponseMessage)
      }
    })

    callback()
  }

  #handleResponse (pending: PendingRequest, response: ResponseMessage): void {
    publishRequestHeaders(pending.request, response, pending.context)
    runHooks(this.#hooks.onResponse, pending.request, response, pending.context)
    try {
      if (pending.controller.aborted) {
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
        pending.handler.onResponseError?.(pending.controller, pending.controller.reason as Error)
        pending.resolve()
        return
      }
    } catch (error) {
      this.#publishRequestError(pending.request, pending.context, error as Error)
      pending.handler.onResponseError?.(pending.controller, error as Error)
      pending.resolve()
      return
    }

    if (response.bodyPort) {
      const body = new MessagePortReadable({ port: response.bodyPort })
      pending.controller.on('pause', () => body.pause())
      pending.controller.on('resume', () => body.resume())
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
        pending.handler.onResponseData?.(pending.controller as any, Buffer.from(response.body))
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
