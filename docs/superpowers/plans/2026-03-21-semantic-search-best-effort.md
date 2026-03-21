# Semantic Search Best-Effort Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix semantic search returning 0 results by running a best-effort keyword filter before falling back to the full LLM collection dump.

**Architecture:** When `isSemanticQuery` returns true, extract meaningful keywords from the query and run them through `filterReleasesInMemory` with OR logic. If any results are found, return them in the normal format with a "search more broadly" hint. Only fall through to the full 1500-item LLM dump if the filter finds nothing, or if the user explicitly asks for a broader search. Also improves the LLM dump instructions to give Claude clearer guidance (target count, brief rationale per result).

**Tech Stack:** TypeScript, Cloudflare Workers, Vitest

---

## Files Modified

| File | What changes |
|------|-------------|
| `src/mcp/tools/authenticated.ts` | New `extractSemanticFilterTerms()` function; updated `search_collection` handler routing; updated `formatCollectionForSemanticSearch()` instructions; updated tool description |
| `test/mcp/tools/semanticSearch.test.ts` | New test file for `extractSemanticFilterTerms` and `shouldUseBroadSearch` |

`isSemanticQuery`, `filterReleasesInMemory`, and `moodMapping.ts` are **not changed**.

---

## Task 1: `extractSemanticFilterTerms` — tests first

**Files:**
- Create: `test/mcp/tools/semanticSearch.test.ts`

The function `extractSemanticFilterTerms(query: string): string[]` will be a new module-level export in `src/mcp/tools/authenticated.ts`. Tests import it directly.

Note: `isSemanticQuery` lives inside the `registerAuthenticatedTools` closure and is NOT being moved. The new functions are created at module level so they can be exported and tested.

- [ ] **Step 1: Write the failing test file**

Create `test/mcp/tools/semanticSearch.test.ts` with the following content:

```typescript
import { describe, it, expect } from 'vitest'
import { extractSemanticFilterTerms, shouldUseBroadSearch } from '../../../src/mcp/tools/authenticated'

describe('extractSemanticFilterTerms', () => {
  it('strips common stop words and returns meaningful terms', () => {
    expect(extractSemanticFilterTerms('empowering female vocals')).toEqual(['empowering', 'female', 'vocals'])
  })

  it('strips leading/trailing stop words', () => {
    expect(extractSemanticFilterTerms('something for a rainy day')).toEqual(['rainy', 'day'])
  })

  it('strips all stop words from a fully-stop-word query', () => {
    expect(extractSemanticFilterTerms('something with a lot of the')).toEqual(['lot'])
  })

  it('returns single meaningful word', () => {
    expect(extractSemanticFilterTerms('instrumental')).toEqual(['instrumental'])
  })

  it('strips short words (length <= 2) that are not stop words', () => {
    expect(extractSemanticFilterTerms('upbeat music to go')).toEqual(['upbeat', 'music'])
  })

  it('handles mixed case', () => {
    expect(extractSemanticFilterTerms('Upbeat Female Vocals')).toEqual(['upbeat', 'female', 'vocals'])
  })

  it('handles road trip type queries', () => {
    expect(extractSemanticFilterTerms('good road trip music')).toEqual(['good', 'road', 'trip', 'music'])
  })
})
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npm test -- test/mcp/tools/semanticSearch.test.ts --run
```

Expected: FAIL — `extractSemanticFilterTerms` is not exported from `authenticated.ts`.

---

## Task 2: Implement `extractSemanticFilterTerms`

**Files:**
- Modify: `src/mcp/tools/authenticated.ts`

The function needs to be:
1. Defined at module level (outside the `registerAuthenticatedTools` function) so it can be exported and tested
2. Exported so the test can import it

- [ ] **Step 1: Add the function at module level**

Add the following immediately before the `registerAuthenticatedTools` function definition (i.e., after the imports and before `export function registerAuthenticatedTools`):

```typescript
/**
 * Extract meaningful filter terms from a semantic query by removing stop words
 * and short filler words. Used to attempt a best-effort filter before falling
 * back to the full LLM collection dump.
 */
export function extractSemanticFilterTerms(query: string): string[] {
  const STOP_WORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'of', 'for', 'with', 'in', 'on', 'at',
    'to', 'is', 'it', 'its', 'be', 'by', 'as', 'up', 'do', 'go', 'my',
    'me', 'we', 'he', 'she', 'so', 'no', 'if', 'but', 'not', 'are', 'was',
    'that', 'this', 'they', 'them', 'from', 'have', 'had', 'has', 'some',
    'something', 'anything', 'everything', 'like', 'just', 'more', 'very',
    'want', 'need', 'give', 'show', 'find', 'get',
  ])

  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
}
```

- [ ] **Step 2: Run the tests**

```bash
npm test -- test/mcp/tools/semanticSearch.test.ts --run
```

Expected: all 7 tests pass.

- [ ] **Step 3: Run full test suite to confirm nothing broken**

```bash
npm test -- test/clients/cachedDiscogs.test.ts test/utils/moodMapping.test.ts --run
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tools/authenticated.ts test/mcp/tools/semanticSearch.test.ts
git commit -m "feat: add extractSemanticFilterTerms utility function"
```

---

## Task 3: Update `search_collection` routing — tests first

**Files:**
- Modify: `test/mcp/tools/semanticSearch.test.ts`

Before changing the routing logic, write tests that describe the new behaviour. These will be integration-style tests using mock data, testing the routing decisions directly.

The key behaviours to test:
1. Semantic query with keyword matches → returns filtered results + "search more broadly" hint
2. Semantic query with no keyword matches → falls through to LLM dump format
3. "Search more broadly" trigger phrases → bypasses best-effort filter, goes straight to LLM dump

Since `search_collection` is a large handler with auth dependencies, we test the *routing logic* by testing the helper functions that drive it. The routing logic will be extracted into a small testable helper `shouldUseBroadSearch(query: string): boolean` alongside `extractSemanticFilterTerms`.

- [ ] **Step 1: Add tests for `shouldUseBroadSearch`**

Append to `test/mcp/tools/semanticSearch.test.ts` (the import at the top of the file already includes `shouldUseBroadSearch` — added in Task 1):

```typescript
describe('shouldUseBroadSearch', () => {
  it('returns true for "search more broadly"', () => {
    expect(shouldUseBroadSearch('search more broadly')).toBe(true)
  })

  it('returns true for "show more"', () => {
    expect(shouldUseBroadSearch('show more')).toBe(true)
  })

  it('returns true for "full collection"', () => {
    expect(shouldUseBroadSearch('full collection')).toBe(true)
  })

  it('returns true for "broader search"', () => {
    expect(shouldUseBroadSearch('broader search')).toBe(true)
  })

  it('returns true for "show everything"', () => {
    expect(shouldUseBroadSearch('show everything')).toBe(true)
  })

  it('returns true for "show all"', () => {
    expect(shouldUseBroadSearch('show all')).toBe(true)
  })

  it('returns false for a normal semantic query', () => {
    expect(shouldUseBroadSearch('empowering female vocals')).toBe(false)
  })

  it('returns false for a mood query', () => {
    expect(shouldUseBroadSearch('something for a rainy Sunday')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(shouldUseBroadSearch('Search More Broadly')).toBe(true)
  })

  it('returns false when broad phrase is embedded in a real query', () => {
    expect(shouldUseBroadSearch('show all Miles Davis')).toBe(false)
  })

  it('returns false for "show all jazz albums"', () => {
    expect(shouldUseBroadSearch('show all jazz albums')).toBe(false)
  })

  it('returns true when broad phrase has trailing punctuation', () => {
    expect(shouldUseBroadSearch('show everything!')).toBe(true)
  })

  it('returns true for "please show more" with filler words', () => {
    expect(shouldUseBroadSearch('please show more')).toBe(true)
  })

  it('returns true for "can you search more broadly?"', () => {
    expect(shouldUseBroadSearch('can you search more broadly?')).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- test/mcp/tools/semanticSearch.test.ts --run
```

Expected: the `shouldUseBroadSearch` tests fail (function not yet defined).

---

## Task 4: Implement `shouldUseBroadSearch` and update routing

**Files:**
- Modify: `src/mcp/tools/authenticated.ts`

- [ ] **Step 1: Add `shouldUseBroadSearch` at module level**

Add immediately after `extractSemanticFilterTerms`:

```typescript
/**
 * Returns true if the query is explicitly asking for a broad/full collection search.
 * These queries bypass the best-effort semantic filter and go straight to the LLM dump.
 *
 * Uses strict matching: the query must be essentially just a broad-search phrase,
 * optionally surrounded by filler words (please, can you, etc.) and punctuation.
 * "show all" matches, but "show all Miles Davis" does NOT — that's a real query.
 */
export function shouldUseBroadSearch(query: string): boolean {
  // Strip filler words and punctuation, then check for an exact broad-search phrase
  const FILLER_WORDS = new Set(['please', 'can', 'you', 'could', 'would', 'just', 'ok', 'okay', 'yes', 'yeah', 'sure'])
  const meaningful = query
    .toLowerCase()
    .replace(/[^a-z\s]/g, '') // strip punctuation
    .split(/\s+/)
    .filter((w) => w.length > 0 && !FILLER_WORDS.has(w))
    .join(' ')
    .trim()

  const broadSearchPhrases = new Set([
    'search more broadly',
    'show more',
    'full collection',
    'broader search',
    'show everything',
    'show all',
  ])
  return broadSearchPhrases.has(meaningful)
}
```

- [ ] **Step 2: Run `shouldUseBroadSearch` tests**

```bash
npm test -- test/mcp/tools/semanticSearch.test.ts --run
```

Expected: all tests pass.

- [ ] **Step 3: Update the routing logic in `search_collection`**

In `src/mcp/tools/authenticated.ts`, find the semantic query detection block (currently at line ~493):

```typescript
// Semantic query detection: if the query is conceptual/descriptive
// (not matching artists, albums, genres, or moods), short-circuit
// and return the full collection for LLM-based selection.
if (isSemanticQuery(query, allReleases)) {
    const semanticResult = formatCollectionForSemanticSearch(allReleases, query)
    if (collectionTruncationNote && semanticResult.content?.[0]?.type === 'text') {
        semanticResult.content[0].text += collectionTruncationNote
    }
    return semanticResult
}
```

Replace it with:

```typescript
// Semantic query detection: if the query is conceptual/descriptive
// (not matching artists, albums, genres, or moods), try a best-effort
// keyword filter first. Only fall back to the full LLM dump if:
// (a) the user explicitly asked for a broader search, or
// (b) the best-effort filter found no results.
if (isSemanticQuery(query, allReleases) || shouldUseBroadSearch(query)) {
    if (!shouldUseBroadSearch(query)) {
        // Best-effort: run filterReleasesInMemory once per extracted term (OR logic)
        const semanticTerms = extractSemanticFilterTerms(query)
        const bestEffortResults: DiscogsCollectionItem[] = []
        const bestEffortSeen = new Set<string>()

        for (const term of semanticTerms) {
            const termResults = filterReleasesInMemory(allReleases, term)
            for (const release of termResults) {
                const key = `${release.id}-${release.instance_id}`
                if (!bestEffortSeen.has(key)) {
                    bestEffortSeen.add(key)
                    bestEffortResults.push(release)
                }
            }
        }

        if (bestEffortResults.length > 0) {
            // Sort by rating desc, then date added desc
            bestEffortResults.sort((a, b) => {
                if (a.rating !== b.rating) return b.rating - a.rating
                return new Date(b.date_added).getTime() - new Date(a.date_added).getTime()
            })

            const finalResults = bestEffortResults.slice(0, per_page)
            const summary = `Found ${bestEffortResults.length} possible matches for "${query}" in your collection (showing ${finalResults.length} items):`

            const releaseList = finalResults
                .map((release) => {
                    const info = release.basic_information
                    const artists = info.artists.map((a) => a.name).join(', ')
                    const formats = info.formats.map((f) => f.name).join(', ')
                    const genres = info.genres?.length ? info.genres.join(', ') : 'Unknown'
                    const styles = info.styles?.length ? ` | Styles: ${info.styles.join(', ')}` : ''
                    const rating = release.rating > 0 ? ` ⭐${release.rating}` : ''
                    return `• [ID: ${release.id}] ${artists} - ${info.title} (${info.year})\n  Format: ${formats} | Genre: ${genres}${styles}${rating}`
                })
                .join('\n\n')

            const broadSearchHint = `\n\n💡 Showing possible matches based on keywords. If these aren't what you're looking for, ask me to "search more broadly" and I'll look through your full collection.`

            return {
                content: [{
                    type: 'text',
                    text: `${summary}\n${releaseList}${broadSearchHint}${collectionTruncationNote}`,
                }],
            }
        }
        // Fall through to LLM dump — no best-effort results found
    }

    // Full LLM dump: broad search requested, or best-effort found nothing
    const semanticResult = formatCollectionForSemanticSearch(allReleases, query)
    if (collectionTruncationNote && semanticResult.content?.[0]?.type === 'text') {
        semanticResult.content[0].text += collectionTruncationNote
    }
    return semanticResult
}
```

- [ ] **Step 4: Run lint and tests**

```bash
npm run lint && npm test -- test/mcp/tools/semanticSearch.test.ts test/clients/cachedDiscogs.test.ts --run
```

Expected: lint clean, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/authenticated.ts test/mcp/tools/semanticSearch.test.ts
git commit -m "feat: best-effort keyword filter for semantic search with broad-search fallback"
```

---

## Task 5: Improve `formatCollectionForSemanticSearch` instructions

**Files:**
- Modify: `src/mcp/tools/authenticated.ts` — `formatCollectionForSemanticSearch` function (~line 357)

This task has no new tests (the function's output is a prompt string; correctness is evaluated by LLM behaviour, not unit assertions). Just update the instructions.

- [ ] **Step 1: Replace the instruction text**

Find `formatCollectionForSemanticSearch` and replace the `text:` template literal:

**Before:**
```typescript
text:
    `**Semantic search mode:** The collection filter could not find direct matches for "${query}". ` +
    `Below is the complete collection (${allReleases.length} releases). ` +
    `Please use your knowledge of these artists and albums to select the best matches for the user's intent: "${query}"\n\n` +
    `${compactList}\n\n` +
    `**Tip:** Use the release IDs with the get_release tool for detailed information about specific albums.`,
```

**After:**
```typescript
text:
    `**Semantic search mode:** No keyword matches found for "${query}". ` +
    `Below is the complete collection (${allReleases.length} releases).\n\n` +
    `**Instructions:** Select 8–12 releases that best match the user's intent: "${query}". ` +
    `Use your knowledge of these artists, albums, and genres to identify the strongest matches. ` +
    `For each result, include a brief note (1 sentence) explaining why it fits. ` +
    `If you find fewer than 8 strong matches, return only the ones you're confident about — do not pad with weak matches.\n\n` +
    `${compactList}\n\n` +
    `**Tip:** Use the release IDs with the get_release tool for detailed information about specific albums.`,
```

- [ ] **Step 2: Update the tool description and query parameter description**

In `src/mcp/tools/authenticated.ts`, find the tool description string (line ~389) and replace:

```typescript
// BEFORE (tool description, line ~389):
"Search your Discogs collection with natural language queries. IMPORTANT: Pass the user's query as-is — do NOT rewrite, decompose, or make multiple searches. The tool handles semantic/conceptual queries internally (e.g., 'strong empowering female voice', 'perfect for a rainy Sunday') by returning the full collection for you to select from using your knowledge. Also supports mood descriptors like 'mellow jazz', temporal terms like 'recent' or 'oldest', and specific searches by artist, album, genre, or year. One call is sufficient for any query."

// AFTER:
"Search your Discogs collection with natural language queries. IMPORTANT: Pass the user's query as-is — do NOT rewrite, decompose, or make multiple searches. The tool handles semantic/conceptual queries internally (e.g., 'strong empowering female voice', 'perfect for a rainy Sunday') by first attempting a keyword match, then returning the full collection for LLM-based selection if no matches are found. Also supports mood descriptors like 'mellow jazz', temporal terms like 'recent' or 'oldest', and specific searches by artist, album, genre, or year. One call is sufficient for any query."
```

Also update the `query` parameter description string (line ~394):

```typescript
// BEFORE:
"The user's search query passed verbatim. Do NOT rewrite or decompose the query — pass it exactly as the user said it. The tool handles semantic queries like 'empowering female vocals' or 'road trip music' by returning the full collection for LLM-based selection."

// AFTER:
"The user's search query passed verbatim. Do NOT rewrite or decompose the query — pass it exactly as the user said it. The tool handles semantic queries like 'empowering female vocals' or 'road trip music' by first trying keyword matching, then falling back to full collection search if needed."
```

- [ ] **Step 3: Run lint and build**

```bash
npm run lint && npm run build
```

Expected: lint clean, TypeScript compiles with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tools/authenticated.ts
git commit -m "feat: improve semantic search LLM instructions and update tool description"
```

---

## Task 6: Final verification

- [ ] **Step 1: Run full test suite**

```bash
npm test -- --run
```

Expected: all tests pass.

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: clean compile.

- [ ] **Step 3: Manual smoke tests via MCP**

Deploy to dev: `npm run deploy`

Test these queries and confirm expected behaviour:

| Query | Expected behaviour |
|-------|-------------------|
| `empowering female vocals` | Best-effort results + "search more broadly" hint |
| `good road trip music` | Best-effort results + hint |
| `search more broadly` (follow-up) | Full LLM dump with 8–12 selections |
| `mellow jazz` | Normal mood pipeline (not semantic, no change) |
| `Miles Davis` | Normal literal search (not semantic, no change) |
| `something completely abstract like pure mathematics` | 0 best-effort results → LLM dump |
