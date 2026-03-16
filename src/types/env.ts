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
