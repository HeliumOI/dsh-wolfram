/**
 * Cache semantics: TTL, LRU order, key separation, and disposal.
 *
 * These run without a kernel, so they pin the behaviour the integration test
 * can only sample once.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { cacheKey, createCache } from '../lib/cache.js'

/** A cache with an injectable clock. */
function fakeClockCache(options = {}) {
  let now = 1_000
  const cache = createCache({ maxEntries: 4, ttlMs: 100, now: () => now, ...options })
  return { cache, advance: ms => { now += ms } }
}

test('a miss returns undefined', () => {
  const { cache } = fakeClockCache()
  assert.equal(cache.get('absent'), undefined)
})

test('a stored value is returned while the TTL holds', () => {
  const { cache, advance } = fakeClockCache()
  const value = { status: 'ok', inputForm: '42' }
  cache.set('k', value)
  advance(99)
  assert.deepEqual(cache.get('k'), value)
})

test('an entry expires once the TTL has elapsed', () => {
  const { cache, advance } = fakeClockCache()
  cache.set('k', { status: 'ok' })
  advance(101)
  assert.equal(cache.get('k'), undefined)
  assert.equal(cache.size, 0, 'an expired entry is removed, not just hidden')
})

test('a hit refreshes recency, so a hot key survives eviction', () => {
  const { cache } = fakeClockCache()
  cache.set('a', { id: 'a' })
  cache.set('b', { id: 'b' })
  cache.get('a')            // a becomes most recent
  cache.set('c', { id: 'c' })
  cache.set('d', { id: 'd' }) // cap is 4, nothing evicted yet
  cache.set('e', { id: 'e' }) // evicts the least recent, which is b
  assert.equal(cache.get('b'), undefined, 'b was least recently used')
  assert.deepEqual(cache.get('a'), { id: 'a' })
  assert.equal(cache.size, 4)
})

test('the oldest entry is evicted beyond the cap', () => {
  const { cache } = fakeClockCache({ maxEntries: 2 })
  cache.set('a', { id: 'a' })
  cache.set('b', { id: 'b' })
  cache.set('c', { id: 'c' })
  assert.equal(cache.get('a'), undefined)
  assert.deepEqual(cache.get('b'), { id: 'b' })
  assert.deepEqual(cache.get('c'), { id: 'c' })
})

test('overwriting a key does not grow the cache', () => {
  const { cache } = fakeClockCache({ maxEntries: 2 })
  cache.set('a', { v: 1 })
  cache.set('a', { v: 2 })
  assert.equal(cache.size, 1)
  assert.deepEqual(cache.get('a'), { v: 2 })
})

test('the timeout is part of the key', () => {
  assert.notEqual(cacheKey('1/0', undefined), cacheKey('1/0', 5))
  assert.notEqual(cacheKey('1/0', 5), cacheKey('1/0', 10))
  assert.equal(cacheKey('1/0', undefined), cacheKey('1/0', undefined))
  // A newline or separator inside the code must not collide with another key.
  assert.notEqual(cacheKey('a\u0000b', 5), cacheKey('a', 5))
})

test('clear drops every entry', () => {
  const { cache } = fakeClockCache()
  cache.set('a', { id: 'a' })
  cache.set('b', { id: 'b' })
  cache.clear()
  assert.equal(cache.size, 0)
  assert.equal(cache.get('a'), undefined)
})
