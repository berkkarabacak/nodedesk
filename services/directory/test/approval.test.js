// M4 integration tests: connection requests, approval lifecycle, trust.
// The request clock is injected (nowFn) — no real-time sleeps (SPEC §11).

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { generateKeyPairSync, createSign } from 'node:crypto'
import { createDirectoryService } from '../src/server.js'

const ISS = 'https://accounts.google.com'
const CLIENT_ID = 'test-client-id.apps.googleusercontent.com'
const H = 'device-h-aaaaaaaaaaaaaaaa' // host, owned by account A
const C1 = 'device-c1-bbbbbbbbbbbbbbbb' // controller, same account A
const C2 = 'device-c2-cccccccccccccccc' // helper controller, account B

let jwksServer
let privateKey
let svc
let base
let nowMs

function b64url(buf) {
  return Buffer.from(buf).toString('base64url')
}

function jwt(subject) {
  const header = b64url(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }))
  const body = b64url(
    JSON.stringify({
      iss: ISS,
      aud: CLIENT_ID,
      sub: subject,
      email: `${subject}@example.com`,
      name: subject,
      exp: Math.floor(Date.now() / 1000) + 600,
    }),
  )
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${body}`)
  return `${header}.${body}.${signer.sign(privateKey, 'base64url')}`
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

let A // account A session (owner of H and C1)
let B // account B session (helper on C2)

async function requestFrom(account, deviceId, label = 'Test Laptop') {
  const res = await api('/v1/requests', {
    method: 'POST',
    token: account.sessionToken,
    deviceId,
    body: { hostDeviceId: H, label },
  })
  return res
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
  svc = createDirectoryService({
    clientId: CLIENT_ID,
    jwksUrl: `http://127.0.0.1:${jwksServer.address().port}/certs`,
    nowFn: () => nowMs,
  })
  const port = await svc.listen()
  base = `http://127.0.0.1:${port}`
  nowMs = Date.now()

  const authA = await api('/auth/google', { method: 'POST', body: { idToken: jwt('m4-owner') } })
  A = authA.body
  const authB = await api('/auth/google', { method: 'POST', body: { idToken: jwt('m4-helper') } })
  B = authB.body
  // Owner enrolls host H and controller C1 on account A.
  await api('/v1/devices/enroll', { method: 'POST', token: A.sessionToken, deviceId: H, body: { deviceId: H, name: 'Office PC' } })
  await api('/v1/devices/enroll', { method: 'POST', token: A.sessionToken, deviceId: C1, body: { deviceId: C1, name: 'Home Laptop' } })
})

after(() => {
  svc.close()
  jwksServer.close()
})

test('APPROVAL-01: pending request is host-visible with verified identity and deadline', async () => {
  const created = await requestFrom(B, C2, "Daniel's MacBook")
  assert.equal(created.status, 200)
  assert.equal(created.body.state, 'pending')
  assert.equal(created.body.deadline, nowMs + 30_000) // host-issued 30 s deadline

  const pending = await api(`/v1/requests/pending?deviceId=${H}`, { token: A.sessionToken, deviceId: H })
  assert.equal(pending.body.requests.length, 1)
  const r = pending.body.requests[0]
  assert.equal(r.requesterEmail, 'm4-helper@example.com')
  assert.equal(r.isNewDevice, true)
  assert.equal(r.id, created.body.id)
  // cleanup
  await api('/v1/requests/cancel', { method: 'POST', token: B.sessionToken, deviceId: C2, body: { id: r.id } })
})

test('APPROVAL-02: Reject grants nothing and creates no trust', async () => {
  const created = await requestFrom(B, C2)
  const rej = await api('/v1/requests/reject', { method: 'POST', token: A.sessionToken, deviceId: H, body: { id: created.body.id } })
  assert.equal(rej.status, 200)
  const status = await api(`/v1/requests/status?id=${created.body.id}`, { token: B.sessionToken, deviceId: C2 })
  assert.equal(status.body.state, 'rejected')
  assert.deepEqual(status.body.permissions, { control: false, files: false, clipboard: false, audio: false })
  const trusted = await api(`/v1/devices/trusted?deviceId=${H}`, { token: A.sessionToken, deviceId: H })
  assert.equal(trusted.body.controllers.length, 0)
})

test('APPROVAL-03/04: expiry is host-enforced; accept-at-deadline has exactly one winner', async () => {
  const created = await requestFrom(B, C2)
  nowMs += 31_000 // pass the deadline with no host action
  const accept = await api('/v1/requests/accept', { method: 'POST', token: A.sessionToken, deviceId: H, body: { id: created.body.id, control: true } })
  assert.equal(accept.status, 410)
  const status = await api(`/v1/requests/status?id=${created.body.id}`, { token: B.sessionToken, deviceId: C2 })
  assert.equal(status.body.state, 'expired')

  // A double-accept on a live request also yields exactly one decision.
  const second = await requestFrom(B, C2)
  const a1 = await api('/v1/requests/accept', { method: 'POST', token: A.sessionToken, deviceId: H, body: { id: second.body.id, control: true } })
  const a2 = await api('/v1/requests/accept', { method: 'POST', token: A.sessionToken, deviceId: H, body: { id: second.body.id, control: true } })
  assert.equal(a1.status, 200)
  assert.equal(a2.status, 410)
  await api('/v1/requests/end', { method: 'POST', token: B.sessionToken, deviceId: C2, body: { id: second.body.id } })
})

test('APPROVAL-05/06 shape: accepted permissions are exactly what the host granted', async () => {
  const created = await requestFrom(B, C2)
  await api('/v1/requests/accept', {
    method: 'POST',
    token: A.sessionToken,
    deviceId: H,
    body: { id: created.body.id, control: false, files: false, clipboard: false, audio: false },
  })
  const status = await api(`/v1/requests/status?id=${created.body.id}`, { token: B.sessionToken, deviceId: C2 })
  assert.equal(status.body.state, 'accepted')
  assert.deepEqual(status.body.permissions, { control: false, files: false, clipboard: false, audio: false })
  await api('/v1/requests/end', { method: 'POST', token: B.sessionToken, deviceId: C2, body: { id: created.body.id } })
})

test('APPROVAL-07: acceptance is bound to request, device, and account', async () => {
  const created = await requestFrom(B, C2)
  // Another device of the same account cannot read or reuse it.
  const other = await api(`/v1/requests/status?id=${created.body.id}`, { token: B.sessionToken, deviceId: 'device-c9-zzzzzzzzzzzzzzzz' })
  assert.equal(other.status, 403)
  // The host of a DIFFERENT device cannot accept it.
  const notMine = await api('/v1/requests/accept', { method: 'POST', token: B.sessionToken, deviceId: C2, body: { id: created.body.id, control: true } })
  assert.equal(notMine.status, 403)
  await api('/v1/requests/cancel', { method: 'POST', token: B.sessionToken, deviceId: C2, body: { id: created.body.id } })
})

test('APPROVAL-08: controller cancellation invalidates the pending request', async () => {
  const created = await requestFrom(B, C2)
  await api('/v1/requests/cancel', { method: 'POST', token: B.sessionToken, deviceId: C2, body: { id: created.body.id } })
  const pending = await api(`/v1/requests/pending?deviceId=${H}`, { token: A.sessionToken, deviceId: H })
  assert.equal(pending.body.requests.length, 0)
  const late = await api('/v1/requests/accept', { method: 'POST', token: A.sessionToken, deviceId: H, body: { id: created.body.id, control: true } })
  assert.equal(late.status, 410)
})

test('APPROVAL-09: a second request while one is pending gets Busy', async () => {
  const first = await requestFrom(B, C2)
  assert.equal(first.status, 200)
  const second = await requestFrom(A, C1)
  assert.equal(second.status, 409)
  assert.equal(second.body.error, 'busy')
  await api('/v1/requests/cancel', { method: 'POST', token: B.sessionToken, deviceId: C2, body: { id: first.body.id } })
})

test('APPROVAL-10: accepting a helper creates no persistent trust; next request needs approval again', async () => {
  const first = await requestFrom(B, C2)
  await api('/v1/requests/accept', { method: 'POST', token: A.sessionToken, deviceId: H, body: { id: first.body.id, control: true, trust: true } })
  await api('/v1/requests/end', { method: 'POST', token: B.sessionToken, deviceId: C2, body: { id: first.body.id } })
  // trust:true from a different account must NOT create a trusted entry.
  const trusted = await api(`/v1/devices/trusted?deviceId=${H}`, { token: A.sessionToken, deviceId: H })
  assert.equal(trusted.body.controllers.length, 0)
  const next = await requestFrom(B, C2)
  assert.equal(next.body.state, 'pending') // approval required again
  await api('/v1/requests/cancel', { method: 'POST', token: B.sessionToken, deviceId: C2, body: { id: next.body.id } })
})

test('HOST-07 + unattended: trusted same-account controller is auto-accepted only when policy is on', async () => {
  // C1 is not trusted yet: even same-account, the request needs approval.
  const initial = await requestFrom(A, C1)
  assert.equal(initial.body.state, 'pending')

  // Host accepts with trust → C1 becomes a trusted controller.
  await api('/v1/requests/accept', { method: 'POST', token: A.sessionToken, deviceId: H, body: { id: initial.body.id, control: true, files: true, clipboard: true, audio: false, trust: true } })
  await api('/v1/requests/end', { method: 'POST', token: A.sessionToken, deviceId: C1, body: { id: initial.body.id } })
  const trusted = await api(`/v1/devices/trusted?deviceId=${H}`, { token: A.sessionToken, deviceId: H })
  assert.equal(trusted.body.controllers.length, 1)
  assert.equal(trusted.body.controllers[0].controllerDeviceId, C1)

  // Unattended off: still pending.
  const off = await requestFrom(A, C1)
  assert.equal(off.body.state, 'pending')
  await api('/v1/requests/cancel', { method: 'POST', token: A.sessionToken, deviceId: C1, body: { id: off.body.id } })

  // Unattended on: auto-accepted with owner permissions.
  await api('/v1/devices/policy', { method: 'POST', token: A.sessionToken, deviceId: H, body: { deviceId: H, unattended: true } })
  const on = await requestFrom(A, C1)
  assert.equal(on.body.state, 'accepted')
  assert.deepEqual(on.body.permissions, { control: true, files: true, clipboard: true, audio: true })
  await api('/v1/requests/end', { method: 'POST', token: A.sessionToken, deviceId: C1, body: { id: on.body.id } })
})

test('TRUST-02: revoking one controller ends its session and blocks auto-reconnect', async () => {
  await api('/v1/devices/trusted/revoke', { method: 'POST', token: A.sessionToken, deviceId: H, body: { deviceId: H, controllerDeviceId: C1 } })
  const trusted = await api(`/v1/devices/trusted?deviceId=${H}`, { token: A.sessionToken, deviceId: H })
  assert.equal(trusted.body.controllers.length, 0)
  // Unattended still on, but trust is gone: pending again, no auto-accept.
  const after = await requestFrom(A, C1)
  assert.equal(after.body.state, 'pending')
  await api('/v1/requests/cancel', { method: 'POST', token: A.sessionToken, deviceId: C1, body: { id: after.body.id } })
  // cleanup: unattended back off for other tests
  await api('/v1/devices/policy', { method: 'POST', token: A.sessionToken, deviceId: H, body: { deviceId: H, unattended: false } })
})

test('SECURITY-02: knowing a public ID grants no privileged operation', async () => {
  const pub = svc.db.prepare('SELECT public_id FROM devices WHERE device_id = ?').get(H).public_id
  // Unauthenticated privileged paths:
  for (const [method, path, body] of [
    ['POST', '/v1/requests', { hostDeviceId: H }],
    ['POST', '/v1/devices/policy', { deviceId: H, unattended: true }],
    ['POST', '/v1/requests/accept', { id: 'whatever', control: true }],
    ['GET', `/v1/devices/trusted?deviceId=${H}`, undefined],
  ]) {
    const res = await api(path, { method, body })
    assert.equal(res.status, 401, `${method} ${path}`)
  }
  // Authenticated but not the owner:
  const foreign = await api('/v1/devices/policy', { method: 'POST', token: B.sessionToken, deviceId: C2, body: { deviceId: H, unattended: true } })
  assert.equal(foreign.status, 403)
  // Public ID resolves to metadata only.
  const meta = await api('/v1/computers/resolve', { method: 'POST', token: B.sessionToken, deviceId: C2, body: { publicId: pub } })
  assert.equal(meta.status, 200)
  assert.deepEqual(Object.keys(meta.body).sort(), ['deviceId', 'name', 'online', 'publicId'])
})
