import { Unpromise } from '@watchable/unpromise'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { postMessageToThread, threadId } from 'node:worker_threads'

export type Hooks<T extends (...args: any[]) => unknown> = T | T[]
type ThreadTransferList = Parameters<typeof postMessageToThread>[2]
type HeaderValue = string | string[] | number | undefined
type HeaderRecord = Record<string, HeaderValue>
type HeaderEntries = Array<[string, HeaderValue]>

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

export function sanitizeHeaders (headers: HeaderRecord | HeaderEntries | undefined, host: string): HeaderRecord {
  if (Array.isArray(headers)) {
    const result: HeaderRecord = { host }

    for (const [key, value] of headers) {
      if (key !== 'connection' && key !== 'Connection' && key !== 'transfer-encoding' && key !== 'Transfer-Encoding') {
        result[key] = value
      }
    }

    return result
  }

  if (!headers) {
    return { host }
  }

  const hasConnection = Object.hasOwn(headers, 'connection')
  const hasTitleConnection = Object.hasOwn(headers, 'Connection')
  const hasTransferEncoding = Object.hasOwn(headers, 'transfer-encoding')
  const hasTitleTransferEncoding = Object.hasOwn(headers, 'Transfer-Encoding')

  if (
    headers.host === host &&
    !hasConnection &&
    !hasTitleConnection &&
    !hasTransferEncoding &&
    !hasTitleTransferEncoding
  ) {
    return headers
  }

  const result = Object.assign({}, headers, { host })
  delete result.connection
  delete result.Connection
  delete result['transfer-encoding']
  delete result['Transfer-Encoding']
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
