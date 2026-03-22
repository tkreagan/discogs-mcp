# Fix: Collection fetch timeouts and rate limit failures

## Status

Most of the original timeout fix is already implemented:
* ~~Throttle delay reduced to 1000ms~~ ✅ (needs increase to 1500ms -- see below)
* ~~Cache TTL increased to 4 hours~~ ✅
* ~~Time-budgeted `getCompleteCollection` with `partial` flag~~ ✅
* ~~Auto-retry loops in all tools and resource handlers~~ ✅
* ~~Updated `getCompleteCollectionReleases`~~ ✅

**Still failing:** 429 rate limit errors when Claude calls multiple tools concurrently (e.g. `search_collection` + `get_recommendations`).

## Remaining problem: Concurrent tool calls defeat the throttle

When Claude calls multiple tools in the same turn, both call `getCompleteCollection()` concurrently. The KV-based throttle at `src/clients/discogs.ts:163-200` has a **race condition**: two requests read the same `lastRequestTime` from KV before either writes an update, so both proceed without adequate delay. This doubles API calls and triggers Discogs 429 responses.

The in-memory request deduplication (`pendingRequests` map in `src/utils/cache.ts:47`) only works within a single Worker isolate and cannot coordinate across concurrent HTTP requests.

## Remaining changes (2 steps)

### Step 1: Increase throttle delay for concurrency safety

**File:** `src/clients/discogs.ts`, line 150

Change `REQUEST_DELAY_MS` from `1000` to `1500`. With the race condition, two concurrent requests can both slip through. At 1500ms each, even if two requests fire simultaneously, the combined rate is ~40 req/min -- safely within Discogs' 60/min limit.

```typescript
// BEFORE
private readonly REQUEST_DELAY_MS = 1000

// AFTER
private readonly REQUEST_DELAY_MS = 1500
```

The per-page slowdown (~25s extra for 50 pages on cold cache) is absorbed by the existing auto-retry mechanism -- cached pages from pass 1 are free on retry.

### Step 2: Add fetch lock to prevent concurrent collection fetches

**File:** `src/clients/cachedDiscogs.ts`

Add a KV-based lock so that when one tool call is already fetching the collection, other callers poll the cache for the result instead of starting their own concurrent fetch.

**SmartCache needs a `getKV()` accessor.** Add to `src/utils/cache.ts`:

```typescript
// Add to SmartCache class
getKV(): KVNamespace {
	return this.kv
}
```

**Add lock helpers to CachedDiscogsClient:**

```typescript
private readonly FETCH_LOCK_TTL = 120 // 2 minutes - long enough for a full fetch

/**
 * Try to acquire a fetch lock in KV. Returns true if lock was acquired.
 * Uses a short TTL so locks auto-expire if the fetcher crashes.
 */
private async tryAcquireFetchLock(lockKey: string): Promise<boolean> {
	try {
		const kv = this.cache.getKV()
		const existing = await kv.get(lockKey)
		if (existing) {
			return false // Lock is held
		}
		// Write lock. There's still a small race window here, but it's
		// much narrower than the throttle race (single KV write vs.
		// entire pagination loop). Worst case: two fetchers run, but
		// the wider throttle delay (1500ms) keeps us within rate limits.
		await kv.put(lockKey, Date.now().toString(), {
			expirationTtl: this.FETCH_LOCK_TTL,
		})
		return true
	} catch {
		return true // Fail open: if KV errors, proceed with fetch
	}
}

private async releaseFetchLock(lockKey: string): Promise<void> {
	try {
		await this.cache.getKV().delete(lockKey)
	} catch {
		// Lock will auto-expire via TTL
	}
}
```

**Modify `getCompleteCollection`** to use the lock. Insert between the cache check and the pagination loop:

```typescript
// After the cache check (existing code), before the pagination loop:

const lockKey = `fetch-lock:collection:${username}`
const acquiredLock = await this.tryAcquireFetchLock(lockKey)

if (!acquiredLock) {
	// Another caller is already fetching. Poll for the cached result.
	console.log(`Collection fetch already in progress for ${username}, waiting for cache...`)
	const pollStart = Date.now()
	const POLL_TIMEOUT_MS = Math.min(timeBudgetMs, 45000)
	const POLL_INTERVAL_MS = 2000

	while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
		const result = await this.cache.get<DiscogsCollectionResponse & { partial?: boolean }>('collections', cacheKey)
		if (result && !result.partial) {
			return result
		}
	}
	// Polling timed out -- fall through and try to fetch (lock will have expired)
}

// Wrap the existing pagination loop in try/finally:
try {
	// ... existing pagination + caching code ...
} finally {
	if (acquiredLock) {
		await this.releaseFetchLock(lockKey)
	}
}
```

## How the fix works end-to-end

**Scenario: Claude calls search_collection + get_recommendations on cold cache**

1. **Request A** (`search_collection`) arrives first:
   * Cache miss → acquires fetch lock → starts pagination at 1500ms/page
   * Time budget hit → returns partial → auto-retry (cached pages free) → completes
   * Full collection cached, lock released

2. **Request B** (`get_recommendations`) arrives concurrently:
   * Cache miss → sees fetch lock → polls cache every 2s
   * When Request A caches the full result, Request B's poll finds it
   * Request B returns with zero API calls

**Result:** Only one set of API calls, no 429s, both tools complete within 45s.

## Verification

1. `npm run lint` -- code style passes
2. `npm test` -- all existing tests pass
3. `npm run build` -- compiles cleanly
4. Manual test: call `search_collection` + `get_recommendations` in same turn -- confirm no 429 errors
5. Call `search_collection` alone on cold cache -- confirm it completes within 45s

## Files to modify

| File | What changes |
|------|-------------|
| `src/clients/discogs.ts` (line 150) | Increase `REQUEST_DELAY_MS` from 1000 to 1500 |
| `src/utils/cache.ts` | Add `getKV()` accessor method to SmartCache |
| `src/clients/cachedDiscogs.ts` | Add fetch lock helpers + lock logic in `getCompleteCollection` |
