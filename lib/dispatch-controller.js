'use strict'

class DispatchController {
  #paused = false
  #reason = null
  #aborted = false

  get paused () {
    return this.#paused
  }

  get reason () {
    return this.#reason
  }

  get aborted () {
    return this.#aborted
  }

  pause () {
    this.#paused = true
  }

  resume () {
    this.#paused = false
  }

  abort (reason) {
    this.#aborted = true
    this.#reason = reason
  }
}

module.exports = DispatchController
