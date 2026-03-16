# OAuth Flow Redesign Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual copy-paste OAuth flow with MCP OAuth 2.1 compliance so all MCP clients (Claude Code, Claude Desktop, opencode) open a browser automatically for first-time authentication.

**Architecture:** Add `@cloudflare/workers-oauth-provider` as the MCP OAuth 2.1 layer. Create `src/index-oauth.ts` as the new entry point with smart routing (session-based paths bypass OAuth, everything else goes through the provider). Create `src/auth/oauth-handler.ts` to bridge Discogs OAuth 1.0a with the MCP OAuth 2.1 authorize/callback cycle. Refactor `src/mcp/server.ts` into a factory that returns `{ server, setContext }` so both paths inject auth props consistently.

**Tech Stack:** TypeScript, Cloudflare Workers, `@cloudflare/workers-oauth-provider`, `@cloudflare/vitest-pool-workers`, Vitest, Discogs OAuth 1.0a, MCP SDK (`@modelcontextprotocol/sdk`), Cloudflare Agents SDK (`agents`)

**Reference:** See `docs/superpowers/specs/2026-03-15-oauth-flow-design.md` for the full spec. See `/Users/rian/Documents/GitHub/lastfm-mcp/src/` for the equivalent implementation to mirror.

---

## Chunk 1: Foundation

Installs the new dependency, updates the env type, refactors the MCP server factory, and removes the security issue in `discogs.ts`. All other tasks build on this.

### Task 1: Install `@cloudflare/workers-oauth-provider`

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the dependency**

```bash
cd /Users/rian/Documents/GitHub/discogs-mcp
npm install @cloudflare/workers-oauth-provider
```

Expected: `package.json` `dependencies` now includes `@cloudflare/workers-oauth-provider`.

- [ ] **Step 2: Verify types are available**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors about `@cloudflare/workers-oauth-provider` missing.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: install @cloudflare/workers-oauth-provider"
```

---

### Task 2: Update `src/types/env.ts`

The `JWT_SECRET` binding is no longer needed (JWT sessions are removed). The `OAUTH_PROVIDER` binding is injected by the library at runtime.

**Files:**
- Modify: `src/types/env.ts`

- [ ] **Step 1: Update the env interface**

Replace the contents of `src/types/env.ts` with:

```typescript
/**
 * Environment variables and bindings for the Cloudflare Worker
 */
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'

export interface Env {
  // Discogs OAuth credentials
  DISCOGS_CONSUMER_KEY: string
  DISCOGS_CONSUMER_SECRET: string

  // OAuth provider helpers (injected by @cloudflare/workers-oauth-provider at runtime)
  OAUTH_PROVIDER: OAuthHelpers

  // KV namespaces for logging, rate limiting, and sessions
  MCP_LOGS: KVNamespace
  MCP_RL: KVNamespace
  MCP_SESSIONS: KVNamespace
}
```

- [ ] **Step 2: Check for JWT_SECRET references**

```bash
grep -rn "JWT_SECRET\|jwt\.ts\|createSessionToken\|verifySessionToken" src/
```

Note any files that still reference JWT (will be cleaned up in Task 6).

- [ ] **Step 3: Commit**

```bash
git add src/types/env.ts
git commit -m "feat: update Env type for OAuth provider, remove JWT_SECRET"
```

---

### Task 3: Remove debug logs from `src/auth/discogs.ts`

**Files:**
- Modify: `src/auth/discogs.ts`

- [ ] **Step 1: Write the test (the security fix test)**

The existing test at `test/auth/discogs.spec.ts` tests the `DiscogsAuth` class. Add a test that verifies no sensitive data is logged. Open `test/auth/discogs.spec.ts` and add inside the `describe('DiscogsAuth', ...)` block:

```typescript
it('should not log the signing key or signature', async () => {
  const consoleSpy = vi.spyOn(console, 'log')
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: () => Promise.resolve('oauth_token=tok&oauth_token_secret=sec'),
  })
  await auth.getRequestToken('http://localhost/callback')
  const loggedMessages = consoleSpy.mock.calls.map((args) => args.join(' '))
  expect(loggedMessages.some((msg) => msg.includes('signing key'))).toBe(false)
  expect(loggedMessages.some((msg) => msg.includes('OAuth signature:'))).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/auth/discogs.spec.ts 2>&1 | tail -20
```

Expected: FAIL — the test should catch the current `console.log` statements.

- [ ] **Step 3: Remove the three debug `console.log` lines from `src/auth/discogs.ts`**

In `src/auth/discogs.ts`, find and remove these lines (around line 152–154):
```typescript
console.log('OAuth signature base string:', baseString)
console.log('OAuth signing key:', signingKey)
console.log('OAuth signature:', signature)
```

Keep the other `console.log` statements (e.g. "Getting OAuth header for request token..." — those are fine).

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/auth/discogs.spec.ts 2>&1 | tail -20
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auth/discogs.ts test/auth/discogs.spec.ts
git commit -m "fix: remove OAuth signing key from console logs (security)"
```

---

### Task 4: Refactor `src/mcp/server.ts` to factory pattern

Replace the current `createServer(env, request, sessionId)` function with `createMcpServer(env, baseUrl, options?)` that returns `{ server, setContext }`. This allows both the OAuth path and the session-based path to inject auth context after the server is created.

**Files:**
- Modify: `src/mcp/server.ts`

Current signature: `createServer(env: Env, request: Request, sessionId: string): McpServer`
New signature: `createMcpServer(env: Env, baseUrl: string, options?: { authMessages?: AuthMessageConfig }): { server: McpServer, setContext: (ctx: Partial<McpRequestContext>) => void }`

- [ ] **Step 1: Understand the current tool registration signatures**

Read `src/mcp/tools/authenticated.ts` lines 228–235 and `src/mcp/tools/public.ts` lines 23–27 to see what `getSessionContext` type is expected. Both take `getSessionContext: () => Promise<SessionContext>` where `SessionContext = { session: SessionPayload | null, connectionId?: string }`.

- [ ] **Step 2: Write a failing type-check test**

Before changing `server.ts`, verify the current shape compiles:
```bash
npx tsc --noEmit 2>&1 | grep -c "error" || echo "0 errors"
```

Note the current error count.

- [ ] **Step 3: Rewrite `src/mcp/server.ts`**

Replace the entire file with:

```typescript
/**
 * MCP Server factory for Discogs
 * Returns { server, setContext } so both OAuth and session paths can inject auth props.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Env } from '../types/env.js'
import { registerPublicTools } from './tools/public.js'
import { registerAuthenticatedTools } from './tools/authenticated.js'
import { registerResources } from './resources/discogs.js'
import { registerPrompts } from './prompts/collection.js'

/**
 * Auth session — Discogs credentials available to tools after authentication.
 */
export interface DiscogsSession {
  username: string
  numericId: string
  accessToken: string
  accessTokenSecret: string
}

/**
 * Per-request context — mutable, updated before each MCP handler call.
 */
export interface McpRequestContext {
  session: DiscogsSession | null
  sessionId: string | null
  baseUrl: string
}

/**
 * Legacy alias kept so tool files don't need simultaneous updates.
 * Tools use `SessionContext` for the shape of what `getSessionContext()` returns.
 * @deprecated Use McpRequestContext directly in new code.
 */
export interface SessionContext {
  session: DiscogsSession | null
  connectionId?: string
}

export interface McpServerWithContext {
  server: McpServer
  setContext: (ctx: Partial<McpRequestContext>) => void
  getContext: () => McpRequestContext
}

/**
 * Creates and configures the MCP server.
 *
 * @param env - Cloudflare Worker environment bindings
 * @param baseUrl - Base URL for constructing auth URLs (e.g. https://host)
 */
export function createMcpServer(env: Env, baseUrl: string): McpServerWithContext {
  const server = new McpServer({
    name: 'discogs-mcp',
    version: '1.0.0',
  })

  // Mutable context — set by the caller before the MCP handler runs
  const context: McpRequestContext = {
    session: null,
    sessionId: null,
    baseUrl,
  }

  // Getter for tools (legacy SessionContext shape)
  const getSessionContext = async (): Promise<SessionContext> => ({
    session: context.session,
    connectionId: context.sessionId ?? undefined,
  })

  // Register all tools and resources
  registerPublicTools(server, env, getSessionContext)
  registerAuthenticatedTools(server, env, getSessionContext)
  registerResources(server, env, getSessionContext)
  registerPrompts(server)

  return {
    server,
    setContext: (ctx: Partial<McpRequestContext>) => {
      if (ctx.session !== undefined) context.session = ctx.session
      if (ctx.sessionId !== undefined) context.sessionId = ctx.sessionId
      if (ctx.baseUrl !== undefined) context.baseUrl = ctx.baseUrl
    },
    getContext: () => ({ ...context }),
  }
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -30
```

Expected: no new errors from `server.ts`. There may be errors from `index.ts` (which still imports the old `createServer`) — that's fine for now, it'll be resolved in Task 7.

- [ ] **Step 5: Run existing tests to make sure nothing broke**

```bash
npx vitest run 2>&1 | tail -20
```

Expected: existing tests still pass (the test files don't directly import `createServer`).

- [ ] **Step 6: Commit**

```bash
git add src/mcp/server.ts
git commit -m "refactor: createMcpServer factory with setContext for OAuth + session paths"
```

---

## Chunk 2: OAuth Handler

Creates `src/auth/oauth-handler.ts` — the DefaultHandler for the OAuth provider, implementing all auth routes.

### Task 5: Create `src/auth/oauth-handler.ts` skeleton

**Files:**
- Create: `src/auth/oauth-handler.ts`

- [ ] **Step 1: Create the file skeleton**

```typescript
// ABOUTME: OAuth handler integrating Discogs authentication with MCP OAuth 2.1.
// ABOUTME: Handles /authorize, /discogs-callback, /login, /callback, and /.well-known/oauth-protected-resource.
import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import type { ExecutionContext } from '@cloudflare/workers-types'
import { DiscogsAuth } from './discogs'
import type { Env } from '../types/env'

// Env with OAuth helpers injected by the provider at runtime
interface OAuthEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers
}

/**
 * Discogs user props stored in the OAuth token.
 * Passed to completeAuthorization() and available in apiHandler via ctx.props.
 */
export interface DiscogsUserProps {
  numericId: string       // Discogs numeric user ID (from /oauth/identity field "id")
  username: string        // Discogs username (from /oauth/identity field "username")
  accessToken: string
  accessTokenSecret: string
}

/**
 * DefaultHandler for @cloudflare/workers-oauth-provider.
 * Only handles auth-related routes. Static routes (/, /health, etc.) are
 * handled by the main entry point in index-oauth.ts.
 */
export const DiscogsOAuthHandler = {
  async fetch(request: Request, env: OAuthEnv, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    switch (url.pathname) {
      case '/authorize':
        if (request.method === 'GET') return handleAuthorize(request, env)
        return new Response('Method not allowed', { status: 405 })

      case '/discogs-callback':
        if (request.method === 'GET') return handleDiscogsCallback(request, env)
        return new Response('Method not allowed', { status: 405 })

      case '/login':
        if (request.method === 'GET') return handleManualLogin(request, env)
        return new Response('Method not allowed', { status: 405 })

      case '/callback':
        if (request.method === 'GET') return handleManualCallback(request, env)
        return new Response('Method not allowed', { status: 405 })

      case '/.well-known/oauth-protected-resource':
        return handleProtectedResourceMetadata(request)

      default:
        return new Response('Not found', { status: 404 })
    }
  },
}

// ── Stub implementations (filled in subsequent tasks) ──────────────────────────

async function handleAuthorize(request: Request, env: OAuthEnv): Promise<Response> {
  return new Response('Not implemented', { status: 501 })
}

async function handleDiscogsCallback(request: Request, env: OAuthEnv): Promise<Response> {
  return new Response('Not implemented', { status: 501 })
}

async function handleManualLogin(request: Request, env: OAuthEnv): Promise<Response> {
  return new Response('Not implemented', { status: 501 })
}

async function handleManualCallback(request: Request, env: OAuthEnv): Promise<Response> {
  return new Response('Not implemented', { status: 501 })
}

function handleProtectedResourceMetadata(request: Request): Response {
  return new Response('Not implemented', { status: 501 })
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit 2>&1 | grep "oauth-handler" | head -10
```

Expected: no errors from `oauth-handler.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/auth/oauth-handler.ts
git commit -m "feat: add DiscogsOAuthHandler skeleton"
```

---

### Task 6: Implement `/.well-known/oauth-protected-resource`

This endpoint must be publicly accessible (no auth) so unauthenticated MCP clients can discover the authorization server.

**Files:**
- Modify: `src/auth/oauth-handler.ts`

- [ ] **Step 1: Write the failing test**

Create `test/auth/oauth-handler.spec.ts`:

```typescript
// ABOUTME: Tests for DiscogsOAuthHandler auth routes.
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import { DiscogsOAuthHandler } from '../../src/auth/oauth-handler'

describe('/.well-known/oauth-protected-resource', () => {
  it('returns 200 with correct fields', async () => {
    const req = new Request('https://example.com/.well-known/oauth-protected-resource')
    const ctx = createExecutionContext()
    const res = await DiscogsOAuthHandler.fetch(req, env as any, ctx)
    await waitOnExecutionContext(ctx)

    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.resource).toBe('https://example.com')
    expect(body.authorization_servers).toContain('https://example.com')
    expect(body.bearer_methods_supported).toContain('header')
  })

  it('is accessible without authentication', async () => {
    const req = new Request('https://example.com/.well-known/oauth-protected-resource')
    const ctx = createExecutionContext()
    const res = await DiscogsOAuthHandler.fetch(req, env as any, ctx)
    await waitOnExecutionContext(ctx)
    // Must not be 401 or 403 — unauthenticated clients need to read this
    expect(res.status).not.toBe(401)
    expect(res.status).not.toBe(403)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/auth/oauth-handler.spec.ts 2>&1 | tail -20
```

Expected: FAIL (501 Not Implemented)

- [ ] **Step 3: Implement `handleProtectedResourceMetadata`**

Replace the stub in `src/auth/oauth-handler.ts`:

```typescript
function handleProtectedResourceMetadata(request: Request): Response {
  const url = new URL(request.url)
  const baseUrl = `${url.protocol}//${url.host}`

  return new Response(
    JSON.stringify({
      resource: baseUrl,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ['header'],
      scopes_supported: [],
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=3600',
      },
    },
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/auth/oauth-handler.spec.ts 2>&1 | tail -20
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auth/oauth-handler.ts test/auth/oauth-handler.spec.ts
git commit -m "feat: implement /.well-known/oauth-protected-resource endpoint"
```

---

### Task 7: Implement `/authorize`

Parses the MCP OAuth 2.1 request, gets a Discogs request token, stores pending state in KV, and redirects to Discogs.

**Files:**
- Modify: `src/auth/oauth-handler.ts`

- [ ] **Step 1: Add test for `/authorize`**

Add to `test/auth/oauth-handler.spec.ts`:

```typescript
import { vi } from 'vitest'

// Mock DiscogsAuth at the top of the file (add after existing imports)
vi.mock('../../src/auth/discogs', () => ({
  DiscogsAuth: vi.fn().mockImplementation(() => ({
    getRequestToken: vi.fn().mockResolvedValue({
      oauth_token: 'mock-request-token',
      oauth_token_secret: 'mock-request-secret',
      oauth_callback_confirmed: 'true',
    }),
    getAccessToken: vi.fn().mockResolvedValue({
      oauth_token: 'mock-access-token',
      oauth_token_secret: 'mock-access-secret',
    }),
  })),
}))

// Add this describe block to the file:
describe('/authorize', () => {
  it('redirects to discogs.com/oauth/authorize with the request token', async () => {
    const url = new URL('https://example.com/authorize')
    url.searchParams.set('client_id', 'test-client')
    url.searchParams.set('redirect_uri', 'https://client/callback')
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('state', 'random123')
    url.searchParams.set('code_challenge', 'abc123')
    url.searchParams.set('code_challenge_method', 'S256')

    const req = new Request(url.toString())
    const ctx = createExecutionContext()
    const res = await DiscogsOAuthHandler.fetch(req, env as any, ctx)
    await waitOnExecutionContext(ctx)

    expect(res.status).toBe(302)
    const location = res.headers.get('Location') ?? ''
    expect(location).toContain('discogs.com/oauth/authorize')
    expect(location).toContain('oauth_token=mock-request-token')
  })
})
```

- [ ] **Step 2: Run to confirm it fails**

```bash
npx vitest run test/auth/oauth-handler.spec.ts -t "authorize" 2>&1 | tail -20
```

Expected: FAIL (501)

- [ ] **Step 3: Implement `handleAuthorize`**

Replace the stub:

```typescript
async function handleAuthorize(request: Request, env: OAuthEnv): Promise<Response> {
  try {
    const oauthReqInfo: AuthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request)

    const url = new URL(request.url)
    const callbackUrl = `${url.protocol}//${url.host}/discogs-callback`

    const discogsAuth = new DiscogsAuth(env.DISCOGS_CONSUMER_KEY, env.DISCOGS_CONSUMER_SECRET)
    const { oauth_token: requestToken, oauth_token_secret: requestTokenSecret } =
      await discogsAuth.getRequestToken(callbackUrl)

    // Store pending state: correlate Discogs oauth_token with our OAuth 2.1 request
    await env.MCP_SESSIONS.put(
      `oauth-pending:${requestToken}`,
      JSON.stringify({ oauthReqInfo, requestTokenSecret }),
      { expirationTtl: 600 }, // 10 minutes
    )

    return Response.redirect(
      `https://www.discogs.com/oauth/authorize?oauth_token=${requestToken}`,
      302,
    )
  } catch (error) {
    console.error('[OAUTH] /authorize error:', error)
    return new Response(
      `<html><body><h1>Authorization Error</h1><p>${error instanceof Error ? error.message : 'Unknown error'}</p><p><a href="/authorize">Try again</a></p></body></html>`,
      { status: 500, headers: { 'Content-Type': 'text/html' } },
    )
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/auth/oauth-handler.spec.ts -t "authorize" 2>&1 | tail -20
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auth/oauth-handler.ts test/auth/oauth-handler.spec.ts
git commit -m "feat: implement /authorize — Discogs request token + KV store"
```

---

### Task 8: Implement `/discogs-callback`

Exchanges the Discogs tokens, fetches user identity, and calls `completeAuthorization()`.

**Files:**
- Modify: `src/auth/oauth-handler.ts`

- [ ] **Step 1: Add Discogs identity mock and callback test**

Add to the mock in `test/auth/oauth-handler.spec.ts` (extend the existing `vi.mock`):

```typescript
// Add to the existing vi.mock for discogs - the fetch mock for /oauth/identity
// At top of file, add:
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)
```

Add this describe block:

```typescript
describe('/discogs-callback', () => {
  it('completes authorization and redirects to client redirect_uri', async () => {
    // Pre-seed KV with a pending oauth state
    await env.MCP_SESSIONS.put(
      'oauth-pending:mock-request-token',
      JSON.stringify({
        oauthReqInfo: {
          clientId: 'test-client',
          redirectUri: 'https://client/callback',
          state: 'random123',
          scope: [],
        },
        requestTokenSecret: 'mock-request-secret',
      }),
    )

    // Mock Discogs /oauth/identity response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 12345, username: 'testuser' }),
    })

    const req = new Request(
      'https://example.com/discogs-callback?oauth_token=mock-request-token&oauth_verifier=mock-verifier',
    )
    const ctx = createExecutionContext()
    const res = await DiscogsOAuthHandler.fetch(req, env as any, ctx)
    await waitOnExecutionContext(ctx)

    // Should redirect (302) — library issues the code redirect to client
    expect([302, 303]).toContain(res.status)
  })

  it('returns 400 when oauth_token is missing', async () => {
    const req = new Request('https://example.com/discogs-callback')
    const ctx = createExecutionContext()
    const res = await DiscogsOAuthHandler.fetch(req, env as any, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(400)
  })

  it('returns 400 when KV entry is missing (expired)', async () => {
    const req = new Request(
      'https://example.com/discogs-callback?oauth_token=no-such-token&oauth_verifier=x',
    )
    const ctx = createExecutionContext()
    const res = await DiscogsOAuthHandler.fetch(req, env as any, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
npx vitest run test/auth/oauth-handler.spec.ts -t "discogs-callback" 2>&1 | tail -20
```

Expected: FAIL (501)

- [ ] **Step 3: Implement `handleDiscogsCallback`**

Replace the stub:

```typescript
async function handleDiscogsCallback(request: Request, env: OAuthEnv): Promise<Response> {
  const url = new URL(request.url)
  const oauthToken = url.searchParams.get('oauth_token')
  const oauthVerifier = url.searchParams.get('oauth_verifier')

  if (!oauthToken || !oauthVerifier) {
    return new Response('Missing OAuth parameters', { status: 400 })
  }

  // Retrieve and immediately delete the pending state (prevents replay)
  const pendingKey = `oauth-pending:${oauthToken}`
  const pendingDataStr = await env.MCP_SESSIONS.get(pendingKey)

  if (!pendingDataStr) {
    return new Response(
      '<html><body><h1>Session Expired</h1><p>The authorization session has expired or is invalid. Please try again.</p><p><a href="/authorize">Restart authorization</a></p></body></html>',
      { status: 400, headers: { 'Content-Type': 'text/html' } },
    )
  }

  const pendingData = JSON.parse(pendingDataStr)
  const { oauthReqInfo, requestTokenSecret }: { oauthReqInfo: AuthRequest; requestTokenSecret: string } = pendingData

  // Delete immediately — prevents replay even if subsequent steps fail
  await env.MCP_SESSIONS.delete(pendingKey)

  try {
    // Exchange request token for access token
    const discogsAuth = new DiscogsAuth(env.DISCOGS_CONSUMER_KEY, env.DISCOGS_CONSUMER_SECRET)
    const { oauth_token: accessToken, oauth_token_secret: accessTokenSecret } =
      await discogsAuth.getAccessToken(oauthToken, requestTokenSecret, oauthVerifier)

    // Fetch Discogs identity to get username and numeric ID
    const identityRes = await fetch('https://api.discogs.com/oauth/identity', {
      headers: {
        Authorization: (
          await discogsAuth.getAuthHeaders('https://api.discogs.com/oauth/identity', 'GET', {
            key: accessToken,
            secret: accessTokenSecret,
          })
        ).Authorization,
        'User-Agent': 'discogs-mcp/1.0.0',
      },
    })

    if (!identityRes.ok) {
      throw new Error(`Failed to fetch Discogs identity: ${identityRes.status}`)
    }

    const identity = await identityRes.json() as { id: number; username: string }
    const userProps: DiscogsUserProps = {
      numericId: String(identity.id),
      username: identity.username,
      accessToken,
      accessTokenSecret,
    }

    // Complete the MCP OAuth 2.1 flow — library issues the authorization code to client
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo,
      userId: userProps.username, // OAuth 2.1 subject = username
      metadata: {
        label: 'Discogs MCP Access',
        discogsUsername: userProps.username,
        authorizedAt: new Date().toISOString(),
      },
      scope: oauthReqInfo.scope,
      props: userProps,
    })

    return Response.redirect(redirectTo, 302)
  } catch (error) {
    console.error('[OAUTH] /discogs-callback error:', error)
    return new Response(
      `<html><body><h1>Authentication Failed</h1><p>${error instanceof Error ? error.message : 'Unknown error'}</p><p>Please try again.</p></body></html>`,
      { status: 500, headers: { 'Content-Type': 'text/html' } },
    )
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/auth/oauth-handler.spec.ts -t "discogs-callback" 2>&1 | tail -20
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auth/oauth-handler.ts test/auth/oauth-handler.spec.ts
git commit -m "feat: implement /discogs-callback — token exchange + completeAuthorization"
```

---

### Task 9: Implement `/login` and `/callback` (manual login path)

For clients that don't support MCP OAuth (e.g. Claude Desktop with a manually configured session URL).

**Files:**
- Modify: `src/auth/oauth-handler.ts`

- [ ] **Step 1: Add manual login tests**

Add to `test/auth/oauth-handler.spec.ts`:

```typescript
describe('/login (manual path)', () => {
  it('redirects to discogs.com/oauth/authorize', async () => {
    const req = new Request('https://example.com/login?session_id=test-session')
    const ctx = createExecutionContext()
    const res = await DiscogsOAuthHandler.fetch(req, env as any, ctx)
    await waitOnExecutionContext(ctx)

    expect(res.status).toBe(302)
    const location = res.headers.get('Location') ?? ''
    expect(location).toContain('discogs.com/oauth/authorize')
  })

  it('sets a CSRF cookie', async () => {
    const req = new Request('https://example.com/login?session_id=test-session')
    const ctx = createExecutionContext()
    const res = await DiscogsOAuthHandler.fetch(req, env as any, ctx)
    await waitOnExecutionContext(ctx)

    const cookie = res.headers.get('Set-Cookie') ?? ''
    expect(cookie).toContain('csrf')
  })

  it('stores pending login state in KV', async () => {
    const req = new Request('https://example.com/login?session_id=test-session-kv')
    const ctx = createExecutionContext()
    await DiscogsOAuthHandler.fetch(req, env as any, ctx)
    await waitOnExecutionContext(ctx)

    const stored = await env.MCP_SESSIONS.get('login-pending:test-session-kv')
    expect(stored).not.toBeNull()
    const data = JSON.parse(stored!)
    expect(data.csrfToken).toBeDefined()
    expect(data.requestToken).toBeDefined()
    expect(data.requestTokenSecret).toBeDefined()
  })
})

describe('/callback (manual path)', () => {
  it('returns 400 when login-pending KV entry is missing', async () => {
    const req = new Request(
      'https://example.com/callback?session_id=no-such-session&oauth_token=x&oauth_verifier=y',
    )
    const ctx = createExecutionContext()
    const res = await DiscogsOAuthHandler.fetch(req, env as any, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(400)
  })

  it('returns 403 when CSRF token is missing', async () => {
    const csrfToken = 'test-csrf-token'
    await env.MCP_SESSIONS.put(
      'login-pending:csrf-test',
      JSON.stringify({
        sessionId: 'csrf-test',
        csrfToken,
        requestToken: 'tok',
        requestTokenSecret: 'sec',
        fromMcpClient: true,
        timestamp: Date.now(),
      }),
    )
    const req = new Request(
      'https://example.com/callback?session_id=csrf-test&oauth_token=tok&oauth_verifier=x',
      // No cookie
    )
    const ctx = createExecutionContext()
    const res = await DiscogsOAuthHandler.fetch(req, env as any, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(403)
  })

  it('stores session in KV and returns HTML success page when CSRF is valid', async () => {
    const csrfToken = 'valid-csrf-token'
    await env.MCP_SESSIONS.put(
      'login-pending:happy-path',
      JSON.stringify({
        sessionId: 'happy-path',
        csrfToken,
        requestToken: 'mock-request-token',
        requestTokenSecret: 'mock-request-secret',
        fromMcpClient: true,
        timestamp: Date.now(),
      }),
    )

    // Mock identity fetch
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 99, username: 'happyuser' }),
    })

    const isHttps = false // test env is http
    const cookieName = isHttps ? '__Host-csrf' : 'csrf'
    const req = new Request(
      'https://example.com/callback?session_id=happy-path&oauth_token=mock-request-token&oauth_verifier=mock-verifier',
      { headers: { Cookie: `${cookieName}=${csrfToken}` } },
    )
    const ctx = createExecutionContext()
    const res = await DiscogsOAuthHandler.fetch(req, env as any, ctx)
    await waitOnExecutionContext(ctx)

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Authentication Successful')

    const session = await env.MCP_SESSIONS.get('session:happy-path')
    expect(session).not.toBeNull()
    const sessionData = JSON.parse(session!)
    expect(sessionData.username).toBe('happyuser')
  })
})
```

- [ ] **Step 2: Run to confirm they fail**

```bash
npx vitest run test/auth/oauth-handler.spec.ts -t "login|callback" 2>&1 | tail -20
```

Expected: FAIL

- [ ] **Step 3: Implement `handleManualLogin`**

Replace the stub:

```typescript
async function handleManualLogin(request: Request, env: OAuthEnv): Promise<Response> {
  try {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('session_id') ?? crypto.randomUUID()
    const fromMcpClient = !!url.searchParams.get('session_id')

    // Generate CSRF token
    const csrfToken = crypto.randomUUID()

    // Construct Discogs callback URL for the manual path
    const callbackUrl = `${url.protocol}//${url.host}/callback?session_id=${sessionId}`

    // Get Discogs request token
    const discogsAuth = new DiscogsAuth(env.DISCOGS_CONSUMER_KEY, env.DISCOGS_CONSUMER_SECRET)
    const { oauth_token: requestToken, oauth_token_secret: requestTokenSecret } =
      await discogsAuth.getRequestToken(callbackUrl)

    // Single KV write with all fields (CSRF token + Discogs tokens)
    await env.MCP_SESSIONS.put(
      `login-pending:${sessionId}`,
      JSON.stringify({
        sessionId,
        csrfToken,
        requestToken,
        requestTokenSecret,
        fromMcpClient,
        timestamp: Date.now(),
      }),
      { expirationTtl: 600 }, // 10 minutes
    )

    // Use __Host- prefix on HTTPS, plain on HTTP (local dev)
    const isHttps = url.protocol === 'https:'
    const cookieName = isHttps ? '__Host-csrf' : 'csrf'
    const cookieFlags = isHttps
      ? `${cookieName}=${csrfToken}; HttpOnly; Secure; SameSite=Lax; Path=/`
      : `${cookieName}=${csrfToken}; HttpOnly; SameSite=Lax; Path=/`

    const authorizeUrl = `https://www.discogs.com/oauth/authorize?oauth_token=${requestToken}`

    return new Response(null, {
      status: 302,
      headers: {
        Location: authorizeUrl,
        'Set-Cookie': cookieFlags,
      },
    })
  } catch (error) {
    console.error('[LOGIN] /login error:', error)
    return new Response(
      `Login error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      { status: 500 },
    )
  }
}
```

- [ ] **Step 4: Implement `handleManualCallback`**

Replace the stub:

```typescript
async function handleManualCallback(request: Request, env: OAuthEnv): Promise<Response> {
  try {
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('session_id')
    const oauthToken = url.searchParams.get('oauth_token')
    const oauthVerifier = url.searchParams.get('oauth_verifier')

    if (!sessionId || !oauthToken || !oauthVerifier) {
      return new Response('Missing required parameters', { status: 400 })
    }

    // Look up the pending login
    const pendingKey = `login-pending:${sessionId}`
    const pendingDataStr = await env.MCP_SESSIONS.get(pendingKey)

    if (!pendingDataStr) {
      return new Response(
        '<html><body><h1>Session Expired</h1><p>Your login session has expired. Please try again.</p></body></html>',
        { status: 400, headers: { 'Content-Type': 'text/html' } },
      )
    }

    const pendingData = JSON.parse(pendingDataStr)

    // Validate CSRF token from cookie
    const isHttps = url.protocol === 'https:'
    const cookieName = isHttps ? '__Host-csrf' : 'csrf'
    const cookieHeader = request.headers.get('Cookie') ?? ''
    const cookies = Object.fromEntries(
      cookieHeader.split(';').map((c) => {
        const [k, ...v] = c.trim().split('=')
        return [k, v.join('=')]
      }),
    )
    const csrfFromCookie = cookies[cookieName]

    if (!csrfFromCookie || csrfFromCookie !== pendingData.csrfToken) {
      await env.MCP_SESSIONS.delete(pendingKey)
      return new Response('CSRF validation failed. Please try logging in again.', { status: 403 })
    }

    // Clean up pending entry
    await env.MCP_SESSIONS.delete(pendingKey)

    // Exchange tokens
    const discogsAuth = new DiscogsAuth(env.DISCOGS_CONSUMER_KEY, env.DISCOGS_CONSUMER_SECRET)
    const { oauth_token: accessToken, oauth_token_secret: accessTokenSecret } =
      await discogsAuth.getAccessToken(oauthToken, pendingData.requestTokenSecret, oauthVerifier)

    // Fetch identity
    const identityRes = await fetch('https://api.discogs.com/oauth/identity', {
      headers: {
        Authorization: (
          await discogsAuth.getAuthHeaders('https://api.discogs.com/oauth/identity', 'GET', {
            key: accessToken,
            secret: accessTokenSecret,
          })
        ).Authorization,
        'User-Agent': 'discogs-mcp/1.0.0',
      },
    })

    if (!identityRes.ok) {
      throw new Error(`Failed to fetch Discogs identity: ${identityRes.status}`)
    }

    const identity = await identityRes.json() as { id: number; username: string }

    // Store session in KV (7 days)
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000
    await env.MCP_SESSIONS.put(
      `session:${sessionId}`,
      JSON.stringify({
        numericId: String(identity.id),
        username: identity.username,
        accessToken,
        accessTokenSecret,
        timestamp: Date.now(),
        expiresAt,
        sessionId,
      }),
      { expirationTtl: 7 * 24 * 60 * 60 },
    )

    const fromMcpClient = !!pendingData.fromMcpClient
    const instructionsHtml = fromMcpClient
      ? `<p>Your MCP session is now connected. You can close this window.</p>`
      : `<p>Use this URL in your MCP client: <code>${url.protocol}//${url.host}/mcp?session_id=${sessionId}</code></p>`

    return new Response(
      `<!DOCTYPE html><html><body>
        <h1>Authentication Successful!</h1>
        <p>You're now authenticated as <strong>${identity.username}</strong> on Discogs.</p>
        ${instructionsHtml}
      </body></html>`,
      {
        status: 200,
        headers: {
          'Content-Type': 'text/html',
          'Set-Cookie': `${cookieName}=; Max-Age=0; Path=/`,
        },
      },
    )
  } catch (error) {
    console.error('[LOGIN] /callback error:', error)
    return new Response(
      `Authentication failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      { status: 500 },
    )
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run test/auth/oauth-handler.spec.ts 2>&1 | tail -20
```

Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/auth/oauth-handler.ts test/auth/oauth-handler.spec.ts
git commit -m "feat: implement /login and /callback manual login path with CSRF"
```

---

## Chunk 3: Entry Point

Creates `src/index-oauth.ts`, wires up the OAuth provider, and updates `wrangler.toml`.

### Task 10: Create `src/index-oauth.ts`

**Files:**
- Create: `src/index-oauth.ts`

- [ ] **Step 1: Write the new entry point**

```typescript
// ABOUTME: Main entry point supporting MCP OAuth 2.1 and session-based authentication.
// ABOUTME: Routes /mcp requests to session handler or OAuth provider based on auth state.
import { OAuthProvider } from '@cloudflare/workers-oauth-provider'
import type { ExecutionContext } from '@cloudflare/workers-types'
import { createMcpHandler } from 'agents/mcp'

import { DiscogsOAuthHandler, type DiscogsUserProps } from './auth/oauth-handler'
import { createMcpServer } from './mcp/server'
import type { Env } from './types/env'

const SERVER_VERSION = '1.0.0'

// PKCE + standard MCP session TTL (7 days)
const ACCESS_TOKEN_TTL = 7 * 24 * 60 * 60

/**
 * OAuth provider instance — handles all OAuth 2.1 endpoints automatically:
 * - /.well-known/oauth-authorization-server (discovery)
 * - /oauth/register (dynamic client registration)
 * - /oauth/token (token exchange)
 * - All routes not intercepted by the main fetch handler
 */
const oauthProvider = new OAuthProvider({
  apiRoute: '/mcp',
  apiHandler: {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      // This runs only for OAuth-authenticated requests (valid bearer token).
      // workers-oauth-provider injects the user props from completeAuthorization() into ctx.props.
      const url = new URL(request.url)
      const baseUrl = `${url.protocol}//${url.host}`

      const { server, setContext } = createMcpServer(env, baseUrl)

      const props = (ctx as unknown as { props?: DiscogsUserProps }).props
      if (props?.username && props?.accessToken) {
        setContext({
          session: {
            username: props.username,
            numericId: props.numericId,
            accessToken: props.accessToken,
            accessTokenSecret: props.accessTokenSecret,
          },
        })
      }

      return createMcpHandler(server)(request, env, ctx)
    },
  },
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/oauth/token',
  clientRegistrationEndpoint: '/oauth/register',
  defaultHandler: DiscogsOAuthHandler,
  accessTokenTTL: ACCESS_TOKEN_TTL,
})

/**
 * Handle MCP request using a pre-existing KV session (session_id param or Mcp-Session-Id header).
 * Two call paths:
 *   - session_id param: called unconditionally, handles KV miss internally
 *   - Mcp-Session-Id header: only called after router verifies KV entry exists
 */
async function handleSessionBasedMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  sessionId: string,
): Promise<Response> {
  const url = new URL(request.url)
  const baseUrl = `${url.protocol}//${url.host}`

  const sessionDataStr = await env.MCP_SESSIONS.get(`session:${sessionId}`)

  if (!sessionDataStr) {
    return new Response(JSON.stringify({ error: 'invalid_session' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
      // Intentionally no WWW-Authenticate header — client should not retry via OAuth
    })
  }

  const sessionData = JSON.parse(sessionDataStr)

  if (sessionData.expiresAt && Date.now() > sessionData.expiresAt) {
    return new Response(JSON.stringify({ error: 'session_expired' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { server, setContext } = createMcpServer(env, baseUrl)
  setContext({
    session: {
      username: sessionData.username,
      numericId: sessionData.numericId,
      accessToken: sessionData.accessToken,
      accessTokenSecret: sessionData.accessTokenSecret,
    },
    sessionId,
  })

  const handler = createMcpHandler(server)
  const response = await handler(request, env, ctx)

  const newHeaders = new Headers(response.headers)
  newHeaders.set('Mcp-Session-Id', sessionId)
  newHeaders.set('Access-Control-Expose-Headers', 'Mcp-Session-Id')

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  })
}

/**
 * Strip the 'resource' parameter from OAuth token requests.
 * Claude.ai sends the full MCP endpoint URL as `resource`, but workers-oauth-provider
 * validates audience against ${protocol}//${host} only. Stripping prevents audience mismatch.
 * Only applied when Content-Type is application/x-www-form-urlencoded.
 */
async function stripResourceParam(request: Request): Promise<Request> {
  if (request.method !== 'POST') return request
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.includes('application/x-www-form-urlencoded')) return request

  const body = await request.text()
  const params = new URLSearchParams(body)

  if (!params.has('resource')) {
    return new Request(request.url, { method: request.method, headers: request.headers, body })
  }

  params.delete('resource')
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: params.toString(),
  })
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const baseUrl = `${url.protocol}//${url.host}`

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
          'Access-Control-Expose-Headers': 'Mcp-Session-Id',
          'Access-Control-Max-Age': '86400',
        },
      })
    }

    // Static routes — handled before OAuth provider
    if (url.pathname === '/' && request.method === 'GET') {
      return new Response(
        JSON.stringify({
          name: 'Discogs MCP Server',
          version: SERVER_VERSION,
          description: 'Model Context Protocol server for Discogs collection access',
          endpoints: { '/mcp': 'MCP endpoint', '/login': 'Manual OAuth login', '/health': 'Health check' },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } },
      )
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      return new Response(
        JSON.stringify({ status: 'ok', timestamp: new Date().toISOString(), version: SERVER_VERSION }),
        { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } },
      )
    }

    if (url.pathname === '/.well-known/mcp.json' && request.method === 'GET') {
      return new Response(
        JSON.stringify({
          version: '1.0',
          serverInfo: { name: 'discogs-mcp', version: SERVER_VERSION },
          transport: { type: 'streamable-http', endpoint: '/mcp' },
          authentication: { required: false },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } },
      )
    }

    // /mcp — session routing (applies to both GET and POST)
    if (url.pathname === '/mcp') {
      // 1. Explicit session_id param → session path (handles KV miss internally)
      const sessionId = url.searchParams.get('session_id')
      if (sessionId) {
        return handleSessionBasedMcp(request, env, ctx, sessionId)
      }

      // 2. Mcp-Session-Id header — only route to session path if KV entry exists
      const mcpSessionId = request.headers.get('Mcp-Session-Id')
      if (mcpSessionId) {
        const sessionDataStr = await env.MCP_SESSIONS.get(`session:${mcpSessionId}`)
        if (sessionDataStr) {
          return handleSessionBasedMcp(request, env, ctx, mcpSessionId)
        }
        // No KV entry → fall through to OAuth provider (returns 401 + WWW-Authenticate)
      }

      // 3. Everything else → OAuth provider
      const response = await oauthProvider.fetch(request, env, ctx)

      // Inject WWW-Authenticate on 401 responses from /mcp
      if (response.status === 401) {
        const newHeaders = new Headers(response.headers)
        newHeaders.set(
          'WWW-Authenticate',
          `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
        )
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders,
        })
      }

      return response
    }

    // /oauth/token — strip resource param before forwarding
    if (url.pathname === '/oauth/token') {
      request = await stripResourceParam(request)
      return oauthProvider.fetch(request, env, ctx)
    }

    // All other routes → OAuth provider (handles /authorize, /discogs-callback, /login,
    // /callback, /.well-known/oauth-protected-resource, /.well-known/oauth-authorization-server)
    return oauthProvider.fetch(request, env, ctx)
  },
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit 2>&1 | grep "index-oauth" | head -10
```

Expected: no errors from `index-oauth.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/index-oauth.ts
git commit -m "feat: add src/index-oauth.ts — MCP OAuth 2.1 entry point"
```

---

### Task 11: Update `wrangler.toml` and delete `src/auth/jwt.ts`

**Files:**
- Modify: `wrangler.toml`
- Delete: `src/auth/jwt.ts`

- [ ] **Step 1: Update `wrangler.toml` to use the new entry point**

In `wrangler.toml`, change:
```toml
main = "src/index.ts"
```
to:
```toml
main = "src/index-oauth.ts"
```

- [ ] **Step 2: Remove JWT_SECRET from wrangler.toml secrets comment**

In `wrangler.toml`, find the secrets comment block and remove `# - JWT_SECRET`. It should now read:
```toml
# Secrets (set via wrangler secret put):
# - DISCOGS_CONSUMER_KEY
# - DISCOGS_CONSUMER_SECRET
```

- [ ] **Step 3: Delete `src/auth/jwt.ts`**

```bash
rm /Users/rian/Documents/GitHub/discogs-mcp/src/auth/jwt.ts
```

- [ ] **Step 4: Verify the project still compiles with the new main**

```bash
npx tsc --noEmit 2>&1 | head -30
```

There may be errors from `src/index.ts` (still imports jwt.ts). Those are expected — `index.ts` is being kept only for rollback and will not be the active entry point. If there are errors from `src/index-oauth.ts` or other active files, fix them.

- [ ] **Step 5: Run all tests to make sure nothing broke**

```bash
npx vitest run 2>&1 | tail -20
```

Expected: all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add wrangler.toml
git rm src/auth/jwt.ts
git commit -m "feat: point wrangler.toml at index-oauth.ts, delete jwt.ts"
```

---

## Chunk 4: Tests

Adds the full test suite for the new entry point.

### Task 12: Unit tests — routing and 401 behavior

**Files:**
- Create: `test/index-oauth.spec.ts`

- [ ] **Step 1: Write the routing and 401 tests**

Create `test/index-oauth.spec.ts`:

```typescript
// ABOUTME: Tests for src/index-oauth.ts — routing, 401 behavior, session paths, discovery.
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { describe, it, expect, vi } from 'vitest'
import worker from '../src/index-oauth'

// MCP initialize request body (required for the MCP handler to respond)
const MCP_INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'TestClient', version: '1.0.0' },
  },
  id: 1,
})

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
}

describe('POST /mcp — unauthenticated', () => {
  it('returns 401', async () => {
    const req = new Request('https://example.com/mcp', {
      method: 'POST', body: MCP_INIT_BODY, headers: MCP_HEADERS,
    })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(401)
  })

  it('includes WWW-Authenticate with resource_metadata', async () => {
    const req = new Request('https://example.com/mcp', {
      method: 'POST', body: MCP_INIT_BODY, headers: MCP_HEADERS,
    })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.headers.get('WWW-Authenticate')).toContain(
      'Bearer resource_metadata="https://example.com/.well-known/oauth-protected-resource"',
    )
  })

  it('does not contain a copy-paste login URL in the body', async () => {
    const req = new Request('https://example.com/mcp', {
      method: 'POST', body: MCP_INIT_BODY, headers: MCP_HEADERS,
    })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    const body = await res.text()
    expect(body).not.toContain('/login?session_id=')
    expect(body).not.toContain('/login?connection_id=')
  })
})

describe('POST /mcp — session_id param path', () => {
  it('returns 401 JSON (no WWW-Authenticate) when session not in KV', async () => {
    const req = new Request('https://example.com/mcp?session_id=nonexistent', {
      method: 'POST', body: MCP_INIT_BODY, headers: MCP_HEADERS,
    })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(401)
    // Must NOT have WWW-Authenticate — this is an explicit session claim
    expect(res.headers.get('WWW-Authenticate')).toBeNull()
    const body = await res.json() as any
    expect(body.error).toBe('invalid_session')
  })

  it('returns 200 when session_id has a valid KV entry', async () => {
    const sessionId = 'test-valid-session'
    await env.MCP_SESSIONS.put(
      `session:${sessionId}`,
      JSON.stringify({
        username: 'testuser',
        numericId: '12345',
        accessToken: 'tok',
        accessTokenSecret: 'sec',
        expiresAt: Date.now() + 60 * 60 * 1000,
        sessionId,
      }),
    )
    const req = new Request(`https://example.com/mcp?session_id=${sessionId}`, {
      method: 'POST', body: MCP_INIT_BODY, headers: MCP_HEADERS,
    })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200)
  })
})

describe('POST /mcp — Mcp-Session-Id header', () => {
  it('returns 401 + WWW-Authenticate when Mcp-Session-Id has no KV entry', async () => {
    const req = new Request('https://example.com/mcp', {
      method: 'POST', body: MCP_INIT_BODY,
      headers: { ...MCP_HEADERS, 'Mcp-Session-Id': 'no-such-session' },
    })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer resource_metadata=')
  })

  it('returns 200 when Mcp-Session-Id has a valid KV entry', async () => {
    const sessionId = 'mcp-header-session'
    await env.MCP_SESSIONS.put(
      `session:${sessionId}`,
      JSON.stringify({
        username: 'testuser2',
        numericId: '67890',
        accessToken: 'tok2',
        accessTokenSecret: 'sec2',
        expiresAt: Date.now() + 60 * 60 * 1000,
        sessionId,
      }),
    )
    const req = new Request('https://example.com/mcp', {
      method: 'POST', body: MCP_INIT_BODY,
      headers: { ...MCP_HEADERS, 'Mcp-Session-Id': sessionId },
    })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200)
  })
})

describe('GET /.well-known/oauth-protected-resource', () => {
  it('returns 200 with required fields', async () => {
    const req = new Request('https://example.com/.well-known/oauth-protected-resource')
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.resource).toBe('https://example.com')
    expect(body.authorization_servers).toContain('https://example.com')
    expect(body.bearer_methods_supported).toContain('header')
  })
})

describe('GET /.well-known/oauth-authorization-server', () => {
  it('returns 200 with all MCP-required fields', async () => {
    const req = new Request('https://example.com/.well-known/oauth-authorization-server')
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.issuer).toBeDefined()
    expect(body.authorization_endpoint).toBeDefined()
    expect(body.token_endpoint).toBeDefined()
    expect(body.response_types_supported).toContain('code')
    expect(body.grant_types_supported).toContain('authorization_code')
    expect(body.code_challenge_methods_supported).toContain('S256')
  })
})

describe('GET /health', () => {
  it('returns 200 with status ok', async () => {
    const req = new Request('https://example.com/health')
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.status).toBe('ok')
  })
})
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run test/index-oauth.spec.ts 2>&1 | tail -30
```

Expected: most tests pass. Fix any failures that arise from implementation gaps.

- [ ] **Step 3: Commit passing tests**

```bash
git add test/index-oauth.spec.ts
git commit -m "test: routing and 401 behavior for index-oauth.ts"
```

---

### Task 13: Integration test — full OAuth round-trip

**Files:**
- Create: `test/oauth-roundtrip.spec.ts`

- [ ] **Step 1: Write the round-trip test**

```typescript
// ABOUTME: Integration test for the full MCP OAuth 2.1 round-trip.
// ABOUTME: Verifies: 401 → discovery → /authorize → /discogs-callback → token → /mcp 200.
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import worker from '../src/index-oauth'

// Mock DiscogsAuth so we don't hit real Discogs APIs
vi.mock('../src/auth/discogs', () => ({
  DiscogsAuth: vi.fn().mockImplementation(() => ({
    getRequestToken: vi.fn().mockResolvedValue({
      oauth_token: 'mock-request-token',
      oauth_token_secret: 'mock-request-secret',
      oauth_callback_confirmed: 'true',
    }),
    getAccessToken: vi.fn().mockResolvedValue({
      oauth_token: 'mock-access-token',
      oauth_token_secret: 'mock-access-secret',
    }),
    getAuthHeaders: vi.fn().mockResolvedValue({
      Authorization: 'OAuth mock-auth',
    }),
  })),
}))

// Mock fetch for Discogs /oauth/identity
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const BASE_URL = 'https://discogs-mcp-prod.example.com'

const MCP_INIT = JSON.stringify({
  jsonrpc: '2.0', method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'Test', version: '1.0' } },
  id: 1,
})
const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }

/**
 * Compute PKCE S256 code challenge
 */
async function computeS256Challenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

describe('Full OAuth round-trip', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('Step 1: POST /mcp returns 401 + WWW-Authenticate', async () => {
    const req = new Request(`${BASE_URL}/mcp`, { method: 'POST', body: MCP_INIT, headers: MCP_HEADERS })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toContain('Bearer resource_metadata=')
  })

  it('Step 2: GET /.well-known/oauth-protected-resource returns authorization_servers', async () => {
    const req = new Request(`${BASE_URL}/.well-known/oauth-protected-resource`)
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.authorization_servers).toBeDefined()
    expect(body.authorization_servers.length).toBeGreaterThan(0)
  })

  it('Step 3: GET /.well-known/oauth-authorization-server returns valid metadata', async () => {
    const req = new Request(`${BASE_URL}/.well-known/oauth-authorization-server`)
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.issuer).toBeDefined()
    expect(body.authorization_endpoint).toBeDefined()
    expect(body.token_endpoint).toBeDefined()
    expect(body.code_challenge_methods_supported).toContain('S256')
  })

  it('Step 4: GET /authorize redirects to discogs.com/oauth/authorize', async () => {
    const verifier = 'test-verifier-abcdefg12345678'
    const challenge = await computeS256Challenge(verifier)

    const url = new URL(`${BASE_URL}/authorize`)
    url.searchParams.set('client_id', 'test-client-id')
    url.searchParams.set('redirect_uri', `${BASE_URL}/callback`)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('state', 'test-state-123')
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')

    const req = new Request(url.toString())
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(res.status).toBe(302)
    const location = res.headers.get('Location') ?? ''
    expect(location).toContain('discogs.com/oauth/authorize')
    expect(location).toContain('oauth_token=mock-request-token')
  })

  it('Step 5–6: GET /discogs-callback completes authorization and redirects to client', async () => {
    // Pre-seed KV with pending OAuth state (as if /authorize ran)
    await env.MCP_SESSIONS.put(
      'oauth-pending:mock-request-token',
      JSON.stringify({
        oauthReqInfo: {
          clientId: 'test-client-id',
          redirectUri: `${BASE_URL}/callback`,
          state: 'test-state-123',
          scope: [],
        },
        requestTokenSecret: 'mock-request-secret',
      }),
    )

    // Mock identity API
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 42, username: 'discogsuser' }),
    })

    const req = new Request(
      `${BASE_URL}/discogs-callback?oauth_token=mock-request-token&oauth_verifier=mock-verifier`,
    )
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)

    expect([302, 303]).toContain(res.status)
    // Pending KV entry should be deleted
    const pending = await env.MCP_SESSIONS.get('oauth-pending:mock-request-token')
    expect(pending).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run test/oauth-roundtrip.spec.ts 2>&1 | tail -30
```

Expected: all steps pass.

- [ ] **Step 3: Commit**

```bash
git add test/oauth-roundtrip.spec.ts
git commit -m "test: full OAuth 2.1 round-trip integration test"
```

---

### Task 14: Manual login round-trip test

**Files:**
- Create: `test/manual-login.spec.ts`

- [ ] **Step 1: Write the manual login round-trip test**

```typescript
// ABOUTME: Integration test for the manual login path (/login → /callback → /mcp?session_id=).
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import worker from '../src/index-oauth'

vi.mock('../src/auth/discogs', () => ({
  DiscogsAuth: vi.fn().mockImplementation(() => ({
    getRequestToken: vi.fn().mockResolvedValue({
      oauth_token: 'manual-request-token',
      oauth_token_secret: 'manual-request-secret',
      oauth_callback_confirmed: 'true',
    }),
    getAccessToken: vi.fn().mockResolvedValue({
      oauth_token: 'manual-access-token',
      oauth_token_secret: 'manual-access-secret',
    }),
    getAuthHeaders: vi.fn().mockResolvedValue({ Authorization: 'OAuth mock' }),
  })),
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const BASE_URL = 'https://example.com'
const SESSION_ID = 'manual-test-session'

const MCP_INIT = JSON.stringify({
  jsonrpc: '2.0', method: 'initialize',
  params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'Test', version: '1.0' } },
  id: 1,
})
const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }

describe('Manual login round-trip', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('Step 1: GET /login redirects to Discogs and stores pending state', async () => {
    const req = new Request(`${BASE_URL}/login?session_id=${SESSION_ID}`)
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toContain('discogs.com/oauth/authorize')

    // Capture CSRF cookie for step 2
    const setCookie = res.headers.get('Set-Cookie') ?? ''
    expect(setCookie).toContain('csrf')

    // Verify KV entry was written
    const pending = await env.MCP_SESSIONS.get(`login-pending:${SESSION_ID}`)
    expect(pending).not.toBeNull()
    const data = JSON.parse(pending!)
    expect(data.csrfToken).toBeDefined()
    expect(data.requestToken).toBe('manual-request-token')
  })

  it('Step 2: GET /callback with valid CSRF stores session and returns success page', async () => {
    // Seed pending state
    const csrfToken = 'test-csrf-manual'
    await env.MCP_SESSIONS.put(
      `login-pending:${SESSION_ID}`,
      JSON.stringify({
        sessionId: SESSION_ID,
        csrfToken,
        requestToken: 'manual-request-token',
        requestTokenSecret: 'manual-request-secret',
        fromMcpClient: true,
        timestamp: Date.now(),
      }),
    )

    // Mock identity API
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 777, username: 'manualuser' }),
    })

    const req = new Request(
      `${BASE_URL}/callback?session_id=${SESSION_ID}&oauth_token=manual-request-token&oauth_verifier=manual-verifier`,
      { headers: { Cookie: `csrf=${csrfToken}` } }, // HTTP/localhost uses plain 'csrf'
    )
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain('Authentication Successful')
    expect(body).toContain('manualuser')

    const session = await env.MCP_SESSIONS.get(`session:${SESSION_ID}`)
    expect(session).not.toBeNull()
    const sessionData = JSON.parse(session!)
    expect(sessionData.username).toBe('manualuser')
  })

  it('Step 3: POST /mcp?session_id=... returns 200 after successful login', async () => {
    // Seed valid session (as if step 2 completed)
    await env.MCP_SESSIONS.put(
      `session:${SESSION_ID}`,
      JSON.stringify({
        username: 'manualuser',
        numericId: '777',
        accessToken: 'manual-access-token',
        accessTokenSecret: 'manual-access-secret',
        expiresAt: Date.now() + 60 * 60 * 1000,
        sessionId: SESSION_ID,
      }),
    )

    const req = new Request(`${BASE_URL}/mcp?session_id=${SESSION_ID}`, {
      method: 'POST', body: MCP_INIT, headers: MCP_HEADERS,
    })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)

    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 2: Run tests**

```bash
npx vitest run test/manual-login.spec.ts 2>&1 | tail -30
```

Expected: all steps pass.

- [ ] **Step 3: Run full test suite to verify nothing broke**

```bash
npx vitest run 2>&1 | tail -30
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add test/manual-login.spec.ts
git commit -m "test: manual login round-trip integration test"
```

---

### Task 15: Verify success criteria and manual smoke test

- [ ] **Step 1: Run all tests and confirm they pass**

```bash
npx vitest run 2>&1 | grep -E "passed|failed|error"
```

Expected: all tests passed, 0 failed.

- [ ] **Step 2: Build to confirm no TypeScript errors**

```bash
npm run build 2>&1 | tail -20
```

Expected: successful build, no TS errors.

- [ ] **Step 3: Start dev server and test with MCP Inspector**

```bash
npm run dev
```

In a second terminal:
```bash
npx @modelcontextprotocol/inspector http://localhost:8787/mcp
```

Expected: MCP Inspector shows an OAuth prompt and opens the browser to Discogs — NOT a copy-paste URL.

- [ ] **Step 4: Verify session-based path still works**

```bash
curl -s http://localhost:8787/login?session_id=test123
```

Expected: redirect to `discogs.com/oauth/authorize`.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete MCP OAuth 2.1 compliance — browser flow replaces copy-paste URLs"
```

---

## Post-Completion

- [ ] Deploy to production: `npm run deploy:prod`
- [ ] Verify all success criteria on production (connect MCP Inspector to production URL)
- [ ] After successful production verification, delete `src/index.ts`:
  ```bash
  git rm src/index.ts
  git commit -m "chore: remove legacy index.ts after production verification"
  ```
