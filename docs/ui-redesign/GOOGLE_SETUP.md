# Google sign-in + hosted directory

NodeDesk's desktop app is a public OAuth client. It uses Google's installed-app
loopback flow with PKCE. There is no client secret. A missing or placeholder
client id makes the app say sign-in is not configured. It never invents an account.

The directory that verifies the Google ID token is
`https://nodedesk.berkkarabacak.com`. That hostname is the directory URL in
`account.json`. It is **not** the browser redirect URI. The desktop app never
sends the browser to `https://nodedesk.berkkarabacak.com/auth/google/callback`.
After the loopback exchange it `POST`s the ID token to
`https://nodedesk.berkkarabacak.com/auth/google`.

## 1. Google Cloud Console — Desktop client

Do this once, in a browser, as the Google account that will own the project.

1. Open https://console.cloud.google.com/ and create a project named **NodeDesk**
   (any project id is fine). Stay in that project.
2. APIs & Services → **OAuth consent screen**.
   - User type: **External**.
   - App name: `NodeDesk`.
   - User support email: your Google account.
   - Audience: External, publishing status **Testing** until you are ready to verify.
   - Scopes: add `openid`, `.../auth/userinfo.email`, and `.../auth/userinfo.profile`
     (the consent screen lists these as openid, email, and profile).
   - Test users: add every Google account that will sign in while the app is in Testing.
     Accounts that are not listed are rejected by Google.
   - Developer contact email: your Google account.
   - Save. Do not request extra scopes.
3. APIs & Services → **Credentials** → **Create credentials** → **OAuth client ID**.
   - Application type: **Desktop app**.
   - Name: `NodeDesk desktop`.
   - Create.
4. Copy the **Client ID**. It looks like `1234567890-abcdef.apps.googleusercontent.com`.
   If Google also shows a client secret, ignore it. Do not download a JSON key,
   do not commit it, and do not put it in `/etc/nodedesk`.
5. Desktop clients use the loopback redirect. Google allows
   `http://127.0.0.1` and `http://localhost` on any port for this client type.
   NodeDesk binds `http://127.0.0.1:<ephemeral port>` with no path, sends
   `code_challenge_method=S256`, and exchanges the code itself.
   If the console shows an authorized-redirect list for this Desktop client,
   leave the defaults or add only:
   - `http://127.0.0.1`
   - `http://localhost`
   Do **not** add `https://nodedesk.berkkarabacak.com/auth/google/callback`.
   That URL is not a redirect this build uses. Adding it to a Web client would
   also create a client secret, which this repo must not store.

Authorized JavaScript origins are for web clients. Leave them empty.

## 2. Where the client id goes

Same client id in both places. Nothing else.

**Server** `2.28.215.22`, file `/etc/nodedesk/google-client-id`, mode `600`,
one line, the client id only:

```bash
sudo install -d -m 755 /etc/nodedesk /var/lib/nodedesk
sudo install -m 600 /dev/null /etc/nodedesk/google-client-id
printf '%s\n' '1234567890-abcdef.apps.googleusercontent.com' | sudo tee /etc/nodedesk/google-client-id >/dev/null
sudo chmod 600 /etc/nodedesk/google-client-id
```

**Each desktop**, `account.json` in the app config directory
(Windows: `%APPDATA%\dev.nodedesk.app\account.json`):

```json
{
  "clientId": "1234567890-abcdef.apps.googleusercontent.com",
  "directoryUrl": "https://nodedesk.berkkarabacak.com"
}
```

Or the environment variables `NODEDESK_GOOGLE_CLIENT_ID` and
`NODEDESK_DIRECTORY_URL`. The sample file
`apps/desktop/src-tauri/account.example.json` is a placeholder. Copying it
unchanged leaves sign-in not configured.

## 3. DNS

If `nodedesk.berkkarabacak.com` does not already resolve to the server, in
Squarespace DNS add one record:

| Type | Host | Data |
|---|---|---|
| A | `nodedesk` | `2.28.215.22` |

Do not change the apex, `www`, or `sync.berkkarabacak.com`.

## 4. Run the directory

From `services/directory` on the server (Linux, Docker):

```bash
docker compose up -d --build
```

`docker-compose.yml` uses the host network and the process binds
`127.0.0.1:8081`. There is no published port. Do not add
`47984`, `47989`, `47990`, or `48010`.

nginx (`deploy/nginx/nodedesk.conf`) listens on 443 and proxies to
`http://127.0.0.1:8081`. Put the TLS certificate on the server. The database
file is `/var/lib/nodedesk/directory.db`. Back that file up. A restart does
not need the Google client secret because there isn't one.

Check, on the server:

```bash
curl -fsS http://127.0.0.1:8081/healthz
curl -fsS https://nodedesk.berkkarabacak.com/healthz
```

Both return `{"ok":true}`.

## 5. What a successful sign-in does

Login → system browser → Google account (must be a test user while consent
is in Testing) → browser returns to `http://127.0.0.1:<port>` → the app
exchanges the code with Google → the directory verifies the ID token
(audience must be this client id) → My Computers shows the real empty or
synced list. Local network mode keeps working when this is not configured.
