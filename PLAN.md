# Load Shedding Implementation Plan

## Problem Statement

Once a request enters Node.js's event loop queue, it cannot be rejected until processing begins. This causes requests to pile up during overload, consuming memory and increasing latency. The goal is to **shed load immediately** with a 503 before requests consume resources.

```
Current:  Request → TCP Accept → Event Loop Queue → [Wait] → Process → 503 (Too Late)

Desired:  Request → TCP Accept → Load Check → 503 (Immediate, no queue entry)
                                     ↓
                              Route to Worker (if allowed)
```

## Design Principles

1. **Any thread can be the gateway** - Not limited to main thread
2. **External API for load detection** - Consumer provides the logic
3. **Library provides the hook** - Simple callback point for accept/reject decisions
4. **Check all workers** - Try each worker before shedding
5. **Non-breaking** - Opt-in feature, existing code works unchanged

## Architecture

### Load Shedding Flow (Multiple Workers)

```
Request for "api.local" (has 3 workers)
       ↓
┌──────────────────────────────────────┐
│ canAccept({ port: worker1, ... })    │ → false (busy)
│ canAccept({ port: worker2, ... })    │ → false (busy)
│ canAccept({ port: worker3, ... })    │ → true  ✓
└──────────────────────────────────────┘
       ↓
Route to worker3

──────────────────────────────────────────

Request for "api.local" (all workers busy)
       ↓
┌──────────────────────────────────────┐
│ canAccept({ port: worker1, ... })    │ → false
│ canAccept({ port: worker2, ... })    │ → false
│ canAccept({ port: worker3, ... })    │ → false
└──────────────────────────────────────┘
       ↓
503 Service Unavailable (immediate, no queue entry)
```

### Consumer Controls the Logic

The library does **not** implement load detection. Consumers provide a callback:

```javascript
const interceptor = createThreadInterceptor({
  domain: '.local',
  canAccept: (context) => {
    // context.port - the specific worker port being checked
    // context.hostname - target hostname
    // context.method, context.path, context.headers - request info

    // Consumer implements their own logic
    return isWorkerAvailable(context.port)
  }
})
```

## Implementation

### Phase 1: Add Error Type

Location: `lib/utils.js`

```javascript
class LoadSheddingError extends Error {
  constructor(message = 'Service Unavailable - Load Shedding') {
    super(message)
    this.name = 'LoadSheddingError'
    this.code = 'UND_ERR_LOAD_SHEDDING'
    this.statusCode = 503
  }
}
```

### Phase 2: Add canAccept Hook

Location: `lib/hooks.js`

Add `canAccept` to supported hooks with special handling (returns boolean).

### Phase 3: Update RoundRobin

Location: `lib/roundrobin.js`

Add method to find first accepting worker:

```javascript
findAccepting(canAcceptFn, context) {
  // Try each port starting from current index
  for (let i = 0; i < this.ports.length; i++) {
    const port = this.ports[(this.index + i) % this.ports.length]
    if (canAcceptFn({ ...context, port })) {
      this.index = (this.index + i + 1) % this.ports.length
      return port
    }
  }
  return null  // All workers busy
}
```

### Phase 4: Integrate into Interceptor

Location: `lib/interceptor.js`

```javascript
// After route lookup
const route = routes.get(hostname)
if (!route) {
  throw new Error(`No target found for ${hostname}`)
}

const context = {
  hostname,
  method: opts.method,
  path: opts.path,
  headers: opts.headers
}

// Find accepting worker (checks all if needed)
const port = hooks.canAccept
  ? route.findAccepting(hooks.canAccept, context)
  : route.next()

if (!port) {
  // All workers rejected or no workers available
  queueMicrotask(() => handler.onError(new LoadSheddingError()))
  return true
}

// Continue with selected port...
```

### Phase 5: Wire Configuration

Location: `index.js`

Accept `canAccept` in options and pass to hooks.

## Usage Examples

### Basic: Memory-based Check

```javascript
const interceptor = createThreadInterceptor({
  domain: '.local',
  canAccept: () => {
    const usage = process.memoryUsage()
    return usage.heapUsed / usage.heapTotal < 0.9
  }
})
```

### Per-Worker Tracking

```javascript
const workerLoad = new Map()

const interceptor = createThreadInterceptor({
  domain: '.local',
  canAccept: (ctx) => {
    const load = workerLoad.get(ctx.port) ?? 0
    return load < 10  // Max 10 inflight per worker
  }
})

// Track via existing hooks
interceptor.hooks.onClientRequest = (opts, ctx) => {
  const load = workerLoad.get(ctx.port) ?? 0
  workerLoad.set(ctx.port, load + 1)
}

interceptor.hooks.onClientResponse = (opts, ctx) => {
  const load = workerLoad.get(ctx.port) ?? 1
  workerLoad.set(ctx.port, load - 1)
}
```

### Circuit Breaker Per Worker

```javascript
const breakers = new Map()  // port -> CircuitBreaker

const interceptor = createThreadInterceptor({
  domain: '.local',
  canAccept: (ctx) => {
    const breaker = breakers.get(ctx.port)
    return !breaker?.opened  // Accept if circuit not open
  }
})
```

## File Changes Summary

| File | Change | Description |
|------|--------|-------------|
| `lib/utils.js` | Modify | Add `LoadSheddingError` class |
| `lib/hooks.js` | Modify | Add `canAccept` hook type |
| `lib/roundrobin.js` | Modify | Add `findAccepting()` method |
| `lib/interceptor.js` | Modify | Use canAccept check before dispatch |
| `index.js` | Modify | Accept `canAccept` option, export error |
| `test/load-shedding.test.js` | New | Tests for load shedding |

## Key Points

- **Sync callback only**: For performance. Async data should be cached separately.
- **Consumer owns the logic**: No built-in counters. Full flexibility.
- **Try all workers**: Only shed when ALL workers for a route reject.
- **Minimal overhead**: One function call per worker until one accepts.
- **Works in mesh**: Any thread with an interceptor can use this.
