import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { Duplex, pipeline, Readable, Writable } from 'node:stream'

interface StreamControl {
  chunks?: unknown[]
  more?: boolean
  fin?: boolean
  err?: Error
}

export class MessagePortWritable extends Writable {
  messagePort: MessagePort
  #callback: ((error?: Error | null) => void) | null
  #otherSideDestroyed: boolean

  constructor ({ port }: { port: MessagePort }) {
    super()
    this.messagePort = port
    this.#callback = null
    this.#otherSideDestroyed = false

    this.messagePort.on('message', (control: StreamControl) => {
      if (control.more) {
        const callback = this.#callback
        this.#callback = null
        callback?.()
      } else if (control.err) {
        this.#otherSideDestroyed = true
        this.destroy(control.err)
      }
    })

    this.messagePort.on('close', () => {
      if (!this.destroyed && !this.writableFinished) {
        this.destroy(new Error('message port closed'))
      }
    })
  }

  _write (chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.messagePort.postMessage({ chunks: [chunk] })
    this.#callback = callback
  }

  _writev (chunks: Array<{ chunk: unknown }>, callback: (error?: Error | null) => void): void {
    this.messagePort.postMessage({ chunks: chunks.map(({ chunk }) => chunk) })
    this.#callback = callback
  }

  _destroy (err: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.#otherSideDestroyed) {
      this.messagePort.postMessage(err ? { err } : { fin: true })
    }

    setImmediate(() => {
      this.messagePort.close()
      callback(err)
    })
  }

  static asTransferable (body: NodeJS.ReadableStream): { port: MessagePort; transferList: MessagePort[] } {
    const channel = new MessageChannel()
    const stream = new MessagePortWritable({ port: channel.port1 })

    stream.cork()
    pipeline(body, stream, () => {})
    process.nextTick(() => stream.uncork())

    return { port: channel.port2, transferList: [channel.port2] }
  }
}

export function toBufferChunk (chunk: unknown): Buffer | string {
  if (Buffer.isBuffer(chunk) || typeof chunk === 'string') {
    return chunk
  }

  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  }

  return Buffer.from(chunk as ArrayBuffer)
}

export class MessagePortDuplex extends Duplex {
  messagePort: MessagePort
  #callback: ((error?: Error | null) => void) | null
  #otherSideDestroyed: boolean
  #finReceived: boolean
  #finSent: boolean

  constructor ({ port, allowHalfOpen = false }: { port: MessagePort; allowHalfOpen?: boolean }) {
    // allowHalfOpen defaults to false to mirror net.Socket semantics, which is
    // what ws and undici expect from an upgraded connection.
    super({ allowHalfOpen })
    this.messagePort = port
    this.#callback = null
    this.#otherSideDestroyed = false
    this.#finReceived = false
    this.#finSent = false

    this.messagePort.on('message', (control: StreamControl) => {
      if (Array.isArray(control.chunks)) {
        for (const chunk of control.chunks) {
          this.push(toBufferChunk(chunk))
        }
      } else if (control.more) {
        const callback = this.#callback
        this.#callback = null
        callback?.()
      } else if (control.fin) {
        this.#finReceived = true
        this.push(null)
      } else if (control.err) {
        this.#otherSideDestroyed = true
        this.destroy(control.err)
      }
    })

    this.messagePort.on('close', () => {
      if (!this.destroyed && !(this.#finReceived && this.writableFinished)) {
        this.destroy(new Error('message port closed'))
      }
    })
  }

  _read (): void {
    this.messagePort.postMessage({ more: true })
  }

  _write (chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.messagePort.postMessage({ chunks: [chunk] })
    this.#callback = callback
  }

  _writev (chunks: Array<{ chunk: unknown }>, callback: (error?: Error | null) => void): void {
    this.messagePort.postMessage({ chunks: chunks.map(({ chunk }) => chunk) })
    this.#callback = callback
  }

  _final (callback: (error?: Error | null) => void): void {
    this.#finSent = true
    this.messagePort.postMessage({ fin: true })
    callback()
  }

  _destroy (err: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.#otherSideDestroyed) {
      if (err) {
        this.messagePort.postMessage({ err })
      } else if (!this.#finSent) {
        this.messagePort.postMessage({ fin: true })
      }
    }

    setImmediate(() => {
      this.messagePort.close()
      callback(err)
    })
  }
}

export class MessagePortReadable extends Readable {
  messagePort: MessagePort
  #otherSideDestroyed: boolean
  #finReceived: boolean

  constructor ({ port }: { port: MessagePort }) {
    super()
    this.messagePort = port
    this.#otherSideDestroyed = false
    this.#finReceived = false

    this.messagePort.on('message', (msg: StreamControl) => {
      if (Array.isArray(msg.chunks)) {
        for (const chunk of msg.chunks) {
          this.push(chunk)
        }
      } else if (msg.fin) {
        this.#finReceived = true
        this.push(null)
      } else if (msg.err) {
        this.#otherSideDestroyed = true
        this.destroy(msg.err)
      }
    })

    this.messagePort.on('close', () => {
      if (!this.destroyed && !this.readableEnded && !this.#finReceived) {
        this.destroy(new Error('message port closed'))
      }
    })
  }

  _read (): void {
    this.messagePort.postMessage({ more: true })
  }

  _destroy (err: Error | null, callback: (error?: Error | null) => void): void {
    if (err && !this.#otherSideDestroyed) {
      this.messagePort.postMessage({ err })
    }

    setImmediate(() => {
      this.messagePort.close()
      callback(err)
    })
  }
}
