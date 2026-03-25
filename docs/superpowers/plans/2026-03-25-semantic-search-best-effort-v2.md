# Semantic Search Best-Effort Filter + 750-Cap (v2)

> Supersedes `2026-03-21-semantic-search-best-effort.md`.
> Fixes GitHub issue #10: "Semantic search too often falls back to dumping full collection on the LLM context"

**Goal:** Stop dumping the entire collection (1500-5000 releases) into the LLM context for semantic queries. Instead: (1) try a best-effort keyword filter first, (2) only fall back to an LLM dump if the filter finds nothing, and (3) cap the LLM dump at 750 releases.

**Architecture:**

```
query → isSemanticQuery? → YES →
  1. shouldUseBroadSearch? → YES → capped LLM dump (max 750)
  2. Extract keywords → filter in-memory (OR logic)
     → Results found? → return them + "search more broadly" hint
     → No results? → capped LLM dump (max 750) + improved instructions
```

**Tech Stack:** TypeScript, Cloudflare Workers, Vitest

---

## Files Modified

| File | What changes |
|------|-------------|
| `src/mcp/tools/authenticated.ts` | New `extractSemanticFilterTerms()`, `shouldUseBroadSearch()`; updated `search_collection` routing; updated `formatCollectionForSemanticSearch()` with 750-cap + better LLM instructions; updated tool description |
| `test/mcp/tools/semanticSearch.test.ts` | New test file |

---

## Task 1: Add `extractSemanticFilterTerms` with tests

- [ ] Create `test/mcp/tools/semanticSearch.test.ts` with tests for `extractSemanticFilterTerms`
- [ ] Add `extractSemanticFilterTerms()` as a module-level export in `authenticated.ts`
- [ ] Run tests to confirm they pass

## Task 2: Add `shouldUseBroadSearch` with tests

- [ ] Add tests for `shouldUseBroadSearch` to the test file
- [ ] Add `shouldUseBroadSearch()` as a module-level export in `authenticated.ts`
- [ ] Run tests to confirm they pass

## Task 3: Cap `formatCollectionForSemanticSearch` at 750 releases

- [ ] Update `formatCollectionForSemanticSearch()` to accept a `maxReleases` param (default 750)
- [ ] Prioritize: rated items first (rating desc), then unrated by date_added desc
- [ ] Update LLM instructions: "Select 8-12 matches, include brief rationale"
- [ ] Update tool description and query param description

## Task 4: Update `search_collection` routing

- [ ] When `isSemanticQuery` is true AND `shouldUseBroadSearch` is false: extract keywords, filter in-memory with OR logic, return results with "search more broadly" hint
- [ ] When best-effort finds nothing OR `shouldUseBroadSearch` is true: fall through to capped LLM dump
- [ ] Ensure `collectionTruncationNote` is still appended

## Task 5: Final verification

- [ ] Run full test suite
- [ ] Build succeeds
- [ ] Commit and push
