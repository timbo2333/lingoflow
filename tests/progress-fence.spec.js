const { test, expect } = require("./progress-strict-test");

const binding = { ownerId: "fence-owner", bindingId: "fence-binding" };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1"));
  await page.goto("/");
  await page.evaluate(async owner => {
    await window.LingoFlowSyncStateRepository.bindWorkspace(owner);
    window.LingoFlowSupabaseAuth = { ...window.LingoFlowSupabaseAuth,
      getState: () => ({ status: "authenticated", user: { id: owner.ownerId } }) };
  }, binding);
});

test("durable localSeq wins without Web Locks, in either commit order", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const lib = window.LingoFlowArticleLibrary;
    const repo = window.LingoFlowSyncStateRepository;
    const resume = window.LingoFlowReadingResume;
    const article = await lib.createArticle({ content: "No lock ordering" });
    const fingerprint = await resume.fingerprintContent(article.content);
    const context = await lib.getProgressContext(article.id, owner);
    const target = progress => resume.createCheckpoint({ progress, paragraphIndex: 3 }, fingerprint);
    const prepare = value => repo.prepareProgressMovement({ ...owner,
      articleId: article.id, beforeResume: null, target: target(value),
      scope: context.scope, articleFence: context.fence });
    const old = await prepare(0.8);
    const newer = await prepare(0.3);
    const commit = pending => lib.commitReadingResumeIfCurrent({ articleId: article.id,
      expectedContent: article.content, contentFingerprint: fingerprint,
      beforeResume: null, target: pending.target, scope: context.scope,
      expectedFence: context.fence, action: pending });
    const second = await commit(newer.pending);
    const first = await commit(old.pending);
    const saved = await lib.getArticle(article.id);
    return { oldSeq: old.pending.localSeq, newSeq: newer.pending.localSeq,
      second: second.status, first: first.status, progress: saved.reading.resume.progress };
  }, binding);
  expect(result).toEqual({ oldSeq: 1, newSeq: 2,
    second: "committed", first: "stale-action", progress: 0.3 });
});

test("three tab-style actions converge on seq3, never maximum progress", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const lib = window.LingoFlowArticleLibrary;
    const repo = window.LingoFlowSyncStateRepository;
    const resume = window.LingoFlowReadingResume;
    const article = await lib.createArticle({ content: "Three independent actions" });
    const fingerprint = await resume.fingerprintContent(article.content);
    const context = await lib.getProgressContext(article.id, owner);
    const actions = [];
    for (const progress of [0.8, 0.5, 0.2]) {
      const prepared = await repo.prepareProgressMovement({ ...owner,
        articleId: article.id, beforeResume: null, scope: context.scope,
        articleFence: context.fence,
        target: resume.createCheckpoint({ progress, paragraphIndex: 2 }, fingerprint) });
      actions.push(prepared.pending);
    }
    const statuses = [];
    for (const action of [actions[1], actions[0], actions[2]]) {
      const commit = await lib.commitReadingResumeIfCurrent({ articleId: article.id,
        expectedContent: article.content, contentFingerprint: fingerprint,
        beforeResume: null, target: action.target, scope: context.scope,
        expectedFence: context.fence, action });
      statuses.push(commit.status);
    }
    return { seq: actions.map(action => action.localSeq), statuses,
      final: (await lib.getArticle(article.id)).reading.resume.progress };
  }, binding);
  expect(result).toEqual({ seq: [1, 2, 3],
    statuses: ["committed", "stale-action", "committed"], final: 0.2 });
});

test("separate browser tabs share durable sequence and reject delayed seq1", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:4173" });
  const tabs = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
  try {
    await Promise.all(tabs.map(tab => tab.goto("/")));
    await tabs[0].evaluate(owner => window.LingoFlowSyncStateRepository.bindWorkspace(owner), binding);
    const article = await tabs[0].evaluate(() => window.LingoFlowArticleLibrary.createArticle({
      content: "Three real tabs, one local sequence" }));
    const actions = [];
    for (const [index, progress] of [0.8, 0.5, 0.2].entries()) {
      actions.push(await tabs[index].evaluate(async ({ owner, article, progress }) => {
        const lib = window.LingoFlowArticleLibrary;
        const resume = window.LingoFlowReadingResume;
        const context = await lib.getProgressContext(article.id, owner);
        const fingerprint = await resume.fingerprintContent(article.content);
        const prepared = await window.LingoFlowSyncStateRepository.prepareProgressMovement({
          ...owner, articleId: article.id, beforeResume: null,
          scope: context.scope, articleFence: context.fence,
          target: resume.createCheckpoint({ progress, paragraphIndex: 2 }, fingerprint)
        });
        return { pending: prepared.pending, context };
      }, { owner: binding, article, progress }));
    }
    async function commit(tab, action) {
      return tab.evaluate(async ({ article, action }) => {
        const fingerprint = await window.LingoFlowReadingResume.fingerprintContent(article.content);
        return window.LingoFlowArticleLibrary.commitReadingResumeIfCurrent({
          articleId: article.id, expectedContent: article.content, contentFingerprint: fingerprint,
          beforeResume: null, target: action.pending.target,
          scope: action.context.scope, expectedFence: action.context.fence,
          action: action.pending
        });
      }, { article, action });
    }
    const seq3 = await commit(tabs[2], actions[2]);
    const seq1 = await commit(tabs[0], actions[0]);
    const seq2 = await commit(tabs[1], actions[1]);
    const final = await tabs[0].evaluate(id => window.LingoFlowArticleLibrary.getArticle(id), article.id);
    expect(actions.map(action => action.pending.localSeq)).toEqual([1, 2, 3]);
    expect([seq3.status, seq1.status, seq2.status]).toEqual([
      "committed", "stale-action", "stale-action"]);
    expect(final.reading.resume.progress).toBe(0.2);
  } finally {
    await context.close();
  }
});

test("service converges on latest desired when Web Locks are unavailable", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    const lib = window.LingoFlowArticleLibrary;
    const repo = window.LingoFlowSyncStateRepository;
    const resume = window.LingoFlowReadingResume;
    const article = await lib.createArticle({ content: "No Web Locks" });
    const fingerprint = await resume.fingerprintContent(article.content);
    const make = value => resume.createCheckpoint({ progress: value,
      paragraphIndex: Math.round(value * 10) }, fingerprint);
    const [first, second] = await Promise.all([
      window.LingoFlowProgressLocalDesired.writeRealMovement(article.id, make(0.8)),
      window.LingoFlowProgressLocalDesired.writeRealMovement(article.id, make(0.3))
    ]);
    const row = await repo.getProgressDesired(owner.ownerId, owner.bindingId, article.id);
    const current = await lib.getArticle(article.id);
    return { statuses: [first.status, second.status], seq: row.record.localSeq,
      confirmed: row.record.confirmed?.checkpoint.progress,
      actual: current.reading.resume.progress };
  }, binding);
  expect(result.seq).toBe(2);
  expect(result.confirmed).toBe(0.3);
  expect(result.actual).toBe(0.3);
  expect(result.statuses).toEqual(expect.arrayContaining(["confirmed", "superseded"]));
});

test("newer action may supersede a trusted older fence, not an unknown Resume", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const lib = window.LingoFlowArticleLibrary;
    const repo = window.LingoFlowSyncStateRepository;
    const resume = window.LingoFlowReadingResume;
    const article = await lib.createArticle({ content: "Trusted successor" });
    const fingerprint = await resume.fingerprintContent(article.content);
    const context = await lib.getProgressContext(article.id, owner);
    const target = value => resume.createCheckpoint({ progress: value, paragraphIndex: 3 }, fingerprint);
    const prepare = value => repo.prepareProgressMovement({ ...owner,
      articleId: article.id, beforeResume: null, target: target(value),
      scope: context.scope, articleFence: context.fence });
    const old = (await prepare(0.8)).pending;
    const newer = (await prepare(0.3)).pending;
    const commit = action => lib.commitReadingResumeIfCurrent({ articleId: article.id,
      expectedContent: article.content, contentFingerprint: fingerprint,
      beforeResume: null, target: action.target, scope: context.scope,
      expectedFence: context.fence, action });
    const first = await commit(old);
    const second = await commit(newer);
    const unknown = target(0.5);
    await lib.updateArticleReading(article.id, { resume: unknown });
    const later = (await repo.prepareProgressMovement({ ...owner, articleId: article.id,
      beforeResume: null, target: target(0.9), scope: context.scope,
      articleFence: context.fence })).pending;
    const rejected = await commit(later);
    return { first: first.status, second: second.status, rejected: rejected.status,
      progress: (await lib.getArticle(article.id)).reading.resume.progress };
  }, binding);
  expect(result).toEqual({ first: "committed", second: "committed",
    rejected: "unknown-resume-change", progress: 0.5 });
});

test("same Article ID and Resume after A to B scope rotation rejects old tab CAS", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const lib = window.LingoFlowArticleLibrary;
    const resume = window.LingoFlowReadingResume;
    const article = await lib.createArticle({ content: "Same identity after switch" });
    const fingerprint = await resume.fingerprintContent(article.content);
    const old = await lib.getProgressContext(article.id, owner);
    const switched = await lib.replaceAllArticles([article], [article],
      { nextProgressScope: { ownerId: "new-owner", bindingId: "new-binding" } });
    const rejected = await lib.commitReadingResumeIfCurrent({
      articleId: article.id, expectedContent: article.content, contentFingerprint: fingerprint,
      beforeResume: null, target: resume.createCheckpoint({ progress: 0.8,
        paragraphIndex: 8 }, fingerprint), scope: old.scope, expectedFence: old.fence });
    return { switched: switched.status, rejected: rejected.status,
      resume: (await lib.getArticle(article.id)).reading.resume || null };
  }, binding);
  expect(result).toEqual({ switched: "replaced", rejected: "scope-mismatch", resume: null });
});

test("delete and restore invalidate old lifecycle, while title edit does not", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const lib = window.LingoFlowArticleLibrary;
    const resume = window.LingoFlowReadingResume;
    const article = await lib.createArticle({ content: "Lifecycle ABA" });
    const fingerprint = await resume.fingerprintContent(article.content);
    const old = await lib.getProgressContext(article.id, owner);
    await lib.updateArticle(article.id, { title: "New title" });
    const afterTitle = await lib.getProgressContext(article.id, owner);
    await lib.updateArticle(article.id, { deletedAt: new Date().toISOString() });
    await lib.updateArticle(article.id, { deletedAt: null });
    const rejected = await lib.commitReadingResumeIfCurrent({ articleId: article.id,
      expectedContent: article.content, contentFingerprint: fingerprint,
      beforeResume: null, target: resume.createCheckpoint({ progress: 0.4,
        paragraphIndex: 4 }, fingerprint), scope: old.scope, expectedFence: old.fence });
    return { titleKeepsLifecycle: old.fence.lifecycleToken === afterTitle.fence.lifecycleToken,
      rejected: rejected.status };
  }, binding);
  expect(result).toEqual({ titleKeepsLifecycle: true, rejected: "lifecycle-mismatch" });
});

test("confirmed is ready only while its exact Article fence remains current", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const lib = window.LingoFlowArticleLibrary;
    const resume = window.LingoFlowReadingResume;
    const progress = window.LingoFlowProgressLocalDesired;
    const article = await lib.createArticle({ content: "Dynamic ready gate" });
    const fingerprint = await resume.fingerprintContent(article.content);
    await progress.writeRealMovement(article.id,
      resume.createCheckpoint({ progress: 0.7, paragraphIndex: 7 }, fingerprint));
    const ready = await progress.evaluateConfirmed(owner.ownerId, owner.bindingId, article.id);
    await lib.updateArticleReading(article.id, { resume:
      resume.createCheckpoint({ progress: 0.2, paragraphIndex: 2 }, fingerprint) });
    const blocked = await progress.evaluateConfirmed(owner.ownerId, owner.bindingId, article.id);
    return { ready: ready.status, blocked: blocked.status };
  }, binding);
  expect(result).toEqual({ ready: "ready", blocked: "blocked" });
});

test("fenced Resume-only movement creates no Article mutation or push work", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const lib = window.LingoFlowArticleLibrary;
    const repo = window.LingoFlowSyncStateRepository;
    const resume = window.LingoFlowReadingResume;
    const article = await lib.createArticle({ content: "Resume without Article sync echo" });
    const fingerprint = await resume.fingerprintContent(article.content);
    const saved = await window.LingoFlowProgressLocalDesired.writeRealMovement(article.id,
      resume.createCheckpoint({ progress: 0.4, paragraphIndex: 4 }, fingerprint));
    const outbox = await repo.listArticleMutations(owner.ownerId, owner.bindingId);
    const after = await lib.getArticle(article.id);
    return { status: saved.status, outbox: outbox.items.length,
      updatedAtUnchanged: after.updatedAt === article.updatedAt,
      lastReadAtUnchanged: after.lastReadAt === article.lastReadAt };
  }, binding);
  expect(result).toEqual({ status: "confirmed", outbox: 0,
    updatedAtUnchanged: true, lastReadAtUnchanged: true });
});

test("Article change between verify and promote leaves old confirmed non-ready", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const lib = window.LingoFlowArticleLibrary;
    const repo = window.LingoFlowSyncStateRepository;
    const resume = window.LingoFlowReadingResume;
    const article = await lib.createArticle({ content: "Promotion race" });
    const fingerprint = await resume.fingerprintContent(article.content);
    const context = await lib.getProgressContext(article.id, owner);
    const target = resume.createCheckpoint({ progress: 0.8, paragraphIndex: 8 }, fingerprint);
    const prepared = await repo.prepareProgressMovement({ ...owner,
      articleId: article.id, beforeResume: null, target,
      scope: context.scope, articleFence: context.fence });
    await lib.commitReadingResumeIfCurrent({ articleId: article.id,
      expectedContent: article.content, contentFingerprint: fingerprint,
      beforeResume: null, target, scope: context.scope,
      expectedFence: context.fence, action: prepared.pending });
    const verified = await lib.getProgressContext(article.id, owner);
    await lib.updateArticleReading(article.id, { resume:
      resume.createCheckpoint({ progress: 0.25, paragraphIndex: 2 }, fingerprint) });
    const settled = await repo.settleProgressMovement(owner.ownerId, owner.bindingId,
      article.id, prepared.pending.actionId, "promote", null, verified.fence);
    const eligibility = await window.LingoFlowProgressLocalDesired.evaluateConfirmed(
      owner.ownerId, owner.bindingId, article.id);
    return { settled: settled.status, eligibility: eligibility.status,
      confirmed: settled.record.confirmed.checkpoint.progress };
  }, binding);
  expect(result).toEqual({ settled: "confirmed", eligibility: "blocked", confirmed: 0.8 });
});

test("switch and old conditional write serialize without contaminating new scope", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const lib = window.LingoFlowArticleLibrary;
    const resume = window.LingoFlowReadingResume;
    const article = await lib.createArticle({ content: "Concurrent switch" });
    const fingerprint = await resume.fingerprintContent(article.content);
    const old = await lib.getProgressContext(article.id, owner);
    const [switchResult, writeResult] = await Promise.all([
      lib.replaceAllArticles([article], [article], { nextProgressScope:
        { ownerId: "new-owner", bindingId: "new-binding" } }),
      lib.commitReadingResumeIfCurrent({ articleId: article.id,
        expectedContent: article.content, contentFingerprint: fingerprint,
        beforeResume: null, target: resume.createCheckpoint({ progress: 0.9,
          paragraphIndex: 9 }, fingerprint), scope: old.scope, expectedFence: old.fence })
    ]);
    const current = await lib.getProgressContext(article.id);
    return { switched: switchResult.status, write: writeResult.status,
      owner: current.scope.ownerId, resume: current.article.reading.resume || null };
  }, binding);
  if (result.switched === "replaced") {
    expect(result.write).toBe("scope-mismatch");
    expect(result.owner).toBe("new-owner");
    expect(result.resume).toBeNull();
  } else {
    expect(result.switched).toBe("blocked");
    expect(result.write).toBe("committed");
    expect(result.owner).toBe("fence-owner");
  }
});

test("Progress repository outage preserves local Resume without manufacturing desired", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const lib = window.LingoFlowArticleLibrary;
    const repo = window.LingoFlowSyncStateRepository;
    const resume = window.LingoFlowReadingResume;
    const article = await lib.createArticle({ content: "Offline desired infrastructure" });
    const fingerprint = await resume.fingerprintContent(article.content);
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function(stores, mode, ...rest) {
      if (this.name === "LingoFlowSyncDB" && mode === "readwrite" &&
          Array.from(stores).includes("progressDesired")) throw new Error("test storage outage");
      return original.call(this, stores, mode, ...rest);
    };
    let saved;
    try {
      saved = await window.LingoFlowProgressLocalDesired.writeRealMovement(article.id,
        resume.createCheckpoint({ progress: 0.55, paragraphIndex: 5 }, fingerprint));
    } finally {
      IDBDatabase.prototype.transaction = original;
    }
    const row = await repo.getProgressDesired(owner.ownerId, owner.bindingId, article.id);
    const context = await lib.getProgressContext(article.id, owner);
    return { status: saved.status, actual: context.article.reading.resume.progress,
      desired: row.record, action: context.fence.action };
  }, binding);
  expect(result).toEqual({ status: "local-only", actual: 0.55,
    desired: null, action: null });
});

test("prepared read failure keeps action provenance; retry reuses seq and newer action wins", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    const lib = window.LingoFlowArticleLibrary;
    const repo = window.LingoFlowSyncStateRepository;
    const resume = window.LingoFlowReadingResume;
    const progress = window.LingoFlowProgressLocalDesired;
    const article = await lib.createArticle({ content: "Prepared read failure" });
    const fingerprint = await resume.fingerprintContent(article.content);
    const target = value => resume.createCheckpoint({ progress: value,
      paragraphIndex: Math.round(value * 10) }, fingerprint);
    const oldTarget = target(0.8);
    const newTarget = target(0.3);
    const original = IDBDatabase.prototype.transaction;
    let failOnce = true;
    IDBDatabase.prototype.transaction = function(stores, mode, ...rest) {
      if (failOnce && this.name === "LingoFlowSyncDB" && mode === "readonly" &&
          Array.from(stores).includes("progressDesired")) {
        failOnce = false;
        throw new Error("injected post-prepare read outage");
      }
      return original.call(this, stores, mode, ...rest);
    };
    let first;
    try { first = await progress.writeRealMovement(article.id, oldTarget); }
    finally { IDBDatabase.prototype.transaction = original; }
    const afterFailure = await lib.getProgressContext(article.id, owner);
    const pending = await repo.getProgressDesired(owner.ownerId, owner.bindingId, article.id);
    const retry = await progress.writeRealMovement(article.id,
      { ...oldTarget, updatedAt: "2026-10-01T01:00:00.000Z" });
    const afterRetry = await repo.getProgressDesired(owner.ownerId, owner.bindingId, article.id);
    const newer = await progress.writeRealMovement(article.id, newTarget);
    const final = await repo.getProgressDesired(owner.ownerId, owner.bindingId, article.id);
    return { first: first.status, firstActionId: first.actionId,
      afterFailureResume: afterFailure.article.reading.resume || null,
      afterFailureFence: afterFailure.fence.action,
      pendingActionId: pending.record.pending.actionId,
      retry: retry.status, retrySeq: afterRetry.record.localSeq,
      newer: newer.status, finalSeq: final.record.localSeq,
      finalProgress: (await lib.getArticle(article.id)).reading.resume.progress };
  }, binding);
  expect(result).toEqual({ first: "retryable", firstActionId: result.pendingActionId,
    afterFailureResume: null, afterFailureFence: null,
    pendingActionId: result.firstActionId, retry: "confirmed", retrySeq: 1,
    newer: "confirmed", finalSeq: 2, finalProgress: 0.3 });
});

test("older prepared retry cannot overtake another tab's newer action", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    const lib = window.LingoFlowArticleLibrary;
    const repo = window.LingoFlowSyncStateRepository;
    const resume = window.LingoFlowReadingResume;
    const progress = window.LingoFlowProgressLocalDesired;
    const article = await lib.createArticle({ content: "Prepared retry ordering" });
    const fingerprint = await resume.fingerprintContent(article.content);
    const older = resume.createCheckpoint({ progress: 0.8, paragraphIndex: 8 }, fingerprint);
    const newer = resume.createCheckpoint({ progress: 0.3, paragraphIndex: 3 }, fingerprint);
    const original = IDBDatabase.prototype.transaction;
    let failOnce = true;
    IDBDatabase.prototype.transaction = function(stores, mode, ...rest) {
      if (failOnce && this.name === "LingoFlowSyncDB" && mode === "readonly" &&
          Array.from(stores).includes("progressDesired")) {
        failOnce = false;
        throw new Error("injected older apply outage");
      }
      return original.call(this, stores, mode, ...rest);
    };
    let failed;
    try { failed = await progress.writeRealMovement(article.id, older); }
    finally { IDBDatabase.prototype.transaction = original; }
    const context = await lib.getProgressContext(article.id, owner);
    const second = await repo.prepareProgressMovement({ ...owner, articleId: article.id,
      target: newer, beforeResume: null, scope: context.scope, articleFence: context.fence });
    const written = await lib.commitReadingResumeIfCurrent({ articleId: article.id,
      expectedContent: article.content, contentFingerprint: fingerprint,
      beforeResume: null, target: newer, scope: context.scope,
      expectedFence: context.fence, action: second.pending });
    await repo.settleProgressMovement(owner.ownerId, owner.bindingId, article.id,
      second.pending.actionId, "promote", null, written.fence);
    const delayed = await progress.writeRealMovement(article.id,
      { ...older, updatedAt: "2026-10-01T02:00:00.000Z" });
    const row = await repo.getProgressDesired(owner.ownerId, owner.bindingId, article.id);
    return { failed: failed.status, second: written.status, delayed: delayed.status,
      seq: row.record.localSeq, progress: (await lib.getArticle(article.id)).reading.resume.progress };
  }, binding);
  expect(result).toEqual({ failed: "retryable", second: "committed",
    delayed: "superseded", seq: 2, progress: 0.3 });
});

test("settle outage retains written fence and pending for idempotent reconciliation", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const lib = window.LingoFlowArticleLibrary;
    const repo = window.LingoFlowSyncStateRepository;
    const resume = window.LingoFlowReadingResume;
    const progress = window.LingoFlowProgressLocalDesired;
    const article = await lib.createArticle({ content: "Settle failure recovery" });
    const fingerprint = await resume.fingerprintContent(article.content);
    const target = resume.createCheckpoint({ progress: 0.6, paragraphIndex: 6 }, fingerprint);
    const original = IDBDatabase.prototype.transaction;
    let writes = 0;
    IDBDatabase.prototype.transaction = function(stores, mode, ...rest) {
      if (this.name === "LingoFlowSyncDB" && mode === "readwrite" &&
          Array.from(stores).includes("progressDesired") && ++writes === 2) {
        throw new Error("injected settle outage");
      }
      return original.call(this, stores, mode, ...rest);
    };
    let first;
    try { first = await progress.writeRealMovement(article.id, target); }
    finally { IDBDatabase.prototype.transaction = original; }
    const context = await lib.getProgressContext(article.id, owner);
    const before = await repo.getProgressDesired(owner.ownerId, owner.bindingId, article.id);
    const recovered = await progress.reconcile();
    const again = await progress.reconcile();
    const after = await repo.getProgressDesired(owner.ownerId, owner.bindingId, article.id);
    return { first: first.status, firstActionId: first.actionId,
      writtenActionId: context.fence.action?.actionId,
      writtenProgress: context.article.reading.resume.progress,
      pendingActionId: before.record.pending?.actionId,
      recovered: recovered.results[0]?.status, repeatedCount: again.results.length,
      localSeq: after.record.localSeq, confirmedProgress: after.record.confirmed.checkpoint.progress };
  }, binding);
  expect(result).toEqual({ first: "retryable", firstActionId: result.pendingActionId,
    writtenActionId: result.firstActionId, writtenProgress: 0.6,
    pendingActionId: result.firstActionId, recovered: "confirmed", repeatedCount: 0,
    localSeq: 1, confirmedProgress: 0.6 });
});

test("workspace transition defers prepared movement without quarantining it", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const lib = window.LingoFlowArticleLibrary;
    const repo = window.LingoFlowSyncStateRepository;
    const resume = window.LingoFlowReadingResume;
    const progress = window.LingoFlowProgressLocalDesired;
    const article = await lib.createArticle({ content: "Pending through transition" });
    const fingerprint = await resume.fingerprintContent(article.content);
    const context = await lib.getProgressContext(article.id, owner);
    await repo.prepareProgressMovement({ ...owner, articleId: article.id,
      target: resume.createCheckpoint({ progress: 0.4, paragraphIndex: 4 }, fingerprint),
      beforeResume: null, scope: context.scope, articleFence: context.fence });
    const transition = await lib.beginWorkspaceTransition({ from: owner,
      to: { ownerId: "other-owner", bindingId: "other-binding" }, storageSnapshot: [] });
    const deferred = await progress.reconcile();
    const during = await repo.getProgressDesired(owner.ownerId, owner.bindingId, article.id);
    await lib.finishWorkspaceTransition(transition.transition.transitionId, "rollback");
    const recovered = await progress.reconcile();
    const after = await repo.getProgressDesired(owner.ownerId, owner.bindingId, article.id);
    return { deferred: deferred.results[0]?.status, pendingDuring: Boolean(during.record.pending),
      quarantineDuring: during.record.quarantined,
      recovered: recovered.results[0]?.status,
      confirmed: after.record.confirmed?.checkpoint.progress };
  }, binding);
  expect(result).toEqual({ deferred: "retryable", pendingDuring: true,
    quarantineDuring: null, recovered: "confirmed", confirmed: 0.4 });
});

test("authenticated B cannot write A Article even before a Progress scope exists", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const lib = window.LingoFlowArticleLibrary;
    const resume = window.LingoFlowReadingResume;
    const article = await lib.createArticle({ content: "A asset without Progress fence scope" });
    const fingerprint = await resume.fingerprintContent(article.content);
    window.LingoFlowSupabaseAuth = { ...window.LingoFlowSupabaseAuth,
      getState: () => ({ status: "authenticated", user: { id: "other-owner" } }) };
    const attempt = await window.LingoFlowProgressLocalDesired.writeRealMovement(article.id,
      resume.createCheckpoint({ progress: 0.4, paragraphIndex: 4 }, fingerprint));
    return { status: attempt.status, resume: (await lib.getArticle(article.id)).reading.resume || null };
  });
  expect(result).toEqual({ status: "scope-mismatch", resume: null });
});

test("authenticated but not-yet-bound reader keeps Resume local-only on empty workspace", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:4173" });
  const page = await context.newPage();
  try {
    await page.goto("/");
    const result = await page.evaluate(async () => {
      const lib = window.LingoFlowArticleLibrary;
      const resume = window.LingoFlowReadingResume;
      const article = await lib.createArticle({ content: "Unbound but local-first" });
      const fingerprint = await resume.fingerprintContent(article.content);
      window.LingoFlowSupabaseAuth = { ...window.LingoFlowSupabaseAuth,
        getState: () => ({ status: "authenticated", user: { id: "new-owner" } }) };
      const saved = await window.LingoFlowProgressLocalDesired.writeRealMovement(article.id,
        resume.createCheckpoint({ progress: 0.4, paragraphIndex: 4 }, fingerprint));
      const workspace = await window.LingoFlowSyncStateRepository.getWorkspaceBinding();
      const fence = await lib.getProgressContext(article.id);
      return { saved: saved.status, workspace: workspace.status,
        actual: fence.article.reading.resume.progress, action: fence.fence.action };
    });
    expect(result).toEqual({ saved: "local-only", workspace: "missing",
      actual: 0.4, action: null });
  } finally {
    await context.close();
  }
});

test("malformed Resume and malformed Progress row fail closed without blocking unrelated rows", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const lib = window.LingoFlowArticleLibrary;
    const repo = window.LingoFlowSyncStateRepository;
    const resume = window.LingoFlowReadingResume;
    const bad = await lib.createArticle({ content: "Malformed Resume" });
    const good = await lib.createArticle({ content: "Unrelated healthy movement" });
    const db = await lib.openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("articles", "readwrite");
      const request = tx.objectStore("articles").get(bad.id);
      request.onsuccess = () => tx.objectStore("articles").put({ ...request.result,
        reading: { ...request.result.reading, resume: { progress: "bad" } } });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    const badFingerprint = await resume.fingerprintContent(bad.content);
    const denied = await window.LingoFlowProgressLocalDesired.writeRealMovement(bad.id,
      resume.createCheckpoint({ progress: 0.6, paragraphIndex: 6 }, badFingerprint));
    const goodFingerprint = await resume.fingerprintContent(good.content);
    const accepted = await window.LingoFlowProgressLocalDesired.writeRealMovement(good.id,
      resume.createCheckpoint({ progress: 0.4, paragraphIndex: 4 }, goodFingerprint));
    const syncDb = await repo.openDatabase();
    await new Promise((resolve, reject) => {
      const tx = syncDb.transaction("progressDesired", "readwrite");
      tx.objectStore("progressDesired").put({ ownerId: owner.ownerId,
        bindingId: owner.bindingId, articleId: bad.id, localSeq: "bad" });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    const list = await repo.listProgressDesired(owner.ownerId, owner.bindingId);
    return { denied: denied.status, accepted: accepted.status,
      malformedCount: list.malformedCount, healthyCount: list.records.length,
      badResumeStillPresent: (await lib.getArticle(bad.id)).reading.resume.progress };
  }, binding);
  expect(result).toEqual({ denied: "malformed-resume", accepted: "confirmed",
    malformedCount: 1, healthyCount: 1, badResumeStillPresent: "bad" });
});

test("account-switch rollback restores prior Article fence and confirmed desired validity", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const lib = window.LingoFlowArticleLibrary;
    const resume = window.LingoFlowReadingResume;
    const progress = window.LingoFlowProgressLocalDesired;
    const article = await lib.createArticle({ content: "Rollback fence snapshot" });
    const fingerprint = await resume.fingerprintContent(article.content);
    await progress.writeRealMovement(article.id,
      resume.createCheckpoint({ progress: 0.65, paragraphIndex: 6 }, fingerprint));
    const snapshot = await lib.snapshotProgressState();
    const before = await lib.getArticle(article.id);
    await lib.replaceAllArticles([before], [], { nextProgressScope:
      { ownerId: "other-owner", bindingId: "other-binding" } });
    await lib.replaceAllArticles([], [before], { restoreProgressState: snapshot });
    const validity = await progress.evaluateConfirmed(owner.ownerId, owner.bindingId, article.id);
    return { status: validity.status, progress: validity.checkpoint?.progress };
  }, binding);
  expect(result).toEqual({ status: "ready", progress: 0.65 });
});

test("populated LibraryDB v2 upgrades to v3 without changing Article reading", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:4173" });
  const page = await context.newPage();
  try {
    await page.goto("/favicon.svg");
    const original = await page.evaluate(async () => {
      const article = { id: "article:migration", title: "Preserved title",
        content: "Preserved text", sourceType: "paste",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        lastReadAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null, reading: { progress: 0.8, paragraphIndex: 8,
          updatedAt: "2026-01-01T00:00:00.000Z",
          resume: { progress: 0.3, paragraphIndex: 3,
            contentFingerprint: "sha256:" + "a".repeat(64),
            updatedAt: "2026-01-01T00:00:00.000Z" } } };
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("LingoFlowLibraryDB", 2);
        request.onupgradeneeded = () => request.result.createObjectStore("articles", { keyPath: "id" });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction("articles", "readwrite");
        tx.objectStore("articles").put(article);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return article;
    });
    await page.goto("/");
    const result = await page.evaluate(async () => {
      const lib = window.LingoFlowArticleLibrary;
      const db = await lib.openDatabase();
      return { version: db.version, stores: [...db.objectStoreNames],
        article: await lib.getArticle("article:migration") };
    });
    expect(result.version).toBe(3);
    expect(result.stores).toEqual(expect.arrayContaining([
      "articles", "progressFences", "progressControl"]));
    expect(result.article).toEqual(original);
  } finally {
    await context.close();
  }
});
