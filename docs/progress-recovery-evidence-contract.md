# Local Progress Recovery Evidence Foundation

This is local protocol plumbing, not Progress Cloud rollout. No Progress
transport, scheduler, inventory, pull or bootstrap is introduced. CREATE and
own-success rebase remain disabled. SyncDB stays at v7 (metadata only).

## Attention and original-request recovery

Identity attention records optionally retain only Boolean ID matches, an
ordered list of mismatched field names, and whether a canonical result was
already accepted. No original response body or credentials are stored.

The pure taxonomy distinguishes settlement uncertainty, protocol identity
conflict, canonical contradiction, local authority contradiction, and scope /
auth contradiction. Legacy ambiguous reason-only records fail closed.

`prepareProgressReceiptRecovery(ownerId, bindingId, articleId, attemptId)` is a
read-only eligibility check. It returns a deeply frozen copy of the original
attempt ID, cloud mutation ID and immutable request, never a new request. It
checks authenticated owner, binding, no workspace transition, strict provenance,
scope occupancy and local observation diagnostic. Its result is not a send
lease; a future transport must recheck the original generation/scope at dispatch.

Only wrong-response-ID uncertainty can currently qualify. Same-ID wrong-payload,
mutation-ID reuse, duplicate canonical contradiction, and observation authority
contradiction remain blocked. Malformed/unknown responses remain `may_have_sent`.
Recovered mock canonical results use the ordinary settlement transaction, which
preserves newer desired/pending and local sequence continuity.

The server's existing push is not a read-only receipt GET: if the receipt does
not exist it may execute the original request. Future transport must serialize
the immutable request identically on every send; numeric JSONB representation
must not be altered. No serialization or send is added here.

## Current Article snapshot evidence

`serverReadingContext` remains exactly the four server fields. Optional sibling
`articleSidecar.serverContextConfirmation` retains scoped observation ID,
confirmation sequence, request event ordinal, current-snapshot source, complete
context and snapshot cursor. The cursor is an associated fact, not a clock.

A scoped control record in the existing `control` store holds monotonic safe
integer counters and at most 32 outstanding request tickets. Tickets are
allocated transactionally **before** an existing snapshot request. Evicting an
abandoned ticket only disqualifies that old response; counters never wrap/reset.

Only `ArticleSyncCloudService.snapshot` creates production evidence, and only
when a captured runtime-generation guard is available. It makes no additional
HTTP request. Snapshot shape, projection fingerprint, binding, ticket and
monotonic Article context are verified before the confirmation transaction.
Same-context new requests can confirm. Duplicate ingestion cannot increment.
Malformed, stale, contradictory or old-scope responses do not confirm.

Historical push receipts, unchanged receipt replay, pull history, bootstrap,
cursor advance, generic sidecar writes, local save, reading movement and Backup
cannot increase the counters. A historical fact can establish Article context
without becoming a current-row confirmation. A context ahead of known Article
revision remains untrusted until normal Article settlement/bind completes.

Counters are local provenance only, never server CAS/revision/epoch authority,
cross-device ordering or a winner rule. A malformed/exhausted counter fails
closed with a fixed diagnostic status. No evidence enters Backup v2.

## Rejection ordering and reason-specific gates

Parent terminal settlement writes the attempt, rejection event ordinal and
confirmation baseline in one SyncDB transaction. A missing old clock yields
`null`; an initialized clock with no confirmations yields `0`. Neither is a
timestamp or a fabricated server fact. Legacy terminal rows without the new
baseline cannot pass a freshness gate.

`parent-not-ready` requires a trusted active current context matching fresh
confirmation, with both confirmation sequence after baseline **and** request
ordinal after rejection. E/F may be identical. Thus:

- Confirmation before rejection belongs to its baseline, so cannot release it.
- Request before rejection / response after rejection cannot release it.
- Request after rejection / response committed after it can release it.

Epoch/fingerprint mismatch requires a legal newer context with a new epoch;
same-context confirmations cannot wash away the contradiction. Normal candidate
validation still checks the local fingerprint and frozen causal base. Deleted
parent additionally requires trusted active restored context and post-rejection
current confirmation. Gate release never rebases old desired or changes a frozen
request. New incompatible context still requires a new real movement.

All evidence is scoped to owner + binding + Article. Account replacement cannot
transfer it; old callbacks recheck generation and binding within the transaction.
Old-binding confirmed-desired re-claim remains deferred. The existing cross-DB
coverage check remains point-in-time advisory (the previously retained P3).

## Strict-review scope protection

The review reproduced stale-generation writes in the two snapshot contradiction
diagnostic branches, not in normal confirmation. Both diagnostic paths now
recheck the captured guard after asynchronous validation/queued reads and abort
if the guard changes during their write. Diagnostics cannot bypass scope safety.
Regression fixtures cover each branch and preserve the first failing traces in
system temp storage; no raw credentials or response dumps enter the repository.

Cross-tab tests overlap actual IndexedDB transactions in all three rejection /
snapshot orderings without Web Locks. Separate checks verify the durable ticket
exists before the existing snapshot fetch, a new identical-context observation
increments once, repeated rejection takes a new baseline, an abandoned ticket
cannot confirm after reload, and a matching historical receipt cannot refresh
an existing proof. Backup testing performs a successful new-Article restore and
checks that imported Resume creates neither Progress desired nor confirmation.

These remain trusted internal ingestion seams, not proof against arbitrary
same-origin script / IndexedDB tampering. The only production caller of the
confirmation writer is the current-snapshot service with its captured guard.
Eligibility is still not dispatch permission: the future transport must define
stable original-request serialization, final owner/binding/generation checks and
the controlled same-ID retry/receipt path before its first authenticated send.
