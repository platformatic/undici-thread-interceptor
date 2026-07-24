import type { MessagePort } from 'node:worker_threads'

import { MessagePortDuplex } from './message-port-streams.ts'

export interface FakeSocketAddress {
  address: string
  family: string
  port: number
}

/**
 * A MessagePortDuplex with enough of the net.Socket surface for upgrade
 * consumers (ws, @fastify/websocket, user 'upgrade' listeners) to treat it
 * as the connection they took over.
 */
export class FakeSocket extends MessagePortDuplex {
  readonly remoteAddress: string
  readonly remoteFamily: string
  readonly remotePort: number
  readonly localAddress: string
  readonly localPort: number

  constructor ({ port }: { port: MessagePort }) {
    super({ port })
    this.remoteAddress = '127.0.0.1'
    this.remoteFamily = 'IPv4'
    this.remotePort = 0
    this.localAddress = '127.0.0.1'
    this.localPort = 0
  }

  address (): FakeSocketAddress {
    return { address: this.localAddress, family: this.localFamily, port: this.localPort }
  }

  get localFamily (): string {
    return 'IPv4'
  }

  // Timeouts never fire on a tunneled connection; the callback is
  // intentionally never invoked, matching an idle-free socket.
  setTimeout (_timeout?: number, _callback?: () => void): this {
    return this
  }

  setNoDelay (_noDelay?: boolean): this {
    return this
  }

  setKeepAlive (_enable?: boolean, _initialDelay?: number): this {
    return this
  }

  ref (): this {
    return this
  }

  unref (): this {
    return this
  }
}

export interface FakeIncomingMessage {
  method: string
  url: string
  headers: Record<string, string | string[]>
  rawHeaders: string[]
  httpVersion: string
  httpVersionMajor: number
  httpVersionMinor: number
  complete: boolean
  socket: FakeSocket
  connection: FakeSocket
}

export function buildFakeRequest (
  method: string,
  url: string,
  headers: Record<string, string | string[]>,
  socket: FakeSocket
): FakeIncomingMessage {
  const rawHeaders: string[] = []

  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        rawHeaders.push(name, entry)
      }
    } else {
      rawHeaders.push(name, value)
    }
  }

  return {
    method,
    url,
    headers,
    rawHeaders,
    httpVersion: '1.1',
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    complete: true,
    socket,
    connection: socket
  }
}
