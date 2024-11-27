'use strict'

class WrapHandler {
  #handler

  constructor (handler) {
    this.#handler = handler
  }

  onRequestStart (controller, context) {
    this.#handler.onConnect?.((err) => controller.abort(err), context)
  }

  onResponseStart (controller, statusCode, headers, statusMessage) {
    const rawHeaders = []
    for (const [key, val] of Object.entries(headers)) {
      rawHeaders.push(Buffer.from(key), Buffer.from(val))
    }

    this.#handler.onHeaders?.(
      statusCode,
      rawHeaders,
      () => {},
      statusMessage
    )
  }

  onResponseData (controller, data) {
    this.#handler.onData?.(data)
  }

  onResponseEnd () {
    this.#handler.onComplete?.([])
  }

  onResponseError (controller, err) {
    process._rawDebug('WrapHandler.onResponseError', err)
    this.#handler.onError?.(err)
  }
}

module.exports = WrapHandler
