'use strict'

const { parentPort } = require('node:worker_threads')
const { wire } = require('../../')

const app = (req, res) => {
  // res.setHeader('foo', undefined)
  res.end('hello world')
}

wire({ server: app, port: parentPort })
