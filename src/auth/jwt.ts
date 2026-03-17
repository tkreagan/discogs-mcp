/**
 * JWT utilities for session token creation and verification.
 * Used by the legacy session-based handler (src/index.ts).
 */

export interface SessionPayload {
	userId: string
	accessToken: string
	accessTokenSecret: string
	iat: number
	exp: number
}

/**
 * Creates a signed JWT session token using the Web Crypto API.
 */
export async function createSessionToken(
	payload: Omit<SessionPayload, 'iat' | 'exp'>,
	secret: string,
	expiresInHours = 168,
): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	const fullPayload: SessionPayload = {
		...payload,
		iat: now,
		exp: now + expiresInHours * 3600,
	}

	const header = { alg: 'HS256', typ: 'JWT' }
	const encodedHeader = btoa(JSON.stringify(header)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
	const encodedPayload = btoa(JSON.stringify(fullPayload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
	const signingInput = `${encodedHeader}.${encodedPayload}`

	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret || 'fallback-secret'),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signingInput))
	const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)))
		.replace(/=/g, '')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')

	return `${signingInput}.${encodedSignature}`
}

/**
 * Verifies a JWT session token and returns the payload if valid, or null if invalid/expired.
 */
export async function verifySessionToken(token: string, secret: string): Promise<SessionPayload | null> {
	try {
		const parts = token.split('.')
		if (parts.length !== 3) return null

		const [encodedHeader, encodedPayload, encodedSignature] = parts
		const signingInput = `${encodedHeader}.${encodedPayload}`

		const key = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(secret || 'fallback-secret'),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['verify'],
		)

		const signatureBytes = Uint8Array.from(
			atob(encodedSignature.replace(/-/g, '+').replace(/_/g, '/')),
			(c) => c.charCodeAt(0),
		)

		const valid = await crypto.subtle.verify('HMAC', key, signatureBytes, new TextEncoder().encode(signingInput))
		if (!valid) return null

		const payload: SessionPayload = JSON.parse(atob(encodedPayload.replace(/-/g, '+').replace(/_/g, '/')))
		if (payload.exp < Math.floor(Date.now() / 1000)) return null

		return payload
	} catch {
		return null
	}
}
