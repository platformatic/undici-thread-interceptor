'use strict'

const { test } = require('node:test')
const { strictEqual, rejects } = require('node:assert')
const { join } = require('node:path')
const { Worker } = require('node:worker_threads')
const { setTimeout: sleep } = require('node:timers/promises')
const { createThreadInterceptor } = require('../')
const { Agent, request } = require('undici')

test('service restart with network / 1', async (t) => {
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

  await rejects(request('http://myserver2.local/crash', {
    dispatcher: agent,
  }))

  const worker2bis = new Worker(join(__dirname, 'fixtures', 'network-crash.js'))
  t.after(() => worker2bis.terminate())

  interceptor.route('myserver2', worker2bis)

  await sleep(2000)

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
})

test('service restart with network / 2', async (t) => {
  const composer = new Worker(join(__dirname, 'fixtures', 'composer.js'), {
    workerData: { name: 'composer' },
  })
  t.after(() => composer.terminate())
  const worker1 = new Worker(join(__dirname, 'fixtures', 'network-crash.js'), {
    workerData: { name: 'worker1' },
  })
  t.after(() => worker1.terminate())
  const worker2 = new Worker(join(__dirname, 'fixtures', 'network-crash.js'), {
    workerData: { name: 'worker2' },
  })
  t.after(() => worker2.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('composer', composer)
  interceptor.route('myserver', worker1)
  interceptor.route('myserver2', worker2)

  const agent = new Agent().compose(interceptor)

  await sleep(1000)

  {
    const res = await request('http://composer.local/s1/example', {
      dispatcher: agent,
    })

    strictEqual(res.statusCode, 200)
    await res.body.dump()
  }

  {
    const res = await request('http://composer.local/s2/example', {
      dispatcher: agent,
    })

    strictEqual(res.statusCode, 200)
    await res.body.dump()
  }

  {
    const res = await request('http://composer.local/s2/crash', {
      dispatcher: agent,
    })
    strictEqual(res.statusCode, 500)
    await res.body.dump()
  }

  const worker2bis = new Worker(join(__dirname, 'fixtures', 'network-crash.js'), {
    workerData: { name: 'worker2bis' },
  })
  t.after(() => worker2bis.terminate())

  interceptor.route('myserver2', worker2bis)

  await sleep(2000)

  {
    const res = await request('http://composer.local/s1/example', {
      dispatcher: agent,
    })

    strictEqual(res.statusCode, 200)
    await res.body.dump()
  }

  {
    const res = await request('http://composer.local/s2/example', {
      dispatcher: agent,
    })

    strictEqual(res.statusCode, 200)
    await res.body.dump()
  }
})

test('service restart with network / 3', async (t) => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'network-crash.js'), {
    workerData: { name: 'worker1' },
  })
  t.after(() => worker1.terminate())
  const worker2 = new Worker(join(__dirname, 'fixtures', 'network-crash.js'), {
    workerData: { name: 'worker2' },
  })
  t.after(() => worker2.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local',
  })
  interceptor.route('myserver', worker1)
  interceptor.route('myserver2', worker2)

  const agent = new Agent().compose(interceptor)

  await sleep(1000)

  {
    const res = await request('http://myserver2.local/example', {
      dispatcher: agent,
    })

    strictEqual(res.statusCode, 200)
    await res.body.dump()
  }

  await rejects(request('http://myserver2.local/crash', {
    dispatcher: agent,
  }))

  const worker2bis = new Worker(join(__dirname, 'fixtures', 'network-crash.js'), {
    workerData: { name: 'worker2bis' },
  })
  t.after(() => worker2bis.terminate())

  interceptor.route('myserver2', worker2bis)

  const composer = new Worker(join(__dirname, 'fixtures', 'composer.js'), {
    workerData: { name: 'composer' },
  })
  t.after(() => composer.terminate())

  interceptor.route('composer', composer)

  await sleep(2000)

  {
    const res = await request('http://composer.local/s1/example', {
      dispatcher: agent,
    })

    strictEqual(res.statusCode, 200)
    await res.body.dump()
  }

  {
    const res = await request('http://composer.local/s2/example', {
      dispatcher: agent,
    })

    strictEqual(res.statusCode, 200)
    await res.body.dump()
  }
})
