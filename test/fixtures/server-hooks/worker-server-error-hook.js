'use strict'

const { parentPort } = require('worker_threads')
const { wire } = require('../../..')

wire({
  server: function (req, res) {
    res.destroy(new Error('kaboom'))
  },
  port: parentPort,
  onServerError: error => {
    console.log('onServerError called:', error.message)
  }
})
