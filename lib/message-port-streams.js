'use strict'

const { Writable, Readable, pipeline } = require('node:stream')

class MessagePortWritable extends Writable {
  #otherSideDestroyed = false

  constructor ({ port }) {
    super({ decodeStrings: false })
    this.messagePort = port
    this._callback = null

    this.messagePort.on('message', (control) => {
      if (control.more) {
        const callback = this._callback
        this._callback = null
        if (callback) {
          callback()
        }
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

  _write (chunk, encoding, callback) {
    this.messagePort.postMessage({ chunks: [chunk] })
    this._callback = callback
  }

  _writev (chunks, callback) {
    const toWrite = new Array(chunks.length)
    for (let i = 0; i < chunks.length; i++) {
      toWrite[i] = chunks[i].chunk
    }
    this.messagePort.postMessage({ chunks: toWrite })
    this._callback = callback
  }

  _destroy (err, callback) {
    if (!this.#otherSideDestroyed) {
      if (err) {
        this.messagePort.postMessage({ err })
      } else {
        this.messagePort.postMessage({ fin: true })
      }
    }
    setImmediate(() => {
      this.messagePort.close()
      callback(err)
    })
  }

  static asTransferable ({ body, worker }) {
    const channel = new MessageChannel()
    const stream = new MessagePortWritable({
      port: channel.port1
    })

    if (body && (typeof body.read === 'function' || typeof body[Symbol.asyncIterator] === 'function')) {
      // We cork the writable side so that we can fill the stream with all data ready to be read
      stream.cork()
      pipeline(body, stream, () => {
        // nothing do do here, we consume the stream and ignore errors
      })
      process.nextTick(() => {
        stream.uncork()
      })
    } else {
      stream.end(body)
      // Catch any possible error, and ignore them
      stream.on('error', () => {})
    }

    return { port: channel.port2, transferList: [channel.port2], stream }
  }
}

module.exports.MessagePortWritable = MessagePortWritable

class MessagePortReadable extends Readable {
  #otherSideDestroyed = false

  constructor ({ port }) {
    super({ decodeStrings: false })
    this.messagePort = port
    this.messagePort.on('message', (msg) => {
      if (Array.isArray(msg.chunks)) {
        for (const c of msg.chunks) {
          this.push(c)
        }
      } else if (msg.fin) {
        this.push(null)
      } else if (msg.err) {
        this.#otherSideDestroyed = true
        this.destroy(msg.err)
      }
    })

    this.messagePort.on('close', () => {
      if (!this.destroyed && !this.readableEnded) {
        this.destroy(new Error('message port closed'))
      }
    })
  }

  _read () {
    this.messagePort.postMessage({ more: true })
  }

  _destroy (err, callback) {
    if (err && !this.#otherSideDestroyed) {
      this.messagePort.postMessage({ err })
    }
    setImmediate(() => {
      this.messagePort.close()
      callback(err)
    })
  }
}

module.exports.MessagePortReadable = MessagePortReadable
