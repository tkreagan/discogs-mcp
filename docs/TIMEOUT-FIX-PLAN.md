# Fix: search_collection timeout on large collections

## Context

`search_collection` (and other tools using `getCompleteCollection`) times out after 45s on cold cache. The tool fetches the **entire** Discogs collection via sequential paginated API calls (1s throttle each) before filtering in memory. A 3000-item collection takes ~33s; a 5000-item collection takes ~55s, exceeding the 45s MCP client timeout. Discogs has no server-side collection search, so client-side fetch+filter is unavoidable.

The 45-minute cache TTL means this cold-start penalty recurs ~32 times/day.

## Root cause

The call chain is:

```
search_collection tool (src/mcp/tools/authenticated.ts:387)
  → cachedClient.getCompleteCollection() (src/clients/cachedDiscogs.ts:202)
    → loops through ALL pages sequentially:
      → this.searchCollection() per page (cachedDiscogs.ts:53, caches each page in KV)
        → this.client.searchCollection() (src/clients/discogs.ts:270)
          → throttleRequest() waits 1100ms (discogs.ts:150)
          → fetchWithRetry() hits Discogs API (retry.ts)
```

Each page holds 100 items. For N items, that's ceil(N/100) API calls at 1.1s each. If any call gets a 429, retry delays (3s/6s/12s exponential backoff) add more time. The `maxPages` cap is 50 (5000 items).

The same `getCompleteCollection` is called by:
* `search_collection` (authenticated.ts:459)
* `get_collection_stats` (authenticated.ts:679)
* `get_recommendations` (authenticated.ts:826, via `getCompleteCollectionReleases`)
* Resource handlers (src/mcp/resources/discogs.ts:49, 160)

## Approach: Time-budgeted fetching with auto-retry

Fetch pages until a time budget is reached. If incomplete, immediately retry. Cached pages are free (~10ms from KV, no API call, no throttle delay), so the retry spends its budget only on remaining uncached pages. The collection always loads fully within the 45s MCP timeout.

**Why this works:** `CachedDiscogsClient.searchCollection()` (line 53-86) already caches each page individually in KV under key `cache:collections:{username}:{page}:{sort}`. On auto-retry, those cached pages are served from KV instantly. Example for a 5000-item collection (50 pages):

* Pass 1 (30s budget): fetches pages 1-30 from API, each cached in KV
* Auto-retry (remaining ~12s): pages 1-30 from cache (~300ms total), pages 31-50 from API
* Total wall time: ~32-35s, well within 45s

## Changes (5 steps, in order)

### Step 1: Reduce throttle delay

**File:** `src/clients/discogs.ts`, line 150

Change `REQUEST_DELAY_MS` from `1100` to `1000`. Discogs allows 60 authenticated requests/minute = 1000ms minimum interval. The existing retry logic with exponential backoff (retry.ts) already handles 429 responses gracefully. Saves ~5s on a 50-page fetch.

```typescript
// BEFORE
private readonly REQUEST_DELAY_MS = 1100

// AFTER
private readonly REQUEST_DELAY_MS = 1000
```

### Step 2: Increase collection cache TTL

**File:** `src/utils/cache.ts`, line 302

Change `collections` TTL from `45 * 60` (45 minutes) to `4 * 60 * 60` (4 hours). Collections don't change frequently, and the cost of cold starts is high. Reduces cold starts from ~32/day to ~6/day.

```typescript
// BEFORE
collections: 45 * 60,

// AFTER
collections: 4 * 60 * 60,
```

### Step 3: Add time-budgeted fetching to `getCompleteCollection`

**File:** `src/clients/cachedDiscogs.ts`, method at lines 202-266

This is the core fix. Modify `getCompleteCollection` to:

1. Add a `timeBudgetMs` parameter (default: `35000`)
2. Replace the `cache.getOrFetch()` wrapper with manual cache check + conditional write
3. Check the time budget before each page fetch; break if exceeded
4. Return `partial: true` flag when the fetch is incomplete
5. Only write to the complete-collection cache key when the fetch is truly complete
6. Do NOT cache partial results at the complete-collection level (individual pages are already cached by `searchCollection()`)

**Return type changes to:** `DiscogsCollectionResponse & { partial?: boolean }`

**Existing methods to reuse (do not reimplement):**
* `SmartCache.get()` at `src/utils/cache.ts:72` -- read from cache directly
* `SmartCache.set()` at `src/utils/cache.ts:107` -- write to cache directly
* `CachedDiscogsClient.searchCollection()` at line 53 -- fetches a single page with per-page caching

**Implementation:**

```typescript
async getCompleteCollection(
	username: string,
	accessToken: string,
	accessTokenSecret: string,
	consumerKey: string,
	consumerSecret: string,
	maxPages: number = 50,
	timeBudgetMs: number = 35000,
): Promise<DiscogsCollectionResponse & { partial?: boolean }> {
	const cacheKey = `${username}:complete:${maxPages}`

	// 1. Check cache for a complete (non-partial) result
	const cached = await this.cache.get<DiscogsCollectionResponse & { partial?: boolean }>('collections', cacheKey)
	if (cached && !cached.partial) {
		return cached
	}

	// 2. Fetch pages with time budget
	console.log(`Fetching complete collection for ${username} (max ${maxPages} pages, budget ${timeBudgetMs}ms)`)
	const startTime = Date.now()
	let allReleases: DiscogsCollectionItem[] = []
	let currentPage = 1
	let totalPages = 1
	let actualTotalItems = 0
	let timedOut = false

	do {
		// Check time budget before each page fetch
		if (Date.now() - startTime > timeBudgetMs) {
			console.log(`Time budget exceeded after ${currentPage - 1} pages (${Date.now() - startTime}ms)`)
			timedOut = true
			break
		}

		const pageResult = await this.searchCollection(
			username,
			accessToken,
			accessTokenSecret,
			{ page: currentPage, per_page: 100 },
			consumerKey,
			consumerSecret,
		)

		if (currentPage === 1) {
			actualTotalItems = pageResult.pagination.items
		}

		allReleases = allReleases.concat(pageResult.releases)
		totalPages = Math.min(pageResult.pagination.pages, maxPages)
		currentPage++
	} while (currentPage <= totalPages)

	const isTruncated = !timedOut && actualTotalItems > allReleases.length

	const result = {
		pagination: {
			pages: totalPages,
			page: 1,
			per_page: allReleases.length,
			items: actualTotalItems || allReleases.length,
			urls: {} as { last?: string; next?: string },
		},
		releases: allReleases,
		partial: timedOut,
	}

	// 3. Only cache complete results with full TTL
	if (!timedOut) {
		await this.cache.set('collections', cacheKey, result)

		if (isTruncated) {
			console.log(
				`Collection truncated: indexed ${allReleases.length} of ${actualTotalItems} items (hit ${maxPages}-page limit).`,
			)
		}
	}
	// Partial results are NOT cached at the complete-collection level.
	// Individual pages are already cached by searchCollection(),
	// so the next call will fly through cached pages and continue from where we stopped.

	return result
}
```

### Step 4: Add auto-retry loop in each tool that calls `getCompleteCollection`

The retry loop lives at the **tool layer**, not inside `getCompleteCollection`. This keeps the fetcher simple (single pass with budget) and lets each tool manage its own overall time budget.

**Retry pattern to apply at each call site:**

```typescript
const toolStart = Date.now()
const TOOL_BUDGET_MS = 40000 // 40s total, 5s margin before 45s MCP timeout

let collection = await cachedClient.getCompleteCollection(
	username, accessToken, accessTokenSecret, consumerKey, consumerSecret,
	50, // maxPages
	30000, // first pass: 30s budget
)

// Auto-retry: cached pages are free, so retry spends budget only on uncached pages
while (collection.partial && Date.now() - toolStart < TOOL_BUDGET_MS) {
	const remaining = Math.max(TOOL_BUDGET_MS - (Date.now() - toolStart), 5000)
	collection = await cachedClient.getCompleteCollection(
		username, accessToken, accessTokenSecret, consumerKey, consumerSecret,
		50, remaining,
	)
}
```

**Apply this pattern in these locations:**

**File: `src/mcp/tools/authenticated.ts`**
* `search_collection` (line 459): Replace the single `getCompleteCollection` call with the retry loop above
* `get_collection_stats` (line 679): Same pattern
* `get_recommendations` (line 826): Same pattern, but this goes through `getCompleteCollectionReleases` -- see step 5

Keep existing truncation messaging (lines 467-469) for the edge case where even retries don't complete (truly massive collections beyond 5000 items).

**File: `src/mcp/resources/discogs.ts`**
* Line 49: Same retry pattern for collection resource handler
* Line 160: Same retry pattern for stats resource handler

### Step 5: Update `getCompleteCollectionReleases`

**File:** `src/clients/cachedDiscogs.ts`, lines 272-281

Pass through the `timeBudgetMs` parameter to the underlying `getCompleteCollection` call. The tool layer handles retry, so this method just needs to forward the budget.

```typescript
async getCompleteCollectionReleases(
	username: string,
	accessToken: string,
	accessTokenSecret: string,
	consumerKey: string,
	consumerSecret: string,
	timeBudgetMs: number = 35000,
): Promise<{ releases: DiscogsCollectionItem[]; partial?: boolean }> {
	const collection = await this.getCompleteCollection(
		username, accessToken, accessTokenSecret, consumerKey, consumerSecret,
		50, timeBudgetMs,
	)
	return { releases: collection.releases, partial: collection.partial }
}
```

Tools calling `getCompleteCollectionReleases` should apply the same retry loop from step 4, checking `result.partial`.

## Implementation order

1. Step 1 (throttle) + Step 2 (cache TTL) -- quick wins, no risk
2. Step 3 (time-budgeted `getCompleteCollection`) -- core fix
3. Step 5 (`getCompleteCollectionReleases` update) -- dependency for step 4
4. Step 4 (auto-retry in all tool callers) -- wires everything together
5. Run `npm run lint`, `npm test`, `npm run build`

## Verification

1. `npm run lint` -- code style passes
2. `npm test` -- all existing tests pass
3. `npm run build` -- compiles cleanly
4. Manual test: deploy to dev (`npm run deploy`), call `search_collection` with cold cache on a large collection, confirm it completes within 45s
5. Verify `get_collection_stats` and `get_recommendations` also complete reliably
6. Call `search_collection` a second time -- confirm it returns instantly from cache

## Files to modify

| File | What changes |
|------|-------------|
| `src/clients/discogs.ts` (line 150) | Reduce `REQUEST_DELAY_MS` from 1100 to 1000 |
| `src/utils/cache.ts` (line 302) | Increase collections TTL from 45 min to 4 hours |
| `src/clients/cachedDiscogs.ts` (lines 202-281) | Time-budgeted `getCompleteCollection` + updated `getCompleteCollectionReleases` |
| `src/mcp/tools/authenticated.ts` (lines 459, 679, 826) | Auto-retry loop at each `getCompleteCollection` call site |
| `src/mcp/resources/discogs.ts` (lines 49, 160) | Auto-retry loop at resource handler call sites |
