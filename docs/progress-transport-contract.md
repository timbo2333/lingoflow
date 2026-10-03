# Progress one-shot transport foundation (B3-3B-2B-1)

This slice implements injected/mock HTTP only. It does **not** enable Progress
Cloud Sync. No migration, CREATE, worker, retry scheduler, pull, inventory,
bootstrap, UI event caller, or rollout is added.

## Capability and authority

The official coordinator entry is
`LingoFlowProgressLocalDesired.dispatchProgressCloudAttempt(ownerId, bindingId, articleId, attemptId)`.
It is lazy and returns `transport-not-configured`: there is deliberately no
default `window.fetch` implementation in this slice.

An explicit `createCloudDispatcher({ fetchImpl, deadlineMs? })` capability returns
the same four-identity dispatch function. Mock tests inject HTTP here. Caller
payloads are never accepted. The service has no arbitrary-mutation POST API or
IndexedDB writes; the repository has no HTTP. No automatic production caller
invokes either dispatch entry.

Reserve and dispatch are distinct: the caller first explicitly reserves a
prepared attempt into durable `may_have_sent`. Dispatch never reserves it.
`prepareProgressCloudDispatch` is read-only and checks authenticated owner,
current binding, workspace transition, strict attempt/provenance, UPDATE-only
request and unresolved scope occupancy. It permits `may_have_sent` or eligible
`settlement_attention`; the latter passes `prepareProgressReceiptRecovery` and
its final transactional eligibility check without rewriting the attention.
All other attempt states are refused. A retry reads the original frozen request,
not the newest Resume/desired; no new attempt or mutation ID is minted.

## Wire representation

The private serializer derives only from the validated immutable request. It
checks exact keys and types, revision within PostgreSQL bigint, UPDATE-only
expected state, finite progress 0–1 and integer paragraphIndex 0–2147483647.
Null paragraphIndex, coercion, extra fields, defaults and CREATE fail closed.
There is no persisted wire copy or second payload authority.

Fixed mutation order: mutationId, articleId, expectedState,
expectedProgressRevision, parentReadingEpoch, contentFingerprint, progress,
paragraphIndex. Fixed envelope order: p_expected_owner_id, p_mutation. Values
are not rounded, clamped or normalized. Cloning/reversed insertion order/IDB
reloads serialize identically with the same mutation ID and revision string.

## Auth, cancellation and transactions

Generation is captured synchronously at dispatch entry, before any await.
The durable cloudMutationId is bound at the first validated repository read,
before auth awaits, and must match the final read and response-time read.

Existing verified Auth context establishes the owner. Token and user ID are
then read together from a **single SDK session object**, checked against that
verified owner and synchronous Auth state. The independent getAccessToken API
is not used. Session/token remain call-local memory; none are returned,
persisted or logged.

Every existing `lingoflow:auth-state` trust notification invalidates Progress
generation, including authenticating/session verification after SDK refresh,
session loss and same-user logout/relogin. Account Switch also invalidates it.
Generation is cancellation only, not a sequence, revision, epoch or clock.

The final sendable repository read and synchronous owner/generation/identity
check are followed directly by HTTP, with no intervening await. A late response
rechecks binding, owner, generation and durable attempt/mutation identity before
ordinary settlement. Scope loss drops the response, leaving durable state
unresolved in its original binding.

Settlement rechecks scope after its async local coverage reads and inside its
SyncDB transaction. The transaction captures all queued IDB request completion
events; a changed guard aborts **all** writes, including nested observation or
evidence writes. Active transactions also subscribe to generation/AbortSignal
invalidation, closing the interval between the last request and commit. The
binding is checked in the same transaction that writes settlement. Listeners
are removed on transaction termination. No crypto/network await occurs there.

## Deadline and result semantics

Default deadline is 10 seconds, injectable for deterministic tests. It covers
auth, repository guards, fetch/headers/body and settlement. AbortController,
Promise.race, monotonic deadline checks and a finished-call guard ensure that
an auth/body continuation arriving after return cannot send or settle. Abort
does not prove the server did not execute: it does not rewind or terminalize an
attempt. A call performs at most one HTTP operation; another attempt requires
another explicit invocation with the same durable identity.

Network rejection, timeout, non-2xx other than 401/403, malformed JSON and
unknown parser results are unknown/unresolved. 401/403 or structured
authentication-required are auth-paused/unresolved. Valid responses go through
the existing ProgressCloudResult parser and ordinary repository settlement:
applied/unchanged/idempotent canonical replay, CAS terminal hints, reason-specific
parent evidence and mutation-id-reuse attention. No transport-specific CAS or
recovery settlement is introduced. Newer confirmed/pending/localSeq are protected.
Coverage remains point-in-time advisory (P3), never send authorization.

Duplicate sends from two tabs are allowed with the exact same body/ID. Server
idempotency and local transactional settlement provide correctness, not Web
Locks. Progress dispatch does not mutate Article content/outbox/projection.

## Zero LIVE and next gate

New tests use fake session material and injected HTTP, block external network,
spy on all real Progress endpoint requests and assert zero. They disable the
unrelated Article background worker through its existing injected gate so
fixture capture cannot masquerade as a Progress side effect. Existing Article
runtime/Auth regressions are run separately without that isolation.

Before first authenticated UPDATE: strict review must accept this slice; a
separate explicit LIVE gate must wire actual HTTP, obtain a dedicated already
existing Progress revision and safe owner/binding context, and verify real
authenticated UPDATE/replay/unknown recovery. No CREATE discovery is added here.
Future LIVE browser configuration must use `trace: "off"`, `video: "off"`, no
HAR recording and no credential-bearing request logs. This slice does not load
credentials or execute that gate. The historical old-owner/new-binding reclaim
problem remains deferred before Progress bootstrap/rollout.
