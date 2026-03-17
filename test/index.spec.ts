// ABOUTME: Tests for src/index.ts — session-based handler GET / marketing page.
import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
import worker from '../src/index'

describe('GET / — marketing page (session handler)', () => {
  it('returns 200 with HTML content type', async () => {
    const req = new Request('https://example.com/', { method: 'GET' })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/html')
  })

  it('contains Discogs MCP in the body', async () => {
    const req = new Request('https://example.com/', { method: 'GET' })
    const ctx = createExecutionContext()
    const res = await worker.fetch(req, env, ctx)
    await waitOnExecutionContext(ctx)
    const body = await res.text()
    expect(body).toContain('Discogs MCP')
  })
})
