'use strict'

const { Writable, Readable } = require('node:stream')

class MessagePortWritable extends Writable {
  #otherSideDestroyed = false

  constructor ({ port }) {
    super()
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
}

module.exports.MessagePortWritable = MessagePortWritable

class MessagePortReadable extends Readable {
  #otherSideDestroyed = false

  constructor ({ port }) {
    super()
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
