"use strict";

const { test, expect } = require("@playwright/test");
const {
  config, hasOwnerA, hasOwnerB, id, mutationId, fingerprint, projection,
  articlePush, articleSnapshot, progressPush, progressPull, progressInventory,
  inspect, canonicalNumericRepresentation, cleanup
} = require("./progress-cloud-live-helpers");

// Opt-in, real authenticated PostgREST + read-only Project A state inspection.
// Use dedicated test accounts; never copy credentials into this repository.
test.describe("B3-1 authenticated server contract", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!hasOwnerA,
    "LIVE gate requires LF_PROGRESS_LIVE_TEST=1, Project A publishable URL/key, and owner A JWT/ID.");
  test.setTimeout(600_000);

  const a = config.a;

  test("PostgreSQL numeric JSONB identity is representation-sensitive", async () => {
    const state = await canonicalNumericRepresentation();
    expect(state).toEqual({ equal: true, left: "0.30", right: "0.3",
      hashEqual: false });
  });

  async function create(articleId, content = "B3 contract body") {
    const result = await articlePush(a, articleId, "put", projection(articleId, content));
    expect(result.status).toBe("applied");
    expect(result.contentFingerprint).toBe(fingerprint(content));
    expect(result.readingEpoch).toMatch(/^[0-9a-f-]{36}$/);
    return result;
  }

  function checkpoint(parent, progress = 0.3, paragraphIndex = 3,
      expectedState = "absent", expectedProgressRevision = null) {
    return {
      expectedState, expectedProgressRevision,
      parentReadingEpoch: parent.readingEpoch,
      contentFingerprint: parent.contentFingerprint,
      progress, paragraphIndex
    };
  }

  function simultaneous(left, right) {
    // Both HTTP requests are released through one gate, without awaiting either.
    // The assertions are order-independent because the database owner lock decides
    // which one settles first.
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    const requests = [barrier.then(left), barrier.then(right)];
    release();
    return Promise.all(requests);
  }

  async function rejectedWithoutEffects(articleId, value, reason, key = mutationId(),
      expectedOwner = a.owner) {
    const before = await inspect(a, articleId, key);
    const result = await progressPush(a, articleId, value, key, expectedOwner);
    expect(result.reason).toBe(reason);
    expect(["rejected", "conflict"]).toContain(result.status);
    const after = await inspect(a, articleId, key);
    expect(after).toEqual(before);
    return key;
  }

  test("same mutation ID and same payload race settles exactly once", async () => {
    const articleId = id();
    try {
      const parent = await create(articleId);
      const value = checkpoint(parent);
      const key = mutationId();
      const [left, right] = await simultaneous(
        () => progressPush(a, articleId, value, key),
        () => progressPush(a, articleId, value, key));
      expect(left).toEqual(right);
      expect(left.status).toBe("applied");
      expect(left.revision).toBe("revision:1");
      const state = await inspect(a, articleId, key);
      expect(state.current.revision).toBe(1);
      expect(state.changes).toBe(1);
      expect(state.receipts).toBe(1);
      expect(state.targetReceipt).toBe(1);
      expect(state.targetResult).toEqual(left);
    } finally { await cleanup(a, [articleId]); }
  });

  test("same mutation ID and different payload race rejects the loser", async () => {
    const articleId = id();
    try {
      const parent = await create(articleId);
      const key = mutationId();
      const [left, right] = await simultaneous(
        () => progressPush(a, articleId, checkpoint(parent, 0.2, 2), key),
        () => progressPush(a, articleId, checkpoint(parent, 0.8, 8), key));
      const winner = [left, right].find(result => result.status === "applied");
      const loser = [left, right].find(result => result.reason === "mutation-id-reuse");
      expect(winner).toBeTruthy();
      expect(loser?.status).toBe("rejected");
      const state = await inspect(a, articleId, key);
      expect(state.current.progress).toBe(winner.progress);
      expect(state.current.revision).toBe(1);
      expect(state.changes).toBe(1);
      expect(state.receipts).toBe(1);
      expect(state.targetResult).toEqual(winner);
    } finally { await cleanup(a, [articleId]); }
  });

  test("backward CAS, failure matrix, and corrected failed ID have exact effects", async () => {
    const articleId = id();
    try {
      const parent = await create(articleId);
      const first = await progressPush(a, articleId, checkpoint(parent, 0.8, 8));
      expect(first.status).toBe("applied");
      const second = await progressPush(a, articleId,
        checkpoint(parent, 0.3, 3, "revision", first.revision));
      expect(second.status).toBe("applied");
      expect(second.revision).toBe("revision:2");
      expect((await inspect(a, articleId)).current.progress).toBe(0.3);

      const base = checkpoint(parent, 0.4, 4, "revision", second.revision);
      await rejectedWithoutEffects(articleId,
        { ...base, expectedProgressRevision: first.revision }, "revision-mismatch");
      await rejectedWithoutEffects(articleId,
        { ...base, contentFingerprint: `sha256:${"0".repeat(64)}` }, "fingerprint-mismatch");
      await rejectedWithoutEffects(articleId,
        { ...base, parentReadingEpoch: "00000000-0000-4000-8000-000000000000" },
        "parent-epoch-mismatch");
      await rejectedWithoutEffects(articleId,
        { ...base, progress: 1.1 }, "invalid-checkpoint");
      await rejectedWithoutEffects(articleId, checkpoint(parent), "revision-mismatch");
      await rejectedWithoutEffects(articleId, base, "owner-context-mismatch",
        mutationId(), "00000000-0000-4000-8000-000000000001");

      const successfulKey = mutationId();
      const applied = await progressPush(a, articleId, base, successfulKey);
      expect(applied.status).toBe("applied");
      await rejectedWithoutEffects(articleId, { ...base, progress: 0.5 },
        "mutation-id-reuse", successfulKey);

      const failedKey = await rejectedWithoutEffects(articleId,
        { ...base, expectedProgressRevision: first.revision }, "revision-mismatch");
      const corrected = await progressPush(a, articleId,
        { ...base, expectedProgressRevision: applied.revision }, failedKey);
      expect(corrected.status).toBe("unchanged");
      const after = await inspect(a, articleId, failedKey);
      expect(after.targetReceipt).toBe(1);
      expect(after.targetResult).toEqual(corrected);
      expect(after.current.revision).toBe(3);
      expect(after.changes).toBe(3);
    } finally { await cleanup(a, [articleId]); }
  });

  test("absent/deleted parents reject without current, change, or receipt", async () => {
    const missingId = id();
    const articleId = id();
    try {
      const parent = await create(articleId);
      const value = checkpoint(parent);
      await rejectedWithoutEffects(missingId, value, "parent-not-ready");
      const snapshot = await articleSnapshot(a, articleId);
      const now = new Date().toISOString();
      const deleted = await articlePush(a, articleId, "delete", {
        ...snapshot.projection, deletedAt: now, updatedAt: now
      }, snapshot.revision);
      expect(deleted.status).toBe("applied");
      await rejectedWithoutEffects(articleId, checkpoint(deleted), "article-deleted");
    } finally { await cleanup(a, [articleId]); }
  });

  test("valid no-op writes receipt only; deleted/restored parent still validates", async () => {
    const articleId = id();
    try {
      const parent = await create(articleId);
      const value = checkpoint(parent);
      const initial = await progressPush(a, articleId, value);
      expect(initial.status).toBe("applied");
      const noopValue = checkpoint(parent, 0.3, 3, "revision", initial.revision);
      const before = await inspect(a, articleId);
      const key = mutationId();
      const noop = await progressPush(a, articleId, noopValue, key);
      expect(noop.status).toBe("unchanged");
      const after = await inspect(a, articleId, key);
      expect(after.current).toEqual(before.current);
      expect(after.changes).toBe(before.changes);
      expect(after.latestCursor).toBe(before.latestCursor);
      expect(after.receipts).toBe(before.receipts + 1);
      expect(after.targetReceipt).toBe(1);
      expect(after.targetResult).toEqual(noop);
      expect(await progressPush(a, articleId, noopValue, key)).toEqual(noop);
      expect(await inspect(a, articleId, key)).toEqual(after);
      const anotherNoop = await progressPush(a, articleId, noopValue, mutationId());
      expect(anotherNoop.status).toBe("unchanged");
      const afterAnother = await inspect(a, articleId);
      expect(afterAnother.current).toEqual(after.current);
      expect(afterAnother.changes).toBe(after.changes);
      expect(afterAnother.receipts).toBe(after.receipts + 1);

      const snapshot = await articleSnapshot(a, articleId);
      const now = new Date().toISOString();
      const deleted = await articlePush(a, articleId, "delete", {
        ...snapshot.projection, deletedAt: now, updatedAt: now
      }, snapshot.revision);
      expect(deleted.status).toBe("applied");
      await rejectedWithoutEffects(articleId, noopValue, "article-deleted");
      const restored = await articlePush(a, articleId, "restore", {
        ...snapshot.projection, updatedAt: new Date().toISOString(), deletedAt: null
      }, deleted.revision);
      expect(restored.status).toBe("applied");
      await rejectedWithoutEffects(articleId, noopValue, "parent-epoch-mismatch");
    } finally { await cleanup(a, [articleId]); }
  });

  test("epoch replacement races under CAS and stale epoch cannot return", async () => {
    const articleId = id();
    try {
      const parent = await create(articleId);
      const initial = await progressPush(a, articleId, checkpoint(parent));
      const snapshot = await articleSnapshot(a, articleId);
      const titleValue = { ...snapshot.projection, title: "Metadata only",
        updatedAt: new Date().toISOString() };
      const titleKey = mutationId();
      const titleOnly = await articlePush(a, articleId, "put", titleValue,
        snapshot.revision, titleKey);
      expect(titleOnly.status).toBe("applied");
      expect(titleOnly.readingEpoch).toBe(parent.readingEpoch);
      expect(titleOnly.contentFingerprint).toBe(parent.contentFingerprint);
      const afterTitle = await inspect(a, articleId);
      expect(await articlePush(a, articleId, "put", titleValue,
        snapshot.revision, titleKey)).toEqual(titleOnly);
      expect(await inspect(a, articleId)).toEqual(afterTitle);
      const staleArticle = await articlePush(a, articleId, "put", {
        ...titleValue, title: "Stale metadata"
      }, snapshot.revision);
      expect(staleArticle).toMatchObject({ status: "conflict",
        reason: "revision-mismatch", currentRevision: titleOnly.revision });
      const afterStale = await inspect(a, articleId);
      // Article conflicts retain an idempotency receipt, but must not mutate
      // the current Article, its change log, or the linked Progress state.
      expect(afterStale.article).toEqual(afterTitle.article);
      expect(afterStale.articleChanges).toBe(afterTitle.articleChanges);
      expect(afterStale.articleReceipts).toBe(afterTitle.articleReceipts + 1);
      expect(afterStale.current).toEqual(afterTitle.current);
      expect(afterStale.changes).toBe(afterTitle.changes);
      expect(afterStale.latestCursor).toBe(afterTitle.latestCursor);
      expect(afterStale.receipts).toBe(afterTitle.receipts);
      const edited = await articlePush(a, articleId, "put", {
        ...titleValue, content: "A new Article body", updatedAt: new Date().toISOString()
      }, titleOnly.revision);
      expect(edited.status).toBe("applied");
      expect(edited.readingEpoch).not.toBe(parent.readingEpoch);
      const [left, right] = await simultaneous(
        () => progressPush(a, articleId,
          checkpoint(edited, 0.4, 4, "revision", initial.revision)),
        () => progressPush(a, articleId,
          checkpoint(edited, 0.6, 6, "revision", initial.revision)));
      const winner = [left, right].find(result => result.status === "applied");
      const loser = [left, right].find(result => result.reason === "revision-mismatch");
      expect(winner?.revision).toBe("revision:2");
      expect(loser?.status).toBe("conflict");
      const state = await inspect(a, articleId);
      expect(state.current.epoch).toBe(edited.readingEpoch);
      expect(state.current.progress).toBe(winner.progress);
      expect(state.changes).toBe(2);
      expect(state.receipts).toBe(2);
      await rejectedWithoutEffects(articleId,
        checkpoint(parent, 0.7, 7, "revision", winner.revision),
        "parent-epoch-mismatch");
    } finally { await cleanup(a, [articleId]); }
  });

  test("inventory high-water plus catch-up pull reconstructs current state", async () => {
    const articleIds = ["a", "b", "c", "d", "e"].map(suffix => id(`-${suffix}`));
    try {
      const parents = await Promise.all(articleIds.slice(0, 4).map(articleId => create(articleId)));
      const first = [];
      for (let index = 0; index < 4; index += 1) {
        first.push(await progressPush(a, articleIds[index], checkpoint(parents[index], 0.1, 1)));
        expect(first[index].status).toBe("applied");
      }
      const beforeHighWater = await progressPush(a, articleIds[0],
        checkpoint(parents[0], 0.2, 2, "revision", first[0].revision));
      expect(beforeHighWater.status).toBe("applied");
      const firstPage = await progressInventory(a, null, null, 2);
      expect(firstPage.status).toBe("ready");
      const highWater = firstPage.highWaterCursor;
      expect(BigInt(beforeHighWater.cursor.slice(7)))
        .toBeLessThanOrEqual(BigInt(highWater.slice(7)));
      const afterHighWater = await progressPush(a, articleIds[1],
        checkpoint(parents[1], 0.3, 3, "revision", first[1].revision));
      expect(afterHighWater.status).toBe("applied");
      const parentE = await create(articleIds[4]);
      expect((await progressPush(a, articleIds[4], checkpoint(parentE, 0.5, 5))).status)
        .toBe("applied");
      expect((await progressPush(a, articleIds[3],
        checkpoint(parents[3], 0.4, 4, "revision", first[3].revision))).status)
        .toBe("applied");
      expect(BigInt(afterHighWater.cursor.slice(7)))
        .toBeGreaterThan(BigInt(highWater.slice(7)));

      const observed = new Map(firstPage.rows.map(row => [row.articleId, row]));
      let page = firstPage;
      for (let guard = 0; page.hasMore && guard < 100; guard += 1) {
        page = await progressInventory(a, page.nextArticleId, highWater, 2);
        expect(page.status).toBe("ready");
        expect(page.highWaterCursor).toBe(highWater);
        for (const row of page.rows) observed.set(row.articleId, row);
      }
      expect(page.hasMore).toBe(false);
      // A row updated after H may disappear from the fixed inventory. Catch-up
      // changes, not client timestamps, restore the exact current projection.
      let cursor = highWater;
      for (let guard = 0; guard < 100; guard += 1) {
        const batch = await progressPull(a, cursor, 2);
        expect(batch.status).toBe("ready");
        for (const change of batch.changes) observed.set(change.articleId, change);
        cursor = batch.nextCursor;
        if (!batch.hasMore) break;
        expect(guard).toBeLessThan(99);
      }
      for (const articleId of articleIds) {
        const state = (await inspect(a, articleId)).current;
        const view = observed.get(articleId);
        expect(view).toBeTruthy();
        expect(view.revision).toBe(`revision:${state.revision}`);
        expect(view.cursor).toBe(`cursor:${state.cursor}`);
        expect(view.progress).toBe(state.progress);
      }
    } finally { await cleanup(a, articleIds); }
  });

  test("pull pagination is ordered, repeatable, and has an empty tail", async () => {
    const articleIds = [id(), id(), id()];
    try {
      // Find the current owner tail without assuming an empty production history.
      let baseline = "cursor:0";
      for (let guard = 0; guard < 100; guard += 1) {
        const page = await progressPull(a, baseline, 25);
        expect(page.status).toBe("ready");
        baseline = page.nextCursor;
        if (!page.hasMore) break;
        expect(guard).toBeLessThan(99);
      }
      const parents = await Promise.all(articleIds.map(articleId => create(articleId)));
      const events = [];
      for (let index = 0; index < articleIds.length; index += 1) {
        events.push(await progressPush(a, articleIds[index], checkpoint(parents[index])));
      }
      events.push(await progressPush(a, articleIds[0],
        checkpoint(parents[0], 0.8, 8, "revision", events[0].revision)));
      events.push(await progressPush(a, articleIds[1],
        checkpoint(parents[1], 0.2, 2, "revision", events[1].revision)));
      expect(events.every(event => event.status === "applied")).toBe(true);
      const twoPage = await progressPull(a, baseline, 2);
      expect(twoPage.status).toBe("ready");
      expect(twoPage.changes.length).toBe(2);
      const maxPage = await progressPull(a, baseline, 25);
      expect(maxPage.status).toBe("ready");
      expect(maxPage.changes.map(change => change.cursor))
        .toEqual(events.map(event => event.cursor));
      const collected = [];
      let cursor = baseline;
      for (let guard = 0; guard < 100; guard += 1) {
        const page = await progressPull(a, cursor, 1);
        expect(page.status).toBe("ready");
        expect(page.changes.length).toBeLessThanOrEqual(1);
        expect(await progressPull(a, cursor, 1)).toEqual(page);
        collected.push(...page.changes.filter(change => articleIds.includes(change.articleId)));
        cursor = page.nextCursor;
        if (!page.hasMore) break;
        expect(guard).toBeLessThan(99);
      }
      expect(collected.map(change => change.cursor)).toEqual(events.map(event => event.cursor));
      expect(collected.map(change => change.revision))
        .toEqual(["revision:1", "revision:1", "revision:1", "revision:2", "revision:2"]);
      const tail = await progressPull(a, cursor, 25);
      expect(tail).toMatchObject({ status: "ready", changes: [], nextCursor: cursor,
        hasMore: false });
    } finally { await cleanup(a, articleIds); }
  });

  test("1 MiB Article accepted; 1 MiB+1 rejected without parent side effects", async () => {
    const articleId = id();
    try {
      const accepted = await create(articleId, "x".repeat(1_048_576));
      const key = mutationId();
      const before = await inspect(a, articleId);
      const snapshot = await articleSnapshot(a, articleId);
      const rejected = await articlePush(a, articleId, "put", {
        ...snapshot.projection, content: "x".repeat(1_048_577),
        updatedAt: new Date().toISOString()
      }, accepted.revision, key);
      expect(rejected).toMatchObject({ status: "rejected", reason: "article-too-large" });
      expect(await inspect(a, articleId)).toEqual(before);
      const corrected = await articlePush(a, articleId, "put", {
        ...snapshot.projection, title: "Corrected", updatedAt: new Date().toISOString()
      }, accepted.revision, key);
      expect(corrected.status).toBe("applied");
    } finally { await cleanup(a, [articleId]); }
  });

  test("different authenticated owner cannot observe or mutate A", async () => {
    test.skip(!hasOwnerB, "Owner B isolation requires a second dedicated JWT/owner ID.");
    const b = config.b;
    const articleId = id();
    try {
      const parent = await create(articleId);
      expect((await progressPush(a, articleId, checkpoint(parent))).status).toBe("applied");
      const beforeA = await inspect(a, articleId);
      const beforeB = await inspect(b, articleId);
      expect(beforeB.current).toBeNull();
      let page = await progressInventory(b, null, null, 25);
      for (let guard = 0; guard < 100; guard += 1) {
        expect(page.status).toBe("ready");
        expect(page.rows.map(row => row.articleId)).not.toContain(articleId);
        if (!page.hasMore) break;
        page = await progressInventory(b, page.nextArticleId, page.highWaterCursor, 25);
        expect(guard).toBeLessThan(99);
      }
      let cursor = "cursor:0";
      for (let guard = 0; guard < 100; guard += 1) {
        const batch = await progressPull(b, cursor, 25);
        expect(batch.status).toBe("ready");
        expect(batch.changes.map(change => change.articleId)).not.toContain(articleId);
        cursor = batch.nextCursor;
        if (!batch.hasMore) break;
        expect(guard).toBeLessThan(99);
      }
      expect((await articleSnapshot(b, articleId)).status).toBe("missing");
      expect((await progressPush(b, articleId, checkpoint(parent))).reason)
        .toBe("parent-not-ready");
      expect(await inspect(a, articleId)).toEqual(beforeA);
      expect(await inspect(b, articleId)).toEqual(beforeB);
    } finally { await cleanup(a, [articleId]); }
  });
});
