// Google ID-token verification (OIDC). Fetches Google's JWKS and verifies
// the RS256 signature, issuer, audience, and expiry locally — no token or
// profile data is ever sent to a third party beyond Google itself.
//
// The JWKS URL and fetch are injectable so tests can use a local keys server
// with a real RSA keypair; nothing about verification is mocked away.

import { createVerify, createPublicKey } from 'node:crypto'

const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs'
const VALID_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com'])

function b64urlDecode(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(b64, 'base64')
}

export function createGoogleVerifier({ jwksUrl = GOOGLE_JWKS, clientId, fetchFn = fetch } = {}) {
  if (!clientId) throw new Error('Google verifier requires a clientId')
  let cache = { keys: null, fetchedAt: 0 }

  async function getKeys() {
    // Cache JWKS for 5 minutes; kid misses force a refetch (key rotation).
    if (cache.keys && Date.now() - cache.fetchedAt < 5 * 60 * 1000) return cache.keys
    const res = await fetchFn(jwksUrl)
    if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`)
    const body = await res.json()
    cache = { keys: body.keys, fetchedAt: Date.now() }
    return cache.keys
  }

  /**
   * Verify a Google ID token. Returns { issuer, subject, email, name } or
   * throws — callers must treat any throw as "not authenticated".
   */
  return async function verifyIdToken(idToken) {
    const parts = String(idToken ?? '').split('.')
    if (parts.length !== 3) throw new Error('malformed token')
    const [h, p, sig] = parts
    const header = JSON.parse(b64urlDecode(h).toString('utf8'))
    const payload = JSON.parse(b64urlDecode(p).toString('utf8'))

    if (header.alg !== 'RS256') throw new Error('unexpected alg')
    let keys = await getKeys()
    let jwk = keys.find((k) => k.kid === header.kid)
    if (!jwk) {
      cache = { keys: null, fetchedAt: 0 } // force refetch once
      keys = await getKeys()
      jwk = keys.find((k) => k.kid === header.kid)
    }
    if (!jwk) throw new Error('unknown signing key')

    const publicKey = createPublicKey({ key: jwk, format: 'jwk' })
    const verifier = createVerify('RSA-SHA256')
    verifier.update(`${h}.${p}`)
    if (!verifier.verify(publicKey, b64urlDecode(sig))) throw new Error('bad signature')

    if (!VALID_ISSUERS.has(payload.iss)) throw new Error('bad issuer')
    if (payload.aud !== clientId) throw new Error('wrong audience')
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) throw new Error('expired')
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new Error('no subject')

    return {
      issuer: payload.iss,
      subject: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : '',
      name: typeof payload.name === 'string' ? payload.name : '',
    }
  }
}
