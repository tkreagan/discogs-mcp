# Timeout Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `search_collection` (and related tools) timing out after 45s on cold cache for large Discogs collections by introducing time-budgeted fetching with automatic retry.

**Architecture:** A time budget is passed into `getCompleteCollection`; if the budget is hit before all pages are fetched, the method returns a `partial: true` result. Because each page is already cached individually in KV by `searchCollection()`, a retry call flies through the already-cached pages and continues from where the first pass stopped. The retry loop lives at the tool layer, keeping the fetcher simple.

**Tech Stack:** TypeScript, Cloudflare Workers, Cloudflare KV, Vitest

---

## Files Modified

| File | What changes |
|------|-------------|
| `src/clients/discogs.ts` | Reduce `REQUEST_DELAY_MS` from 1100 → 1000 |
| `src/utils/cache.ts` | Increase `collections` TTL from 45 min → 4 hours; update comment |
| `src/clients/cachedDiscogs.ts` | Time-budgeted `getCompleteCollection`; updated `getCompleteCollectionReleases` |
| `src/mcp/tools/authenticated.ts` | Auto-retry loop at 3 `getCompleteCollection`/`getCompleteCollectionReleases` call sites |
| `src/mcp/resources/discogs.ts` | Auto-retry loop at 2 call sites |
| `test/clients/cachedDiscogs.test.ts` | New tests for time-budget and partial-result behaviour |

---

## Task 1: Quick wins — throttle + cache TTL

**Files:**
- Modify: `src/clients/discogs.ts:150`
- Modify: `src/utils/cache.ts:302`

- [ ] **Step 1: Reduce `REQUEST_DELAY_MS`**

  In `src/clients/discogs.ts`, change line 150:

  ```typescript
  // BEFORE
  // Using 1100ms to leave a safe buffer
  private readonly REQUEST_DELAY_MS = 1100

  // AFTER
  // Discogs allows 60 authenticated requests per minute = 1000ms minimum interval
  // Retry logic in retry.ts handles any 429 responses with exponential backoff
  private readonly REQUEST_DELAY_MS = 1000
  ```

- [ ] **Step 2: Increase collections cache TTL and update comment**

  In `src/utils/cache.ts`, change line 302:

  ```typescript
  // BEFORE
  collections: 45 * 60, // Complete collection cache; aligns with getCompleteCollection's 45-min intent

  // AFTER
  collections: 4 * 60 * 60, // Complete collection cache; 4 hours — collections change infrequently
  ```

- [ ] **Step 3: Run lint and tests**

  ```bash
  npm run lint && npm test
  ```

  Expected: all tests pass, no lint errors.

- [ ] **Step 4: Commit**

  ```bash
  git add src/clients/discogs.ts src/utils/cache.ts
  git commit -m "perf: reduce request delay to 1000ms, extend collection cache TTL to 4h"
  ```

---

## Task 2: Time-budgeted `getCompleteCollection` — tests first

**Files:**
- Modify: `test/clients/cachedDiscogs.test.ts`

- [ ] **Step 1: Add failing tests for time-budget behaviour**

  Append to `test/clients/cachedDiscogs.test.ts` (after the existing describe block):

  ```typescript
  describe('CachedDiscogsClient.getCompleteCollection — time budget', () => {
    let client: CachedDiscogsClient
    let mockSearchCollection: ReturnType<typeof vi.fn>
    let kv: KVNamespace

    beforeEach(() => {
      vi.clearAllMocks()
      kv = makeKV()
      client = new CachedDiscogsClient({ setKV: vi.fn() } as unknown as DiscogsClient, kv)
      mockSearchCollection = vi.fn()
      vi.spyOn(client as never, 'searchCollection').mockImplementation(mockSearchCollection)
    })

    it('returns partial:true when time budget is exceeded mid-fetch', async () => {
      // Simulate 5-page collection where each page takes 15ms; budget is 25ms (fits ~1 page)
      mockSearchCollection.mockImplementation(
        async (_u: string, _a: string, _s: string, opts: { page: number }) => {
          await new Promise(r => setTimeout(r, 15))
          return makePageResponse(opts.page, 5, 500)
        }
      )

      const result = await client.getCompleteCollection('user', 'tok', 'sec', 'key', 'csec', 50, 25)

      expect(result.partial).toBe(true)
      expect(result.releases.length).toBeLessThan(500)
    })

    it('returns partial:false and full data when budget is sufficient', async () => {
      // 3-page collection, generous budget
      mockSearchCollection.mockImplementation((_u: string, _a: string, _s: string, opts: { page: number }) =>
        Promise.resolve(makePageResponse(opts.page, 3, 300))
      )

      const result = await client.getCompleteCollection('user', 'tok', 'sec', 'key', 'csec', 50, 30000)

      expect(result.partial).toBe(undefined) // no partial flag on complete results
      expect(result.releases).toHaveLength(300)
    })

    it('does not cache partial results at the complete-collection level', async () => {
      // Budget too tight — first call returns partial
      mockSearchCollection.mockImplementation(
        async (_u: string, _a: string, _s: string, opts: { page: number }) => {
          await new Promise(r => setTimeout(r, 15))
          return makePageResponse(opts.page, 5, 500)
        }
      )

      await client.getCompleteCollection('user', 'tok', 'sec', 'key', 'csec', 50, 25)

      // Now give generous budget — should NOT return a cached partial result
      mockSearchCollection.mockImplementation((_u: string, _a: string, _s: string, opts: { page: number }) =>
        Promise.resolve(makePageResponse(opts.page, 5, 500))
      )

      const result = await client.getCompleteCollection('user', 'tok', 'sec', 'key', 'csec', 50, 30000)

      expect(result.partial).toBeUndefined()
      expect(result.releases).toHaveLength(500)
    })

    it('caches complete result so second call makes zero API calls', async () => {
      mockSearchCollection.mockImplementation((_u: string, _a: string, _s: string, opts: { page: number }) =>
        Promise.resolve(makePageResponse(opts.page, 3, 300))
      )

      await client.getCompleteCollection('user', 'tok', 'sec', 'key', 'csec', 50, 30000)
      const callsAfterFirst = mockSearchCollection.mock.calls.length

      await client.getCompleteCollection('user', 'tok', 'sec', 'key', 'csec', 50, 30000)

      // Second call should hit KV cache; no additional searchCollection calls
      expect(mockSearchCollection.mock.calls.length).toBe(callsAfterFirst)
    })
  })
  ```

- [ ] **Step 2: Run new tests to confirm they fail**

  ```bash
  npm test -- test/clients/cachedDiscogs.test.ts
  ```

  Expected: the 4 new tests in the "time budget" describe block fail (the current implementation has no `timeBudgetMs` parameter).

---

## Task 3: Implement time-budgeted `getCompleteCollection`

**Files:**
- Modify: `src/clients/cachedDiscogs.ts:192-266`

- [ ] **Step 1: Replace `getCompleteCollection` implementation**

  Replace the method at lines 202-266 in `src/clients/cachedDiscogs.ts` with:

  ```typescript
  /**
   * Fetch the user's complete collection, assembling all paginated pages.
   * Used by tools that need to operate on the full collection in-memory
   * (search, stats, recommendations). The complete result is cached in KV,
   * so the first call on cold cache pays the pagination cost; all subsequent
   * calls return instantly.
   *
   * Time-budgeted: if `timeBudgetMs` is hit before all pages are fetched,
   * returns a result with `partial: true`. Each page is cached individually
   * by searchCollection(), so a retry call skips already-cached pages and
   * continues from where the previous call left off.
   */
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

    // Return cached complete (non-partial) result immediately
    const cached = await this.cache.get<DiscogsCollectionResponse & { partial?: boolean }>('collections', cacheKey)
    if (cached && !cached.partial) {
      return cached
    }

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

    const isTruncated = actualTotalItems > allReleases.length

    const result: DiscogsCollectionResponse & { partial?: boolean } = {
      pagination: {
        pages: totalPages,
        page: 1,
        per_page: allReleases.length,
        items: actualTotalItems || allReleases.length,
        urls: {} as { last?: string; next?: string },
      },
      releases: allReleases,
      // Only set `partial` when true — absence means complete (tests check `=== undefined`)
      ...(timedOut ? { partial: true } : {}),
    }

    // Only cache complete results. Partial results are NOT cached at the
    // complete-collection level — individual pages are already cached by
    // searchCollection(), so the next call flies through them and continues.
    if (!timedOut) {
      await this.cache.set('collections', cacheKey, result)

      if (isTruncated) {
        console.log(
          `Collection truncated: indexed ${allReleases.length} of ${actualTotalItems} items (hit ${maxPages}-page limit).`,
        )
      }
    }

    return result
  }
  ```

  Note: The new signature adds `timeBudgetMs` as a 7th parameter and changes the return type to `DiscogsCollectionResponse & { partial?: boolean }`. The existing 5-parameter callers are unaffected — TypeScript will use the defaults.

- [ ] **Step 2: Run tests**

  ```bash
  npm test -- test/clients/cachedDiscogs.test.ts
  ```

  Expected: all tests in both describe blocks pass.

- [ ] **Step 3: Commit**

  ```bash
  git add src/clients/cachedDiscogs.ts test/clients/cachedDiscogs.test.ts
  git commit -m "feat: add time-budgeted fetching to getCompleteCollection"
  ```

---

## Task 4: Update `getCompleteCollectionReleases`

**Files:**
- Modify: `src/clients/cachedDiscogs.ts:272-281`

- [ ] **Step 1: Update method to pass through `timeBudgetMs` and propagate `partial`**

  Replace `getCompleteCollectionReleases` (lines 272-281) with:

  ```typescript
  /**
   * Convenience: get just the releases array from the complete collection.
   * Passes through `timeBudgetMs` and propagates `partial` so the tool layer
   * can apply its own retry loop.
   */
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

- [ ] **Step 2: Run full test suite**

  ```bash
  npm test
  ```

  Expected: all tests pass (existing callers pass no `timeBudgetMs` and get the default).

- [ ] **Step 3: Commit**

  ```bash
  git add src/clients/cachedDiscogs.ts
  git commit -m "feat: propagate timeBudgetMs and partial through getCompleteCollectionReleases"
  ```

---

## Task 5: Auto-retry in `authenticated.ts` (3 call sites)

**Files:**
- Modify: `src/mcp/tools/authenticated.ts:459`, `679`, `826`

The retry helper pattern used at all three sites (replace each bare `getCompleteCollection` / `getCompleteCollectionReleases` call):

```typescript
const toolStart = Date.now()
const TOOL_BUDGET_MS = 40000 // 40s total; 5s margin before 45s MCP timeout

let collection = await cachedClient.getCompleteCollection(
  userProfile.username,
  session.accessToken,
  session.accessTokenSecret,
  env.DISCOGS_CONSUMER_KEY,
  env.DISCOGS_CONSUMER_SECRET,
  50,       // maxPages
  30000,    // first pass: 30s budget
)
while (collection.partial && Date.now() - toolStart < TOOL_BUDGET_MS) {
  const remaining = Math.max(TOOL_BUDGET_MS - (Date.now() - toolStart), 5000)
  collection = await cachedClient.getCompleteCollection(
    userProfile.username,
    session.accessToken,
    session.accessTokenSecret,
    env.DISCOGS_CONSUMER_KEY,
    env.DISCOGS_CONSUMER_SECRET,
    50,
    remaining,
  )
}
```

For `get_recommendations` (which uses `getCompleteCollectionReleases`), the pattern is:

```typescript
const toolStart = Date.now()
const TOOL_BUDGET_MS = 40000

let collectionResult = await cachedClient.getCompleteCollectionReleases(
  userProfile.username,
  session.accessToken,
  session.accessTokenSecret,
  env.DISCOGS_CONSUMER_KEY,
  env.DISCOGS_CONSUMER_SECRET,
  30000,
)
while (collectionResult.partial && Date.now() - toolStart < TOOL_BUDGET_MS) {
  const remaining = Math.max(TOOL_BUDGET_MS - (Date.now() - toolStart), 5000)
  collectionResult = await cachedClient.getCompleteCollectionReleases(
    userProfile.username,
    session.accessToken,
    session.accessTokenSecret,
    env.DISCOGS_CONSUMER_KEY,
    env.DISCOGS_CONSUMER_SECRET,
    remaining,
  )
}
const allReleases = collectionResult.releases
```

- [ ] **Step 1: Update `search_collection` call site (line ~459)**

  Replace the single `getCompleteCollection` call and the lines that read `allReleases = collection.releases` with the retry loop pattern above. The truncation note check (currently at line ~467) must also check `collection.partial`:

  ```typescript
  if (collection.partial || collection.pagination.items > collection.releases.length) {
    collectionTruncationNote = `\n\n⚠️ Your collection has ${collection.pagination.items} releases but only ${collection.releases.length} were indexed. Some results may be missing.`
  }
  ```

- [ ] **Step 2: Update `get_collection_stats` call site (line ~679)**

  Replace the single `getCompleteCollection` call with the retry loop. Add the same `collection.partial` truncation check after the loop, updating the existing truncation display logic accordingly.

- [ ] **Step 3: Update `get_recommendations` call site (line ~826)**

  Replace the single `getCompleteCollectionReleases` call with the `getCompleteCollectionReleases` retry variant shown above.

- [ ] **Step 4: Run lint and tests**

  ```bash
  npm run lint && npm test
  ```

  Expected: all tests pass, no lint errors.

- [ ] **Step 5: Commit**

  ```bash
  git add src/mcp/tools/authenticated.ts
  git commit -m "feat: add auto-retry loop to search_collection, get_collection_stats, get_recommendations"
  ```

---

## Task 6: Auto-retry in `discogs.ts` resources (2 call sites)

**Files:**
- Modify: `src/mcp/resources/discogs.ts:49`, `160`

- [ ] **Step 1: Update collection resource handler (line ~49)**

  This uses `getCompleteCollection` directly. Apply the `collection` retry pattern from Task 5 Step 1.

- [ ] **Step 2: Update stats resource handler (line ~160)**

  This uses `getCompleteCollectionReleases`. Apply the `collectionResult` retry pattern from Task 5 Step 3.

- [ ] **Step 3: Run lint and full test suite**

  ```bash
  npm run lint && npm test && npm run build
  ```

  Expected: lint clean, all tests pass, build succeeds.

- [ ] **Step 4: Commit**

  ```bash
  git add src/mcp/resources/discogs.ts
  git commit -m "feat: add auto-retry loop to collection and stats resource handlers"
  ```

---

## Task 7: Verification

- [ ] **Step 1: Final build check**

  ```bash
  npm run build
  ```

  Expected: compiles cleanly with no TypeScript errors.

- [ ] **Step 2: Manual test on large collection**

  Deploy to dev: `npm run deploy`

  Call `search_collection` with cold cache on a collection with 3000+ items. Confirm it completes within 45s.

- [ ] **Step 3: Verify warm-cache response**

  Call `search_collection` a second time immediately. Confirm it returns within ~1s from cache.

- [ ] **Step 4: Verify other tools**

  Call `get_collection_stats` and `get_recommendations` with cold cache. Confirm they also complete within 45s.
