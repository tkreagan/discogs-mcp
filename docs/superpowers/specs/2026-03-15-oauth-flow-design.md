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
| `src/auth/oauth-handler.ts` | Auth route handler: `/authorize`, `/discogs-callback`, `/login`, `/callback`, `/.well-known/oauth-protected-resource` |

### Changed Files

| File | Change |
|------|--------|
| `wrangler.toml` | Point `main` at `src/index-oauth.ts` |
| `src/auth/discogs.ts` | Remove debug `console.log` of signing key and signature |
| `src/mcp/server.ts` | Remove `buildSessionAuthMessages` fallback; session auth messages only used in session-based path |

### Deleted Files

| File | Reason |
|------|--------|
| `src/index.ts` | Replaced by `src/index-oauth.ts` |
| `src/auth/jwt.ts` | JWT sessions replaced by OAuth bearer tokens; manual login stores directly in KV |

### New Dependency

`@cloudflare/workers-oauth-provider` — provides `OAuthProvider`, `AuthRequest`, and `OAuthHelpers` types.

---

## Request Routing

`src/index-oauth.ts` handles routing before delegating to the OAuth provider:

```
GET  /                          → marketing/info page
GET  /.well-known/mcp.json      → MCP server card (Claude Desktop discovery)
GET  /health                    → health check
OPTIONS *                       → CORS preflight

POST/GET /mcp
  ├─ has session_id param        → handleSessionBasedMcp() (KV lookup)
  ├─ has Mcp-Session-Id header
  │   with valid KV session      → handleSessionBasedMcp()
  └─ everything else             → oauthProvider.fetch()
       ├─ valid bearer token     → authenticated MCP handler (tools receive props)
       └─ no/invalid token       → 401 + WWW-Authenticate (triggers browser OAuth flow)

POST /oauth/token               → strip resource param, then oauthProvider.fetch()
Everything else                 → oauthProvider.fetch()
                                   (handles /authorize, /discogs-callback,
                                    /login, /callback,
                                    /.well-known/oauth-protected-resource,
                                    /.well-known/oauth-authorization-server)
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
2. Call Discogs API to get a request token (`DiscogsAuth.getRequestToken(callbackUrl)`)
3. Store `{ oauthReqInfo, requestTokenSecret }` in KV as `oauth-pending:${requestToken}` (TTL 10 min)
4. Redirect user's browser to `https://discogs.com/oauth/authorize?oauth_token=${requestToken}`

### `/discogs-callback` (Discogs → our server)

1. Receive `oauth_token` + `oauth_verifier` from Discogs
2. Look up `oauth-pending:${oauth_token}` from KV to get `requestTokenSecret` + `oauthReqInfo`
3. Delete the pending KV entry (cleanup)
4. Exchange for Discogs access token (`DiscogsAuth.getAccessToken`)
5. Fetch Discogs identity (`GET /oauth/identity`) to get username
6. Call `env.OAUTH_PROVIDER.completeAuthorization({ props: { accessToken, accessTokenSecret, username } })`
7. Redirect to MCP client's `redirectTo` URL — browser flow complete

### User Props

```typescript
interface DiscogsUserProps {
  userId: string        // Discogs username
  username: string
  accessToken: string
  accessTokenSecret: string
}
```

These props flow into the MCP `apiHandler` via `ctx.props`, replacing the JWT/KV session lookup for OAuth-authenticated requests.

### KV Eventual Consistency

Not a practical concern: the write in `/authorize` and the read in `/discogs-callback` are separated by user interaction on Discogs (5–30 seconds minimum), and Cloudflare's anycast routing keeps the same browser on the same data center. Same pattern used successfully in lastfm-mcp.

---

## Manual Login Path

Preserved for clients that don't support MCP OAuth (e.g. Claude Desktop with manual config):

- `GET /login?session_id=<id>` — CSRF token generated and stored in `__Host-` secure cookie; Discogs OAuth 1.0a request token obtained; redirect to Discogs authorize URL
- `GET /callback?session_id=<id>` — CSRF validated; Discogs access token exchanged; session stored in KV as `session:${sessionId}` (TTL 30 days); HTML success page returned
- Stored session format:
  ```json
  { "userId", "username", "accessToken", "accessTokenSecret", "timestamp", "expiresAt", "sessionId" }
  ```

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
| KV miss in `/discogs-callback` (expired/wrong token) | "Session expired, please try again" with link back to `/authorize` |
| Discogs access token exchange fails | Clear error message surfaced to user |
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
| `POST /mcp` with `Mcp-Session-Id` header + valid KV | `200`, session-based path |
| `POST /mcp` with `Mcp-Session-Id` header + no KV entry | `401` with `WWW-Authenticate` |
| `GET /.well-known/oauth-protected-resource` | correct fields: `resource`, `authorization_servers`, `bearer_methods_supported` |
| `GET /.well-known/oauth-authorization-server` | all MCP-required fields: `issuer`, `authorization_endpoint`, `token_endpoint`, `response_types_supported` (includes `"code"`), `grant_types_supported` (includes `"authorization_code"`), `code_challenge_methods_supported` (includes `"S256"`) |

### Integration Test — Full OAuth Round-Trip

1. `POST /mcp` (no auth) → assert `401` + `WWW-Authenticate`
2. `GET /.well-known/oauth-protected-resource` → assert valid JSON with `authorization_servers`
3. `GET /.well-known/oauth-authorization-server` → assert valid metadata
4. `GET /authorize?client_id=...&redirect_uri=...&code_challenge=...&code_challenge_method=S256&response_type=code` → assert redirect to `discogs.com/oauth/authorize`
5. Simulate Discogs callback: `GET /discogs-callback?oauth_token=mock&oauth_verifier=mock` (mock Discogs token exchange + identity API)
6. Assert: `completeAuthorization()` called, redirect issued to client `redirect_uri`
7. Client exchanges code: `POST /oauth/token` with code → assert token response with `access_token`
8. `POST /mcp` with `Authorization: Bearer <access_token>` → assert `200` with MCP capabilities

### Manual Login Round-Trip

1. `GET /login?session_id=test-session` → assert redirect to Discogs auth URL
2. `GET /callback?session_id=test-session&oauth_token=mock&oauth_verifier=mock` → assert HTML success page + KV session stored
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

**Rollback:** Revert `wrangler.toml` to point `main` back at the old `index.ts` (if preserved in a branch).

---

## Success Criteria

1. All automated tests pass
2. `POST /mcp` with no auth returns `401` with correct `WWW-Authenticate` header
3. Full OAuth round-trip integration test passes
4. Manual verification: MCP Inspector connecting to `/mcp` triggers OAuth browser open, not a copy-paste URL
5. Manual verification: existing session via `session_id` param or `Mcp-Session-Id` header continues to work
6. No tool response in the OAuth path contains a copy-paste login URL
7. Discogs OAuth signing key no longer logged to console
