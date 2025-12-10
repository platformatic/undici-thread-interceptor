'use strict'

const { test } = require('node:test')
const { deepStrictEqual, rejects, strictEqual } = require('node:assert')
const { join } = require('path')
const { Worker } = require('worker_threads')
const { createThreadInterceptor } = require('../')
const { Agent, request, interceptors } = require('undici')
const { once } = require('events')
const { RoundRobin } = require('../lib/roundrobin')

test('round-robin .route with array', async t => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'worker1.js'), {
    workerData: { message: 'mesh' }
  })
  t.after(() => worker1.terminate())
  const worker2 = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker2.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('myserver', [worker1, worker2])

  const agent = new Agent().compose(interceptor)

  {
    const { body } = await request('http://myserver.local/whoami', {
      dispatcher: agent
    })

    deepStrictEqual(await body.json(), { threadId: worker1.threadId })
  }

  {
    const { body } = await request('http://myserver.local/whoami', {
      dispatcher: agent
    })

    deepStrictEqual(await body.json(), { threadId: worker2.threadId })
  }
})

test('round-robin multiple .route', async t => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'worker1.js'), {
    workerData: { message: 'mesh' }
  })
  t.after(() => worker1.terminate())
  const worker2 = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker2.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('myserver', worker1)
  await interceptor.route('myserver', worker2)

  const agent = new Agent().compose(interceptor)

  {
    const { body } = await request('http://myserver.local/whoami', {
      dispatcher: agent
    })

    deepStrictEqual(await body.json(), { threadId: worker1.threadId })
  }

  {
    const { body } = await request('http://myserver.local/whoami', {
      dispatcher: agent
    })

    deepStrictEqual(await body.json(), { threadId: worker2.threadId })
  }
})

test('round-robin one worker exits', async t => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'worker1.js'), {
    workerData: { message: 'mesh' }
  })
  t.after(() => worker1.terminate())
  const worker2 = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker2.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('myserver', worker1)
  await interceptor.route('myserver', worker2)

  const agent = new Agent().compose(interceptor)

  {
    const { body } = await request('http://myserver.local/whoami', {
      dispatcher: agent
    })

    deepStrictEqual(await body.json(), { threadId: worker1.threadId })
  }

  worker2.terminate()
  // We must wait for the worker to exit
  // otherwise the next request will
  await once(worker2, 'exit')

  {
    const { body } = await request('http://myserver.local/whoami', {
      dispatcher: agent
    })

    deepStrictEqual(await body.json(), { threadId: worker1.threadId })
  }
})

test('round-robin one worker exits, in flight request', async t => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'worker1.js'), {
    workerData: { message: 'mesh' }
  })
  t.after(() => worker1.terminate())
  const worker2 = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker2.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('myserver', worker1)
  await interceptor.route('myserver', worker2)

  const agent = new Agent().compose(interceptor)

  {
    const { body } = await request('http://myserver.local/whoami', {
      dispatcher: agent
    })

    deepStrictEqual(await body.json(), { threadId: worker1.threadId })
  }

  worker2.terminate()

  await rejects(
    request('http://myserver.local/whoami', {
      dispatcher: agent
    })
  )
})

test('round-robin one worker is using network', async t => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'network.js'))
  t.after(() => worker1.terminate())

  const worker2 = new Worker(join(__dirname, 'fixtures', 'network.js'), { workerData: { network: true } })
  t.after(() => worker2.terminate())

  const worker3 = new Worker(join(__dirname, 'fixtures', 'network.js'))
  t.after(() => worker3.terminate())

  const interceptor = createThreadInterceptor({ domain: '.local' })
  const p1 = interceptor.route('myserver', worker1)
  const p2 = interceptor.route('myserver', worker2)
  const p3 = interceptor.route('myserver', worker3)

  // Wait for the second worker to advertise its port
  await once(worker2, 'message')
  await Promise.all([p1, p2, p3])

  const responses = []
  for (let i = 0; i < 3; i++) {
    const agent = new Agent().compose(interceptor)

    const { body } = await request('http://myserver.local', { dispatcher: agent })

    responses.push(await body.json())
  }

  deepStrictEqual(responses, [{ via: 'thread' }, { via: 'network' }, { via: 'thread' }])
})

test('RoundRobin delete unknown port', () => {
  const rr = new RoundRobin()
  rr.delete({})
})

test('503 status code retries it', async t => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'worker1.js'), {
    workerData: {
      message: 'mesh',
      whoamiReturn503: true
    }
  })
  t.after(() => worker1.terminate())
  const worker2 = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker2.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('myserver', [worker1, worker2])

  const agent = new Agent().compose(interceptor, interceptors.retry())

  {
    const { body, statusCode } = await request('http://myserver.local/whoami', {
      dispatcher: agent
    })

    strictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { threadId: worker2.threadId })
  }

  {
    const { body, statusCode } = await request('http://myserver.local/whoami', {
      dispatcher: agent
    })

    strictEqual(statusCode, 200)
    deepStrictEqual(await body.json(), { threadId: worker2.threadId })
  }
})

test('round-robin multiple add/remove operations', async t => {
  const worker1 = new Worker(join(__dirname, 'fixtures', 'worker1.js'), {
    workerData: { message: 'mesh' }
  })
  t.after(() => worker1.terminate())
  const worker2 = new Worker(join(__dirname, 'fixtures', 'worker1.js'))
  t.after(() => worker2.terminate())

  const interceptor = createThreadInterceptor({
    domain: '.local'
  })
  await interceptor.route('myserver', worker1)
  await interceptor.addRoute('myserver', worker2)

  const agent = new Agent().compose(interceptor)
  async function whoami (expectedWorker) {
    const { body } = await request('http://myserver.local/whoami', { dispatcher: agent })

    deepStrictEqual(await body.json(), { threadId: expectedWorker.threadId })
  }

  await whoami(worker1)
  await whoami(worker2)

  await interceptor.unroute('myserver', worker1)
  // This should be a no-op since the worker no longer in the round-robin
  await interceptor.removeRoute('myserver', worker1)

  await whoami(worker2)
  await whoami(worker2)

  await interceptor.route('myserver', worker1)
  // This should be a no-op since the worker is already in the round-robin
  interceptor.addRoute('myserver', worker2)

  await whoami(worker2)
  await whoami(worker1)

  await interceptor.unroute('myserver', worker1)
  await interceptor.removeRoute('myserver', worker2)

  await rejects(() => request('http://myserver.local/whoami', { dispatcher: agent }), {
    message: 'No target found for myserver.local in thread 0.'
  })

  await interceptor.close()

  await rejects(() => interceptor.route('myserver', worker1), { message: 'The dispatcher has been closed.' })
  await rejects(() => interceptor.unroute('myserver', worker1), { message: 'The dispatcher has been closed.' })
  await interceptor.unroute('myserver', worker1, true)
})
