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

interface PendingOperation {
  initiator?: MessagePort
  recipients: Set<MessagePort>
}

const operationMessages: Set<string> = new Set([
  Message.INTERCEPTOR_UPDATE,
  Message.INTERCEPTOR_LEAVE,
  Message.SERVER_UPDATE,
  Message.SERVER_LEAVE,
  Message.MESH_ACK
])

const operationNames: Record<string, string> = {
  [Message.INTERCEPTOR_UPDATE]: 'Interceptor update',
  [Message.INTERCEPTOR_LEAVE]: 'Interceptor leave',
  [Message.SERVER_UPDATE]: 'Server update',
  [Message.SERVER_LEAVE]: 'Server leave',
  [Message.MESH_ACK]: 'Mesh acknowledgement'
}

const coordinators = new Map<string, Coordinator>()

export class Coordinator {
  #options: CoordinatorOptions
  #mesh: Mesh
  #members: Map<MessagePort, Member>
  #closed: boolean
  #destroyed: boolean
  #boundWorkerMessageListener: (value: unknown) => void
  #pendingOperations: Map<string, PendingOperation>
  #internalOperationId: number

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
    this.#pendingOperations = new Map()
    this.#internalOperationId = 0

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
    this.#pendingOperations.clear()
    this.#mesh = prepareMesh(this.#options.meshId)
  }

  restart (): void {
    if (this.#destroyed) {
      throw new Error(`Coordinator ${this.#options.meshId} has been destroyed.`)
    }

    this.#closed = false
    this.#members.clear()
    this.#pendingOperations.clear()
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
    if (!message.operationId) {
      this.#options.onError?.(new Error('Coordinator connect requires an operationId.'))
      message.port.close()
      return
    }

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

    const operationId = message.operationId

    if (message.role === 'server') {
      this.#upsertServer(
        member,
        {
          metadata: message.metadata,
          origin: message.server?.origin,
          state: message.server?.state,
          mode: message.server?.mode,
          address: message.server?.address,
          capabilities: message.server?.capabilities
        },
        operationId,
        message.port
      )
    } else {
      this.#upsertInterceptor(member, message.metadata, operationId, message.port)
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
      const operationId = operationMessages.has(message.type ?? '') ? this.#requireOperationId(message) : undefined

      switch (message.type) {
        case Message.INTERCEPTOR_UPDATE:
          this.#upsertInterceptor(member, message.metadata, operationId!, member.port)
          break
        case Message.INTERCEPTOR_LEAVE:
          this.#removeInterceptor(member.id, operationId!, member.port)
          break
        case Message.SERVER_UPDATE:
          this.#upsertServer(member, message, operationId!, member.port)
          break
        case Message.SERVER_LEAVE:
          this.#removeServer(member.id, operationId!, member.port)
          break
        case Message.GET_MESH:
          member.port.postMessage({ type: Message.MESH, mesh: this.#mesh })
          break
        case Message.MESH_ACK:
          this.#acknowledge(member.port, operationId!)
          break
      }
    } catch (error) {
      this.#options.onError?.(error as Error)
      if (typeof message.operationId === 'string' && message.operationId.length > 0) {
        member.port.postMessage({ type: Message.OPERATION_ERROR, operationId: message.operationId, error })
      }
    }
  }

  #requireOperationId (message: { type?: string; operationId?: unknown }): string {
    if (typeof message.operationId !== 'string' || message.operationId.length === 0) {
      throw new Error(`${operationNames[message.type ?? ''] ?? 'Mesh operation'} requires an operationId.`)
    }

    return message.operationId
  }

  #upsertInterceptor (member: Member, metadata: unknown, operationId: string, initiator?: MessagePort): void {
    const interceptor: MeshInterceptor = {
      interceptorId: member.id,
      threadId: member.threadId,
      metadata
    }

    const exists = this.#mesh.interceptors[member.id]
    this.#mesh.interceptors[member.id] = interceptor

    if (!exists) {
      /* c8 ignore next - else */
      this.#options.onInterceptorAvailable?.(interceptor)
    }

    this.#publishMesh(operationId, initiator)
  }

  #upsertServer (member: Member, message: Record<string, unknown>, operationId: string, initiator?: MessagePort): void {
    const previous = this.#mesh.servers[member.id]
    /* c8 ignore next - else */
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
      metadata: message.metadata ?? previous?.metadata,
      capabilities: (message.capabilities ?? previous?.capabilities) as MeshServer['capabilities']
    }

    const server: MeshServer =
      mode === 'tcp'
        ? {
            ...base,
            mode,
            /* c8 ignore next - else */
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
    this.#publishMesh(operationId, initiator)
  }

  #removeMember (member: Member): void {
    this.#members.delete(member.port)

    for (const [operationId, operation] of this.#pendingOperations) {
      operation.recipients.delete(member.port)
      this.#completeIfApplied(operationId)
    }

    if (member.role === 'interceptor') {
      this.#removeInterceptor(member.id, this.#nextInternalOperationId())
    } else {
      this.#removeServer(member.id, this.#nextInternalOperationId())
    }
  }

  #removeInterceptor (interceptorId: string, operationId: string, initiator?: MessagePort): void {
    const interceptor = this.#mesh.interceptors[interceptorId]

    if (!interceptor) {
      return
    }

    delete this.#mesh.interceptors[interceptorId]
    this.#options.onInterceptorClosed?.(interceptor)
    this.#publishMesh(operationId, initiator, this.getMember('interceptor', interceptorId)?.port)
  }

  #removeServer (serverId: string, operationId: string, initiator?: MessagePort): void {
    const server = this.#mesh.servers[serverId]

    if (!server) {
      return
    }

    delete this.#mesh.servers[serverId]
    this.#options.onServerClosed?.({ ...server, state: 'closed' })
    this.#rebuildOrigins()
    this.#publishMesh(operationId, initiator)
  }

  #rebuildOrigins (): void {
    this.#mesh.origins = {}

    for (const server of Object.values(this.#mesh.servers)) {
      this.#mesh.origins[server.origin] ??= { origin: server.origin, servers: [] }
      this.#mesh.origins[server.origin].servers.push(server.serverId)
    }
  }

  #publishMesh (operationId: string, initiator?: MessagePort, excluded?: MessagePort): void {
    this.#mesh.version++

    const recipients = new Set<MessagePort>()
    for (const member of this.#members.values()) {
      if (member.role === 'interceptor' && member.port !== excluded) {
        recipients.add(member.port)
      }
    }

    this.#pendingOperations.set(operationId, { initiator, recipients })
    const message = { type: Message.MESH, operationId, mesh: this.#mesh }

    for (const member of this.#members.values()) {
      try {
        member.port.postMessage(message)
      } catch (error) {
        recipients.delete(member.port)
        this.#options.onError?.(error as Error)
      }
    }

    const mesh = structuredClone(this.#mesh)

    if (channels.meshUpdate.hasSubscribers) {
      channels.meshUpdate.publish({ meshId: mesh.meshId, version: mesh.version, mesh })
    }

    /* c8 ignore next - else */
    this.#options.onMesh?.(mesh)

    this.#completeIfApplied(operationId)
  }

  #acknowledge (port: MessagePort, operationId: string): void {
    const operation = this.#pendingOperations.get(operationId)
    if (!operation) {
      return
    }

    operation.recipients.delete(port)
    this.#completeIfApplied(operationId)
  }

  #completeIfApplied (operationId: string): void {
    const operation = this.#pendingOperations.get(operationId)
    if (!operation || operation.recipients.size > 0) {
      return
    }

    this.#pendingOperations.delete(operationId)
    if (operation.initiator) {
      setImmediate(() => {
        try {
          if (this.#members.get(operation.initiator!)?.role === 'server') {
            operation.initiator?.postMessage({ type: Message.MESH, mesh: this.#mesh })
          }
          operation.initiator?.postMessage({ type: Message.MESH_APPLIED, operationId })
        } catch (error) {
          this.#options.onError?.(error as Error)
        }
      }).unref()
    }
  }

  #nextInternalOperationId (): string {
    this.#internalOperationId++
    return `internal-${this.#internalOperationId}`
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
