# Favorite Supabase Dev Sync Setup

This setup is only for the Favorite Dev Cloud vertical slice. It does not add a
production account UI or enable other entity types.

## 1. Create the Dev project and user

1. Create a Supabase Dev project.
2. Create one Supabase Auth test user.
3. Record the project URL, publishable/anon key, Auth user UUID, and a current
   user access token. Never use a service-role key in the browser.

The Auth user UUID is the sync `ownerId`. The database functions independently
compare it with `auth.uid()` from the signed user JWT.

## 2. Apply the database migration

Apply the migrations in order through the Supabase CLI migration workflow:

```text
supabase/migrations/20260904000000_favorite_sync_dev.sql
supabase/migrations/20260905012000_fix_favorite_sync_rpc.sql
```

The first migration creates the three Favorite sync tables, owner-only RLS
policies, and the authenticated Push/Pull RPC functions. The second migration
replaces the Pull RPC to correct its `coalesce` expressions without rewriting
the already-applied migration history. Direct browser table access is revoked;
the client only calls those RPCs.

## 3. Configure a local browser session

Copy `js/supabase-config.example.js` to the ignored file
`js/supabase-config.local.js`, then provide:

- `projectUrl`
- `publishableKey`
- optionally, the Auth user's UUID as `expectedOwnerId`
- a function that returns the current signed-in user's access token

The runtime `ownerId` always comes from the authenticated `/auth/v1/user`
response. `expectedOwnerId` is only a local assertion that blocks startup if the
session belongs to a different user.

The local config file is intentionally ignored. Do not place database passwords,
service-role keys, admin secrets, or committed user access tokens in the repo.

Open the local app with `?supabase-sync=dev` in the URL. The app only loads
`js/supabase-config.local.js` when that explicit Dev flag is present. A normal
page load remains local-only and does not attempt Auth, Push, or Pull.

After the Dev session is verified, page startup binds the authenticated owner,
recovers prepared Favorite mutations, reconciles local drift into the durable
outbox, pushes ready mutations, then pulls through the existing Inbox/Apply
path. Network failures do not undo local Favorite writes; their outbox entries
remain available for the next page load or `online` retry.

## 4. Run the real-cloud smoke test

Provide these environment variables to the test process:

```text
LINGOFLOW_SUPABASE_URL
LINGOFLOW_SUPABASE_PUBLISHABLE_KEY
LINGOFLOW_SUPABASE_OWNER_ID
LINGOFLOW_SUPABASE_ACCESS_TOKEN
```

Then run `tests/supabase-sync-service.spec.js`. With all four values present, its
live test uses two isolated browser contexts to verify create, update, tombstone,
and local-dirty protection through Supabase. Without them, only the live test is
skipped; adapter and SQL contract tests still run.

The access token is short-lived. Obtain a fresh token from the Dev user's Auth
session when the test reports an authentication failure.
