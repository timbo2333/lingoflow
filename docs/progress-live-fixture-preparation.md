# Dedicated Progress fixture preparation — harness foundation

Stage **B3-3B-2B-2B-1** implements a test-only harness, not actual fixture setup.
The foundation CLI has **no network adapter**, including when both gates are
set. Importing it does no IO. No real Article/Progress mutation is authorized by
this stage. **LF_PROGRESS_ARTICLE_A is not prepared.**

## Future actual preparation (separate review and authorization)

Next stage B3-3B-2B-2B-2 must explicitly inject the tested IO seams. Require
`LF_PROGRESS_LIVE_TEST=1`, `LF_PROGRESS_FIXTURE_PREPARE=1`, and
`--dedicated-test-account`; verify Auth GET owner against the fixed dedicated A
`db4f9c1c-4563-47a9-8649-150a4fb87a6a`. Project URL and linked CLI project must be
Project A (`yebabpjplbgidzwpjhoy`). Account B is not required. Credentials come
only from the same Terminal process environment; never chat, dotenv, artifacts
or another process/session. DEBUG/NODE_DEBUG/PWDEBUG must be absent.

The CLI currently stops before IO with `fixture-transport-not-injected`:

```sh
node scripts/progress-live-fixture-prepare.js --dedicated-test-account
```

An injected future runner uses exactly the older test-side `articlePush` and
`progressPush` functions through `serverContractAdapter`, never the complete
LIVE suite. Do not run old tests to create this fixture: they introduce
conflicts/delete/restore and automatically cleanup. The adapter is separately
gated and budgets at most one request per kind. No default HTTP implementation
is imported or connected by this CLI.

## Definition and journal

Fresh identity `b3-2b-live-fixture-a-<uuid>` is accepted by the existing readonly
preflight convention. Freeze two distinct setup mutation UUIDs, the Article
creation timestamp, template version/digest, and checkpoint 0.20 / paragraph 4.
The fixed title is `Progress LIVE Fixture A`. The fixed UTF-8 body contains
twenty substantial natural paragraphs, no random text or embedded clock.
Content/epoch are not synthesized from browser history. Fingerprint must match
the exact template bytes; epoch comes only from the server.

Journal must live in a private mode-0700 `lingoflow-progress-fixture-*` directory
inside system temp, filename `preparation.json`. Files are mode 0600, strict
allowlisted schema, atomically renamed after fsync. Never store a JWT, session,
Authorization/header, password or service/admin key. The journal includes only
non-secret identity, frozen definition digest/version, safe timestamps, canonical
Article/Progress facts and preparation status. Do not put it in the repo.

Stages: planned → article_created → progress_seeded → local_article_ready →
observation_seeded → ready. Failure records attention/partial and the last
completed stage. Each request is durably marked attempted **before** calling its
helper. Unknown results forbid re-sending or generating another Article.
Restart always SELECT-verifies first. Fully verified existing stages may
continue; contradictory facts fail closed. An attempted request without a
verified completion requires separate operator investigation, not automatic
recovery/retry. A completed journal rerun is verify-only.
An exclusive `.preparation.lock` lease is acquired before reading/generating
identity and held until the run ends. A concurrent run or crash-left lock stops
before IO; do not automatically remove stale locks or create a new journal to
retry an uncertain operation. Resolve it only after operator verification.

Before setup, exact Article/Progress current, changes and receipts must all be
absent. After each setup, exact current and the exact setup receipt must agree,
with exactly one change/receipt per lane. Revisions/cursors/counts are stringified
in SQL, never converted to JS Number. A normal fresh preparation sends at most
one Article put/null-base and one **test-only** Progress absent seed. The Article
and Progress commits are not atomic together. Preserve partial setup; no cleanup.
Current/change history uses the entity identity; setup mutation-ID collision
checks use `(owner_id, mutation_id)` across ALL Articles, matching each receipt
table's primary key. A matching receipt on another Article is a collision, not
absence. Receipt results must still match the exact frozen Article after setup.
Validate a supplied Article ID (including trailing-newline rejection) and gates
before filesystem/lock/journal/CDP/Auth/SQL/network IO. Invalid input performs no IO.

## Local establishment and observation authority

Use already released normal Article Sync to hydrate the exact Article into the
dedicated browser. The harness never calls local createArticle, rewrites a
bootstrap state, creates binding, or fabricates serverReadingContext. If the
existing runtime isn't ready, stop and let normal Article sync/operator resolve
it. LibraryDB v3 and SyncDB v7 must already exist. The separate readonly inspector
verifies owner/binding/generation/scope, Article content hash/bytes and parent
revision/epoch/fingerprint/lifecycle, bootstrap safety, conflicts, pending
mutations/movements/attempts and observation diagnostics.

Immediately before local seed, re-SELECT the server current, validate exact
journal facts, and recheck the same original runtime scope. Seed only a revision
observation with Progress revision, row cursor, parent epoch, fingerprint and
checkpoint. No client clock, max-progress or Article revision substitution.
Only unknown→revision or exact unchanged local baselines are permitted by the
runner. Use the production observation normalizer/monotonic repository writer,
not raw test helper store writes.

`recordProgressRemoteObservation(..., scopeGuard, expectedParent)` adds optional
guards to the existing transaction; default calls retain their original two-store
semantics and function arity. For an explicit expected parent, the transaction
includes Article sidecars, outbox, desired and attempts as well as CONTROL and
observations. It re-reads trusted parent revision/epoch/fingerprint/lifecycle,
diagnostics, bootstrap/conflict/pending state, binding, and unsettled attempts
inside the SAME write transaction. Parent updates sharing those stores must
linearize before validation (blocked) or after observation commit. This is not
an advisory snapshot or a caller-supplied "already verified" boolean.
The optional cancellation
capability from `captureCloudResponseContext(..., callGuard)` checks the actual
private Progress generation, Auth owner, and caller lifetime. It subscribes to
the same invalidator as settlement, including same-owner refresh/relogin and
Account Switch preparation. The native transaction checks every request and
aborts on invalidation even after its last put, before commit. Binding is checked
inside that transaction. The seed holds an existing Library Article/fence/scope
readonly barrier until SyncDB settles, preventing concurrent Library scope edits;
this is an IDB locking boundary, not a cross-DB atomic write claim.

Fresh server verification in `runPreparation` mints a module-private WeakMap
capability tied to frozen exact server facts, owner, binding, Article and pinned
runtime scope. It is single-use, non-cloneable, and revoked on interrupted runs;
it is never journaled. `seedObservation` accepts ONLY that capability. The raw
page operation is module-internal and not exported. There is no public raw-facts
seed or capability factory. Injected inspectors remain explicit trusted IO seams
(deterministic tests inject MOCK facts, not a LIVE server authority).

The pinned Document has a temporary page-side cancellation capability: History
pushState/replaceState/go/back/forward, navigation events, URL/document change,
pagehide/beforeunload cancel before IDB commit through the existing scopeGuard.
Same-URL history changes also invalidate it. This is test tooling installed only
on explicit CDP attachment and removed on detach, not a production global API.
Reload/close/crash/target replacement cannot transfer it to the next Document.
CDP events additionally block later calls; they are not merely a post-write check
that returns blocked after a durable write. No rematching another page. Missing/replaced
binding, scope or generation is NO-GO. Keep already created server data on scope
loss. Detach without closing the user's existing browser/tab. There are no
trace/HAR/video/screenshot/console/request recordings.

Seed changes **only** progressRemoteObservations. It does not alter Resume,
furthest, lastReadAt, desired, pending action, attempt, may-have-sent, settlement,
outbox or runtime cursor. Open the Reader normally later, without simulated
movement. Future client UPDATE requires actual Reader movement and the normal
durable attempt/reservation/dispatch checks; a fixture baseline is not a send
lease (P3).

## Production boundary and accounting

Server contract already permits absent creation. This **test-side seed** does
not enable production client CREATE: repository preparation still rejects create,
transport stays revision-only and default HTTP stays unconfigured. There is no
automatic Progress scheduler/retry/pull/inventory/bootstrap/rollout. Existing
production Article Sync is unchanged. No migration, schema or privilege change.
Setup mutation IDs must never be reused for the later client UPDATE.

Foundation real mutation accounting: Article setup **0**, Progress seed **0**,
authenticated production client UPDATE **0**, production client CREATE **0**.
Future normal fixture accounting is separately 1/1/0/0; preserve it for later
current/change/receipt/replay validation. Cleanup is a separate future stage.

## Deterministic regression only

```sh
npx playwright test --config playwright.progress-fixture.config.js
```

Allowlisted tests only; mock Auth/server/helper requests plus real test-local
IndexedDB. The fixture configuration opts into a shared auto-teardown network
assertion through `progress-strict-test`. The test browser's `newContext` is
wrapped once: original arguments/receiver are forwarded unchanged, and context
routes/listeners are awaited **before** the new context is returned. Existing
contexts, future pages and popups share the same protection. Installation is
idempotent; nested verification transfers accounting ownership instead of
duplicating routes/listeners. Closing a context does not erase its violations.
The wrapper is restored and listeners/routes are released at scope teardown,
including body/installation failures. A context completing creation after its
scope ends is closed, not returned unprotected. Original assertion errors and
network violations are both preserved.

The strict entry point also wraps its browser-type launch/persistent-launch/
connect methods. Existing independent launch and persistent-context paths use
that entry point and are covered. Current allowlisted suites use **zero**
APIRequestContext/request.newContext paths. This guard does not claim coverage
of arbitrary Node HTTP clients or unrelated suites. LIVE CDP adapters retain
their raw Playwright import: deterministic tests attach them only to the already
protected local test context and do not create a new context through those
adapters. Never install this test policy on the user's future LIVE browser.
Each Playwright worker owns its guard state; concurrent scopes on separate
browsers are independently accounted. Ambiguous browser-type scope resolution
fails closed rather than guessing.

Only loopback HTTP port 4173 resources are allowed. Config/SDK and announcement reads
use explicit mock adapters; any other external URL (Article REST, Progress RPC,
Auth or non-Supabase hosts) is counted and aborted, and teardown requires zero
forbidden attempts. Counters retain only structural categories, not raw URLs or
request data. This infrastructure is never installed on production or LIVE IO.
No real credentials are
needed or read by tests. Output lives in `/tmp`, recordings are OFF. Browser
fixtures may initialize mock databases/bootstrap to test boundaries; that is
not a LIVE seed or a production hydration implementation. Preserve first test
failures, investigate them before re-running. Do not claim a real fixture or
LIVE gate passed from deterministic results.
