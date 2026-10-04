const { test, expect } = require("./progress-strict-test");

const ownerA = { ownerId: "transition-owner-a", bindingId: "transition-binding-a" };
const ownerB = { ownerId: "transition-owner-b", bindingId: "transition-binding-b" };

test("switching fence blocks a second tab's Article and Resume writes", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:4173" });
  const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
  try {
    await Promise.all([first.goto("/"), second.goto("/")]);
    await first.evaluate(owner => window.LingoFlowSyncStateRepository.bindWorkspace(owner), ownerA);
    const article = await first.evaluate(() => window.LingoFlowArticleLibrary.createArticle({
      content: "Transition-protected Article" }));
    const prior = await second.evaluate(async ({ article, owner }) => {
      const lib = window.LingoFlowArticleLibrary;
      return lib.getProgressContext(article.id, owner);
    }, { article, owner: ownerA });
    const begun = await first.evaluate(({ from, to }) =>
      window.LingoFlowArticleLibrary.beginWorkspaceTransition({ from, to, storageSnapshot: [] }),
    { from: ownerA, to: ownerB });
    expect(begun.status).toBe("switching");
    const blocked = await second.evaluate(async ({ article, prior }) => {
      const lib = window.LingoFlowArticleLibrary;
      const attempt = async operation => {
        try { await operation(); return "written"; }
        catch { return "blocked"; }
      };
      const fingerprint = await window.LingoFlowReadingResume.fingerprintContent(article.content);
      const target = window.LingoFlowReadingResume.createCheckpoint({
        progress: 0.4, paragraphIndex: 4 }, fingerprint);
      return {
        create: await attempt(() => lib.createArticle({ content: "Other tab Article" })),
        update: await attempt(() => lib.updateArticle(article.id, { title: "Unexpected" })),
        delete: await attempt(() => lib.updateArticle(article.id, { deletedAt: new Date().toISOString() })),
        restore: await attempt(() => lib.restoreArticle({ ...article, id: "article:other-tab" })),
        resume: (await lib.commitReadingResumeIfCurrent({ articleId: article.id,
          expectedContent: article.content, contentFingerprint: fingerprint,
          beforeResume: null, target, scope: prior.scope,
          expectedFence: prior.fence })).status
      };
    }, { article, prior });
    expect(blocked).toEqual({ create: "blocked", update: "blocked", delete: "blocked",
      restore: "blocked", resume: "workspace-transition" });
    const failedReplacement = await first.evaluate(async ({ from, to }) => {
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function(stores, mode, ...rest) {
        if (this.name === "LingoFlowSyncDB" && mode === "readwrite" &&
            Array.from(stores).includes("entitySidecars") &&
            Array.from(stores).includes("articleOutbox")) {
          throw new Error("injected replacement failure after second-tab writes");
        }
        return original.call(this, stores, mode, ...rest);
      };
      try {
        return await window.LingoFlowSyncStateRepository.replaceWorkspaceBinding({
          from, to, accountLabel: "b@example.test" });
      } finally { IDBDatabase.prototype.transaction = original; }
    }, { from: ownerA, to: ownerB });
    expect(failedReplacement.status).toBe("failed");
    const rollback = await first.evaluate(() =>
      window.LingoFlowAccountSwitchService.recoverInterruptedSwitch());
    expect(rollback.status).toBe("rolled-back");
    expect((await first.evaluate(() => window.LingoFlowSyncStateRepository.getWorkspaceBinding()))
      .binding).toMatchObject(ownerA);
    expect(await first.evaluate(id => window.LingoFlowArticleLibrary.getArticle(id), article.id))
      .toMatchObject({ id: article.id, deletedAt: null });
  } finally { await context.close(); }
});

test("another tab cannot recover an actively held switch as a crash", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:4173" });
  const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
  try {
    await Promise.all([first.goto("/"), second.goto("/")]);
    await first.evaluate(async ({ from, to }) => {
      await window.LingoFlowSyncStateRepository.bindWorkspace(from);
      await window.LingoFlowArticleLibrary.createArticle({ content: "Active switch Article" });
      window.__switchEntered = false;
      window.__switchHold = navigator.locks.request("lingoflow:workspace-account-switch", async () => {
        const begun = await window.LingoFlowArticleLibrary.beginWorkspaceTransition({
          from, to, storageSnapshot: [] });
        window.__switchEntered = true;
        await new Promise(resolve => { window.__releaseSwitch = resolve; });
        await window.LingoFlowSyncStateRepository.replaceWorkspaceBinding({
          from, to, accountLabel: "b@example.test" });
        await window.LingoFlowArticleLibrary.finishWorkspaceTransition(
          begun.transition.transitionId, "finalize");
      });
    }, { from: ownerA, to: ownerB });
    await expect.poll(() => first.evaluate(() => window.__switchEntered)).toBe(true);
    await second.evaluate(() => {
      window.__recoveryResult = null;
      void window.LingoFlowAccountSwitchService.recoverInterruptedSwitch()
        .then(result => { window.__recoveryResult = result; });
    });
    await second.waitForTimeout(100);
    expect(await second.evaluate(() => window.__recoveryResult)).toBeNull();
    expect(await first.evaluate(() => window.LingoFlowArticleLibrary.getWorkspaceTransition()))
      .not.toBeNull();
    await first.evaluate(async () => {
      window.__releaseSwitch();
      await window.__switchHold;
    });
    await expect.poll(() => second.evaluate(() => window.__recoveryResult?.status)).toBe("ready");
    expect((await second.evaluate(() => window.LingoFlowSyncStateRepository.getWorkspaceBinding()))
      .binding).toMatchObject(ownerB);
  } finally { await context.close(); }
});

test("SyncDB failure rolls back stable A without losing A Articles", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async from => {
    const repo = window.LingoFlowSyncStateRepository;
    const lib = window.LingoFlowArticleLibrary;
    await repo.bindWorkspace(from);
    const article = await lib.createArticle({ content: "Preserve on failed switch" });
    window.LingoFlowSupabaseAuth = {
      getSessionContext: async () => ({ status: "ready",
        user: { id: "transition-owner-b", email: "b@example.test" } })
    };
    window.LingoFlowFavoriteAppSync = {
      prepareAccountSwitch: async () => ({}), bootstrap: async () => ({ status: "ready" })
    };
    window.LingoFlowArticleSyncApp = {
      prepareAccountSwitch: async () => ({}), start: async () => ({ status: "ready" })
    };
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function(stores, mode, ...rest) {
      if (this.name === "LingoFlowSyncDB" && mode === "readwrite" &&
          Array.from(stores).includes("articleOutbox") &&
          Array.from(stores).includes("entitySidecars")) {
        throw new Error("injected binding replacement outage");
      }
      return original.call(this, stores, mode, ...rest);
    };
    let switched;
    try { switched = await window.LingoFlowAccountSwitchService.switchToCurrentAccount(); }
    finally { IDBDatabase.prototype.transaction = original; }
    return { switchStatus: switched.status, switchReason: switched.reason,
      binding: (await repo.getWorkspaceBinding()).binding,
      transition: await lib.getWorkspaceTransition(),
      context: await lib.getProgressContext(article.id, from) };
  }, ownerA);
  expect(result.switchStatus).toBe("failed");
  expect(result.switchReason).toBe("switch-failed");
  expect(result.binding).toMatchObject(ownerA);
  expect(result.transition).toBeNull();
  expect(result.context).toMatchObject({ status: "ready",
    scope: { ownerId: ownerA.ownerId, bindingId: ownerA.bindingId },
    article: { content: "Preserve on failed switch" } });
});

test("without cross-tab locks account switch fails before touching A assets", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async from => {
    const repo = window.LingoFlowSyncStateRepository;
    const lib = window.LingoFlowArticleLibrary;
    await repo.bindWorkspace(from);
    const article = await lib.createArticle({ content: "Keep without switch lock" });
    window.LingoFlowSupabaseAuth = { getSessionContext: async () => ({
      status: "ready", user: { id: "transition-owner-b" } }) };
    const original = navigator.locks;
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    let switched;
    try { switched = await window.LingoFlowAccountSwitchService.switchToCurrentAccount(); }
    finally { Object.defineProperty(navigator, "locks", { configurable: true, value: original }); }
    return { switched, binding: (await repo.getWorkspaceBinding()).binding,
      article: await lib.getArticle(article.id), transition: await lib.getWorkspaceTransition() };
  }, ownerA);
  expect(result.switched).toMatchObject({ status: "failed", reason: "switch-lock-unavailable" });
  expect(result.binding).toMatchObject(ownerA);
  expect(result.article).toMatchObject({ content: "Keep without switch lock" });
  expect(result.transition).toBeNull();
});

test("successful transition opens stable B and rejects stale A action", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async ({ from, to }) => {
    const repo = window.LingoFlowSyncStateRepository;
    const lib = window.LingoFlowArticleLibrary;
    await repo.bindWorkspace(from);
    const article = await lib.createArticle({ content: "A-only Article" });
    const old = await lib.getProgressContext(article.id, from);
    const fingerprint = await window.LingoFlowReadingResume.fingerprintContent(article.content);
    const transition = await lib.beginWorkspaceTransition({ from, to, storageSnapshot: [] });
    const replacement = await repo.replaceWorkspaceBinding({ from, to,
      accountLabel: "b@example.test" });
    const finished = await lib.finishWorkspaceTransition(transition.transition.transitionId, "finalize");
    const stale = await lib.commitReadingResumeIfCurrent({ articleId: article.id,
      expectedContent: article.content, contentFingerprint: fingerprint,
      beforeResume: null,
      target: window.LingoFlowReadingResume.createCheckpoint({ progress: 0.8,
        paragraphIndex: 8 }, fingerprint), scope: old.scope, expectedFence: old.fence });
    const fresh = await lib.createArticle({ content: "B Article" });
    return { replacement: replacement.status, finished: finished.status,
      stale: stale.status, articles: await lib.listArticles({ includeDeleted: true }),
      scope: (await lib.getProgressContext(fresh.id, to)).scope,
      transition: await lib.getWorkspaceTransition() };
  }, { from: ownerA, to: ownerB });
  expect(result).toMatchObject({ replacement: "replaced", finished: "finalized",
    stale: "missing", articles: [{ content: "B Article" }],
    scope: { ownerId: ownerB.ownerId, bindingId: ownerB.bindingId }, transition: null });
});

for (const syncAfterCrash of ["A", "B"]) {
  test(`reload recovers durable switching state with SyncDB still ${syncAfterCrash}`, async ({ page }) => {
    await page.goto("/");
    await page.evaluate(async ({ from, to, syncAfterCrash }) => {
      const repo = window.LingoFlowSyncStateRepository;
      const lib = window.LingoFlowArticleLibrary;
      await repo.bindWorkspace(from);
      await lib.createArticle({ content: "Crash-window Article" });
      await lib.beginWorkspaceTransition({ from, to, storageSnapshot: [] });
      if (syncAfterCrash === "B") {
        await repo.replaceWorkspaceBinding({ from, to, accountLabel: "b@example.test" });
      }
    }, { from: ownerA, to: ownerB, syncAfterCrash });
    await page.reload();
    await expect.poll(() => page.evaluate(async () =>
      window.LingoFlowArticleLibrary.getWorkspaceTransition())).toBeNull();
    const result = await page.evaluate(async () => ({
      articles: await window.LingoFlowArticleLibrary.listArticles({ includeDeleted: true }),
      binding: (await window.LingoFlowSyncStateRepository.getWorkspaceBinding()).binding,
      scope: (await window.LingoFlowArticleLibrary.snapshotProgressState()).scope
    }));
    expect(result.binding.ownerId).toBe(syncAfterCrash === "A" ? ownerA.ownerId : ownerB.ownerId);
    expect(result.articles).toHaveLength(syncAfterCrash === "A" ? 1 : 0);
    expect(result.scope?.ownerId || null).toBe(syncAfterCrash === "A" ? null : ownerB.ownerId);
  });
}

test("failed rollback stays durably blocked and reload safely restores A", async ({ page }) => {
  await page.goto("/");
  const beforeReload = await page.evaluate(async ({ from, to }) => {
    const repo = window.LingoFlowSyncStateRepository;
    const lib = window.LingoFlowArticleLibrary;
    await repo.bindWorkspace(from);
    const article = await lib.createArticle({ content: "Rollback crash Article" });
    localStorage.setItem("EnglishReaderV052ReadingPrefs", '{"fontSize":21}');
    await lib.beginWorkspaceTransition({ from, to, storageSnapshot: [
      { key: "EnglishReaderV052ReadingPrefs", value: '{"fontSize":21}' }
    ] });
    localStorage.removeItem("EnglishReaderV052ReadingPrefs");
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function(stores, mode, ...rest) {
      if (this.name === "LingoFlowLibraryDB" && mode === "readwrite" &&
          Array.from(stores).includes("progressControl") &&
          Array.from(stores).includes("articles") &&
          Array.from(stores).includes("progressFences")) {
        throw new Error("injected rollback storage failure");
      }
      return original.call(this, stores, mode, ...rest);
    };
    let failed = false;
    try {
      const transition = await lib.getWorkspaceTransition();
      await lib.finishWorkspaceTransition(transition.transitionId, "rollback");
    } catch { failed = true; }
    finally { IDBDatabase.prototype.transaction = original; }
    let blocked = false;
    try { await lib.createArticle({ content: "Must stay blocked" }); }
    catch { blocked = true; }
    return { failed, blocked, transition: await lib.getWorkspaceTransition(),
      article: await lib.getArticle(article.id) };
  }, { from: ownerA, to: ownerB });
  expect(beforeReload.failed).toBe(true);
  expect(beforeReload.blocked).toBe(true);
  expect(beforeReload.transition).not.toBeNull();
  expect(beforeReload.article).toMatchObject({ content: "Rollback crash Article" });
  await page.reload();
  await expect.poll(() => page.evaluate(() =>
    window.LingoFlowArticleLibrary.getWorkspaceTransition())).toBeNull();
  const after = await page.evaluate(async () => ({
    preference: localStorage.getItem("EnglishReaderV052ReadingPrefs"),
    binding: (await window.LingoFlowSyncStateRepository.getWorkspaceBinding()).binding,
    articles: await window.LingoFlowArticleLibrary.listArticles({ includeDeleted: true })
  }));
  expect(after.preference).toBe('{"fontSize":21}');
  expect(after.binding).toMatchObject(ownerA);
  expect(after.articles).toHaveLength(1);
});
