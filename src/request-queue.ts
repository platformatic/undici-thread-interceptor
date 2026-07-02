import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { setImmediate } from 'node:timers/promises'

export const MAX_QUEUE = 8

export interface RequestQueue<T> {
  push: (item: T) => void
  size: () => number
  drained: () => Promise<void> | undefined
}

export function createRequestQueue<T> (id: string, callback: (item: T) => void | Promise<void>): RequestQueue<T> {
  const queue: T[] = []
  let processing = false
  let active = 0
  let lastLoop = 0
  let pipelining = 0
  let drainedPromise: Promise<void> | undefined
  let resolveDrained: (() => void) | undefined

  // MessagePort-delivered requests are not kernel socket events. A burst of
  // posted messages can be consumed by JavaScript in one long turn, and if the
  // application handler does synchronous work, timers and control messages in
  // that worker can be starved. This queue intentionally mimics libuv fairness:
  // it processes only a bounded number of same-loop request dispatches before
  // yielding with setImmediate(), giving the worker a chance to observe timers,
  // close messages, and peer-management traffic. This is about responsiveness
  // under load, not about reordering requests or improving raw throughput.
  async function processQueue (): Promise<void> {
    if (processing) {
      return
    }

    processing = true

    while (queue.length > 0) {
      const item = queue.shift() as T
      active++

      try {
        await callback(item)
      } catch {
        // The callback owns protocol-level error handling. The queue must keep
        // draining after a failed item so later requests are not stranded.
      } finally {
        active--
      }

      const currentLoop = performance.nodeTiming.uvMetricsInfo.loopCount
      if (currentLoop === lastLoop) {
        pipelining++
      } else {
        lastLoop = currentLoop
        pipelining = 0
      }

      if (pipelining >= MAX_QUEUE) {
        pipelining = 0
        await setImmediate(undefined, { ref: false })
      }
    }

    processing = false
    resolveDrainIfEmpty()
  }

  function resolveDrainIfEmpty (): void {
    if (queue.length === 0 && active === 0 && resolveDrained) {
      resolveDrained()
      drainedPromise = undefined
      resolveDrained = undefined
    }
  }

  return {
    push (item) {
      queue.push(item)
      processQueue().catch(error => {
        process.emitWarning(`Request queue ${id} failed: ${(error as Error).message}`)
      })
    },
    size () {
      return queue.length + active
    },
    drained () {
      if (queue.length === 0 && active === 0) {
        return
      }

      if (!drainedPromise) {
        const { promise, resolve } = Promise.withResolvers<void>()
        drainedPromise = promise
        resolveDrained = resolve
      }

      return drainedPromise
    }
  }
}
