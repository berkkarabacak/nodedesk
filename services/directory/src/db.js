// Storage for the NodeDesk directory service. Zero-dependency: uses the
// built-in node:sqlite module. Migrations are additive and versioned.

import { DatabaseSync } from 'node:sqlite'

const MIGRATIONS = [
  // v1: accounts, sessions, saved computers.
  `
  CREATE TABLE IF NOT EXISTS accounts (
    id            INTEGER PRIMARY KEY,
    issuer        TEXT NOT NULL,
    subject       TEXT NOT NULL,
    email         TEXT NOT NULL,
    name          TEXT NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL,
    UNIQUE (issuer, subject)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id            INTEGER PRIMARY KEY,
    account_id    INTEGER NOT NULL REFERENCES accounts(id),
    session_hash  TEXT NOT NULL UNIQUE,
    refresh_hash  TEXT UNIQUE,
    created_at    INTEGER NOT NULL,
    session_exp   INTEGER NOT NULL,
    refresh_exp   INTEGER NOT NULL,
    revoked       INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS saved_computers (
    id            INTEGER PRIMARY KEY,
    account_id    INTEGER NOT NULL REFERENCES accounts(id),
    device_id     TEXT NOT NULL,
    public_id     TEXT NOT NULL,
    name          TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    removed_at    INTEGER,
    UNIQUE (account_id, device_id)
  );
  `,
  // v2 (M3): enrolled devices with stable identity and a public nine-digit ID.
  // The public ID is a lookup handle, not a credential (SPEC §05); it is
  // stored as TEXT so leading zeroes survive.
  `
  CREATE TABLE IF NOT EXISTS devices (
    device_id     TEXT PRIMARY KEY,
    account_id    INTEGER NOT NULL REFERENCES accounts(id),
    name          TEXT NOT NULL,
    public_id     TEXT NOT NULL UNIQUE,
    created_at    INTEGER NOT NULL,
    last_seen     INTEGER
  );
  `,
  // v3 (M4): host policy, trusted controllers, and connection requests.
  // Trust is a host-side authorization record keyed by controller device
  // identity — never inferred from account, discovery, or saved-list rows.
  // Request decisions are atomic (state guarded UPDATE) so Accept/expiry
  // races have exactly one winner (APPROVAL-04).
  `
  ALTER TABLE devices ADD COLUMN unattended INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE IF NOT EXISTS trusted_controllers (
    id                INTEGER PRIMARY KEY,
    host_device_id    TEXT NOT NULL REFERENCES devices(device_id),
    controller_device_id TEXT NOT NULL,
    controller_label  TEXT NOT NULL DEFAULT '',
    created_at        INTEGER NOT NULL,
    revoked_at        INTEGER,
    UNIQUE (host_device_id, controller_device_id)
  );

  CREATE TABLE IF NOT EXISTS connection_requests (
    id                  TEXT PRIMARY KEY,
    host_device_id      TEXT NOT NULL REFERENCES devices(device_id),
    requester_account_id INTEGER NOT NULL REFERENCES accounts(id),
    requester_device_id TEXT NOT NULL,
    requester_label     TEXT NOT NULL DEFAULT '',
    state               TEXT NOT NULL DEFAULT 'pending',
    deadline            INTEGER NOT NULL,
    perm_control        INTEGER NOT NULL DEFAULT 0,
    perm_files          INTEGER NOT NULL DEFAULT 0,
    perm_clipboard      INTEGER NOT NULL DEFAULT 0,
    perm_audio          INTEGER NOT NULL DEFAULT 0,
    decided_at          INTEGER,
    created_at          INTEGER NOT NULL
  );
  `,
  // v4 (M5): self-reported route hints for verified resolution.
  `
  ALTER TABLE devices ADD COLUMN endpoints TEXT NOT NULL DEFAULT '[]';
  `,
]

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  const row = db.prepare('PRAGMA user_version').get()
  let version = row.user_version
  while (version < MIGRATIONS.length) {
    db.exec(MIGRATIONS[version])
    version += 1
    db.exec(`PRAGMA user_version = ${version}`)
  }
  return db
}
