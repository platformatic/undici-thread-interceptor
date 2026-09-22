import { deepStrictEqual, strictEqual } from 'node:assert'
import { once } from 'node:events'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import { Agent, request } from 'undici'
import { createCoordinator, createInterceptor, createServer } from '../src/index.ts'
import { workerURL } from './helper.ts'

for (const mode of ['request', 'timeout', 'tcp']) {
  for (const warm of mode === 'timeout' ? [false] : [false, true]) {
    test(`unref preserves remote I/O and releases idle ports: ${mode}, warm=${warm}`, { timeout: 10000 }, async t => {
      const meshId = `unref-${mode}-${warm}`
      const coordinator = createCoordinator({ meshId })
      t.after(() => coordinator.destroy())
      const handler = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
        await sleep(100)
        res.write('first')
        await sleep(100)
        res.end('last')
      }
      let target: typeof handler | string = handler
      if (mode === 'tcp') {
        const http = createHttpServer(handler).listen(0, '127.0.0.1')
        await once(http, 'listening')
        target = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
        t.after(() => {
          http.closeAllConnections()
          http.close()
        })
      }
      const server = createServer({ meshId, domain: 'backend.local', server: target })
      await server.ready
      t.after(() => server.close())
      const worker = new Worker(workerURL('unref.ts'), { workerData: { meshId, mode, warm } })
      t.after(() => worker.terminate())
      const messages: unknown[] = []
      worker.on('message', value => messages.push(value))
      strictEqual((await once(worker, 'exit'))[0], 0)
      deepStrictEqual(messages, mode === 'timeout' ? ['UND_TI_CONNECT_TIMEOUT'] : [['firstlast', 'firstlast']])
    })
  }
}

test('server unref preserves pending handlers and allows idle exit', { timeout: 10000 }, async t => {
  const meshId = 'unref-server'
  const coordinator = createCoordinator({ meshId })
  t.after(() => coordinator.destroy())
  const worker = new Worker(workerURL('unref.ts'), { workerData: { meshId, mode: 'server' } })
  t.after(() => worker.terminate())
  const exit = once(worker, 'exit')
  await once(worker, 'message')
  const interceptor = createInterceptor({ meshId, domain: '.local' })
  await interceptor.ready
  t.after(() => interceptor.close())
  const dispatcher = new Agent().compose(interceptor)
  t.after(() => dispatcher.close())
  const pending = once(worker, 'message')
  const response = request('http://backend.local/', { dispatcher })
  await pending
  // The server worker has no local timer: only its active UTI handler keeps it alive.
  await sleep(100)
  worker.postMessage('release')
  strictEqual(await (await response).body.text(), 'finished')
  strictEqual((await exit)[0], 0)
})

test('ref restores idle interceptor liveness', { timeout: 10000 }, async t => {
  const meshId = 'ref-again'
  const coordinator = createCoordinator({ meshId })
  t.after(() => coordinator.destroy())
  const worker = new Worker(workerURL('unref.ts'), { workerData: { meshId, mode: 'ref' } })
  t.after(() => worker.terminate())
  const exit = once(worker, 'exit')
  await once(worker, 'message')
  await sleep(100)
  const alive = once(worker, 'message')
  worker.postMessage('check')
  deepStrictEqual(await alive, ['alive'])
  strictEqual((await exit)[0], 0)
})
