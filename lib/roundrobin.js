'use strict'

class RoundRobin {
  constructor () {
    this.ports = []
    this.index = 0
  }

  next () {
    const port = this.ports[this.index]
    this.index = (this.index + 1) % this.ports.length
    return port
  }

  add (port) {
    this.ports.push(port)
    return this.ports.length - 1
  }

  findByThreadId (threadId) {
    return this.ports.find((p) => p.threadId === threadId)
  }

  remove (port) {
    const index = this.ports.indexOf(port)
    if (index === -1) {
      return
    }

    this.ports.splice(index, 1)

    // If the port was removed and the index is greater than the
    // length of the array, we need to reset the index
    this.index = this.index % this.ports.length
  }

  get length () {
    return this.ports.length
  }

  [Symbol.iterator] () {
    return this.ports[Symbol.iterator]()
  }
}

module.exports = RoundRobin
