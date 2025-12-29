'use strict'

const { test } = require('node:test')
const { RequestsStore } = require('../lib/requests-store')

test('RequestsStore extends Map', (t) => {
  const store = new RequestsStore()
  t.assert.ok(store instanceof Map)
  t.assert.ok(store instanceof RequestsStore)
})

test('basic Map operations', (t) => {
  const store = new RequestsStore()

  store.set('key1', 'value1')
  store.set('key2', 'value2')

  t.assert.strictEqual(store.size, 2)
  t.assert.strictEqual(store.get('key1'), 'value1')
  t.assert.strictEqual(store.get('key2'), 'value2')
  t.assert.strictEqual(store.has('key1'), true)
  t.assert.strictEqual(store.has('key3'), false)
})

test('delete returns correct boolean', (t) => {
  const store = new RequestsStore()

  store.set('key1', 'value1')

  const deleted = store.delete('key1')
  t.assert.strictEqual(deleted, true)
  t.assert.strictEqual(store.size, 0)

  const notDeleted = store.delete('nonexistent')
  t.assert.strictEqual(notDeleted, false)
})

test('delete triggers onDrained callback when store becomes empty', async (t) => {
  const store = new RequestsStore()

  store.set('key1', 'value1')
  store.set('key2', 'value2')

  let drainedCalled = false
  const drainedPromise = store.drained()
  drainedPromise.then(() => {
    drainedCalled = true
  })

  // Delete first item - should not trigger onDrained
  store.delete('key1')
  t.assert.strictEqual(drainedCalled, false)
  t.assert.strictEqual(store.size, 1)

  // Delete second item - should trigger onDrained
  store.delete('key2')
  await drainedPromise
  t.assert.strictEqual(drainedCalled, true)
  t.assert.strictEqual(store.size, 0)
})

test('drained returns undefined when store is already empty', (t) => {
  const store = new RequestsStore()

  const result = store.drained()
  t.assert.strictEqual(result, undefined)
})

test('drained returns promise that resolves when store becomes empty', async (t) => {
  const store = new RequestsStore()

  store.set('key1', 'value1')
  store.set('key2', 'value2')
  store.set('key3', 'value3')

  const drainedPromise = store.drained()
  t.assert.ok(drainedPromise instanceof Promise)

  let resolved = false
  drainedPromise.then(() => {
    resolved = true
  })

  // Delete items one by one
  store.delete('key1')
  await new Promise(resolve => setImmediate(resolve))
  t.assert.strictEqual(resolved, false)

  store.delete('key2')
  await new Promise(resolve => setImmediate(resolve))
  t.assert.strictEqual(resolved, false)

  store.delete('key3')
  await drainedPromise
  t.assert.strictEqual(resolved, true)
})

test('drained returns same promise on multiple calls', (t) => {
  const store = new RequestsStore()

  store.set('key1', 'value1')

  const promise1 = store.drained()
  const promise2 = store.drained()

  t.assert.strictEqual(promise1, promise2)
})

test('drained promise is reset after store becomes empty', async (t) => {
  const store = new RequestsStore()

  // First cycle
  store.set('key1', 'value1')
  const promise1 = store.drained()
  store.delete('key1')
  await promise1

  // Second cycle - should get a new promise
  store.set('key2', 'value2')
  const promise2 = store.drained()

  t.assert.notStrictEqual(promise1, promise2)

  store.delete('key2')
  await promise2
})

test('deleting non-existent key does not trigger onDrained', (t) => {
  const store = new RequestsStore()

  store.set('key1', 'value1')

  let drainedCalled = false
  const drainedPromise = store.drained()
  drainedPromise.then(() => {
    drainedCalled = true
  })

  // Try to delete non-existent key
  store.delete('nonexistent')

  // Store is not empty, so onDrained should not be called
  t.assert.strictEqual(drainedCalled, false)
  t.assert.strictEqual(store.size, 1)
})

test('multiple items can be added and removed', async (t) => {
  const store = new RequestsStore()

  // Add multiple items
  for (let i = 0; i < 10; i++) {
    store.set(`key${i}`, `value${i}`)
  }

  t.assert.strictEqual(store.size, 10)

  const drainedPromise = store.drained()

  // Remove all items
  for (let i = 0; i < 10; i++) {
    store.delete(`key${i}`)
  }

  await drainedPromise
  t.assert.strictEqual(store.size, 0)
})

test('drained with Promise.withResolvers', async (t) => {
  const store = new RequestsStore()

  store.set('key1', 'value1')

  const drainedPromise = store.drained()

  // Verify it's a proper promise
  t.assert.ok(drainedPromise instanceof Promise)
  t.assert.strictEqual(typeof drainedPromise.then, 'function')
  t.assert.strictEqual(typeof drainedPromise.catch, 'function')

  store.delete('key1')

  await drainedPromise
})
