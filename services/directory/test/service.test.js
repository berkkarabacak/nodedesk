// Integration tests for the directory service. Uses a REAL RSA keypair and a
// local JWKS server — tokens are genuinely signed and verified; only Google's
// URL is swapped, per the verifier's documented injection point.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { generateKeyPairSync, createSign } from 'node:crypto'
import { createDirectoryService } from '../src/server.js'

const ISS = 'https://accounts.google.com'
const CLIENT_ID = 'test-client-id.apps.googleusercontent.com'

let jwksServer
let jwksUrl
let privateKey
let svc
let base

function b64url(buf) {
  return Buffer.from(buf).toString('base64url')
}

function signJwt(payload, { kid = 'k1', alg = 'RS256' } = {}) {
  const header = b64url(JSON.stringify({ alg, kid, typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${body}`)
  return `${header}.${body}.${signer.sign(privateKey, 'base64url')}`
}

function googleToken(overrides = {}) {
  return signJwt({
    iss: ISS,
    aud: CLIENT_ID,
    sub: 'user-a-subject',
    email: 'a@example.com',
    name: 'Account A',
    exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  })
}

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json() }
}

async function signIn(subject, email) {
  const { status, body } = await api('/auth/google', {
    method: 'POST',
    body: { idToken: googleToken({ sub: subject, email }) },
  })
  assert.equal(status, 200)
  return body
}

before(async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  privateKey = pair.privateKey
  const jwk = pair.publicKey.export({ format: 'jwk' })
  jwksServer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }] }))
  })
  await new Promise((r) => jwksServer.listen(0, '127.0.0.1', r))
  jwksUrl = `http://127.0.0.1:${jwksServer.address().port}/certs`

  svc = createDirectoryService({ clientId: CLIENT_ID, jwksUrl })
  const port = await svc.listen()
  base = `http://127.0.0.1:${port}`
})

after(() => {
  svc.close()
  jwksServer.close()
})

test('SECURITY-01: account isolation is enforced on the service', async () => {
  const a = await signIn('subject-a', 'a@example.com')
  const b = await signIn('subject-b', 'b@example.com')

  // A has a saved computer; B must never see it.
  const aId = svc._accountId(ISS, 'subject-a')
  svc._insertSaved(aId, { deviceId: 'dev-h', publicId: '482913705', name: 'Office PC' })

  const aList = await api('/v1/computers', { token: a.sessionToken })
  assert.equal(aList.body.computers.length, 1)
  assert.equal(aList.body.computers[0].publicId, '482913705')

  const bList = await api('/v1/computers', { token: b.sessionToken })
  assert.equal(bList.body.computers.length, 0)

  // A's session token cannot be used to read B's profile either.
  const me = await api('/v1/me', { token: a.sessionToken })
  assert.equal(me.body.email, 'a@example.com')
})

test('LIST-02: a brand-new account reads a real empty directory', async () => {
  const c = await signIn('subject-c', 'c@example.com')
  const res = await api('/v1/computers', { token: c.sessionToken })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.computers, [])
})

test('AUTH-06: invalid identity material is rejected without leaking detail', async () => {
  for (const bad of [
    '',
    'not-a-jwt',
    googleToken({ aud: 'someone-else' }), // wrong audience
    googleToken({ iss: 'https://evil.example' }), // wrong issuer
    googleToken({ exp: Math.floor(Date.now() / 1000) - 10 }), // expired
    signJwt({ iss: ISS, aud: CLIENT_ID, sub: 'x', exp: Math.floor(Date.now() / 1000) + 60 }, { alg: 'none' }),
  ]) {
    const res = await api('/auth/google', { method: 'POST', body: { idToken: bad } })
    assert.equal(res.status, 401, `should reject: ${String(bad).slice(0, 40)}`)
    assert.deepEqual(res.body, { error: 'invalid_identity' })
  }
})

test('a tampered signature is rejected', async () => {
  const good = googleToken({ sub: 'tamper-subject' })
  const [h, p] = good.split('.')
  const res = await api('/auth/google', { method: 'POST', body: { idToken: `${h}.${p}.AAAA` } })
  assert.equal(res.status, 401)
})

test('refresh rotates and the old pair stops working', async () => {
  const a = await signIn('subject-refresh', 'r@example.com')
  const rotated = await api('/auth/refresh', { method: 'POST', body: { refreshToken: a.refreshToken } })
  assert.equal(rotated.status, 200)
  assert.notEqual(rotated.body.sessionToken, a.sessionToken)

  // Old session token is dead after rotation.
  const old = await api('/v1/me', { token: a.sessionToken })
  assert.equal(old.status, 401)

  // New token works; old refresh token cannot be reused.
  const me = await api('/v1/me', { token: rotated.body.sessionToken })
  assert.equal(me.status, 200)
  const reuse = await api('/auth/refresh', { method: 'POST', body: { refreshToken: a.refreshToken } })
  assert.equal(reuse.status, 401)
})

test('logout revokes the account sessions', async () => {
  const a = await signIn('subject-logout', 'l@example.com')
  const out = await api('/auth/logout', { method: 'POST', token: a.sessionToken })
  assert.equal(out.status, 200)
  const me = await api('/v1/me', { token: a.sessionToken })
  assert.equal(me.status, 401)
})

test('unauthenticated and unknown routes are denied', async () => {
  assert.equal((await api('/v1/computers')).status, 401)
  assert.equal((await api('/v1/computers', { token: 'deadbeef' })).status, 401)
  assert.equal((await api('/nope')).status, 404)
})

test('auth endpoints are rate limited', async () => {
  let last
  for (let i = 0; i < 35; i++) {
    last = await api('/auth/google', { method: 'POST', body: { idToken: 'x' } })
  }
  assert.equal(last.status, 429)
})
