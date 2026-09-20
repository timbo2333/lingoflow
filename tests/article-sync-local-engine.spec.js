const { test, expect } = require("@playwright/test");

const OWNER = { ownerId: "article-owner-a", bindingId: "article-binding-a" };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
  });
  await page.goto("/");
  await expect(page.locator("#inputText")).toBeVisible();
});

async function bound(page) {
  const result = await page.evaluate(owner => (
    window.LingoFlowSyncStateRepository.bindWorkspace(owner)
  ), OWNER);
  expect(["bound", "unchanged"]).toContain(result.status);
}

test("Article DB v2 新建时 bySource 非唯一；相同 source 的不同 ID 共存", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const library = window.LingoFlowArticleLibrary;
    const db = await library.openDatabase();
    const first = await library.createArticle({
      sourceType: "library", sourceId: "shared", content: "First article"
    });
    const second = await library.createArticle({
      sourceType: "library", sourceId: "shared", content: "Second article"
    });
    return {
      version: db.version,
      unique: db.transaction("articles").objectStore("articles").index("bySource").unique,
      ids: (await library.findArticlesBySource("library", "shared")).map(article => article.id),
      first: first.id,
      second: second.id
    };
  });
  expect(result.version).toBe(2);
  expect(result.unique).toBe(false);
  expect(result.first).not.toBe(result.second);
  expect(result.ids).toEqual(expect.arrayContaining([result.first, result.second]));
});

test("真实 v1 → v2 upgrade 保留 ID、正文、reading、soft-delete", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:4173" });
  const fresh = await context.newPage();
  try {
    await fresh.goto("/favicon.svg");
    const original = await fresh.evaluate(async () => {
      const article = {
        id: "article:old-v1", title: "Old", content: "Original body",
        sourceType: "library", sourceId: "same-source",
        createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z",
        lastReadAt: "2026-01-03T00:00:00Z", deletedAt: "2026-01-04T00:00:00Z",
        reading: { progress: 0.72, paragraphIndex: 4, updatedAt: "2026-01-03T00:00:00Z" }
      };
      await new Promise((resolve, reject) => {
        const request = indexedDB.open("LingoFlowLibraryDB", 1);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore("articles", { keyPath: "id" });
          store.createIndex("byLastReadAt", "lastReadAt");
          store.createIndex("byDeletedAt", "deletedAt");
          store.createIndex("bySource", ["sourceType", "sourceId"], { unique: true });
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("articles", "readwrite");
          tx.objectStore("articles").add(article);
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
      });
      return article;
    });
    await fresh.goto("/");
    const result = await fresh.evaluate(async () => {
      const library = window.LingoFlowArticleLibrary;
      const db = await library.openDatabase();
      const article = await library.getArticle("article:old-v1");
      const second = await library.createArticle({
        sourceType: "library", sourceId: "same-source", content: "Second body"
      });
      return { version: db.version,
        unique: db.transaction("articles").objectStore("articles").index("bySource").unique,
        article, second };
    });
    expect(result.version).toBe(2);
    expect(result.unique).toBe(false);
    expect(result.article).toEqual(original);
    expect(result.second.id).not.toBe(original.id);
  } finally {
    await context.close();
  }
});

test("Sync DB v3 → v4 upgrade 保留原 binding 并只增 Article stores", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:4173" });
  const fresh = await context.newPage();
  try {
    await fresh.goto("/favicon.svg");
    await fresh.evaluate(async owner => {
      await new Promise((resolve, reject) => {
        const request = indexedDB.open("LingoFlowSyncDB", 3);
        request.onupgradeneeded = () => {
          const db = request.result;
          const control = db.createObjectStore("control", { keyPath: "key" });
          db.createObjectStore("entitySidecars", {
            keyPath: ["ownerId", "entityType", "entityId", "scope"]
          });
          db.createObjectStore("outbox", { keyPath: ["ownerId", "mutationId"] });
          db.createObjectStore("syncIssues", { keyPath: ["ownerId", "mutationId"] });
          db.createObjectStore("inbox", { keyPath: ["ownerId", "bindingId", "inboxSeq"] });
          control.add({ key: "workspace-binding", ...owner });
        };
        request.onsuccess = () => { request.result.close(); resolve(); };
        request.onerror = () => reject(request.error);
      });
    }, OWNER);
    await fresh.goto("/");
    const result = await fresh.evaluate(async () => {
      const state = window.LingoFlowSyncStateRepository;
      const db = await state.openDatabase();
      return { version: db.version, stores: Array.from(db.objectStoreNames).sort(),
        binding: await state.getWorkspaceBinding() };
    });
    expect(result.version).toBe(4);
    expect(result.stores).toEqual([
      "articleOutbox", "articleSidecars", "control", "entitySidecars", "inbox", "outbox", "syncIssues"
    ]);
    expect(result.binding.binding).toMatchObject(OWNER);
  } finally {
    await context.close();
  }
});

test("create/edit/delete/restore 产生独立 durable Article mutation，reading-only 不产生", async ({ page }) => {
  await bound(page);
  const result = await page.evaluate(async owner => {
    const library = window.LingoFlowArticleLibrary;
    const state = window.LingoFlowSyncStateRepository;
    const engine = window.LingoFlowArticleSyncLocalEngine.create();
    const created = await engine.createArticle({ title: "A", content: "Initial" }, owner);
    const id = created.article.id;
    const edited = await engine.editArticle(id, { content: "Edited" }, owner);
    const deleted = await engine.deleteArticle(id, owner);
    const restored = await engine.restoreArticle(id, owner);
    const beforeReading = await state.listArticleMutations(owner.ownerId, owner.bindingId);
    const beforeProjection = window.LingoFlowArticleSyncProjection
      .projectArticleForSync(await library.getArticle(id));
    await engine.updateReading(id, {
      progress: 0.5, paragraphIndex: 3,
      updatedAt: new Date().toISOString(), lastReadAt: new Date().toISOString()
    });
    const afterReading = await state.listArticleMutations(owner.ownerId, owner.bindingId);
    const afterProjection = window.LingoFlowArticleSyncProjection
      .projectArticleForSync(await library.getArticle(id));
    return { created, edited, deleted, restored, beforeReading, afterReading,
      beforeProjection, afterProjection, article: await library.getArticle(id),
      sidecar: await state.getArticleSidecar(owner.ownerId, owner.bindingId, id) };
  }, OWNER);
  for (const item of [result.created, result.edited, result.deleted, result.restored]) {
    expect(item.status).toBe("ready");
  }
  expect(result.beforeReading.items.map(item => item.operation).sort())
    .toEqual(["delete", "put", "put", "restore"]);
  expect(result.afterReading.items).toHaveLength(4);
  expect(result.beforeProjection).toEqual(result.afterProjection);
  expect(result.article.reading.progress).toBe(0.5);
  expect(result.sidecar.sidecar.knownRevision).toBeNull();
  for (const item of result.afterReading.items) {
    expect(item.candidate).not.toHaveProperty("reading");
    expect(item.candidate).not.toHaveProperty("lastReadAt");
    expect(item.candidateFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(item).not.toHaveProperty("localBeforeSnapshot");
    expect(item).not.toHaveProperty("request");
  }
});

test("prepared after crash: before-state 重放，candidate-state 提升，重复恢复幂等", async ({ page }) => {
  await bound(page);
  const result = await page.evaluate(async owner => {
    const library = window.LingoFlowArticleLibrary;
    const state = window.LingoFlowSyncStateRepository;
    const real = window.LingoFlowArticleSyncLocalEngine.create();
    const article = await library.createArticle({ content: "Before" });
    const id = article.id;
    const failing = window.LingoFlowArticleSyncLocalEngine.create({
      library: { ...library, commitArticleSyncProjection: async () => { throw new Error("crash after prepare"); } }
    });
    try { await failing.editArticle(id, { content: "After" }, owner); } catch {}
    await library.updateArticleReading(id, { progress: 0.63, paragraphIndex: 7 });
    const prepared = await state.listArticleMutations(owner.ownerId, owner.bindingId);
    const recovered = await real.recoverPrepared(owner);
    const again = await real.recoverPrepared(owner);
    return { prepared, recovered, again, article: await library.getArticle(id),
      items: await state.listArticleMutations(owner.ownerId, owner.bindingId) };
  }, OWNER);
  expect(result.prepared.items).toHaveLength(1);
  expect(result.prepared.items[0].status).toBe("prepared");
  expect(result.recovered.outcomes[0].status).toBe("ready");
  expect(result.again.outcomes).toEqual([]);
  expect(result.article.content).toBe("After");
  expect(result.article.reading.progress).toBe(0.63);
  expect(result.items.items).toHaveLength(1);
});

test("local write 后 ready 前崩溃可恢复；diverged state 标记 issue", async ({ page }) => {
  await bound(page);
  const result = await page.evaluate(async owner => {
    const library = window.LingoFlowArticleLibrary;
    const state = window.LingoFlowSyncStateRepository;
    const real = window.LingoFlowArticleSyncLocalEngine.create();
    const article = await library.createArticle({ content: "Before" });
    const failingState = {
      ...state,
      updateArticleMutationStatus: async () => { throw new Error("crash before ready"); }
    };
    const failing = window.LingoFlowArticleSyncLocalEngine.create({ state: failingState });
    try { await failing.editArticle(article.id, { content: "After" }, owner); } catch {}
    await library.updateArticleReading(article.id, { progress: 0.47, paragraphIndex: 2 });
    const before = await state.listArticleMutations(owner.ownerId, owner.bindingId);
    const recovered = await real.recoverPrepared(owner);
    const second = await library.createArticle({ content: "Other before" });
    const failAgain = window.LingoFlowArticleSyncLocalEngine.create({
      library: { ...library, commitArticleSyncProjection: async () => { throw new Error("crash"); } }
    });
    try { await failAgain.editArticle(second.id, { content: "Other after" }, owner); } catch {}
    await library.updateArticle(second.id, { content: "Independent edit" });
    const issue = await real.recoverPrepared(owner);
    return { before, recovered, issue, article: await library.getArticle(article.id),
      items: await state.listArticleMutations(owner.ownerId, owner.bindingId) };
  }, OWNER);
  expect(result.before.items[0].status).toBe("prepared");
  expect(result.recovered.outcomes[0].status).toBe("ready");
  expect(result.article.content).toBe("After");
  expect(result.article.reading.progress).toBe(0.47);
  expect(result.issue.outcomes[0].status).toBe("issue");
  expect(result.items.items.map(item => item.status)).toEqual(["ready", "issue"]);
});

test("remote apply preserves latest reading and produces no outbox echo", async ({ page }) => {
  await bound(page);
  const result = await page.evaluate(async owner => {
    const library = window.LingoFlowArticleLibrary;
    const adapter = window.LingoFlowArticleSyncRepository;
    const projection = window.LingoFlowArticleSyncProjection;
    const state = window.LingoFlowSyncStateRepository;
    const article = await library.createArticle({ content: "Local" });
    await library.updateArticleReading(article.id, {
      progress: 0.63, paragraphIndex: 5, lastReadAt: "2026-09-20T10:00:00Z"
    });
    const before = await adapter.getProjection(article.id);
    const remote = { ...before, content: "Remote", updatedAt: "2026-09-20T11:00:00Z" };
    const applied = await adapter.applyRemoteProjection({
      ...owner, remoteProjection: remote, expectedProjection: before
    });
    return { applied, article: await library.getArticle(article.id),
      sameProjection: projection.compareArticleSyncProjection(applied.article, remote),
      outbox: await state.listArticleMutations(owner.ownerId, owner.bindingId) };
  }, OWNER);
  expect(result.applied.status).toBe("committed");
  expect(result.sameProjection).toBe(true);
  expect(result.article.reading.progress).toBe(0.63);
  expect(result.article.lastReadAt).toBe("2026-09-20T10:00:00Z");
  expect(result.outbox.items).toEqual([]);
});

test("unbound local Article remains usable and never receives owner outbox", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const library = window.LingoFlowArticleLibrary;
    const engine = window.LingoFlowArticleSyncLocalEngine.create();
    const created = await engine.createArticle({ content: "Anonymous" }, owner);
    const edited = await engine.editArticle(created.article.id, { content: "Still anonymous" }, owner);
    const db = await window.LingoFlowSyncStateRepository.openDatabase();
    const outbox = await new Promise(resolve => {
      const request = db.transaction("articleOutbox").objectStore("articleOutbox").getAll();
      request.onsuccess = () => resolve(request.result);
    });
    return { article: await library.getArticle(created.article.id), created, edited, outbox };
  }, OWNER);
  expect(result.article.content).toBe("Still anonymous");
  expect(result.created.status).toBe("local-only");
  expect(result.edited.status).toBe("local-only");
  expect(result.outbox).toEqual([]);
});

test("A2 production path does not bootstrap existing Articles into an outbox", async ({ page }) => {
  await bound(page);
  const id = await page.evaluate(async () => (
    (await window.LingoFlowArticleLibrary.createArticle({ content: "Existing article" })).id
  ));
  await page.reload();
  const result = await page.evaluate(async ({ owner, id }) => ({
    article: await window.LingoFlowArticleLibrary.getArticle(id),
    mutations: await window.LingoFlowSyncStateRepository.listArticleMutations(
      owner.ownerId, owner.bindingId
    )
  }), { owner: OWNER, id });
  expect(result.article.content).toBe("Existing article");
  expect(result.mutations.items).toEqual([]);
});

test("prepare 前失败不修改 Article；绑定不匹配也不错误归属", async ({ page }) => {
  await bound(page);
  const result = await page.evaluate(async owner => {
    const library = window.LingoFlowArticleLibrary;
    const state = window.LingoFlowSyncStateRepository;
    const article = await library.createArticle({ content: "Before" });
    const failing = window.LingoFlowArticleSyncLocalEngine.create({
      state: { ...state, prepareArticleMutation: async () => ({ status: "failed" }) }
    });
    const failed = await failing.editArticle(article.id, { content: "Lost" }, owner);
    const mismatch = await window.LingoFlowArticleSyncLocalEngine.create().editArticle(
      article.id, { content: "Wrong owner" },
      { ownerId: "account-b", bindingId: "binding-b" }
    );
    return { failed, mismatch, article: await library.getArticle(article.id),
      outbox: await state.listArticleMutations(owner.ownerId, owner.bindingId) };
  }, OWNER);
  expect(result.failed.status).toBe("failed");
  expect(result.mismatch.status).toBe("blocked");
  expect(result.article.content).toBe("Before");
  expect(result.outbox.items).toEqual([]);
});

test("remote apply CAS 合并在读取后新增的 reading；pending local 阻止 stale remote", async ({ page }) => {
  await bound(page);
  const result = await page.evaluate(async owner => {
    const library = window.LingoFlowArticleLibrary;
    const adapter = window.LingoFlowArticleSyncRepository;
    const state = window.LingoFlowSyncStateRepository;
    const article = await library.createArticle({ content: "Local" });
    const before = await adapter.getProjection(article.id);
    const remote = { ...before, content: "Remote", updatedAt: "2026-09-20T11:00:00Z" };
    const committed = library.commitArticleSyncProjection;
    window.LingoFlowArticleLibrary = {
      ...library,
      commitArticleSyncProjection: async (...args) => {
        await library.updateArticleReading(article.id, { progress: 0.91, paragraphIndex: 9 });
        return await committed(...args);
      }
    };
    const applied = await adapter.applyRemoteProjection({
      ...owner, remoteProjection: remote, expectedProjection: before
    });
    window.LingoFlowArticleLibrary = library;
    const engine = window.LingoFlowArticleSyncLocalEngine.create();
    await engine.editArticle(article.id, { title: "Unsynced" }, owner);
    const blocked = await adapter.applyRemoteProjection({
      ...owner, remoteProjection: { ...remote, title: "Stale" }
    });
    return { applied, blocked, article: await library.getArticle(article.id),
      outbox: await state.listArticleMutations(owner.ownerId, owner.bindingId) };
  }, OWNER);
  expect(result.applied.status).toBe("committed");
  expect(result.article.content).toBe("Remote");
  expect(result.article.title).toBe("Unsynced");
  expect(result.article.reading.progress).toBe(0.91);
  expect(result.blocked).toMatchObject({ status: "blocked", reason: "unsynced-local-article" });
  expect(result.outbox.items).toHaveLength(1);
});

test("Article mutation 不进入 Favorite worker；Account Switch 原子清理 Article sync state", async ({ page }) => {
  await bound(page);
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    const engine = window.LingoFlowArticleSyncLocalEngine.create();
    const created = await engine.createArticle({ content: "A only" }, owner);
    const sent = [];
    const worker = window.LingoFlowSyncFavoritePushWorker.create({
      push: async (...args) => { sent.push(args); throw new Error("Article must not send"); }
    });
    const workerResult = await worker.runOnce(owner);
    const before = await state.listArticleMutations(owner.ownerId, owner.bindingId);
    const switched = await state.replaceWorkspaceBinding({
      from: owner,
      to: { ownerId: "article-owner-b", bindingId: "article-binding-b" },
      accountLabel: "B"
    });
    const db = await state.openDatabase();
    const remaining = await Promise.all(["articleOutbox", "articleSidecars"].map(name => (
      new Promise(resolve => {
        const request = db.transaction(name).objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result);
      })
    )));
    return { created: created.status, sent: sent.length, workerResult,
      before: before.items.length, switched, remaining };
  }, OWNER);
  expect(result.created).toBe("ready");
  expect(result.before).toBe(1);
  expect(result.sent).toBe(0);
  expect(result.switched.status).toBe("replaced");
  expect(result.remaining).toEqual([[], []]);
});

test("reload 后 prepared mutation 从持久化状态恢复且 mutationId 不变", async ({ page }) => {
  await bound(page);
  const prepared = await page.evaluate(async owner => {
    const library = window.LingoFlowArticleLibrary;
    const state = window.LingoFlowSyncStateRepository;
    const article = await library.createArticle({ content: "Before reload" });
    const failing = window.LingoFlowArticleSyncLocalEngine.create({
      library: { ...library, commitArticleSyncProjection: async () => { throw new Error("crash"); } }
    });
    try { await failing.editArticle(article.id, { content: "After reload" }, owner); } catch {}
    const item = (await state.listArticleMutations(owner.ownerId, owner.bindingId)).items[0];
    return { id: article.id, mutationId: item.mutationId };
  }, OWNER);
  await page.reload();
  const recovered = await page.evaluate(async ({ owner, prepared }) => {
    const engine = window.LingoFlowArticleSyncLocalEngine.create();
    const state = window.LingoFlowSyncStateRepository;
    const result = await engine.recoverPrepared(owner);
    const items = await state.listArticleMutations(owner.ownerId, owner.bindingId);
    return { result, item: items.items[0], article: await window.LingoFlowArticleLibrary.getArticle(prepared.id) };
  }, { owner: OWNER, prepared });
  expect(recovered.result.outcomes[0].status).toBe("ready");
  expect(recovered.item.mutationId).toBe(prepared.mutationId);
  expect(recovered.article.content).toBe("After reload");
});

for (const bytes of [5_000, 50_000, 250_000, 1_000_000]) {
  test(`${bytes} byte Article payload persists prepared → ready without duplicate body`, async ({ page }) => {
    await bound(page);
    const result = await page.evaluate(async ({ owner, bytes }) => {
      const engine = window.LingoFlowArticleSyncLocalEngine.create();
      const state = window.LingoFlowSyncStateRepository;
      const created = await engine.createArticle({ content: "x".repeat(bytes) }, owner);
      const item = (await state.listArticleMutations(owner.ownerId, owner.bindingId)).items[0];
      return { status: created.status, serializedBytes: new TextEncoder()
        .encode(JSON.stringify(item)).length,
        candidateBytes: new TextEncoder().encode(JSON.stringify(item.candidate)).length,
        contentBytes: new TextEncoder().encode(item.candidate.content).length };
    }, { owner: OWNER, bytes });
    expect(result.status).toBe("ready");
    expect(result.contentBytes).toBe(bytes);
    expect(result.serializedBytes).toBeLessThan(bytes * 1.2 + 1_000);
    expect(result.candidateBytes).toBeGreaterThan(bytes);
  });
}
