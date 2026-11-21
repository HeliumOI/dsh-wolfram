/**
 * A small LRU with a time-to-live, used to answer an identical `wolfram` call
 * without paying another kernel start-up.
 *
 * Only deterministic-enough outcomes are cached (see `CACHEABLE_STATUSES` in
 * `index.js`): caching a timeout or a crash would hide a retry that might
 * succeed. The cache is process-local and per plugin instance, so a reload
 * starts clean.
 *
 * @module @local/dsh-wolfram/lib/cache
 */

/**
 * Create a bounded LRU cache with TTL expiry.
 *
 * @param options - entry cap, TTL, and an injectable clock for tests.
 * @returns get/set/clear plus size.
 */
export function createCache({ maxEntries, ttlMs, now = Date.now }) {
  /** Insertion order is recency order once a hit re-inserts its entry. */
  const entries = new Map()

  return {
    /**
     * Read one entry, expiring it when stale.
     *
     * @param key - cache key.
     * @returns the stored value, or undefined on a miss.
     */
    get(key) {
      const hit = entries.get(key)
      if (hit === undefined) return undefined
      if (now() - hit.at > ttlMs) {
        entries.delete(key)
        return undefined
      }
      // Refresh recency: delete+set moves the entry to the tail of the Map.
      entries.delete(key)
      entries.set(key, hit)
      return hit.value
    },

    /**
     * Store one entry, evicting the least recently used beyond the cap.
     *
     * @param key - cache key.
     * @param value - the tool result to reuse.
     */
    set(key, value) {
      entries.delete(key)
      entries.set(key, { value, at: now() })
      while (entries.size > maxEntries) {
        entries.delete(entries.keys().next().value)
      }
    },

    /** Drop every entry. */
    clear() {
      entries.clear()
    },

    /** Current entry count, for tests and diagnostics. */
    get size() {
      return entries.size
    },
  }
}

/**
 * Build the cache key for one call.
 *
 * The timeout is part of the key because the same expression under a larger
 * budget can legitimately produce a result the smaller budget could not.
 *
 * @param code - Wolfram Language source.
 * @param timeoutSec - the model's requested budget, if any.
 * @returns a collision-safe key.
 */
export function cacheKey(code, timeoutSec) {
  return `${timeoutSec ?? 'default'}\u0000${code}`
}
