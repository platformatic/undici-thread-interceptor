'use strict'

const { parentPort } = require('worker_threads')
const { wire } = require('../../')

const dispatcher = wire({ port: parentPort })

parentPort.on('message', (message) => {
  if (message === 'test-replace-server-undefined') {
    try {
      dispatcher.replaceServer(undefined)
      parentPort.postMessage({ error: null })
    } catch (err) {
      parentPort.postMessage({ error: err.message })
    }
  }
  if (message === 'test-replace-server-no-args') {
    try {
      dispatcher.replaceServer()
      parentPort.postMessage({ error: null })
    } catch (err) {
      parentPort.postMessage({ error: err.message })
    }
  }
})
