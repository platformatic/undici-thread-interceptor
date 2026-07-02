import type { MessagePort } from 'node:worker_threads'

import { channels } from './diagnostics.ts'
import {
  Message,
  prepareMesh,
  type CoordinatorConnectMessage,
  type Mesh,
  type MeshInterceptor,
  type MeshServer,
  type Role,
  type State
} from './protocol.ts'

export interface CoordinatorOptions {
  meshId: string
  onMesh?: (mesh: Mesh) => void
  onInterceptorAvailable?: (interceptor: MeshInterceptor) => void
  onInterceptorClosed?: (interceptor: MeshInterceptor) => void
  onServerAvailable?: (server: MeshServer) => void
  onServerUnavailable?: (server: MeshServer) => void
  onServerPaused?: (server: MeshServer) => void
  onServerResumed?: (server: MeshServer) => void
  onServerClosed?: (server: MeshServer) => void
  onServerUpdate?: (server: MeshServer) => void
  onError?: (error: Error) => void
}

interface Member {
  role: Role
  id: string
  threadId: number
  port: MessagePort
}

const coordinators = new Map<string, Coordinator>()

export class Coordinator {
  #options: CoordinatorOptions
  #mesh: Mesh
  #members: Map<MessagePort, Member>
  #closed: boolean
  #destroyed: boolean
  #boundWorkerMessageListener: (value: unknown) => void

  constructor (options: CoordinatorOptions) {
    if (coordinators.has(options.meshId)) {
      throw new Error(`A coordinator already exists for mesh ${options.meshId}.`)
    }

    coordinators.set(options.meshId, this)

    this.#options = options
    this.#mesh = prepareMesh(options.meshId)
    this.#members = new Map()
    this.#closed = false
    this.#destroyed = false
    this.#boundWorkerMessageListener = this.#onWorkerMessage.bind(this)

    process.on('workerMessage', this.#boundWorkerMessageListener)
  }

  close (serverId?: string): void {
    if (serverId !== undefined) {
      const member = this.getMember('server', serverId)

      if (!member) {
        return
      }

      member.port.postMessage({ type: Message.CLOSE, meshId: this.#options.meshId, serverId })
      return
    }

    if (this.#closed) {
      return
    }

    this.#closed = true

    for (const member of this.#members.values()) {
      member.port.close()
    }

    this.#members.clear()
    this.#mesh = prepareMesh(this.#options.meshId)
  }

  restart (): void {
    if (this.#destroyed) {
      throw new Error(`Coordinator ${this.#options.meshId} has been destroyed.`)
    }

    this.#closed = false
    this.#members.clear()
    this.#mesh = prepareMesh(this.#options.meshId)
  }

  destroy (): void {
    if (this.#destroyed) {
      return
    }

    this.#closed = true
    this.#destroyed = true

    for (const member of this.#members.values()) {
      member.port.close()
    }

    this.#members.clear()

    coordinators.delete(this.#options.meshId)
    process.removeListener('workerMessage', this.#boundWorkerMessageListener)
  }

  getMesh (): Mesh {
    return structuredClone(this.#mesh)
  }

  pause (serverId: string): void {
    const member = this.getMember('server', serverId)

    if (!member) {
      return
    }

    member.port.postMessage({ type: Message.PAUSE, meshId: this.#options.meshId, serverId })
  }

  resume (serverId: string): void {
    const member = this.getMember('server', serverId)

    if (!member) {
      return
    }

    member.port.postMessage({ type: Message.RESUME, meshId: this.#options.meshId, serverId })
  }

  connectMember (message: CoordinatorConnectMessage): void {
    if (this.#closed) {
      message.port.close()
      return
    }

    const id = message.role === 'server' ? message.server?.id : message.interceptor?.id

    if (!id) {
      message.port.close()
      return
    }

    if (message.role === 'server' && !message.server) {
      message.port.close()
      return
    }

    if (message.role === 'interceptor' && !message.interceptor) {
      message.port.close()
      return
    }

    const member: Member = {
      role: message.role,
      id,
      threadId: message.threadId,
      port: message.port
    }

    this.#members.set(message.port, member)

    message.port.on('message', value => this.#onMessage(member, value))
    message.port.on('close', () => this.#removeMember(member))
    message.port.start()

    if (message.role === 'server') {
      this.#upsertServer(member, {
        metadata: message.metadata,
        origin: message.server?.origin,
        state: message.server?.state,
        mode: message.server?.mode,
        address: message.server?.address
      })
    } else {
      this.#upsertInterceptor(member, message.metadata)
    }
  }

  getMember (role: Role, id: string): Member | undefined {
    for (const member of this.#members.values()) {
      if (member.role === role && member.id === id) {
        return member
      }
    }
  }

  #onMessage (member: Member, value: unknown): void {
    const message = value as { type?: string; [key: string]: unknown }

    try {
      switch (message.type) {
        case Message.INTERCEPTOR_UPDATE:
          this.#upsertInterceptor(member, message.metadata)
          break
        case Message.INTERCEPTOR_LEAVE:
          this.#removeInterceptor(member.id)
          break
        case Message.SERVER_UPDATE:
          this.#upsertServer(member, message)
          break
        case Message.SERVER_LEAVE:
          this.#removeServer(member.id)
          break
        case Message.GET_MESH:
          member.port.postMessage({ type: Message.MESH, mesh: this.#mesh })
          break
      }
    } catch (error) {
      this.#options.onError?.(error as Error)
    }
  }

  #upsertInterceptor (member: Member, metadata: unknown): void {
    const interceptor: MeshInterceptor = {
      interceptorId: member.id,
      threadId: member.threadId,
      metadata
    }

    const exists = this.#mesh.interceptors[member.id]
    this.#mesh.interceptors[member.id] = interceptor

    if (!exists) {
      this.#options.onInterceptorAvailable?.(interceptor)
    }

    this.#publishMesh()
  }

  #upsertServer (member: Member, message: Record<string, unknown>): void {
    const previous = this.#mesh.servers[member.id]
    const serverState = (message.state ?? previous?.state ?? 'available') as State
    const origin = (message.origin ?? previous?.origin) as string | undefined
    const mode = (message.mode ?? previous?.mode) as MeshServer['mode'] | undefined

    if (!origin || !mode) {
      return
    }

    const base = {
      serverId: member.id,
      threadId: member.threadId,
      origin,
      state: serverState,
      metadata: message.metadata ?? previous?.metadata
    }

    const server: MeshServer =
      mode === 'tcp'
        ? {
            ...base,
            mode,
            address: (message.address ?? (previous?.mode === 'tcp' ? previous.address : undefined)) as string
          }
        : { ...base, mode }

    this.#mesh.servers[member.id] = server

    if (!previous) {
      this.#options.onServerAvailable?.(server)
    } else if (previous.state !== server.state) {
      switch (server.state) {
        case 'paused':
          this.#options.onServerPaused?.(server)
          break
        case 'available':
          this.#options.onServerResumed?.(server)
          break
        case 'closed':
          this.#options.onServerClosed?.(server)
          break
        default:
          this.#options.onServerUnavailable?.(server)
          break
      }
    } else {
      this.#options.onServerUpdate?.(server)
    }

    this.#rebuildOrigins()
    this.#publishMesh()
  }

  #removeMember (member: Member): void {
    this.#members.delete(member.port)

    if (member.role === 'interceptor') {
      this.#removeInterceptor(member.id)
    } else {
      this.#removeServer(member.id)
    }
  }

  #removeInterceptor (interceptorId: string): void {
    const interceptor = this.#mesh.interceptors[interceptorId]

    if (!interceptor) {
      return
    }

    delete this.#mesh.interceptors[interceptorId]
    this.#options.onInterceptorClosed?.(interceptor)
    this.#publishMesh()
  }

  #removeServer (serverId: string): void {
    const server = this.#mesh.servers[serverId]

    if (!server) {
      return
    }

    delete this.#mesh.servers[serverId]
    this.#options.onServerClosed?.({ ...server, state: 'closed' })
    this.#rebuildOrigins()
    this.#publishMesh()
  }

  #rebuildOrigins (): void {
    this.#mesh.origins = {}

    for (const server of Object.values(this.#mesh.servers)) {
      this.#mesh.origins[server.origin] ??= { origin: server.origin, servers: [] }
      this.#mesh.origins[server.origin].servers.push(server.serverId)
    }
  }

  #publishMesh (): void {
    this.#mesh.version++

    const message = { type: Message.MESH, mesh: this.#mesh }

    for (const member of this.#members.values()) {
      member.port.postMessage(message)
    }

    const mesh = structuredClone(this.#mesh)

    if (channels.meshUpdate.hasSubscribers) {
      channels.meshUpdate.publish({ meshId: mesh.meshId, version: mesh.version, mesh })
    }

    this.#options.onMesh?.(mesh)
  }

  #onWorkerMessage (value: unknown) {
    const message = value as Partial<CoordinatorConnectMessage>

    if (
      message?.type !== Message.COORDINATOR_CONNECT ||
      !message.meshId ||
      !message.port ||
      this.#mesh.meshId !== message.meshId
    ) {
      return
    }

    this.connectMember(message as CoordinatorConnectMessage)
  }
}

export function createCoordinator (options: CoordinatorOptions): Coordinator {
  return new Coordinator(options)
}
