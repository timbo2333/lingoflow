#!/usr/bin/env node
// Opt-in authenticated HTTP gate for B3-1. Never prints credentials or tokens.
// Required environment: LF_SUPABASE_URL, LF_SUPABASE_PUBLISHABLE_KEY,
// LF_PROGRESS_OWNER_A, LF_PROGRESS_JWT_A, LF_PROGRESS_OWNER_B, LF_PROGRESS_JWT_B.
// Use dedicated test accounts. Only this run's exact Article ID is touched.

const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");

const names = ["LF_SUPABASE_URL", "LF_SUPABASE_PUBLISHABLE_KEY",
  "LF_PROGRESS_OWNER_A", "LF_PROGRESS_JWT_A",
  "LF_PROGRESS_OWNER_B", "LF_PROGRESS_JWT_B"];
if (names.some(name => !process.env[name])) {
  process.stderr.write("B3-1 LIVE gate skipped: dedicated test credentials are not configured.\n");
  process.exit(2);
}

const baseUrl = process.env.LF_SUPABASE_URL.replace(/\/$/, "");
const key = process.env.LF_SUPABASE_PUBLISHABLE_KEY;
const a = { owner: process.env.LF_PROGRESS_OWNER_A, jwt: process.env.LF_PROGRESS_JWT_A };
const b = { owner: process.env.LF_PROGRESS_OWNER_B, jwt: process.env.LF_PROGRESS_JWT_B };
const articleId = `b3-1-live-${randomUUID()}`;
const now = () => new Date().toISOString();
const fingerprint = content => `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
const mutationId = () => `b3-1:${randomUUID()}`;
let checks = 0;
let articleRevision = null;

async function rpc(who, name, body) {
  const response = await fetch(`${baseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${who.jwt}`,
      Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  assert.equal(response.ok, true, `${name}: HTTP ${response.status}`);
  return response.json();
}

async function article(who, operation, projection, baseRevision = articleRevision,
    id = mutationId()) {
  const result = await rpc(who, "lingoflow_article_sync_push", {
    p_expected_owner_id: who.owner,
    p_mutation: { mutationId: id, articleId, operation,
      baseRevision, projection }
  });
  if (["applied", "unchanged"].includes(result.status)) articleRevision = result.revision;
  return result;
}

async function progress(who, options, id = mutationId()) {
  return rpc(who, "lingoflow_progress_sync_push", {
    p_expected_owner_id: who.owner,
    p_mutation: {
      mutationId: id, articleId,
      expectedState: options.expectedState,
      expectedProgressRevision: options.expectedProgressRevision,
      parentReadingEpoch: options.parentReadingEpoch,
      contentFingerprint: options.contentFingerprint,
      progress: options.progress,
      paragraphIndex: options.paragraphIndex
    }
  });
}

function check(label, actual, expected) {
  assert.equal(actual, expected, label);
  checks += 1;
}

async function main() {
  const projection = {
    id: articleId, title: "B3-1 test", content: "A 🌿 中文",
    sourceType: "paste", createdAt: now(), updatedAt: now(), deletedAt: null
  };
  try {
    const created = await article(a, "put", projection, null);
    check("Article create", created.status, "applied");
    const e1 = created.readingEpoch;
    check("server fingerprint", created.contentFingerprint, fingerprint(projection.content));
    assert.match(e1, /^[0-9a-f-]{36}$/);

    let afterArticleId = null;
    let highWaterCursor = null;
    for (;;) {
      const page = await rpc(a, "lingoflow_progress_sync_inventory", {
        p_expected_owner_id: a.owner,
        p_after_article_id: afterArticleId,
        p_high_water_cursor: highWaterCursor,
        p_limit: 25
      });
      check("inventory page", page.status, "ready");
      assert(!page.rows.some(row => row.articleId === articleId),
        "new Article must have an observed-absent Progress row");
      if (!page.hasMore) break;
      afterArticleId = page.nextArticleId;
      highWaterCursor = page.highWaterCursor;
    }
    const first = await progress(a, { expectedState: "absent",
      expectedProgressRevision: null, parentReadingEpoch: e1,
      contentFingerprint: created.contentFingerprint,
      progress: 0.8, paragraphIndex: 8 });
    check("observed-absent create", first.status, "applied");
    check("first revision", first.revision, "revision:1");

    const secondRequest = { expectedState: "revision",
      expectedProgressRevision: first.revision, parentReadingEpoch: e1,
      contentFingerprint: created.contentFingerprint,
      progress: 0.3, paragraphIndex: 3 };
    const secondId = mutationId();
    const second = await progress(a, secondRequest, secondId);
    check("backward CAS update", second.status, "applied");
    check("second revision", second.revision, "revision:2");
    check("idempotent replay", (await progress(a, secondRequest, secondId)).cursor, second.cursor);
    check("mutation ID reuse", (await progress(a,
      { ...secondRequest, progress: 0.4 }, secondId)).reason, "mutation-id-reuse");

    const stale = await progress(a, { ...secondRequest, progress: 0.5 });
    check("stale CAS", stale.status, "conflict");
    const noop = await progress(a, { ...secondRequest,
      expectedProgressRevision: second.revision });
    check("identical no-op", noop.status, "unchanged");
    check("no-op revision stable", noop.revision, second.revision);
    check("no-op cursor stable", noop.cursor, second.cursor);

    const badId = mutationId();
    const badFingerprint = await progress(a, { ...secondRequest,
      expectedProgressRevision: second.revision,
      contentFingerprint: `sha256:${"0".repeat(64)}` }, badId);
    check("fingerprint rejected", badFingerprint.reason, "fingerprint-mismatch");
    const recovered = await progress(a, { ...secondRequest,
      expectedProgressRevision: second.revision }, badId);
    check("failed ID not consumed", recovered.status, "unchanged");
    check("epoch mismatch", (await progress(a, { ...secondRequest,
      expectedProgressRevision: second.revision,
      parentReadingEpoch: randomUUID() })).reason, "parent-epoch-mismatch");
    check("invalid checkpoint", (await progress(a, { ...secondRequest,
      expectedProgressRevision: second.revision, progress: 1.1 })).reason,
    "invalid-checkpoint");
    check("owner B cannot mutate A", (await progress(b, { ...secondRequest,
      expectedProgressRevision: second.revision })).reason, "parent-not-ready");
    check("owner mismatch rejected", (await rpc(b, "lingoflow_progress_sync_pull", {
      p_expected_owner_id: a.owner })).reason, "owner-context-mismatch");

    const titleOnly = await article(a, "put", { ...projection,
      title: "B3-1 renamed", updatedAt: now() });
    check("title-only preserves epoch", titleOnly.readingEpoch, e1);
    const changed = await article(a, "put", { ...projection,
      title: "B3-1 renamed", content: "B", updatedAt: now() });
    check("content edit", changed.status, "applied");
    assert.notEqual(changed.readingEpoch, e1);
    const e2 = changed.readingEpoch;
    const reverted = await article(a, "put", { ...projection,
      title: "B3-1 renamed", content: projection.content, updatedAt: now() });
    assert.notEqual(reverted.readingEpoch, e1);
    assert.notEqual(reverted.readingEpoch, e2);
    checks += 2;

    const replaced = await progress(a, { expectedState: "revision",
      expectedProgressRevision: second.revision,
      parentReadingEpoch: reverted.readingEpoch,
      contentFingerprint: reverted.contentFingerprint,
      progress: 0.6, paragraphIndex: 6 });
    check("epoch replacement", replaced.revision, "revision:3");
    check("concurrent old revision conflicts", (await progress(a, {
      expectedState: "revision", expectedProgressRevision: second.revision,
      parentReadingEpoch: reverted.readingEpoch,
      contentFingerprint: reverted.contentFingerprint,
      progress: 0.7, paragraphIndex: 7 })).status, "conflict");

    const deletedProjection = { ...projection, title: "B3-1 renamed",
      updatedAt: now(), deletedAt: now() };
    const deleted = await article(a, "delete", deletedProjection);
    assert.notEqual(deleted.readingEpoch, reverted.readingEpoch);
    checks += 1;
    check("deleted parent gate", (await progress(a, {
      expectedState: "revision", expectedProgressRevision: replaced.revision,
      parentReadingEpoch: deleted.readingEpoch,
      contentFingerprint: deleted.contentFingerprint,
      progress: 0.7, paragraphIndex: 7 })).reason, "article-deleted");
    const restored = await article(a, "restore", { ...deletedProjection,
      deletedAt: null, updatedAt: now() });
    assert.notEqual(restored.readingEpoch, e1);
    assert.notEqual(restored.readingEpoch, deleted.readingEpoch);
    checks += 2;

    const beforeOversize = await rpc(a, "lingoflow_article_sync_snapshot", {
      p_expected_owner_id: a.owner, p_article_id: articleId
    });
    const oversize = await article(a, "put", { ...beforeOversize.projection,
      content: "x".repeat(1048577), updatedAt: now() }, beforeOversize.revision);
    check("Article hard size limit", oversize.reason, "article-too-large");
    const afterOversize = await rpc(a, "lingoflow_article_sync_snapshot", {
      p_expected_owner_id: a.owner, p_article_id: articleId
    });
    check("oversize revision unchanged", afterOversize.revision, beforeOversize.revision);
    check("oversize epoch unchanged", afterOversize.readingEpoch,
      beforeOversize.readingEpoch);

    const pull = await rpc(a, "lingoflow_progress_sync_pull", {
      p_expected_owner_id: a.owner, p_after_cursor: "cursor:0", p_limit: 1
    });
    check("pull page bounded", pull.changes.length, 1);
    check("pull has more", pull.hasMore, true);
    const pull2 = await rpc(a, "lingoflow_progress_sync_pull", {
      p_expected_owner_id: a.owner, p_after_cursor: pull.nextCursor, p_limit: 25
    });
    check("pull cursor advances", pull2.status, "ready");
    assert(pull2.changes.every(item =>
      BigInt(item.cursor.slice(7)) > BigInt(pull.nextCursor.slice(7))));
    checks += 1;
    const inventory = await rpc(a, "lingoflow_progress_sync_inventory", {
      p_expected_owner_id: a.owner, p_limit: 25
    });
    check("inventory high-water", inventory.status, "ready");
    assert.match(inventory.highWaterCursor, /^cursor:\d+$/);
    checks += 1;
    const bInventory = await rpc(b, "lingoflow_progress_sync_inventory", {
      p_expected_owner_id: b.owner, p_limit: 25
    });
    check("owner B inventory", bInventory.status, "ready");
    assert(!bInventory.rows.some(row => row.articleId === articleId));
    checks += 1;
  } finally {
    // Soft-delete only the exact Article created by this run. Current-state
    // test tombstones remain in the dedicated account's sync history.
    const snapshot = await rpc(a, "lingoflow_article_sync_snapshot", {
      p_expected_owner_id: a.owner, p_article_id: articleId
    });
    if (snapshot.status === "found" && snapshot.lifecycle === "active") {
      const result = await article(a, "delete", {
        ...snapshot.projection, deletedAt: now(), updatedAt: now()
      }, snapshot.revision);
      assert.equal(result.status, "applied", "test Article cleanup");
    }
  }
  process.stdout.write(`B3-1 authenticated HTTP gate: ${checks} checks passed.\n`);
}

main().catch(error => {
  process.stderr.write(`B3-1 authenticated HTTP gate failed: ${error.message}\n`);
  process.exitCode = 1;
});
