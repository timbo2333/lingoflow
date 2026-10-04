const { test, expect } = require("./progress-strict-test");

const owner = { ownerId: "progress-owner", bindingId: "progress-binding" };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1"));
  await page.goto("/");
  await page.evaluate(async binding => {
    await window.LingoFlowSyncStateRepository.bindWorkspace(binding);
    const original = window.LingoFlowSupabaseAuth;
    window.LingoFlowSupabaseAuth = { ...original,
      getState: () => ({ status: "authenticated", user: { id: binding.ownerId } }) };
  }, owner);
});

test("forward coalescing and backward reread use latest movement, never max", async ({ page }) => {
  const result = await page.evaluate(async binding => {
    const library = window.LingoFlowArticleLibrary;
    const resume = window.LingoFlowReadingResume;
    const progress = window.LingoFlowProgressLocalDesired;
    const repo = window.LingoFlowSyncStateRepository;
    const article = await library.createArticle({ content: "Progress movement test" });
    const fingerprint = await resume.fingerprintContent(article.content);
    const statuses = [];
    for (const value of [0.2, 0.4, 0.6, 0.8, 0.3]) {
      const target = resume.createCheckpoint({ progress: value, paragraphIndex: Math.round(value * 10) }, fingerprint);
      statuses.push((await progress.writeRealMovement(article.id, target,
        { progress: value, paragraphIndex: Math.round(value * 10) })).status);
    }
    const row = await repo.getProgressDesired(binding.ownerId, binding.bindingId, article.id);
    const saved = await library.getArticle(article.id);
    const outbox = await repo.listArticleMutations(binding.ownerId, binding.bindingId);
    return { statuses, row: row.record, reading: saved.reading,
      lastReadAtUnchanged: saved.lastReadAt === article.lastReadAt,
      articleOutbox: outbox.items.length };
  }, owner);
  expect(result.statuses).toEqual(Array(5).fill("confirmed"));
  expect(result.row.localSeq).toBe(5);
  expect(result.row.pending).toBeNull();
  expect(result.row.confirmed.checkpoint.progress).toBe(0.3);
  expect(result.reading.resume.progress).toBe(0.3);
  expect(result.reading.progress).toBe(0.8); // historical furthest remains separate
  expect(result.lastReadAtUnchanged).toBe(true);
  expect(result.articleOutbox).toBe(0);
});

test("Reader restore alone creates no desired; real scroll creates one without Article outbox", async ({ page }) => {
  const paragraphs = Array.from({ length: 48 }, (_, index) =>
    `Paragraph ${index + 1} has enough English words to make the reading position stable across lines. ` +
    `Only a real scroll after initial restore should create a durable Progress action.`);
  await page.locator("#inputText").fill(["Progress Reader", ...paragraphs].join("\n"));
  await page.getByRole("button", { name: "开始阅读", exact: true }).click();
  await expect(page.locator("#readerLayout")).toHaveClass(/show/);
  const articleId = await page.evaluate(async () =>
    (await window.LingoFlowArticleLibrary.listArticles())[0].id);
  await page.waitForTimeout(900);
  const before = await page.evaluate(async ({ binding, articleId }) =>
    window.LingoFlowSyncStateRepository.getProgressDesired(
      binding.ownerId, binding.bindingId, articleId), { binding: owner, articleId });
  expect(before.record).toBeNull();
  await page.evaluate(() => {
    const metrics = getArticleReadingMetrics();
    window.scrollTo({ top: metrics.startY + metrics.scrollRange * 0.42, behavior: "auto" });
  });
  await expect.poll(async () => page.evaluate(async ({ binding, articleId }) => {
    const row = await window.LingoFlowSyncStateRepository.getProgressDesired(
      binding.ownerId, binding.bindingId, articleId);
    return row.record?.confirmed?.checkpoint?.progress || 0;
  }, { binding: owner, articleId }), { timeout: 4000 }).toBeGreaterThan(0.25);
  const outbox = await page.evaluate(async binding =>
    window.LingoFlowSyncStateRepository.listArticleMutations(
      binding.ownerId, binding.bindingId), owner);
  expect(outbox.items).toHaveLength(0);
});

test("ordinary B1/backup-style Resume writes never manufacture desired", async ({ page }) => {
  const result = await page.evaluate(async binding => {
    const library = window.LingoFlowArticleLibrary;
    const resume = window.LingoFlowReadingResume;
    const repo = window.LingoFlowSyncStateRepository;
    const article = await library.createArticle({ content: "Existing resume" });
    const fingerprint = await resume.fingerprintContent(article.content);
    const checkpoint = resume.createCheckpoint({ progress: 0.45, paragraphIndex: 3 }, fingerprint);
    await library.updateArticleReading(article.id, { resume: checkpoint });
    const row = await repo.getProgressDesired(binding.ownerId, binding.bindingId, article.id);
    await window.LingoFlowProgressLocalDesired.reconcile();
    const later = await repo.getProgressDesired(binding.ownerId, binding.bindingId, article.id);
    return { before: row.record, after: later.record };
  }, owner);
  expect(result).toEqual({ before: null, after: null });
});

test("crash reconciliation promotes applied pending, replays safe before, and is idempotent", async ({ page }) => {
  const result = await page.evaluate(async binding => {
    const library = window.LingoFlowArticleLibrary;
    const resume = window.LingoFlowReadingResume;
    const repo = window.LingoFlowSyncStateRepository;
    const progress = window.LingoFlowProgressLocalDesired;
    const article = await library.createArticle({ content: "Crash windows" });
    const fingerprint = await resume.fingerprintContent(article.content);
    const one = resume.createCheckpoint({ progress: 0.2, paragraphIndex: 2 }, fingerprint);
    const firstContext = await library.getProgressContext(article.id, binding);
    const first = await repo.prepareProgressMovement({ ...binding, articleId: article.id,
      beforeResume: null, target: one, scope: firstContext.scope,
      articleFence: firstContext.fence });
    await library.commitReadingResumeIfCurrent({ articleId: article.id,
      expectedContent: article.content, contentFingerprint: fingerprint,
      beforeResume: null, target: one, scope: firstContext.scope,
      expectedFence: firstContext.fence, action: first.pending });
    const afterFirst = await progress.reconcile();
    const two = resume.createCheckpoint({ progress: 0.4, paragraphIndex: 4 }, fingerprint);
    const secondContext = await library.getProgressContext(article.id, binding);
    const second = await repo.prepareProgressMovement({ ...binding, articleId: article.id,
      beforeResume: one, target: two, scope: secondContext.scope,
      articleFence: secondContext.fence });
    const afterSecond = await progress.reconcile();
    const again = await progress.reconcile();
    const row = await repo.getProgressDesired(binding.ownerId, binding.bindingId, article.id);
    const saved = await library.getArticle(article.id);
    return { first: first.status, second: second.status,
      afterFirst: afterFirst.results[0].status,
      afterSecond: afterSecond.results[0].status,
      again: again.results.length, row: row.record,
      resume: saved.reading.resume };
  }, owner);
  expect(result.first).toBe("prepared");
  expect(result.second).toBe("prepared");
  expect(result.afterFirst).toBe("confirmed");
  expect(result.afterSecond).toBe("confirmed");
  expect(result.again).toBe(0);
  expect(result.row.confirmed.checkpoint.progress).toBe(0.4);
  expect(result.row.pending).toBeNull();
  expect(result.resume.progress).toBe(0.4);
});

test("stale pending and fingerprint mismatch do not overwrite newer local Resume", async ({ page }) => {
  const result = await page.evaluate(async binding => {
    const library = window.LingoFlowArticleLibrary;
    const resume = window.LingoFlowReadingResume;
    const repo = window.LingoFlowSyncStateRepository;
    const progress = window.LingoFlowProgressLocalDesired;
    const article = await library.createArticle({ content: "Stale pending" });
    const fingerprint = await resume.fingerprintContent(article.content);
    const oldTarget = resume.createCheckpoint({ progress: 0.8, paragraphIndex: 8 }, fingerprint);
    const newer = resume.createCheckpoint({ progress: 0.3, paragraphIndex: 3 }, fingerprint);
    const firstContext = await library.getProgressContext(article.id, binding);
    await repo.prepareProgressMovement({ ...binding, articleId: article.id,
      beforeResume: null, target: oldTarget, scope: firstContext.scope,
      articleFence: firstContext.fence });
    await library.updateArticleReading(article.id, { resume: newer });
    const stale = await progress.reconcile();
    const afterStale = await library.getArticle(article.id);
    const row = await repo.getProgressDesired(binding.ownerId, binding.bindingId, article.id);
    const second = await library.createArticle({ content: "Before content edit" });
    const secondFingerprint = await resume.fingerprintContent(second.content);
    const secondContext = await library.getProgressContext(second.id, binding);
    await repo.prepareProgressMovement({ ...binding, articleId: second.id,
      beforeResume: null, scope: secondContext.scope, articleFence: secondContext.fence,
      target: resume.createCheckpoint({ progress: 0.5, paragraphIndex: 5 }, secondFingerprint) });
    await library.updateArticle(second.id, { content: "After content edit" });
    const mismatch = await progress.reconcile();
    const edited = await library.getArticle(second.id);
    return { stale: stale.results[0].status, current: afterStale.reading.resume.progress,
      quarantined: row.record.quarantined?.reason,
      mismatch: mismatch.results[0].status, editedResume: edited.reading.resume || null };
  }, owner);
  expect(result).toEqual({ stale: "blocked", current: 0.3,
    quarantined: "unknown-resume-change", mismatch: "blocked", editedResume: null });
});

test("out-of-order CAS rejects an older tab's stale expected Resume", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:4173" });
  const a = await context.newPage();
  const b = await context.newPage();
  try {
    await a.goto("/");
    await b.goto("/");
    const article = await a.evaluate(() => window.LingoFlowArticleLibrary.createArticle({ content: "Two tabs" }));
    const fingerprint = await a.evaluate(content =>
      window.LingoFlowReadingResume.fingerprintContent(content), article.content);
    const input = { articleId: article.id, expectedContent: article.content,
      contentFingerprint: fingerprint, beforeResume: null };
    const fence = await a.evaluate(id => window.LingoFlowArticleLibrary.getProgressContext(id), article.id);
    input.scope = fence.scope;
    input.expectedFence = fence.fence;
    const newer = await b.evaluate(value => window.LingoFlowArticleLibrary.commitReadingResumeIfCurrent({
      ...value, target: window.LingoFlowReadingResume.createCheckpoint(
        { progress: 0.3, paragraphIndex: 3 }, value.contentFingerprint)
    }), input);
    const older = await a.evaluate(value => window.LingoFlowArticleLibrary.commitReadingResumeIfCurrent({
      ...value, target: window.LingoFlowReadingResume.createCheckpoint(
        { progress: 0.8, paragraphIndex: 8 }, value.contentFingerprint)
    }), input);
    expect(newer.status).toBe("committed");
    expect(older.status).toBe("unknown-resume-change");
    const saved = await a.evaluate(id => window.LingoFlowArticleLibrary.getArticle(id), article.id);
    expect(saved.reading.resume.progress).toBe(0.3);
  } finally {
    await context.close();
  }
});

test("new pending coalesces old intent without discarding confirmed desired", async ({ page }) => {
  const result = await page.evaluate(async binding => {
    const library = window.LingoFlowArticleLibrary;
    const resume = window.LingoFlowReadingResume;
    const repo = window.LingoFlowSyncStateRepository;
    const article = await library.createArticle({ content: "Pending coalescing" });
    const fingerprint = await resume.fingerprintContent(article.content);
    const target = value => resume.createCheckpoint({ progress: value,
      paragraphIndex: Math.round(value * 10) }, fingerprint);
    await window.LingoFlowProgressLocalDesired.writeRealMovement(article.id, target(0.2));
    const confirmed = (await repo.getProgressDesired(binding.ownerId, binding.bindingId,
      article.id)).record.confirmed.checkpoint.progress;
    const current = (await library.getArticle(article.id)).reading.resume;
    const context = await library.getProgressContext(article.id, binding);
    const first = await repo.prepareProgressMovement({ ...binding, articleId: article.id,
      beforeResume: current, target: target(0.4), scope: context.scope,
      articleFence: context.fence });
    const second = await repo.prepareProgressMovement({ ...binding, articleId: article.id,
      beforeResume: current, target: target(0.6), scope: context.scope,
      articleFence: context.fence });
    const row = (await repo.getProgressDesired(binding.ownerId, binding.bindingId, article.id)).record;
    const stale = await repo.settleProgressMovement(binding.ownerId, binding.bindingId,
      article.id, first.pending.actionId, "promote");
    return { confirmed, pending: row.pending.target.progress,
      seq: row.localSeq, stale: stale.status,
      secondSeq: second.pending.localSeq };
  }, owner);
  expect(result).toEqual({ confirmed: 0.2, pending: 0.6,
    seq: 3, stale: "superseded", secondSeq: 3 });
});

test("account switch isolates old owner's durable desired without wiping it", async ({ page }) => {
  const result = await page.evaluate(async binding => {
    const library = window.LingoFlowArticleLibrary;
    const resume = window.LingoFlowReadingResume;
    const repo = window.LingoFlowSyncStateRepository;
    const article = await library.createArticle({ content: "Preserve pending on switch" });
    const fingerprint = await resume.fingerprintContent(article.content);
    await window.LingoFlowProgressLocalDesired.writeRealMovement(article.id,
      resume.createCheckpoint({ progress: 0.35, paragraphIndex: 3 }, fingerprint));
    await window.LingoFlowProgressLocalDesired.prepareAccountSwitch();
    const replacement = await repo.replaceWorkspaceBinding({
      from: binding,
      to: { ownerId: "other-owner", bindingId: "other-binding" },
      accountLabel: "other@example.test"
    });
    const oldAccess = await repo.getProgressDesired(binding.ownerId, binding.bindingId, article.id);
    const newAccess = await repo.getProgressDesired("other-owner", "other-binding", article.id);
    const db = await repo.openDatabase();
    const tx = db.transaction("progressDesired", "readonly");
    const stored = await new Promise(resolve => {
      const request = tx.objectStore("progressDesired").get([
        binding.ownerId, binding.bindingId, article.id]);
      request.onsuccess = () => resolve(request.result);
    });
    return { replacement: replacement.status, oldAccess: oldAccess.status,
      newAccess: newAccess.record, physicallyRetained: stored?.confirmed?.checkpoint?.progress };
  }, owner);
  expect(result).toEqual({ replacement: "replaced",
    oldAccess: "blocked", newAccess: null, physicallyRetained: 0.35 });
});
