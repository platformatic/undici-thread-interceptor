import fastq from 'fastq'
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
  let lastLoop = 0
  let pipelining = 0
  let drainedPromise: Promise<void> | undefined
  let resolveDrained: (() => void) | undefined
  const queue = fastq<unknown, T, void>((item, done) => {
    processItem(item)
      .then(() => done(null))
      .catch(error => done(error as Error))
  }, MAX_QUEUE)

  // MessagePort-delivered requests are not kernel socket events. A burst of
  // posted messages can be consumed by JavaScript in one long turn, and if the
  // application handler does synchronous work, timers and control messages in
  // that worker can be starved. This queue intentionally mimics libuv fairness:
  // it processes only a bounded number of same-loop request dispatches before
  // yielding with setImmediate(), giving the worker a chance to observe timers,
  // close messages, and peer-management traffic. This is about responsiveness
  // under load, not about reordering requests or improving raw throughput.
  async function processItem (item: T): Promise<void> {
    try {
      await callback(item)
    } catch {
      // The callback owns protocol-level error handling. The queue must keep
      // draining after a failed item so later requests are not stranded.
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

  queue.error((error: Error | null) => {
    if (error) {
      process.emitWarning(`Request queue ${id} failed: ${error.message}`)
    }
  })

  queue.drain = () => {
    if (resolveDrained) {
      resolveDrained()
      drainedPromise = undefined
      resolveDrained = undefined
    }
  }

  return {
    push (item) {
      queue.push(item)
    },
    size () {
      return queue.length() + queue.running()
    },
    drained () {
      if (queue.idle()) {
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
