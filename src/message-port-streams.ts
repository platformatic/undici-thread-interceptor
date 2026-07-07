import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { pipeline, Readable, Writable } from 'node:stream'

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
