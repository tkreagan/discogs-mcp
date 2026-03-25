# Rate Limit Optimization Plan

> Fixes GitHub issue #11: "First API call hits Discogs rate limit"

**Goal:** Reduce cold-cache collection fetch time and eliminate cross-user throttle interference.

**Root causes:**
1. Global throttle key `discogs:last_request_time` is shared across ALL users — one user's recent call delays everyone
2. Sequential page fetching with 1000ms gap — 15 pages takes ~15s minimum
3. Dead `RateLimiter` code adds confusion

**Changes:**

## Task 1: Per-user throttle key
- Change `DiscogsClient` to accept a throttle user identifier
- Throttle key becomes `discogs:throttle:{username}` instead of global `discogs:last_request_time`
- Each user gets their own rate budget

## Task 2: Reduce proactive throttle + parallel page fetching
- Cut `REQUEST_DELAY_MS` from 1000ms to 500ms (fetchWithRetry handles 429s)
- In `getCompleteCollection()`, fetch pages in batches of 3 concurrently
- Expected cold-cache time: ~6s for 15 pages (down from ~15s)

## Task 3: Remove dead RateLimiter code
- Delete `src/utils/rateLimit.ts` and `test/utils/rateLimit.test.ts`
- Remove `MCP_RL` KV binding from `wrangler.toml` if not used elsewhere

## Task 4: Update existing tests + verification
- Update throttle tests in `test/clients/discogs.test.ts`
- Run full test suite
