# Progress Cloud server contract (B3-1)

This is a server-only contract. No browser Progress push, pull, bootstrap,
remote apply, or production rollout is enabled by this phase.

## Parent Article reading context

`readingEpoch` is a server-generated opaque UUID. It changes when Article
content changes, on soft-delete, and on explicit restore. Metadata-only edits
retain it. A→B→A content changes do not revive an old epoch. The server also
maintains `contentFingerprint = sha256:<lowercase hex>` over the exact UTF-8
bytes of Article `content` (and no other fields). Neither value is accepted
from an Article client mutation.

The existing Article push, pull, and snapshot RPC signatures remain unchanged.
Successful Article push results, pull changes, and snapshots add these two
top-level fields; they are **not** inserted into the Article projection. Old
client parsers can ignore them. A replayed Article receipt obtains the epoch
from its original change cursor, not the current Article row.

Historical Article changes were backfilled in per-Article cursor order. This
changes no Article projection, revision, cursor, or mutation receipt.

## Progress push

`lingoflow_progress_sync_push(p_expected_owner_id uuid, p_mutation jsonb)` is
authenticated only. `auth.uid()` is the owner authority; the expected owner is
only a consistency check. The mutation has exactly these keys:

```json
{
  "mutationId": "stable cloud attempt ID",
  "articleId": "existing cloud Article ID",
  "expectedState": "absent",
  "expectedProgressRevision": null,
  "parentReadingEpoch": "server Article epoch UUID",
  "contentFingerprint": "sha256:<64 lowercase hex>",
  "progress": 0.3,
  "paragraphIndex": 3
}
```

For an existing Progress row, use `expectedState: "revision"` and
`expectedProgressRevision: "revision:N"`. `absent` must come from a completed
remote observation; `unknown` is not a legal push state. The RPC checks actual
absence/revision under the owner lock. A local B2 actionId or localSeq must
never be used as the cloud mutationId.

The parent must exist, be active, have the supplied epoch, and have the
server-computed fingerprint. A valid revision CAS may replace an old-epoch
Progress row after an Article edit/restore; old-epoch state is not a separate
tombstone. A concurrent update still wins through CAS. Lower progress is a
valid update; neither progress nor timestamps determine conflict order.

Success is `applied` with a new per-Article Progress revision and a new
owner-scoped change cursor, or `unchanged` for an identical valid-CAS payload.
`unchanged` keeps revision/cursor and writes only a success receipt. Retrying a
successful mutationId with the same PostgreSQL `jsonb::text` request
representation returns the same receipt result. This is byte-stable for the
same parsed JSONB value, but **not** semantic numeric canonicalization:
`0.30` and `0.3` compare equal as JSONB numbers yet retain different numeric
scale in `jsonb::text` and produce different request hashes. A retry must
reuse the same serialized numeric representation; future clients must not
silently reformat a pending mutation. Reusing an ID with a different hash returns
`mutation-id-reuse`. Rejected/conflicting attempts write no Progress current
row, revision, change, or success receipt, so a corrected attempt may reuse a
previously failed ID.

## Pull and inventory

`lingoflow_progress_sync_pull(owner, afterCursor, limit)` returns ordered
historical Progress changes. Cursor is owner-scoped change order, **not** a
Progress row revision. Default page size is 10; hard maximum is 25.

`lingoflow_progress_sync_inventory(owner, afterArticleId, highWaterCursor,
limit)` scans current rows by Article ID. First page uses both cursor and
article ID `null`; later pages pass back both returned values. The first page
captures a fixed owner high-water. Rows changed during the scan may disappear
from that inventory snapshot; incremental pull starting at `highWaterCursor`
recovers them. This is for a one-time bootstrap, not every startup.

Progress has no independent delete/restore. An Article tombstone leaves old
Progress as historical observation only. Future clients must check the parent
Article lifecycle, epoch, and fingerprint before applying any checkpoint.

## Security and rollout boundary

Direct table and sequence privileges are revoked from `anon` and
`authenticated`; RLS is enabled; only authenticated RPC execution is granted.
The server serializes Article and Progress mutation commits using the same
per-owner advisory lock. Current row revision and change-log cursor are
separate. `serverUpdatedAt` is diagnostic only, never ordering authority.

This contract does not claim that existing B2 desired records have a trusted
remote base or parent epoch. Old binding re-claim, client causal state,
bootstrap, scheduler, and conflict UI remain future rollout gates.

## Repeatable B3-1 gate

`tests/progress-cloud-server-contract.spec.js` verifies the static privilege
boundary, additive Article parser fields, and exact UTF-8 fingerprints in a
browser. Its fixtures distinguish CRLF from LF, composed from decomposed
Unicode, and preserve spaces and a trailing newline. The expected digests were
cross-checked against PostgreSQL SHA-256 of the same UTF-8 bytes.

`tests/progress-cloud-server-contract-live.spec.js` is opt-in. Set
`LF_PROGRESS_LIVE_TEST=1`, `LF_SUPABASE_URL`,
`LF_SUPABASE_PUBLISHABLE_KEY`, `LF_PROGRESS_OWNER_A`, and
`LF_PROGRESS_JWT_A` in the local process environment; add
`LF_PROGRESS_OWNER_B` and `LF_PROGRESS_JWT_B` for the distinct-owner test.
Never paste a JWT into a report or commit it. The suite uses authenticated
HTTP RPC and a separate read-only linked-database inspection to compare
current rows, changes, and receipts before and after failures. Every generated
Article ID begins with `b3-contract-`; cleanup soft-deletes only those exact
test Articles. Run the LIVE suite with one worker and dedicated test accounts.
When credentials or linked-database inspection are unavailable, record a skip
or environment blocker rather than claiming the LIVE gate passed.

The current server contract test does not establish a 1,000+ row scale
baseline. That remains a separate rollout gate, not implied by the bounded
pagination tests here.
