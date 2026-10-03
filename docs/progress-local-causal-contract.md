# B3-2 client causal repository

B3-2A provides the local causal core; B3-2B propagates authoritative Article
server reading context through the existing Article pipeline. Together they
perform no Progress HTTP/RPC, remote apply, bootstrap, scheduling, or rollout.
No Supabase migration, Backup schema, Article projection or LibraryDB version changes.

## Storage and authority

SyncDB v6 adds `progressRemoteObservations`, keyed by
`[ownerId, bindingId, articleId]`. Upgrade creates only the store; B2 records
are not rewritten. LibraryDB remains v3. Existing Favorite and Article state
is retained. Workspace replacement deliberately does not clear either Progress
store. Every normal observation/context/causal snapshot operation validates the
current binding inside its transaction. Old binding reclaim remains deferred.

Observation facts (no timestamps or whole RPC responses):

- Missing record: `{kind: "unknown"}` (not absence).
- Absent: `{kind: "absent", evidence: {kind: "completed-inventory-catchup",
  highWaterCursor, throughCursor}}`; both cursors use `cursor:N`, through >= high.
- Revision: `{kind: "revision", revision: "revision:N", cursor: "cursor:N",
  parentReadingEpoch, contentFingerprint, checkpoint: {progress, paragraphIndex}}`.

`recordProgressRemoteObservation(ownerId, bindingId, articleId, fact)` accepts
strictly validated facts, not empty pages, unknown, timeout or arbitrary RPC
envelopes. **The evidence shape alone cannot prove a completed inventory.**
This API is a trusted internal ingestion seam; only explicit test fixtures call
it in B3-2A. Future bootstrap must establish completion before invoking it.
`getProgressRemoteObservation` returns explicit unknown; `listProgressRemoteObservations`
lists only the current binding. Neither writes desired.

Rules: lower revisions are stale; equal revisions must have identical cursor,
epoch, fingerprint and checkpoint; newer revision requires a greater cursor.
Inconsistency preserves the old fact and stores a reason-only diagnostic in the
same observation record. This blocks candidate readiness until a strictly newer
valid fact is recorded. Equal replay does not erase the diagnostic. Stronger absent
evidence may replace older absent evidence only when both boundaries do not regress.
A revision following absence must be beyond its completed through cursor.
Progress has no delete: no absent evidence, even with a later boundary, may erase
an observed revision; that contradiction is diagnosed.

## Parent context

Optional `articleSidecars.serverReadingContext` contains exactly:
`{articleRevision, readingEpoch, contentFingerprint, lifecycle}`.
Epoch is the server UUID; content fingerprint is `sha256:<hex>` of body UTF-8.
It is **not** `lastSyncedFingerprint`, the Article projection hash, nor any local
fence token/revision. `recordArticleServerReadingContext` requires existing cloud
identity and current scope. It preserves all other sidecar fields and does not
acknowledge Article mutations. Context revision must not precede knownRevision
or the previous context. Same-revision contradictions, or changed content/lifecycle
without a new epoch, preserve the fact with a durable diagnostic. The getter
returns null for missing/invalid context. Missing context fails closed.
The B3-2B Article parser accepts a complete server-returned epoch and body
fingerprint from a successful push receipt, pull change or snapshot. Push and
pull lifecycle comes from the confirmed operation/projection; snapshot has an
explicit lifecycle. The context is written with the Article revision in the
same SyncDB settlement/bind transaction. Conflict snapshots may record a newer
observed context independently, but it is not trusted until the corresponding
Article revision is bound. Article sidecar rebinding and conflict-resolution
writes preserve this optional metadata when an older response omits the
additive fields. A retained context whose `articleRevision` differs from
`knownRevision` stays durable but is not trusted until fresh server context is
recorded. Partial responses never splice fields from older facts or local data.
No Article path writes a Progress absence observation.
Article revision proves context freshness; it is not Progress generation
equality authority. `readingEpoch` prevents an A→B→A body reversion from
reviving a desired frozen against the first A generation.

## Frozen action base

`pending.causalBase` is the complete normalized observation fact plus
`parent: null | serverReadingContext`. A confirmed record receives exactly that
base. Missing B2 base is exposed as `{kind: "unanchored", parent: null}` on reads,
not rewritten in storage. B2 recovery remains unanchored. Explicit malformed
bases are isolated, never interpreted as absence.

Prepare is the linearization point: one readwrite transaction includes `control`,
`progressDesired`, `progressRemoteObservations`, `articleSidecars`. It checks binding,
reads both complete facts, freezes base, allocates localSeq and writes pending.
No crypto or network awaits occur inside this transaction. Retry, promotion and
reconciliation never reread observations to replace a base. Observation updates
cannot access the desired store. Only a new genuine movement captures a new base.
Forward and backward coalescing remain latest-action-wins.

This gives a coherent **durable transaction snapshot**, not a claim that two
independent ingestion calls represent a single server event. If a future caller
publishes correlated facts atomically, prepare sees the entire old or new pair.
Separately committed old Progress/new Article context is legitimate: it is the
epoch-replacement case below, not a torn read. A cross-store transaction fixture
tests both serialization orders.

## Local candidate evaluation

`LingoFlowProgressCausalState.evaluate(snapshot)` is pure.
`LingoFlowProgressLocalDesired.evaluateCloudCandidate(ownerId, bindingId, articleId)`
collects a binding-checked SyncDB snapshot and a read-only LibraryDB context,
hashes current content outside transactions, then rereads both and checks auth /
generation. Concurrent change returns `state-changed`; it never initializes scope
or fence. This is an advisory local evaluation, **not a durable send lease**.
B3-3 must revalidate gates when preparing a real cloud attempt.

Ready requires: current confirmed owner/binding, no Library workspace transition,
confirmed desired, no pending movement, matching current Resume/fence/scope,
anchored base matching current observation, no observation/context anomaly,
established Article identity, trusted parent context, active/cloud-size-eligible
Article, completed safe Article bootstrap, no target Article issue or unresolved
mutation/incoming apply, compatible frozen parent epoch and body fingerprint.

Results are `{status: "ready", mode: "create" | "update"}` or
`{status: "not-ready", reason}`. Reasons include `unanchored`, `unknown-base`,
`stale-base`, `parent-epoch-mismatch`, `fingerprint-mismatch`, parent pending/conflict/
bootstrap/local-only gates. They are computed, not stored authority.

Title-only Article revision advance with unchanged epoch/body does not invalidate
a frozen action. Progress revision R/E1 plus current Article E2 can yield ready
update for a **new E2 movement** with base R and frozen parent E2. The observation's
old epoch is not compared to current parent as a blanket blocker. An old action
frozen against E1 remains blocked.

Anonymous movement stays local-only. Import, legacy Resume, open/restore, ordinary
reading writes and later login never synthesize desired or observation. Reading-only
writes retain the B2 zero Article mutation/outbox/push boundary. No own-success
predecessor chain, rebase API or cloud attempt fields are introduced.

## Durable cloud attempt dispatch boundary (B3-3B-1)

The local `progressCloudAttempts` store remains in SyncDB v7. Its states are
`awaiting_postflight`, `prepared`, `may_have_sent`, `blocked_before_dispatch`,
and `superseded`. A frozen UPDATE request is immutable across every state.
`prepared` is **not** send authorization: a caller must explicitly recover an
awaiting postflight or reserve a prepared attempt before any future transport.

`resumeCloudAttemptPostflight` rereads LibraryDB and completes the original
awaiting attempt through a binding-checked SyncDB transaction. It never creates
a replacement request and never skips directly to `may_have_sent`. Concurrent
recovery returns the same prepared result or preserves a blocked result; no
wall-clock lease or orphan timeout is used.

`reserveCloudAttemptForDispatch` rereads the Article, Resume, fence, lifecycle,
scope, fingerprint, and cloud-size eligibility. Its SyncDB transaction then
revalidates binding, desired sequence/pending state, observation, Article parent
context, bootstrap, conflicts and Article outbox. A newer pending movement
defers; a newer confirmed movement supersedes the old prepared attempt. A
stale local or causal fact blocks dispatch. Only after the `prepared` →
`may_have_sent` transaction commits does the API return a frozen copy of its
durable request.

`may_have_sent` means the client **cannot prove the server has not seen the
mutation**. It does not mean sent, uploaded, synced, acknowledged, or successful.
It cannot be superseded or rewritten, and blocks a second attempt in its scope.
Future retry or recovery must reuse the same mutation ID and byte-equivalent
immutable request; this slice implements neither network transport nor result
settlement. Reader movement remains free to create a newer local desired while
an older attempt is `may_have_sent`.

The LibraryDB and SyncDB checks are not a cross-database lock. A local-only
Resume write in the narrow gap after the final LibraryDB read can leave a newer
local position without a corresponding desired while an older request becomes
`may_have_sent`. The newer Resume is preserved; the cloud may lag it until a
later real action. Future settlement/rollout must not equate this reservation
with the latest local position being synced.

## Validation

`progress-causal-state.spec.js` covers real IndexedDB transactions, fixtures,
recovery, monotonic guards, scoped APIs and dynamic evaluation; it aborts external
requests and asserts zero Article/Progress sync RPC attempts. No LIVE credentials
are used. Existing B2 Reader/fence/account-switch tests cover movement provenance,
multi-tab ordering, lifecycle ABA and crash safety. SyncDB upgrade tests verify
populated earlier versions, including B2 desired compatibility without raw rewrite.
