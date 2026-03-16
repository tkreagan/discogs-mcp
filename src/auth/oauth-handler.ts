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

async function handleManualLogin(request: Request, env: OAuthEnv): Promise<Response> {
  return new Response('Not implemented', { status: 501 })
}

async function handleManualCallback(request: Request, env: OAuthEnv): Promise<Response> {
  return new Response('Not implemented', { status: 501 })
}

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
