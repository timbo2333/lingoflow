const { test, expect } = require("@playwright/test");

const OWNER = { ownerId: "article-runtime-owner", bindingId: "article-runtime-binding" };

function createSharedRuntimeServer() {
  const records = new Map();
  const changes = [];
  const receipts = new Map();
  function append(projection, operation) {
    const current = records.get(projection.id);
    const record = {
      articleId: projection.id,
      projection: structuredClone(projection),
      operation,
      revision: (current?.revision || 0) + 1,
      cursor: changes.length + 1
    };
    records.set(projection.id, record);
    changes.push(record);
    return record;
  }
  return {
    push(mutation) {
      if (receipts.has(mutation.mutationId)) return structuredClone(receipts.get(mutation.mutationId));
      const current = records.get(mutation.articleId);
      const currentRevision = current ? `revision:${current.revision}` : null;
      if (currentRevision !== mutation.baseRevision) {
        return {
          status: "conflict", reason: "revision-mismatch",
          mutationId: mutation.mutationId, articleId: mutation.articleId,
          currentRevision,
          remoteProjection: current ? structuredClone(current.projection) : undefined
        };
      }
      const next = append(mutation.candidate, mutation.operation);
      const result = {
        status: "applied", mutationId: mutation.mutationId,
        articleId: mutation.articleId, operation: mutation.operation,
        revision: `revision:${next.revision}`, cursor: `cursor:${next.cursor}`
      };
      receipts.set(mutation.mutationId, result);
      return structuredClone(result);
    },
    pull(afterCursor, limit) {
      const after = afterCursor === null ? 0 : Number(afterCursor.slice(7));
      const available = changes.filter(item => item.cursor > after);
      const page = available.slice(0, limit);
      return {
        status: "ready",
        changes: page.map(item => ({
          articleId: item.articleId, projection: structuredClone(item.projection),
          operation: item.operation, revision: `revision:${item.revision}`,
          cursor: `cursor:${item.cursor}`
        })),
        nextCursor: `cursor:${page.at(-1)?.cursor || after}`,
        hasMore: available.length > page.length
      };
    },
    snapshot(articleId) {
      const current = records.get(articleId);
      return current ? {
        status: "found", articleId, projection: structuredClone(current.projection),
        revision: `revision:${current.revision}`, cursor: `cursor:${current.cursor}`,
        lifecycle: current.projection.deletedAt === null ? "active" : "deleted"
      } : { status: "missing", articleId };
    }
  };
}

async function openRuntimeDevice(browser, server, owner) {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:4173" });
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1"));
  await page.exposeFunction("__sharedArticlePush", mutation => server.push(mutation));
  await page.exposeFunction("__sharedArticlePull", (cursor, limit) => server.pull(cursor, limit));
  await page.exposeFunction("__sharedArticleSnapshot", articleId => server.snapshot(articleId));
  await page.goto("/");
  await expect(page.locator("#inputText")).toBeVisible();
  await page.evaluate(async currentOwner => {
    const cloud = {
      pushArticleMutation: async (_owner, mutation) => window.__sharedArticlePush(mutation),
      pullArticleChanges: async (_owner, cursor, limit) => window.__sharedArticlePull(cursor, limit),
      snapshot: async (_owner, articleId) => window.__sharedArticleSnapshot(articleId)
    };
    const auth = {
      initialize: async () => ({ status: "authenticated" }),
      getSessionContext: async () => ({ status: "ready", user: { id: currentOwner.ownerId } })
    };
    await window.LingoFlowSyncStateRepository.bindWorkspace(currentOwner);
    const bootstrap = window.LingoFlowArticleSyncBootstrapCoordinator.create({ cloud, auth });
    const runtime = window.LingoFlowArticleSyncApp.create({
      gateEnabled: () => true,
      listenAccountEvents: false,
      auth,
      cloud,
      bootstrap,
      state: window.LingoFlowSyncStateRepository,
      localEngine: window.LingoFlowArticleSyncLocalEngine.create()
    });
    window.LingoFlowArticleSyncApp = runtime;
    const started = await runtime.start();
    if (started.status !== "active") throw new Error(`runtime:${started.status}`);
    await runtime.syncNow();
  }, owner);
  return { context, page };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
  });
  await page.goto("/");
  await expect(page.locator("#inputText")).toBeVisible();
  await page.evaluate(() => {
    window.__createArticleRuntimeHarness = async (owner, seed = []) => {
      const records = new Map();
      const changes = [];
      const receipts = new Map();
      const calls = { push: [], pull: [], snapshot: [] };
      const control = {
        unavailable: false,
        unavailableReason: "network-unavailable",
        offline: false,
        authReady: true,
        deferPush: false,
        ackLostOnce: false,
        ackLostMutationIds: new Set(),
        pendingPushes: [],
        deferPull: false,
        pendingPulls: []
      };
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        get: () => !control.offline
      });

      function append(projection, operation) {
        const current = records.get(projection.id);
        const record = {
          articleId: projection.id,
          projection: structuredClone(projection),
          operation,
          revision: (current?.revision || 0) + 1,
          cursor: changes.length + 1
        };
        records.set(projection.id, record);
        changes.push(record);
        return record;
      }

      for (const item of seed) append(item.projection, item.operation || "put");

      function push(mutation) {
        calls.push.push(structuredClone(mutation));
        if (control.unavailable) {
          return Promise.resolve({ status: "unavailable", reason: control.unavailableReason });
        }
        const receipt = receipts.get(mutation.mutationId);
        if (receipt) return Promise.resolve(structuredClone(receipt));
        const apply = () => {
          const current = records.get(mutation.articleId);
          const currentRevision = current ? `revision:${current.revision}` : null;
          if (currentRevision !== mutation.baseRevision) {
            return {
              status: "conflict",
              reason: "revision-mismatch",
              mutationId: mutation.mutationId,
              articleId: mutation.articleId,
              currentRevision,
              remoteProjection: current ? structuredClone(current.projection) : undefined
            };
          }
          const next = append(mutation.candidate, mutation.operation);
          const result = {
            status: "applied",
            mutationId: mutation.mutationId,
            articleId: mutation.articleId,
            operation: mutation.operation,
            revision: `revision:${next.revision}`,
            cursor: `cursor:${next.cursor}`
          };
          receipts.set(mutation.mutationId, structuredClone(result));
          if (control.ackLostOnce && !control.ackLostMutationIds.has(mutation.mutationId)) {
            control.ackLostMutationIds.add(mutation.mutationId);
            return { status: "unavailable", reason: "network-unavailable" };
          }
          return result;
        };
        if (!control.deferPush) return Promise.resolve(apply());
        return new Promise(resolve => control.pendingPushes.push(() => resolve(apply())));
      }

      function pull(afterCursor, limit) {
        calls.pull.push({ afterCursor, limit });
        if (control.unavailable) {
          return Promise.resolve({ status: "unavailable", reason: control.unavailableReason });
        }
        const read = () => {
          const after = afterCursor === null ? 0 : Number(afterCursor.slice(7));
          const available = changes.filter(item => item.cursor > after);
          const page = available.slice(0, limit);
          return {
            status: "ready",
            changes: page.map(item => ({
              articleId: item.articleId,
              projection: structuredClone(item.projection),
              operation: item.operation,
              revision: `revision:${item.revision}`,
              cursor: `cursor:${item.cursor}`
            })),
            nextCursor: `cursor:${page.at(-1)?.cursor || after}`,
            hasMore: available.length > page.length
          };
        };
        if (!control.deferPull) return Promise.resolve(read());
        return new Promise(resolve => control.pendingPulls.push(() => resolve(read())));
      }

      const cloud = {
        pushArticleMutation: async (_owner, mutation) => await push(mutation),
        pullArticleChanges: async (_owner, cursor, limit) => await pull(cursor, limit),
        snapshot: async (_owner, articleId) => {
          calls.snapshot.push(articleId);
          if (control.unavailable) {
            return { status: "unavailable", reason: control.unavailableReason };
          }
          const current = records.get(articleId);
          return current ? {
            status: "found",
            articleId,
            projection: structuredClone(current.projection),
            revision: `revision:${current.revision}`,
            cursor: `cursor:${current.cursor}`,
            lifecycle: current.projection.deletedAt === null ? "active" : "deleted"
          } : { status: "missing", articleId };
        }
      };
      const auth = {
        initialize: async () => ({ status: control.authReady ? "authenticated" : "signed-out" }),
        getSessionContext: async () => control.authReady
          ? { status: "ready", user: { id: owner.ownerId } }
          : { status: "signed-out" }
      };
      const state = window.LingoFlowSyncStateRepository;
      await state.bindWorkspace(owner);
      const boot = window.LingoFlowArticleSyncBootstrapCoordinator.create({ cloud, auth });
      const bootResult = await boot.run(owner);
      if (bootResult.status !== "complete") throw new Error(`bootstrap:${bootResult.status}`);
      const runtime = window.LingoFlowArticleSyncApp.create({
        gateEnabled: () => true,
        listenAccountEvents: false,
        auth,
        state,
        cloud,
        bootstrap: boot,
        localEngine: window.LingoFlowArticleSyncLocalEngine.create()
      });
      window.LingoFlowArticleSyncApp = runtime;
      runtime.installLifecycle();
      await runtime.start();
      await runtime.syncNow();
      return {
        owner,
        runtime,
        cloud,
        control,
        calls,
        records,
        changes,
        append,
        releasePush() { control.pendingPushes.shift()?.(); },
        releasePull() { control.pendingPulls.shift()?.(); },
        snapshot() {
          return {
            records: Array.from(records.values()).map(value => structuredClone(value)),
            calls: structuredClone(calls),
            state: runtime.getState()
          };
        }
      };
    };
  });
});

test("unauthenticated local writes never create Article outbox", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    localStorage.removeItem("lingoflow_article_sync_runtime_dev");
    const article = await window.LingoFlowArticleSyncWriteService.createArticle({ content: "Local only" });
    const binding = await window.LingoFlowSyncStateRepository.bindWorkspace(owner);
    const outbox = await window.LingoFlowSyncStateRepository.listArticleMutations(
      owner.ownerId,
      owner.bindingId
    );
    return { article, binding: binding.status, outbox, app: window.LingoFlowArticleSyncApp.getState() };
  }, OWNER);
  expect(result.article.content).toBe("Local only");
  expect(result.outbox.items).toEqual([]);
  expect(result.app.status).toBe("inactive");
});

test("runtime requires auth, confirmed workspace, and complete bootstrap", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const denied = window.LingoFlowArticleSyncApp.create({ gateEnabled: () => false });
    const off = await denied.start();
    const authStarting = window.LingoFlowArticleSyncApp.create({
      gateEnabled: () => true,
      auth: {
        getState: () => ({ status: "authenticating", reason: "restoring-session" }),
        initialize: () => new Promise(() => {}),
        getSessionContext: () => new Promise(() => {})
      },
      state: window.LingoFlowSyncStateRepository,
      repository: window.LingoFlowArticleSyncRepository,
      localEngine: window.LingoFlowArticleSyncLocalEngine.create(),
      cloud: {
        pushArticleMutation: async () => ({}), pullArticleChanges: async () => ({}), snapshot: async () => ({})
      },
      bootstrap: { run: async () => ({ status: "blocked" }) }
    });
    const restoring = await authStarting.start();
    return { off, restoring };
  });
  expect(result.off).toMatchObject({ status: "inactive", reason: "feature-disabled" });
  expect(result.restoring).toMatchObject({ status: "inactive", reason: "restoring-session" });
});

test("authenticated startup reuses verified Auth state without waiting on a redundant session read", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    let sessionReads = 0;
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => false
    });
    const runtime = window.LingoFlowArticleSyncApp.create({
      gateEnabled: () => true,
      listenAccountEvents: false,
      auth: {
        getState: () => ({ status: "authenticated", user: { id: owner.ownerId } }),
        getSessionContext: () => {
          sessionReads += 1;
          return new Promise(() => {});
        }
      },
      state: {
        getWorkspaceBinding: async () => ({ status: "ready", binding: owner }),
        getArticleBootstrapState: async () => ({
          status: "ready",
          state: { status: "complete" }
        }),
        beginArticleRuntime: async () => ({ status: "ready" }),
        pauseArticleRuntime: async () => ({ status: "ready" })
      },
      repository: { getProjection: async () => null },
      localEngine: {
        recoverPrepared: async () => ({ status: "ready" }),
        reconcileRuntimeDesired: async () => ({ status: "ready" })
      },
      cloud: {
        pushArticleMutation: async () => ({ status: "unavailable" }),
        pullArticleChanges: async () => ({ status: "unavailable" }),
        snapshot: async () => ({ status: "unavailable" })
      },
      bootstrap: { run: async () => ({ status: "complete" }) }
    });
    const started = await Promise.race([
      runtime.start(),
      new Promise(resolve => setTimeout(() => resolve({ status: "timed_out" }), 500))
    ]);
    runtime.stop();
    return { started, sessionReads };
  }, OWNER);
  expect(result.started).toMatchObject({ status: "active", reason: "ready" });
  expect(result.sessionReads).toBe(0);
});

test("normal create/edit/delete/restore automatically sync with serialized revisions", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = await window.__createArticleRuntimeHarness(owner);
    const writer = window.LingoFlowArticleSyncWriteService;
    const created = await writer.createArticle({ title: "One", content: "A" });
    await h.runtime.syncNow();
    await writer.updateArticle(created.id, { content: "B" });
    await h.runtime.syncNow();
    await writer.deleteArticle(created.id);
    await h.runtime.syncNow();
    await writer.restoreArticle(created.id);
    await h.runtime.syncNow();
    return h.snapshot();
  }, OWNER);
  expect(result.records).toHaveLength(1);
  expect(result.records[0].revision).toBe(4);
  expect(result.records[0].projection.content).toBe("B");
  expect(result.records[0].projection.deletedAt).toBeNull();
  expect(result.calls.push.map(call => call.operation)).toEqual(["put", "put", "delete", "restore"]);
  expect(result.calls.push.map(call => call.baseRevision)).toEqual([
    null, "revision:1", "revision:2", "revision:3"
  ]);
});

test("offline create/edit/edit coalesces to one latest put without self conflict", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = await window.__createArticleRuntimeHarness(owner);
    h.control.offline = true;
    const writer = window.LingoFlowArticleSyncWriteService;
    const created = await writer.createArticle({ content: "A" });
    await writer.updateArticle(created.id, { content: "B" });
    await writer.updateArticle(created.id, { content: "C" });
    const before = await window.LingoFlowSyncStateRepository.listArticleMutations(
      owner.ownerId, owner.bindingId
    );
    h.control.offline = false;
    await h.runtime.syncNow();
    return { before, after: await window.LingoFlowSyncStateRepository.listArticleMutations(
      owner.ownerId, owner.bindingId
    ), snapshot: h.snapshot() };
  }, OWNER);
  expect(result.before.items).toHaveLength(1);
  expect(result.before.items[0]).toMatchObject({ status: "desired" });
  expect(result.before.items[0].candidate.content).toBe("C");
  expect(result.snapshot.calls.push).toHaveLength(1);
  expect(result.snapshot.calls.push[0]).toMatchObject({ operation: "put", baseRevision: null });
  expect(result.snapshot.records[0].projection.content).toBe("C");
  expect(result.after.items).toEqual([]);
});

test("offline create/edit/delete compresses to one null-base tombstone", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = await window.__createArticleRuntimeHarness(owner);
    h.control.offline = true;
    const writer = window.LingoFlowArticleSyncWriteService;
    const created = await writer.createArticle({ content: "A" });
    await writer.updateArticle(created.id, { content: "B" });
    await writer.deleteArticle(created.id);
    h.control.offline = false;
    await h.runtime.syncNow();
    return h.snapshot();
  }, OWNER);
  expect(result.calls.push).toHaveLength(1);
  expect(result.calls.push[0]).toMatchObject({ operation: "delete", baseRevision: null });
  expect(result.records[0].revision).toBe(1);
  expect(result.records[0].projection.deletedAt).not.toBeNull();
});

test("existing revision repeated edits use one successor with latest projection", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const now = "2026-09-21T00:00:00.000Z";
    const projection = {
      id: "article:existing", title: "Existing", content: "Remote", sourceType: "paste",
      createdAt: now, updatedAt: now, deletedAt: null
    };
    const h = await window.__createArticleRuntimeHarness(owner, [{ projection }]);
    h.control.offline = true;
    const writer = window.LingoFlowArticleSyncWriteService;
    await writer.updateArticle(projection.id, { content: "B" });
    await writer.updateArticle(projection.id, { content: "C" });
    await writer.updateArticle(projection.id, { content: "D" });
    h.control.offline = false;
    await h.runtime.syncNow();
    return h.snapshot();
  }, OWNER);
  expect(result.calls.push).toHaveLength(1);
  expect(result.calls.push[0]).toMatchObject({ operation: "put", baseRevision: "revision:1" });
  expect(result.records[0]).toMatchObject({ revision: 2 });
  expect(result.records[0].projection.content).toBe("D");
});

test("existing revision 5 edit then delete offline becomes one revision 6 delete", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const changes = Array.from({ length: 5 }, (_, index) => {
      const minute = String(index).padStart(2, "0");
      return {
        projection: {
          id: "article:revision-five-delete",
          title: "Existing",
          content: `Remote ${index + 1}`,
          sourceType: "paste",
          createdAt: "2026-09-21T00:00:00.000Z",
          updatedAt: `2026-09-21T00:${minute}:00.000Z`,
          deletedAt: null
        }
      };
    });
    const h = await window.__createArticleRuntimeHarness(owner, changes);
    h.control.offline = true;
    const writer = window.LingoFlowArticleSyncWriteService;
    await writer.updateArticle("article:revision-five-delete", { content: "Local edit" });
    await writer.deleteArticle("article:revision-five-delete");
    h.control.offline = false;
    await h.runtime.syncNow();
    return h.snapshot();
  }, OWNER);
  expect(result.calls.push).toHaveLength(1);
  expect(result.calls.push[0]).toMatchObject({ operation: "delete", baseRevision: "revision:5" });
  expect(result.records[0].revision).toBe(6);
  expect(result.records[0].projection.deletedAt).not.toBeNull();
});

test("existing deleted revision 7 restore then edit offline becomes one safe restore", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const changes = Array.from({ length: 7 }, (_, index) => {
      const final = index === 6;
      const minute = String(index).padStart(2, "0");
      return {
        operation: final ? "delete" : "put",
        projection: {
          id: "article:revision-seven-restore",
          title: "Existing",
          content: `Remote ${index + 1}`,
          sourceType: "paste",
          createdAt: "2026-09-21T00:00:00.000Z",
          updatedAt: `2026-09-21T00:${minute}:00.000Z`,
          deletedAt: final ? "2026-09-21T00:06:00.000Z" : null
        }
      };
    });
    const h = await window.__createArticleRuntimeHarness(owner, changes);
    h.control.offline = true;
    const writer = window.LingoFlowArticleSyncWriteService;
    await writer.restoreArticle("article:revision-seven-restore");
    await writer.updateArticle("article:revision-seven-restore", { content: "Restored local edit" });
    h.control.offline = false;
    await h.runtime.syncNow();
    return h.snapshot();
  }, OWNER);
  expect(result.calls.push).toHaveLength(1);
  expect(result.calls.push[0]).toMatchObject({ operation: "restore", baseRevision: "revision:7" });
  expect(result.records[0].revision).toBe(8);
  expect(result.records[0].projection).toMatchObject({
    content: "Restored local edit",
    deletedAt: null
  });
});

test("delete/restore/edit tail derives put against active server and never stale restore", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const now = "2026-09-21T00:00:00.000Z";
    const projection = {
      id: "article:restore-chain", title: "Existing", content: "Remote", sourceType: "paste",
      createdAt: now, updatedAt: now, deletedAt: null
    };
    const h = await window.__createArticleRuntimeHarness(owner, [{ projection }]);
    h.control.offline = true;
    const writer = window.LingoFlowArticleSyncWriteService;
    await writer.deleteArticle(projection.id);
    await writer.restoreArticle(projection.id);
    await writer.updateArticle(projection.id, { content: "Final" });
    h.control.offline = false;
    await h.runtime.syncNow();
    return h.snapshot();
  }, OWNER);
  expect(result.calls.push).toHaveLength(1);
  expect(result.calls.push[0]).toMatchObject({ operation: "put", baseRevision: "revision:1" });
  expect(result.records[0].projection.content).toBe("Final");
});

test("in-flight immutable head keeps request identity while later edit becomes desired tail", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = await window.__createArticleRuntimeHarness(owner);
    h.control.deferPush = true;
    const writer = window.LingoFlowArticleSyncWriteService;
    const created = await writer.createArticle({ content: "Head" });
    const draining = h.runtime.syncNow();
    while (h.control.pendingPushes.length === 0) await new Promise(resolve => setTimeout(resolve, 0));
    const headBefore = (await window.LingoFlowSyncStateRepository.listArticleMutations(
      owner.ownerId, owner.bindingId
    )).items.find(item => item.status === "ready");
    await writer.updateArticle(created.id, { content: "Tail" });
    const during = await window.LingoFlowSyncStateRepository.listArticleMutations(
      owner.ownerId, owner.bindingId
    );
    h.releasePush();
    h.control.deferPush = false;
    await draining;
    await h.runtime.syncNow();
    return { headBefore, during, snapshot: h.snapshot() };
  }, OWNER);
  const readyDuring = result.during.items.find(item => item.status === "ready");
  const desiredDuring = result.during.items.find(item => item.status === "desired");
  expect(readyDuring.mutationId).toBe(result.headBefore.mutationId);
  expect(readyDuring.candidate.content).toBe("Head");
  expect(desiredDuring.candidate.content).toBe("Tail");
  expect(result.snapshot.calls.push.map(call => call.baseRevision)).toEqual([null, "revision:1"]);
  expect(result.snapshot.records[0].projection.content).toBe("Tail");
});

test("ack-lost retries identical head then creates safe successor", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = await window.__createArticleRuntimeHarness(owner);
    h.control.ackLostOnce = true;
    const writer = window.LingoFlowArticleSyncWriteService;
    const created = await writer.createArticle({ content: "Head" });
    await h.runtime.syncNow();
    await writer.updateArticle(created.id, { content: "Tail" });
    await h.runtime.syncNow();
    await h.runtime.syncNow();
    return h.snapshot();
  }, OWNER);
  expect(result.calls.push.length).toBeGreaterThanOrEqual(3);
  for (const field of ["mutationId", "articleId", "operation", "baseRevision", "candidate"]) {
    expect(result.calls.push[0][field]).toEqual(result.calls.push[1][field]);
  }
  expect(result.records[0].projection.content).toBe("Tail");
  expect(result.records[0].revision).toBe(2);
});

test("ack-lost head and later desired tail survive runtime restart", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = await window.__createArticleRuntimeHarness(owner);
    h.control.ackLostOnce = true;
    h.control.deferPush = true;
    const writer = window.LingoFlowArticleSyncWriteService;
    const created = await writer.createArticle({ content: "Head before restart" });
    const firstAttempt = h.runtime.syncNow();
    while (h.control.pendingPushes.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    await writer.updateArticle(created.id, { content: "Tail after lost ack" });
    h.runtime.stop("crash-restart");
    h.releasePush();
    await firstAttempt;
    h.control.deferPush = false;
    const beforeRestart = await window.LingoFlowSyncStateRepository.listArticleMutations(
      owner.ownerId, owner.bindingId
    );
    await h.runtime.start();
    await h.runtime.syncNow();
    return { beforeRestart, after: h.snapshot() };
  }, OWNER);
  const statuses = result.beforeRestart.items.map(item => item.status);
  const ready = result.beforeRestart.items.find(item => item.status === "ready");
  const desired = result.beforeRestart.items.find(item => item.status === "desired");
  expect(statuses).toContain("ready");
  expect(desired?.candidate.content).toBe("Tail after lost ack");
  expect(result.after.calls.push.length).toBeGreaterThanOrEqual(3);
  for (const field of ["mutationId", "articleId", "operation", "baseRevision", "candidate"]) {
    expect(result.after.calls.push[0][field]).toEqual(result.after.calls.push[1][field]);
  }
  expect(result.after.calls.push.at(-1).baseRevision).toBe("revision:1");
  expect(result.after.records[0]).toMatchObject({ revision: 2 });
  expect(result.after.records[0].projection.content).toBe("Tail after lost ack");
});

test("remote pull applies content and preserves device-local reading", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = await window.__createArticleRuntimeHarness(owner);
    const local = await window.LingoFlowArticleSyncWriteService.createArticle({ content: "Initial" });
    await h.runtime.syncNow();
    await window.LingoFlowArticleLibrary.updateArticleReading(local.id, {
      progress: 0.72, paragraphIndex: 8, lastReadAt: "2026-09-21T08:00:00.000Z"
    });
    const current = h.records.get(local.id);
    h.append({
      ...current.projection,
      content: "Remote edit",
      updatedAt: "2026-09-21T09:00:00.000Z"
    }, "put");
    await h.runtime.syncNow();
    return {
      article: await window.LingoFlowArticleLibrary.getArticle(local.id),
      outbox: await window.LingoFlowSyncStateRepository.listArticleMutations(
        owner.ownerId, owner.bindingId
      )
    };
  }, OWNER);
  expect(result.article.content).toBe("Remote edit");
  expect(result.article.reading).toMatchObject({ progress: 0.72, paragraphIndex: 8 });
  expect(result.article.lastReadAt).toBe("2026-09-21T08:00:00.000Z");
  expect(result.outbox.items).toEqual([]);
});

test("remote conflict is durable per article and does not block another Article", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = await window.__createArticleRuntimeHarness(owner);
    const writer = window.LingoFlowArticleSyncWriteService;
    const first = await writer.createArticle({ content: "First" });
    const second = await writer.createArticle({ content: "Second" });
    await h.runtime.syncNow();
    h.control.offline = true;
    await writer.updateArticle(first.id, { content: "Local first" });
    await writer.updateArticle(second.id, { content: "Local second" });
    const remote = h.records.get(first.id);
    h.append({ ...remote.projection, content: "Remote first",
      updatedAt: "2026-09-21T10:00:00.000Z" }, "put");
    h.control.offline = false;
    await h.runtime.syncNow();
    return {
      issues: await window.LingoFlowSyncStateRepository.listArticleRuntimeIssues(
        owner.ownerId, owner.bindingId
      ),
      first: await window.LingoFlowArticleLibrary.getArticle(first.id),
      records: h.snapshot().records
    };
  }, OWNER);
  expect(result.issues.issues.map(issue => issue.articleId)).toContain(result.first.id);
  expect(result.first.content).toBe("Local first");
  expect(result.records.find(item => item.articleId !== result.first.id).projection.content)
    .toBe("Local second");
});

test("account switch invalidates in-flight response before settlement", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = await window.__createArticleRuntimeHarness(owner);
    h.control.deferPush = true;
    const created = await window.LingoFlowArticleSyncWriteService.createArticle({ content: "A" });
    const draining = h.runtime.syncNow();
    while (h.control.pendingPushes.length === 0) await new Promise(resolve => setTimeout(resolve, 0));
    const before = await window.LingoFlowSyncStateRepository.listArticleMutations(
      owner.ownerId, owner.bindingId
    );
    await h.runtime.prepareAccountSwitch();
    h.releasePush();
    await draining;
    const after = await window.LingoFlowSyncStateRepository.listArticleMutations(
      owner.ownerId, owner.bindingId
    );
    return { created: created.id, before, after, runtime: h.runtime.getState() };
  }, OWNER);
  expect(result.before.items).toHaveLength(1);
  expect(result.after.items).toHaveLength(1);
  expect(result.after.items[0].mutationId).toBe(result.before.items[0].mutationId);
  expect(result.runtime).toMatchObject({ status: "inactive", reason: "account-switching" });
});

test("reading-only changes create neither desired tail nor push", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = await window.__createArticleRuntimeHarness(owner);
    const article = await window.LingoFlowArticleSyncWriteService.createArticle({ content: "A" });
    await h.runtime.syncNow();
    const beforePushes = h.calls.push.length;
    await window.LingoFlowArticleLibrary.updateArticleReading(article.id, {
      progress: 0.5, paragraphIndex: 4, lastReadAt: "2026-09-21T11:00:00.000Z"
    });
    await h.runtime.syncNow();
    return {
      beforePushes,
      afterPushes: h.calls.push.length,
      mutations: await window.LingoFlowSyncStateRepository.listArticleMutations(
        owner.ownerId, owner.bindingId
      )
    };
  }, OWNER);
  expect(result.afterPushes).toBe(result.beforePushes);
  expect(result.mutations.items).toEqual([]);
});

test("Backup v2 Article restore enters durable capture only while runtime is active", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = await window.__createArticleRuntimeHarness(owner);
    h.control.offline = true;
    const now = "2026-09-21T00:00:00.000Z";
    const article = {
      id: "article:backup-runtime", title: "Backup", content: "Imported", sourceType: "paste",
      createdAt: now, updatedAt: now, lastReadAt: now, deletedAt: null,
      reading: { progress: 0, paragraphIndex: 0, updatedAt: null }
    };
    const restored = await window.LingoFlowBackupV2.restoreArticles({
      articles: [article]
    });
    const pending = await window.LingoFlowSyncStateRepository.listArticleMutations(
      owner.ownerId, owner.bindingId
    );
    return { restored, pending };
  }, OWNER);
  expect(result.restored.status).toBe("completed");
  expect(result.pending.items).toHaveLength(1);
  expect(result.pending.items[0]).toMatchObject({ articleId: "article:backup-runtime", status: "desired" });
});

test("same source remains metadata and distinct stable IDs sync independently", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = await window.__createArticleRuntimeHarness(owner);
    const writer = window.LingoFlowArticleSyncWriteService;
    const first = await writer.createArticle({
      content: "First", sourceType: "library", sourceId: "shared-source"
    });
    const second = await writer.createArticle({
      content: "Second", sourceType: "library", sourceId: "shared-source"
    });
    await h.runtime.syncNow();
    return { first: first.id, second: second.id, snapshot: h.snapshot() };
  }, OWNER);
  expect(result.first).not.toBe(result.second);
  expect(result.snapshot.records).toHaveLength(2);
  expect(new Set(result.snapshot.records.map(item => item.articleId)).size).toBe(2);
});

for (const bytes of [5_000, 50_000, 250_000, 1_000_000]) {
  test(`${bytes} byte runtime payload reaches cloud intact`, async ({ page }) => {
    const result = await page.evaluate(async ({ owner, bytes }) => {
      const h = await window.__createArticleRuntimeHarness(owner);
      const article = await window.LingoFlowArticleSyncWriteService.createArticle({
        content: "x".repeat(bytes)
      });
      await h.runtime.syncNow();
      return {
        id: article.id,
        bytes: new TextEncoder().encode(h.records.get(article.id).projection.content).length,
        pushes: h.calls.push.length
      };
    }, { owner: OWNER, bytes });
    expect(result.bytes).toBe(bytes);
    expect(result.pushes).toBe(1);
  });
}

test("100 remote changes drain in bounded pages of 10", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = await window.__createArticleRuntimeHarness(owner);
    const base = h.changes.length;
    for (let index = 0; index < 100; index += 1) {
      const now = `2026-09-21T00:${String(index % 60).padStart(2, "0")}:00.000Z`;
      h.append({
        id: `article:backlog:${index}`, title: `Backlog ${index}`, content: `Body ${index}`,
        sourceType: "paste", createdAt: now, updatedAt: now, deletedAt: null
      }, "put");
    }
    const beforePulls = h.calls.pull.length;
    await h.runtime.syncNow();
    return {
      articleCount: (await window.LingoFlowArticleLibrary.listArticles()).length,
      pullCalls: h.calls.pull.slice(beforePulls),
      runtimeState: await window.LingoFlowSyncStateRepository.getArticleRuntimeState(
        owner.ownerId, owner.bindingId
      ),
      base
    };
  }, OWNER);
  expect(result.articleCount).toBe(100);
  expect(result.pullCalls.length).toBe(10);
  expect(result.pullCalls.every(call => call.limit === 10)).toBe(true);
  expect(result.runtimeState.state.cursor).toBe("cursor:100");
});

test("browser online event resumes an offline desired tail automatically", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = await window.__createArticleRuntimeHarness(owner);
    h.control.offline = true;
    const article = await window.LingoFlowArticleSyncWriteService.createArticle({ content: "Offline" });
    for (let index = 0; index < 50 && h.runtime.getState().status !== "paused"; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const before = await window.LingoFlowSyncStateRepository.listArticleMutations(
      owner.ownerId, owner.bindingId
    );
    h.control.offline = false;
    window.dispatchEvent(new Event("online"));
    for (let index = 0; index < 50 && !h.records.has(article.id); index += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return { before, snapshot: h.snapshot() };
  }, OWNER);
  expect(result.before.items).toHaveLength(1);
  expect(result.before.items[0].status).toBe("desired");
  expect(result.snapshot.state).toMatchObject({ status: "active" });
  expect(result.snapshot.calls.push.length).toBeGreaterThan(0);
  expect(result.snapshot.records[0].projection.content).toBe("Offline");
});

test("auth expiry pauses without deleting head, cursor, or local Article and later resumes", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = await window.__createArticleRuntimeHarness(owner);
    h.control.unavailable = true;
    h.control.unavailableReason = "auth-expired";
    const article = await window.LingoFlowArticleSyncWriteService.createArticle({ content: "Pending auth" });
    await h.runtime.syncNow();
    const paused = {
      app: h.runtime.getState(),
      article: await window.LingoFlowArticleLibrary.getArticle(article.id),
      outbox: await window.LingoFlowSyncStateRepository.listArticleMutations(
        owner.ownerId, owner.bindingId
      ),
      cursor: await window.LingoFlowSyncStateRepository.getArticleRuntimeState(
        owner.ownerId, owner.bindingId
      )
    };
    h.control.unavailable = false;
    h.runtime.requestSync("auth-restored");
    await h.runtime.syncNow();
    return { paused, after: h.snapshot() };
  }, OWNER);
  expect(result.paused.app).toMatchObject({ status: "paused", reason: "auth-expired" });
  expect(result.paused.article.content).toBe("Pending auth");
  expect(result.paused.outbox.items).toHaveLength(1);
  expect(result.paused.cursor.state.cursor).toBe("cursor:0");
  expect(result.after.records[0].projection.content).toBe("Pending auth");
});

test("transient offline Auth pause retains the write context for durable local deletes", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const createRuntime = window.LingoFlowArticleSyncApp.create;
    const h = await window.__createArticleRuntimeHarness(owner);
    h.runtime.stop("replace-with-lifecycle-runtime");
    h.control.offline = true;
    const auth = {
      getState: () => ({ status: "authenticated", user: { id: owner.ownerId } }),
      getSessionContext: async () => ({ status: "ready", user: { id: owner.ownerId } })
    };
    const runtime = createRuntime({
      gateEnabled: () => true,
      auth,
      state: window.LingoFlowSyncStateRepository,
      repository: window.LingoFlowArticleSyncRepository,
      localEngine: window.LingoFlowArticleSyncLocalEngine.create(),
      cloud: h.cloud,
      bootstrap: { run: async () => ({ status: "complete" }) }
    });
    window.LingoFlowArticleSyncApp = runtime;
    runtime.installLifecycle();
    await runtime.start();
    window.dispatchEvent(new CustomEvent("lingoflow:auth-state", {
      detail: { status: "paused", reason: "authenticated-user-unavailable" }
    }));
    const authPaused = runtime.getState();
    const article = await window.LingoFlowArticleSyncWriteService.createArticle({
      title: "Offline Auth Pause",
      content: "Create, edit, then delete while Auth verification is offline."
    });
    await window.LingoFlowArticleSyncWriteService.updateArticle(article.id, {
      title: "Offline Auth Pause Edited"
    });
    await window.LingoFlowArticleSyncWriteService.deleteArticle(article.id);
    const mutations = await window.LingoFlowSyncStateRepository.listArticleMutations(
      owner.ownerId,
      owner.bindingId
    );
    return {
      authPaused,
      app: runtime.getState(),
      writeContext: runtime.getWriteContext(),
      article: await window.LingoFlowArticleLibrary.getArticle(article.id),
      mutations: mutations.items.filter(item => item.articleId === article.id)
    };
  }, OWNER);
  expect(result.authPaused).toMatchObject({
    status: "paused",
    reason: "authenticated-user-unavailable",
    ownerId: OWNER.ownerId,
    bindingId: OWNER.bindingId
  });
  expect(result.app).toMatchObject({
    status: "paused",
    ownerId: OWNER.ownerId,
    bindingId: OWNER.bindingId
  });
  expect(result.writeContext).toMatchObject({ status: "ready", owner: OWNER });
  expect(result.article.deletedAt).toEqual(expect.any(String));
  expect(result.mutations).toHaveLength(1);
  expect(result.mutations[0]).toMatchObject({
    status: "desired",
    operation: "delete",
    baseRevision: null,
    attemptCount: 0
  });
});

test("pull page fetched before apply remains durable and resumes without cursor skip", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = await window.__createArticleRuntimeHarness(owner);
    const now = "2026-09-21T12:00:00.000Z";
    h.append({
      id: "article:pending-page", title: "Pending", content: "Remote", sourceType: "paste",
      createdAt: now, updatedAt: now, deletedAt: null
    }, "put");
    h.runtime.stop("crash-injection");
    const state = window.LingoFlowSyncStateRepository;
    const pageResult = await h.cloud.pullArticleChanges(owner, "cursor:0", 10);
    await state.persistArticleRuntimePullPage(owner.ownerId, owner.bindingId, "cursor:0", pageResult);
    const before = await state.getArticleRuntimeState(owner.ownerId, owner.bindingId);
    await h.runtime.start();
    await h.runtime.syncNow();
    return {
      before,
      after: await state.getArticleRuntimeState(owner.ownerId, owner.bindingId),
      article: await window.LingoFlowArticleLibrary.getArticle("article:pending-page")
    };
  }, OWNER);
  expect(result.before.state).toMatchObject({ cursor: "cursor:0", pendingCursor: "cursor:1" });
  expect(result.after.state).toMatchObject({ cursor: "cursor:1", pendingCursor: null });
  expect(result.article.content).toBe("Remote");
});

test("remote apply before cursor persistence replays as stale duplicate and commits cursor once", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = await window.__createArticleRuntimeHarness(owner);
    const now = "2026-09-21T12:10:00.000Z";
    const projection = {
      id: "article:applied-before-cursor", title: "Pending", content: "Remote", sourceType: "paste",
      createdAt: now, updatedAt: now, deletedAt: null
    };
    h.append(projection, "put");
    h.runtime.stop("crash-after-apply");
    const state = window.LingoFlowSyncStateRepository;
    const pageResult = await h.cloud.pullArticleChanges(owner, "cursor:0", 10);
    await state.persistArticleRuntimePullPage(owner.ownerId, owner.bindingId, "cursor:0", pageResult);
    await window.LingoFlowArticleSyncRepository.applyRemoteProjection({
      ...owner, remoteProjection: projection, expectedProjection: null
    });
    await state.bindArticleRemoteRevision(
      owner.ownerId,
      owner.bindingId,
      projection.id,
      "revision:1",
      await window.LingoFlowArticleSyncLocalEngine.fingerprint(projection),
      "active"
    );
    await h.runtime.start();
    await h.runtime.syncNow();
    return {
      state: await state.getArticleRuntimeState(owner.ownerId, owner.bindingId),
      matches: (await window.LingoFlowArticleLibrary.listArticles())
        .filter(article => article.id === projection.id).length,
      sidecar: await state.getArticleSidecar(owner.ownerId, owner.bindingId, projection.id)
    };
  }, OWNER);
  expect(result.state.state.cursor).toBe("cursor:1");
  expect(result.matches).toBe(1);
  expect(result.sidecar.sidecar.knownRevision).toBe("revision:1");
});

test("remote delete becomes a local soft-delete without losing the record", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = await window.__createArticleRuntimeHarness(owner);
    const article = await window.LingoFlowArticleSyncWriteService.createArticle({ content: "Delete me" });
    await h.runtime.syncNow();
    const current = h.records.get(article.id);
    h.append({
      ...current.projection,
      deletedAt: "2026-09-21T12:20:00.000Z",
      updatedAt: "2026-09-21T12:20:00.000Z"
    }, "delete");
    await h.runtime.syncNow();
    return {
      record: await window.LingoFlowArticleLibrary.getArticle(article.id),
      visible: await window.LingoFlowArticleLibrary.listArticles(),
      deleted: await window.LingoFlowArticleLibrary.listArticles({ deletedOnly: true })
    };
  }, OWNER);
  expect(result.record.deletedAt).toBe("2026-09-21T12:20:00.000Z");
  expect(result.visible.find(item => item.id === result.record.id)).toBeUndefined();
  expect(result.deleted.find(item => item.id === result.record.id)).toBeTruthy();
});

test("prepared desired WAL recovers local write and promotes after restart", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = await window.__createArticleRuntimeHarness(owner);
    h.control.offline = true;
    const engine = window.LingoFlowArticleSyncLocalEngine.create({
      hooks: { afterRuntimeLocalWrite: async () => { throw new Error("crash"); } }
    });
    try { await engine.createDesiredArticle({ content: "Recovered" }, owner); } catch {}
    const before = await window.LingoFlowSyncStateRepository.listArticleMutations(
      owner.ownerId, owner.bindingId
    );
    h.runtime.stop("restart");
    h.control.offline = false;
    await h.runtime.start();
    await h.runtime.syncNow();
    return { before, after: h.snapshot() };
  }, OWNER);
  expect(result.before.items).toHaveLength(1);
  expect(result.before.items[0].status).toBe("prepared");
  expect(result.after.records[0].projection.content).toBe("Recovered");
});

test("pull response from an invalidated generation is discarded before local apply", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = await window.__createArticleRuntimeHarness(owner);
    const now = "2026-09-21T12:30:00.000Z";
    h.append({
      id: "article:old-generation", title: "Old", content: "Remote", sourceType: "paste",
      createdAt: now, updatedAt: now, deletedAt: null
    }, "put");
    h.control.deferPull = true;
    const draining = h.runtime.syncNow();
    while (h.control.pendingPulls.length === 0) await new Promise(resolve => setTimeout(resolve, 0));
    await h.runtime.prepareAccountSwitch();
    h.releasePull();
    await draining;
    return {
      article: await window.LingoFlowArticleLibrary.getArticle("article:old-generation"),
      runtimeState: await window.LingoFlowSyncStateRepository.getArticleRuntimeState(
        owner.ownerId, owner.bindingId
      )
    };
  }, OWNER);
  expect(result.article).toBeNull();
  expect(result.runtimeState.state.cursor).toBe("cursor:0");
});

test("Backup restore remains local-only and creates no outbox when runtime gate is OFF", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    await window.LingoFlowSyncStateRepository.bindWorkspace(owner);
    const now = "2026-09-21T00:00:00.000Z";
    const restored = await window.LingoFlowBackupV2.restoreArticles({ articles: [{
      id: "article:backup-off", title: "Backup", content: "Local", sourceType: "paste",
      createdAt: now, updatedAt: now, lastReadAt: now, deletedAt: null,
      reading: { progress: 0, paragraphIndex: 0, updatedAt: null }
    }] });
    return {
      restored,
      outbox: await window.LingoFlowSyncStateRepository.listArticleMutations(
        owner.ownerId, owner.bindingId
      )
    };
  }, OWNER);
  expect(result.restored.status).toBe("completed");
  expect(result.outbox.items).toEqual([]);
});

test("two isolated devices create/edit/delete and preserve receiving-device reading", async ({ browser }) => {
  const server = createSharedRuntimeServer();
  const owner = { ownerId: "article-runtime-shared-owner", bindingId: "article-runtime-shared-binding" };
  const a = await openRuntimeDevice(browser, server, owner);
  let b;
  try {
    const articleId = await a.page.evaluate(async () => {
      const article = await window.LingoFlowArticleSyncWriteService.createArticle({
        title: "Shared", content: "Created on A"
      });
      await window.LingoFlowArticleSyncApp.syncNow();
      return article.id;
    });
    b = await openRuntimeDevice(browser, server, owner);
    expect((await b.page.evaluate(async id => (
      window.LingoFlowArticleLibrary.getArticle(id)
    ), articleId)).content).toBe("Created on A");

    await b.page.evaluate(async id => {
      await window.LingoFlowArticleLibrary.updateArticleReading(id, {
        progress: 0.61,
        paragraphIndex: 6,
        lastReadAt: "2026-09-21T13:00:00.000Z"
      });
    }, articleId);
    await a.page.evaluate(async id => {
      await window.LingoFlowArticleSyncWriteService.updateArticle(id, { content: "Edited on A" });
      await window.LingoFlowArticleSyncApp.syncNow();
    }, articleId);
    const edited = await b.page.evaluate(async id => {
      await window.LingoFlowArticleSyncApp.syncNow();
      return await window.LingoFlowArticleLibrary.getArticle(id);
    }, articleId);
    expect(edited.content).toBe("Edited on A");
    expect(edited.reading).toMatchObject({ progress: 0.61, paragraphIndex: 6 });

    await a.page.evaluate(async id => {
      await window.LingoFlowArticleSyncWriteService.deleteArticle(id);
      await window.LingoFlowArticleSyncApp.syncNow();
    }, articleId);
    const deleted = await b.page.evaluate(async id => {
      await window.LingoFlowArticleSyncApp.syncNow();
      return await window.LingoFlowArticleLibrary.getArticle(id);
    }, articleId);
    expect(deleted.deletedAt).not.toBeNull();
    expect(deleted.reading.progress).toBe(0.61);
  } finally {
    await a.context.close();
    await b?.context.close();
  }
});

test("concurrent sync requests share one flight and do not duplicate a revision", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = await window.__createArticleRuntimeHarness(owner);
    h.control.deferPush = true;
    const article = await window.LingoFlowArticleSyncWriteService.createArticle({ content: "Once" });
    const first = h.runtime.syncNow();
    const second = h.runtime.syncNow();
    while (h.control.pendingPushes.length === 0) await new Promise(resolve => setTimeout(resolve, 0));
    h.releasePush();
    h.control.deferPush = false;
    await Promise.all([first, second]);
    return { articleId: article.id, snapshot: h.snapshot() };
  }, OWNER);
  expect(result.snapshot.records.find(item => item.articleId === result.articleId).revision).toBe(1);
  expect(new Set(result.snapshot.calls.push.map(call => call.mutationId)).size).toBe(1);
});

test("revision continuity gap becomes a durable article issue before cursor advances", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = await window.__createArticleRuntimeHarness(owner);
    h.runtime.stop("inject-gap");
    const now = "2026-09-21T13:10:00.000Z";
    const projection = {
      id: "article:gap", title: "Gap", content: "Revision two", sourceType: "paste",
      createdAt: now, updatedAt: now, deletedAt: null
    };
    await window.LingoFlowSyncStateRepository.persistArticleRuntimePullPage(
      owner.ownerId,
      owner.bindingId,
      "cursor:0",
      {
        status: "ready",
        changes: [{
          articleId: projection.id, projection, operation: "put",
          revision: "revision:2", cursor: "cursor:1"
        }],
        nextCursor: "cursor:1",
        hasMore: false
      }
    );
    await h.runtime.start();
    await h.runtime.syncNow();
    return {
      issues: await window.LingoFlowSyncStateRepository.listArticleRuntimeIssues(
        owner.ownerId, owner.bindingId
      ),
      state: await window.LingoFlowSyncStateRepository.getArticleRuntimeState(
        owner.ownerId, owner.bindingId
      ),
      article: await window.LingoFlowArticleLibrary.getArticle(projection.id)
    };
  }, OWNER);
  expect(result.issues.issues).toHaveLength(1);
  expect(result.issues.issues[0]).toMatchObject({
    articleId: "article:gap", reason: "remote-revision-gap", remoteRevision: "revision:2"
  });
  expect(result.state.state.cursor).toBe("cursor:1");
  expect(result.article).toBeNull();
});

test("legacy sidecar without lifecycle is backfilled from snapshot before promotion", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const now = "2026-09-21T13:20:00.000Z";
    const projection = {
      id: "article:legacy-sidecar", title: "Legacy", content: "Remote", sourceType: "paste",
      createdAt: now, updatedAt: now, deletedAt: null
    };
    const h = await window.__createArticleRuntimeHarness(owner, [{ projection }]);
    const db = await window.LingoFlowSyncStateRepository.openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("articleSidecars", "readwrite");
      const store = tx.objectStore("articleSidecars");
      const request = store.get([owner.ownerId, projection.id]);
      request.onsuccess = () => {
        const value = request.result;
        delete value.lastSyncedLifecycle;
        store.put(value);
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    h.control.offline = true;
    await window.LingoFlowArticleSyncWriteService.updateArticle(projection.id, { content: "Local" });
    h.control.offline = false;
    await h.runtime.syncNow();
    return {
      snapshotCalls: h.calls.snapshot,
      record: h.records.get(projection.id),
      sidecar: await window.LingoFlowSyncStateRepository.getArticleSidecar(
        owner.ownerId, owner.bindingId, projection.id
      )
    };
  }, OWNER);
  expect(result.snapshotCalls).toContain("article:legacy-sidecar");
  expect(result.record.revision).toBe(2);
  expect(result.record.projection.content).toBe("Local");
  expect(result.sidecar.sidecar.lastSyncedLifecycle).toBe("active");
});

test("transient snapshot failure pauses legacy lifecycle backfill without a durable conflict", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const now = "2026-09-21T13:30:00.000Z";
    const projection = {
      id: "article:legacy-sidecar-network", title: "Legacy", content: "Remote",
      sourceType: "paste", createdAt: now, updatedAt: now, deletedAt: null
    };
    const h = await window.__createArticleRuntimeHarness(owner, [{ projection }]);
    const db = await window.LingoFlowSyncStateRepository.openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("articleSidecars", "readwrite");
      const store = tx.objectStore("articleSidecars");
      const request = store.get([owner.ownerId, projection.id]);
      request.onsuccess = () => {
        const value = request.result;
        delete value.lastSyncedLifecycle;
        store.put(value);
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    h.control.offline = true;
    await window.LingoFlowArticleSyncWriteService.updateArticle(projection.id, { content: "Local" });
    h.control.offline = false;
    h.control.unavailable = true;
    await h.runtime.syncNow();
    const paused = {
      state: h.runtime.getState(),
      issues: await window.LingoFlowSyncStateRepository.listArticleRuntimeIssues(
        owner.ownerId, owner.bindingId
      ),
      mutations: await window.LingoFlowSyncStateRepository.listArticleMutations(
        owner.ownerId, owner.bindingId
      )
    };
    h.control.unavailable = false;
    await h.runtime.syncNow();
    return { paused, after: h.snapshot() };
  }, OWNER);
  expect(result.paused.state).toMatchObject({ status: "paused", reason: "network-unavailable" });
  expect(result.paused.issues.issues).toEqual([]);
  expect(result.paused.mutations.items).toHaveLength(1);
  expect(result.paused.mutations.items[0].status).toBe("desired");
  expect(result.after.records[0].projection.content).toBe("Local");
  expect(result.after.records[0].revision).toBe(2);
});
