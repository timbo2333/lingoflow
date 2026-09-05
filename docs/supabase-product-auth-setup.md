# Supabase Product Auth Setup

V0.7 uses Supabase Auth email/password sessions to activate Favorite cloud sync.
The browser client uses only the public project URL and publishable key from
`js/supabase-config.js`. The SDK persists and refreshes the session; LingoFlow
does not store passwords or implement its own refresh-token protocol.

## Dashboard configuration required

In the Supabase Dashboard, open:

`Authentication → URL Configuration`

Set the production **Site URL** to the exact GitHub Pages application URL:

```text
https://timbo2333.github.io/lingoflow/
```

Add these **Redirect URLs** for the current production and local test entry
points:

```text
https://timbo2333.github.io/lingoflow/
http://127.0.0.1:4173/
http://localhost:4173/
```

If the deployed Pages URL differs, use its exact HTTPS URL instead. Keep Email
Confirmation enabled. The signup request passes the current page URL as
`emailRedirectTo`, so the confirmation link must be allowed here.

## Product behavior

- A signed-out page remains fully local-first and does not load the Auth SDK
  until the user opens the account flow (or a stored session/callback exists).
- Supabase Auth persists the browser session and refreshes access tokens.
- The authenticated `user.id` is the only source of the sync `ownerId`.
- Existing anonymous Favorites require an explicit **关联并同步** choice before
  workspace binding or reconciliation can begin.
- Choosing **暂不关联** leaves all local Favorites unchanged and uploads
  nothing. The choice remains available from the account panel.
- An empty, unbound browser can bind with low friction and pull the signed-in
  account's existing Favorite changes.
- Logout clears only the local Supabase session. It does not remove Favorites,
  the workspace binding, sidecars, inbox, outbox, or conflicts.
- A workspace already bound to another owner is blocked. V0.7 directs that
  user to another browser/Profile instead of attempting multi-account storage.

## Public configuration boundary

`js/supabase-config.js` may contain:

- Supabase project URL
- Supabase publishable key
- public SDK URL

It must never contain an access token, refresh token, password, secret key,
service-role key, database password, or admin credential. The ignored
`js/supabase-config.local.js` remains available only for conditional Dev smoke
tests and is not the normal product activation path.
