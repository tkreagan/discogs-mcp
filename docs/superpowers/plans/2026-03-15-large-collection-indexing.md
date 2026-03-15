# Large Collection Indexing Fix — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix incomplete results for Discogs collections larger than 2,500 items by raising the page cap to 50, correctly reporting the real collection total, and surfacing truncation warnings in tool output.

**Architecture:** Three focused changes — fix `getCompleteCollection` in the caching client, fix the `collections` KV TTL in `SmartCache`, and update the two tool handlers to detect and display truncation. No new files needed.

**Tech Stack:** TypeScript, Cloudflare Workers, Vitest

**Branch:** `fix/large-collection-indexing`
**Worktree:** `.worktrees/fix/large-collection-indexing`
**Spec:** `docs/superpowers/specs/2026-03-15-large-collection-indexing-design.md`
**Issue:** https://github.com/rianvdm/discogs-mcp/issues/6

---

## Chunk 1: Fix `getCompleteCollection` and `SmartCache` TTL

### Task 1: Write failing tests for `getCompleteCollection`

**Files:**
- Create: `test/clients/cachedDiscogs.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
// test/clients/cachedDiscogs.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CachedDiscogsClient } from '../../src/clients/cachedDiscogs'
import { DiscogsClient } from '../../src/clients/discogs'

// Minimal KV mock — only methods actually used by SmartCache
function makeKV(store: Map<string, string> = new Map()): KVNamespace {
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value) }),
    delete: vi.fn(async (key: string) => { store.delete(key) }),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cursor: '' })),
  } as unknown as KVNamespace
}

function makePageResponse(page: number, totalPages: number, totalItems: number, releases: object[] = []) {
  return {
    pagination: { page, pages: totalPages, per_page: 100, items: totalItems, urls: {} },
    releases,
  }
}

describe('CachedDiscogsClient.getCompleteCollection', () => {
  let client: CachedDiscogsClient
  let mockSearchCollection: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    const kv = makeKV()
    // CachedDiscogsClient constructor: (client: DiscogsClient, kv: KVNamespace)
    // The inner DiscogsClient is irrelevant here — we spy on searchCollection directly.
    client = new CachedDiscogsClient({} as DiscogsClient, kv)
    // Spy on the internal searchCollection so we can control page responses
    mockSearchCollection = vi.fn()
    vi.spyOn(client as never, 'searchCollection').mockImplementation(mockSearchCollection)
  })

  it('returns pagination.items equal to the real Discogs total, not truncated count', async () => {
    // 40 pages = 4000 items, but maxPages default is 50, so all pages are fetched
    const totalItems = 4000
    const totalPages = 40
    mockSearchCollection.mockImplementation((_u: string, _a: string, _s: string, opts: { page: number }) => {
      return Promise.resolve(makePageResponse(opts.page, totalPages, totalItems))
    })

    const result = await client.getCompleteCollection('user', 'token', 'secret', 'key', 'consumerSecret')

    expect(result.pagination.items).toBe(4000)
    expect(result.releases).toHaveLength(0) // no releases in mock pages
    expect(mockSearchCollection).toHaveBeenCalledTimes(40)
  })

  it('reports actual total even when collection exceeds maxPages cap', async () => {
    // 70 pages = 7000 items, exceeds default maxPages=50
    const totalItems = 7000
    const totalPages = 70
    mockSearchCollection.mockImplementation((_u: string, _a: string, _s: string, opts: { page: number }) => {
      return Promise.resolve(makePageResponse(opts.page, totalPages, totalItems))
    })

    const result = await client.getCompleteCollection('user', 'token', 'secret', 'key', 'consumerSecret')

    // pagination.items should be the REAL Discogs total (7000), not truncated count (5000)
    expect(result.pagination.items).toBe(7000)
    // Only 50 pages fetched (5000 items at 100/page, but mock pages have 0 releases)
    expect(mockSearchCollection).toHaveBeenCalledTimes(50)
  })

  it('logs a warning when collection is truncated', async () => {
    const consoleSpy = vi.spyOn(console, 'log')
    const totalItems = 6000
    mockSearchCollection.mockImplementation((_u: string, _a: string, _s: string, opts: { page: number }) => {
      return Promise.resolve(makePageResponse(opts.page, 60, totalItems))
    })

    await client.getCompleteCollection('user', 'token', 'secret', 'key', 'consumerSecret')

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('truncated'))
  })

  it('does NOT log a truncation warning when full collection fits within maxPages', async () => {
    const consoleSpy = vi.spyOn(console, 'log')
    mockSearchCollection.mockImplementation((_u: string, _a: string, _s: string, opts: { page: number }) => {
      return Promise.resolve(makePageResponse(opts.page, 10, 1000)) // 1000 items, 10 pages
    })

    await client.getCompleteCollection('user', 'token', 'secret', 'key', 'consumerSecret')

    const truncationLogs = consoleSpy.mock.calls.filter(args => String(args[0]).includes('truncated'))
    expect(truncationLogs).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npx vitest run test/clients/cachedDiscogs.test.ts
```

Expected: 4 tests fail (method signatures and logic don't match yet).

---

### Task 2: Fix `getCompleteCollection` in `cachedDiscogs.ts`

**Files:**
- Modify: `src/clients/cachedDiscogs.ts:204-259`

- [ ] **Step 3: Apply the fix**

In `src/clients/cachedDiscogs.ts`, replace the `getCompleteCollection` method body:

```typescript
async getCompleteCollection(
  username: string,
  accessToken: string,
  accessTokenSecret: string,
  consumerKey: string,
  consumerSecret: string,
  maxPages: number = 50, // Supports up to 5000 items at 100/page
): Promise<DiscogsCollectionResponse> {
  const cacheKey = `${username}:complete:${maxPages}`

  return this.cache.getOrFetch(
    'collections',
    cacheKey,
    async () => {
      console.log(`Fetching complete collection for ${username} (max ${maxPages} pages)`)

      let allReleases: DiscogsCollectionItem[] = []
      let currentPage = 1
      let totalPages = 1
      let actualTotalItems = 0

      do {
        const pageResult = await this.searchCollection(
          username,
          accessToken,
          accessTokenSecret,
          { page: currentPage, per_page: 100 },
          consumerKey,
          consumerSecret,
        )

        // Capture the real Discogs total from the first page only.
        // Never overwrite — pagination.items is stable across all pages.
        if (currentPage === 1) {
          actualTotalItems = pageResult.pagination.items
        }

        allReleases = allReleases.concat(pageResult.releases)
        totalPages = Math.min(pageResult.pagination.pages, maxPages)
        currentPage++
      } while (currentPage <= totalPages)

      const isTruncated = actualTotalItems > allReleases.length
      if (isTruncated) {
        console.log(
          `Collection truncated: indexed ${allReleases.length} of ${actualTotalItems} items (hit ${maxPages}-page limit).`,
        )
      }

      // pagination.pages = pages actually fetched (clamped to maxPages).
      // pagination.items = REAL Discogs total, even when truncated.
      // Tool-layer truncation checks must use pagination.items, not pagination.pages.
      return {
        pagination: {
          pages: totalPages,
          page: 1,
          per_page: allReleases.length,
          items: actualTotalItems || allReleases.length,
          urls: {},
        },
        releases: allReleases,
      }
    },
  )
}
```

Note: the `{ maxAge: 45 * 60 }` option is removed from the `getOrFetch` call — it becomes unnecessary once the `collections` TTL in `SmartCache` is fixed in Task 3.

Also update the doc comment above the method to read:
```
 * For a 1000-item collection this costs ~11 API calls on cold cache, 0 on warm.
 * For a 5000-item collection this costs ~50 API calls on cold cache (~55s at Discogs rate limits).
```

- [ ] **Step 4: Run the new tests**

```bash
npx vitest run test/clients/cachedDiscogs.test.ts
```

Expected: all 4 tests pass. If any fail, check that `actualTotalItems` is captured correctly and that `pagination.items` in the return uses `actualTotalItems`.

---

### Task 3: Fix `collections` TTL in `SmartCache`

**Files:**
- Modify: `src/utils/cache.ts:302`

- [ ] **Step 5: Update the TTL**

In `src/utils/cache.ts`, inside `createDiscogsCache`, change:

```typescript
collections: 30 * 60, // Collections don't change often
```

to:

```typescript
collections: 45 * 60, // Complete collection cache; aligns with getCompleteCollection's 45-min intent
```

- [ ] **Step 6: Run all tests**

```bash
npx vitest run
```

Expected: 68+ tests pass, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add src/clients/cachedDiscogs.ts src/utils/cache.ts test/clients/cachedDiscogs.test.ts
git commit -m "fix: raise collection index cap to 5000 items and report real Discogs total

- Raise maxPages default from 25 to 50 (supports up to 5000 items)
- Fix pagination.items to return real Discogs total, not truncated count
- Fix broken truncation detection (was comparing clamped value to itself)
- Fix collections KV TTL from 30min to 45min to match intended cache window
- Add tests for truncation behaviour in CachedDiscogsClient

Closes #6"
```

---

## Chunk 2: Surface truncation warnings in tool output

### Task 4: Update `get_collection_stats` tool

**Files:**
- Modify: `src/mcp/tools/authenticated.ts:619-692`

- [ ] **Step 1: Switch from `getCompleteCollectionReleases` to `getCompleteCollection`**

Find this block (around line 622):

```typescript
let stats
if (cachedClient) {
  const allReleases = await cachedClient.getCompleteCollectionReleases(
    userProfile.username,
    session.accessToken,
    session.accessTokenSecret,
    env.DISCOGS_CONSUMER_KEY,
    env.DISCOGS_CONSUMER_SECRET,
  )
  stats = cachedClient.computeStatsFromReleases(allReleases)
} else {
```

Replace with:

```typescript
let stats
let collectionTotalItems = 0
let collectionIndexedItems = 0
if (cachedClient) {
  const collection = await cachedClient.getCompleteCollection(
    userProfile.username,
    session.accessToken,
    session.accessTokenSecret,
    env.DISCOGS_CONSUMER_KEY,
    env.DISCOGS_CONSUMER_SECRET,
  )
  stats = cachedClient.computeStatsFromReleases(collection.releases)
  collectionTotalItems = collection.pagination.items
  collectionIndexedItems = collection.releases.length
} else {
  stats = await client.getCollectionStats(
    userProfile.username,
    session.accessToken,
    session.accessTokenSecret,
    env.DISCOGS_CONSUMER_KEY,
    env.DISCOGS_CONSUMER_SECRET,
  )
  collectionTotalItems = stats.totalReleases
  collectionIndexedItems = stats.totalReleases
}

const isIncomplete = collectionTotalItems > collectionIndexedItems
```

- [ ] **Step 2: Update the "Total Releases" line and add the footer warning**

Find:

```typescript
let text = `**Collection Statistics for ${userProfile.username}**\n\n`
text += `Total Releases: ${stats.totalReleases}\n`
text += `Average Rating: ${stats.averageRating.toFixed(1)} (${stats.ratedReleases} rated releases)\n\n`
```

Replace with:

```typescript
let text = `**Collection Statistics for ${userProfile.username}**\n\n`
if (isIncomplete) {
  text += `Total Releases: ${collectionIndexedItems} indexed of ${collectionTotalItems} total\n`
} else {
  text += `Total Releases: ${stats.totalReleases}\n`
}
text += `Average Rating: ${stats.averageRating.toFixed(1)} (${stats.ratedReleases} rated releases)\n\n`
```

Then find the return statement (just before `} catch (error)`):

```typescript
return {
  content: [
    {
      type: 'text',
      text,
    },
  ],
}
```

Replace with:

```typescript
if (isIncomplete) {
  text += `\n⚠️ Only ${collectionIndexedItems} of your ${collectionTotalItems} releases have been indexed. Stats above reflect the indexed portion only.`
}

return {
  content: [
    {
      type: 'text',
      text,
    },
  ],
}
```

- [ ] **Step 3: Run all tests**

```bash
npx vitest run
```

Expected: all tests pass.

---

### Task 5: Update `search_collection` tool

**Files:**
- Modify: `src/mcp/tools/authenticated.ts:412-420, 489, 509`

- [ ] **Step 4: Declare `collectionTruncationNote` before the `if (cachedClient)` block**

Find (around line 408, just before `if (cachedClient)`):

```typescript
const allResults: DiscogsCollectionItem[] = []
const seenReleaseIds = new Set<string>()
let allReleases: DiscogsCollectionItem[] = []
```

Replace with:

```typescript
const allResults: DiscogsCollectionItem[] = []
const seenReleaseIds = new Set<string>()
let allReleases: DiscogsCollectionItem[] = []
let collectionTruncationNote = ''
```

- [ ] **Step 5: Switch from `getCompleteCollectionReleases` to `getCompleteCollection`**

Find (around line 412):

```typescript
if (cachedClient) {
  // Fetch complete collection once (cached for 45 min)
  allReleases = await cachedClient.getCompleteCollectionReleases(
    userProfile.username,
    session.accessToken,
    session.accessTokenSecret,
    env.DISCOGS_CONSUMER_KEY,
    env.DISCOGS_CONSUMER_SECRET,
  )
```

Replace with:

```typescript
if (cachedClient) {
  // Fetch complete collection once (cached for 45 min)
  const collection = await cachedClient.getCompleteCollection(
    userProfile.username,
    session.accessToken,
    session.accessTokenSecret,
    env.DISCOGS_CONSUMER_KEY,
    env.DISCOGS_CONSUMER_SECRET,
  )
  allReleases = collection.releases
  if (collection.pagination.items > collection.releases.length) {
    collectionTruncationNote = `\n\n⚠️ Your collection has ${collection.pagination.items} releases but only ${collection.releases.length} were indexed. Some results may be missing.`
  }
```

Note: `collectionTruncationNote` is assigned (not declared) here — it was declared as `let` in Step 4.

Also check just after `allReleases` is assigned: the existing code has a semantic-query early return that must also include the truncation note. Find this block (around line 425):

```typescript
if (isSemanticQuery(query, allReleases)) {
  return formatCollectionForSemanticSearch(allReleases, query)
}
```

Replace with:

```typescript
if (isSemanticQuery(query, allReleases)) {
  const semanticResult = formatCollectionForSemanticSearch(allReleases, query)
  if (collectionTruncationNote && semanticResult.content?.[0]?.type === 'text') {
    semanticResult.content[0].text += collectionTruncationNote
  }
  return semanticResult
}
```

- [ ] **Step 6: Append the truncation note to the main response**

Find (around line 515, inside the main return block):

```typescript
text: `${summary}${temporalInfo}${moodInfo}\n${releaseList}\n\n**Tip:** Use the release IDs with the get_release tool for detailed information about specific albums.`,
```

Replace with:

```typescript
text: `${summary}${temporalInfo}${moodInfo}\n${releaseList}\n\n**Tip:** Use the release IDs with the get_release tool for detailed information about specific albums.${collectionTruncationNote}`,
```

- [ ] **Step 7: Run all tests**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/tools/authenticated.ts
git commit -m "feat: show truncation warning in stats and search when collection exceeds index limit"
```

---

## Chunk 3: Final verification and PR

- [ ] **Step 1: Run the full test suite one final time**

```bash
npx vitest run
```

Expected: all tests pass, 0 failures.

- [ ] **Step 2: Build to verify TypeScript compiles cleanly**

```bash
npm run build 2>&1 | tail -10
```

Expected: no errors.

- [ ] **Step 3: Push the branch and open a PR**

```bash
git push -u origin fix/large-collection-indexing
gh pr create \
  --title "Fix incomplete results for large collections (>2500 items)" \
  --body "Closes #6

## Summary
- Raises collection index cap from 2,500 to 5,000 items (maxPages 25→50)
- Fixes \`pagination.items\` to report the real Discogs total, not the truncated count
- Fixes broken truncation detection (was comparing clamped value to itself)
- Fixes \`collections\` KV TTL from 30min to 45min to match intended cache window
- Adds truncation warnings in \`get_collection_stats\` and \`search_collection\` output when a collection exceeds the indexed portion

## Test plan
- [ ] Confirm 68+ existing tests still pass
- [ ] Confirm new \`CachedDiscogsClient\` tests cover truncation and accurate reporting
- [ ] Manual test with a 4000+ item collection: \`get_collection_stats\` should report correct total; \`search_collection\` should find all matches" \
  --base main
```
