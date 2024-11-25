'use strict'

const { test } = require('node:test')
const { strictEqual, rejects } = require('node:assert')
const { join } = require('node:path')
const { Worker } = require('node:worker_threads')
const { setTimeout: sleep } = require('node:timers/promises')
const { createThreadInterceptor } = require('../')
const { Agent, request } = require('undici')

test('two service in a mesh, one is terminated with an inflight message', async (t) => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'network-crash.js'), {
    workerData: { message: 'mesh' },
  })
  t.after(() => worker1.terminate())
  const worker2 = new Worker(join(__dirname, 'fixtures', 'network-crash.js'))
  t.after(() => worker2.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker1)
  interceptor.route('myserver2', worker2)

  const agent = new Agent().compose(interceptor)

  await sleep(1000)

  {
    const res = await request('http://myserver.local/example', {
      dispatcher: agent,
    })

    strictEqual(res.statusCode, 200)
    await res.body.dump()
  }

  {
    const res = await request('http://myserver2.local/example', {
      dispatcher: agent,
    })

    strictEqual(res.statusCode, 200)
    await res.body.dump()
  }

  console.log('all successful request completed')

  await rejects(request('http://myserver2.local/crash', {
    dispatcher: agent,
  }))

  console.log('service crashed')

  const worker2bis = new Worker(join(__dirname, 'fixtures', 'network-crash.js'))
  t.after(() => worker2bis.terminate())

  interceptor.route('myserver2', worker2bis)

  await sleep(2000)

  console.log('calling worker1')

  {
    const res = await request('http://myserver.local/example', {
      dispatcher: agent,
    })

    strictEqual(res.statusCode, 200)
    await res.body.dump()
  }

  console.log('calling worker2bis')

  {
    const res = await request('http://myserver2.local/example', {
      dispatcher: agent,
    })

    strictEqual(res.statusCode, 200)
    await res.body.dump()
  }
})
