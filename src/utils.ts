import { Unpromise } from '@watchable/unpromise'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { postMessageToThread, threadId } from 'node:worker_threads'

export type Hooks<T extends (...args: any[]) => unknown> = T | T[]
type ThreadTransferList = Parameters<typeof postMessageToThread>[2]

export const kTimeout = Symbol('undici.thread-interceptor..timeout')

export function createId (): string {
  return randomUUID()
}

export function normalizeOrigin (origin: string | URL): string {
  if (origin instanceof URL) {
    return `${origin.protocol.slice(0, -1)}:${origin.hostname.toLowerCase()}`
  }

  const value = origin.toLowerCase()

  if (value.includes('://')) {
    const url = new URL(value)
    return `${url.protocol.slice(0, -1)}:${url.hostname}`
  }

  if (value.includes(':')) {
    return value
  }

  return `http:${value}`
}

export function sanitizeHeaders (
  headers: Record<string, string | string[] | number | undefined> = {}
): Record<string, string | string[] | number | undefined> {
  const result: Record<string, string | string[] | number | undefined> = {}

  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase()

    if (normalized === 'connection' || normalized === 'transfer-encoding') {
      continue
    }

    result[key] = value
  }

  return result
}

export async function executeWithTimeout<T> (
  promise: Promise<T>,
  timeout: number,
  timeoutValue: typeof kTimeout = kTimeout
): Promise<T | typeof kTimeout> {
  const ac = new AbortController()

  return Unpromise.race([promise, sleep(timeout, timeoutValue, { signal: ac.signal, ref: false })]).then((
    value: T | Symbol
  ) => {
    ac.abort()
    return value
  })
}

export function normalizeHooks<T extends (...args: any[]) => unknown> (hook: Hooks<T> | undefined): T[] {
  if (hook === undefined) {
    return []
  }

  const hooks = Array.isArray(hook) ? hook : [hook]
  for (const fn of hooks) {
    if (typeof fn !== 'function') {
      throw new Error(`Expected a function, got ${typeof fn}`)
    }
    if (fn.constructor.name === 'AsyncFunction') {
      throw new Error('Async hooks are not supported')
    }
  }

  return hooks
}

export function runHooks<T extends (...args: any[]) => unknown> (hooks: T[], ...args: Parameters<T>): void {
  for (const hook of hooks) {
    hook(...args)
  }
}

export function sendThreadMessage (
  destinationThreadId: number,
  value: unknown,
  transferList: ThreadTransferList = [],
  timeout?: number
): Promise<void> {
  if (destinationThreadId !== threadId) {
    return postMessageToThread(destinationThreadId, value, transferList, timeout)
  }

  return new Promise((resolve, reject) => {
    queueMicrotask(() => {
      try {
        process.emit('workerMessage', value, threadId)
        resolve()
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  })
}
