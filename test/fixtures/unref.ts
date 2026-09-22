import { strictEqual } from 'node:assert'
import { once } from 'node:events'
import { parentPort, workerData } from 'node:worker_threads'
import { Agent, request } from 'undici'
import { createInterceptor, createServer } from '../../src/index.ts'

const { meshId, mode, warm } = workerData

if (mode === 'server') {
  const server = createServer({
    meshId,
    domain: 'backend.local',
    server: async (_req: any, res: any) => {
      strictEqual(server.unref().ref().unref(), server)
      const released = once(parentPort!, 'message')
      parentPort!.unref()
      parentPort!.postMessage('pending')
      await released
      res.end('finished')
    }
  })
  await server.ready
  parentPort!.postMessage('ready')
} else {
  const interceptor = createInterceptor({ meshId, domain: '.local', connectTimeout: mode === 'timeout' ? 50 : 0 })
  // Bootstrap and later coordinator operations must retain their own reference.
  strictEqual(interceptor.unref(), interceptor)
  parentPort!.unref()
  await interceptor.ready
  await interceptor.updateMetadata({ unreferenced: true })

  if (mode === 'ref') {
    strictEqual(interceptor.ref(), interceptor)
    parentPort!.once('message', () => {
      parentPort!.postMessage('alive')
      interceptor.unref()
    })
    parentPort!.unref()
    parentPort!.postMessage('ready')
  } else {
    const dispatcher = new Agent().compose(interceptor)
    async function fetchBody (): Promise<string> {
      const { body } = await request('http://backend.local/', { dispatcher })
      return body.text()
    }
    try {
      if (warm) {
        interceptor.ref()
        await fetchBody()
        interceptor.unref()
      }
      parentPort!.postMessage(await Promise.all([fetchBody(), fetchBody()]))
    } catch (error) {
      parentPort!.postMessage((error as Error & { code?: string }).code)
    }
    // Leave idle UTI ports open to verify natural worker exit, including after errors.
  }
}
