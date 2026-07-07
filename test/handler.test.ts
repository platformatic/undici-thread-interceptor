import { AsyncLocalStorage } from 'node:async_hooks'
import { deepStrictEqual, strictEqual } from 'node:assert'
import { test } from 'node:test'
import { Agent, request, type Dispatcher } from 'undici'

import { createAgent, createMesh, createWorkerServer, waitForMeshServers } from './helper.ts'

test('supports undici handler pause and resume lifecycle', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'handler-lifecycle')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'handler.local' })
  const { interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:handler.local', 1)
  const calls: string[] = []
  const testInterceptor = (dispatch: Dispatcher.Dispatch): Dispatcher.Dispatch => {
    return (opts, handler) => {
      return dispatch(opts, {
        onRequestStart (controller, context) {
          calls.push('request-start')
          strictEqual(controller.paused, false)
          controller.pause()
          strictEqual(controller.paused, true)
          controller.resume()
          strictEqual(controller.paused, false)
          handler.onRequestStart?.(controller, context)
        },
        onResponseStart (controller, statusCode, headers, statusMessage) {
          calls.push('response-start')
          strictEqual(statusCode, 200)
          strictEqual(typeof headers, 'object')
          return handler.onResponseStart?.(controller, statusCode, headers, statusMessage)
        },
        onResponseData (controller, chunk) {
          handler.onResponseData?.(controller, chunk)
        },
        onResponseEnd (controller, trailers) {
          handler.onResponseEnd?.(controller, trailers)
        },
        onResponseError (controller, error) {
          handler.onResponseError?.(controller, error)
        }
      })
    }
  }
  const agent = new Agent().compose(interceptor, testInterceptor)

  const { statusCode, body } = await request('http://handler.local', { dispatcher: agent })

  strictEqual(statusCode, 200)
  deepStrictEqual(await body.json(), { hello: 'world' })
  deepStrictEqual(calls, ['request-start', 'response-start'])
})

test('preserves AsyncLocalStorage through composed interceptors', async t => {
  const { meshId, coordinatorThreadId } = await createMesh(t, 'async-local-storage')
  await createWorkerServer(t, { meshId, coordinatorThreadId, serverId: 'server-1', domain: 'als.local' })
  const { interceptor } = await createAgent(t, meshId, coordinatorThreadId)
  await waitForMeshServers(interceptor, 'http:als.local', 1)
  const storage = new AsyncLocalStorage<number>()
  const seen: Record<string, unknown> = {}
  const createTestInterceptor = (name: string) => {
    return (dispatch: Dispatcher.Dispatch): Dispatcher.Dispatch => {
      return (opts, handler) => {
        return dispatch(opts, {
          onRequestStart (controller, context) {
            seen[`${name}:request`] = storage.getStore()
            handler.onRequestStart?.(controller, context)
          },
          onResponseStart (controller, statusCode, headers, statusMessage) {
            seen[`${name}:response`] = storage.getStore()
            return handler.onResponseStart?.(controller, statusCode, headers, statusMessage)
          },
          onResponseData (controller, chunk) {
            handler.onResponseData?.(controller, chunk)
          },
          onResponseEnd (controller, trailers) {
            handler.onResponseEnd?.(controller, trailers)
          },
          onResponseError (controller, error) {
            handler.onResponseError?.(controller, error)
          }
        })
      }
    }
  }
  const agent = new Agent().compose(interceptor, createTestInterceptor('first'), createTestInterceptor('second'))

  await storage.run(42, async () => {
    const { statusCode, body } = await request('http://als.local', { dispatcher: agent })
    strictEqual(statusCode, 200)
    await body.json()
  })

  deepStrictEqual(seen, {
    'first:request': 42,
    'second:request': 42,
    'second:response': 42,
    'first:response': 42
  })
})
