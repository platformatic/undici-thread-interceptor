import { parentPort } from 'node:worker_threads'

import { MessagePortReadable } from '../../src/message-port-streams.ts'

parentPort?.once('message', ({ port }) => {
  const readable = new MessagePortReadable({ port })
  const chunks: Buffer[] = []

  readable.on('data', chunk => chunks.push(Buffer.from(chunk)))
  readable.on('end', () => parentPort?.postMessage({ chunks }))
})
