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
