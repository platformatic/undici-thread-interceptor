'use strict'

const { parentPort, workerData } = require('node:worker_threads')
const { createServer } = require('node:http')
const { wire } = require('../../')

const app = (req, res) => {
  // res.setHeader('foo', undefined)
  res.end('hello world')
}

wire({ server: app, port: parentPort })
