import diagnosticsChannel from 'node:diagnostics_channel'
import { parentPort, workerData } from 'node:worker_threads'

import { createCoordinator } from '../../src/index.ts'

if (workerData.diagnostics) {
  diagnosticsChannel.channel('undici-thread-interceptor:mesh:update').subscribe(message => {
    parentPort?.postMessage({ type: 'diagnostics', channel: 'mesh:update', message })
  })
}

const coordinator = createCoordinator({ meshId: workerData.meshId })

parentPort?.postMessage({ type: 'ready' })

parentPort?.on('message', message => {
  if (message === 'close') {
    coordinator.destroy()
    parentPort?.postMessage({ type: 'closed' })
  }
})
