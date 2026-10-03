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
    const success = (attempt, status = "applied", revision = "revision:11",
      cursor = "cursor:11") => ({
      status, mutationId: attempt.cloudMutationId, articleId: attempt.articleId,
      revision, cursor, progress: attempt.request.progress,
      paragraphIndex: attempt.request.paragraphIndex,
      parentReadingEpoch: attempt.request.parentReadingEpoch,
      contentFingerprint: attempt.request.contentFingerprint,
      serverUpdatedAt: "2026-10-03T00:00:00+00:00"
    });
    window.h = { repo, lib, flow, resume, binding, article, fp, epoch, epoch2,
      args, raw, setup, target, movement, prepare, success,
      setAuthOwner: value => { authOwner = value; } };
  });
});

test.afterEach(async ({ page }) => {
  expect(page.__progressRequests, "B3-3B-2A must make zero Progress requests").toEqual([]);
});

test("strict Progress parser accepts complete success and rejects unknown shapes", async ({ page }) => {
  const parsed = await page.evaluate(() => {
    const parser = window.LingoFlowProgressCloudResult;
    const request = { mutationId: "m", articleId: "a", expectedState: "revision",
      parentReadingEpoch: "11111111-2222-4333-8444-555555555555",
      contentFingerprint: `sha256:${"a".repeat(64)}`, progress: 0.3, paragraphIndex: 3 };
    const success = { status: "applied", mutationId: "m", articleId: "a",
      revision: "revision:11", cursor: "cursor:11", progress: 0.3,
      paragraphIndex: 3, parentReadingEpoch: request.parentReadingEpoch,
      contentFingerprint: request.contentFingerprint,
      serverUpdatedAt: "2026-10-03T00:00:00+00:00" };
    return {
      applied: parser.parse(success, request).status,
      unchanged: parser.parse({ ...success, status: "unchanged",
        revision: "revision:10", cursor: "cursor:10" }, request).status,
      missing: parser.parse({ ...success, cursor: undefined }, request).status,
      overflowingRevision: parser.parse({ ...success,
        revision: "revision:9223372036854775808" }, request).status,
      overflowingCursor: parser.parse({ ...success,
        cursor: "cursor:9223372036854775808" }, request).status,
      wrongId: parser.parse({ ...success, mutationId: "other" }, request),
      unknownStatus: parser.parse({ ...success, status: "synced" }, request).status,
      unknownReason: parser.parse({ status: "rejected", reason: "future-reason" }, request).status,
      conflict: parser.parse({ status: "conflict", reason: "revision-mismatch",
        mutationId: "m", articleId: "a", currentRevision: "revision:12",
        currentCursor: "cursor:14" }, request)
    };
  });
  expect(parsed.applied).toBe("success");
  expect(parsed.unchanged).toBe("success");
  expect(parsed.missing).toBe("unparseable");
  expect(parsed.overflowingRevision).toBe("unparseable");
  expect(parsed.overflowingCursor).toBe("unparseable");
  expect(parsed.wrongId).toEqual({ status: "attention", reason: "success-identity-mismatch" });
  expect(parsed.unknownStatus).toBe("unparseable");
  expect(parsed.unknownReason).toBe("unparseable");
  expect(parsed.conflict).toEqual({ status: "terminal", reason: "revision-mismatch",
    currentRevisionHint: "revision:12", currentCursorHint: "cursor:14" });
});

test("applied settlement advances observation and consumes only exact desired shell", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
    const settled = await h.flow.settleCloudResult(guard, h.article.id,
      attempt.attemptId, h.success(attempt));
    const after = await h.repo.getProgressDesired(...h.args);
    const observation = await h.repo.getProgressRemoteObservation(...h.args);
    const stored = await h.repo.getProgressCloudAttempt(...h.args, attempt.attemptId);
    const coverage = await h.flow.evaluateLatestLocalCloudCoverage(...h.args);
    return { settled, after, observation, stored, coverage };
  });
  expect(result.settled).toMatchObject({ status: "succeeded", resultStatus: "applied",
    localCoverageAtSettlement: "covered" });
  expect(result.after.record.localSeq).toBe(1);
  expect(result.after.record.confirmed).toBeNull();
  expect(result.observation.observation).toMatchObject({ revision: "revision:11",
    cursor: "cursor:11", checkpoint: { progress: 0.3, paragraphIndex: 3 } });
  expect(result.stored.attempt.status).toBe("succeeded");
  expect(result.coverage.status).toBe("covered");
});

test("unchanged and receipt replay use canonical revision without increment", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup();
    await h.raw("progressRemoteObservations", tx => tx.objectStore("progressRemoteObservations")
      .put({ ownerId: h.binding.ownerId, bindingId: h.binding.bindingId,
        articleId: h.article.id, kind: "revision", revision: "revision:10", cursor: "cursor:10",
        parentReadingEpoch: h.epoch, contentFingerprint: h.fp,
        checkpoint: { progress: 0.3, paragraphIndex: 3 } }));
    await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
    const response = h.success(attempt, "unchanged", "revision:10", "cursor:10");
    const first = await h.flow.settleCloudResult(guard, h.article.id, attempt.attemptId, response);
    const replay = await h.flow.settleCloudResult(guard, h.article.id, attempt.attemptId, response);
    return { first, replay, stored: await h.repo.getProgressCloudAttempt(...h.args,
      attempt.attemptId), observation: await h.repo.getProgressRemoteObservation(...h.args) };
  });
  expect(result.first).toMatchObject({ status: "succeeded", resultStatus: "unchanged" });
  expect(result.replay).toMatchObject({ status: "succeeded", idempotent: true });
  expect(result.stored.attempt.settlement.result.revision).toBe("revision:10");
  expect(result.observation.observation.cursor).toBe("cursor:10");
});

test("conflicting duplicate canonical success enters durable attention", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
    await h.flow.settleCloudResult(guard, h.article.id, attempt.attemptId, h.success(attempt));
    const duplicate = await h.flow.settleCloudResult(guard, h.article.id, attempt.attemptId,
      h.success(attempt, "applied", "revision:12", "cursor:12"));
    return { duplicate, stored: await h.repo.getProgressCloudAttempt(...h.args,
      attempt.attemptId), observation: await h.repo.getProgressRemoteObservation(...h.args) };
  });
  expect(result.duplicate.status).toBe("settlement_attention");
  expect(result.stored.attempt.status).toBe("settlement_attention");
  expect(result.observation.observation.revision).toBe("revision:11");
});

test("identical canonical success with different JSON field order remains idempotent", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
    const firstResponse = h.success(attempt);
    const secondResponse = Object.fromEntries(Object.entries(firstResponse).reverse());
    const first = await h.flow.settleCloudResult(guard, h.article.id,
      attempt.attemptId, firstResponse);
    const second = await h.flow.settleCloudResult(guard, h.article.id,
      attempt.attemptId, secondResponse);
    return { first, second, stored: await h.repo.getProgressCloudAttempt(...h.args,
      attempt.attemptId) };
  });
  expect(result.first.status).toBe("succeeded");
  expect(result.second).toMatchObject({ status: "succeeded", idempotent: true });
  expect(result.stored.attempt.status).toBe("succeeded");
});

test("newer observation is not downgraded by older server success", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    await h.repo.recordProgressRemoteObservation(...h.args, { kind: "revision",
      revision: "revision:12", cursor: "cursor:12", parentReadingEpoch: h.epoch,
      contentFingerprint: h.fp, checkpoint: { progress: 0.7, paragraphIndex: 7 } });
    const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
    const settled = await h.flow.settleCloudResult(guard, h.article.id,
      attempt.attemptId, h.success(attempt));
    return { settled, desired: await h.repo.getProgressDesired(...h.args),
      observation: await h.repo.getProgressRemoteObservation(...h.args) };
  });
  expect(result.settled).toMatchObject({ status: "succeeded", observationStatus: "stale-observation",
    localCoverageAtSettlement: "unknown" });
  expect(result.observation.observation.revision).toBe("revision:12");
  expect(result.desired.record.confirmed.checkpoint.progress).toBe(0.3);
});

test("equal-revision canonical contradiction fails closed without clearing desired", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    await h.repo.recordProgressRemoteObservation(...h.args, { kind: "revision",
      revision: "revision:11", cursor: "cursor:11", parentReadingEpoch: h.epoch,
      contentFingerprint: h.fp, checkpoint: { progress: 0.8, paragraphIndex: 8 } });
    const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
    const settled = await h.flow.settleCloudResult(guard, h.article.id,
      attempt.attemptId, h.success(attempt));
    return { settled, desired: await h.repo.getProgressDesired(...h.args),
      observation: await h.repo.getProgressRemoteObservation(...h.args) };
  });
  expect(result.settled.status).toBe("settlement_attention");
  expect(result.observation.observation.checkpoint.progress).toBe(0.8);
  expect(result.observation.diagnostic.reason).toBe("inconsistent-observation");
  expect(result.desired.record.confirmed.checkpoint.progress).toBe(0.3);
});

test("pre-existing observation contradiction cannot consume desired or claim latest covered", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup();
    await h.raw("progressRemoteObservations", tx => tx.objectStore("progressRemoteObservations")
      .put({ ownerId: h.binding.ownerId, bindingId: h.binding.bindingId,
        articleId: h.article.id, kind: "revision", revision: "revision:10", cursor: "cursor:10",
        parentReadingEpoch: h.epoch, contentFingerprint: h.fp,
        checkpoint: { progress: 0.3, paragraphIndex: 3 } }));
    await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    const contradiction = await h.repo.recordProgressRemoteObservation(...h.args, {
      kind: "revision", revision: "revision:10", cursor: "cursor:10",
      parentReadingEpoch: h.epoch, contentFingerprint: h.fp,
      checkpoint: { progress: 0.8, paragraphIndex: 8 }
    });
    const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
    const settled = await h.flow.settleCloudResult(guard, h.article.id, attempt.attemptId,
      h.success(attempt, "unchanged", "revision:10", "cursor:10"));
    return { contradiction, settled, desired: await h.repo.getProgressDesired(...h.args),
      coverage: await h.flow.evaluateLatestLocalCloudCoverage(...h.args),
      observation: await h.repo.getProgressRemoteObservation(...h.args) };
  });
  expect(result.contradiction.status).toBe("inconsistent-observation");
  expect(result.observation.diagnostic.reason).toBe("inconsistent-observation");
  expect(result.desired.record.confirmed.checkpoint.progress).toBe(0.3);
  expect(result.settled.localCoverageAtSettlement).toBe("unknown");
  expect(result.coverage.status).not.toBe("covered");
});

test("newer confirmed and pending both survive an older success", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const first = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, first.attemptId);
    await h.movement(0.4);
    const newer = await h.repo.getProgressDesired(...h.args);
    const context = await h.lib.getProgressContext(h.article.id, h.binding);
    const pending = await h.repo.prepareProgressMovement({ ...h.binding, articleId: h.article.id,
      target: h.target(0.5), beforeResume: context.article.reading.resume,
      articleFence: context.fence, scope: context.scope });
    const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
    const settled = await h.flow.settleCloudResult(guard, h.article.id,
      first.attemptId, h.success(first));
    return { newer, pending, settled, after: await h.repo.getProgressDesired(...h.args) };
  });
  expect(result.settled).toMatchObject({ status: "succeeded",
    localCoverageAtSettlement: "advanced" });
  expect(result.after.record.localSeq).toBe(3);
  expect(result.after.record.confirmed).toEqual(result.newer.record.confirmed);
  expect(result.after.record.pending.actionId).toBe(result.pending.pending.actionId);
  expect(result.after.record.confirmed.causalBase.revision).toBe("revision:10");
});

test("local-only narrow-window advancement leaves server success but not latest coverage", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    const context = await h.lib.getProgressContext(h.article.id, h.binding);
    const advanced = await h.lib.commitReadingResumeIfCurrent({
      articleId: h.article.id, expectedContent: context.article.content,
      contentFingerprint: h.fp, beforeResume: context.article.reading.resume,
      target: h.target(0.4), furthest: null, scope: context.scope,
      expectedFence: context.fence
    });
    const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
    const settled = await h.flow.settleCloudResult(guard, h.article.id,
      attempt.attemptId, h.success(attempt));
    return { advanced, settled, desired: await h.repo.getProgressDesired(...h.args),
      coverage: await h.flow.evaluateLatestLocalCloudCoverage(...h.args),
      context: await h.lib.getProgressContext(h.article.id, h.binding) };
  });
  expect(result.advanced.status).toBe("committed");
  expect(result.settled).toMatchObject({ status: "succeeded",
    localCoverageAtSettlement: "advanced" });
  expect(result.desired.record.confirmed.checkpoint.progress).toBe(0.3);
  expect(result.context.article.reading.resume.progress).toBe(0.4);
  expect(result.coverage.status).toBe("local-advanced");
});

test("dynamic coverage stops being covered after a later local-only Reader movement", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
    await h.flow.settleCloudResult(guard, h.article.id, attempt.attemptId, h.success(attempt));
    const before = await h.flow.evaluateLatestLocalCloudCoverage(...h.args);
    const context = await h.lib.getProgressContext(h.article.id, h.binding);
    await h.lib.commitReadingResumeIfCurrent({ articleId: h.article.id,
      expectedContent: context.article.content, contentFingerprint: h.fp,
      beforeResume: context.article.reading.resume, target: h.target(0.4),
      furthest: null, scope: context.scope, expectedFence: context.fence });
    return { before, after: await h.flow.evaluateLatestLocalCloudCoverage(...h.args) };
  });
  expect(result.before.status).toBe("covered");
  expect(result.after.status).toBe("local-advanced");
});

test("dynamic coverage reports unknown when LibraryDB cannot be read", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
    await h.flow.settleCloudResult(guard, h.article.id, attempt.attemptId, h.success(attempt));
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function(...args) {
      if (this.name === "LingoFlowLibraryDB") throw new Error("fixture-library-unavailable");
      return original.apply(this, args);
    };
    try { return await h.flow.evaluateLatestLocalCloudCoverage(...h.args); }
    finally { IDBDatabase.prototype.transaction = original; }
  });
  expect(result.status).toBe("unknown");
});

test("LibraryDB coverage outage does not erase a valid server success", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    const original = window.LingoFlowArticleLibrary;
    window.LingoFlowArticleLibrary = { ...original,
      getProgressContext: async () => { throw new Error("fixture-library-unavailable"); } };
    let settled;
    try { settled = await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId,
      h.success(attempt)); }
    finally { window.LingoFlowArticleLibrary = original; }
    return { settled, desired: await h.repo.getProgressDesired(...h.args),
      stored: await h.repo.getProgressCloudAttempt(...h.args, attempt.attemptId) };
  });
  expect(result.settled).toMatchObject({ status: "succeeded",
    localCoverageAtSettlement: "unknown" });
  expect(result.desired.record.confirmed).toBeTruthy();
  expect(result.stored.attempt.status).toBe("succeeded");
});

test("settlement transaction rollback keeps attempt, observation and desired retryable", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    const response = h.success(attempt);
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(...args) {
      if (this.name === "progressCloudAttempts" && args[0]?.status === "succeeded") {
        throw new DOMException("injected settlement abort", "QuotaExceededError");
      }
      return originalPut.apply(this, args);
    };
    let failed = false;
    try { await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId, response); }
    catch { failed = true; }
    finally { IDBObjectStore.prototype.put = originalPut; }
    const before = {
      attempt: await h.repo.getProgressCloudAttempt(...h.args, attempt.attemptId),
      observation: await h.repo.getProgressRemoteObservation(...h.args),
      desired: await h.repo.getProgressDesired(...h.args)
    };
    const retry = await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId, response);
    return { failed, before, retry };
  });
  expect(result.failed).toBe(true);
  expect(result.before.attempt.attempt.status).toBe("may_have_sent");
  expect(result.before.observation.observation.revision).toBe("revision:10");
  expect(result.before.desired.record.confirmed.checkpoint.progress).toBe(0.3);
  expect(result.retry.status).toBe("succeeded");
});

test("latest-local coverage reports pending movement after an older success", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
    await h.flow.settleCloudResult(guard, h.article.id, attempt.attemptId, h.success(attempt));
    const context = await h.lib.getProgressContext(h.article.id, h.binding);
    await h.repo.prepareProgressMovement({ ...h.binding, articleId: h.article.id,
      target: h.target(0.4), beforeResume: context.article.reading.resume,
      articleFence: context.fence, scope: context.scope });
    return h.flow.evaluateLatestLocalCloudCoverage(...h.args);
  });
  expect(result.status).toBe("pending-local");
});

test("older success never rebases a newer confirmed desired", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    await h.movement(0.4);
    const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
    const settled = await h.flow.settleCloudResult(guard, h.article.id,
      attempt.attemptId, h.success(attempt));
    return { settled, candidate: await h.flow.evaluateCloudCandidate(...h.args),
      coverage: await h.flow.evaluateLatestLocalCloudCoverage(...h.args),
      desired: await h.repo.getProgressDesired(...h.args) };
  });
  expect(result.settled.localCoverageAtSettlement).toBe("advanced");
  expect(result.candidate.reason).toBe("stale-base");
  expect(result.coverage.status).toBe("local-advanced");
  expect(result.desired.record.confirmed.causalBase.revision).toBe("revision:10");
});

test("CAS conflict retains desired and partial hints without fabricating observation", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
    const terminal = await h.flow.settleCloudResult(guard, h.article.id, attempt.attemptId,
      { status: "conflict", reason: "revision-mismatch", mutationId: attempt.cloudMutationId,
        articleId: attempt.articleId, currentRevision: "revision:11", currentCursor: "cursor:11" });
    const repeat = await h.prepare();
    return { terminal, repeat, stored: await h.repo.getProgressCloudAttempt(...h.args,
      attempt.attemptId), observation: await h.repo.getProgressRemoteObservation(...h.args),
      desired: await h.repo.getProgressDesired(...h.args) };
  });
  expect(result.terminal).toMatchObject({ status: "terminal", reason: "revision-mismatch" });
  expect(result.stored.attempt.settlement.currentRevisionHint).toBe("revision:11");
  expect(result.observation.observation.revision).toBe("revision:10");
  expect(result.desired.record.confirmed.checkpoint.progress).toBe(0.3);
  expect(result.repeat.reason).toBe("progress-refresh-required");
});

test("trusted Progress refresh releases conflict gate but does not rebase old desired", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
    await h.flow.settleCloudResult(guard, h.article.id, attempt.attemptId,
      { status: "conflict", reason: "revision-mismatch", mutationId: attempt.cloudMutationId,
        articleId: attempt.articleId, currentRevision: "revision:11", currentCursor: "cursor:11" });
    await h.repo.recordProgressRemoteObservation(...h.args, { kind: "revision",
      revision: "revision:11", cursor: "cursor:11", parentReadingEpoch: h.epoch,
      contentFingerprint: h.fp, checkpoint: { progress: 0.2, paragraphIndex: 2 } });
    const old = await h.prepare();
    await h.movement(0.4);
    const fresh = await h.prepare();
    return { old, fresh, desired: await h.repo.getProgressDesired(...h.args) };
  });
  expect(result.old.reason).toBe("stale-base");
  expect(result.fresh.status).toBe("prepared");
  expect(result.desired.record.confirmed.causalBase.revision).toBe("revision:11");
});

for (const reason of ["parent-not-ready", "article-deleted", "parent-epoch-mismatch",
  "fingerprint-mismatch"]) {
  test(`${reason} is terminal and needs trusted Article context refresh`, async ({ page }) => {
    const result = await page.evaluate(async reason => {
      await h.setup(); await h.movement(0.3);
      const attempt = (await h.prepare()).attempt;
      await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
      const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
      const terminal = await h.flow.settleCloudResult(guard, h.article.id, attempt.attemptId,
        { status: "rejected", reason, mutationId: attempt.cloudMutationId,
          articleId: attempt.articleId });
      const blocked = await h.prepare();
      const article = await h.lib.getArticle(h.article.id);
      return { terminal, blocked, article, desired: await h.repo.getProgressDesired(...h.args) };
    }, reason);
    expect(result.terminal).toMatchObject({ status: "terminal", reason });
    expect(result.blocked.reason).toBe("parent-refresh-required");
    expect(result.article.deletedAt).toBeNull();
    expect(result.desired.record.confirmed.checkpoint.progress).toBe(0.3);
  });
}

test("title-only Article revision does not release a parent refresh gate", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
    await h.flow.settleCloudResult(guard, h.article.id, attempt.attemptId,
      { status: "rejected", reason: "parent-epoch-mismatch",
        mutationId: attempt.cloudMutationId, articleId: attempt.articleId });
    await h.raw("articleSidecars", tx => {
      const store = tx.objectStore("articleSidecars");
      const request = store.get([h.binding.ownerId, h.article.id]);
      request.onsuccess = () => store.put({ ...request.result, knownRevision: "revision:2",
        serverReadingContext: { articleRevision: "revision:2", readingEpoch: h.epoch,
          contentFingerprint: h.fp, lifecycle: "active" } });
    });
    return h.prepare();
  });
  expect(result.reason).toBe("parent-refresh-required");
});

test("new Article epoch releases parent gate without rewriting old desired", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
    await h.flow.settleCloudResult(guard, h.article.id, attempt.attemptId,
      { status: "rejected", reason: "parent-epoch-mismatch",
        mutationId: attempt.cloudMutationId, articleId: attempt.articleId });
    await h.raw("articleSidecars", tx => {
      const store = tx.objectStore("articleSidecars");
      const request = store.get([h.binding.ownerId, h.article.id]);
      request.onsuccess = () => store.put({ ...request.result, knownRevision: "revision:2",
        serverReadingContext: { articleRevision: "revision:2", readingEpoch: h.epoch2,
          contentFingerprint: h.fp, lifecycle: "active" } });
    });
    const old = await h.prepare();
    await h.movement(0.4);
    const fresh = await h.prepare();
    return { old, fresh, desired: await h.repo.getProgressDesired(...h.args) };
  });
  expect(result.old.reason).toBe("parent-epoch-mismatch");
  expect(result.fresh.status).toBe("prepared");
  expect(result.fresh.attempt.request.parentReadingEpoch).toBe("22222222-2222-4333-8444-555555555555");
});

for (const reason of ["invalid-mutation", "invalid-checkpoint"]) {
  test(`${reason} becomes terminal without reconstructing request`, async ({ page }) => {
    const result = await page.evaluate(async reason => {
      await h.setup(); await h.movement(0.3);
      const attempt = (await h.prepare()).attempt;
      await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
      const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
      const settled = await h.flow.settleCloudResult(guard, h.article.id, attempt.attemptId,
        { status: "rejected", reason });
      return { settled, stored: await h.repo.getProgressCloudAttempt(...h.args,
        attempt.attemptId), repeat: await h.prepare() };
    }, reason);
    expect(result.settled).toMatchObject({ status: "terminal", reason });
    expect(result.stored.attempt.request.expectedState).toBe("revision");
    expect(result.repeat.reason).toBe("progress-protocol-invariant");
  });
}

test("mutation-id-reuse is high-severity attention and blocks a replacement", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
    const attention = await h.flow.settleCloudResult(guard, h.article.id, attempt.attemptId,
      { status: "rejected", reason: "mutation-id-reuse",
        mutationId: attempt.cloudMutationId, articleId: attempt.articleId });
    return { attention, next: await h.prepare(), stored: await h.repo.getProgressCloudAttempt(
      ...h.args, attempt.attemptId) };
  });
  expect(result.attention.status).toBe("settlement_attention");
  expect(result.next.status).toBe("existing-attempt");
  expect(result.stored.attempt.status).toBe("settlement_attention");
});

for (const response of [null, { status: "unknown" }, { status: "rejected", reason: "authentication-required" }]) {
  test(`unknown/auth response ${JSON.stringify(response)} preserves may_have_sent`, async ({ page }) => {
    const result = await page.evaluate(async response => {
      await h.setup(); await h.movement(0.3);
      const attempt = (await h.prepare()).attempt;
      await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
      const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
      return { settled: await h.flow.settleCloudResult(guard, h.article.id,
        attempt.attemptId, response), stored: await h.repo.getProgressCloudAttempt(
          ...h.args, attempt.attemptId) };
    }, response);
    expect(["unparseable", "auth-paused"]).toContain(result.settled.status);
    expect(result.stored.attempt.status).toBe("may_have_sent");
  });
}

test("consuming a source keeps localSeq authority for the next real movement", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
    await h.flow.settleCloudResult(guard, h.article.id, attempt.attemptId, h.success(attempt));
    const movement = await h.movement(0.4);
    const desired = await h.repo.getProgressDesired(...h.args);
    const candidate = await h.flow.evaluateCloudCandidate(...h.args);
    return { movement, desired, candidate };
  });
  expect(result.movement.status).toBe("confirmed");
  expect(result.desired.record.localSeq).toBe(2);
  expect(result.desired.record.confirmed.causalBase.revision).toBe("revision:11");
  expect(result.candidate).toEqual({ status: "ready", mode: "update" });
});

test("a mock transport timeout and malformed body keep the same durable request", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
    const timeout = { status: "unavailable", reason: "timeout" };
    const serverError = { status: "unavailable", reason: "server-error" };
    const a = await h.flow.settleCloudResult(guard, h.article.id, attempt.attemptId, timeout);
    const b = await h.flow.settleCloudResult(guard, h.article.id, attempt.attemptId, serverError);
    const c = await h.flow.settleCloudResult(guard, h.article.id, attempt.attemptId,
      { status: "applied", mutationId: attempt.cloudMutationId });
    return { a, b, c, stored: await h.repo.getProgressCloudAttempt(...h.args,
      attempt.attemptId), request: attempt.request };
  });
  for (const key of ["a", "b", "c"]) expect(result[key].status).toBe("unparseable");
  expect(result.stored.attempt.status).toBe("may_have_sent");
  expect(result.stored.attempt.request).toEqual(result.request);
});

test("response identity mismatch is attention and cannot consume local desired", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
    const settled = await h.flow.settleCloudResult(guard, h.article.id, attempt.attemptId,
      { ...h.success(attempt), mutationId: "another-mutation" });
    return { settled, stored: await h.repo.getProgressCloudAttempt(...h.args,
      attempt.attemptId), desired: await h.repo.getProgressDesired(...h.args) };
  });
  expect(result.settled.status).toBe("settlement_attention");
  expect(result.stored.attempt.status).toBe("settlement_attention");
  expect(result.desired.record.confirmed.checkpoint.progress).toBe(0.3);
});

test("tampered may-have-sent source target cannot settle a plausible success", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    await h.raw("progressCloudAttempts", tx => {
      const store = tx.objectStore("progressCloudAttempts");
      const request = store.get([...h.args, attempt.attemptId]);
      request.onsuccess = () => store.put({ ...request.result,
        sourceFence: { ...request.result.sourceFence,
          action: { ...request.result.sourceFence.action,
            target: { ...request.result.sourceFence.action.target, progress: 0.9 } } } });
    });
    const result = await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId,
      h.success(attempt));
    return { result, desired: await h.repo.getProgressDesired(...h.args),
      observation: await h.repo.getProgressRemoteObservation(...h.args) };
  });
  expect(result.result.status).toBe("malformed-attempt");
  expect(result.desired.record.confirmed.checkpoint.progress).toBe(0.3);
  expect(result.observation.observation.revision).toBe("revision:10");
});

test("two tabs settle one canonical response idempotently", async ({ page }) => {
  const attempt = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    return attempt;
  });
  const second = await page.context().newPage();
  try {
    await second.goto("/");
    await second.evaluate(ownerId => {
      window.LingoFlowSupabaseAuth = { getState: () => ({ status: "authenticated",
        user: { id: ownerId } }) };
    }, attempt.ownerId);
    const raw = await page.evaluate(attempt => h.success(attempt), attempt);
    const args = [attempt.ownerId, attempt.bindingId, attempt.articleId, attempt.attemptId];
    const [a, b] = await Promise.all([
      page.evaluate(async ({ args, raw }) => {
        const guard = await h.flow.captureCloudResponseContext(...args.slice(0, 2));
        return h.flow.settleCloudResult(guard, args[2], args[3], raw);
      }, { args, raw }),
      second.evaluate(async ({ args, raw }) => {
        const flow = window.LingoFlowProgressLocalDesired;
        const guard = await flow.captureCloudResponseContext(...args.slice(0, 2));
        return flow.settleCloudResult(guard, args[2], args[3], raw);
      }, { args, raw })
    ]);
    expect([a.status, b.status]).toEqual(["succeeded", "succeeded"]);
    expect([a.idempotent, b.idempotent].filter(Boolean)).toHaveLength(1);
    const stored = await page.evaluate(args => window.LingoFlowSyncStateRepository
      .getProgressCloudAttempt(...args), args);
    expect(stored.attempt.status).toBe("succeeded");
  } finally { await second.close(); }
});

test("reload after may_have_sent permits same result settlement without a new attempt", async ({ page }) => {
  const frozen = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    return { attempt, response: h.success(attempt) };
  });
  await page.reload();
  const result = await page.evaluate(async frozen => {
    window.LingoFlowSupabaseAuth = { getState: () => ({ status: "authenticated",
      user: { id: frozen.attempt.ownerId } }) };
    const flow = window.LingoFlowProgressLocalDesired;
    const a = frozen.attempt;
    const guard = await flow.captureCloudResponseContext(a.ownerId, a.bindingId);
    const settled = await flow.settleCloudResult(guard, a.articleId, a.attemptId, frozen.response);
    return { settled, stored: await window.LingoFlowSyncStateRepository
      .getProgressCloudAttempt(a.ownerId, a.bindingId, a.articleId, a.attemptId) };
  }, frozen);
  expect(result.settled.status).toBe("succeeded");
  expect(result.stored.attempt.cloudMutationId).toBe(frozen.attempt.cloudMutationId);
});

test("Account Switch before response leaves old may_have_sent unconsumed", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
    await h.repo.replaceWorkspaceBinding({ from: h.binding,
      to: { ownerId: "attempt-owner-b", bindingId: "attempt-binding-b" },
      accountLabel: "b@example.test" });
    h.setAuthOwner("attempt-owner-b");
    const settled = await h.flow.settleCloudResult(guard, h.article.id,
      attempt.attemptId, h.success(attempt));
    const db = await h.repo.openDatabase();
    const stored = await new Promise(resolve => {
      const request = db.transaction("progressCloudAttempts").objectStore("progressCloudAttempts")
        .get([...h.args, attempt.attemptId]);
      request.onsuccess = () => resolve(request.result);
    });
    return { settled, stored };
  });
  expect(result.settled.status).toBe("not-ready");
  expect(result.stored.status).toBe("may_have_sent");
});

test("Account Switch during settlement precheck cannot commit the old owner's success", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
    const original = window.LingoFlowArticleLibrary;
    let replacement;
    window.LingoFlowArticleLibrary = { ...original, getProgressContext: async (...args) => {
      if (!replacement) {
        replacement = await h.repo.replaceWorkspaceBinding({ from: h.binding,
          to: { ownerId: "attempt-owner-b", bindingId: "attempt-binding-b" },
          accountLabel: "b@example.test" });
        h.setAuthOwner("attempt-owner-b");
      }
      return original.getProgressContext(...args);
    } };
    let settled;
    try { settled = await h.flow.settleCloudResult(guard, h.article.id,
      attempt.attemptId, h.success(attempt)); }
    finally { window.LingoFlowArticleLibrary = original; }
    const db = await h.repo.openDatabase();
    const stored = await new Promise(resolve => {
      const request = db.transaction("progressCloudAttempts").objectStore("progressCloudAttempts")
        .get([...h.args, attempt.attemptId]);
      request.onsuccess = () => resolve(request.result);
    });
    return { replacement, settled, stored,
      binding: await h.repo.getWorkspaceBinding() };
  });
  expect(result.replacement.status).toBe("replaced");
  expect(result.settled.status).toBe("not-ready");
  expect(result.stored.status).toBe("may_have_sent");
  expect(result.binding.binding.ownerId).toBe("attempt-owner-b");
});

test("same owner with a new binding cannot settle old binding response", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    const guard = await h.flow.captureCloudResponseContext(...h.args.slice(0, 2));
    await h.raw("control", tx => tx.objectStore("control")
      .put({ key: "workspace-binding", ownerId: h.binding.ownerId,
        bindingId: "attempt-binding-a-new" }));
    const settled = await h.flow.settleCloudResult(guard, h.article.id,
      attempt.attemptId, h.success(attempt));
    const db = await h.repo.openDatabase();
    const stored = await new Promise(resolve => {
      const request = db.transaction("progressCloudAttempts").objectStore("progressCloudAttempts")
        .get([...h.args, attempt.attemptId]);
      request.onsuccess = () => resolve(request.result);
    });
    return { settled, stored };
  });
  expect(result.settled.status).toBe("not-ready");
  expect(result.stored.status).toBe("may_have_sent");
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

test("awaiting crash recovery reuses the frozen request and is idempotent", async ({ page }) => {
  const frozen = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const context = await h.lib.getProgressContext(h.article.id, h.binding, { initialize: false });
    return (await h.repo.prepareProgressCloudAttempt(...h.args, {
      scope: context.scope, fence: context.fence, checkpoint: context.article.reading.resume,
      fingerprint: h.fp, articleActive: true, cloudEligible: true, transitionInactive: true
    })).attempt;
  });
  await page.reload();
  const result = await page.evaluate(async attempt => {
    window.LingoFlowSupabaseAuth = { getState: () => ({ status: "authenticated",
      user: { id: attempt.ownerId } }) };
    const flow = window.LingoFlowProgressLocalDesired;
    const args = [attempt.ownerId, attempt.bindingId, attempt.articleId, attempt.attemptId];
    const first = await flow.resumeCloudAttemptPostflight(...args);
    const second = await flow.resumeCloudAttemptPostflight(...args);
    return { first, second, attempts: await window.LingoFlowSyncStateRepository
      .listProgressCloudAttempts(...args.slice(0, 3)) };
  }, frozen);
  expect(result.first.status).toBe("prepared");
  expect(result.second.status).toBe("prepared");
  expect(result.first.attempt).toEqual(result.second.attempt);
  expect(result.first.attempt.request).toEqual(frozen.request);
  expect(result.attempts.attempts).toHaveLength(1);
});

test("two tabs recover one awaiting attempt without replacement or block", async ({ page }) => {
  const attempt = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const context = await h.lib.getProgressContext(h.article.id, h.binding, { initialize: false });
    return (await h.repo.prepareProgressCloudAttempt(...h.args, {
      scope: context.scope, fence: context.fence, checkpoint: context.article.reading.resume,
      fingerprint: h.fp, articleActive: true, cloudEligible: true, transitionInactive: true
    })).attempt;
  });
  const second = await page.context().newPage();
  try {
    await second.goto("/");
    await second.evaluate(() => { window.LingoFlowSupabaseAuth = { getState: () => ({
      status: "authenticated", user: { id: "attempt-owner-a" } }) }; });
    const args = [attempt.ownerId, attempt.bindingId, attempt.articleId, attempt.attemptId];
    const [a, b] = await Promise.all([
      page.evaluate(args => h.flow.resumeCloudAttemptPostflight(...args), args),
      second.evaluate(args => window.LingoFlowProgressLocalDesired
        .resumeCloudAttemptPostflight(...args), args)
    ]);
    expect([a.status, b.status]).toEqual(["prepared", "prepared"]);
    expect(a.attempt).toEqual(b.attempt);
    expect(a.attempt.cloudMutationId).toBe(attempt.cloudMutationId);
  } finally { await second.close(); }
});

test("original postflight and another tab's recovery converge on one prepared attempt", async ({ page }) => {
  const frozen = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const context = await h.lib.getProgressContext(h.article.id, h.binding, { initialize: false });
    const local = { scope: context.scope, fence: context.fence,
      checkpoint: context.article.reading.resume, fingerprint: h.fp,
      articleActive: true, cloudEligible: true, transitionInactive: true };
    const attempt = (await h.repo.prepareProgressCloudAttempt(...h.args, local)).attempt;
    return { attempt, local };
  });
  const second = await page.context().newPage();
  try {
    await second.goto("/");
    await second.evaluate(() => { window.LingoFlowSupabaseAuth = { getState: () => ({
      status: "authenticated", user: { id: "attempt-owner-a" } }) }; });
    const args = [frozen.attempt.ownerId, frozen.attempt.bindingId,
      frozen.attempt.articleId, frozen.attempt.attemptId];
    const [original, recovered] = await Promise.all([
      page.evaluate(({ args, local }) => h.repo.confirmProgressCloudAttempt(...args, local),
        { args, local: frozen.local }),
      second.evaluate(args => window.LingoFlowProgressLocalDesired
        .resumeCloudAttemptPostflight(...args), args)
    ]);
    expect(original.status).toBe("prepared");
    expect(recovered.status).toBe("prepared");
    expect(original.attempt).toEqual(recovered.attempt);
    expect(original.attempt.request).toEqual(frozen.attempt.request);
    const all = await page.evaluate(args => h.repo.listProgressCloudAttempts(...args.slice(0, 3)), args);
    expect(all.attempts).toHaveLength(1);
  } finally { await second.close(); }
});

test("invalid awaiting recovery blocks rather than creating a new attempt", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const context = await h.lib.getProgressContext(h.article.id, h.binding, { initialize: false });
    const attempt = (await h.repo.prepareProgressCloudAttempt(...h.args, {
      scope: context.scope, fence: context.fence, checkpoint: context.article.reading.resume,
      fingerprint: h.fp, articleActive: true, cloudEligible: true, transitionInactive: true
    })).attempt;
    await h.raw("progressRemoteObservations", tx => {
      const store = tx.objectStore("progressRemoteObservations");
      const request = store.get(h.args);
      request.onsuccess = () => store.put({ ...request.result, revision: "revision:11",
        cursor: "cursor:11" });
    });
    const recovered = await h.flow.resumeCloudAttemptPostflight(...h.args, attempt.attemptId);
    const again = await h.flow.resumeCloudAttemptPostflight(...h.args, attempt.attemptId);
    return { attempt, recovered, again, stored: await h.repo.getProgressCloudAttempt(...h.args,
      attempt.attemptId) };
  });
  expect(result.recovered.status).toBe("not-ready");
  expect(result.stored.attempt.status).toBe("blocked_before_dispatch");
  expect(result.stored.attempt.request).toEqual(result.attempt.request);
  expect(result.again.status).toBe("not-awaiting-postflight");
});

test("reservation commits may_have_sent before exposing the immutable request", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const prepared = (await h.prepare()).attempt;
    const reserved = await h.flow.reserveCloudAttemptForDispatch(...h.args, prepared.attemptId);
    const requestFrozen = Object.isFrozen(reserved.immutableRequest);
    const stored = await h.repo.getProgressCloudAttempt(...h.args, prepared.attemptId);
    const second = await h.flow.reserveCloudAttemptForDispatch(...h.args, prepared.attemptId);
    const supersede = await h.repo.supersedePreparedProgressCloudAttempt(...h.args, prepared.attemptId);
    return { prepared, reserved, requestFrozen, stored, second, supersede };
  });
  expect(result.reserved.status).toBe("may_have_sent");
  expect(result.stored.attempt.status).toBe("may_have_sent");
  expect(result.reserved.immutableRequest).toEqual(result.stored.attempt.request);
  expect(result.requestFrozen).toBe(true);
  expect(result.reserved.cloudMutationId).toBe(result.prepared.cloudMutationId);
  expect(result.second.status).toBe("not-prepared");
  expect(result.supersede.status).toBe("not-prepared");
});

test("dispatch request is returned only after the attempt transaction completes", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    const original = IDBDatabase.prototype.transaction;
    let completionObserved = false;
    IDBDatabase.prototype.transaction = function(names, mode, ...rest) {
      const tx = original.call(this, names, mode, ...rest);
      if (this.name === "LingoFlowSyncDB" && mode === "readwrite" &&
          Array.from(names).includes("progressCloudAttempts")) {
        tx.addEventListener("complete", () => { completionObserved = true; });
      }
      return tx;
    };
    try {
      const reserved = await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
      return { reserved, completionObserved };
    } finally { IDBDatabase.prototype.transaction = original; }
  });
  expect(result.reserved.status).toBe("may_have_sent");
  expect(result.completionObserved).toBe(true);
});

test("local-only Resume/fence advance blocks dispatch even without newer desired", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    const context = await h.lib.getProgressContext(h.article.id, h.binding);
    const target = h.target(0.4);
    const local = await h.lib.commitReadingResumeIfCurrent({ articleId: h.article.id,
      expectedContent: context.article.content, contentFingerprint: h.fp,
      beforeResume: context.article.reading.resume, target, furthest: null,
      scope: context.scope, expectedFence: context.fence });
    const desired = await h.repo.getProgressDesired(...h.args);
    const reserved = await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    return { local, desired, reserved, stored: await h.repo.getProgressCloudAttempt(...h.args,
      attempt.attemptId) };
  });
  expect(result.local.status).toBe("committed");
  expect(result.desired.record.confirmed.checkpoint.progress).toBe(0.3);
  expect(result.reserved.status).toBe("not-ready");
  expect(result.stored.attempt.status).toBe("blocked_before_dispatch");
});

test("direct repository reservation cannot trust a stale caller snapshot", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    const context = await h.lib.getProgressContext(h.article.id, h.binding);
    const oldLocal = { scope: context.scope, fence: context.fence,
      checkpoint: context.article.reading.resume, fingerprint: h.fp,
      articleActive: true, cloudEligible: true, transitionInactive: true };
    await h.lib.commitReadingResumeIfCurrent({ articleId: h.article.id,
      expectedContent: context.article.content, contentFingerprint: h.fp,
      beforeResume: context.article.reading.resume, target: h.target(0.4), furthest: null,
      scope: context.scope, expectedFence: context.fence });
    const direct = await h.repo.reserveProgressCloudAttemptForDispatch(...h.args,
      attempt.attemptId, oldLocal);
    return { direct, stored: await h.repo.getProgressCloudAttempt(...h.args, attempt.attemptId) };
  });
  expect(result.direct.status).not.toBe("may_have_sent");
  expect(result.stored.attempt.status).toBe("blocked_before_dispatch");
});

test("local-only movement after final Library read preserves newer Resume despite conservative reservation", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    const original = window.LingoFlowArticleLibrary;
    let reads = 0;
    let localStatus = null;
    window.LingoFlowArticleLibrary = { ...original,
      getProgressContext: async (...args) => {
        const context = await original.getProgressContext(...args);
        reads += 1;
        if (reads === 2) {
          const local = await original.commitReadingResumeIfCurrent({ articleId: h.article.id,
            expectedContent: context.article.content, contentFingerprint: h.fp,
            beforeResume: context.article.reading.resume, target: h.target(0.4),
            furthest: null, scope: context.scope, expectedFence: context.fence });
          localStatus = local.status;
        }
        return context;
      } };
    let reserved;
    try { reserved = await h.repo.reserveProgressCloudAttemptForDispatch(...h.args,
      attempt.attemptId); }
    finally { window.LingoFlowArticleLibrary = original; }
    const now = await original.getProgressContext(h.article.id, h.binding);
    const desired = await h.repo.getProgressDesired(...h.args);
    return { reads, localStatus, reserved, localResume: now.article.reading.resume,
      desired: desired.record.confirmed.checkpoint,
      stored: await h.repo.getProgressCloudAttempt(...h.args, attempt.attemptId) };
  });
  expect(result.reads).toBe(2);
  expect(result.localStatus).toBe("committed");
  expect(result.reserved.status).toBe("may_have_sent");
  expect(result.localResume.progress).toBe(0.4);
  expect(result.desired.progress).toBe(0.3);
  expect(result.stored.attempt.request.progress).toBe(0.3);
});

test("failed older postflight cannot undo another tab's prepared recovery", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const context = await h.lib.getProgressContext(h.article.id, h.binding, { initialize: false });
    const attempt = (await h.repo.prepareProgressCloudAttempt(...h.args, {
      scope: context.scope, fence: context.fence, checkpoint: context.article.reading.resume,
      fingerprint: h.fp, articleActive: true, cloudEligible: true, transitionInactive: true
    })).attempt;
    const recovered = await h.flow.resumeCloudAttemptPostflight(...h.args, attempt.attemptId);
    const lateRejection = await h.repo.rejectAwaitingProgressCloudAttempt(...h.args,
      attempt.attemptId, "late-old-tab-postflight");
    return { recovered, lateRejection, stored: await h.repo.getProgressCloudAttempt(...h.args,
      attempt.attemptId) };
  });
  expect(result.recovered.status).toBe("prepared");
  expect(result.lateRejection.status).toBe("prepared");
  expect(result.stored.attempt.status).toBe("prepared");
});

test("prepared survives reload before dispatch; a concurrent reservation returns one request", async ({ page }) => {
  const prepared = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    return (await h.prepare()).attempt;
  });
  await page.reload();
  const second = await page.context().newPage();
  try {
    await second.goto("/");
    const auth = () => { window.LingoFlowSupabaseAuth = { getState: () => ({
      status: "authenticated", user: { id: "attempt-owner-a" } }) }; };
    await page.evaluate(auth);
    await second.evaluate(auth);
    const args = [prepared.ownerId, prepared.bindingId, prepared.articleId, prepared.attemptId];
    const before = await page.evaluate(args => window.LingoFlowSyncStateRepository
      .getProgressCloudAttempt(...args), args);
    const [a, b] = await Promise.all([
      page.evaluate(args => window.LingoFlowProgressLocalDesired
        .reserveCloudAttemptForDispatch(...args), args),
      second.evaluate(args => window.LingoFlowProgressLocalDesired
        .reserveCloudAttemptForDispatch(...args), args)
    ]);
    expect(before.attempt.status).toBe("prepared");
    expect([a.status, b.status].sort()).toEqual(["may_have_sent", "not-prepared"]);
    const sent = a.status === "may_have_sent" ? a : b;
    expect(sent.immutableRequest).toEqual(prepared.request);
  } finally { await second.close(); }
});

test("may_have_sent survives reload and newer Reader movement without mutation", async ({ page }) => {
  const before = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    const reserved = await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    await h.movement(0.4);
    const second = await h.prepare();
    return { attempt, reserved, second, desired: await h.repo.getProgressDesired(...h.args) };
  });
  expect(before.second.status).toBe("existing-attempt");
  expect(before.desired.record.confirmed.checkpoint.progress).toBe(0.4);
  await page.reload();
  const after = await page.evaluate(async attempt => {
    const repo = window.LingoFlowSyncStateRepository;
    return repo.getProgressCloudAttempt(attempt.ownerId, attempt.bindingId,
      attempt.articleId, attempt.attemptId);
  }, before.attempt);
  expect(after.attempt.status).toBe("may_have_sent");
  expect(after.attempt.request).toEqual(before.attempt.request);
  expect(after.attempt.cloudMutationId).toBe(before.attempt.cloudMutationId);
});

test("malformed may_have_sent fails closed and cannot make another attempt", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    await h.raw("progressCloudAttempts", tx => tx.objectStore("progressCloudAttempts")
      .put({ ...attempt, status: "may_have_sent", request: { ...attempt.request,
        expectedProgressRevision: "revision:11" } }));
    return { read: await h.repo.getProgressCloudAttempt(...h.args, attempt.attemptId),
      prepare: await h.prepare(), reserve: await h.flow.reserveCloudAttemptForDispatch(...h.args,
        attempt.attemptId) };
  });
  expect(result.read.status).toBe("malformed-attempt");
  expect(result.prepare.status).toBe("malformed-attempt");
  expect(result.reserve.status).toBe("malformed-attempt");
});

for (const flaw of ["mutationId", "source-target", "scope"]) {
  test(`malformed may_have_sent ${flaw} remains a high-severity unresolved stop`, async ({ page }) => {
    const result = await page.evaluate(async flaw => {
      await h.setup(); await h.movement(0.3);
      const attempt = (await h.prepare()).attempt;
      await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
      let corrupt = { ...attempt, status: "may_have_sent" };
      if (flaw === "mutationId") corrupt.request = { ...attempt.request,
        mutationId: "00000000-0000-4000-8000-000000000000" };
      if (flaw === "source-target") corrupt.sourceFence = { ...attempt.sourceFence,
        action: { ...attempt.sourceFence.action,
          target: { ...attempt.sourceFence.action.target, progress: 0.9 } } };
      if (flaw === "scope") corrupt.sourceScope = { ...attempt.sourceScope,
        bindingId: "wrong-binding" };
      await h.raw("progressCloudAttempts", tx => tx.objectStore("progressCloudAttempts")
        .put(corrupt));
      return { read: await h.repo.getProgressCloudAttempt(...h.args, attempt.attemptId),
        list: await h.repo.listProgressCloudAttempts(...h.args),
        next: await h.prepare() };
    }, flaw);
    expect(result.read).toMatchObject({ status: "malformed-attempt", severity: "high" });
    expect(result.list.status).toBe("malformed-attempt");
    expect(result.next.status).toBe("malformed-attempt");
  });
}

for (const change of ["observation", "epoch", "fingerprint", "outbox", "bootstrap"]) {
  test(`dispatch revalidation denies ${change} advancement`, async ({ page }) => {
    const result = await page.evaluate(async change => {
      await h.setup(); await h.movement(0.3);
      const attempt = (await h.prepare()).attempt;
      if (change === "observation") await h.repo.recordProgressRemoteObservation(...h.args, {
        kind: "revision", revision: "revision:11", cursor: "cursor:11",
        parentReadingEpoch: h.epoch, contentFingerprint: h.fp,
        checkpoint: { progress: 0.2, paragraphIndex: 2 }
      });
      if (["epoch", "fingerprint"].includes(change)) await h.raw("articleSidecars", tx => {
        const store = tx.objectStore("articleSidecars");
        const request = store.get([h.binding.ownerId, h.article.id]);
        request.onsuccess = () => {
          const row = request.result;
          store.put({ ...row, knownRevision: "revision:2", serverReadingContext: {
            articleRevision: "revision:2", readingEpoch: change === "epoch" ? h.epoch2 : h.epoch,
            contentFingerprint: change === "fingerprint" ? `sha256:${"b".repeat(64)}` : h.fp,
            lifecycle: "active" } });
        };
      });
      if (change === "outbox") await h.raw("articleOutbox", tx => tx.objectStore("articleOutbox")
        .put({ ...h.binding, articleId: h.article.id, mutationId: "pending-article" }));
      if (change === "bootstrap") await h.raw("control", tx => {
        const store = tx.objectStore("control");
        const request = store.getAll();
        request.onsuccess = () => {
          const row = request.result.find(item => item.kind === "article-bootstrap-state" &&
            item.ownerId === h.binding.ownerId);
          store.put({ ...row, status: "in_progress", phase: "catching-up" });
        };
      });
      const reserved = await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
      return { reserved, stored: await h.repo.getProgressCloudAttempt(...h.args, attempt.attemptId) };
    }, change);
    expect(result.reserved.status).not.toBe("may_have_sent");
    expect(result.stored.attempt.status).toBe("blocked_before_dispatch");
  });
}

test("title-only Article revision advance preserves compatible epoch and dispatch readiness", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.raw("articleSidecars", tx => {
      const store = tx.objectStore("articleSidecars");
      const request = store.get([h.binding.ownerId, h.article.id]);
      request.onsuccess = () => store.put({ ...request.result, knownRevision: "revision:2",
        serverReadingContext: { articleRevision: "revision:2", readingEpoch: h.epoch,
          contentFingerprint: h.fp, lifecycle: "active" } });
    });
    return h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
  });
  expect(result.status).toBe("may_have_sent");
  expect(result.immutableRequest.expectedProgressRevision).toBe("revision:10");
});

test("newer confirmed supersedes prepared; newer pending defers without blocking", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const first = (await h.prepare()).attempt;
    const context = await h.lib.getProgressContext(h.article.id, h.binding);
    const pending = await h.repo.prepareProgressMovement({ ...h.binding, articleId: h.article.id,
      target: h.target(0.4), beforeResume: context.article.reading.resume,
      articleFence: context.fence, scope: context.scope });
    const deferred = await h.flow.reserveCloudAttemptForDispatch(...h.args, first.attemptId);
    const before = await h.repo.getProgressCloudAttempt(...h.args, first.attemptId);
    await h.repo.settleProgressMovement(...h.args, pending.pending.actionId,
      "quarantine", "fixture-aborted-pending");
    await h.movement(0.5);
    const superseded = await h.flow.reserveCloudAttemptForDispatch(...h.args, first.attemptId);
    return { deferred, before, superseded,
      after: await h.repo.getProgressCloudAttempt(...h.args, first.attemptId) };
  });
  expect(result.deferred.status).toBe("deferred-newer-pending");
  expect(result.before.attempt.status).toBe("prepared");
  expect(result.superseded).toMatchObject({ status: "not-ready", reason: "newer-confirmed" });
  expect(result.after.attempt.status).toBe("superseded");
});

test("Account Switch and new binding reject old recovery and reservation", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const context = await h.lib.getProgressContext(h.article.id, h.binding, { initialize: false });
    const awaiting = (await h.repo.prepareProgressCloudAttempt(...h.args, {
      scope: context.scope, fence: context.fence, checkpoint: context.article.reading.resume,
      fingerprint: h.fp, articleActive: true, cloudEligible: true, transitionInactive: true
    })).attempt;
    const next = { ...h.binding, bindingId: "attempt-binding-a-new" };
    await h.raw("control", tx => tx.objectStore("control")
      .put({ key: "workspace-binding", ...next }));
    const wrongBinding = await h.flow.resumeCloudAttemptPostflight(...h.args, awaiting.attemptId);
    await h.raw("control", tx => tx.objectStore("control")
      .put({ key: "workspace-binding", ...h.binding }));
    const recovered = await h.flow.resumeCloudAttemptPostflight(...h.args, awaiting.attemptId);
    const other = { ownerId: "attempt-owner-b", bindingId: "attempt-binding-b" };
    await h.repo.replaceWorkspaceBinding({ from: h.binding, to: other,
      accountLabel: "b@example.test" });
    h.setAuthOwner(other.ownerId);
    const oldRecovery = await h.flow.resumeCloudAttemptPostflight(...h.args, awaiting.attemptId);
    const oldReserve = await h.flow.reserveCloudAttemptForDispatch(...h.args, awaiting.attemptId);
    return { wrongBinding, recovered, oldRecovery, oldReserve };
  });
  expect(result.wrongBinding.status).toBe("not-ready");
  expect(result.recovered.status).toBe("prepared");
  expect(result.oldRecovery.status).toBe("not-ready");
  expect(result.oldReserve.status).toBe("not-ready");
});

test("Account Switch during awaiting recovery cannot promote the old attempt", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const context = await h.lib.getProgressContext(h.article.id, h.binding, { initialize: false });
    const attempt = (await h.repo.prepareProgressCloudAttempt(...h.args, {
      scope: context.scope, fence: context.fence, checkpoint: context.article.reading.resume,
      fingerprint: h.fp, articleActive: true, cloudEligible: true, transitionInactive: true
    })).attempt;
    const original = SubtleCrypto.prototype.digest;
    let injected = false;
    SubtleCrypto.prototype.digest = async function(...args) {
      if (!injected) {
        injected = true;
        await h.repo.replaceWorkspaceBinding({ from: h.binding,
          to: { ownerId: "attempt-owner-b", bindingId: "attempt-binding-b" },
          accountLabel: "b@example.test" });
        h.setAuthOwner("attempt-owner-b");
      }
      return original.apply(this, args);
    };
    let recovered;
    try { recovered = await h.flow.resumeCloudAttemptPostflight(...h.args, attempt.attemptId); }
    finally { SubtleCrypto.prototype.digest = original; }
    const db = await h.repo.openDatabase();
    const raw = await new Promise(resolve => {
      const request = db.transaction("progressCloudAttempts").objectStore("progressCloudAttempts")
        .get([...h.args, attempt.attemptId]);
      request.onsuccess = () => resolve(request.result);
    });
    return { injected, recovered, raw };
  });
  expect(result.injected).toBe(true);
  expect(result.recovered.status).toBe("not-ready");
  expect(result.raw.status).toBe("blocked_before_dispatch");
});

test("Account Switch between Library revalidation and SyncDB reservation denies dispatch", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    const original = SubtleCrypto.prototype.digest;
    let calls = 0;
    SubtleCrypto.prototype.digest = async function(...args) {
      calls += 1;
      if (calls === 2) {
        await h.repo.replaceWorkspaceBinding({ from: h.binding,
          to: { ownerId: "attempt-owner-b", bindingId: "attempt-binding-b" },
          accountLabel: "b@example.test" });
        h.setAuthOwner("attempt-owner-b");
      }
      return original.apply(this, args);
    };
    let reserved;
    try { reserved = await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId); }
    finally { SubtleCrypto.prototype.digest = original; }
    const db = await h.repo.openDatabase();
    const raw = await new Promise(resolve => {
      const request = db.transaction("progressCloudAttempts").objectStore("progressCloudAttempts")
        .get([...h.args, attempt.attemptId]);
      request.onsuccess = () => resolve(request.result);
    });
    return { calls, reserved, raw };
  });
  expect(result.calls).toBeGreaterThanOrEqual(2);
  expect(result.reserved.status).toBe("not-ready");
  expect(result.raw.status).toBe("blocked_before_dispatch");
});

test("may_have_sent remains retained but inaccessible after Account Switch", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    const other = { ownerId: "attempt-owner-b", bindingId: "attempt-binding-b" };
    await h.repo.replaceWorkspaceBinding({ from: h.binding, to: other,
      accountLabel: "b@example.test" });
    h.setAuthOwner(other.ownerId);
    const oldRead = await h.repo.getProgressCloudAttempt(...h.args, attempt.attemptId);
    const oldReserve = await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    const db = await h.repo.openDatabase();
    const raw = await new Promise(resolve => {
      const request = db.transaction("progressCloudAttempts").objectStore("progressCloudAttempts")
        .get([...h.args, attempt.attemptId]);
      request.onsuccess = () => resolve(request.result);
    });
    return { oldRead, oldReserve, raw };
  });
  expect(result.oldRead.status).toBe("blocked");
  expect(result.oldReserve.status).toBe("not-ready");
  expect(result.raw.status).toBe("may_have_sent");
});

test("anonymous and disabled CREATE path cannot reserve", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const attempt = (await h.prepare()).attempt;
    h.setAuthOwner(null);
    const anonymous = await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    const directAnonymous = await h.repo.reserveProgressCloudAttemptForDispatch(...h.args,
      attempt.attemptId);
    h.setAuthOwner(h.binding.ownerId);
    await h.raw("progressCloudAttempts", tx => {
      const store = tx.objectStore("progressCloudAttempts");
      store.put({ ...attempt, request: { ...attempt.request, expectedState: "absent" } });
    });
    const create = await h.flow.reserveCloudAttemptForDispatch(...h.args, attempt.attemptId);
    return { anonymous, directAnonymous, create };
  });
  expect(result.anonymous.status).toBe("not-ready");
  expect(result.directAnonymous.status).toBe("not-ready");
  expect(result.create.status).toBe("malformed-attempt");
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
