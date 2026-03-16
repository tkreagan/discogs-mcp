# OAuth Flow Redesign: Design Spec

**Date:** 2026-03-15
**Status:** Approved

---

## Problem

All MCP clients (Claude Code, Claude Desktop, opencode) receive a copy-paste URL when they need to authenticate, instead of having the browser open automatically.

The correct MCP OAuth 2.1 behavior:
1. Client sends unauthenticated `POST /mcp`
2. Server returns `401 WWW-Authenticate: Bearer resource_metadata="https://host/.well-known/oauth-protected-resource"`
3. Client fetches `/.well-known/oauth-protected-resource`, then `/.well-known/oauth-authorization-server`
4. Client opens browser to `/authorize`
5. User authorizes on Discogs → `completeAuthorization()` runs → token issued to client
6. Client retries with bearer token — no copy/paste required

---

## Goals

- All supported clients (Claude Code, Claude Desktop, opencode) trigger an automatic browser open for first-time authentication
- No copy-paste `/login?...` URLs shown for clients that support MCP OAuth
- Clients with existing sessions (via `session_id` param or `Mcp-Session-Id` header + KV) continue to work without re-authenticating
- Comprehensive automated tests that lock in the fix and prevent regression
- Remove security issue: Discogs OAuth signing key currently logged to console

## Non-Goals

- Changing any MCP tool logic, rate limiting, caching, or collection indexing
- Supporting new MCP clients beyond Claude Code, Claude Desktop, and opencode
- Keeping backward compatibility with the old `connection_id` session approach

---

## Architecture

### New Files

| File | Purpose |
|------|---------|
| `src/index-oauth.ts` | New main entry point (replaces `src/index.ts` in `wrangler.toml`) |
| `src/auth/oauth-handler.ts` | Auth route handler: `/authorize`, `/discogs-callback`, `/login`, `/callback`, `/.well-known/oauth-protected-resource` (served publicly, no auth required — unauthenticated clients must be able to read it for discovery). Note: `/.well-known/oauth-authorization-server` is served automatically by `@cloudflare/workers-oauth-provider` and does not appear in `oauth-handler.ts`. |

### Changed Files

| File | Change |
|------|--------|
| `wrangler.toml` | Point `main` at `src/index-oauth.ts` |
| `src/auth/discogs.ts` | Remove debug `console.log` of signing key and signature |
| `src/mcp/server.ts` | (1) Rename `createServer` → `createMcpServer` and refactor to return `{ server, setContext }` (mirroring lastfm-mcp), so both OAuth and session paths can inject props. (2) Remove `buildSessionAuthMessages` default fallback — the OAuth path always passes `buildOAuthAuthMessages()` explicitly. |

### Deleted Files

| File | Reason | Timing |
|------|--------|--------|
| `src/index.ts` | Replaced by `src/index-oauth.ts` | **After** production verification is complete (not during initial implementation) |
| `src/auth/jwt.ts` | JWT sessions replaced by OAuth bearer tokens; manual login stores directly in KV. Remove imports from `src/mcp/server.ts` and `src/index.ts` (the only current importers) before deleting. | During implementation |

### KV Binding

The existing `MCP_SESSIONS` KV namespace binding is reused for all session and pending-auth storage. No new KV namespace is needed.

### New Dependency

`@cloudflare/workers-oauth-provider` — provides `OAuthProvider`, `AuthRequest`, and `OAuthHelpers` types. The library also automatically enforces PKCE (`code_challenge`/`code_challenge_method=S256`) for public clients and rejects authorization requests missing `code_challenge` with a `400 invalid_request` response. No additional PKCE enforcement code is needed.

**Scopes:** The server does not define custom scopes. Pass `scope: oauthReqInfo.scope` (whatever the client requested) to `completeAuthorization()` unchanged. The `/.well-known/oauth-authorization-server` `scopes_supported` field is an empty array — the library handles this in its discovery response.

**`redirect_uri` validation:** The library enforces that the `redirect_uri` in `POST /oauth/token` matches the one used during `/authorize`. No additional validation code is needed. Tests must use matching `redirect_uri` values across the authorize and token exchange steps.

**OAuth bearer token TTL:** Set `accessTokenTTL: 7 * 24 * 60 * 60` (7 days) in the `OAuthProvider` constructor options. Manual KV sessions also use 7 days (`expirationTtl: 7 * 24 * 60 * 60`). Always set TTLs explicitly — do not rely on library defaults.

**`completeAuthorization()` return type:** Returns `{ redirectTo: string }` where `redirectTo` is the client's `redirect_uri` with `?code=...&state=...` appended by the library. Use `return Response.redirect(redirectTo, 302)`. It does not return a `Response` object directly.

**`/oauth/token` body encoding:** Strip the `resource` param only if `Content-Type: application/x-www-form-urlencoded` is present; pass the request through unchanged otherwise. (RFC 6749 requires form encoding for token requests, so non-form requests are malformed and the library will reject them regardless.)

**`session_id` param vs `Mcp-Session-Id` header KV miss behavior:** These are intentionally asymmetric. A `session_id` param is an explicit claim by the client that it has a known session — return `401 JSON` with **no** `WWW-Authenticate` header (the client should not retry via browser OAuth). A `Mcp-Session-Id` header on a request with no other session signal means the client doesn't know whether it's authenticated — fall through to the OAuth provider which returns `401 + WWW-Authenticate` (client retries via browser flow). This matches lastfm-mcp behavior. The unit test table must include a test for `session_id` param + KV miss asserting `401` JSON with no `WWW-Authenticate`.

**KV key namespaces:** `oauth-pending:${requestToken}` uses the Discogs `oauth_token` as key (required because that's the only correlation identifier Discogs returns in its callback). `login-pending:${sessionId}` uses the session ID as key (generated by us at login start). These are intentionally different schemes.

---

## Request Routing

`src/index-oauth.ts` handles routing before delegating to the OAuth provider:

Note: the `session_id` / `Mcp-Session-Id` session routing below applies ONLY to `/mcp`. All other paths (including `/callback?session_id=...`) are routed to the OAuth provider without session interception. The session routing applies equally to both `GET /mcp` (SSE) and `POST /mcp` (JSON-RPC) — `handleSessionBasedMcp` delegates to `createMcpHandler` which handles both transports transparently.

```
GET  /                          → marketing/info page
GET  /.well-known/mcp.json      → MCP server card (Claude Desktop discovery)
GET  /health                    → health check
OPTIONS *                       → CORS preflight

POST/GET /mcp
  ├─ has session_id param        → handleSessionBasedMcp() (handles KV miss → 401 JSON internally)
  ├─ has Mcp-Session-Id header
  │   with valid KV session      → handleSessionBasedMcp() (KV pre-checked; won't miss)
  │   with no/expired KV entry   → falls through to oauthProvider.fetch() (→ 401 + WWW-Authenticate)
  └─ everything else             → oauthProvider.fetch()
       ├─ valid bearer token     → authenticated MCP handler (tools receive props)
       └─ no/invalid token       → 401 + WWW-Authenticate (triggers browser OAuth flow)

POST /oauth/token               → INTERCEPTED: strip resource param (if form-encoded), then oauthProvider.fetch()
                                   Mechanism (only if Content-Type is application/x-www-form-urlencoded):
                                   read body as text, parse with `new URLSearchParams(body)`,
                                   delete the `resource` key, re-serialize, reconstruct
                                   `new Request(request.url, { method, headers, body: params.toString() })`.
                                   Note: the original body stream is consumed by the read — always pass
                                   the reconstructed Request to the provider.
                                   Rationale: Claude.ai sends the full endpoint URL (e.g. `https://host/mcp`)
                                   as `resource`, but workers-oauth-provider validates audience against
                                   `https://host` only. The library does not support path-scoped resources
                                   (RFC 8707). Matches lastfm-mcp.
Everything else                 → oauthProvider.fetch() → DefaultHandler (oauth-handler.ts)
                                   Routes handled there:
                                   /authorize                           → MCP OAuth start (→ Discogs)
                                   /discogs-callback                    → MCP OAuth complete
                                   /login                               → manual login start (→ Discogs)
                                   /callback                            → manual login complete
                                   /.well-known/oauth-protected-resource → RFC 9728 metadata
                                   /.well-known/oauth-authorization-server → served by library
```

The `WWW-Authenticate` header is injected on 401 responses from `/mcp`:
```
Bearer resource_metadata="https://host/.well-known/oauth-protected-resource"
```

---

## Discogs OAuth 1.0a Flow Inside MCP OAuth 2.1

The Discogs OAuth 1.0a two-step exchange happens inside the `/authorize` → `/discogs-callback` cycle.

### `/authorize` (MCP client → our server)

1. Parse the OAuth 2.1 request from the MCP client via `env.OAUTH_PROVIDER.parseAuthRequest(request)`
2. Construct `callbackUrl` from the incoming request: `${url.protocol}//${url.host}/discogs-callback` (points to the MCP OAuth callback — NOT `/callback`, which is the separate manual login path).
3. Call Discogs API to get a request token: `const { oauth_token: requestToken, oauth_token_secret: requestTokenSecret } = await discogsAuth.getRequestToken(callbackUrl)`
4. Store `{ oauthReqInfo, requestTokenSecret }` in KV as `oauth-pending:${requestToken}` (TTL 10 min). The key `requestToken` (Discogs `oauth_token`) is what Discogs will return in the callback, so it serves as the correlation key. The `oauthReqInfo` carries the OAuth 2.1 `state` parameter from the original client request; `completeAuthorization()` handles echoing it back to the client automatically.
5. Redirect user's browser to `https://discogs.com/oauth/authorize?oauth_token=${requestToken}`

### `/discogs-callback` (Discogs → our server)

Discogs returns the same `oauth_token` value in the callback query param as was issued in the request token step (per OAuth 1.0a spec) — this is the correlation key.

1. Receive `oauth_token` + `oauth_verifier` from Discogs
2. Look up `oauth-pending:${oauth_token}` from KV to get `requestTokenSecret` + `oauthReqInfo`
3. Delete the pending KV entry immediately (before exchange — intentional: prevents replay and simplifies cleanup regardless of whether the exchange succeeds)
4. Exchange for Discogs access token (`DiscogsAuth.getAccessToken`)
5. Fetch Discogs identity (`GET /oauth/identity`) to get `id` (numeric, mapped to `userId`) and `username`
6. Call `env.OAUTH_PROVIDER.completeAuthorization({ request: oauthReqInfo, userId: username, metadata: { ... }, scope: oauthReqInfo.scope, props: { numericId, username, accessToken, accessTokenSecret } })` — this returns a `{ redirectTo }` object where `redirectTo` is the MCP client's `redirect_uri` with the authorization code embedded as a query parameter (added automatically by the library). Redirect to `redirectTo` with a `302`. Do not construct this redirect manually. See lastfm-mcp `src/auth/oauth-handler.ts` `handleLastfmCallback()` for the reference pattern.

### User Props

```typescript
interface DiscogsUserProps {
  numericId: string     // Discogs numeric user ID (from /oauth/identity response field "id", cast to string)
  username: string      // Discogs username string (from /oauth/identity response field "username")
  accessToken: string
  accessTokenSecret: string
}
```

These props flow into the MCP `apiHandler` via `ctx.props` for OAuth-authenticated requests, replacing the JWT/KV session lookup. For session-based requests, equivalent props are passed via `setContext`. Note: `completeAuthorization()` takes a `userId` argument (the OAuth 2.1 subject — pass `username` here); this is distinct from `props.numericId` (the Discogs numeric ID stored in props for tool use).

### KV Eventual Consistency

Not a practical concern: the write in `/authorize` and the read in `/discogs-callback` are separated by user interaction on Discogs (5–30 seconds minimum), and Cloudflare's anycast routing keeps the same browser on the same data center. Same pattern used successfully in lastfm-mcp.

---

## `handleSessionBasedMcp` Function

Lives in `src/index-oauth.ts`. Two call paths:
- `session_id` param path: called immediately; function handles KV miss internally (step 2)
- `Mcp-Session-Id` header path: router pre-checks KV before calling; function will not encounter a KV miss on this path

`createMcpHandler` (used in step 6) is imported from `agents/mcp` — the Cloudflare Agents SDK. It wraps an `McpServer` instance for use in a Worker fetch handler.

1. Look up `session:${sessionId}` from `MCP_SESSIONS` KV
2. If missing (`session_id` param path only): return `401` JSON `{ error: "invalid_session" }` with **no** `WWW-Authenticate` header
3. If expired (`expiresAt < Date.now()`): return `401` JSON `{ error: "session_expired", ... }`
4. Parse session JSON and construct a `DiscogsUserProps` object: `{ numericId: session.numericId, username: session.username, accessToken: session.accessToken, accessTokenSecret: session.accessTokenSecret }`
5. Create the MCP server using `createMcpServer(env, baseUrl)` — this factory must be updated as part of this work to return `{ server, setContext }`, mirroring lastfm-mcp's `createMcpServer`. The `setContext({ props: DiscogsUserProps })` call makes props available to MCP tools in the same way `ctx.props` does in the OAuth path. The `src/mcp/server.ts` "Changed Files" entry covers this refactor.
6. Run `createMcpHandler(server)(request, env, ctx)`
7. Inject `Mcp-Session-Id: ${sessionId}` header on the response

---

## Manual Login Path

Preserved for clients that don't support MCP OAuth (e.g. Claude Desktop with manual config):

- `GET /login?session_id=<id>` — Steps in order: (1) Generate random CSRF token. (2) Construct `callbackUrl = ${url.protocol}//${url.host}/callback?session_id=${sessionId}`. (3) Call Discogs to get a request token (`requestToken`, `requestTokenSecret`). (4) **Single KV write** (all fields written together, after the Discogs call):
  ```json
  { "sessionId": "...", "csrfToken": "...", "requestToken": "...", "requestTokenSecret": "...", "fromMcpClient": true, "timestamp": 0 }
  ```
  TTL 10 min. (5) Set `__Host-csrf` cookie (value = csrfToken; HTTPS only — fall back to plain `csrf` on HTTP/localhost). (6) Redirect to Discogs authorize URL.
- `GET /callback?session_id=<id>&oauth_token=<discogsToken>&oauth_verifier=<verifier>` — Discogs calls this URL after user authorization. Steps: (1) Look up `login-pending:${sessionId}` from KV — if missing: `400` HTML "Session expired, please try again". (2) Validate CSRF: `__Host-csrf` cookie value must match `csrfToken` in KV entry; on mismatch: `403`, delete KV entry. (3) Delete `login-pending:${sessionId}` from KV. (4) Exchange via `DiscogsAuth.getAccessToken(oauth_token, pendingData.requestTokenSecret, oauth_verifier)`. (5) Fetch Discogs identity to get `numericId` and `username`. (6) Store session in KV as `session:${sessionId}` (TTL 7 days). (7) Return HTML success page.
- Stored session format:
  ```json
  { "numericId", "username", "accessToken", "accessTokenSecret", "timestamp", "expiresAt", "sessionId" }
  ```
  TTL: 7 days (`expirationTtl: 7 * 24 * 60 * 60`).

---

## Security Fixes Bundled

- Remove `console.log('OAuth signing key:', signingKey)` and `console.log('OAuth signature:', signature)` from `src/auth/discogs.ts`
- Replace commented-out `env.MCP_SESSIONS.delete()` with actual KV deletes for pending tokens
- Add CSRF protection to manual login flow (missing from current implementation)

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Discogs request token call fails in `/authorize` | HTML error page with retry link |
| KV write fails in `/authorize` (storing `oauth-pending:`) | HTML error page — abort the flow |
| `/discogs-callback` with no `oauth_token` param | `400` plain text: "Missing OAuth parameters" |
| KV miss in `/discogs-callback` (expired/wrong token) | `400` HTML: "Session expired, please try again" with link back to `/authorize` |
| Discogs access token exchange fails (after KV entry already deleted) | `500` HTML error page — no retry possible, user must restart flow |
| Discogs identity fetch (`/oauth/identity`) fails after successful token exchange | `500` HTML error page — access token is dangling but not stored; user must restart flow |
| `completeAuthorization()` throws | `500` HTML error page |
| KV miss in `handleSessionBasedMcp` | `401` JSON response |
| Expired session in `handleSessionBasedMcp` | `401` JSON response |

---

## Testing

New test files in `test/`:

### Unit Tests

| Test | Assertion |
|------|-----------|
| `POST /mcp` no auth | `401` + `WWW-Authenticate: Bearer resource_metadata=...` |
| Response body does NOT contain copy-paste login URL | confirmed |
| `POST /mcp` with valid bearer token | `200`, reaches MCP handler |
| `POST /mcp?session_id=x` with valid KV session | `200`, session-based path |
| `POST /mcp?session_id=x` with KV miss | `401` JSON `{ error: "invalid_session" }`, **no** `WWW-Authenticate` header |
| `POST /mcp` with `Mcp-Session-Id` header + valid KV | `200`, session-based path |
| `POST /mcp` with `Mcp-Session-Id` header + no KV entry | Falls through to OAuth provider → `401` + `WWW-Authenticate` (same as unauthenticated request) |
| `GET /.well-known/oauth-protected-resource` | correct fields: `resource`, `authorization_servers`, `bearer_methods_supported` |
| `GET /.well-known/oauth-authorization-server` | all MCP-required fields: `issuer`, `authorization_endpoint`, `token_endpoint`, `response_types_supported` (includes `"code"`), `grant_types_supported` (includes `"authorization_code"`), `code_challenge_methods_supported` (includes `"S256"`) |

### Integration Test — Full OAuth Round-Trip

1. `POST /mcp` (no auth) → assert `401` + `WWW-Authenticate`
2. `GET /.well-known/oauth-protected-resource` → assert valid JSON with `authorization_servers`
3. `GET /.well-known/oauth-authorization-server` → assert valid metadata
4. `GET /authorize?client_id=...&redirect_uri=https://client/callback&state=random123&code_challenge=<S256_HASH_OF_VERIFIER>&code_challenge_method=S256&response_type=code` → assert redirect to `discogs.com/oauth/authorize`
5. Simulate Discogs callback: `GET /discogs-callback?oauth_token=mock&oauth_verifier=mock` (mock Discogs token exchange + identity API)
6. Assert: `completeAuthorization()` called, redirect issued to `https://client/callback?code=...&state=random123`
7. Client exchanges code: `POST /oauth/token` with body `grant_type=authorization_code&code=...&redirect_uri=https://client/callback&client_id=...&code_verifier=<ORIGINAL_VERIFIER>` → assert token response with `access_token`. Required fields: `grant_type` (must be `authorization_code`), `client_id`, `redirect_uri` (must match step 4), `code_verifier` (must be the preimage of `code_challenge` from step 4). Missing any of these returns `400`.
8. `POST /mcp` with `Authorization: Bearer <access_token>` → assert `200` with MCP capabilities

### Manual Login Round-Trip

1. `GET /login?session_id=test-session` → assert redirect to Discogs auth URL; capture the `__Host-csrf` cookie value from the response + the CSRF token stored in `login-pending:test-session` in KV
2. `GET /callback?session_id=test-session&oauth_token=mock&oauth_verifier=mock` with `Cookie: __Host-csrf=<value from step 1>` (CSRF must be replayed) → assert HTML success page + `session:test-session` stored in KV
3. `POST /mcp?session_id=test-session` → assert `200`

### Regression Tests

- `POST /mcp` with no auth returns `401` — not `200` with a login URL string in the body
- `POST /mcp?session_id=valid` with valid KV session returns `200`

---

## Deployment

No feature flags needed — this is a routing and auth layer replacement.

**Verification in staging:**
1. Run `npm run dev` locally
2. Use MCP Inspector (`npx @modelcontextprotocol/inspector`) to connect to `http://localhost:8787/mcp`
3. Confirm MCP Inspector shows OAuth prompt and opens browser, not a copy-paste URL
4. Complete the flow and confirm authenticated tools work

**Rollback:** This work should be done on a feature branch. `src/index.ts` and `src/auth/jwt.ts` are deleted as part of implementation — rollback is via `git revert` or reverting the branch, not via restoring `wrangler.toml` alone. Do not delete `src/index.ts` until production verification is complete.

---

## Success Criteria

1. All automated tests pass
2. `POST /mcp` with no auth returns `401` with correct `WWW-Authenticate` header
3. Full OAuth round-trip integration test passes
4. Manual verification: MCP Inspector connecting to `/mcp` triggers OAuth browser open, not a copy-paste URL
5. Manual verification: existing session via `session_id` param or `Mcp-Session-Id` header continues to work
6. No tool response in the OAuth path contains a copy-paste login URL
7. Discogs OAuth signing key no longer logged to console
