import { once } from 'node:events'
import type { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import { Agent, type Dispatcher } from 'undici'

import { createInterceptor, type InterceptorFunction } from '../src/index.ts'

let counter = 0

export async function createMesh (
  t: test.TestContext,
  name: string
): Promise<{ meshId: string; coordinatorThreadId: number }> {
  const meshId = `v2-${name}-${counter++}`
  const worker = new Worker(workerURL('coordinator.ts'), { workerData: { meshId } })
  t.after(() => worker.terminate())
  await once(worker, 'message')
  return { meshId, coordinatorThreadId: worker.threadId }
}

export function workerURL (name: string): URL {
  return new URL(`./fixtures/${name}`, import.meta.url)
}

export async function createWorkerServer (
  t: test.TestContext,
  options: {
    meshId: string
    coordinatorThreadId: number
    serverId: string
    domain: string
    message?: string
    paused?: boolean
    whoamiReturn503?: boolean
    diagnostics?: boolean
    kind?: 'basic' | 'express' | 'koa' | 'server-hooks' | 'server-hook-arrays' | 'server-error-hooks' | 'graceful-close'
  }
): Promise<Worker & { hooks: string[]; diagnostics: Array<{ channel: string; message: any }> }> {
  const worker = new Worker(workerURL('worker.ts'), { workerData: options })
  ;(worker as Worker & { hooks: string[]; diagnostics: Array<{ channel: string; message: any }> }).hooks = []
  ;(worker as Worker & { hooks: string[]; diagnostics: Array<{ channel: string; message: any }> }).diagnostics = []
  worker.on('message', message => {
    if ((message as { type?: string }).type === 'hook') {
      ;(worker as Worker & { hooks: string[] }).hooks.push((message as { value: string }).value)
    }
    if ((message as { type?: string }).type === 'diagnostics') {
      ;(worker as Worker & { diagnostics: Array<{ channel: string; message: any }> }).diagnostics.push(
        message as { channel: string; message: any }
      )
    }
  })
  t.after(() => worker.terminate())
  await once(worker, 'message')
  return worker as Worker & { hooks: string[]; diagnostics: Array<{ channel: string; message: any }> }
}

export async function createAgent (
  t: test.TestContext,
  meshId: string,
  coordinatorThreadId: number,
  options: { domain?: string } = {}
): Promise<{ agent: Dispatcher; interceptor: InterceptorFunction }> {
  const interceptor = createInterceptor({ meshId, coordinatorThreadId, domain: options.domain ?? '.local' })
  t.after(() => interceptor.close())
  await interceptor.ready
  return { agent: new Agent().compose(interceptor), interceptor }
}

export async function waitForMeshServers (
  interceptor: InterceptorFunction,
  domain: string,
  count: number
): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const servers = interceptor.getMesh()?.origins[domain]?.servers.length ?? 0
    if (servers >= count) {
      return
    }
    await sleep(20)
  }
  throw new Error(`mesh did not contain ${count} server(s) for ${domain}`)
}

export async function waitForMeshServerCount (
  interceptor: InterceptorFunction,
  domain: string,
  count: number
): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const servers = interceptor.getMesh()?.origins[domain]?.servers.length ?? 0
    if (servers === count) {
      return
    }
    await sleep(20)
  }
  throw new Error(`mesh did not contain exactly ${count} server(s) for ${domain}`)
}

export async function waitForMeshOriginRemoved (interceptor: InterceptorFunction, domain: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (!interceptor.getMesh()?.origins[domain]) {
      return
    }
    await sleep(20)
  }
  throw new Error(`mesh still contained ${domain}`)
}

export async function waitForMeshServerAddress (
  interceptor: InterceptorFunction,
  serverId: string,
  address: string
): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const server = interceptor.getMesh()?.servers[serverId]
    if (server?.mode === 'tcp' && server.address === address) {
      return
    }
    await sleep(20)
  }
  throw new Error(`mesh server ${serverId} did not update to ${address}`)
}

export function requestWithTimeout<T> (promise: Promise<T>, timeout = 1000): Promise<T> {
  return Promise.race([
    promise,
    sleep(timeout).then(() => {
      throw new Error('timeout')
    })
  ])
}
