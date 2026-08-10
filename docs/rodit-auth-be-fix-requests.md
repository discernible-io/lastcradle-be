# `@rodit/rodit-auth-be` fix requests

Requests for the RODiT auth SDK after the SLC CodeCome remediations
(2026-08-10). **Do not change** `SECURITY_OPTIONS.WEBHOOK_TLS_SKIP_VERIFY` /
self-signed acceptance — that is an intentional product feature (mutual auth
via Ed25519 webhook signatures).

## 1. Outbound `send_webhook` SSRF controls (HIGH — CC-0001 residual)

**Where:** `lib/middleware/webhookhandlermw.js` → `send_webhook`

**Problem:** SLC now blocklists private/loopback/metadata hosts at
`validateWebhookUrl` / join-by-url mint time, but the SDK still `fetch()`es
whatever URL is embedded in JWT `rodit_webhookurl` / peer metadata (including
CRUDA and passport-minted identities). DNS rebinding after mint, or a
compromised on-chain webhook URL, still reaches internal targets.

**Request:**

1. Before `fetch(formattedWebhookUrl, …)`, parse the URL and reject:
   - non-empty userinfo
   - loopback / RFC1918 / link-local / ULA / CGNAT / cloud-metadata hostnames
     and resolved A/AAAA addresses (same policy as SLC
     `src/game/url-join-identity.js`)
2. Enforce `webhook_cidr` when present on the peer/JWT (today it is stored
   but never consulted on the outbound path).
3. Prefer resolve-once + pin the IP for the request lifetime (DNS rebinding
   defense).

**Acceptable behavior:** keep `WEBHOOK_TLS_SKIP_VERIFY=true` support for
**public** destinations with self-signed certs.

## 2. Login success identity for app hooks (MEDIUM — CC-0008 hygiene)

**Where:** `login_client` / `login_client_withnep413` in
`lib/middleware/authenticationmw.js`

**Problem:** SLC fixed stamp pollution by decoding `jwt_token.sub` from the
response body. A cleaner SDK contract would expose the authenticated peer id
explicitly (e.g. `req.authenticatedRoditId` or include `roditid` in the JSON
body from the verified identity only).

**Request:** After successful signature verification, set a single
server-derived identity field on `req` (and optionally echo it in the login
JSON) that apps can trust without decoding the JWT.

## 3. Optional: `req.rateLimit` enforcement helper (LOW — CC-0006)

**Where:** `validatepermissionsmw.js` sets `req.rateLimit` metadata

**Request:** Document or ship a small middleware that consumes
`req.rateLimit` (today labeled future / inert) so apps are not left to
reimplement per-route claim enforcement.
