'use strict'

const { parentPort } = require('worker_threads')
const { wire } = require('../../..')

wire({
  server: function (_req, res) {
    res.destroy(new Error('kaboom'))
  },
  port: parentPort,
  onServerError: (_req, _rep, error) => {
    console.log('onServerError called:', error.message)
  }
})
