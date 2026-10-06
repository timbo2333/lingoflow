# Pinned browser SDK dependency and storage contract

The normal product Auth loader pins **supabase-js 2.117.2**, including the
exact **auth-js 2.117.2** dependency. It no longer accepts an SDK URL from
client configuration or reuses an unknown preexisting `window.supabase`.

Trust anchor (private constants in `js/supabase-auth-service.js`):

- URL: `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js`
- SRI: `sha256-WdOUh8NYmEO0EDItij1WLOAiq6HlzLFomO8/sqDaLs0=`
- SHA-256: `59d39487c3589843b410322d8a3d562ce022aba1e5ccb16898ef3fb2a0da2ecd`
- Original artifact: 217,945 bytes; byte-identical to the verified npm package.

The loader sets exact src, integrity and anonymous CORS before append. A
temporary accessor records the UMD assignment only while the loader-owned
element is `document.currentScript`. A foreign write, replacement before load,
missing API, script error or 15s timeout fails closed. Only successful owned
execution **and** load establish private SDK/factory references. Later global
replacement does not replace those references. Concurrent calls share a private
promise; failure has no alternate URL, integrity-free or unknown-global fallback.
Each attempt locks settlement before cleanup. Timer, handler, script and global
cleanup are individually guarded; an exception cannot leave waiters pending.
Successful finalization is mandatory before private SDK/factory references are
committed. Any cleanup exception, including on the otherwise-successful path,
rejects with `supabase-sdk-cleanup-failed` without exposing descriptor/object
details. Failure retains the rejected load promise for this Document; late
load/error/timeout callbacks cannot establish trust or start another load.
Trust is Document-local, never a persisted/public boolean. This is dependency
integrity hardening, not a defense against malicious same-privilege page code
that rewrites browser APIs or compromises the loader itself.

Exact-build trust applies only to Documents newly created/reloaded after the
hardening is deployed, which successfully initialize through this hardened
loader. An old Document that already loaded floating `@2` or an unknown /
preexisting Supabase SDK before deployment is **not retroactively trusted**.
Before any LIVE fixture or future test-side token reader relies on this build
identity, reload or create a new Document and complete the hardened loader
again. A dependency deployment alone does not certify already-open pages.

## Audited normal browser storage

For this build, `persistSession: true`, no custom storage/userStorage, and
available browser localStorage:

- SDK uses the current page origin's `globalThis.localStorage`.
- Default key: `sb-${baseUrl.hostname.split('.')[0]}-auth-token`, using a
  validated standard URL, not substring guessing.
- Project A key: `sb-yebabpjplbgidzwpjhoy-auth-token`.
- `_saveSession` clones the session; `setItemAsync` JSON-stringifies it.
- Normal value is the top-level session object, not a version/base64 envelope.
- Token path: `parsed.access_token`; adjacent session fields include
  `refresh_token`, `expires_in`, `expires_at`, `token_type` and `user`.
- Native `localStorage.getItem` is synchronous and does not refresh or call SDK.
- SDK `getSession` is asynchronous and can refresh/remove session state.
- When localStorage is unavailable the SDK can fall back to memory; a future
  storage-only test reader must return NO-GO rather than guessing/recovering it.

Sources: the published npm packages, and byte-matched
[SupabaseClient](https://github.com/supabase/supabase-js/blob/v2.117.2/packages/core/supabase-js/src/SupabaseClient.ts),
[GoTrueClient](https://github.com/supabase/supabase-js/blob/v2.117.2/packages/core/auth-js/src/GoTrueClient.ts)
and [storage helpers](https://github.com/supabase/supabase-js/blob/v2.117.2/packages/core/auth-js/src/lib/helpers.ts).
Future SDK upgrades require a new artifact/storage audit and relevant Auth tests.

## Not Progress transport authorization

This change implements no token reader, identity hook or fixture send bridge.
Tokens/storage metadata are not owner authority. Page-side send linearization,
browser token continuity and IndexedDB barriers still require separate work.
The existing native-generation send-boundary P1 remains open; fixture READY is
not a future authenticated client UPDATE send lease. No LIVE fixture execution
is authorized by these tests or this dependency pin.

Loader tests simulate DOM execution without CDN access. Auth/first-device tests
use an explicit fake script-loader and mock SDK, not an unverified preexisting
global. Native-browser SRI smoke uses isolated contexts and audited public bytes;
it must not attach a user profile, inspect a real session or access a Project.
