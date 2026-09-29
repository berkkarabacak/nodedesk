# ADR 0002: Account-based fleet discovery

- Status: Accepted
- Date: 2026-09-29

## Context

NodeDesk finds computers by LAN UDP broadcast (port 47800) and, when Tailscale
is installed, by the local tailnet status. Most of the owner's machines will
not share a LAN. Tailscale remains a supported path, but it is optional and
not something every machine will have.

The owner wants same-account computers to see each other across networks:
Google sign-in, account management, and a list of that account's PCs. LAN and
Tailscale discovery stay as they are. Account discovery is additive.

Two constraints are not optional:

- Sunshine is never silently exposed to the public internet
  ([networking](../networking.md), [security](../security.md)).
- The agent channel is HMAC-signed but not encrypted. A public address is not
  a safe place to send it. Tailscale is still the confidentiality path for an
  untrusted network.

OAuth client IDs and the registry that stores presence are **owner-supplied
configuration**. They are not secrets committed to git. A desktop OAuth client
is a public client: there is no client secret to hide in the binary.

## Decision

**Google is the identity provider. An account-linked device registry stores
presence and address candidates. Phase A ships identity, the device list, and
connect through addresses NodeDesk already knows how to use. Phase B, a secure
path that is neither LAN nor Tailscale, is documented here and not built.**

### Phase A — this change

1. **Identity.** "Sign in with Google" uses the OAuth authorization-code flow
   with PKCE (`S256`) and a loopback redirect on `127.0.0.1`. Scopes are
   `openid email`. The access token, refresh token, Google subject, and email
   are stored in OS secure storage (the same keyring service as access codes).
   The client id comes from `NODEDESK_GOOGLE_CLIENT_ID` or Settings → Advanced.
   It is not hardcoded.
2. **Registry.** A small HTTPS API, base URL from `NODEDESK_REGISTRY_URL` or
   Settings → Advanced, records devices for the signed-in account:
   `POST /v1/devices`, `POST /v1/devices/{id}/heartbeat`, `GET /v1/devices`,
   `DELETE /v1/devices/{id}`. The client sends `Authorization: Bearer` and does
   not put an account id in the body. A real registry must validate the Google
   access token and key records by its `sub` claim. The wire shape lives in
   `apps/desktop/src-tauri/src/registry.rs`.
3. **What gets published.** Only addresses this app is willing to dial:
   private LAN (RFC1918 and IPv6 unique-local) and Tailscale (CGNAT
   `100.64.0.0/10`, Tailscale's IPv6 prefix, or a Tailscale hostname). Public
   IPs are dropped before they are sent. A machine whose only address is
   public checks in with no address rather than advertising that IP.
4. **What the dashboard does.** With no account session, the computer list is
   unchanged. With a session, registry devices are merged beside LAN and
   tailnet results. If discovery already found one of the device's usable
   addresses, that existing card is kept (LAN / Tailscale still win). Otherwise
   the best candidate is used: Tailscale IPv4, then private LAN IPv4, then
   Tailscale IPv6, then other local IPv6, then a Tailscale hostname. Connect
   uses the existing client path to that address. A device with no usable
   address is shown by name as on the account and not reachable. Nothing in
   this phase opens a port.

`mock://local` selects an in-process stub so unit tests and a single desktop
process can exercise the client without a server. The stub keys records by the
raw bearer string and does **not** validate Google tokens. It is not a
deployment.

### Phase B — not in this change

A computer that has no private or Tailscale address still cannot be connected.
These are the options for a later decision. None of them are implemented, and
none of them may publish Sunshine on the public internet:

| Option | Idea | Constraint |
|---|---|---|
| Tailscale (already shipped) | Exchange the tailnet address through the registry so two NodeDesk installs find each other even when broadcast cannot | User installs Tailscale. NodeDesk still does not require it |
| Outbound relay | Both peers dial out to a relay the owner runs. The host does not listen on a public port | The Moonlight session stays end-to-end encrypted. The relay forwards ciphertext. It is not a place that terminates the stream |
| UDP hole punching | Both peers dial out (STUN/TURN) so no inbound public listener is required | No fallback that opens the Sunshine port. High complexity. Easy to get wrong |
| Explicit port forward | The user forwards a port themselves | Only after a clear warning. Never automatic, never silent |

Until one of those exists, "not reachable from this network yet" is the honest
state. That is preferable to a connect button that would poke Sunshine at a
public address.

### Owner configuration

Berk supplies, outside this repository:

1. A Google Cloud OAuth client of type **Desktop**. Client id only — do not
   create or ship a client secret. Redirect is loopback
   `http://127.0.0.1:<port>/callback` (ephemeral port). If the console demands
   a fixed port, set `NODEDESK_OAUTH_REDIRECT_PORT`.
2. A registry base URL and a place to host the API above (any small HTTPS
   service). NodeDesk does not ship that server. Dev-only overrides
   `NODEDESK_OAUTH_AUTH_URL`, `NODEDESK_OAUTH_TOKEN_URL`, and
   `NODEDESK_OAUTH_USERINFO_URL` exist so tests can point at a local token
   service instead of Google.

## Consequences

- Sign-in does nothing useful until a client id is configured. The button says
  so instead of opening a browser that cannot succeed.
- Tokens are not written to `settings.json`. The client id and registry URL
  may be, because they are not secrets. Environment variables override the
  file when set.
- Cross-network confidentiality is unchanged: the agent channel is still not
  encrypted. Account discovery will not aim it at a public IP. Tailscale
  remains the way to cross an untrusted network.
- A production registry is a new trust boundary. It learns device names and
  private addresses for an account. It must not be given access codes, refresh
  tokens, or file contents, and it must authenticate the Google token rather
  than trust a user id from the client.
- Hosting, quotas, and account deletion are follow-on work. This ADR does not
  pick a vendor for the registry.

## Alternatives considered

- **Tailscale only.** Already works, and stays. It does not cover machines
  where Tailscale will not be installed, which is the case this ADR is for.
- **Email magic-link or a NodeDesk-operated account database.** More product
  surface before there is a registry to protect. Google is the identity the
  owner already has. Another provider can sit in front of the same registry
  later; the device list is not Google-shaped.
- **Put a client secret in the app.** A secret in a desktop binary is public.
  PKCE is the right tool for an installed app.
- **Implement hole punching in the same change as sign-in.** It is a different
  security problem. Shipping it beside the first registry client would make it
  easy to "just" fall back to a public Sunshine port. Phase A refuses that
  fallback instead.
