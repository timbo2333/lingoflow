const { test, expect } = require("@playwright/test");

const OWNER = { ownerId: "size-limit-owner", bindingId: "size-limit-binding" };
const LIMIT = 1024 * 1024;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
  });
  await page.goto("/");
  await expect(page.locator("#inputText")).toBeVisible();
});

test("1 MiB UTF-8 boundary is inclusive for ASCII, Chinese and emoji", async ({ page }) => {
  const result = await page.evaluate(limit => {
    const size = window.LingoFlowArticleSyncSize;
    const check = content => size.validateArticleCloudSyncSize({ content });
    return {
      constant: size.MAX_ARTICLE_SYNC_CONTENT_BYTES,
      ascii: [limit - 1, limit, limit + 1].map(n => check("a".repeat(n)).status),
      chineseBytes: size.getArticleContentUtf8Bytes("中"),
      emojiBytes: size.getArticleContentUtf8Bytes("😀"),
      chineseAtLimit: check("中".repeat(Math.floor(limit / 3)) + "a").status,
      chineseOver: check("中".repeat(Math.floor(limit / 3)) + "aa").status,
      emojiAtLimit: check("😀".repeat(limit / 4)).status,
      emojiOver: check("😀".repeat(limit / 4) + "a").status
    };
  }, LIMIT);
  expect(result).toEqual({
    constant: LIMIT,
    ascii: ["valid", "valid", "article-too-large"],
    chineseBytes: 3,
    emojiBytes: 4,
    chineseAtLimit: "valid",
    chineseOver: "article-too-large",
    emojiAtLimit: "valid",
    emojiOver: "article-too-large"
  });
});

test("oversized local create and edit keep content but never create sendable outbox", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    const library = window.LingoFlowArticleLibrary;
    const engine = window.LingoFlowArticleSyncLocalEngine.create();
    await state.bindWorkspace(owner);
    const oversized = "a".repeat(1024 * 1024 + 1);
    const created = await engine.createDesiredArticle({ content: oversized }, owner);
    const normal = await engine.createDesiredArticle({ content: "small" }, owner);
    const expanded = await engine.editDesiredArticle(normal.article.id, { content: oversized }, owner);
    const saved = await library.getArticle(created.article.id);
    const savedEdit = await library.getArticle(normal.article.id);
    const outbox = await state.listArticleMutations(owner.ownerId, owner.bindingId);
    const issues = await state.listArticleRuntimeIssues(owner.ownerId, owner.bindingId);
    const shrunk = await engine.editDesiredArticle(normal.article.id, { content: "small again" }, owner);
    const after = await state.listArticleMutations(owner.ownerId, owner.bindingId);
    const afterIssues = await state.listArticleRuntimeIssues(owner.ownerId, owner.bindingId);
    return {
      created: created.status, expanded: expanded.status,
      savedBytes: new TextEncoder().encode(saved.content).length,
      editBytes: new TextEncoder().encode(savedEdit.content).length,
      outbox: outbox.items.map(item => ({ articleId: item.articleId, status: item.status })),
      issues: issues.issues.map(item => ({ articleId: item.articleId, reason: item.reason })),
      shrunk: shrunk.status,
      after: after.items.map(item => ({ articleId: item.articleId, status: item.status })),
      afterIssues: afterIssues.issues.map(item => ({ articleId: item.articleId, reason: item.reason }))
    };
  }, OWNER);
  expect(result.created).toBe("oversized");
  expect(result.expanded).toBe("oversized");
  expect(result.savedBytes).toBe(LIMIT + 1);
  expect(result.editBytes).toBe(LIMIT + 1);
  expect(result.outbox).toEqual([]);
  expect(result.issues).toHaveLength(2);
  expect(result.issues.every(issue => issue.reason === "article-too-large")).toBe(true);
  expect(result.shrunk).toBe("desired");
  expect(result.after).toEqual([{ articleId: result.after[0].articleId, status: "desired" }]);
  expect(result.afterIssues).toHaveLength(1);
});

test("oversized Article remains locally deletable and restorable without cloud mutation", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    const engine = window.LingoFlowArticleSyncLocalEngine.create();
    await state.bindWorkspace(owner);
    const created = await engine.createDesiredArticle({
      content: "x".repeat(1024 * 1024 + 1)
    }, owner);
    const deleted = await engine.editDesiredArticle(created.article.id,
      { deletedAt: new Date().toISOString() }, owner);
    const restored = await engine.editDesiredArticle(created.article.id,
      { deletedAt: null }, owner);
    const saved = await window.LingoFlowArticleLibrary.getArticle(created.article.id);
    const outbox = await state.listArticleMutations(owner.ownerId, owner.bindingId);
    return { deleted: deleted.status, restored: restored.status,
      isActive: saved.deletedAt === null, bytes: new TextEncoder().encode(saved.content).length,
      outboxCount: outbox.items.length };
  }, OWNER);
  expect(result).toEqual({ deleted: "oversized", restored: "oversized",
    isActive: true, bytes: LIMIT + 1, outboxCount: 0 });
});

test("bootstrap capture skips oversized local Article while normal Article remains sendable", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    const library = window.LingoFlowArticleLibrary;
    const engine = window.LingoFlowArticleSyncLocalEngine.create();
    await state.bindWorkspace(owner);
    const large = await library.createArticle({ content: "x".repeat(1024 * 1024 + 1) });
    const small = await library.createArticle({ content: "small" });
    const first = await engine.captureBootstrapArticle(large.id, owner);
    const second = await engine.captureBootstrapArticle(small.id, owner);
    const outbox = await state.listArticleMutations(owner.ownerId, owner.bindingId);
    return { first: first.status, second: second.status,
      outbox: outbox.items.map(item => item.articleId),
      issues: (await state.listArticleRuntimeIssues(owner.ownerId, owner.bindingId))
        .issues.map(item => item.reason) };
  }, OWNER);
  expect(result.first).toBe("quarantined");
  expect(result.second).toBe("ready");
  expect(result.outbox).toHaveLength(1);
  expect(result.issues).toEqual(["article-too-large"]);
});

test("Backup v2 export and restore retain oversized local content", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const content = "x".repeat(1024 * 1024 + 1);
    const article = await window.LingoFlowArticleLibrary.createArticle({ content });
    const exported = await window.LingoFlowBackupV2Export.exportArticles();
    const record = exported.payload.articles.find(item => item.id === article.id);
    const restoredId = `restored:${article.id}`;
    const restored = await window.LingoFlowBackupV2.restoreArticles({
      articles: [{ ...record, id: restoredId }]
    });
    const imported = await window.LingoFlowArticleLibrary.getArticle(restoredId);
    return { bytes: new TextEncoder().encode(record.content).length,
      restored: restored.status,
      importedBytes: new TextEncoder().encode(imported.content).length };
  });
  expect(result.bytes).toBe(LIMIT + 1);
  expect(result.restored).toBe("completed");
  expect(result.importedBytes).toBe(LIMIT + 1);
});

test("one oversized local Article does not block complete bootstrap or normal upload", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    const library = window.LingoFlowArticleLibrary;
    await state.bindWorkspace(owner);
    const large = await library.createArticle({ content: "x".repeat(1024 * 1024 + 1) });
    const small = await library.createArticle({ content: "normal bootstrap" });
    const pushes = [];
    const cloud = {
      pullArticleChanges: async (_owner, cursor) => ({
        status: "ready", changes: [], nextCursor: cursor || "cursor:0", hasMore: false
      }),
      pushArticleMutation: async (_owner, mutation) => {
        pushes.push(mutation.articleId);
        return { status: "applied", mutationId: mutation.mutationId,
          articleId: mutation.articleId, operation: mutation.operation,
          revision: "revision:1", cursor: "cursor:1" };
      }
    };
    const bootstrap = window.LingoFlowArticleSyncBootstrapCoordinator.create({
      cloud, auth: { getSessionContext: async () => ({ status: "ready",
        user: { id: owner.ownerId } }) }
    });
    const completed = await bootstrap.run(owner);
    return { status: completed.status, pushes, largeId: large.id, smallId: small.id,
      issues: (await state.listArticleRuntimeIssues(owner.ownerId, owner.bindingId))
        .issues.map(item => ({ articleId: item.articleId, reason: item.reason })),
      largeStillHere: Boolean(await library.getArticle(large.id)) };
  }, OWNER);
  expect(result.status).toBe("complete");
  expect(result.pushes).toEqual([result.smallId]);
  expect(result.issues).toEqual([{ articleId: result.largeId, reason: "article-too-large" }]);
  expect(result.largeStillHere).toBe(true);
});

test("oversized Article replaces an old bootstrap conflict without blocking workspace", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    const library = window.LingoFlowArticleLibrary;
    const projection = window.LingoFlowArticleSyncProjection;
    await state.bindWorkspace(owner);
    const local = await library.createArticle({ content: "x".repeat(1024 * 1024 + 1) });
    const localProjection = projection.projectArticleForSync(local);
    const remoteProjection = { ...localProjection, content: "remote" };
    await state.beginArticleBootstrap(owner.ownerId, owner.bindingId);
    await state.captureArticleBootstrapIssue({ ...owner, articleId: local.id,
      reason: "bootstrap-content-conflict", localProjection,
      remoteProjection, remoteRevision: "revision:2", remoteLifecycle: "active" });
    const before = await state.getArticleBootstrapState(owner.ownerId, owner.bindingId);
    const quarantined = await state.quarantineOversizedArticle(
      owner.ownerId, owner.bindingId, local.id
    );
    const after = await state.getArticleBootstrapState(owner.ownerId, owner.bindingId);
    const bootstrapIssues = await state.listArticleBootstrapIssues(owner.ownerId, owner.bindingId);
    const runtimeIssues = await state.listArticleRuntimeIssues(owner.ownerId, owner.bindingId);
    return { before: before.state.status, quarantined: quarantined.status,
      after: after.state.status, bootstrapCount: bootstrapIssues.issues.length,
      runtimeReason: runtimeIssues.issues[0]?.reason,
      runtimeLocalProjection: runtimeIssues.issues[0]?.localProjection,
      remoteRevision: runtimeIssues.issues[0]?.remoteRevision,
      localBytes: new TextEncoder().encode((await library.getArticle(local.id)).content).length };
  }, OWNER);
  expect(result).toEqual({ before: "blocked", quarantined: "quarantined",
    after: "in_progress", bootstrapCount: 0, runtimeReason: "article-too-large",
    runtimeLocalProjection: null, remoteRevision: "revision:2", localBytes: LIMIT + 1 });
});

test("oversized local with a remote version preserves remote revision for explicit resolution", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    const library = window.LingoFlowArticleLibrary;
    await state.bindWorkspace(owner);
    const local = await library.createArticle({ content: "x".repeat(1024 * 1024 + 1) });
    const remoteProjection = {
      ...window.LingoFlowArticleSyncProjection.projectArticleForSync(local), content: "remote"
    };
    const change = { articleId: local.id, operation: "put", revision: "revision:1",
      cursor: "cursor:1", projection: remoteProjection };
    const bootstrap = window.LingoFlowArticleSyncBootstrapCoordinator.create({
      cloud: {
        pullArticleChanges: async (_owner, cursor) => ({ status: "ready",
          changes: cursor === null ? [change] : [],
          nextCursor: cursor === null ? "cursor:1" : cursor,
          hasMore: false }),
        pushArticleMutation: async () => { throw new Error("oversized must not upload"); }
      },
      auth: { getSessionContext: async () => ({ status: "ready",
        user: { id: owner.ownerId } }) }
    });
    const completed = await bootstrap.run(owner);
    const issue = (await state.listArticleRuntimeIssues(owner.ownerId, owner.bindingId)).issues[0];
    return { status: completed.status, reason: issue.reason,
      remoteRevision: issue.remoteRevision, remoteContent: issue.remoteProjection?.content,
      localBytes: new TextEncoder().encode((await library.getArticle(local.id)).content).length };
  }, OWNER);
  expect(result).toEqual({ status: "complete", reason: "article-too-large",
    remoteRevision: "revision:1", remoteContent: "remote", localBytes: LIMIT + 1 });
});

test("synced Article can grow locally, resist remote apply, then shrink against known revision", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    const library = window.LingoFlowArticleLibrary;
    const engine = window.LingoFlowArticleSyncLocalEngine.create();
    await state.bindWorkspace(owner);
    const created = await engine.createDesiredArticle({ content: "cloud original" }, owner);
    const ready = await state.promoteNextArticleDesired(owner.ownerId, owner.bindingId);
    await state.settleArticleMutationSuccess(owner.ownerId, owner.bindingId,
      ready.mutation.mutationId, { status: "applied",
        mutationId: ready.mutation.mutationId, articleId: created.article.id,
        operation: "put", revision: "revision:3", cursor: "cursor:3" });
    const remote = window.LingoFlowArticleSyncProjection.projectArticleForSync(created.article);
    const large = await engine.editDesiredArticle(created.article.id,
      { content: "y".repeat(1024 * 1024 + 1) }, owner);
    const blocked = await window.LingoFlowArticleSyncRepository.applyRemoteProjection({
      ...owner, remoteProjection: remote,
      expectedProjection: await window.LingoFlowArticleSyncRepository.getProjection(created.article.id)
    });
    const localBytes = new TextEncoder().encode(
      (await library.getArticle(created.article.id)).content
    ).length;
    const shrunk = await engine.editDesiredArticle(created.article.id,
      { content: "cloud resumed" }, owner);
    const next = await state.promoteNextArticleDesired(owner.ownerId, owner.bindingId);
    return { large: large.status, blocked: blocked.reason, localBytes,
      shrunk: shrunk.status, baseRevision: next.mutation?.baseRevision,
      nextContent: next.mutation?.candidate.content,
      issues: (await state.listArticleRuntimeIssues(owner.ownerId, owner.bindingId)).issues.length };
  }, OWNER);
  expect(result).toEqual({ large: "oversized", blocked: "article-too-large",
    localBytes: LIMIT + 1, shrunk: "desired", baseRevision: "revision:3",
    nextContent: "cloud resumed", issues: 0 });
});

test("client transport never posts oversized crafted ready mutation", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const now = new Date().toISOString();
    const candidate = { id: "article:size:crafted", title: "Size", content: "x".repeat(1024 * 1024 + 1),
      sourceType: "paste", createdAt: now, updatedAt: now, deletedAt: null };
    let calls = 0;
    const cloud = window.LingoFlowArticleSyncCloudService.create({
      projectUrl: "https://article-project.supabase.co",
      publishableKey: "sb_publishable_article_test",
      auth: { getSessionContext: async () => ({ status: "ready",
        user: { id: owner.ownerId } }), getAccessToken: async () => "fake" },
      fetchImpl: async () => { calls += 1; throw new Error("must not send"); }
    });
    const result = await cloud.pushArticleMutation(owner, {
      ...owner, articleId: candidate.id, mutationId: "article:size:mutation",
      operation: "put", baseRevision: null, status: "ready", candidate
    });
    return { result, calls };
  }, OWNER);
  expect(result).toEqual({ result: { status: "rejected", reason: "article-too-large" }, calls: 0 });
});

test("server size rejection and table constraint failure normalize to article-too-large", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const now = new Date().toISOString();
    const candidate = { id: "article:size:server", title: "Size", content: "safe",
      sourceType: "paste", createdAt: now, updatedAt: now, deletedAt: null };
    const mutation = { ...owner, articleId: candidate.id,
      mutationId: "article:size:server-mutation", operation: "put",
      baseRevision: null, status: "ready", candidate };
    const base = { projectUrl: "https://article-project.supabase.co",
      publishableKey: "sb_publishable_article_test",
      auth: { getSessionContext: async () => ({ status: "ready",
        user: { id: owner.ownerId } }), getAccessToken: async () => "fake" } };
    const rpc = window.LingoFlowArticleSyncCloudService.create({ ...base,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
        status: "rejected", reason: "article-too-large",
        articleId: mutation.articleId, mutationId: mutation.mutationId
      }) }) });
    const constraint = window.LingoFlowArticleSyncCloudService.create({ ...base,
      fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({
        message: 'violates check constraint "article_sync_change_content_limit"'
      }) }) });
    return { rpc: await rpc.pushArticleMutation(owner, mutation),
      constraint: await constraint.pushArticleMutation(owner, mutation) };
  }, OWNER);
  expect(result.rpc).toMatchObject({ status: "rejected", reason: "article-too-large" });
  expect(result.constraint).toEqual({ status: "rejected", reason: "article-too-large" });
});

test("oversized conflict cannot keep-local; explicit use-remote preserves reading", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    const library = window.LingoFlowArticleLibrary;
    await state.bindWorkspace(owner);
    const local = await library.createArticle({ content: "x".repeat(1024 * 1024 + 1) });
    await library.updateArticleReading(local.id, { progress: 0.67, paragraphIndex: 4 });
    const projection = window.LingoFlowArticleSyncProjection.projectArticleForSync(local);
    const remote = { ...projection, content: "safe remote version" };
    await state.captureArticleRuntimeIssue({ ...owner, articleId: local.id,
      reason: "bootstrap-content-conflict", localProjection: projection,
      remoteProjection: remote, remoteRevision: "revision:2",
      remoteCursor: "cursor:2", mutationId: null });
    const service = window.LingoFlowArticleSyncConflictService.create({
      app: {
        getResolutionContext: () => ({ status: "ready", owner, generation: 1 }),
        isResolutionContextCurrent: () => true,
        start: async () => ({ status: "inactive" })
      },
      cloud: { snapshot: async () => ({ status: "found", articleId: local.id,
        projection: remote, revision: "revision:2", cursor: "cursor:2",
        lifecycle: "active" }) }
    });
    const rejected = await service.keepLocal(local.id);
    const before = await library.getArticle(local.id);
    const outbox = await state.listArticleMutations(owner.ownerId, owner.bindingId);
    const used = await service.useRemote(local.id);
    const after = await library.getArticle(local.id);
    return { rejected, beforeBytes: new TextEncoder().encode(before.content).length,
      outboxCount: outbox.items.length, used: used.status,
      content: after.content, reading: after.reading };
  }, OWNER);
  expect(result.rejected).toMatchObject({ status: "blocked", reason: "article-too-large" });
  expect(result.beforeBytes).toBe(LIMIT + 1);
  expect(result.outboxCount).toBe(0);
  expect(result.used).toBe("resolved");
  expect(result.content).toBe("safe remote version");
  expect(result.reading.progress).toBe(0.67);
  expect(result.reading.paragraphIndex).toBe(4);
});
