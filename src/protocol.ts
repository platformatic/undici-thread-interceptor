import type { MessagePort } from 'node:worker_threads'

export const MAX_BODY = 32 * 1024

export const Message = {
  COORDINATOR_CONNECT: 'undici-thread-interceptor.coordinator.connect',
  INTERCEPTOR_UPDATE: 'undici-thread-interceptor.interceptor.update',
  INTERCEPTOR_LEAVE: 'undici-thread-interceptor.interceptor.leave',
  SERVER_UPDATE: 'undici-thread-interceptor.server.update',
  SERVER_LEAVE: 'undici-thread-interceptor.server.leave',
  GET_MESH: 'undici-thread-interceptor.mesh.get',
  MESH: 'undici-thread-interceptor.mesh',
  PAUSE: 'undici-thread-interceptor.pause',
  RESUME: 'undici-thread-interceptor.resume',
  CLOSE: 'undici-thread-interceptor.close',
  PEER_CONNECT: 'undici-thread-interceptor.peer.connect',
  PEER_DISCONNECT: 'undici-thread-interceptor.peer.disconnect',
  REQUEST: 'undici-thread-interceptor.request',
  RESPONSE: 'undici-thread-interceptor.response',
  UPGRADE: 'undici-thread-interceptor.upgrade',
  ERROR: 'undici-thread-interceptor.error'
} as const

export type MessageLabel = keyof typeof Message
export type MessageValue = (typeof Message)[MessageLabel]

export type State = 'available' | 'paused' | 'closing' | 'closed'
export type Mode = 'thread' | 'tcp'

export type Role = 'interceptor' | 'server'

interface BaseServer {
  serverId: string
  threadId: number
  origin: string
  state: State
  metadata?: unknown
}

export interface ThreadServer extends BaseServer {
  mode: 'thread'
}

export interface TcpServer extends BaseServer {
  mode: 'tcp'
  address: string
}

export type MeshServer = ThreadServer | TcpServer

export interface MeshInterceptor {
  interceptorId: string
  threadId: number
  metadata?: unknown
}

export interface MeshOrigin {
  origin: string
  servers: string[]
}

export interface Mesh {
  meshId: string
  version: number
  servers: Record<string, MeshServer>
  origins: Record<string, MeshOrigin>
  interceptors: Record<string, MeshInterceptor>
}

export interface CoordinatorConnectMessage {
  type: typeof Message.COORDINATOR_CONNECT
  meshId: string
  role: Role
  metadata?: unknown
  interceptor?: {
    id: string
  }
  server?: {
    id: string
    origin: string
    state: State
    mode: Mode
    address?: string
  }
  threadId: number
  port: MessagePort
}

export interface PeerConnectMessage {
  type: typeof Message.PEER_CONNECT
  meshId: string
  origin: string
  interceptorId: string
  serverId: string
  port: MessagePort
}

export interface RequestMessage {
  type: typeof Message.REQUEST
  id: string
  meshId: string
  interceptorId: string
  origin: string
  path: string
  method: string
  query?: Record<string, unknown>
  headers: Record<string, string | string[] | number | undefined>
  body?: Buffer | Uint8Array | string
  bodyPort?: MessagePort
}

export interface ResponseMessage {
  type: typeof Message.RESPONSE
  id: string
  statusCode: number
  statusMessage?: string
  headers?: Record<string, string | string[] | number | undefined>
  body?: Buffer | Uint8Array | string
  bodyPort?: MessagePort
}

export interface UpgradeMessage {
  type: typeof Message.UPGRADE
  id: string
  meshId: string
  interceptorId: string
  origin: string
  path: string
  method: string
  // Value of the upgrade dispatch option, e.g. 'websocket'. Restored as the
  // upgrade request header on the server side, since undici only adds the
  // connection/upgrade headers at wire-write time.
  protocol: string
  headers: Record<string, string | string[] | number | undefined>
  // Bytes received after the request head, per the http.Server 'upgrade'
  // event contract. Always empty for WebSocket clients.
  head?: Uint8Array
  // Transferred port carrying the connection's raw bytes in both directions.
  // The handshake response travels in-band through this port as HTTP bytes.
  socketPort: MessagePort
}

export interface ErrorMessage {
  type: typeof Message.ERROR
  id: string
  error: Error
}

export function prepareMesh (meshId: string): Mesh {
  return {
    meshId,
    version: 0,
    servers: {},
    origins: {},
    interceptors: {}
  }
}
