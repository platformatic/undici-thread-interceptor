import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import { Agent, request, type Dispatcher } from 'undici'

import { createCoordinator, createInterceptor, type InterceptorFunction } from '../src/index.ts'

const requests = Number(process.env.REQUESTS ?? 100_000)
const meshId = `bench-${process.pid}`
const coordinator = createCoordinator({ meshId })
const worker = new Worker(new URL('./worker.ts', import.meta.url), {
  workerData: {
    meshId,
    coordinatorThreadId: 0,
    serverId: 'server-1',
    domain: 'myserver.local'
  }
})

try {
  await once(worker, 'message')

  const interceptor = createInterceptor({ meshId, domain: '.local', connectTimeout: 60000 })
  await interceptor.ready
  await waitForOrigin(interceptor, 'http:myserver.local')
  const agent = new Agent().compose(interceptor)

  console.time('v2 thread')
  const responses = []
  for (let i = 0; i < requests; i++) {
    responses.push(performRequest(agent))
  }
  await Promise.all(responses)
  console.timeEnd('v2 thread')

  interceptor.close()
} finally {
  await worker.terminate()
  coordinator.destroy()
}

async function performRequest (dispatcher: Dispatcher): Promise<void> {
  const res = await request('http://myserver.local', { dispatcher })
  await res.body.text()
}

async function waitForOrigin (interceptor: InterceptorFunction, origin: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (interceptor.getMesh()?.origins[origin]) {
      return
    }
    await sleep(20)
  }

  throw new Error(`mesh did not contain ${origin}`)
}
