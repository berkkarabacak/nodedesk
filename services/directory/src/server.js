// NodeDesk directory service — M2 scope: Google sign-in exchange, session
// lifecycle, and the account-scoped (initially empty) saved-computer list.
//
// Security model:
// - Accounts are keyed by (issuer, subject), never by email text alone.
// - Only SHA-256 hashes of session/refresh tokens are stored.
// - Every /v1 route requires a valid session and reads ONLY that account's
//   rows — there is no way to address another account's data (SECURITY-01).
// - /auth/* is rate-limited per client IP.
// - Refresh tokens rotate on use; reuse of an old refresh token revokes the
//   whole session family.

import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { openDb } from './db.js'
import { createGoogleVerifier } from './google.js'

const SESSION_TTL_MS = 60 * 60 * 1000 // 1 hour
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const AUTH_RATE_LIMIT = { windowMs: 60_000, max: 30 }
const RESOLVE_RATE_LIMIT = { windowMs: 60_000, max: 10 } // public-ID lookups (SPEC §05)
const PRESENCE_STALE_MS = 30_000 // host presence stale after 30 s without heartbeat
const REQUEST_TTL_MS = 30_000 // host-issued approval deadline (SPEC §05)

function sha256(s) {
  return createHash('sha256').update(s).digest('hex')
}

function token() {
  return randomBytes(32).toString('hex')
}

/** Server-side allocation of a nine-digit public ID with collision handling.
 * Leading zeroes are preserved (TEXT). Not a secret; rate-limited on lookup. */
function allocatePublicId(db) {
  for (let i = 0; i < 100; i++) {
    const n = randomBytes(4).readUInt32BE(0) % 1_000_000_000
    const id = String(n).padStart(9, '0')
    const exists = db.prepare('SELECT 1 FROM devices WHERE public_id = ?').get(id)
    if (!exists) return id
  }
  throw new Error('public id space exhausted')
}

/** A public ID is exactly nine digits, spaces ignored. */
export function normalizePublicId(raw) {
  const digits = String(raw ?? '').replace(/\s/g, '')
  return /^[0-9]{9}$/.test(digits) ? digits : null
}

export function createDirectoryService({ dbPath = ':memory:', verifyIdToken, clientId, jwksUrl, fetchFn, nowFn } = {}) {
  const now = nowFn ?? (() => Date.now())
  const db = openDb(dbPath)
  const verify = verifyIdToken ?? createGoogleVerifier({ clientId, jwksUrl, fetchFn })
  const rateBuckets = new Map()

  function rateLimited(ip, limit = AUTH_RATE_LIMIT) {
    const now = Date.now()
    const bucket = rateBuckets.get(ip) ?? []
    const fresh = bucket.filter((t) => now - t < limit.windowMs)
    if (fresh.length >= limit.max) {
      rateBuckets.set(ip, fresh)
      return true
    }
    fresh.push(now)
    rateBuckets.set(ip, fresh)
    return false
  }

  function presenceOf(device) {
    if (!device || !device.last_seen) return 'unknown'
    return Date.now() - device.last_seen < PRESENCE_STALE_MS ? true : 'unknown'
  }

  function savedRow(accountId, deviceId) {
    return db
      .prepare('SELECT * FROM saved_computers WHERE account_id = ? AND device_id = ?')
      .get(accountId, deviceId)
  }

  // --- M4 helpers -----------------------------------------------------------

  function ownedDevice(account, deviceId) {
    const device = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(String(deviceId ?? ''))
    return device && device.account_id === account.id ? device : null
  }

  /** Lazily expire pending requests past their host-issued deadline. The
   * deadline is authoritative and never pauses (APPROVAL-03). */
  function expireOverdue() {
    db.prepare("UPDATE connection_requests SET state = 'expired', decided_at = ? WHERE state = 'pending' AND deadline <= ?").run(
      now(),
      now(),
    )
  }

  function isTrusted(hostDeviceId, controllerDeviceId) {
    return Boolean(
      db
        .prepare('SELECT 1 FROM trusted_controllers WHERE host_device_id = ? AND controller_device_id = ? AND revoked_at IS NULL')
        .get(hostDeviceId, controllerDeviceId),
    )
  }

  function requestView(r) {
    return {
      id: r.id,
      hostDeviceId: r.host_device_id,
      requesterDeviceId: r.requester_device_id,
      requesterLabel: r.requester_label,
      state: r.state,
      deadline: r.deadline,
      permissions: {
        // Screen viewing is implied by any accepted desktop session;
        // control/files/clipboard/audio are the host-granted capabilities.
        control: Boolean(r.perm_control),
        files: Boolean(r.perm_files),
        clipboard: Boolean(r.perm_clipboard),
        audio: Boolean(r.perm_audio),
      },
    }
  }

  /** Can this account+device act on the request, and as which side? */
  function requestRole(account, req, request) {
    const callerDevice = request.headers['x-device-id'] ?? null
    if (req.requester_account_id === account.id && req.requester_device_id === callerDevice) return 'requester'
    const host = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(req.host_device_id)
    if (host && host.account_id === account.id) return 'host'
    return null
  }

  function upsertAccount(identity) {
    db.prepare(
      `INSERT INTO accounts (issuer, subject, email, name, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (issuer, subject) DO UPDATE SET email = excluded.email, name = excluded.name`,
    ).run(identity.issuer, identity.subject, identity.email, identity.name, Date.now())
    return db.prepare('SELECT * FROM accounts WHERE issuer = ? AND subject = ?').get(identity.issuer, identity.subject)
  }

  function issueSession(accountId) {
    const sessionToken = token()
    const refreshToken = token()
    const now = Date.now()
    db.prepare(
      `INSERT INTO sessions (account_id, session_hash, refresh_hash, created_at, session_exp, refresh_exp)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(accountId, sha256(sessionToken), sha256(refreshToken), now, now + SESSION_TTL_MS, now + REFRESH_TTL_MS)
    return { sessionToken, refreshToken, sessionExpiresAt: now + SESSION_TTL_MS }
  }

  /** Resolve a bearer session token to its account row, or null. */
  function authenticate(sessionToken) {
    if (!sessionToken) return null
    const row = db
      .prepare(
        `SELECT s.id AS session_id, s.session_exp, s.revoked, a.*
         FROM sessions s JOIN accounts a ON a.id = s.account_id
         WHERE s.session_hash = ?`,
      )
      .get(sha256(sessionToken))
    if (!row || row.revoked || row.session_exp <= Date.now()) return null
    return row
  }

  function json(res, status, body) {
    const data = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) })
    res.end(data)
  }

  async function readBody(req) {
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > 64 * 1024) throw new Error('body too large')
    }
    return raw ? JSON.parse(raw) : {}
  }

  const routes = {
    'POST /auth/google': async (req, res) => {
      const body = await readBody(req)
      let identity
      try {
        identity = await verify(body.idToken)
      } catch {
        // Never echo token material or verifier internals (AUTH-06, SECURITY-04).
        return json(res, 401, { error: 'invalid_identity' })
      }
      const account = upsertAccount(identity)
      const session = issueSession(account.id)
      return json(res, 200, {
        profile: {
          accountId: `${account.issuer}|${account.subject}`,
          email: account.email,
          name: account.name,
        },
        ...session,
      })
    },

    'POST /auth/refresh': async (req, res) => {
      const body = await readBody(req)
      const row = db.prepare('SELECT * FROM sessions WHERE refresh_hash = ?').get(sha256(String(body.refreshToken ?? '')))
      if (!row) return json(res, 401, { error: 'invalid_refresh' })
      if (row.revoked || row.refresh_exp <= Date.now()) return json(res, 401, { error: 'invalid_refresh' })
      // Rotate: old refresh dies with this use.
      const sessionToken = token()
      const refreshToken = token()
      const now = Date.now()
      db.prepare(
        `UPDATE sessions SET session_hash = ?, refresh_hash = ?, session_exp = ?, refresh_exp = ? WHERE id = ?`,
      ).run(sha256(sessionToken), sha256(refreshToken), now + SESSION_TTL_MS, now + REFRESH_TTL_MS, row.id)
      return json(res, 200, { sessionToken, refreshToken, sessionExpiresAt: now + SESSION_TTL_MS })
    },

    'POST /auth/logout': async (req, res, account) => {
      db.prepare('UPDATE sessions SET revoked = 1 WHERE account_id = ?').run(account.account_id ?? account.id)
      return json(res, 200, { ok: true })
    },

    'GET /v1/me': async (req, res, account) => {
      return json(res, 200, {
        accountId: `${account.issuer}|${account.subject}`,
        email: account.email,
        name: account.name,
      })
    },

    'GET /v1/computers': async (req, res, account) => {
      // Strictly this account's rows — SECURITY-01. Presence comes from real
      // heartbeats; directory freshness and reachability stay separate facts.
      const callerDevice = req.headers['x-device-id'] ?? null
      const rows = db
        .prepare('SELECT * FROM saved_computers WHERE account_id = ? AND removed_at IS NULL')
        .all(account.id)
      return json(res, 200, {
        computers: rows.map((r) => {
          const device = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(r.device_id)
          return {
            deviceId: r.device_id,
            publicId: r.public_id,
            name: r.name,
            online: presenceOf(device),
            isThisDevice: callerDevice === r.device_id,
            // Route hints visible to account members only (never public).
            endpoints: device?.endpoints ? JSON.parse(device.endpoints) : [],
          }
        }),
      })
    },

    // --- M3: enrollment, identity, presence, saved-computer management ---

    'POST /v1/devices/enroll': async (req, res, account) => {
      // Explicit owner enrollment (HOST-02). The client supplies its stable
      // self-generated device identity; the service allocates the public ID.
      const body = await readBody(req)
      const deviceId = String(body.deviceId ?? '')
      const name = String(body.name ?? '').trim().slice(0, 120)
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(deviceId)) return json(res, 400, { error: 'bad_device_id' })
      if (!name) return json(res, 400, { error: 'bad_name' })

      const existing = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId)
      if (existing) {
        // A device is owned by exactly one account; account switching must not
        // silently transfer ownership (AUTH-08/10).
        if (existing.account_id !== account.id) return json(res, 409, { error: 'owned_by_another_account' })
        const saved = savedRow(account.id, deviceId)
        return json(res, 200, {
          deviceId,
          publicId: existing.public_id,
          saved: Boolean(saved && !saved.removed_at),
        })
      }
      const publicId = allocatePublicId(db)
      db.prepare('INSERT INTO devices (device_id, account_id, name, public_id, created_at) VALUES (?, ?, ?, ?, ?)').run(
        deviceId,
        account.id,
        name,
        publicId,
        Date.now(),
      )
      // Owner devices appear in the account's saved list — unless a removal
      // tombstone exists (DEVICE-08/10: sync must not recreate removed rows).
      if (!savedRow(account.id, deviceId)) {
        db.prepare(
          'INSERT INTO saved_computers (account_id, device_id, public_id, name, created_at) VALUES (?, ?, ?, ?, ?)',
        ).run(account.id, deviceId, publicId, name, Date.now())
      }
      return json(res, 200, { deviceId, publicId, saved: true })
    },

    'POST /v1/devices/heartbeat': async (req, res, account) => {
      const body = await readBody(req)
      const device = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(String(body.deviceId ?? ''))
      // Only the owning account may mark a device present.
      if (!device || device.account_id !== account.id) return json(res, 403, { error: 'not_your_device' })
      // Route hints: the host's own reported endpoints (LAN IPs, tailnet
      // addresses). They are hints for verified resolution — never trusted
      // alone (LIST-10).
      let endpoints = '[]'
      if (Array.isArray(body.endpoints)) {
        endpoints = JSON.stringify(body.endpoints.filter((e) => typeof e === 'string').slice(0, 8))
      }
      db.prepare('UPDATE devices SET last_seen = ?, endpoints = ? WHERE device_id = ?').run(
        now(),
        endpoints,
        device.device_id,
      )
      return json(res, 200, { ok: true })
    },

    'POST /v1/computers/resolve': async (req, res, account, ip) => {
      // DEVICE-03: resolve a public ID to a stable identity + permitted public
      // metadata. No access grant is created by knowing the ID (SECURITY-02).
      if (rateLimited(ip, RESOLVE_RATE_LIMIT)) return json(res, 429, { error: 'rate_limited' })
      const body = await readBody(req)
      const publicId = normalizePublicId(body.publicId)
      if (!publicId) return json(res, 400, { error: 'bad_public_id' })
      const device = db.prepare('SELECT * FROM devices WHERE public_id = ?').get(publicId)
      if (!device) return json(res, 404, { error: 'unknown_id' })
      return json(res, 200, {
        deviceId: device.device_id,
        publicId: device.public_id,
        name: device.name,
        online: presenceOf(device),
      })
    },

    'POST /v1/computers': async (req, res, account) => {
      const body = await readBody(req)
      const publicId = normalizePublicId(body.publicId)
      const name = String(body.name ?? '').trim().slice(0, 120)
      if (!publicId) return json(res, 400, { error: 'bad_public_id' })
      if (!name) return json(res, 400, { error: 'bad_name' })
      const device = db.prepare('SELECT * FROM devices WHERE public_id = ?').get(publicId)
      if (!device) return json(res, 404, { error: 'unknown_id' })
      if (device.device_id === String(body.ownDeviceId ?? '')) return json(res, 400, { error: 'cannot_add_self' })
      const existing = savedRow(account.id, device.device_id)
      if (existing && !existing.removed_at) return json(res, 409, { error: 'already_saved' })
      if (existing) {
        // DEVICE-10: explicit re-add clears the tombstone; no trust is created.
        db.prepare('UPDATE saved_computers SET removed_at = NULL, name = ? WHERE id = ?').run(name, existing.id)
      } else {
        db.prepare(
          'INSERT INTO saved_computers (account_id, device_id, public_id, name, created_at) VALUES (?, ?, ?, ?, ?)',
        ).run(account.id, device.device_id, device.public_id, name, Date.now())
      }
      return json(res, 200, { deviceId: device.device_id, publicId: device.public_id, name })
    },

    'PATCH /v1/computers': async (req, res, account) => {
      const body = await readBody(req)
      const deviceId = String(body.deviceId ?? '')
      const name = String(body.name ?? '').trim().slice(0, 120)
      if (!name) return json(res, 400, { error: 'bad_name' })
      const saved = savedRow(account.id, deviceId)
      if (!saved || saved.removed_at) return json(res, 404, { error: 'not_saved' })
      // DEVICE-06: per-account alias only; device identity/hostname untouched.
      db.prepare('UPDATE saved_computers SET name = ? WHERE id = ?').run(name, saved.id)
      return json(res, 200, { deviceId, name })
    },

    'DELETE /v1/computers': async (req, res, account) => {
      const body = await readBody(req)
      const saved = savedRow(account.id, String(body.deviceId ?? ''))
      if (!saved || saved.removed_at) return json(res, 404, { error: 'not_saved' })
      // DEVICE-08: account-level tombstone; the device stays enrolled and host
      // trust is unaffected. The confirmation copy must say exactly that.
      db.prepare('UPDATE saved_computers SET removed_at = ? WHERE id = ?').run(Date.now(), saved.id)
      return json(res, 200, { ok: true })
    },

    // --- M4: host policy, connection requests, trust ------------------------

    'POST /v1/devices/policy': async (req, res, account) => {
      const body = await readBody(req)
      const device = ownedDevice(account, body.deviceId)
      if (!device) return json(res, 403, { error: 'not_your_device' })
      const unattended = body.unattended === true
      db.prepare('UPDATE devices SET unattended = ? WHERE device_id = ?').run(unattended ? 1 : 0, device.device_id)
      return json(res, 200, { deviceId: device.device_id, unattended })
    },

    'GET /v1/devices/policy': async (req, res, account) => {
      const url = new URL(req.url, 'http://localhost')
      const device = ownedDevice(account, url.searchParams.get('deviceId'))
      if (!device) return json(res, 403, { error: 'not_your_device' })
      return json(res, 200, { deviceId: device.device_id, unattended: Boolean(device.unattended) })
    },

    'POST /v1/requests': async (req, res, account) => {
      const body = await readBody(req)
      const host = db.prepare('SELECT * FROM devices WHERE device_id = ?').get(String(body.hostDeviceId ?? ''))
      if (!host) return json(res, 404, { error: 'unknown_device' })
      const requesterDeviceId = String(req.headers['x-device-id'] ?? '')
      if (!requesterDeviceId) return json(res, 400, { error: 'missing_device_identity' })
      if (requesterDeviceId === host.device_id) return json(res, 400, { error: 'cannot_connect_to_self' })
      const label = String(body.label ?? '').trim().slice(0, 120)

      expireOverdue()
      // HOST-07 + unattended: an already-trusted controller of the SAME owner
      // account connects without approval when the host policy allows it.
      const sameAccount = host.account_id === account.id
      if (sameAccount && host.unattended && isTrusted(host.device_id, requesterDeviceId)) {
        const id = token(12)
        db.prepare(
          `INSERT INTO connection_requests
           (id, host_device_id, requester_account_id, requester_device_id, requester_label, state, deadline, perm_control, perm_files, perm_clipboard, perm_audio, decided_at, created_at)
           VALUES (?, ?, ?, ?, ?, 'accepted', ?, 1, 1, 1, 1, ?, ?)`,
        ).run(id, host.device_id, account.id, requesterDeviceId, label, now(), now(), now())
        const row = db.prepare('SELECT * FROM connection_requests WHERE id = ?').get(id)
        return json(res, 200, requestView(row))
      }

      // APPROVAL-09: one pending or active session per host in this release.
      const busy = db
        .prepare(
          "SELECT 1 FROM connection_requests WHERE host_device_id = ? AND (state = 'pending' OR state = 'accepted') LIMIT 1",
        )
        .get(host.device_id)
      if (busy) return json(res, 409, { error: 'busy' })

      const id = token(12)
      const deadline = now() + REQUEST_TTL_MS
      db.prepare(
        `INSERT INTO connection_requests
         (id, host_device_id, requester_account_id, requester_device_id, requester_label, state, deadline, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(id, host.device_id, account.id, requesterDeviceId, label, deadline, now())
      const row = db.prepare('SELECT * FROM connection_requests WHERE id = ?').get(id)
      return json(res, 200, requestView(row))
    },

    'GET /v1/requests/pending': async (req, res, account) => {
      const url = new URL(req.url, 'http://localhost')
      const device = ownedDevice(account, url.searchParams.get('deviceId'))
      if (!device) return json(res, 403, { error: 'not_your_device' })
      expireOverdue()
      const rows = db
        .prepare(
          `SELECT r.*, a.email AS requester_email, a.name AS requester_name
           FROM connection_requests r JOIN accounts a ON a.id = r.requester_account_id
           WHERE r.host_device_id = ? AND r.state = 'pending' ORDER BY r.created_at ASC`,
        )
        .all(device.device_id)
      return json(res, 200, {
        requests: rows.map((r) => ({
          ...requestView(r),
          requesterEmail: r.requester_email,
          requesterName: r.requester_name,
          // Verified new-device signal: not merely a display string (APPROVAL-01).
          isNewDevice: !isTrusted(r.host_device_id, r.requester_device_id),
          // Persistent trust may only be offered for the owner's own account
          // (APPROVAL-10) — the UI uses this to show/hide the option.
          sameAccount: r.requester_account_id === account.id,
        })),
      })
    },

    'GET /v1/requests/status': async (req, res, account, _ip, request) => {
      const url = new URL(req.url, 'http://localhost')
      const id = url.searchParams.get('id') ?? ''
      expireOverdue()
      const row = db.prepare('SELECT * FROM connection_requests WHERE id = ?').get(id)
      if (!row) return json(res, 404, { error: 'not_found' })
      if (!requestRole(account, row, request)) return json(res, 403, { error: 'not_your_request' })
      return json(res, 200, requestView(row))
    },

    'POST /v1/requests/cancel': async (req, res, account, _ip, request) => {
      const body = await readBody(req)
      const row = db.prepare('SELECT * FROM connection_requests WHERE id = ?').get(String(body.id ?? ''))
      if (!row) return json(res, 404, { error: 'not_found' })
      if (requestRole(account, row, request) !== 'requester') return json(res, 403, { error: 'not_your_request' })
      // APPROVAL-08: a cancelled attempt can never be accepted later.
      db.prepare(
        "UPDATE connection_requests SET state = 'cancelled', decided_at = ? WHERE id = ? AND state IN ('pending', 'accepted')",
      ).run(now(), row.id)
      return json(res, 200, { ok: true })
    },

    'POST /v1/requests/accept': async (req, res, account) => {
      const body = await readBody(req)
      const row = db.prepare('SELECT * FROM connection_requests WHERE id = ?').get(String(body.id ?? ''))
      if (!row) return json(res, 404, { error: 'not_found' })
      if (!ownedDevice(account, row.host_device_id)) return json(res, 403, { error: 'not_your_device' })
      // APPROVAL-04: atomic decision — exactly one winner between Accept and
      // expiry/cancel. The deadline is host-side and authoritative.
      const decidedAt = now()
      const result = db
        .prepare(
          `UPDATE connection_requests
           SET state = 'accepted', decided_at = ?, perm_control = ?, perm_files = ?, perm_clipboard = ?, perm_audio = ?
           WHERE id = ? AND state = 'pending' AND deadline > ?`,
        )
        .run(decidedAt, body.control === true ? 1 : 0, body.files === true ? 1 : 0, body.clipboard === true ? 1 : 0, body.audio === true ? 1 : 0, row.id, decidedAt)
      if (result.changes === 0) return json(res, 410, { error: 'request_not_pending' })
      // APPROVAL-10: persistent trust only when explicitly requested AND the
      // requester belongs to the host's owner account — never for helpers.
      if (body.trust === true && row.requester_account_id === account.id) {
        db.prepare(
          `INSERT INTO trusted_controllers (host_device_id, controller_device_id, controller_label, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (host_device_id, controller_device_id) DO UPDATE SET revoked_at = NULL, controller_label = excluded.controller_label`,
        ).run(row.host_device_id, row.requester_device_id, row.requester_label, decidedAt)
      }
      return json(res, 200, requestView(db.prepare('SELECT * FROM connection_requests WHERE id = ?').get(row.id)))
    },

    'POST /v1/requests/reject': async (req, res, account) => {
      const body = await readBody(req)
      const row = db.prepare('SELECT * FROM connection_requests WHERE id = ?').get(String(body.id ?? ''))
      if (!row) return json(res, 404, { error: 'not_found' })
      if (!ownedDevice(account, row.host_device_id)) return json(res, 403, { error: 'not_your_device' })
      // APPROVAL-02: rejection grants nothing and creates no trust.
      const result = db
        .prepare("UPDATE connection_requests SET state = 'rejected', decided_at = ? WHERE id = ? AND state = 'pending'")
        .run(now(), row.id)
      if (result.changes === 0) return json(res, 410, { error: 'request_not_pending' })
      return json(res, 200, { ok: true })
    },

    'POST /v1/requests/end': async (req, res, account, _ip, request) => {
      const body = await readBody(req)
      const row = db.prepare('SELECT * FROM connection_requests WHERE id = ?').get(String(body.id ?? ''))
      if (!row) return json(res, 404, { error: 'not_found' })
      if (!requestRole(account, row, request)) return json(res, 403, { error: 'not_your_request' })
      // Either side can end; ended grants authorize nothing further.
      db.prepare(
        "UPDATE connection_requests SET state = 'ended', decided_at = ? WHERE id = ? AND state = 'accepted'",
      ).run(now(), row.id)
      return json(res, 200, { ok: true })
    },

    'GET /v1/devices/trusted': async (req, res, account) => {
      const url = new URL(req.url, 'http://localhost')
      const device = ownedDevice(account, url.searchParams.get('deviceId'))
      if (!device) return json(res, 403, { error: 'not_your_device' })
      // TRUST-01: only actual host-authorized controllers, by device identity.
      const rows = db
        .prepare(
          'SELECT * FROM trusted_controllers WHERE host_device_id = ? AND revoked_at IS NULL ORDER BY created_at DESC',
        )
        .all(device.device_id)
      return json(res, 200, {
        controllers: rows.map((r) => ({
          controllerDeviceId: r.controller_device_id,
          label: r.controller_label,
          trustedAt: r.created_at,
        })),
      })
    },

    'POST /v1/devices/trusted/revoke': async (req, res, account) => {
      const body = await readBody(req)
      const device = ownedDevice(account, body.deviceId)
      if (!device) return json(res, 403, { error: 'not_your_device' })
      const controllerId = String(body.controllerDeviceId ?? '')
      // TRUST-02: revoke exactly one controller and end its active sessions.
      const result = db
        .prepare(
          'UPDATE trusted_controllers SET revoked_at = ? WHERE host_device_id = ? AND controller_device_id = ? AND revoked_at IS NULL',
        )
        .run(Date.now(), device.device_id, controllerId)
      if (result.changes === 0) return json(res, 404, { error: 'not_trusted' })
      db.prepare(
        "UPDATE connection_requests SET state = 'ended', decided_at = ? WHERE host_device_id = ? AND requester_device_id = ? AND state = 'accepted'",
      ).run(now(), device.device_id, controllerId)
      return json(res, 200, { ok: true })
    },
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost')
      const key = `${req.method} ${url.pathname}`
      const handler = routes[key]
      if (!handler) return json(res, 404, { error: 'not_found' })

      const ip = req.socket.remoteAddress ?? 'unknown'
      if (key.startsWith('POST /auth/') && rateLimited(ip)) {
        return json(res, 429, { error: 'rate_limited' })
      }

      if (url.pathname.startsWith('/v1/') || key === 'POST /auth/logout') {
        const auth = req.headers.authorization ?? ''
        const account = authenticate(auth.startsWith('Bearer ') ? auth.slice(7) : null)
        if (!account) return json(res, 401, { error: 'unauthenticated' })
        return await handler(req, res, account, ip, req)
      }
      return await handler(req, res)
    } catch (e) {
      if (e instanceof SyntaxError) return json(res, 400, { error: 'bad_request' })
      return json(res, 500, { error: 'internal' })
    }
  })

  return {
    server,
    db,
    /** Test helper: insert a saved computer directly. */
    _insertSaved(accountId, device) {
      db.prepare(
        'INSERT INTO saved_computers (account_id, device_id, public_id, name, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(accountId, device.deviceId, device.publicId, device.name, Date.now())
    },
    _accountId(issuer, subject) {
      return db.prepare('SELECT id FROM accounts WHERE issuer = ? AND subject = ?').get(issuer, subject)?.id
    },
    listen(port = 0) {
      return new Promise((resolve) => {
        server.listen(port, '127.0.0.1', () => resolve(server.address().port))
      })
    },
    close() {
      server.close()
      db.close()
    },
  }
}

// Direct start: node src/server.js
if (import.meta.url === `file://${process.argv[1]}`) {
  const clientId = process.env.GOOGLE_CLIENT_ID
  if (!clientId) {
    console.error('GOOGLE_CLIENT_ID is required. See docs/ui-redesign/GOOGLE_SETUP.md.')
    process.exit(1)
  }
  const port = Number(process.env.PORT ?? 8787)
  const dbPath = process.env.DB_PATH ?? 'directory.db'
  const svc = createDirectoryService({ dbPath, clientId })
  svc.server.listen(port, () => {
    console.log(`NodeDesk directory service listening on :${port} (db: ${dbPath})`)
  })
}
