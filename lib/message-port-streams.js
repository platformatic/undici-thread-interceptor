'use strict'

const { Writable, Readable } = require('node:stream')

class MessagePortWritable extends Writable {
  constructor ({ port }) {
    super()
    this.messagePort = port
    this._callback = null

    this.messagePort.on('message', (control) => {
      if (control?.more) {
        const callback = this._callback
        this._callback = null
        if (callback) {
          callback()
        }
      }
    })
  }

  _writev (chunks, callback) {
    const toWrite = new Array(chunks.length)
    for (let i = 0; i < chunks.length; i++) {
      toWrite[i] = chunks[i].chunk
    }
    this.messagePort.postMessage(toWrite)
    this._callback = callback
  }

  _final (callback) {
    this.messagePort.postMessage(null)
    setImmediate(() => {
      this.messagePort.close()
      callback()
    })
  }
}

module.exports.MessagePortWritable = MessagePortWritable

class MessagePortReadable extends Readable {
  constructor ({ port }) {
    super()
    this.messagePort = port
    this.messagePort.on('message', (chunk) => {
      if (Array.isArray(chunk)) {
        for (const c of chunk) {
          this.push(c)
        }
      } else if (chunk === null) {
        this.push(null)
      }
    })
  }

  _read () {
    this.messagePort.postMessage({ more: true })
  }
}

module.exports.MessagePortReadable = MessagePortReadable
