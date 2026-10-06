# Google sign-in + directory service setup (M2)

NodeDesk's account flow has two pieces an operator must configure. Neither
ships with credentials; a missing piece makes the app show a truthful
"not configured" message, never a fake account.

## 1. Create a Google OAuth client (one time)

1. Go to Google Cloud Console → APIs & Services → Credentials.
2. Create an OAuth 2.0 Client ID of type **Desktop app**. Any name works.
3. Copy the client ID (`….apps.googleusercontent.com`). No client secret is
   used — desktop apps are public clients and NodeDesk uses PKCE.
4. No redirect URI needs to be registered for the Desktop-app type: the flow
   uses a loopback address (`http://127.0.0.1:<random port>`), which Google
   allows for installed apps.
5. Under OAuth consent screen, the scopes `openid`, `email`, `profile` must
   be allowed. While the consent screen is in "Testing", add each user's
   Google account as a test user.

References: Google "Using OAuth 2.0 for Installed Applications"
(loopback IP address flow, PKCE recommended).

## 2. Run the directory service

Zero external dependencies (Node.js ≥ 22.5, built-in HTTP + SQLite):

```bash
cd services/directory
GOOGLE_CLIENT_ID="….apps.googleusercontent.com" \
PORT=8787 \
DB_PATH=/var/lib/nodedesk/directory.db \
node src/server.js
```

- `GOOGLE_CLIENT_ID` (required) — the desktop client ID from step 1. Tokens
  for any other audience are rejected.
- `PORT` (default 8787), `DB_PATH` (default ./directory.db).
- The service verifies Google ID tokens against Google's public JWKS and
  enforces account isolation for every directory read. Put it behind TLS
  (reverse proxy) for any non-localhost use — desktop builds send bearer
  tokens to it.
- Tests: `npm test` (real RSA/JWKS verification, account isolation,
  refresh rotation, rate limiting).

## 3. Point the desktop app at both

Create `account.json` in the desktop app's config directory
(Windows: `%APPDATA%/dev.nodedesk.app/`, macOS/Linux: the platform config
dir), or start from the sample:

```json
{
  "clientId": "….apps.googleusercontent.com",
  "directoryUrl": "https://directory.example.com"
}
```

Without this file, `auth_sign_in` returns `notConfigured` and the Login
screen explains that sign-in isn't set up — local network mode keeps working.

## Security notes

- The Google ID token is verified **by the directory service** (JWKS, RS256,
  issuer, audience, expiry). The desktop never trusts profile strings
  client-side.
- Directory session/refresh tokens are opaque random 256-bit values; only
  their SHA-256 hashes are stored server-side, and they are kept in the OS
  keychain on the desktop when "Stay signed in" is on (memory only when off).
- Nothing token-shaped is written to settings.json, logs, or diagnostics.
