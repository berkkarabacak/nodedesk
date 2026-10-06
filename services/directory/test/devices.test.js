// M3 integration tests: enrollment, public IDs, saved-computer management,
// presence. Same real-crypto setup as service.test.js.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { generateKeyPairSync, createSign } from 'node:crypto'
import { createDirectoryService } from '../src/server.js'
import { normalizePublicId } from '../src/server.js'

const ISS = 'https://accounts.google.com'
const CLIENT_ID = 'test-client-id.apps.googleusercontent.com'

let jwksServer
let svc
let base

function b64url(buf) {
  return Buffer.from(buf).toString('base64url')
}

function signJwt(payload) {
  const header = b64url(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${body}`)
  return `${header}.${body}.${signer.sign(privateKey, 'base64url')}`
}

let privateKey

function googleToken(subject, email) {
  return signJwt({
    iss: ISS,
    aud: CLIENT_ID,
    sub: subject,
    email,
    name: email,
    exp: Math.floor(Date.now() / 1000) + 600,
  })
}

async function api(path, { method = 'GET', token, body, deviceId } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(deviceId ? { 'x-device-id': deviceId } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json() }
}

async function signIn(subject) {
  const { body } = await api('/auth/google', {
    method: 'POST',
    body: { idToken: googleToken(subject, `${subject}@example.com`) },
  })
  return body
}

let accountA
let accountB

before(async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
  privateKey = pair.privateKey
  const jwk = pair.publicKey.export({ format: 'jwk' })
  jwksServer = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ keys: [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }] }))
  })
  await new Promise((r) => jwksServer.listen(0, '127.0.0.1', r))
  svc = createDirectoryService({
    clientId: CLIENT_ID,
    jwksUrl: `http://127.0.0.1:${jwksServer.address().port}/certs`,
  })
  const port = await svc.listen()
  base = `http://127.0.0.1:${port}`
  accountA = await signIn('m3-account-a')
  accountB = await signIn('m3-account-b')
})

after(() => {
  svc.close()
  jwksServer.close()
})

const DEVICE_H = 'device-h-0123456789abcdef' // stable client-generated identity
const DEVICE_X = 'device-x-0123456789abcdef'

test('HOST-01/02: enrollment allocates a stable nine-digit public ID', async () => {
  const res = await api('/v1/devices/enroll', {
    method: 'POST',
    token: accountA.sessionToken,
    body: { deviceId: DEVICE_H, name: 'Office PC' },
  })
  assert.equal(res.status, 200)
  assert.match(res.body.publicId, /^[0-9]{9}$/)

  // Re-enrolling the same device is idempotent and keeps the ID stable.
  const again = await api('/v1/devices/enroll', {
    method: 'POST',
    token: accountA.sessionToken,
    body: { deviceId: DEVICE_H, name: 'Office PC' },
  })
  assert.equal(again.body.publicId, res.body.publicId)
})

test('enrollment rejects bad identities and ownership transfer', async () => {
  const bad = await api('/v1/devices/enroll', {
    method: 'POST',
    token: accountA.sessionToken,
    body: { deviceId: 'short', name: 'X' },
  })
  assert.equal(bad.status, 400)

  // AUTH-08/10: another account cannot claim the same device identity.
  const steal = await api('/v1/devices/enroll', {
    method: 'POST',
    token: accountB.sessionToken,
    body: { deviceId: DEVICE_H, name: 'Stolen?' },
  })
  assert.equal(steal.status, 409)
})

test('LIST-01: enrolled owner device appears for a second controller of the same account', async () => {
  const c3 = await signIn('m3-account-a') // same subject = same account, new device
  const list = await api('/v1/computers', { token: c3.sessionToken, deviceId: 'device-c3-0123456789abcdef' })
  assert.equal(list.status, 200)
  const h = list.body.computers.find((c) => c.deviceId === DEVICE_H)
  assert.ok(h, 'H must appear without typing its ID')
  assert.equal(h.isThisDevice, false)
})

test('LIST-11: the caller device is labeled This computer', async () => {
  const list = await api('/v1/computers', { token: accountA.sessionToken, deviceId: DEVICE_H })
  const h = list.body.computers.find((c) => c.deviceId === DEVICE_H)
  assert.equal(h.isThisDevice, true)
})

test('DEVICE-02: public ID normalization keeps leading zeroes and rejects junk', () => {
  assert.equal(normalizePublicId('482 913 705'), '482913705')
  assert.equal(normalizePublicId(' 012345678 '), '012345678')
  assert.equal(normalizePublicId('123'), null)
  assert.equal(normalizePublicId('abcdefghi'), null)
  assert.equal(normalizePublicId(''), null)
})

test('DEVICE-03/04: resolve returns public metadata only; unknown IDs 404; no access grant', async () => {
  const h = (await api('/v1/computers', { token: accountA.sessionToken })).body.computers[0]
  const ok = await api('/v1/computers/resolve', {
    method: 'POST',
    token: accountB.sessionToken,
    body: { publicId: h.publicId },
  })
  assert.equal(ok.status, 200)
  assert.deepEqual(Object.keys(ok.body).sort(), ['deviceId', 'name', 'online', 'publicId'])

  const nope = await api('/v1/computers/resolve', {
    method: 'POST',
    token: accountB.sessionToken,
    body: { publicId: '000000001' },
  })
  assert.equal(nope.status, 404)
})

test('DEVICE-03..05/10: add, duplicate, remove (tombstone), re-add', async () => {
  const h = (await api('/v1/computers', { token: accountA.sessionToken })).body.computers[0]

  // B saves a reference to H by public ID — an address-book entry, no trust.
  const add = await api('/v1/computers', {
    method: 'POST',
    token: accountB.sessionToken,
    body: { publicId: h.publicId, name: 'Office PC' },
  })
  assert.equal(add.status, 200)

  const dup = await api('/v1/computers', {
    method: 'POST',
    token: accountB.sessionToken,
    body: { publicId: h.publicId, name: 'Office PC again' },
  })
  assert.equal(dup.status, 409) // no duplicate row

  const del = await api('/v1/computers', {
    method: 'DELETE',
    token: accountB.sessionToken,
    body: { deviceId: h.deviceId },
  })
  assert.equal(del.status, 200)
  const gone = await api('/v1/computers', { token: accountB.sessionToken })
  assert.equal(gone.body.computers.length, 0)

  // DEVICE-10: explicit re-add clears the tombstone.
  const readd = await api('/v1/computers', {
    method: 'POST',
    token: accountB.sessionToken,
    body: { publicId: h.publicId, name: 'Office PC' },
  })
  assert.equal(readd.status, 200)
})

test('DEVICE-08: owner-device tombstone is not recreated by re-enrollment sync', async () => {
  // B enrolls X, removes it, re-enrolls: the row must stay hidden.
  await api('/v1/devices/enroll', {
    method: 'POST',
    token: accountB.sessionToken,
    body: { deviceId: DEVICE_X, name: 'Lab Box' },
  })
  await api('/v1/computers', { method: 'DELETE', token: accountB.sessionToken, body: { deviceId: DEVICE_X } })
  const res = await api('/v1/devices/enroll', {
    method: 'POST',
    token: accountB.sessionToken,
    body: { deviceId: DEVICE_X, name: 'Lab Box' },
  })
  assert.equal(res.body.saved, false)
  const list = await api('/v1/computers', { token: accountB.sessionToken })
  assert.equal(list.body.computers.some((c) => c.deviceId === DEVICE_X), false)
})

test('DEVICE-06/07: rename updates the per-account alias, not the device', async () => {
  const h = (await api('/v1/computers', { token: accountB.sessionToken })).body.computers[0]
  const ren = await api('/v1/computers', {
    method: 'PATCH',
    token: accountB.sessionToken,
    body: { deviceId: h.deviceId, name: 'The Office Box' },
  })
  assert.equal(ren.status, 200)
  const bList = await api('/v1/computers', { token: accountB.sessionToken })
  assert.equal(bList.body.computers[0].name, 'The Office Box')
  // A's alias for its own device is untouched.
  const aList = await api('/v1/computers', { token: accountA.sessionToken })
  assert.equal(aList.body.computers.find((c) => c.deviceId === h.deviceId).name, 'Office PC')

  const bad = await api('/v1/computers', {
    method: 'PATCH',
    token: accountB.sessionToken,
    body: { deviceId: h.deviceId, name: '   ' },
  })
  assert.equal(bad.status, 400)
})

test('presence: heartbeat marks only the owning account device online', async () => {
  // Before any heartbeat: unknown, not silently Online.
  let list = await api('/v1/computers', { token: accountA.sessionToken })
  assert.equal(list.body.computers[0].online, 'unknown')

  const hb = await api('/v1/devices/heartbeat', {
    method: 'POST',
    token: accountA.sessionToken,
    body: { deviceId: DEVICE_H },
  })
  assert.equal(hb.status, 200)
  list = await api('/v1/computers', { token: accountA.sessionToken })
  assert.equal(list.body.computers[0].online, true)

  // B cannot heartbeat A's device.
  const forged = await api('/v1/devices/heartbeat', {
    method: 'POST',
    token: accountB.sessionToken,
    body: { deviceId: DEVICE_H },
  })
  assert.equal(forged.status, 403)
})

test('resolve is rate-limited against ID enumeration', async () => {
  let last
  for (let i = 0; i < 12; i++) {
    last = await api('/v1/computers/resolve', {
      method: 'POST',
      token: accountB.sessionToken,
      body: { publicId: String(100000000 + i) },
    })
  }
  assert.equal(last.status, 429)
})
