# Load Shedding Refactoring Plan

## Summary of Review Feedback

The PR received feedback requesting architectural changes to the load shedding implementation:

1. **Performance concern** (ivan-tymoshenko): Calling `canAccept` on every request has performance impact
2. **Architecture concern**: The `canAccept` hook is on the client side, but users need server-side context (thread state, server load, etc.)
3. **Suggestion**: Move the hook to the server side and use `MESSAGE_ROUTE_UPDATE` with `ready=true/false` to control traffic flow
4. **Watt integration**: Health events are emitted in main thread with ~1s resolution; need to propagate to workers

## Current Implementation (Client-Side)

```
Client Thread                    Server Thread
     |                                |
     |--- canAccept() check --------->|  (per-request, client decides)
     |                                |
     |--- MESSAGE_REQUEST ----------->|
     |                                |
```

- `canAccept` hook defined on client-side interceptor
- Called on every request before dispatching
- Client has no context about server state

## Proposed Implementation (Server-Side Flow Control)

Two complementary control flows will be implemented:

### 1. Worker Self-Reporting

Workers can report their own accepting state based on local metrics (memory, CPU, event loop lag).

```
Server Thread                    Coordinator                    Client Threads
     |                                |                                |
     |-- setAccepting(false) -------->|                                |
     |                                |                                |
     |-- MESSAGE_WIRE --------------->|-- MESSAGE_ROUTE_UPDATE ------->|
     |   (ready=false)                |   (propagate to all)           |
     |                                |                                |
     |                                |   Client skips via kReady      |
     |                                |                                |
     |-- setAccepting(true) --------->|-- MESSAGE_ROUTE_UPDATE ------->|
     |   (ready=true, resume)         |                                |
```

### 2. Coordinator-Initiated Control

The coordinator (main thread) can pause/resume a specific worker. This is useful when health events are emitted in the main thread (e.g., Watt) and need to be propagated to all client threads.

```
Watt Health Event                Coordinator                    Client Threads
     |                                |                                |
     |-- worker unhealthy ----------->|                                |
     |                                |                                |
     |                                |-- pauseWorker(port) ---------->|
     |                                |   (sets kReady=false locally)  |
     |                                |                                |
     |                                |-- MESSAGE_ROUTE_UPDATE ------->|
     |                                |   (propagate to all workers)   |
     |                                |                                |
     |-- worker healthy ------------->|                                |
     |                                |                                |
     |                                |-- resumeWorker(port) --------->|
     |                                |   (sets kReady=true locally)   |
     |                                |                                |
     |                                |-- MESSAGE_ROUTE_UPDATE ------->|
```

## TDD Testing Strategy

Following Test-Driven Development, tests are written **before** implementation. Each cycle:
1. Write a failing test
2. Implement minimal code to pass
3. Refactor if needed

### Test File Structure

```
test/
├── flow-control.test.js          # New file for flow control tests
└── load-shedding.test.js         # Remove after migration (or keep for backward compat)
```

### Phase 1: Worker Self-Reporting (`setAccepting`)

Write tests first, then implement `setAccepting()` in `lib/wire.js`.

#### Test 1.1: `setAccepting` is exported from `wire()`
```javascript
test('wire() returns setAccepting function', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures/worker-with-set-accepting.js'))
  t.after(() => worker.terminate())

  // Worker should expose setAccepting
  const result = await once(worker, 'message')
  strictEqual(typeof result[0].hasSetAccepting, 'boolean')
  strictEqual(result[0].hasSetAccepting, true)
})
```

#### Test 1.2: `setAccepting(false)` stops worker from receiving requests
```javascript
test('setAccepting(false) stops routing to worker', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures/worker-set-accepting.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({ domain: '.local' })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  // First request should succeed
  const res1 = await request('http://myserver.local', { dispatcher: agent })
  strictEqual(res1.statusCode, 200)

  // Tell worker to stop accepting
  worker.postMessage({ type: 'setAccepting', value: false })
  await once(worker, 'message') // Wait for confirmation

  // Next request should fail (no ready workers)
  await rejects(
    request('http://myserver.local', { dispatcher: agent }),
    /No target found/
  )
})
```

#### Test 1.3: `setAccepting(true)` resumes routing
```javascript
test('setAccepting(true) resumes routing to worker', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures/worker-set-accepting.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({ domain: '.local' })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  // Stop accepting
  worker.postMessage({ type: 'setAccepting', value: false })
  await once(worker, 'message')

  // Resume accepting
  worker.postMessage({ type: 'setAccepting', value: true })
  await once(worker, 'message')

  // Request should succeed again
  const res = await request('http://myserver.local', { dispatcher: agent })
  strictEqual(res.statusCode, 200)
})
```

#### Test 1.4: `setAccepting(false)` propagates to mesh workers
```javascript
test('setAccepting(false) propagates to other workers in mesh', async (t) => {
  const worker1 = new Worker(join(__dirname, 'fixtures/worker-set-accepting.js'))
  const worker2 = new Worker(join(__dirname, 'fixtures/worker-mesh-client.js'))
  t.after(() => {
    worker1.terminate()
    worker2.terminate()
  })

  const interceptor = createThreadInterceptor({ domain: '.local' })
  await interceptor.route('server1', worker1)
  await interceptor.route('server2', worker2)

  // worker2 makes request to worker1 - should succeed
  worker2.postMessage({ type: 'request', url: 'http://server1.local' })
  const res1 = await once(worker2, 'message')
  strictEqual(res1[0].statusCode, 200)

  // worker1 stops accepting
  worker1.postMessage({ type: 'setAccepting', value: false })
  await once(worker1, 'message')

  // Give time for propagation
  await setTimeout(100)

  // worker2 makes request to worker1 - should fail
  worker2.postMessage({ type: 'request', url: 'http://server1.local' })
  const res2 = await once(worker2, 'message')
  strictEqual(res2[0].error, true)
})
```

#### Test 1.5: `setAccepting` returns promise that resolves after propagation
```javascript
test('setAccepting returns promise that resolves after propagation', async (t) => {
  const worker1 = new Worker(join(__dirname, 'fixtures/worker-set-accepting.js'))
  const worker2 = new Worker(join(__dirname, 'fixtures/worker-mesh-client.js'))
  t.after(() => {
    worker1.terminate()
    worker2.terminate()
  })

  const interceptor = createThreadInterceptor({ domain: '.local' })
  await interceptor.route('server1', worker1)
  await interceptor.route('server2', worker2)

  // Tell worker1 to stop accepting and wait for promise
  worker1.postMessage({ type: 'setAccepting', value: false })
  const result = await once(worker1, 'message')
  strictEqual(result[0].done, true)

  // By the time promise resolves, worker2 should already know
  // No need to wait - make request immediately
  worker2.postMessage({ type: 'request', url: 'http://server1.local' })
  const res = await once(worker2, 'message')
  strictEqual(res[0].error, true) // Should fail immediately, no race condition
})
```

#### Test 1.6: Round-robin skips non-accepting workers
```javascript
test('round-robin skips workers that called setAccepting(false)', async (t) => {
  const worker1 = new Worker(join(__dirname, 'fixtures/worker-set-accepting.js'))
  const worker2 = new Worker(join(__dirname, 'fixtures/worker-set-accepting.js'))
  t.after(() => {
    worker1.terminate()
    worker2.terminate()
  })

  const interceptor = createThreadInterceptor({ domain: '.local' })
  await interceptor.route('myserver', worker1)
  await interceptor.route('myserver', worker2)

  const agent = new Agent().compose(interceptor)

  // worker1 stops accepting
  worker1.postMessage({ type: 'setAccepting', value: false })
  await once(worker1, 'message')

  // All requests should go to worker2
  for (let i = 0; i < 5; i++) {
    const res = await request('http://myserver.local', { dispatcher: agent })
    strictEqual(res.statusCode, 200)
    const body = await res.body.json()
    strictEqual(body.workerId, worker2.threadId)
  }
})
```

### Phase 2: Coordinator-Initiated Control (`pauseWorker` / `resumeWorker`)

Write tests first, then implement in `lib/coordinator.js`.

#### Test 2.1: `pauseWorker` is exposed on interceptor
```javascript
test('interceptor exposes pauseWorker and resumeWorker', async (t) => {
  const interceptor = createThreadInterceptor({ domain: '.local' })

  strictEqual(typeof interceptor.pauseWorker, 'function')
  strictEqual(typeof interceptor.resumeWorker, 'function')
})
```

#### Test 2.2: `pauseWorker(port)` stops routing to that worker
```javascript
test('pauseWorker stops routing to specified worker', async (t) => {
  const worker1 = new Worker(join(__dirname, 'fixtures/worker1.js'))
  const worker2 = new Worker(join(__dirname, 'fixtures/worker1.js'))
  t.after(() => {
    worker1.terminate()
    worker2.terminate()
  })

  const interceptor = createThreadInterceptor({ domain: '.local' })

  // Get the ports when routing
  const port1 = worker1  // or however ports are obtained
  const port2 = worker2

  await interceptor.route('myserver', port1)
  await interceptor.route('myserver', port2)

  const agent = new Agent().compose(interceptor)

  // Pause worker1
  await interceptor.pauseWorker(port1)

  // All requests should go to worker2
  for (let i = 0; i < 5; i++) {
    const res = await request('http://myserver.local', { dispatcher: agent })
    strictEqual(res.statusCode, 200)
  }
})
```

#### Test 2.3: `resumeWorker(port)` resumes routing
```javascript
test('resumeWorker resumes routing to specified worker', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures/worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({ domain: '.local' })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  // Pause then resume
  await interceptor.pauseWorker(worker)
  await interceptor.resumeWorker(worker)

  // Request should succeed
  const res = await request('http://myserver.local', { dispatcher: agent })
  strictEqual(res.statusCode, 200)
})
```

#### Test 2.4: `pauseWorker` propagates to mesh workers
```javascript
test('pauseWorker propagates to all workers in mesh', async (t) => {
  const server = new Worker(join(__dirname, 'fixtures/worker1.js'))
  const client = new Worker(join(__dirname, 'fixtures/worker-mesh-client.js'))
  t.after(() => {
    server.terminate()
    client.terminate()
  })

  const interceptor = createThreadInterceptor({ domain: '.local' })
  await interceptor.route('server', server)
  await interceptor.route('client', client)

  // client makes request to server - should succeed
  client.postMessage({ type: 'request', url: 'http://server.local' })
  const res1 = await once(client, 'message')
  strictEqual(res1[0].statusCode, 200)

  // Coordinator pauses server
  await interceptor.pauseWorker(server)

  // client makes request to server - should fail
  client.postMessage({ type: 'request', url: 'http://server.local' })
  const res2 = await once(client, 'message')
  strictEqual(res2[0].error, true)
})
```

#### Test 2.5: Multiple pause/resume cycles
```javascript
test('multiple pause/resume cycles work correctly', async (t) => {
  const worker = new Worker(join(__dirname, 'fixtures/worker1.js'))
  t.after(() => worker.terminate())

  const interceptor = createThreadInterceptor({ domain: '.local' })
  await interceptor.route('myserver', worker)

  const agent = new Agent().compose(interceptor)

  for (let i = 0; i < 3; i++) {
    // Pause
    await interceptor.pauseWorker(worker)
    await rejects(request('http://myserver.local', { dispatcher: agent }))

    // Resume
    await interceptor.resumeWorker(worker)
    const res = await request('http://myserver.local', { dispatcher: agent })
    strictEqual(res.statusCode, 200)
  }
})
```

#### Test 2.6: Pause all workers returns error
```javascript
test('pausing all workers returns appropriate error', async (t) => {
  const worker1 = new Worker(join(__dirname, 'fixtures/worker1.js'))
  const worker2 = new Worker(join(__dirname, 'fixtures/worker1.js'))
  t.after(() => {
    worker1.terminate()
    worker2.terminate()
  })

  const interceptor = createThreadInterceptor({ domain: '.local' })
  await interceptor.route('myserver', worker1)
  await interceptor.route('myserver', worker2)

  const agent = new Agent().compose(interceptor)

  // Pause both workers
  await interceptor.pauseWorker(worker1)
  await interceptor.pauseWorker(worker2)

  // Request should fail with "No target found"
  await rejects(
    request('http://myserver.local', { dispatcher: agent }),
    /No target found/
  )
})
```

### Phase 3: Remove Old Implementation

After new tests pass, remove old `canAccept` tests and implementation.

#### Test 3.1: Verify old API is removed
```javascript
test('canAccept option is no longer supported', async (t) => {
  // This should either throw or be ignored
  const interceptor = createThreadInterceptor({
    domain: '.local',
    canAccept: () => true  // Should be ignored or throw
  })

  // Verify it doesn't affect behavior
  // ...
})
```

### Test Fixtures Needed

```
test/fixtures/
├── worker-set-accepting.js       # Worker that exposes setAccepting control
├── worker-mesh-client.js         # Worker that makes requests to other workers
└── worker1.js                    # Existing basic worker (reuse)
```

#### `worker-set-accepting.js`
```javascript
const { wire } = require('../../index.js')
const { parentPort } = require('worker_threads')
const { createServer } = require('http')

const server = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ workerId: require('worker_threads').threadId }))
})

const { setAccepting } = wire({ server, port: parentPort })

// Report that setAccepting is available
parentPort.postMessage({ hasSetAccepting: typeof setAccepting === 'function' })

// Handle control messages
parentPort.on('message', (msg) => {
  if (msg.type === 'setAccepting') {
    setAccepting(msg.value)
    parentPort.postMessage({ type: 'setAccepting', done: true })
  }
})
```

### TDD Implementation Order

1. **Write Phase 1 tests** → Run (all fail)
2. **Implement `setAccepting` in `lib/wire.js`** → Phase 1 tests pass
3. **Write Phase 2 tests** → Run (all fail)
4. **Implement `pauseWorker`/`resumeWorker` in `lib/coordinator.js`** → Phase 2 tests pass
5. **Write Phase 3 tests** → Run (may pass/fail depending on current state)
6. **Remove old `canAccept` code** → All tests pass
7. **Run full test suite** → Ensure no regressions

## Implementation Steps

### Step 1: Add `setAccepting` API to Wire

**File: `lib/wire.js`**

Add an async function that allows server-side control of accepting state. It returns a promise that resolves when the coordinator has propagated the change to all other workers.

```javascript
async function setAccepting(interceptor, port, accepting) {
  if (interceptor[kReady] === accepting) return

  interceptor[kReady] = accepting

  // Wait for coordinator to acknowledge propagation
  const propagatedPromise = waitMessage(port, { timeout: 5000 }, m =>
    m.type === MESSAGE_ROUTE_UPDATED && m.ready === accepting
  )

  port.postMessage({
    type: MESSAGE_WIRE,
    ready: accepting,
    address: interceptor[kAddress]
  })

  await propagatedPromise
}
```

Return this from `createWire()` alongside `replaceServer` and `close`.

### Step 2: Add `pauseWorker` / `resumeWorker` API to Coordinator

**File: `lib/coordinator.js`**

Add functions that allow the coordinator to pause/resume a specific worker. This enables the main thread (where Watt health events are emitted) to control traffic to workers.

```javascript
async function pauseWorker(interceptor, port) {
  const routes = interceptor[kRoutes]

  // Update ready state locally
  port[kReady] = false

  // Propagate to all other workers in the mesh
  const promises = []
  for (const [, roundRobin] of routes) {
    for (const otherPort of roundRobin) {
      if (otherPort === port || !otherPort[kWired]) continue

      promises.push(waitMessage(otherPort, { timeout: 5000 }, m =>
        m.type === MESSAGE_ROUTE_UPDATED && m.threadId === port[kThread]
      ))
      otherPort.postMessage({
        type: MESSAGE_ROUTE_UPDATE,
        url: /* port's url */,
        ready: false,
        threadId: port[kThread],
        address: port[kAddress]
      })
    }
  }
  await Promise.all(promises)
}

async function resumeWorker(interceptor, port) {
  // Similar to pauseWorker but with ready: true
}
```

Expose these on the interceptor object:
```javascript
interceptor.pauseWorker = pauseWorker.bind(null, interceptor)
interceptor.resumeWorker = resumeWorker.bind(null, interceptor)
```

### Step 3: Coordinator Propagation (Already Exists)

The coordinator already handles `MESSAGE_WIRE` from workers and propagates state changes via the `wire()` function in `lib/coordinator.js:131`. This sends `MESSAGE_ROUTE_UPDATE` to all other workers in the mesh.

No changes needed here for worker-initiated updates.

### Step 4: Remove Client-Side `canAccept` Hook

**File: `lib/interceptor.js`**

- Remove `canAccept` hook logic
- Keep the existing `kReady` check in `roundRobin.next()` (already returns `null` when no ready worker)
- The null check after `route.next()` already returns appropriate error

**File: `lib/roundrobin.js`**

- Remove `findAccepting()` method
- Remove `kMeta` import (only used by findAccepting)
- Keep `kReady` check in `next()` method

### Step 5: Update Hooks

**File: `lib/hooks.js`**

- Remove `canAccept` hook validation and storage

### Step 6: Simplify Metadata Handling

**File: `lib/coordinator.js`**

- Remove `meta` parameter from `addRoute()` since load shedding decisions are now server-side
- Remove `kMeta` handling

**File: `lib/utils.js`**

- Remove `LoadSheddingError` class (no longer needed, will use standard error)
- Remove `kMeta` symbol

### Step 7: Update Tests

**File: `test/load-shedding.test.js`**

- Remove tests for client-side `canAccept`
- Add tests for worker-side `setAccepting()` API:
  - Test that `setAccepting(false)` stops routing to that worker
  - Test that `setAccepting(true)` resumes routing
  - Test propagation to mesh workers
- Add tests for coordinator-side `pauseWorker()` / `resumeWorker()` API:
  - Test that `pauseWorker(port)` immediately stops routing to that worker
  - Test that `resumeWorker(port)` resumes routing
  - Test that pause/resume propagates to all workers in the mesh
  - Test multiple pause/resume cycles

### Step 8: Update Documentation

**Files: `README.md`, `docs/load-shedding.md`**

- Update with new server-side flow control approach
- Document worker-side `setAccepting()` API
- Document coordinator-side `pauseWorker()` / `resumeWorker()` API
- Provide examples for both approaches:
  - Worker local metrics (memory, event loop lag)
  - Watt health events (coordinator-initiated)

## Files to Modify

| File | Changes |
|------|---------|
| `lib/wire.js` | Add `setAccepting()` function, export from `createWire()` |
| `lib/coordinator.js` | Add `pauseWorker()` / `resumeWorker()` functions, remove `meta` parameter |
| `lib/interceptor.js` | Remove `canAccept` hook logic, simplify port selection |
| `lib/roundrobin.js` | Remove `findAccepting()` method, remove `kMeta` import |
| `lib/hooks.js` | Remove `canAccept` validation |
| `lib/utils.js` | Remove `LoadSheddingError`, remove `kMeta` |
| `index.js` | Update exports (remove LoadSheddingError) |
| `test/load-shedding.test.js` | Rewrite tests for new approach |
| `README.md` | Update documentation |
| `docs/load-shedding.md` | Update documentation |

## API Changes

### Removed
- `canAccept` option in `createThreadInterceptor()`
- `LoadSheddingError` export
- `findAccepting()` method in RoundRobin
- `meta` parameter in `addRoute()`

### Added
- `setAccepting(boolean)` returned from `wire()` function (worker-side)
- `interceptor.pauseWorker(port)` on coordinator (main thread)
- `interceptor.resumeWorker(port)` on coordinator (main thread)

## Example Usage (After Refactoring)

```javascript
// Worker thread (server-side)
const { wire } = require('undici-thread-interceptor')
const { parentPort } = require('worker_threads')

const { interceptor, replaceServer, setAccepting, close } = wire({
  server: app,
  port: parentPort
})

// Integration with Watt health events (main thread propagates to workers)
process.on('message', (msg) => {
  if (msg.type === 'health') {
    setAccepting(msg.healthy)
  }
})

// Or based on local metrics
setInterval(() => {
  const usage = process.memoryUsage()
  const overloaded = usage.heapUsed / usage.heapTotal > 0.9
  setAccepting(!overloaded)
}, 1000)
```

### Coordinator Thread (Main Thread with Watt)

```javascript
// Main thread receives health events and controls workers directly
const { createThreadInterceptor } = require('undici-thread-interceptor')

const interceptor = createThreadInterceptor({ domain: '.local' })

// Track ports for each worker
const workerPorts = new Map()

// Route workers and store their ports
const port1 = worker1.port  // or however you get the port
await interceptor.route('api', port1)
workerPorts.set(worker1.threadId, port1)

const port2 = worker2.port
await interceptor.route('api', port2)
workerPorts.set(worker2.threadId, port2)

// Watt health monitoring - coordinator pauses/resumes workers
wattHealthEmitter.on('worker:unhealthy', (workerId) => {
  const port = workerPorts.get(workerId)
  if (port) {
    interceptor.pauseWorker(port)  // Immediately stops routing to this worker
  }
})

wattHealthEmitter.on('worker:healthy', (workerId) => {
  const port = workerPorts.get(workerId)
  if (port) {
    interceptor.resumeWorker(port)  // Resumes routing to this worker
  }
})
```

## Trade-offs

**Pros:**
- Server has full context for load shedding decisions
- More efficient (no per-request hook call)
- Integrates well with existing health monitoring (Watt)
- Uses existing MESSAGE_ROUTE_UPDATE infrastructure
- Simpler client-side code

**Cons:**
- Eventual consistency (requests may pile up during propagation, ~1s delay)
- Requires explicit integration from user code
- Less granular control (binary accept/reject vs per-request decisions)

## Questions (Resolved)

1. ~~Should `setAccepting(false)` return a promise that resolves when all clients are notified?~~ **Yes** - confirmed
2. ~~Should we add automatic load detection as optional feature (queue length, event loop lag)?~~ **No** - keep it manual
3. ~~Should we keep the `meta` parameter for other use cases (worker identification)?~~ **No** - remove it
