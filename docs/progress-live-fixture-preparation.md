# Dedicated Progress fixture preparation — explicit LIVE execution tooling

Stage **B3-3B-2B-2B-1** established the guarded harness. Stage
**B3-3B-2B-2B-2A** wires a test-side execution adapter and deterministic tests.
Implementing/testing this tooling does **not** authorize actual fixture setup.
Importing the module and plain CLI still do not inject real IO, even when all
environment variables exist. **LF_PROGRESS_ARTICLE_A is not prepared by this stage.**

## Actual preparation (separate review and authorization)

Actual stage B3-3B-2B-2B-2 must explicitly authorize the tested IO seams. Require
`LF_PROGRESS_LIVE_TEST=1`, `LF_PROGRESS_FIXTURE_PREPARE=1`, and
`--dedicated-test-account` **and** `--execute-live-fixture`; verify Auth GET owner against the fixed dedicated A
`db4f9c1c-4563-47a9-8649-150a4fb87a6a`. Project URL and linked CLI project must be
Project A (`yebabpjplbgidzwpjhoy`). Account B is not required. Credentials come
only from the same Terminal process environment; never chat, dotenv, artifacts
or another process/session. DEBUG/NODE_DEBUG/PWDEBUG must be absent.

Without an execution/validation mode the CLI stops before IO with
`fixture-transport-not-injected` (or an earlier environment NO-GO):

```sh
node scripts/progress-live-fixture-prepare.js --dedicated-test-account
```

The explicit adapter uses the shared pure `articlePushArgs`, `progressPushArgs`
and `canonicalFixtureResult` through `serverContractAdapter`, never the complete
LIVE suite. Do not run old tests to create this fixture: they introduce
conflicts/delete/restore and automatically cleanup. The adapter is separately
gated and budgets at most one request per kind. The scoped helper factory reuses
the same audited payload builders; it does not replace global fetch/env or copy
the RPC contract. A second adapter-level HTTP counter/allowlist allows only Auth
GET and the two exact frozen setup requests. Redirects and retries are disabled;
Auth is bounded to 15s and setup HTTP to 30s. Unknown outcomes stop, never retry.

The adapter's execution object exposes orchestrated `execute()` only, not
`createIO()`, setup/seed methods or permit factories. The runtime module is a
read-only facade: no prepare/dispatch HTTP methods, and a caller permit checker
is rejected. Mutation-enabled runtime construction, sender installation and the
scoped HTTP helper factory live in the adapter's non-exported module boundary.
Both mutation lanes are private. After durable
attempt marking, each lane re-reads the exact journal under its owned lock,
SELECT-verifies fresh server state, checks the linked project, and finally
captures the original authenticated runtime scope. The shared builder's exact
wire request is frozen into a private WeakMap one-shot permit bound to lane,
owner, Article ID, mutation ID, scope and journal snapshot. A wrong lane/identity,
reused permit or helper that awaits/re-enters cannot send.

Before private page dispatch, a synchronous readonly Node journal check verifies
the owned lock/file inode, private permissions, exact stage/attempt/definition
and snapshot, then consumes the Node permit. Node's cached scope/cancellation
check is a preliminary deny gate, **not** final browser authority. The private
page closure owns the final native runtime guard and `fetch` invocation in one
synchronous execution segment. Both lanes have a maximum of one issued permit
and one invocation (unknown outcomes conservatively consume the budget); a
failed final guard cannot mint another. Node FS and page execution are not a
cross-process atomic transaction. No caller-supplied readiness boolean authorizes
HTTP.

### Page-side send boundary (local deterministic implementation only)

The sender is a private Document-local CDP RemoteObject, not a `window` raw RPC API or
an independently exported Node send API. The orchestrator itself consumes its
private one-shot Node permit; the runtime never trusts a caller authorization
callback.
It receives only the shared builder's exact plain, deeply frozen JSON wire,
SHA-256 digest, lane, fixture identity and public key. Getter/Proxy/toJSON/function/
Symbol inputs are rejected before serialization; request options and fixed
endpoint/header/method are assembled before the final segment. The two lanes
are Article put/null-base and test-only Progress absent seed; no client UPDATE.
The shared pure wire validator checks these exact semantics in Node and again
in page preparation, before RPC invocation, not just after response parsing.

The old late-iframe path is removed: a parent's synchronous iframe load handler
can replace that realm's fetch before capture. There is no iframe fallback.

`openLocalFixtureTestPage` creates an empty context in the isolated headless,
extension-disabled test browser (CDP 19993, loopback only), blocks service workers
and installs exactly one main-world `Page.addScriptToEvaluateOnNewDocument`
script before navigation. The trusted controller must not add other init
scripts. This is a controlled bootstrap contract, NOT an attempt to certify an
arbitrary existing CDP target or an arbitrary extension/init-script environment.
Unknown existing targets have no private registry proof and fail closed.

At the new Document's initial execution, the script binds its initial fetch in
a lexical closure, creates a frozen lexical bridge, then pauses at `debugger`.
The controller verifies the exact installed source (not merely sourceURL), the
top-level frame/URL and default main-world context, and verifies that no HTML
script has yet been parsed. It obtains the bridge's RemoteObject on the paused
call frame BEFORE resume; application inline/defer/module/async/DCL/load code
runs only afterwards. This uses one controlled init script, not ordering among
unknown multiple init scripts. No native-string/descriptor/Symbol/random-global
test determines trust, and no isolated-world transport substitutes for the
production main-world generation authority.

Neither raw fetch nor the bridge/tickets appear on window/globalThis, DOM,
storage or a public module export. Bootstrap exports only a Page and non-sensitive
read-only evidence; the runtime facade still exports ONLY read-only capabilities.
The controller's private registry/RemoteObject is not send permission. The
orchestrator journal and private Node permit remain mandatory. Browser tickets
are frozen opaque objects stored in a private WeakMap and passed by objectId,
never reusable serialized nonces. Once claimed, reload cannot remint a root for
that attempt; the destroyed context invalidates its old objectId. Revocation,
disposal and response loss preserve UNKNOWN/no-retry rules.

Current root activation and Auth/RPC transport are explicitly localhost-only.
It does not attach to or initialize user 9222. Existing LIVE execution commands
below are documentation for a FUTURE separately authorized integration: the
current mutation path cannot trust such an existing browser and returns NO-GO.
Do not interpret local green tests or READY as LIVE permission or a client
UPDATE lease (P3).

The pinned 2.117.2 storage contract is exactly
`sb-yebabpjplbgidzwpjhoy-auth-token`, a top-level persisted session object.
Only native `localStorage.getItem(exactKey)` plus strict JSON parsing is used.
Require nonempty access token, string refresh token, `token_type="bearer"`,
object `user` with a nonempty ID and valid numeric expiry fields. Missing/unknown
shape, denied storage, or another owner fails closed. No key enumeration,
alternate key, memory fallback, SDK `getSession`/refresh, login or storage write.

During async page preparation, browser token T1 is verified with fixed Auth GET
(15s, no redirects). Expected owner, Node Auth GET owner, browser Auth GET owner,
production Auth owner and workspace owner must agree. T1 and its Bearer header
remain only in the ephemeral page closure; Terminal JWT never crosses CDP.
At send, T2 is synchronously re-read and must exactly equal T1. Returned values
are private opaque RemoteObject tickets or safe facts, never
session, tokens, headers, raw response or Article content.

The final authority uses the existing production
`captureCloudResponseContext(...).guard` private generation seam, current
production Auth status/owner, original Document/URL/random lifetime and both
native readonly IDB barriers. SyncDB `control` protects `workspace-binding`;
LibraryDB `progressControl` protects `workspace`, binding/scopeToken and absence
of `workspace-transition`. Each queues a bounded native readonly request while
acquiring the other DB. Competing writers sharing those stores either commit
first and invalidate the facts, or commit after fetch invocation/lock release.
These are two independent transaction locks, **not** cross-DB atomicity.
Abort/error/early completion/deadline invalidates the barrier and sends nothing.

Once both locks and facts are valid, the final page callback reads T2, checks
Document, real private generation and current Auth, then immediately invokes
the pre-document captured native fetch with owned frozen null-prototype
options and headers: no await, Node/CDP round-trip,
Promise continuation or caller hook between guard and invocation. Both readonly
barriers are released as soon as fetch returns its Promise, before awaiting HTTP.
Later logout/switch/token change is allowed: the request is already may-have-sent.

Each lane has one ephemeral, Document-bound, one-shot object ticket. Its page-monotonic
`performance.now()+2000` not-after deadline starts after async preparation;
queued CDP calls arriving late cannot send. The preparation round-trip itself
does not freeze runtime: final guards still revalidate everything. Setup fetch
is bounded to 30s; Node waits at most 32s. Node timeout, detach, lost response or
target destruction is UNKNOWN, not evidence of no-send. Only an affirmative page
no-invocation result proves no-send. Preserve attempted journal, do not retry,
cleanup, mint another mutation ID or allocate a new fixture.

`progress-page-send-boundary.spec.js` uses isolated Chromium/CDP 19993, minimal
real production generation/repositories, fake local Auth/RPC and fake pinned
script metadata (not a new SRI trust claim). Requests now run through the normal
orchestrator and real temp attempted journal; the test only pauses/observes its
already-authorized CDP call, never mints a runtime permit. Main fetch wrapper,
getter/Proxy and native-string spoof tests assert zero wrapper calls while the
pre-document native request succeeds even after the FIRST inline script or
synchronous load handler replaces window.fetch. The removed late-iframe attack
handler is also installed, but the new sender never creates an iframe. Verified
bootstrap evidence covers all page script/event phases; global/DOM/storage
enumeration reveals no raw transport. Read-only bounded marker names prove
final validation → localhost invocation → actual generation invalidation.
Real
separate IDB connections prove writer-first/barrier-first and acquisition races;
tests also withhold Node invalidation notifications, queue actual delayed CDP
evaluation and lose responses after invocation. External requests fail closed.
User 9222/session and real Supabase are not accessed. The independently sealed
PIN tests remain the SDK/SRI trust evidence. Implementation does not authorize LIVE.

## User steps and complete command — DO NOT run during wiring/review

1. Start the existing local server from the repo root:
   `python3 -m http.server 4173 --bind 127.0.0.1`.
2. Use a dedicated Chrome profile (not your everyday profile), with
   `--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1` and a
   separate private `--user-data-dir`. Keep exactly one existing page at
   exactly `http://127.0.0.1:4173/` (no query/hash). Multiple matching tabs fail
   closed. This explicit adapter opts into exact URL selection in the existing
   runtime helper; other callers retain their existing origin/path behavior.
   The runner never creates/navigates/logs in a page.
3. Personally log in the fixed dedicated owner A, confirm the Workspace, and
   allow normal Article bootstrap/runtime to become safe before preparation.
   Do not create test Articles or Reader movement as part of environment setup.
4. Configure the six listed variables privately in that SAME Terminal:
   `LF_PROGRESS_LIVE_TEST`, `LF_PROGRESS_FIXTURE_PREPARE`, `LF_SUPABASE_URL`,
   `LF_SUPABASE_PUBLISHABLE_KEY`, `LF_PROGRESS_OWNER_A`, `LF_PROGRESS_JWT_A`.
   Both gates must be `1`. No Account B credentials, dotenv or secret argv.
5. Only after separate actual-execution approval, use:

```sh
cd /Users/jinbo/Desktop/vibecoding/lingoflow
node scripts/progress-live-fixture-prepare.js \
  --dedicated-test-account \
  --execute-live-fixture \
  --cdp http://127.0.0.1:9222/ \
  --runtime-url http://127.0.0.1:4173/
```

No manual fixture ID or journal path is required. Before the first setup HTTP,
the runner prints a safe `FIXTURE_JOURNALED` event with the frozen ID and private
temp journal path. Preserve that path. A new plain invocation with execution
authorization is a new preparation, **not** recovery: never use it to retry an
uncertain/partial run. For explicitly approved recovery, append
`--journal /absolute/system-temp/lingoflow-progress-fixture-.../preparation.json`.
That file must already exist, be private and non-symlinked; a missing recovery
journal is NO-GO, not permission to create a replacement fixture. Explicit
`--journal` permanently selects recovery mode. The metadata check records file
identity; after acquiring the exact lock, the actual read must still find that
same private regular file and a valid frozen journal. Missing/null/empty/invalid,
moved/replaced/symlinked or identity-mismatched recovery data fails closed;
it never generates a fresh ID or replacement journal. An optional
`--article-id` must match the journal ID or pass the strict fresh UUID convention.

The result is `READY`, `PARTIAL`, or `NO-GO`, with safe revisions/cursors,
checkpoint, stage, journal path and per-invocation HTTP mutation counts. Exit 0
requires READY; failure exits 2 and preserves server data/journal. Setup is at
most Article **1** + Progress seed **1**, client UPDATE/CREATE **0**. READY stops;
next run the separate read-only preflight only after its own authorization.

### Help and optional read-only validation

`--help` is supported and prints usage without environment inspection or any IO.
Unknown/duplicate options and mixed modes fail closed; no JWT/token/header args
are accepted. `--cdp` must be loopback HTTP without credentials/query/hash;
`--runtime-url` must be exactly `http://127.0.0.1:4173/`.

With separate permission for read-only network checks, replace
`--execute-live-fixture` with `--validate-only`. This verifies environment,
linked Project A, existing runtime scope and Auth owner, then rechecks scope.
It returns `VALIDATED` / `fixtureReady:false`, **not** fixture READY. It makes no
setup HTTP, SQL fixture inspection, identity allocation, journal lock/write,
Article inspection or observation write. Journal readiness is metadata-only
(existing explicit recovery file or default writable temp directory); it does
not prove that a crash-left lock/old journal/server state is safe. Execution
still performs the complete locked collision/history checks.

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
it. Existing Article runtime syncs at startup/foreground and polls every 60s
while visible. The adapter only waits up to 75s with readonly 500ms inspection;
it does **not** call syncNow/start/focus/reload or open/scroll Reader. Reload would
invalidate the pinned Document, so absence/unsafe hydration returns PARTIAL.
One monotonic absolute deadline starts at the first hydrate inspection. Every
inspect, scope capture/local readiness read and poll sleep thereafter races the
remaining time; repeated calls do not restart 75s. A hanging operation times out,
invalidates the execution token/runtime, and returns PARTIAL while preserving
the server fixture. Late results cannot refresh authority, seed observations,
return READY or trigger further server mutations. Cancellation precedes bounded
detach cleanup; a hung page cannot keep the orchestration waiting indefinitely.
LibraryDB v3 and SyncDB v7 must already exist. The separate readonly inspector
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
Its original Progress generation guard also subscribes to existing Auth/Account
Switch invalidation. An empty test-only CDP binding notification relays revocation
to Node (never credentials or fixture payloads). The asynchronous scope read
uses that same CDP channel as an additional preflight only. Final mutation
authority no longer depends on notification delivery or Node cached generation:
the page-side synchronous boundary above remains authoritative even if Node has
not received cancellation. Browser/Node are separate processes; Node journal and
page send are not a distributed atomic lease. An invoked request cannot be recalled.
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

Foundation AND adapter-wiring validation real mutation accounting: Article setup **0**, Progress seed **0**,
authenticated production client UPDATE **0**, production client CREATE **0**.
Future separately authorized normal fixture accounting is 1/1/0/0; preserve it for later
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

`progress-live-fixture-adapter.spec.js` additionally traps every uninjected Node
fetch and database CLI call. Real payload builders use an injected fake HTTP
transport, and SQL uses an injected fake executor; all credentials are sentinels.
No actual execution command is run by this stage's validation. Exact per-lane
HTTP budgets, redirect/timeout policy, plain/help/default-off, gates, Project A,
identity, private journal/recovery, fresh capability, partial/unknown outcomes,
delayed/missing hydrate and production UPDATE/CREATE isolation are asserted.
Negative coverage includes linked-project await races in both lanes, immediately
pre-send scope changes, private seam closure, wrong/reused lane/mutation wire,
journal/lock authority loss, explicit-recovery TOCTOU disappearance/replacement,
never-resolving/late inspect and scope calls, hanging sleep, and a shared deadline
across repeated readiness checks. Real-CDP guard cases use only the isolated
mock test browser on port 19993, never the user's dedicated LIVE browser on 9222.
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
