const { test, expect } = require("@playwright/test");

const projectErrors = new WeakMap();
const OWNER = Object.freeze({ ownerId: "owner:push", bindingId: "binding:push" });

async function loadPushScripts(page) {
  await page.addScriptTag({ url: "/js/sync-canonical.js" });
  await page.addScriptTag({ url: "/js/cloud-sync-protocol.js" });
  await page.addScriptTag({ url: "/js/fake-sync-service.js" });
  await page.addScriptTag({ url: "/js/sync-state-repository.js" });
  await page.addScriptTag({ url: "/js/sync-favorite-service.js" });
  await page.addScriptTag({ url: "/js/sync-favorite-push-worker.js" });
  await page.evaluate(() => {
    window.__getAllSyncStore = async storeName => {
      const db = await window.LingoFlowSyncStateRepository.openDatabase();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const request = tx.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    };
    window.__putSyncStore = async (storeName, value) => {
      const db = await window.LingoFlowSyncStateRepository.openDatabase();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(structuredClone(value));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    };
  });
}

async function openApp(page) {
  await page.goto("/");
  await expect(page.locator("#inputText")).toBeVisible();
  await loadPushScripts(page);
}

test.beforeEach(async ({ page }) => {
  const errors = [];
  projectErrors.set(page, errors);
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (message.type() !== "error") return;
    const sourceUrl = message.location().url || "";
    if (!sourceUrl || sourceUrl.startsWith("http://127.0.0.1:4173")) {
      errors.push(`console.error: ${message.text()}`);
    }
  });
  await page.addInitScript(() => {
    localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
  });
  await openApp(page);
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

test("Scenario A：restart 后 create mutation applied 并原子清理 outbox", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    const capture = window.LingoFlowSyncFavoriteService;
    const favorites = window.LingoFlowFavoriteRepository;
    await capture.bindWorkspace(owner);
    const created = await capture.create(owner, { type: "word", text: "push create" });
    const frozen = (await state.listOutbox({ ownerId: owner.ownerId })).items[0];
    state.closeDatabase();
    await state.openDatabase();

    const fake = window.LingoFlowFakeSyncService.create();
    const worker = window.LingoFlowSyncFavoritePushWorker.create({
      push: (wireOwner, request) => fake.push(wireOwner, request)
    });
    const pushed = await worker.runOnce(owner);
    return {
      created,
      frozen,
      pushed,
      current: favorites.getById(created.favorite.id),
      sidecar: await state.getSidecar(owner.ownerId, created.favorite.id),
      outbox: await state.listOutbox({ ownerId: owner.ownerId }),
      remote: fake.pull({ ownerId: owner.ownerId }, null)
    };
  }, OWNER);

  expect(result.pushed.status).toBe("applied");
  expect(result.current).toEqual(result.created.favorite);
  expect(result.sidecar.sidecar.serverRevision).toBe(result.pushed.revision);
  expect(result.sidecar.sidecar.lastSyncedSnapshot).toEqual(result.frozen.request.payload);
  expect(result.outbox.items).toEqual([]);
  expect(result.remote.changes).toHaveLength(1);
  expect(result.remote.changes[0].payload).toEqual(result.created.favorite);
});

test("Scenario B：server applied 后 settlement crash 使用同 mutationId 幂等重试", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    const capture = window.LingoFlowSyncFavoriteService;
    await capture.bindWorkspace(owner);
    const created = await capture.create(owner, { type: "word", text: "ack crash" });
    const fake = window.LingoFlowFakeSyncService.create();
    const firstLease = await state.acquireNextReadyMutationLease(owner, { leaseMs: 60000 });
    const firstRequest = structuredClone(firstLease.item.request);
    const firstResult = fake.push({ ownerId: owner.ownerId }, structuredClone(firstRequest));

    const expired = structuredClone(firstLease.item);
    expired.leaseExpiresAt = "2026-01-01T00:00:00.000Z";
    await window.__putSyncStore("outbox", expired);
    state.closeDatabase();
    await state.openDatabase();

    const worker = window.LingoFlowSyncFavoritePushWorker.create({
      push: (wireOwner, request) => fake.push(wireOwner, request)
    });
    const replayed = await worker.runOnce(owner);
    const stored = await state.listOutbox({ ownerId: owner.ownerId });
    return {
      created,
      firstLease,
      firstRequest,
      firstResult,
      replayed,
      stored,
      sidecar: await state.getSidecar(owner.ownerId, created.favorite.id),
      remote: fake.pull({ ownerId: owner.ownerId }, null)
    };
  }, OWNER);

  expect(result.replayed.status).toBe("applied");
  expect(result.replayed.revision).toBe(result.firstResult.revision);
  expect(result.firstLease.item.attemptedAt).not.toBeNull();
  expect(result.firstRequest.mutationId).toBe(result.firstLease.item.mutationId);
  expect(result.stored.items).toEqual([]);
  expect(result.sidecar.sidecar.serverRevision).toBe(result.firstResult.revision);
  expect(result.remote.changes).toHaveLength(1);
});

test("push 成功后 binding 改变会阻断 settlement 并保留原 mutation", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    const capture = window.LingoFlowSyncFavoriteService;
    const favorites = window.LingoFlowFavoriteRepository;
    await capture.bindWorkspace(owner);
    const created = await capture.create(owner, { type: "word", text: "binding settlement" });
    const before = structuredClone(favorites.getById(created.favorite.id));
    const original = (await state.listOutbox({ ownerId: owner.ownerId })).items[0];
    const fake = window.LingoFlowFakeSyncService.create();
    const sent = [];
    const worker = window.LingoFlowSyncFavoritePushWorker.create({
      push: async (wireOwner, request) => {
        sent.push(structuredClone(request));
        const applied = fake.push(wireOwner, request);
        await window.__putSyncStore("control", {
          key: "workspace-binding",
          ownerId: owner.ownerId,
          bindingId: "binding:push:new"
        });
        return applied;
      }
    });
    const settled = await worker.runOnce(owner);
    return {
      created,
      before,
      original,
      sent,
      settled,
      binding: await state.getWorkspaceBinding(),
      current: favorites.getById(created.favorite.id),
      sidecar: await state.getSidecar(owner.ownerId, created.favorite.id),
      outbox: await state.listOutbox({ ownerId: owner.ownerId }),
      remote: fake.pull({ ownerId: owner.ownerId }, null)
    };
  }, OWNER);

  expect(result.settled).toMatchObject({
    status: "blocked",
    reason: "workspace-binding-mismatch",
    retryable: true,
    mutationId: result.original.mutationId,
    released: false
  });
  expect(result.binding.binding).toMatchObject({
    ownerId: OWNER.ownerId,
    bindingId: "binding:push:new"
  });
  expect(result.current).toEqual(result.before);
  expect(result.sidecar.status).toBe("missing");
  expect(result.outbox.items).toHaveLength(1);
  expect(result.outbox.items[0]).toMatchObject({
    ownerId: OWNER.ownerId,
    bindingId: OWNER.bindingId,
    mutationId: result.original.mutationId,
    entityId: result.created.favorite.id
  });
  expect(result.outbox.items[0].request).toEqual(result.original.request);
  expect(result.outbox.items[0].attemptedAt).not.toBeNull();
  expect(result.outbox.items[0].leaseToken).not.toBeNull();
  expect(result.outbox.items.filter(item => item.mutationId !== result.original.mutationId))
    .toEqual([]);
  expect(result.sent).toEqual([result.original.request]);
  expect(result.remote.changes).toHaveLength(1);
  expect(result.remote.changes[0].payload).toEqual(result.original.request.payload);
});

test("Scenario C：ACK 前本地 B 被重基线为新 mutation/R6", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const canonical = window.LingoFlowSyncCanonical;
    const state = window.LingoFlowSyncStateRepository;
    const capture = window.LingoFlowSyncFavoriteService;
    const favorites = window.LingoFlowFavoriteRepository;
    const fake = window.LingoFlowFakeSyncService.create();
    await capture.bindWorkspace(owner);

    const baseline = favorites.create({ type: "word", text: "successor", note: "base" });
    const seed = fake.push({ ownerId: owner.ownerId }, {
      mutationId: "mutation:seed:successor",
      entityType: "favorites",
      entityId: baseline.id,
      scope: "record",
      schemaVersion: "1",
      operation: "put",
      baseRevision: null,
      observedCursor: null,
      payload: baseline
    });
    await state.putSidecar({
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      entityType: "favorites",
      entityId: baseline.id,
      scope: "record",
      schemaVersion: "1",
      serverRevision: seed.revision,
      lastSyncedSnapshot: baseline,
      lastSyncedFingerprint: canonical.fingerprint(baseline)
    });
    await capture.update(owner, baseline.id, { note: "A" });
    const m1Before = (await state.listOutbox({ ownerId: owner.ownerId })).items[0];

    let releasePush;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const gate = new Promise(resolve => { releasePush = resolve; });
    const worker = window.LingoFlowSyncFavoritePushWorker.create({
      push: async (wireOwner, request) => {
        markStarted();
        await gate;
        return fake.push(wireOwner, request);
      }
    });
    const running = worker.runOnce(owner);
    await started;
    const changed = await capture.update(owner, baseline.id, { note: "B" });
    const during = await state.listOutbox({ ownerId: owner.ownerId });
    releasePush();
    const settled = await running;
    const after = await state.listOutbox({ ownerId: owner.ownerId });
    return {
      seed,
      m1Before,
      changed,
      during,
      settled,
      after,
      sidecar: await state.getSidecar(owner.ownerId, baseline.id),
      current: favorites.getById(baseline.id)
    };
  }, OWNER);

  expect(result.during.items).toHaveLength(2);
  const duringHead = result.during.items.find(item => item.mutationId === result.m1Before.mutationId);
  const duringSuccessor = result.during.items.find(item => item.mutationId !== result.m1Before.mutationId);
  expect(duringHead.request).toEqual(result.m1Before.request);
  expect(duringHead.attemptedAt).not.toBeNull();
  expect(duringSuccessor.dependsOnMutationId).toBe(result.m1Before.mutationId);
  expect(result.sidecar.sidecar.lastSyncedSnapshot.note).toBe("A");
  expect(result.sidecar.sidecar.serverRevision).toBe(result.settled.revision);
  expect(result.current.note).toBe("B");
  expect(result.after.items).toHaveLength(1);
  expect(result.after.items[0].mutationId).not.toBe(result.m1Before.mutationId);
  expect(result.after.items[0].mutationId).not.toBe(duringSuccessor.mutationId);
  expect(result.after.items[0].dependsOnMutationId).toBeNull();
  expect(result.after.items[0].request.baseRevision).toBe(result.settled.revision);
  expect(result.after.items[0].request.payload.note).toBe("B");
});

test("Scenario D：attempted delete ACK 后生成 explicit restore successor", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const canonical = window.LingoFlowSyncCanonical;
    const state = window.LingoFlowSyncStateRepository;
    const capture = window.LingoFlowSyncFavoriteService;
    const favorites = window.LingoFlowFavoriteRepository;
    const fake = window.LingoFlowFakeSyncService.create();
    await capture.bindWorkspace(owner);
    const baseline = favorites.create({ type: "word", text: "sent restore" });
    const seed = fake.push({ ownerId: owner.ownerId }, {
      mutationId: "mutation:seed:restore",
      entityType: "favorites",
      entityId: baseline.id,
      scope: "record",
      schemaVersion: "1",
      operation: "put",
      baseRevision: null,
      observedCursor: null,
      payload: baseline
    });
    await state.putSidecar({
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      entityType: "favorites",
      entityId: baseline.id,
      scope: "record",
      schemaVersion: "1",
      serverRevision: seed.revision,
      lastSyncedSnapshot: baseline,
      lastSyncedFingerprint: canonical.fingerprint(baseline)
    });
    await capture.softDelete(owner, baseline.id);
    const deleteItem = (await state.listOutbox({ ownerId: owner.ownerId })).items[0];
    let releasePush;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const gate = new Promise(resolve => { releasePush = resolve; });
    const worker = window.LingoFlowSyncFavoritePushWorker.create({
      push: async (wireOwner, request) => {
        markStarted();
        await gate;
        return fake.push(wireOwner, request);
      }
    });
    const running = worker.runOnce(owner);
    await started;
    const restored = await capture.restore(owner, baseline.id);
    const during = await state.listOutbox({ ownerId: owner.ownerId });
    releasePush();
    const settled = await running;
    return {
      seed,
      deleteItem,
      restored,
      during,
      settled,
      after: await state.listOutbox({ ownerId: owner.ownerId }),
      sidecar: await state.getSidecar(owner.ownerId, baseline.id),
      current: favorites.getById(baseline.id)
    };
  }, OWNER);

  expect(result.restored.successorAwaitingAck).toBe(true);
  expect(result.during.items).toHaveLength(2);
  expect(result.during.items.find(item => item.mutationId === result.deleteItem.mutationId).attemptedAt)
    .not.toBeNull();
  expect(result.sidecar.sidecar.lastSyncedSnapshot.deletedAt).not.toBeNull();
  expect(result.current.deletedAt).toBeNull();
  expect(result.after.items).toHaveLength(1);
  expect(result.after.items[0].request.operation).toBe("restore");
  expect(result.after.items[0].request.baseRevision).toBe(result.settled.revision);
  expect(result.after.items[0].request.payload.deletedAt).toBeNull();
  expect(result.after.items[0].mutationId).not.toBe(result.deleteItem.mutationId);
});

test("Scenario E：conflict durable journal 后 successor 保留且阻塞", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const canonical = window.LingoFlowSyncCanonical;
    const state = window.LingoFlowSyncStateRepository;
    const capture = window.LingoFlowSyncFavoriteService;
    const favorites = window.LingoFlowFavoriteRepository;
    const fake = window.LingoFlowFakeSyncService.create();
    await capture.bindWorkspace(owner);
    const baseline = favorites.create({ type: "word", text: "conflict", note: "base" });
    const seed = fake.push({ ownerId: owner.ownerId }, {
      mutationId: "mutation:seed:conflict",
      entityType: "favorites",
      entityId: baseline.id,
      scope: "record",
      schemaVersion: "1",
      operation: "put",
      baseRevision: null,
      observedCursor: null,
      payload: baseline
    });
    await state.putSidecar({
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      entityType: "favorites",
      entityId: baseline.id,
      scope: "record",
      schemaVersion: "1",
      serverRevision: seed.revision,
      lastSyncedSnapshot: baseline,
      lastSyncedFingerprint: canonical.fingerprint(baseline)
    });
    fake.push({ ownerId: owner.ownerId }, {
      mutationId: "mutation:remote:conflict",
      entityType: "favorites",
      entityId: baseline.id,
      scope: "record",
      schemaVersion: "1",
      operation: "put",
      baseRevision: seed.revision,
      observedCursor: null,
      payload: {
        ...baseline,
        note: "remote",
        updatedAt: new Date(Date.parse(baseline.updatedAt) + 1000).toISOString()
      }
    });
    await capture.update(owner, baseline.id, { note: "local A" });

    let releasePush;
    let markStarted;
    const started = new Promise(resolve => { markStarted = resolve; });
    const gate = new Promise(resolve => { releasePush = resolve; });
    const worker = window.LingoFlowSyncFavoritePushWorker.create({
      push: async (wireOwner, request) => {
        markStarted();
        await gate;
        return fake.push(wireOwner, request);
      }
    });
    const running = worker.runOnce(owner);
    await started;
    await capture.update(owner, baseline.id, { note: "local B" });
    releasePush();
    const conflicted = await running;
    const secondRun = await worker.runOnce(owner);
    return {
      baseline,
      seed,
      conflicted,
      secondRun,
      current: favorites.getById(baseline.id),
      sidecar: await state.getSidecar(owner.ownerId, baseline.id),
      outbox: await state.listOutbox({ ownerId: owner.ownerId }),
      issues: await state.listIssues({ ownerId: owner.ownerId, bindingId: owner.bindingId }),
      remote: fake.pull({ ownerId: owner.ownerId }, null)
    };
  }, OWNER);

  expect(result.conflicted.status).toBe("conflict");
  expect(result.current.note).toBe("local B");
  expect(result.sidecar.sidecar.serverRevision).toBe(result.seed.revision);
  expect(result.issues.issues).toHaveLength(1);
  expect(result.issues.issues[0]).toMatchObject({ kind: "conflict", reason: "revision-mismatch" });
  expect(result.issues.issues[0].request.payload.note).toBe("local A");
  expect(result.issues.issues[0].result.currentPayload.note).toBe("remote");
  expect(result.outbox.items).toHaveLength(1);
  expect(result.outbox.items[0].dependsOnMutationId).toBe(result.conflicted.mutationId);
  expect(result.secondRun.status).toBe("blocked");
  expect(result.remote.changes).toHaveLength(2);
});

test("一个 Favorite 的 unresolved issue 不阻塞其他 Favorite push", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    const capture = window.LingoFlowSyncFavoriteService;
    const favorites = window.LingoFlowFavoriteRepository;
    await capture.bindWorkspace(owner);

    const x = await capture.create(owner, { type: "word", text: "issue record x" });
    let releaseConflict;
    let markConflictStarted;
    const conflictStarted = new Promise(resolve => { markConflictStarted = resolve; });
    const conflictGate = new Promise(resolve => { releaseConflict = resolve; });
    const conflictWorker = window.LingoFlowSyncFavoritePushWorker.create({
      push: async (_wireOwner, request) => {
        markConflictStarted();
        await conflictGate;
        return {
          status: "conflict",
          mutationId: request.mutationId,
          entityType: request.entityType,
          entityId: request.entityId,
          scope: request.scope,
          schemaVersion: request.schemaVersion,
          reason: "revision-mismatch",
          currentRevision: "revision:remote:x",
          currentCursor: "cursor:remote:x",
          currentPayload: { ...request.payload, note: "remote x" }
        };
      }
    });
    const conflicting = conflictWorker.runOnce(owner);
    await conflictStarted;
    await capture.update(owner, x.favorite.id, { note: "local x successor" });
    releaseConflict();
    const xConflict = await conflicting;
    const xAfterConflict = await state.listOutbox({
      ownerId: owner.ownerId,
      entityId: x.favorite.id
    });
    const xIssuesBefore = await state.listIssues({
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      entityId: x.favorite.id
    });

    const y = await capture.create(owner, { type: "word", text: "independent record y" });
    const fake = window.LingoFlowFakeSyncService.create();
    const sent = [];
    const yWorker = window.LingoFlowSyncFavoritePushWorker.create({
      push: (wireOwner, request) => {
        sent.push(structuredClone(request));
        return fake.push(wireOwner, request);
      }
    });
    const yResult = await yWorker.runOnce(owner);
    return {
      x,
      y,
      xConflict,
      xAfterConflict,
      xIssuesBefore,
      yResult,
      sent,
      xCurrent: favorites.getById(x.favorite.id),
      yCurrent: favorites.getById(y.favorite.id),
      xOutboxAfter: await state.listOutbox({
        ownerId: owner.ownerId,
        entityId: x.favorite.id
      }),
      xIssuesAfter: await state.listIssues({
        ownerId: owner.ownerId,
        bindingId: owner.bindingId,
        entityId: x.favorite.id
      }),
      yOutboxAfter: await state.listOutbox({
        ownerId: owner.ownerId,
        entityId: y.favorite.id
      }),
      ySidecar: await state.getSidecar(owner.ownerId, y.favorite.id)
    };
  }, OWNER);

  expect(result.xConflict.status).toBe("conflict");
  expect(result.xAfterConflict.items).toHaveLength(1);
  expect(result.xAfterConflict.items[0].dependsOnMutationId).toBe(result.xConflict.mutationId);
  expect(result.xIssuesBefore.issues).toHaveLength(1);
  expect(result.yResult.status).toBe("applied");
  expect(result.sent).toHaveLength(1);
  expect(result.sent[0].entityId).toBe(result.y.favorite.id);
  expect(result.xCurrent.note).toBe("local x successor");
  expect(result.xOutboxAfter.items).toEqual(result.xAfterConflict.items);
  expect(result.xIssuesAfter.issues).toEqual(result.xIssuesBefore.issues);
  expect(result.yCurrent).toEqual(result.y.favorite);
  expect(result.yOutboxAfter.items).toEqual([]);
  expect(result.ySidecar.sidecar.lastSyncedSnapshot).toEqual(result.y.favorite);
});

test("Scenario F：合法 rejected 进入 issue 并停止重试", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    const capture = window.LingoFlowSyncFavoriteService;
    const favorites = window.LingoFlowFavoriteRepository;
    await capture.bindWorkspace(owner);
    const created = await capture.create(owner, { type: "word", text: "rejected" });
    let calls = 0;
    const worker = window.LingoFlowSyncFavoritePushWorker.create({
      push: (_wireOwner, request) => {
        calls += 1;
        return {
          status: "rejected",
          mutationId: request.mutationId,
          entityType: request.entityType,
          entityId: request.entityId,
          scope: request.scope,
          reason: "unsupported-capability"
        };
      }
    });
    const rejected = await worker.runOnce(owner);
    const settledOutbox = await state.listOutbox({ ownerId: owner.ownerId });
    const again = await worker.runOnce(owner);
    return {
      created,
      rejected,
      settledOutbox,
      again,
      calls,
      current: favorites.getById(created.favorite.id),
      sidecar: await state.getSidecar(owner.ownerId, created.favorite.id),
      outbox: await state.listOutbox({ ownerId: owner.ownerId }),
      issues: await state.listIssues({ ownerId: owner.ownerId, bindingId: owner.bindingId })
    };
  }, OWNER);

  expect(result.rejected.status).toBe("rejected");
  expect(result.calls).toBe(1);
  expect(result.settledOutbox.items).toEqual([]);
  expect(result.again.status).toBe("blocked");
  expect(result.again.reason).toBe("no-sendable-ready-mutation");
  expect(result.current).toEqual(result.created.favorite);
  expect(result.sidecar.status).toBe("missing");
  expect(result.outbox.items).toHaveLength(1);
  expect(result.outbox.items[0].dependsOnMutationId).toBeNull();
  expect(result.issues.issues).toHaveLength(1);
  expect(result.issues.issues[0].request).toEqual(result.rejected.issue.request);
});

test("两个 Worker 同时 run 只有一个取得 lease", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const capture = window.LingoFlowSyncFavoriteService;
    await capture.bindWorkspace(owner);
    await capture.create(owner, { type: "word", text: "two workers" });
    const fake = window.LingoFlowFakeSyncService.create();
    let releasePush;
    let markStarted;
    let calls = 0;
    const started = new Promise(resolve => { markStarted = resolve; });
    const gate = new Promise(resolve => { releasePush = resolve; });
    const adapter = async (wireOwner, request) => {
      calls += 1;
      markStarted();
      await gate;
      return fake.push(wireOwner, request);
    };
    const firstWorker = window.LingoFlowSyncFavoritePushWorker.create({ push: adapter });
    const secondWorker = window.LingoFlowSyncFavoritePushWorker.create({ push: adapter });
    const firstPromise = firstWorker.runOnce(owner, { leaseMs: 60000 });
    await started;
    const second = await secondWorker.runOnce(owner, { leaseMs: 60000 });
    releasePush();
    const first = await firstPromise;
    return { first, second, calls };
  }, OWNER);

  expect(result.first.status).toBe("applied");
  expect(result.second.status).toBe("busy");
  expect(result.calls).toBe(1);
});

test("expired lease 可 takeover，旧 token settlement 被拒绝", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    const capture = window.LingoFlowSyncFavoriteService;
    const fake = window.LingoFlowFakeSyncService.create();
    await capture.bindWorkspace(owner);
    await capture.create(owner, { type: "word", text: "lease takeover" });
    const first = await state.acquireNextReadyMutationLease(owner, { leaseMs: 60000 });
    const expired = structuredClone(first.item);
    expired.leaseExpiresAt = "2026-01-01T00:00:00.000Z";
    await window.__putSyncStore("outbox", expired);
    const second = await state.acquireNextReadyMutationLease(owner, { leaseMs: 60000 });
    const serverResult = fake.push({ ownerId: owner.ownerId }, structuredClone(first.item.request));
    const oldSettlement = await state.settleSuccessfulMutation({
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      mutationId: first.item.mutationId,
      leaseToken: first.item.leaseToken,
      request: first.item.request,
      result: serverResult,
      successor: null
    });
    const newSettlement = await state.settleSuccessfulMutation({
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      mutationId: second.item.mutationId,
      leaseToken: second.item.leaseToken,
      request: second.item.request,
      result: serverResult,
      successor: null
    });
    return { first, second, oldSettlement, newSettlement };
  }, OWNER);

  expect(result.second.item.mutationId).toBe(result.first.item.mutationId);
  expect(result.second.item.attemptedAt).toBe(result.first.item.attemptedAt);
  expect(result.second.item.attemptCount).toBe(2);
  expect(result.second.item.leaseToken).not.toBe(result.first.item.leaseToken);
  expect(result.oldSettlement).toMatchObject({ status: "blocked", reason: "stale-push-lease" });
  expect(result.newSettlement.status).toBe("settled");
});

test("transport throw 保留 attempted request，retry 使用同 mutationId", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    const capture = window.LingoFlowSyncFavoriteService;
    await capture.bindWorkspace(owner);
    await capture.create(owner, { type: "word", text: "transport retry" });
    const original = (await state.listOutbox({ ownerId: owner.ownerId })).items[0];
    const failedWorker = window.LingoFlowSyncFavoritePushWorker.create({
      push: () => { throw new Error("offline"); }
    });
    const failed = await failedWorker.runOnce(owner);
    const retained = (await state.listOutbox({ ownerId: owner.ownerId })).items[0];
    const fake = window.LingoFlowFakeSyncService.create();
    const retryWorker = window.LingoFlowSyncFavoritePushWorker.create({
      push: (wireOwner, request) => fake.push(wireOwner, request)
    });
    const retried = await retryWorker.runOnce(owner);
    return { original, failed, retained, retried };
  }, OWNER);

  expect(result.failed).toMatchObject({
    status: "failed",
    reason: "push-transport-failed",
    retryable: true,
    released: true
  });
  expect(result.retained.mutationId).toBe(result.original.mutationId);
  expect(result.retained.request).toEqual(result.original.request);
  expect(result.retained.attemptedAt).not.toBeNull();
  expect(result.retained.attemptCount).toBe(1);
  expect(result.retained.leaseToken).toBeNull();
  expect(result.retried.status).toBe("applied");
});

for (const scenario of [
  {
    title: "malformed result",
    reason: "invalid-push-result",
    build: () => ({ status: "applied" })
  },
  {
    title: "result identity mismatch",
    reason: "push-result-identity-mismatch",
    build: request => ({
      status: "applied",
      mutationId: `${request.mutationId}:wrong`,
      entityType: request.entityType,
      entityId: request.entityId,
      scope: request.scope,
      schemaVersion: request.schemaVersion,
      revision: "revision:1",
      cursor: "cursor:1"
    })
  }
]) {
  test(`${scenario.title} 保留 ready outbox 且不写 issue`, async ({ page }) => {
    const result = await page.evaluate(async ({ owner, scenarioIndex }) => {
      const scenarios = [
        () => ({ status: "applied" }),
        request => ({
          status: "applied",
          mutationId: `${request.mutationId}:wrong`,
          entityType: request.entityType,
          entityId: request.entityId,
          scope: request.scope,
          schemaVersion: request.schemaVersion,
          revision: "revision:1",
          cursor: "cursor:1"
        })
      ];
      const state = window.LingoFlowSyncStateRepository;
      const capture = window.LingoFlowSyncFavoriteService;
      await capture.bindWorkspace(owner);
      await capture.create(owner, { type: "word", text: `bad result ${scenarioIndex}` });
      const worker = window.LingoFlowSyncFavoritePushWorker.create({
        push: (_wireOwner, request) => scenarios[scenarioIndex](request)
      });
      const pushed = await worker.runOnce(owner);
      return {
        pushed,
        outbox: await state.listOutbox({ ownerId: owner.ownerId }),
        issues: await state.listIssues({ ownerId: owner.ownerId, bindingId: owner.bindingId })
      };
    }, { owner: OWNER, scenarioIndex: scenario.title === "malformed result" ? 0 : 1 });

    expect(result.pushed).toMatchObject({
      status: "failed",
      reason: scenario.reason,
      retryable: true,
      released: true
    });
    expect(result.outbox.items).toHaveLength(1);
    expect(result.outbox.items[0].attemptedAt).not.toBeNull();
    expect(result.issues.issues).toEqual([]);
  });
}

test("合法 result 的 entityId 不属于 leased request 时保留原 mutation 可重试", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    const capture = window.LingoFlowSyncFavoriteService;
    const favorites = window.LingoFlowFavoriteRepository;
    await capture.bindWorkspace(owner);
    const created = await capture.create(owner, { type: "word", text: "wrong result entity" });
    const original = (await state.listOutbox({ ownerId: owner.ownerId })).items[0];
    const before = structuredClone(favorites.getById(created.favorite.id));
    const fake = window.LingoFlowFakeSyncService.create();
    const failedWorker = window.LingoFlowSyncFavoritePushWorker.create({
      push: (wireOwner, request) => {
        const applied = fake.push(wireOwner, request);
        return { ...applied, entityId: `${request.entityId}:other` };
      }
    });
    const failed = await failedWorker.runOnce(owner);
    const retained = await state.listOutbox({ ownerId: owner.ownerId });
    const afterFailure = structuredClone(favorites.getById(created.favorite.id));
    const sidecarAfterFailure = await state.getSidecar(owner.ownerId, created.favorite.id);
    const issuesAfterFailure = await state.listIssues({
      ownerId: owner.ownerId,
      bindingId: owner.bindingId
    });
    const retryWorker = window.LingoFlowSyncFavoritePushWorker.create({
      push: (wireOwner, request) => fake.push(wireOwner, request)
    });
    const retried = await retryWorker.runOnce(owner);
    return {
      created,
      original,
      before,
      failed,
      retained,
      afterFailure,
      sidecarAfterFailure,
      issuesAfterFailure,
      retried,
      finalOutbox: await state.listOutbox({ ownerId: owner.ownerId }),
      finalSidecar: await state.getSidecar(owner.ownerId, created.favorite.id),
      remote: fake.pull({ ownerId: owner.ownerId }, null)
    };
  }, OWNER);

  expect(result.failed).toMatchObject({
    status: "failed",
    reason: "push-result-identity-mismatch",
    retryable: true,
    mutationId: result.original.mutationId,
    released: true
  });
  expect(result.retained.items).toHaveLength(1);
  expect(result.retained.items[0].mutationId).toBe(result.original.mutationId);
  expect(result.retained.items[0].request).toEqual(result.original.request);
  expect(result.retained.items[0].attemptedAt).not.toBeNull();
  expect(result.retained.items[0].attemptCount).toBe(1);
  expect(result.retained.items[0].leaseToken).toBeNull();
  expect(result.afterFailure).toEqual(result.before);
  expect(result.sidecarAfterFailure.status).toBe("missing");
  expect(result.issuesAfterFailure.issues).toEqual([]);
  expect(result.retried.status).toBe("applied");
  expect(result.retried.mutationId).toBe(result.original.mutationId);
  expect(result.finalOutbox.items).toEqual([]);
  expect(result.finalSidecar.sidecar.lastSyncedSnapshot).toEqual(result.original.request.payload);
  expect(result.remote.changes).toHaveLength(1);
});

test("success settlement add failure 回滚 sidecar 与 outbox", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const canonical = window.LingoFlowSyncCanonical;
    const state = window.LingoFlowSyncStateRepository;
    const capture = window.LingoFlowSyncFavoriteService;
    const favorites = window.LingoFlowFavoriteRepository;
    const fake = window.LingoFlowFakeSyncService.create();
    await capture.bindWorkspace(owner);
    const first = await capture.create(owner, { type: "word", text: "rollback head" });
    const leased = await state.acquireNextReadyMutationLease(owner, { leaseMs: 60000 });
    const serverResult = fake.push({ ownerId: owner.ownerId }, leased.item.request);
    const second = await capture.create(owner, { type: "word", text: "collision key" });
    const other = (await state.listOutbox({ ownerId: owner.ownerId, entityId: second.favorite.id })).items[0];
    const current = favorites.getById(first.favorite.id);
    const successor = {
      ...structuredClone(leased.item),
      mutationId: other.mutationId,
      status: "ready",
      entityId: current.id,
      createdAt: new Date().toISOString(),
      localOperation: "drift",
      localBeforeSnapshot: current,
      localBeforeFingerprint: canonical.fingerprint(current),
      candidateFingerprint: canonical.fingerprint(current),
      request: {
        ...structuredClone(leased.item.request),
        mutationId: other.mutationId,
        baseRevision: serverResult.revision,
        payload: current
      },
      attemptedAt: null,
      attemptCount: 0,
      leaseToken: null,
      leaseExpiresAt: null,
      dependsOnMutationId: null
    };
    const settled = await state.settleSuccessfulMutation({
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      mutationId: leased.item.mutationId,
      leaseToken: leased.item.leaseToken,
      request: leased.item.request,
      result: serverResult,
      successor
    });
    return {
      settled,
      sidecar: await state.getSidecar(owner.ownerId, first.favorite.id),
      head: await state.getOutbox(owner.ownerId, leased.item.mutationId)
    };
  }, OWNER);

  expect(result.settled).toMatchObject({ status: "failed", reason: "push-success-settlement-failed" });
  expect(result.sidecar.status).toBe("missing");
  expect(result.head.status).toBe("ready");
});

test("syncIssues add failure 不删除 outbox head", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    const capture = window.LingoFlowSyncFavoriteService;
    await capture.bindWorkspace(owner);
    await capture.create(owner, { type: "word", text: "issue rollback" });
    const leased = await state.acquireNextReadyMutationLease(owner, { leaseMs: 60000 });
    const conflict = {
      status: "conflict",
      mutationId: leased.item.mutationId,
      entityType: leased.item.entityType,
      entityId: leased.item.entityId,
      scope: leased.item.scope,
      schemaVersion: "1",
      reason: "revision-mismatch",
      currentRevision: "revision:9",
      currentCursor: "cursor:9",
      currentPayload: leased.item.request.payload
    };
    await window.__putSyncStore("syncIssues", {
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      mutationId: leased.item.mutationId,
      entityType: leased.item.entityType,
      entityId: leased.item.entityId,
      scope: leased.item.scope,
      schemaVersion: "1",
      kind: "conflict",
      reason: "revision-mismatch",
      request: leased.item.request,
      result: conflict,
      createdAt: new Date().toISOString()
    });
    const settled = await state.settleMutationIssue({
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      mutationId: leased.item.mutationId,
      leaseToken: leased.item.leaseToken,
      request: leased.item.request,
      result: conflict
    });
    return {
      settled,
      head: await state.getOutbox(owner.ownerId, leased.item.mutationId)
    };
  }, OWNER);

  expect(result.settled).toMatchObject({ status: "failed", reason: "push-issue-settlement-failed" });
  expect(result.head.status).toBe("ready");
});

test("ready selection 不发送 old binding 或其他 owner item", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    const capture = window.LingoFlowSyncFavoriteService;
    await capture.bindWorkspace(owner);
    await capture.create(owner, { type: "word", text: "current binding" });
    const current = (await state.listOutbox({ ownerId: owner.ownerId })).items[0];
    const oldBinding = structuredClone(current);
    oldBinding.mutationId = "mutation:old-binding";
    oldBinding.bindingId = "binding:old";
    oldBinding.createdAt = "2026-01-01T00:00:00.000Z";
    oldBinding.request.mutationId = oldBinding.mutationId;
    const otherOwner = structuredClone(current);
    otherOwner.ownerId = "owner:other";
    otherOwner.mutationId = "mutation:other-owner";
    otherOwner.request.mutationId = otherOwner.mutationId;
    await window.__putSyncStore("outbox", oldBinding);
    await window.__putSyncStore("outbox", otherOwner);
    const leased = await state.acquireNextReadyMutationLease(owner, { leaseMs: 60000 });
    return { current, leased };
  }, OWNER);

  expect(result.leased.status).toBe("leased");
  expect(result.leased.item.mutationId).toBe(result.current.mutationId);
  expect(result.leased.item.bindingId).toBe(OWNER.bindingId);
  expect(result.leased.item.ownerId).toBe(OWNER.ownerId);
});

for (const malformedRuntime of [
  { caseId: "negative-attempt-count", title: "attemptCount 为负数" },
  { caseId: "fractional-attempt-count", title: "attemptCount 为小数" },
  { caseId: "string-attempt-count", title: "attemptCount 为字符串" },
  { caseId: "malformed-attempted-at", title: "attemptedAt 非 canonical timestamp" },
  { caseId: "missing-attempted-at", title: "attemptCount 已增加但 attemptedAt 为 null" },
  { caseId: "unexpected-attempted-at", title: "attemptCount 为零但 attemptedAt 非 null" },
  { caseId: "missing-lease-expiry", title: "leaseToken 存在但 leaseExpiresAt 为 null" },
  { caseId: "missing-lease-token", title: "leaseExpiresAt 存在但 leaseToken 为 null" },
  { caseId: "malformed-lease-token", title: "leaseToken 非 opaque string" },
  { caseId: "malformed-lease-expiry", title: "leaseExpiresAt 非 canonical timestamp" },
  { caseId: "malformed-dependency", title: "dependsOnMutationId 非 opaque string" },
  { caseId: "self-dependency", title: "dependsOnMutationId 指向自身" }
]) {
  test(`malformed ready runtime：${malformedRuntime.title} 明确失败且不发送`, async ({ page }) => {
    const result = await page.evaluate(async ({ owner, caseId }) => {
      const state = window.LingoFlowSyncStateRepository;
      const capture = window.LingoFlowSyncFavoriteService;
      await capture.bindWorkspace(owner);
      await capture.create(owner, { type: "word", text: `runtime ${caseId}` });
      const item = (await state.listOutbox({ ownerId: owner.ownerId })).items[0];
      const malformed = structuredClone(item);
      const attemptedAt = "2026-09-02T01:00:00.000Z";
      const leaseExpiresAt = "2026-09-02T01:01:00.000Z";

      switch (caseId) {
        case "negative-attempt-count":
          malformed.attemptCount = -1;
          break;
        case "fractional-attempt-count":
          malformed.attemptCount = 1.5;
          break;
        case "string-attempt-count":
          malformed.attemptCount = "1";
          break;
        case "malformed-attempted-at":
          malformed.attemptCount = 1;
          malformed.attemptedAt = "not-a-timestamp";
          break;
        case "missing-attempted-at":
          malformed.attemptCount = 1;
          malformed.attemptedAt = null;
          break;
        case "unexpected-attempted-at":
          malformed.attemptCount = 0;
          malformed.attemptedAt = attemptedAt;
          break;
        case "missing-lease-expiry":
          malformed.attemptCount = 1;
          malformed.attemptedAt = attemptedAt;
          malformed.leaseToken = "favorite-push:valid";
          malformed.leaseExpiresAt = null;
          break;
        case "missing-lease-token":
          malformed.attemptCount = 1;
          malformed.attemptedAt = attemptedAt;
          malformed.leaseToken = null;
          malformed.leaseExpiresAt = leaseExpiresAt;
          break;
        case "malformed-lease-token":
          malformed.attemptCount = 1;
          malformed.attemptedAt = attemptedAt;
          malformed.leaseToken = " invalid-token ";
          malformed.leaseExpiresAt = leaseExpiresAt;
          break;
        case "malformed-lease-expiry":
          malformed.attemptCount = 1;
          malformed.attemptedAt = attemptedAt;
          malformed.leaseToken = "favorite-push:valid";
          malformed.leaseExpiresAt = "not-a-timestamp";
          break;
        case "malformed-dependency":
          malformed.dependsOnMutationId = " invalid-dependency ";
          break;
        case "self-dependency":
          malformed.dependsOnMutationId = malformed.mutationId;
          break;
        default:
          throw new Error(`未知 malformed runtime case: ${caseId}`);
      }

      await window.__putSyncStore("outbox", malformed);
      const listed = await state.listOutbox({ ownerId: owner.ownerId });
      let calls = 0;
      const worker = window.LingoFlowSyncFavoritePushWorker.create({
        push: () => {
          calls += 1;
          throw new Error("malformed runtime 不应发送");
        }
      });
      const pushed = await worker.runOnce(owner);
      const raw = await window.__getAllSyncStore("outbox");
      return { item, malformed, listed, pushed, calls, raw };
    }, { owner: OWNER, caseId: malformedRuntime.caseId });

    expect(result.listed).toMatchObject({ status: "failed", reason: "outbox-list-failed" });
    expect(result.pushed).toMatchObject({ status: "failed", reason: "outbox-list-failed" });
    expect(result.calls).toBe(0);
    expect(result.raw).toHaveLength(1);
    expect(result.raw[0]).toEqual(result.malformed);
    expect(result.raw[0].mutationId).toBe(result.item.mutationId);
    expect(result.raw[0].request).toEqual(result.item.request);
  });
}

test("malformed syncIssues 明确 failed，不退化为空集合", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    const capture = window.LingoFlowSyncFavoriteService;
    await capture.bindWorkspace(owner);
    await window.__putSyncStore("syncIssues", {
      ownerId: owner.ownerId,
      mutationId: "mutation:malformed-issue",
      kind: "conflict"
    });
    return await state.listIssues({ ownerId: owner.ownerId, bindingId: owner.bindingId });
  }, OWNER);

  expect(result).toMatchObject({ status: "failed", reason: "sync-issue-list-failed" });
});

test("v1 → v3 保留 binding、sidecar、prepared/ready request 并补齐 runtime metadata", async ({ page }) => {
  await page.goto("/");
  await page.addScriptTag({ url: "/js/sync-canonical.js" });
  await page.addScriptTag({ url: "/js/cloud-sync-protocol.js" });
  const result = await page.evaluate(async owner => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase("LingoFlowSyncDB");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    const canonical = window.LingoFlowSyncCanonical;
    const favorite = {
      id: "favorite:v1",
      type: "word",
      text: "v1 retained",
      createdAt: "2026-09-01T01:00:00.000Z",
      updatedAt: "2026-09-01T01:00:00.000Z",
      deletedAt: null
    };
    const makeItem = (mutationId, status, entityId) => {
      const payload = { ...favorite, id: entityId };
      return {
        ownerId: owner.ownerId,
        bindingId: owner.bindingId,
        mutationId,
        status,
        entityType: "favorites",
        entityId,
        scope: "record",
        createdAt: "2026-09-01T02:00:00.000Z",
        localOperation: "drift",
        localBeforeSnapshot: payload,
        localBeforeFingerprint: canonical.fingerprint(payload),
        candidateFingerprint: canonical.fingerprint(payload),
        request: {
          mutationId,
          entityType: "favorites",
          entityId,
          scope: "record",
          schemaVersion: "1",
          operation: "put",
          baseRevision: "revision:5",
          observedCursor: null,
          payload
        }
      };
    };
    const prepared = makeItem("mutation:v1:prepared", "prepared", "favorite:v1:prepared");
    const ready = makeItem("mutation:v1:ready", "ready", "favorite:v1:ready");
    const sidecar = {
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      entityType: "favorites",
      entityId: favorite.id,
      scope: "record",
      schemaVersion: "1",
      serverRevision: "revision:5",
      lastSyncedSnapshot: favorite,
      lastSyncedFingerprint: canonical.fingerprint(favorite)
    };

    await new Promise((resolve, reject) => {
      const request = indexedDB.open("LingoFlowSyncDB", 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        const control = db.createObjectStore("control", { keyPath: "key" });
        const sidecars = db.createObjectStore("entitySidecars", {
          keyPath: ["ownerId", "entityType", "entityId", "scope"]
        });
        sidecars.createIndex("byOwnerEntityType", ["ownerId", "entityType"]);
        const outbox = db.createObjectStore("outbox", { keyPath: ["ownerId", "mutationId"] });
        outbox.createIndex("byOwnerRecord", ["ownerId", "entityType", "entityId", "scope"]);
        outbox.createIndex("byOwnerStatusCreatedAt", ["ownerId", "status", "createdAt"]);
        control.add({ key: "workspace-binding", ...owner });
        sidecars.add(sidecar);
        outbox.add(prepared);
        outbox.add(ready);
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
    return { favorite, prepared, ready, sidecar };
  }, OWNER);

  await page.addScriptTag({ url: "/js/sync-state-repository.js" });
  const upgraded = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    const db = await state.openDatabase();
    return {
      version: db.version,
      stores: Array.from(db.objectStoreNames).sort(),
      binding: await state.getWorkspaceBinding(),
      sidecar: await state.getSidecar(owner.ownerId, "favorite:v1"),
      outbox: await state.listOutbox({ ownerId: owner.ownerId })
    };
  }, OWNER);

  expect(upgraded.version).toBe(3);
  expect(upgraded.stores).toEqual([
    "control",
    "entitySidecars",
    "inbox",
    "outbox",
    "syncIssues"
  ]);
  expect(upgraded.binding.binding).toMatchObject(OWNER);
  expect(upgraded.sidecar.sidecar).toEqual(result.sidecar);
  expect(upgraded.outbox.items).toHaveLength(2);
  for (const item of upgraded.outbox.items) {
    const original = item.status === "prepared" ? result.prepared : result.ready;
    expect(item.mutationId).toBe(original.mutationId);
    expect(item.request).toEqual(original.request);
    expect(item).toMatchObject({
      attemptedAt: null,
      attemptCount: 0,
      leaseToken: null,
      leaseExpiresAt: null,
      dependsOnMutationId: null
    });
  }
});

test("v1 ready mutation 升级至 v3 后以原 identity 完成真实 push settlement", async ({ page }) => {
  await page.goto("/");
  await page.addScriptTag({ url: "/js/sync-canonical.js" });
  await page.addScriptTag({ url: "/js/cloud-sync-protocol.js" });
  const fixture = await page.evaluate(async owner => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase("LingoFlowSyncDB");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("v1 fixture database deletion blocked"));
    });
    const canonical = window.LingoFlowSyncCanonical;
    const favorite = {
      id: "favorite:v1:push",
      type: "word",
      text: "v1 real push",
      note: "frozen v1 payload",
      createdAt: "2026-09-02T02:00:00.000Z",
      updatedAt: "2026-09-02T02:00:00.000Z",
      deletedAt: null
    };
    const mutationId = "mutation:v1:real-push";
    const request = {
      mutationId,
      entityType: "favorites",
      entityId: favorite.id,
      scope: "record",
      schemaVersion: "1",
      operation: "put",
      baseRevision: null,
      observedCursor: null,
      payload: favorite
    };
    const ready = {
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      mutationId,
      status: "ready",
      entityType: "favorites",
      entityId: favorite.id,
      scope: "record",
      createdAt: "2026-09-02T02:01:00.000Z",
      localOperation: "drift",
      localBeforeSnapshot: favorite,
      localBeforeFingerprint: canonical.fingerprint(favorite),
      candidateFingerprint: canonical.fingerprint(favorite),
      request
    };
    localStorage.setItem("LingoFlowFavoriteEntities", JSON.stringify({
      [favorite.id]: favorite
    }));

    await new Promise((resolve, reject) => {
      const open = indexedDB.open("LingoFlowSyncDB", 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        const control = db.createObjectStore("control", { keyPath: "key" });
        const sidecars = db.createObjectStore("entitySidecars", {
          keyPath: ["ownerId", "entityType", "entityId", "scope"]
        });
        sidecars.createIndex("byOwnerEntityType", ["ownerId", "entityType"]);
        const outbox = db.createObjectStore("outbox", {
          keyPath: ["ownerId", "mutationId"]
        });
        outbox.createIndex(
          "byOwnerRecord",
          ["ownerId", "entityType", "entityId", "scope"]
        );
        outbox.createIndex(
          "byOwnerStatusCreatedAt",
          ["ownerId", "status", "createdAt"]
        );
        control.add({ key: "workspace-binding", ...owner });
        outbox.add(ready);
      };
      open.onsuccess = () => {
        open.result.close();
        resolve();
      };
      open.onerror = () => reject(open.error);
    });
    return { favorite, mutationId, request, ready };
  }, OWNER);

  await page.addScriptTag({ url: "/js/fake-sync-service.js" });
  await page.addScriptTag({ url: "/js/sync-state-repository.js" });
  await page.addScriptTag({ url: "/js/sync-favorite-service.js" });
  await page.addScriptTag({ url: "/js/sync-favorite-push-worker.js" });
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    const favorites = window.LingoFlowFavoriteRepository;
    const db = await state.openDatabase();
    const upgraded = await state.listOutbox({ ownerId: owner.ownerId });
    const fake = window.LingoFlowFakeSyncService.create();
    const sent = [];
    const worker = window.LingoFlowSyncFavoritePushWorker.create({
      push: (wireOwner, request) => {
        sent.push(structuredClone(request));
        return fake.push(wireOwner, request);
      }
    });
    const pushed = await worker.runOnce(owner);
    return {
      version: db.version,
      stores: Array.from(db.objectStoreNames).sort(),
      upgraded,
      sent,
      pushed,
      current: favorites.getById("favorite:v1:push"),
      sidecar: await state.getSidecar(owner.ownerId, "favorite:v1:push"),
      outbox: await state.listOutbox({ ownerId: owner.ownerId }),
      remote: fake.pull({ ownerId: owner.ownerId }, null)
    };
  }, OWNER);

  expect(result.version).toBe(3);
  expect(result.stores).toEqual([
    "control",
    "entitySidecars",
    "inbox",
    "outbox",
    "syncIssues"
  ]);
  expect(result.upgraded.items).toHaveLength(1);
  expect(result.upgraded.items[0].mutationId).toBe(fixture.mutationId);
  expect(result.upgraded.items[0].request).toEqual(fixture.request);
  expect(result.upgraded.items[0]).toMatchObject({
    attemptedAt: null,
    attemptCount: 0,
    leaseToken: null,
    leaseExpiresAt: null,
    dependsOnMutationId: null
  });
  expect(result.sent).toEqual([fixture.request]);
  expect(result.pushed).toMatchObject({
    status: "applied",
    mutationId: fixture.mutationId
  });
  expect(result.current).toEqual(fixture.favorite);
  expect(result.sidecar.sidecar).toMatchObject({
    serverRevision: result.pushed.revision,
    lastSyncedSnapshot: fixture.favorite
  });
  expect(result.outbox.items).toEqual([]);
  expect(result.remote.changes).toHaveLength(1);
  expect(result.remote.changes[0].payload).toEqual(fixture.favorite);
});
