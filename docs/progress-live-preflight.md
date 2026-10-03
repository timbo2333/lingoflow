# Progress LIVE safety + read-only preflight (B3-3B-2B-2A)

This is **not** the older mutation server-contract suite and does not implement
Progress rollout/bootstrap. Even **GO stops before UPDATE**. Separate human
authorization is required for a future first authenticated UPDATE. A GO is a
point-in-time advisory, not a send lease; dispatch must still use normal durable
attempt preparation and final revalidation.

## Safety boundary

The LIVE command is a Node-only runner. Trace, HAR, video, screenshots, request
recording and credential logging are OFF. It produces only a sanitized stdout
report, no artifacts. Do not run it with `DEBUG`, `NODE_DEBUG` or `PWDEBUG` enabled.
Do not pipe credentials/session/header dumps to the runner. It reads only
`process.env`, never dotenv, shell history, browser tokens or another process's env.

Required account A variables, configured privately in the **same Terminal**:

- `LF_PROGRESS_LIVE_TEST=1` (explicit gate, checked before any network/DB IO)
- `LF_SUPABASE_URL` (must match the existing Project A public URL)
- `LF_SUPABASE_PUBLISHABLE_KEY` (publishable key only)
- `LF_PROGRESS_OWNER_A` and `LF_PROGRESS_JWT_A`
- `LF_PROGRESS_ARTICLE_A` (non-secret exact fixture identity)

`LF_PROGRESS_OWNER_B` and `LF_PROGRESS_JWT_B` are **optional** for this single-A
preflight; they remain necessary for a future Account Switch LIVE gate. Reports
expose presence/missing only, never environment values or the full owner.

## Existing dedicated fixture, not setup

Use a dedicated test account and an **already existing** active <=1 MiB Article
with an already existing Progress current row. Accepted fixture conventions are
`b3-contract-*`, `b3-1-live-*`, `b3-1-browser-*`, `b3-2b-live-*`. Unknown ordinary
Articles are rejected. `--dedicated-test-account` is explicit operator attestation
that both the account and this exact fixture are dedicated, not an automatic
inference from UUID/email. Auth verifies the configured JWT belongs to A; fixed
owner-scoped SQL verifies the Article/Progress belong to that same owner.

Historical test fixtures may have been tombstoned. Do not guess an ID or run
old setup/cleanup to make this command pass. Missing/deleted Article, missing
Progress, untrusted parent, stale/missing local observation => **NO-GO**.

## Read-only local runtime

Use an **already running**, dedicated local HTTP runtime and a dedicated Chrome
profile that you control with a loopback CDP port (for example `9222`). Do not
expose the debugger publicly or use your normal production browser profile.
Prepare/login/open the exact fixture manually *before* this command; that setup
is outside preflight. The command never starts Chrome/server, creates a context,
navigates, scrolls, logs in, or changes data. There must be exactly one existing
tab matching the specified runtime origin/path. Runtime URL flags may not contain
credentials/query/hash; a matching existing tab may have normal app query flags.
CDP attach uses the installed Playwright's `noDefaults:true`: no focus/media
emulation or download-setting overrides. Closing the attached client disconnects
it without closing the existing Chrome/tab (covered by a mock-only CDP test).
One attached page/session is retained throughout preflight. Main-frame navigation,
page close or crash invalidates that session; the runner never rematches another
page to recover or reuse earlier server facts.

Inspection requires existing `LingoFlowSyncDB v7` and `LingoFlowLibraryDB v3`.
Missing/older DBs are not initialized or migrated. Connections are held while
reading to prevent deletion/recreation races. Audited production APIs used:

- `Auth.getState()` (public in-memory owner only, no SDK session read/refresh)
- `captureCloudResponseContext()` (generation + readonly binding validation)
- `getWorkspaceTransition()` (readonly)
- `getProgressContext(..., { initialize:false })` (readonly, no scope/fence creation)
- `getProgressCausalSnapshot()` (readonly SyncDB transaction)

Attempts are read through the existing `byScope` index in a native readonly
transaction. Two local snapshots and generation must agree. No evaluator that
implicitly initializes, repair/reconciliation, observation ingestion, desired,
attempt, may-have-sent, confirmation or cursor writes is used.

After gate/env validation, **before Auth GET or SQL**, a readonly scope-only
baseline captures owner, binding, generation, inactive workspace transition and
the existing Library workspace scope token. It reads no Article/causal data and
creates no control/fence. The same scope is checked again immediately after the
remote stage (before server comparisons), and after local inspection/target
planning immediately before GO. Local inspection must also belong to that
baseline. Changed or unavailable scope returns
`runtime-scope-changed-during-preflight`, without partial success/target facts.

Same-owner logout/relogin and token refresh still invalidate the run because the
existing Auth trust notifications advance generation. Existing Account Switch
preparation advances generation before the durable workspace transition, even
if it later rolls back. Binding/scope-token changes and observed active
transitions fail closed. The baseline is only an ephemeral readiness snapshot;
it is never persisted as an approval or send lease. Cross-tab/DB observations
remain point-in-time checks, not a continuous global lock.

Article parent revision/E/F/lifecycle, local content hash/byte length, safe Article
bootstrap, absence of conflict/pending Article mutation, stable workspace/fence
and existing revision observation/checkpoint must align with server current.
An unresolved local Progress action/call is also NO-GO. Missing causal base is
not repaired. This may be the expected current blocker because Progress Cloud
bootstrap has **not** been implemented.

## Run in your configured Terminal

```sh
cd /Users/jinbo/Desktop/vibecoding/lingoflow
node scripts/progress-live-preflight.js --dedicated-test-account --cdp http://127.0.0.1:9222/ --runtime-url http://127.0.0.1:4173/
```

The runner uses GET `/auth/v1/user`, then `supabase db query --linked --output
json` with a **fixed SELECT only**, after verifying the CLI link is Project A.
No body/title is returned. All revision/cursor bigints are stringified **inside
SQL** as `revision:N` / `cursor:N`, validated through PostgreSQL bigint max without
Number conversion. The existing pure CLI parser supports only the two observed
shapes (array rows / envelope.rows), exactly one object `state`; unknown output
fails closed. CLI stderr/stdout errors never enter the report.

Exit `0`: GO advisory, **STOP**. Exit `2`: NO-GO. Auth/SQL/runtime failures report
safe stage codes, not raw errors. Environment/fixture NO-GO is not a new protocol
finding. Do not send secrets or raw CLI/browser output to chat.

## Target and future seam

Only after every readiness check passes, the planner uses existing Reader
paragraph/scroll geometry and restored session baseline to propose a reachable
destination at least 0.10 beyond server/current/baseline progress and <=0.85.
Near-end/short/unopened fixtures are NO-GO rather than epsilon updates. The runner
does **not** move the Reader or manufacture checkpoint/action/request values.
Next round must use actual Reader movement and resulting durable provenance.

Future explicit test-only injection seam remains the existing
`LingoFlowProgressLocalDesired.createCloudDispatcher({ fetchImpl })`, followed
by identity-only dispatch through normal preparation/reservation/revalidation.
This runner deliberately neither creates nor calls that dispatcher. Production
`index.html`, real HTTP adapter wiring, flags and automatic dispatch remain unchanged.

## Deterministic validation only

```sh
npx playwright test --config playwright.progress-preflight.config.js tests/progress-live-preflight.spec.js
```

This dedicated config allowlists safety/preflight plus the required deterministic
transport/recovery/Auth/account-switch/Article-context regressions, disables all recordings
and puts transient test output under `/tmp`. Tests use noncredential sentinels,
mocked Auth/SQL, mutation traps and real **test-local** IndexedDB/Reader geometry.
Fixture setup writes in deterministic tests are not LIVE preflight setup. The
LIVE runner has no setup/cleanup/mutation/pull/inventory capability. No actual
Progress or Article mutation is authorized by this stage.

Known carry-forward: cross-DB coverage is point-in-time advisory (P3), not a send
lease. Old owner/new binding confirmed-desired re-claim remains a separate future
Progress Cloud/bootstrap blocker, not solved by this harness.

## First regression observations retained

The first 250-test combination had three failures (247 passed): the existing
title-only Article context test returned `parent-bootstrap-unsafe`, and two Auth
UI tests did not reach their intended assertions. The Article case passed an
isolated rerun. Readonly Auth diagnostics proved that initial modal rAF focus
redirected password fill into the email field; the mock sign-in was never called.
This is not evidence of a new protocol failure or proof that all baseline behavior
is flawless. Only test fixtures were corrected: await modal initialization/focus,
and reuse the existing automatic Article worker isolation for synthetic context
fixtures. Production code and test assertions are unchanged. First error contexts
remain under `/tmp/lingoflow-progress-preflight-test-results`; isolated rerun
contexts under `/tmp/lingoflow-progress-preflight-isolated-results`. Do not combine
rerun/diagnostic counts with the final combination count.
