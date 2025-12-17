import { join } from 'path'
import { Worker } from 'worker_threads'
import { createThreadInterceptor } from '../index.js'
import { Agent, request } from 'undici'
import { once } from 'events'

const worker = new Worker(join(import.meta.dirname, '..', 'test', 'fixtures', 'worker1.js'))
await once(worker, 'online')

const interceptor = createThreadInterceptor({
  domain: '.local'
})
await interceptor.route('myserver', worker)

const agent = new Agent().compose(interceptor)

async function performRequest () {
  const res = await request('http://myserver.local', {
    dispatcher: agent
  })

  await res.body.text()
}

console.time('request')
const responses = []
for (let i = 0; i < 100000; i++) {
  responses.push(performRequest())
}
await Promise.all(responses)
console.timeEnd('request')

worker.terminate()
