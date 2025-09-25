'use strict'

const { wire } = require('../../index.js')
const { parentPort, MessageChannel } = require('node:worker_threads')
const sleep = require('atomic-sleep')

// Create a message port for interval counting communication
const { port1, port2 } = new MessageChannel()

// Track interval executions in the worker thread
let intervalCount = 0
const intervalId = setInterval(() => {
  intervalCount++
}, 10) // Execute every 10ms

// Send the message port to the parent for communication
parentPort.postMessage({ type: 'interval-port', port: port2 }, [port2])

// Listen for interval count requests
port1.on('message', (message) => {
  if (message.type === 'get-interval-count') {
    port1.postMessage({ type: 'interval-count', count: intervalCount })
  } else if (message.type === 'stop-interval') {
    clearInterval(intervalId)
  }
})

function slowServer (req, res) {
  // Simulate slow processing to help saturate the queue
  const delay = parseInt(req.headers['x-delay'] || '50')

  // Use atomic-sleep for more reliable timing
  sleep(delay)

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({
    hello: 'world',
    threadId: require('node:worker_threads').threadId,
    timestamp: Date.now()
  }))
}

wire({ server: slowServer, port: parentPort })
