import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDirectoryService, isUsableClientId, loadClientId } from '../src/server.js'

test('client id comes from env or a file, and placeholders are refused', () => {
  assert.equal(isUsableClientId('YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com'), false)
  assert.equal(isUsableClientId('placeholder.apps.googleusercontent.com'), false)
  assert.equal(isUsableClientId('not-a-client'), false)
  assert.equal(isUsableClientId('123-abc.apps.googleusercontent.com'), true)

  assert.equal(
    loadClientId({ GOOGLE_CLIENT_ID: '123-abc.apps.googleusercontent.com' }, () => {
      throw new Error('should not read a file')
    }),
    '123-abc.apps.googleusercontent.com',
  )
  assert.equal(
    loadClientId({ GOOGLE_CLIENT_ID_FILE: '/etc/nodedesk/google-client-id' }, () => 'file-id.apps.googleusercontent.com\n'),
    'file-id.apps.googleusercontent.com',
  )
  assert.equal(loadClientId({ GOOGLE_CLIENT_ID: 'YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com' }), '')
  assert.equal(loadClientId({ GOOGLE_CLIENT_ID_FILE: '/missing' }, () => {
    throw new Error('enoent')
  }), '')
})

test('healthz is unauthenticated and the listener is loopback', async () => {
  const svc = createDirectoryService({
    clientId: '123-abc.apps.googleusercontent.com',
    verifyIdToken: async () => {
      throw new Error('unused')
    },
  })
  const port = await svc.listen(0)
  const address = svc.server.address()
  assert.equal(address.address, '127.0.0.1')
  const res = await fetch(`http://127.0.0.1:${port}/healthz`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
  svc.close()
})
