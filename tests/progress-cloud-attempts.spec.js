const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  const requests = [];
  page.on("request", request => {
    if (/\/rpc\/.*progress|\/rest\/v1\/progress/i.test(request.url())) requests.push(request.url().split("?")[0]);
  });
  page.__progressRequests = requests;
  await page.route("https://**/*", route => route.abort());
  await page.addInitScript(() => localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1"));
  await page.goto("/");
  await page.evaluate(async () => {
    const repo = window.LingoFlowSyncStateRepository;
    const lib = window.LingoFlowArticleLibrary;
    const flow = window.LingoFlowProgressLocalDesired;
    const resume = window.LingoFlowReadingResume;
    const binding = { ownerId: "attempt-owner-a", bindingId: "attempt-binding-a" };
    let authOwner = binding.ownerId;
    window.LingoFlowSupabaseAuth = { getState: () => authOwner
      ? { status: "authenticated", user: { id: authOwner } } : { status: "anonymous" } };
    await repo.bindWorkspace(binding);
    const article = await lib.createArticle({ content: "Attempt fixture: first paragraph.\nSecond paragraph." });
    const fp = await resume.fingerprintContent(article.content);
    const epoch = "11111111-2222-4333-8444-555555555555";
    const epoch2 = "22222222-2222-4333-8444-555555555555";
    const args = [binding.ownerId, binding.bindingId, article.id];
    const raw = async (stores, work) => {
      const db = await repo.openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(stores, "readwrite");
        work(tx);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    };
    const setup = async (kind = "revision") => {
      await repo.bindArticleRemoteRevision(...args, "revision:1", "a".repeat(64), "active");
      await repo.recordArticleServerReadingContext(...args, {
        articleRevision: "revision:1", readingEpoch: epoch,
        contentFingerprint: fp, lifecycle: "active"
      });
      const bootstrap = await repo.beginArticleBootstrap(binding.ownerId, binding.bindingId);
      await raw("control", tx => tx.objectStore("control").put({ ...bootstrap.state,
        status: "complete", phase: "complete", finalCursor: "cursor:0",
        pendingCursor: null, pendingHasMore: false, issueCount: 0 }));
      if (kind === "revision") await repo.recordProgressRemoteObservation(...args, {
        kind: "revision", revision: "revision:10", cursor: "cursor:10",
        parentReadingEpoch: epoch, contentFingerprint: fp,
        checkpoint: { progress: 0.2, paragraphIndex: 2 }
      });
      if (kind === "absent") await repo.recordProgressRemoteObservation(...args, {
        kind: "absent", evidence: { kind: "completed-inventory-catchup",
          highWaterCursor: "cursor:10", throughCursor: "cursor:10" }
      });
    };
    const target = (progress, paragraphIndex = Math.round(progress * 10)) =>
      resume.createCheckpoint({ progress, paragraphIndex }, fp);
    const movement = progress => flow.writeRealMovement(article.id, target(progress));
    const prepare = () => flow.prepareCloudAttempt(...args);
    window.h = { repo, lib, flow, resume, binding, article, fp, epoch, epoch2,
      args, raw, setup, target, movement, prepare,
      setAuthOwner: value => { authOwner = value; } };
  });
});

test.afterEach(async ({ page }) => {
  expect(page.__progressRequests, "B3-3A must make zero Progress requests").toEqual([]);
});

test("revision-ready freezes an independent immutable UPDATE attempt", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const candidate = await h.flow.evaluateCloudCandidate(...h.args);
    const prepared = await h.prepare();
    const read = await h.repo.getProgressCloudAttempt(...h.args, prepared.attempt.attemptId);
    return { candidate, prepared, read, desired: await h.repo.getProgressDesired(...h.args),
      syncVersion: (await h.repo.openDatabase()).version,
      libraryVersion: (await h.lib.openDatabase()).version };
  });
  expect(result.candidate).toEqual({ status: "ready", mode: "update" });
  expect(result.prepared.status).toBe("prepared");
  const attempt = result.prepared.attempt;
  expect(attempt.attemptId).toMatch(/^[0-9a-f-]{36}$/);
  expect(attempt.cloudMutationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(attempt.attemptId).not.toBe(attempt.cloudMutationId);
  expect(attempt.cloudMutationId).not.toBe(attempt.sourceActionId);
  expect(attempt.request).toEqual({ mutationId: attempt.cloudMutationId,
    articleId: attempt.articleId, expectedState: "revision", expectedProgressRevision: "revision:10",
    parentReadingEpoch: "11111111-2222-4333-8444-555555555555",
    contentFingerprint: result.prepared.attempt.sourceCheckpoint.contentFingerprint,
    progress: 0.3, paragraphIndex: 3 });
  expect(result.read.attempt).toEqual(attempt);
  expect(result.desired.record).not.toHaveProperty("cloudMutationId");
  expect(result.syncVersion).toBe(7);
  expect(result.libraryVersion).toBe(3);
});

test("reload preserves IDs, source provenance and exact request representation", async ({ page }) => {
  const before = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    return (await h.prepare()).attempt;
  });
  await page.reload();
  const after = await page.evaluate(async attempt => {
    const repo = window.LingoFlowSyncStateRepository;
    const bound = await repo.getWorkspaceBinding();
    return repo.getProgressCloudAttempt(bound.binding.ownerId, bound.binding.bindingId,
      attempt.articleId, attempt.attemptId);
  }, before);
  expect(after.status).toBe("ready");
  expect(after.attempt).toEqual(before);
  expect(JSON.stringify(after.attempt.request)).toBe(JSON.stringify(before.request));
});

test("crash before Library postflight leaves a durable non-dispatchable proposal", async ({ page }) => {
  const frozen = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const context = await h.lib.getProgressContext(h.article.id, h.binding, { initialize: false });
    const result = await h.repo.prepareProgressCloudAttempt(...h.args, {
      scope: context.scope, fence: context.fence, checkpoint: context.article.reading.resume,
      fingerprint: h.fp, articleActive: true, cloudEligible: true, transitionInactive: true
    });
    return result.attempt;
  });
  expect(frozen.status).toBe("awaiting_postflight");
  await page.reload();
  const persisted = await page.evaluate(async attempt => {
    const repo = window.LingoFlowSyncStateRepository;
    return repo.getProgressCloudAttempt(attempt.ownerId, attempt.bindingId,
      attempt.articleId, attempt.attemptId);
  }, frozen);
  expect(persisted.status).toBe("ready");
  expect(persisted.attempt).toEqual(frozen);
  expect(persisted.attempt.status).not.toBe("prepared");
  const resumed = await page.evaluate(async attempt => {
    window.LingoFlowSupabaseAuth = { getState: () => ({ status: "authenticated",
      user: { id: attempt.ownerId } }) };
    const existing = await window.LingoFlowProgressLocalDesired.prepareCloudAttempt(
      attempt.ownerId, attempt.bindingId, attempt.articleId);
    // Recovery is explicit: another tab might still be completing postflight.
    const blocked = await window.LingoFlowSyncStateRepository.blockPreparedProgressCloudAttempt(
      attempt.ownerId, attempt.bindingId, attempt.articleId, attempt.attemptId,
      "interrupted-postflight");
    const next = await window.LingoFlowProgressLocalDesired.prepareCloudAttempt(
      attempt.ownerId, attempt.bindingId, attempt.articleId);
    const old = await window.LingoFlowSyncStateRepository.getProgressCloudAttempt(
      attempt.ownerId, attempt.bindingId, attempt.articleId, attempt.attemptId);
    return { existing, blocked, next, old };
  }, frozen);
  expect(resumed.existing.status).toBe("existing-attempt");
  expect(resumed.blocked.status).toBe("blocked_before_dispatch");
  expect(resumed.next.status).toBe("prepared");
  expect(resumed.next.attempt.cloudMutationId).not.toBe(frozen.cloudMutationId);
  expect(resumed.old.attempt.status).toBe("blocked_before_dispatch");
  expect(resumed.old.attempt.reason).toBe("interrupted-postflight");
});

test("another tab cannot replace an awaiting attempt while its creator completes postflight", async ({ page }) => {
  const frozen = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const context = await h.lib.getProgressContext(h.article.id, h.binding, { initialize: false });
    const local = { scope: context.scope, fence: context.fence,
      checkpoint: context.article.reading.resume, fingerprint: h.fp,
      articleActive: true, cloudEligible: true, transitionInactive: true };
    const result = await h.repo.prepareProgressCloudAttempt(...h.args, local);
    return { attempt: result.attempt, local };
  });
  const second = await page.context().newPage();
  try {
    await second.goto("/");
    const other = await second.evaluate(async attempt => {
      window.LingoFlowSupabaseAuth = { getState: () => ({ status: "authenticated",
        user: { id: attempt.ownerId } }) };
      return window.LingoFlowProgressLocalDesired.prepareCloudAttempt(
        attempt.ownerId, attempt.bindingId, attempt.articleId);
    }, frozen.attempt);
    const final = await page.evaluate(async frozen => {
      const confirmed = await h.repo.confirmProgressCloudAttempt(...h.args,
        frozen.attempt.attemptId, frozen.local);
      const all = await h.repo.listProgressCloudAttempts(...h.args);
      return { confirmed, all };
    }, frozen);
    expect(other.status).toBe("existing-attempt");
    expect(other.attempt).toEqual(frozen.attempt);
    expect(final.confirmed.status).toBe("prepared");
    expect(final.all.attempts).toHaveLength(1);
    expect(final.all.attempts[0].request).toEqual(frozen.attempt.request);
  } finally { await second.close(); }
});

test("final transition rejects an observation advance after local postflight", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const context = await h.lib.getProgressContext(h.article.id, h.binding, { initialize: false });
    const local = { scope: context.scope, fence: context.fence,
      checkpoint: context.article.reading.resume, fingerprint: h.fp,
      articleActive: true, cloudEligible: true, transitionInactive: true };
    const frozen = await h.repo.prepareProgressCloudAttempt(...h.args, local);
    await h.repo.recordProgressRemoteObservation(...h.args, {
      kind: "revision", revision: "revision:11", cursor: "cursor:11",
      parentReadingEpoch: h.epoch, contentFingerprint: h.fp,
      checkpoint: { progress: 0.2, paragraphIndex: 2 }
    });
    const confirmed = await h.repo.confirmProgressCloudAttempt(...h.args,
      frozen.attempt.attemptId, local);
    const persisted = await h.repo.getProgressCloudAttempt(...h.args, frozen.attempt.attemptId);
    return { frozen, confirmed, persisted };
  });
  expect(result.frozen.status).toBe("awaiting-postflight");
  expect(result.confirmed.status).toBe("not-ready");
  expect(result.persisted.attempt.status).toBe("blocked_before_dispatch");
  expect(result.persisted.attempt.request.expectedProgressRevision).toBe("revision:10");
});

test("old owner cannot finalize awaiting attempt after binding replacement", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const context = await h.lib.getProgressContext(h.article.id, h.binding, { initialize: false });
    const local = { scope: context.scope, fence: context.fence,
      checkpoint: context.article.reading.resume, fingerprint: h.fp,
      articleActive: true, cloudEligible: true, transitionInactive: true };
    const frozen = await h.repo.prepareProgressCloudAttempt(...h.args, local);
    const other = { ownerId: "attempt-owner-b", bindingId: "attempt-binding-b" };
    await h.repo.replaceWorkspaceBinding({ from: h.binding, to: other,
      accountLabel: "b@example.test" });
    const confirmed = await h.repo.confirmProgressCloudAttempt(...h.args,
      frozen.attempt.attemptId, local);
    const db = await h.repo.openDatabase();
    const stored = await new Promise(resolve => {
      const request = db.transaction("progressCloudAttempts").objectStore("progressCloudAttempts")
        .get([...h.args, frozen.attempt.attemptId]);
      request.onsuccess = () => resolve(request.result);
    });
    return { frozen, confirmed, stored };
  });
  expect(result.frozen.status).toBe("awaiting-postflight");
  expect(result.confirmed.status).toBe("not-ready");
  expect(result.stored.status).toBe("blocked_before_dispatch");
  expect(result.stored.reason).toBe("workspace-replaced");
});

for (const change of ["observation", "epoch", "pending", "outbox", "transition"]) {
  test(`stale advisory candidate cannot prepare after ${change} changes`, async ({ page }) => {
    const result = await page.evaluate(async change => {
      await h.setup(); await h.movement(0.3);
      const advisory = await h.flow.evaluateCloudCandidate(...h.args);
      if (change === "observation") await h.repo.recordProgressRemoteObservation(...h.args, {
        kind: "revision", revision: "revision:11", cursor: "cursor:11",
        parentReadingEpoch: h.epoch, contentFingerprint: h.fp,
        checkpoint: { progress: 0.2, paragraphIndex: 2 }
      });
      if (change === "epoch") {
        await h.raw("articleSidecars", tx => {
          const store = tx.objectStore("articleSidecars");
          const request = store.get([h.binding.ownerId, h.article.id]);
          request.onsuccess = () => store.put({ ...request.result, knownRevision: "revision:2",
            serverReadingContext: { articleRevision: "revision:2", readingEpoch: h.epoch2,
              contentFingerprint: h.fp, lifecycle: "active" } });
        });
      }
      if (change === "pending") {
        const context = await h.lib.getProgressContext(h.article.id, h.binding);
        await h.repo.prepareProgressMovement({ ...h.binding, articleId: h.article.id,
          target: h.target(0.4), beforeResume: context.article.reading.resume,
          articleFence: context.fence, scope: context.scope });
      }
      if (change === "outbox") await h.raw("articleOutbox", tx => tx.objectStore("articleOutbox")
        .put({ ...h.binding, articleId: h.article.id, mutationId: "pending-article" }));
      if (change === "transition") await h.lib.beginWorkspaceTransition({ from: h.binding,
        to: { ownerId: "other-owner", bindingId: "other-binding" }, storageSnapshot: [] });
      return { advisory, prepared: await h.prepare(),
        attempts: await h.repo.listProgressCloudAttempts(...h.args) };
    }, change);
    expect(result.advisory).toEqual({ status: "ready", mode: "update" });
    expect(result.prepared.status).not.toBe("prepared");
    expect(result.attempts.attempts).toEqual([]);
  });
}

for (const kind of ["unknown", "absent", "unanchored"]) {
  test(`${kind} never creates a production attempt`, async ({ page }) => {
    const result = await page.evaluate(async kind => {
      await h.setup(kind === "unanchored" ? "revision" : kind);
      await h.movement(0.3);
      if (kind === "unanchored") await h.raw("progressDesired", tx => {
        const store = tx.objectStore("progressDesired");
        const request = store.get(h.args);
        request.onsuccess = () => { const row = request.result;
          row.confirmed.causalBase = { kind: "unanchored", parent: null }; store.put(row); };
      });
      return { result: await h.prepare(), attempts: await h.repo.listProgressCloudAttempts(...h.args) };
    }, kind);
    expect(result.result.status).not.toBe("prepared");
    expect(result.attempts.attempts).toEqual([]);
  });
}

test("invalid int32 paragraph and invalid progress cannot freeze a request", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup();
    await h.flow.writeRealMovement(h.article.id, h.target(0.3, 2147483648));
    const oversized = await h.prepare();
    const invalidProgress = await h.repo.prepareProgressCloudAttempt(...h.args, {
      scope: { ...h.binding, scopeToken: "fixture" }, fence: {}, checkpoint: {
        progress: 1.1, paragraphIndex: 1, contentFingerprint: h.fp,
        updatedAt: "2026-10-01T00:00:00.000Z" }, fingerprint: h.fp,
      articleActive: true, cloudEligible: true, transitionInactive: true
    });
    return { oversized, invalidProgress,
      attempts: await h.repo.listProgressCloudAttempts(...h.args) };
  });
  expect(result.oversized).toMatchObject({ status: "not-ready", reason: "invalid-checkpoint" });
  expect(result.invalidProgress.status).not.toBe("prepared");
  expect(result.attempts.attempts).toEqual([]);
});

test("one unresolved per scope; newer real movement leaves old request unchanged", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const first = (await h.prepare()).attempt;
    await h.movement(0.4);
    const existing = await h.prepare();
    const before = await h.repo.getProgressCloudAttempt(...h.args, first.attemptId);
    const desired = await h.repo.getProgressDesired(...h.args);
    const superseded = await h.repo.supersedePreparedProgressCloudAttempt(...h.args, first.attemptId);
    const next = await h.prepare();
    return { first, existing, before, desired, superseded, next,
      all: await h.repo.listProgressCloudAttempts(...h.args) };
  });
  expect(result.existing.status).toBe("existing-attempt");
  expect(result.before.attempt.request).toEqual(result.first.request);
  expect(result.desired.record.confirmed.checkpoint.progress).toBe(0.4);
  expect(result.superseded.status).toBe("superseded");
  // B has the same frozen rev10 base; superseding A does not fabricate rev11.
  expect(result.next.status).toBe("prepared");
  expect(result.next.attempt.cloudMutationId).not.toBe(result.first.cloudMutationId);
  expect(result.all.attempts).toHaveLength(2);
  expect(result.all.attempts.filter(item => item.status === "prepared")).toHaveLength(1);
});

test("same or older confirmed sequence cannot supersede; blocked attempt cannot supersede", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    const same = await h.repo.supersedePreparedProgressCloudAttempt(...h.args, attempt.attemptId);
    const blocked = await h.repo.blockPreparedProgressCloudAttempt(...h.args,
      attempt.attemptId, "fixture-postflight");
    const again = await h.repo.supersedePreparedProgressCloudAttempt(...h.args, attempt.attemptId);
    return { same, blocked, again, read: await h.repo.getProgressCloudAttempt(...h.args, attempt.attemptId) };
  });
  expect(result.same.status).toBe("not-newer-confirmed");
  expect(result.blocked.status).toBe("blocked_before_dispatch");
  expect(result.again.status).toBe("not-prepared");
  expect(result.read.attempt.reason).toBe("fixture-postflight");
});

test("superseded attempt retains its original durable request after reload", async ({ page }) => {
  const before = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.movement(0.4);
    const superseded = await h.repo.supersedePreparedProgressCloudAttempt(...h.args, attempt.attemptId);
    return { attempt, superseded };
  });
  expect(before.superseded.status).toBe("superseded");
  await page.reload();
  const after = await page.evaluate(async attempt => window.LingoFlowSyncStateRepository
    .getProgressCloudAttempt(attempt.ownerId, attempt.bindingId, attempt.articleId, attempt.attemptId),
  before.attempt);
  expect(after.status).toBe("ready");
  expect(after.attempt.status).toBe("superseded");
  expect(after.attempt.cloudMutationId).toBe(before.attempt.cloudMutationId);
  expect(after.attempt.request).toEqual(before.attempt.request);
  expect(after.attempt.sourceFence).toEqual(before.attempt.sourceFence);
});

test("auth loss and binding replacement isolate retained A attempts", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    h.setAuthOwner(null);
    const anonymous = await h.prepare();
    h.setAuthOwner(h.binding.ownerId);
    const attempt = (await h.prepare()).attempt;
    const other = { ownerId: "attempt-owner-b", bindingId: "attempt-binding-b" };
    const replaced = await h.repo.replaceWorkspaceBinding({ from: h.binding,
      to: other, accountLabel: "b@example.test" });
    h.setAuthOwner(other.ownerId);
    const wrongOwner = await h.repo.getProgressCloudAttempt(...h.args, attempt.attemptId);
    const wrongList = await h.repo.listProgressCloudAttempts(...h.args);
    const wrongSupersede = await h.repo.supersedePreparedProgressCloudAttempt(...h.args, attempt.attemptId);
    const newOwner = await h.repo.listProgressCloudAttempts(other.ownerId, other.bindingId, h.article.id);
    const db = await h.repo.openDatabase();
    const raw = await new Promise(resolve => {
      const request = db.transaction("progressCloudAttempts").objectStore("progressCloudAttempts")
        .get([h.binding.ownerId, h.binding.bindingId, h.article.id, attempt.attemptId]);
      request.onsuccess = () => resolve(request.result);
    });
    return { anonymous, replaced, wrongOwner, wrongList, wrongSupersede, newOwner, raw };
  });
  expect(result.anonymous.status).not.toBe("prepared");
  expect(result.replaced.status).toBe("replaced");
  expect(result.wrongOwner.status).toBe("blocked");
  expect(result.wrongList.status).toBe("blocked");
  expect(result.wrongSupersede.status).toBe("blocked");
  expect(result.newOwner.attempts).toEqual([]);
  expect(result.raw.status).toBe("blocked_before_dispatch");
  expect(result.raw.reason).toBe("workspace-replaced");
});

test("same owner with a new binding cannot see or supersede the old binding's attempt", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    const next = { ...h.binding, bindingId: "attempt-binding-a-new" };
    await h.raw("control", tx => tx.objectStore("control")
      .put({ key: "workspace-binding", ...next }));
    return { oldRead: await h.repo.getProgressCloudAttempt(...h.args, attempt.attemptId),
      oldSupersede: await h.repo.supersedePreparedProgressCloudAttempt(...h.args, attempt.attemptId),
      newList: await h.repo.listProgressCloudAttempts(next.ownerId, next.bindingId, h.article.id) };
  });
  expect(result.oldRead.status).toBe("blocked");
  expect(result.oldSupersede.status).toBe("blocked");
  expect(result.newList.attempts).toEqual([]);
});

test("simultaneous tabs serialize one unresolved attempt in SyncDB", async ({ page }) => {
  await page.evaluate(async () => { await h.setup(); await h.movement(0.3); });
  const second = await page.context().newPage();
  try {
    await second.goto("/");
    await second.evaluate(() => {
      window.LingoFlowSupabaseAuth = { getState: () => ({ status: "authenticated",
        user: { id: "attempt-owner-a" } }) };
    });
    const articleId = await page.evaluate(() => h.article.id);
    const [a, b] = await Promise.all([
      page.evaluate(() => h.prepare()),
      second.evaluate(id => window.LingoFlowProgressLocalDesired.prepareCloudAttempt(
        "attempt-owner-a", "attempt-binding-a", id), articleId)
    ]);
    expect([a.status, b.status].sort()).toEqual(["existing-attempt", "prepared"]);
    const attempts = await page.evaluate(() => h.repo.listProgressCloudAttempts(...h.args));
    expect(attempts.attempts).toHaveLength(1);
  } finally { await second.close(); }
});

test("malformed stored attempt fails closed without a second unresolved record", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.raw("progressCloudAttempts", tx => {
      tx.objectStore("progressCloudAttempts").put({ ...attempt, request: { ...attempt.request,
        expectedProgressRevision: "revision:11" } });
    });
    return { read: await h.repo.getProgressCloudAttempt(...h.args, attempt.attemptId),
      list: await h.repo.listProgressCloudAttempts(...h.args), prepare: await h.prepare() };
  });
  expect(result.read.status).toBe("malformed-attempt");
  expect(result.list.status).toBe("malformed-attempt");
  expect(result.prepare.status).toBe("malformed-attempt");
});

test("tampered source action target cannot be treated as a valid frozen attempt", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.raw("progressCloudAttempts", tx => {
      tx.objectStore("progressCloudAttempts").put({ ...attempt, sourceFence: {
        ...attempt.sourceFence, action: { ...attempt.sourceFence.action,
          target: { ...attempt.sourceFence.action.target, progress: 0.8 } }
      } });
    });
    return { read: await h.repo.getProgressCloudAttempt(...h.args, attempt.attemptId),
      list: await h.repo.listProgressCloudAttempts(...h.args), prepare: await h.prepare() };
  });
  expect(result.read.status).toBe("malformed-attempt");
  expect(result.list.status).toBe("malformed-attempt");
  expect(result.prepare.status).toBe("malformed-attempt");
});

for (const changed of ["fence", "resume", "lifecycle"]) {
  test(`postflight ${changed} change blocks the frozen attempt`, async ({ page }) => {
    const result = await page.evaluate(async changed => {
      await h.setup(); await h.movement(0.3);
      const original = SubtleCrypto.prototype.digest;
      let calls = 0;
      SubtleCrypto.prototype.digest = async function(...args) {
        calls += 1;
        if (calls === 2) {
          const db = await h.lib.openDatabase();
          await new Promise((resolve, reject) => {
            const storeName = changed === "fence" ? "progressFences" : "articles";
            const tx = db.transaction(storeName, "readwrite");
            const store = tx.objectStore(storeName);
            const request = store.get(h.article.id);
            request.onsuccess = () => {
              const row = request.result;
              if (changed === "fence") row.resumeRevision += 1;
              if (changed === "resume") row.reading.resume = h.target(0.4);
              if (changed === "lifecycle") row.deletedAt = "2026-10-03T00:00:00.000Z";
              store.put(row);
            };
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
          });
        }
        return original.apply(this, args);
      };
      let prepared;
      try { prepared = await h.prepare(); }
      finally { SubtleCrypto.prototype.digest = original; }
      return { prepared, attempts: await h.repo.listProgressCloudAttempts(...h.args), calls };
    }, changed);
    expect(result.calls).toBeGreaterThanOrEqual(2);
    expect(result.prepared.status).toBe("not-ready");
    expect(result.prepared.reason).toBe("local-postflight-changed");
    expect(result.attempts.attempts).toHaveLength(1);
    expect(result.attempts.attempts[0].status).toBe("blocked_before_dispatch");
  });
}
