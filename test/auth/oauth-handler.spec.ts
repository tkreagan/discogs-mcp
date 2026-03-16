// ABOUTME: Tests for DiscogsOAuthHandler auth routes.
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { describe, it, expect, vi } from 'vitest'
import { DiscogsOAuthHandler } from '../../src/auth/oauth-handler'

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

describe('/authorize', () => {
  it('redirects to discogs.com/oauth/authorize with the request token', async () => {
    const url = new URL('https://example.com/authorize')
    url.searchParams.set('client_id', 'test-client')
    url.searchParams.set('redirect_uri', 'https://client/callback')
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('state', 'random123')
    url.searchParams.set('code_challenge', 'abc123')
    url.searchParams.set('code_challenge_method', 'S256')

    const mockOauthReqInfo = {
      clientId: 'test-client',
      redirectUri: 'https://client/callback',
      responseType: 'code',
      state: 'random123',
    }
    const envWithOAuth = {
      ...env,
      OAUTH_PROVIDER: {
        parseAuthRequest: vi.fn().mockResolvedValue(mockOauthReqInfo),
      },
    }

    const req = new Request(url.toString())
    const ctx = createExecutionContext()
    const res = await DiscogsOAuthHandler.fetch(req, envWithOAuth as any, ctx)
    await waitOnExecutionContext(ctx)

    expect(res.status).toBe(302)
    const location = res.headers.get('Location') ?? ''
    expect(location).toContain('discogs.com/oauth/authorize')
    expect(location).toContain('oauth_token=mock-request-token')
  })
})
