const { test, expect } = require("@playwright/test");

const projectErrors = new WeakMap();
const OWNER = Object.freeze({ ownerId: "owner:pull", bindingId: "binding:pull" });

function makeFavorite(id, overrides = {}) {
  return {
    id,
    type: "word",
    text: id.replace(/^favorite:/, ""),
    meaning: "Remote Favorite",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides
  };
}

async function loadPullScripts(page) {
  await page.addScriptTag({ url: "/js/sync-canonical.js" });
  await page.addScriptTag({ url: "/js/cloud-sync-protocol.js" });
  await page.addScriptTag({ url: "/js/fake-sync-service.js" });
  await page.addScriptTag({ url: "/js/sync-state-repository.js" });
  await page.addScriptTag({ url: "/js/sync-favorite-service.js" });
  await page.addScriptTag({ url: "/js/sync-favorite-push-worker.js" });
  await page.addScriptTag({ url: "/js/sync-favorite-pull-worker.js" });
  await page.evaluate(() => {
    window.__getAllSyncStore = async storeName => {
      const db = await window.LingoFlowSyncStateRepository.openDatabase();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const request = tx.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(structuredClone(request.result));
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
    window.__deleteSyncStore = async (storeName, key) => {
      const db = await window.LingoFlowSyncStateRepository.openDatabase();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    };
    window.__remoteMutation = (fake, owner, payload, options = {}) => fake.push(
      { ownerId: owner.ownerId },
      {
        mutationId: options.mutationId || `mutation:remote:${crypto.randomUUID()}`,
        entityType: "favorites",
        entityId: payload.id,
        scope: "record",
        schemaVersion: "1",
        operation: options.operation || "put",
        baseRevision: options.baseRevision ?? null,
        observedCursor: null,
        payload: structuredClone(payload)
      }
    );
    window.__makePullWorker = fake => window.LingoFlowSyncFavoritePullWorker.create({
      pull: (wireOwner, cursor) => fake.pull(wireOwner, cursor)
    });
    window.__makeChange = (favorite, options = {}) => ({
      cursor: options.cursor || `cursor:test:${crypto.randomUUID()}`,
      entityType: "favorites",
      entityId: favorite.id,
      scope: "record",
      schemaVersion: "1",
      revision: options.revision || `revision:test:${crypto.randomUUID()}`,
      operation: options.operation || "put",
      payload: structuredClone(favorite)
    });
    window.__putLocalFavorite = favorite => {
      const key = "LingoFlowFavoriteEntities";
      const map = JSON.parse(localStorage.getItem(key) || "{}");
      map[favorite.id] = structuredClone(favorite);
      localStorage.setItem(key, JSON.stringify(map));
    };
    window.__putSidecar = async (owner, favorite, revision) => {
      const canonical = window.LingoFlowSyncCanonical;
      return await window.LingoFlowSyncStateRepository.putSidecar({
        ownerId: owner.ownerId,
        bindingId: owner.bindingId,
        entityType: "favorites",
        entityId: favorite.id,
        scope: "record",
        schemaVersion: "1",
        serverRevision: revision,
        lastSyncedSnapshot: structuredClone(favorite),
        lastSyncedFingerprint: canonical.fingerprint(favorite)
      });
    };
    window.__syncRemoteCreate = async (fake, owner, favorite) => {
      const remote = window.__remoteMutation(fake, owner, favorite);
      const worker = window.__makePullWorker(fake);
      const received = await worker.receiveOnce(owner);
      const applied = await worker.applyNext(owner);
      return { remote, received, applied };
    };
  });
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
  await page.goto("/");
  await expect(page.locator("#inputText")).toBeVisible();
  await loadPullScripts(page);
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

test("validatePullResult 严格接受 ready 并返回深隔离 snapshot", async ({ page }) => {
  const favorite = makeFavorite("favorite:protocol-ready");
  const result = await page.evaluate(favorite => {
    const protocol = window.LingoFlowCloudSyncProtocol;
    const change = window.__makeChange(favorite, {
      cursor: "cursor:ready",
      revision: "revision:ready"
    });
    const input = { status: "ready", changes: [change], nextCursor: "cursor:ready" };
    const validated = protocol.validatePullResult(input);
    input.changes[0].payload.text = "mutated input";
    validated.pullResult.changes[0].payload.meaning = "mutated result";
    const again = protocol.validatePullResult({
      status: "ready",
      changes: [change],
      nextCursor: "cursor:ready"
    });
    return { validated, again };
  }, favorite);

  expect(result.validated.status).toBe("valid");
  expect(result.validated.pullResult.changes[0].payload.text).toBe(favorite.text);
  expect(result.again.pullResult.changes[0].payload.meaning).toBe(favorite.meaning);
});

test("validatePullResult 严格接受 formal rejected", async ({ page }) => {
  const result = await page.evaluate(() => window.LingoFlowCloudSyncProtocol.validatePullResult({
    status: "rejected",
    changes: [],
    nextCursor: null,
    reason: "invalid-cursor"
  }));
  expect(result).toEqual({
    status: "valid",
    pullResult: {
      status: "rejected",
      changes: [],
      nextCursor: null,
      reason: "invalid-cursor"
    },
    errors: []
  });
});

test("validatePullResult 拒绝未知顶层字段且不返回部分 payload", async ({ page }) => {
  const result = await page.evaluate(() => window.LingoFlowCloudSyncProtocol.validatePullResult({
    status: "ready",
    changes: [],
    nextCursor: "cursor:0",
    extra: true
  }));
  expect(result.status).toBe("rejected");
  expect(result.pullResult).toBeNull();
  expect(result.errors).not.toEqual([]);
});

test("validatePullResult 拒绝 duplicate cursor", async ({ page }) => {
  const favorite = makeFavorite("favorite:duplicate-cursor");
  const result = await page.evaluate(favorite => {
    const first = window.__makeChange(favorite, {
      cursor: "cursor:duplicate",
      revision: "revision:1"
    });
    const second = window.__makeChange({ ...favorite, text: "different" }, {
      cursor: "cursor:duplicate",
      revision: "revision:2"
    });
    return window.LingoFlowCloudSyncProtocol.validatePullResult({
      status: "ready",
      changes: [first, second],
      nextCursor: "cursor:duplicate"
    });
  }, favorite);
  expect(result.status).toBe("rejected");
  expect(result.pullResult).toBeNull();
  expect(result.errors.some(error => error.code === "duplicate-pull-cursor")).toBe(true);
});

test("validatePullResult 不执行 getter 并拒绝非 JSON-safe change", async ({ page }) => {
  const result = await page.evaluate(() => {
    let reads = 0;
    const value = { status: "ready", nextCursor: "cursor:unsafe" };
    Object.defineProperty(value, "changes", {
      enumerable: true,
      get() {
        reads += 1;
        return [];
      }
    });
    const validation = window.LingoFlowCloudSyncProtocol.validatePullResult(value);
    return { reads, validation };
  });
  expect(result.reads).toBe(0);
  expect(result.validation.status).toBe("rejected");
  expect(result.validation.pullResult).toBeNull();
});

test("Scenario A：远端 create 经 durable Inbox 精确落地并推进双 cursor", async ({ page }) => {
  const favorite = makeFavorite("favorite:remote-create", {
    futureRemoteFact: { source: "server" }
  });
  const result = await page.evaluate(async ({ owner, favorite }) => {
    const state = window.LingoFlowSyncStateRepository;
    const favorites = window.LingoFlowFavoriteRepository;
    await state.bindWorkspace(owner);
    const fake = window.LingoFlowFakeSyncService.create();
    const remote = window.__remoteMutation(fake, owner, favorite);
    const worker = window.__makePullWorker(fake);
    const received = await worker.receiveOnce(owner);
    const afterReceive = {
      progress: await state.getPullProgress(owner),
      inbox: await state.listInbox(owner),
      favorite: favorites.getById(favorite.id, { includeDeleted: true })
    };
    const applied = await worker.applyNext(owner);
    return {
      remote,
      received,
      afterReceive,
      applied,
      progress: await state.getPullProgress(owner),
      inbox: await state.listInbox(owner),
      current: favorites.getById(favorite.id, { includeDeleted: true }),
      sidecar: await state.getSidecar(owner.ownerId, favorite.id),
      outbox: await state.listOutbox({ ownerId: owner.ownerId })
    };
  }, { owner: OWNER, favorite });

  expect(result.remote.status).toBe("applied");
  expect(result.received.status).toBe("received");
  expect(result.received.received).toBe(1);
  expect(result.afterReceive.favorite).toBeNull();
  expect(result.afterReceive.inbox.items).toHaveLength(1);
  expect(result.afterReceive.progress.progress).toMatchObject({
    receivedCursor: result.remote.cursor,
    appliedCursor: null,
    lastInboxSeq: 1
  });
  expect(result.applied).toMatchObject({ status: "applied", written: true });
  expect(result.current).toEqual(favorite);
  expect(result.sidecar.sidecar).toMatchObject({
    serverRevision: result.remote.revision,
    lastSyncedSnapshot: favorite
  });
  expect(result.inbox.items).toEqual([]);
  expect(result.progress.progress.appliedCursor).toBe(result.remote.cursor);
  expect(result.outbox.items).toEqual([]);
});

test("malformed change 使整次 receive 零写入且 receivedCursor 不推进", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    await state.bindWorkspace(owner);
    const worker = window.LingoFlowSyncFavoritePullWorker.create({
      pull: () => ({
        status: "ready",
        changes: [{
          cursor: "cursor:bad",
          entityType: "favorites",
          entityId: "favorite:bad",
          scope: "record",
          schemaVersion: "1",
          revision: "revision:bad",
          operation: "put",
          payload: { id: "favorite:wrong" }
        }],
        nextCursor: "cursor:bad"
      })
    });
    return {
      received: await worker.receiveOnce(owner),
      progress: await state.getPullProgress(owner),
      inbox: await state.listInbox(owner)
    };
  }, OWNER);
  expect(result.received).toMatchObject({ status: "failed", reason: "invalid-pull-result" });
  expect(result.progress).toEqual({ status: "missing", progress: null });
  expect(result.inbox.items).toEqual([]);
});

test("receive 按服务器数组顺序分配 inboxSeq，不按 opaque cursor 排序", async ({ page }) => {
  const favorites = [
    makeFavorite("favorite:order-z"),
    makeFavorite("favorite:order-a"),
    makeFavorite("favorite:order-m")
  ];
  const result = await page.evaluate(async ({ owner, favorites }) => {
    const state = window.LingoFlowSyncStateRepository;
    await state.bindWorkspace(owner);
    const cursors = ["cursor:z", "cursor:a", "cursor:m"];
    const changes = favorites.map((favorite, index) => window.__makeChange(favorite, {
      cursor: cursors[index],
      revision: `revision:${index + 1}`
    }));
    const worker = window.LingoFlowSyncFavoritePullWorker.create({
      pull: () => ({ status: "ready", changes, nextCursor: "cursor:opaque-end" })
    });
    const received = await worker.receiveOnce(owner);
    return { received, inbox: await state.listInbox(owner) };
  }, { owner: OWNER, favorites });
  expect(result.received.status).toBe("received");
  expect(result.inbox.items.map(item => [item.inboxSeq, item.cursor])).toEqual([
    [1, "cursor:z"],
    [2, "cursor:a"],
    [3, "cursor:m"]
  ]);
});

test("两个 receive worker 同一 receivedCursor 只有一个取得 durable lease", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    await state.bindWorkspace(owner);
    let releaseNetwork;
    const pending = new Promise(resolve => { releaseNetwork = resolve; });
    const first = window.LingoFlowSyncFavoritePullWorker.create({
      pull: async () => {
        await pending;
        return { status: "ready", changes: [], nextCursor: "cursor:0" };
      }
    });
    const second = window.LingoFlowSyncFavoritePullWorker.create({
      pull: () => ({ status: "ready", changes: [], nextCursor: "cursor:0" })
    });
    const firstRun = first.receiveOnce(owner, { leaseMs: 60000 });
    await new Promise(resolve => setTimeout(resolve, 20));
    const secondRun = await second.receiveOnce(owner, { leaseMs: 60000 });
    releaseNetwork();
    const firstResult = await firstRun;
    return { firstResult, secondRun, progress: await state.getPullProgress(owner) };
  }, OWNER);
  expect(result.firstResult.status).toBe("received");
  expect(result.secondRun).toMatchObject({ status: "busy", reason: "pull-lease-active" });
  expect(result.progress.progress.receivedCursor).toBe("cursor:0");
});

test("expired Pull lease 可 takeover，旧 token 的迟到 response 零写入", async ({ page }) => {
  const favorite = makeFavorite("favorite:late-token");
  const result = await page.evaluate(async ({ owner, favorite }) => {
    const state = window.LingoFlowSyncStateRepository;
    await state.bindWorkspace(owner);
    const oldLease = await state.acquirePullLease(owner, { leaseMs: 60000 });
    const control = await window.__getAllSyncStore("control");
    const storedLease = control.find(value => value.leaseToken === oldLease.lease.leaseToken);
    storedLease.leaseExpiresAt = "2026-01-01T00:00:00.000Z";
    await window.__putSyncStore("control", storedLease);
    const replacement = await state.acquirePullLease(owner, { leaseMs: 60000 });
    const change = window.__makeChange(favorite, {
      cursor: "cursor:late",
      revision: "revision:late"
    });
    const late = await state.receivePullResult({
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      leaseToken: oldLease.lease.leaseToken,
      startReceivedCursor: oldLease.lease.startReceivedCursor,
      pullResult: { status: "ready", changes: [change], nextCursor: "cursor:late" }
    });
    return {
      oldLease,
      replacement,
      late,
      inbox: await state.listInbox(owner),
      progress: await state.getPullProgress(owner)
    };
  }, { owner: OWNER, favorite });
  expect(result.replacement.status).toBe("leased");
  expect(result.replacement.lease.leaseToken).not.toBe(result.oldLease.lease.leaseToken);
  expect(result.late).toMatchObject({ status: "blocked", reason: "stale-pull-lease" });
  expect(result.inbox.items).toEqual([]);
  expect(result.progress).toEqual({ status: "missing", progress: null });
});

test("重复 cursor + exact change 是 receive no-op，snapshot 不同则失败且不覆盖", async ({ page }) => {
  const favorite = makeFavorite("favorite:duplicate-receive");
  const result = await page.evaluate(async ({ owner, favorite }) => {
    const state = window.LingoFlowSyncStateRepository;
    await state.bindWorkspace(owner);
    const change = window.__makeChange(favorite, {
      cursor: "cursor:repeat",
      revision: "revision:repeat"
    });
    const run = async (incoming, nextCursor) => {
      const lease = await state.acquirePullLease(owner);
      return await state.receivePullResult({
        ownerId: owner.ownerId,
        bindingId: owner.bindingId,
        leaseToken: lease.lease.leaseToken,
        startReceivedCursor: lease.lease.startReceivedCursor,
        pullResult: { status: "ready", changes: [incoming], nextCursor }
      });
    };
    const first = await run(change, "cursor:first-end");
    const duplicate = await run(change, "cursor:second-end");
    const different = structuredClone(change);
    different.payload.meaning = "different snapshot";
    const conflict = await run(different, "cursor:third-end");
    return {
      first,
      duplicate,
      conflict,
      inbox: await state.listInbox(owner),
      progress: await state.getPullProgress(owner)
    };
  }, { owner: OWNER, favorite });
  expect(result.first).toMatchObject({ status: "received", received: 1 });
  expect(result.duplicate).toMatchObject({
    status: "received",
    received: 0,
    duplicates: ["cursor:repeat"]
  });
  expect(result.conflict).toMatchObject({ status: "failed", reason: "pull-change-cursor-conflict" });
  expect(result.inbox.items).toHaveLength(1);
  expect(result.inbox.items[0].change.payload).toEqual(favorite);
  expect(result.progress.progress.receivedCursor).toBe("cursor:second-end");
});

test("transport failure 与 formal rejected 均释放 lease 且不推进 receive", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    await state.bindWorkspace(owner);
    const transportWorker = window.LingoFlowSyncFavoritePullWorker.create({
      pull: () => { throw new Error("offline"); }
    });
    const transport = await transportWorker.receiveOnce(owner);
    const rejectedWorker = window.LingoFlowSyncFavoritePullWorker.create({
      pull: () => ({
        status: "rejected",
        changes: [],
        nextCursor: null,
        reason: "invalid-cursor"
      })
    });
    const rejected = await rejectedWorker.receiveOnce(owner);
    return {
      transport,
      rejected,
      progress: await state.getPullProgress(owner),
      inbox: await state.listInbox(owner)
    };
  }, OWNER);
  expect(result.transport).toMatchObject({
    status: "failed",
    reason: "pull-transport-failed",
    retryable: true,
    released: true
  });
  expect(result.rejected).toMatchObject({ status: "rejected", reason: "invalid-cursor" });
  expect(result.progress).toEqual({ status: "missing", progress: null });
  expect(result.inbox.items).toEqual([]);
});

test("Scenario B：clean local A/R1 接收 remote B/R2 后精确更新", async ({ page }) => {
  const first = makeFavorite("favorite:remote-update", { meaning: "A" });
  const second = { ...first, meaning: "B", updatedAt: "2026-09-01T01:00:00.000Z" };
  const result = await page.evaluate(async ({ owner, first, second }) => {
    const state = window.LingoFlowSyncStateRepository;
    const favorites = window.LingoFlowFavoriteRepository;
    await state.bindWorkspace(owner);
    const fake = window.LingoFlowFakeSyncService.create();
    const baseline = await window.__syncRemoteCreate(fake, owner, first);
    const remote = window.__remoteMutation(fake, owner, second, {
      baseRevision: baseline.remote.revision
    });
    const worker = window.__makePullWorker(fake);
    const received = await worker.receiveOnce(owner);
    const applied = await worker.applyNext(owner);
    return {
      baseline,
      remote,
      received,
      applied,
      current: favorites.getById(first.id, { includeDeleted: true }),
      sidecar: await state.getSidecar(owner.ownerId, first.id)
    };
  }, { owner: OWNER, first, second });
  expect(result.remote.status).toBe("applied");
  expect(result.applied).toMatchObject({ status: "applied", written: true });
  expect(result.current).toEqual(second);
  expect(result.sidecar.sidecar.lastSyncedSnapshot).toEqual(second);
  expect(result.sidecar.sidecar.serverRevision).toBe(result.remote.revision);
});

test("Scenario C：remote tombstone 原样落地且不物理删除、不建 outbox", async ({ page }) => {
  const active = makeFavorite("favorite:remote-delete");
  const tombstone = {
    ...active,
    updatedAt: "2026-09-01T02:00:00.000Z",
    deletedAt: "2026-09-01T02:00:00.000Z"
  };
  const result = await page.evaluate(async ({ owner, active, tombstone }) => {
    const state = window.LingoFlowSyncStateRepository;
    const favorites = window.LingoFlowFavoriteRepository;
    await state.bindWorkspace(owner);
    const fake = window.LingoFlowFakeSyncService.create();
    const baseline = await window.__syncRemoteCreate(fake, owner, active);
    const remote = window.__remoteMutation(fake, owner, tombstone, {
      baseRevision: baseline.remote.revision
    });
    const worker = window.__makePullWorker(fake);
    await worker.receiveOnce(owner);
    const applied = await worker.applyNext(owner);
    return {
      remote,
      applied,
      visible: favorites.list().find(item => item.id === active.id) || null,
      stored: favorites.getById(active.id, { includeDeleted: true }),
      sidecar: await state.getSidecar(owner.ownerId, active.id),
      outbox: await state.listOutbox({ ownerId: owner.ownerId })
    };
  }, { owner: OWNER, active, tombstone });
  expect(result.applied.status).toBe("applied");
  expect(result.visible).toBeNull();
  expect(result.stored).toEqual(tombstone);
  expect(result.sidecar.sidecar.lastSyncedSnapshot).toEqual(tombstone);
  expect(result.outbox.items).toEqual([]);
});

test("Scenario D：remote restore 把 clean tombstone 原样恢复为 active 且不建 local mutation", async ({ page }) => {
  const active = makeFavorite("favorite:remote-restore");
  const tombstone = {
    ...active,
    updatedAt: "2026-09-01T01:00:00.000Z",
    deletedAt: "2026-09-01T01:00:00.000Z"
  };
  const restored = {
    ...active,
    meaning: "restored remotely",
    updatedAt: "2026-09-01T02:00:00.000Z"
  };
  const result = await page.evaluate(async ({ owner, active, tombstone, restored }) => {
    const state = window.LingoFlowSyncStateRepository;
    const favorites = window.LingoFlowFavoriteRepository;
    await state.bindWorkspace(owner);
    const fake = window.LingoFlowFakeSyncService.create();
    const created = window.__remoteMutation(fake, owner, active);
    const deleted = window.__remoteMutation(fake, owner, tombstone, {
      baseRevision: created.revision
    });
    const worker = window.__makePullWorker(fake);
    await worker.receiveOnce(owner);
    await worker.applyNext(owner);
    await worker.applyNext(owner);
    const remote = window.__remoteMutation(fake, owner, restored, {
      operation: "restore",
      baseRevision: deleted.revision
    });
    await worker.receiveOnce(owner);
    const applied = await worker.applyNext(owner);
    return {
      created,
      deleted,
      remote,
      applied,
      current: favorites.getById(active.id, { includeDeleted: true }),
      sidecar: await state.getSidecar(owner.ownerId, active.id),
      outbox: await state.listOutbox({ ownerId: owner.ownerId })
    };
  }, { owner: OWNER, active, tombstone, restored });
  expect(result.remote.status).toBe("applied");
  expect(result.applied.status).toBe("applied");
  expect(result.current).toEqual(restored);
  expect(result.sidecar.sidecar.lastSyncedSnapshot).toEqual(restored);
  expect(result.outbox.items).toEqual([]);
});

test("Scenario E：own echo 优先于 local dirty，保留本地 successor 与 sidecar", async ({ page }) => {
  const baseline = makeFavorite("favorite:own-echo", { meaning: "A" });
  const result = await page.evaluate(async ({ owner, baseline }) => {
    const state = window.LingoFlowSyncStateRepository;
    const capture = window.LingoFlowSyncFavoriteService;
    const favorites = window.LingoFlowFavoriteRepository;
    await capture.bindWorkspace(owner);
    const fake = window.LingoFlowFakeSyncService.create();
    const remote = window.__remoteMutation(fake, owner, baseline);
    window.__putLocalFavorite(baseline);
    await window.__putSidecar(owner, baseline, remote.revision);
    const local = await capture.update(owner, baseline.id, {
      meaning: "local successor B"
    });
    const beforeOutbox = await state.listOutbox({ ownerId: owner.ownerId });
    const beforeSidecar = await state.getSidecar(owner.ownerId, baseline.id);
    const worker = window.__makePullWorker(fake);
    await worker.receiveOnce(owner);
    const applied = await worker.applyNext(owner);
    return {
      remote,
      local,
      applied,
      current: favorites.getById(baseline.id, { includeDeleted: true }),
      beforeOutbox,
      afterOutbox: await state.listOutbox({ ownerId: owner.ownerId }),
      beforeSidecar,
      afterSidecar: await state.getSidecar(owner.ownerId, baseline.id),
      progress: await state.getPullProgress(owner)
    };
  }, { owner: OWNER, baseline });
  expect(result.applied).toMatchObject({ status: "unchanged", reason: "own-echo" });
  expect(result.current).toEqual(result.local.favorite);
  expect(result.afterOutbox).toEqual(result.beforeOutbox);
  expect(result.afterSidecar).toEqual(result.beforeSidecar);
  expect(result.progress.progress.appliedCursor).toBe(result.remote.cursor);
});

test("own echo 优先于 physical local missing，并安全消费已确认 remote fact", async ({ page }) => {
  const baseline = makeFavorite("favorite:own-echo-missing-local", { meaning: "A" });
  const result = await page.evaluate(async ({ owner, baseline }) => {
    const state = window.LingoFlowSyncStateRepository;
    const favorites = window.LingoFlowFavoriteRepository;
    await state.bindWorkspace(owner);
    await window.__putSidecar(owner, baseline, "revision:echo-missing-local");
    const change = window.__makeChange(baseline, {
      cursor: "cursor:echo-missing-local",
      revision: "revision:echo-missing-local"
    });
    const worker = window.LingoFlowSyncFavoritePullWorker.create({
      pull: () => ({ status: "ready", changes: [change], nextCursor: change.cursor })
    });
    await worker.receiveOnce(owner);
    const applied = await worker.applyNext(owner);
    return {
      applied,
      current: favorites.getById(baseline.id, { includeDeleted: true }),
      sidecar: await state.getSidecar(owner.ownerId, baseline.id),
      inbox: await state.listInbox(owner),
      progress: await state.getPullProgress(owner)
    };
  }, { owner: OWNER, baseline });

  expect(result.applied).toMatchObject({ status: "unchanged", reason: "own-echo" });
  expect(result.current).toBeNull();
  expect(result.sidecar.sidecar.lastSyncedSnapshot).toEqual(baseline);
  expect(result.inbox.items).toEqual([]);
  expect(result.progress.progress.appliedCursor).toBe("cursor:echo-missing-local");
});

test("same revision different payload 转为 durable pull issue，不覆盖本地/sidecar", async ({ page }) => {
  const baseline = makeFavorite("favorite:same-revision", { meaning: "A" });
  const incoming = { ...baseline, meaning: "inconsistent" };
  const result = await page.evaluate(async ({ owner, baseline, incoming }) => {
    const state = window.LingoFlowSyncStateRepository;
    const favorites = window.LingoFlowFavoriteRepository;
    await state.bindWorkspace(owner);
    window.__putLocalFavorite(baseline);
    await window.__putSidecar(owner, baseline, "revision:same");
    const change = window.__makeChange(incoming, {
      cursor: "cursor:same-different",
      revision: "revision:same"
    });
    const worker = window.LingoFlowSyncFavoritePullWorker.create({
      pull: () => ({ status: "ready", changes: [change], nextCursor: change.cursor })
    });
    await worker.receiveOnce(owner);
    const applied = await worker.applyNext(owner);
    return {
      applied,
      current: favorites.getById(baseline.id, { includeDeleted: true }),
      sidecar: await state.getSidecar(owner.ownerId, baseline.id),
      issues: await state.listIssues({ ownerId: owner.ownerId, bindingId: owner.bindingId }),
      inbox: await state.listInbox(owner),
      progress: await state.getPullProgress(owner)
    };
  }, { owner: OWNER, baseline, incoming });
  expect(result.applied).toMatchObject({
    status: "conflict",
    reason: "same-revision-different-payload"
  });
  expect(result.current).toEqual(baseline);
  expect(result.sidecar.sidecar.lastSyncedSnapshot).toEqual(baseline);
  expect(result.issues.issues).toHaveLength(1);
  expect(result.issues.issues[0]).toMatchObject({
    direction: "pull",
    kind: "conflict",
    remoteRevision: "revision:same",
    remoteCursor: "cursor:same-different"
  });
  expect(result.issues.issues[0].mutationId).toMatch(/^pull:/);
  expect(result.issues.issues[0].issueId).toBe(result.issues.issues[0].mutationId);
  expect(result.inbox.items).toEqual([]);
  expect(result.progress.progress.appliedCursor).toBe("cursor:same-different");
});

test("Scenario F：local dirty + pending outbox 遇到 remote change 转为 pull conflict", async ({ page }) => {
  const baseline = makeFavorite("favorite:local-dirty", { meaning: "A" });
  const remoteNext = { ...baseline, meaning: "remote C", updatedAt: "2026-09-01T02:00:00.000Z" };
  const result = await page.evaluate(async ({ owner, baseline, remoteNext }) => {
    const state = window.LingoFlowSyncStateRepository;
    const capture = window.LingoFlowSyncFavoriteService;
    const favorites = window.LingoFlowFavoriteRepository;
    await capture.bindWorkspace(owner);
    const fake = window.LingoFlowFakeSyncService.create();
    const synced = await window.__syncRemoteCreate(fake, owner, baseline);
    const local = await capture.update(owner, baseline.id, { meaning: "local B" });
    const outboxBefore = await state.listOutbox({ ownerId: owner.ownerId });
    const sidecarBefore = await state.getSidecar(owner.ownerId, baseline.id);
    const remote = window.__remoteMutation(fake, owner, remoteNext, {
      baseRevision: synced.remote.revision
    });
    const worker = window.__makePullWorker(fake);
    await worker.receiveOnce(owner);
    const applied = await worker.applyNext(owner);
    return {
      remote,
      local,
      applied,
      current: favorites.getById(baseline.id, { includeDeleted: true }),
      outboxBefore,
      outboxAfter: await state.listOutbox({ ownerId: owner.ownerId }),
      sidecarBefore,
      sidecarAfter: await state.getSidecar(owner.ownerId, baseline.id),
      issues: await state.listIssues({ ownerId: owner.ownerId, bindingId: owner.bindingId }),
      progress: await state.getPullProgress(owner)
    };
  }, { owner: OWNER, baseline, remoteNext });
  expect(result.applied).toMatchObject({ status: "conflict", reason: "local-mutation-pending" });
  expect(result.current).toEqual(result.local.favorite);
  expect(result.outboxAfter).toEqual(result.outboxBefore);
  expect(result.sidecarAfter).toEqual(result.sidecarBefore);
  expect(result.issues.issues).toHaveLength(1);
  expect(result.issues.issues[0].remoteChange.payload).toEqual(remoteNext);
  expect(result.issues.issues[0].pendingMutationIds).toEqual([
    result.outboxBefore.items[0].mutationId
  ]);
  expect(result.progress.progress.appliedCursor).toBe(result.remote.cursor);
});

test("已有 push issue 时，非 echo remote fact 追加 pull issue 而不覆盖 Favorite", async ({ page }) => {
  const baseline = makeFavorite("favorite:push-issue", { meaning: "A" });
  const remoteNext = { ...baseline, meaning: "remote C", updatedAt: "2026-09-01T02:00:00.000Z" };
  const result = await page.evaluate(async ({ owner, baseline, remoteNext }) => {
    const state = window.LingoFlowSyncStateRepository;
    const capture = window.LingoFlowSyncFavoriteService;
    const favorites = window.LingoFlowFavoriteRepository;
    await capture.bindWorkspace(owner);
    const fake = window.LingoFlowFakeSyncService.create();
    const synced = await window.__syncRemoteCreate(fake, owner, baseline);
    const local = await capture.update(owner, baseline.id, { meaning: "local B" });
    const remote = window.__remoteMutation(fake, owner, remoteNext, {
      baseRevision: synced.remote.revision
    });
    const pushWorker = window.LingoFlowSyncFavoritePushWorker.create({
      push: (wireOwner, request) => fake.push(wireOwner, request)
    });
    const pushed = await pushWorker.runOnce(owner);
    const beforeIssues = await state.listIssues({ ownerId: owner.ownerId, bindingId: owner.bindingId });
    const pullWorker = window.__makePullWorker(fake);
    await pullWorker.receiveOnce(owner);
    const applied = await pullWorker.applyNext(owner);
    return {
      remote,
      local,
      pushed,
      applied,
      beforeIssues,
      afterIssues: await state.listIssues({ ownerId: owner.ownerId, bindingId: owner.bindingId }),
      current: favorites.getById(baseline.id, { includeDeleted: true })
    };
  }, { owner: OWNER, baseline, remoteNext });
  expect(result.pushed.status).toBe("conflict");
  expect(result.beforeIssues.issues).toHaveLength(1);
  expect(result.applied).toMatchObject({ status: "conflict", reason: "sync-issue-exists" });
  expect(result.afterIssues.issues).toHaveLength(2);
  expect(result.afterIssues.issues.map(issue => issue.direction || "push").sort()).toEqual([
    "pull",
    "push"
  ]);
  expect(result.current).toEqual(result.local.favorite);
});

test("Crash B：applying durable、Favorite 未写时用冻结 candidate 恢复", async ({ page }) => {
  const favorite = makeFavorite("favorite:crash-b");
  const result = await page.evaluate(async ({ owner, favorite }) => {
    const state = window.LingoFlowSyncStateRepository;
    const repository = window.LingoFlowFavoriteRepository;
    await state.bindWorkspace(owner);
    const fake = window.LingoFlowFakeSyncService.create();
    window.__remoteMutation(fake, owner, favorite);
    const normal = window.__makePullWorker(fake);
    await normal.receiveOnce(owner);
    const failingRepository = {
      getById: (...args) => repository.getById(...args),
      commitExactSnapshot: () => { throw new Error("crash-before-local-write"); }
    };
    const crashing = window.LingoFlowSyncFavoritePullWorker.create({
      pull: (wireOwner, cursor) => fake.pull(wireOwner, cursor),
      favoriteRepository: failingRepository
    });
    const first = await crashing.applyNext(owner);
    const durableBefore = await state.listInbox(owner);
    state.closeDatabase();
    await state.openDatabase();
    const recovered = await normal.applyNext(owner);
    return {
      first,
      durableBefore,
      recovered,
      current: repository.getById(favorite.id, { includeDeleted: true }),
      inbox: await state.listInbox(owner),
      sidecar: await state.getSidecar(owner.ownerId, favorite.id)
    };
  }, { owner: OWNER, favorite });
  expect(result.first).toMatchObject({
    status: "failed",
    reason: "favorite-remote-commit-failed",
    applying: true
  });
  expect(result.durableBefore.items[0].status).toBe("applying");
  expect(result.durableBefore.items[0].applyIntent.candidateSnapshot).toEqual(favorite);
  expect(result.recovered).toMatchObject({ status: "applied", recovered: true, written: true });
  expect(result.current).toEqual(favorite);
  expect(result.inbox.items).toEqual([]);
  expect(result.sidecar.sidecar.lastSyncedSnapshot).toEqual(favorite);
});

test("Scenario G / Crash C：Favorite 已写、finalize 未完成时不重复写并完成收口", async ({ page }) => {
  const favorite = makeFavorite("favorite:crash-c");
  const result = await page.evaluate(async ({ owner, favorite }) => {
    const state = window.LingoFlowSyncStateRepository;
    const repository = window.LingoFlowFavoriteRepository;
    await state.bindWorkspace(owner);
    const fake = window.LingoFlowFakeSyncService.create();
    window.__remoteMutation(fake, owner, favorite);
    const normal = window.__makePullWorker(fake);
    await normal.receiveOnce(owner);
    const stateWithFinalizeCrash = {
      ...state,
      finalizeInboxApply: async () => ({ status: "failed", reason: "injected-finalize-crash" })
    };
    const crashing = window.LingoFlowSyncFavoritePullWorker.create({
      pull: (wireOwner, cursor) => fake.pull(wireOwner, cursor),
      syncStateRepository: stateWithFinalizeCrash
    });
    const first = await crashing.applyNext(owner);
    const rawAfterFirst = localStorage.getItem("LingoFlowFavoriteEntities");
    const durableBefore = await state.listInbox(owner);
    const originalCommit = repository.commitExactSnapshot;
    let commitCalls = 0;
    const countingRepository = {
      getById: (...args) => repository.getById(...args),
      commitExactSnapshot: value => {
        commitCalls += 1;
        return originalCommit(value);
      }
    };
    const recovering = window.LingoFlowSyncFavoritePullWorker.create({
      pull: (wireOwner, cursor) => fake.pull(wireOwner, cursor),
      favoriteRepository: countingRepository
    });
    const recovered = await recovering.applyNext(owner);
    return {
      first,
      rawAfterFirst,
      durableBefore,
      recovered,
      commitCalls,
      rawAfterRecovery: localStorage.getItem("LingoFlowFavoriteEntities"),
      inbox: await state.listInbox(owner),
      sidecar: await state.getSidecar(owner.ownerId, favorite.id)
    };
  }, { owner: OWNER, favorite });
  expect(result.first).toMatchObject({
    status: "failed",
    reason: "injected-finalize-crash",
    localCommitted: true
  });
  expect(result.durableBefore.items[0].status).toBe("applying");
  expect(result.recovered).toMatchObject({ status: "applied", recovered: true, written: false });
  expect(result.commitCalls).toBe(0);
  expect(result.rawAfterRecovery).toBe(result.rawAfterFirst);
  expect(result.inbox.items).toEqual([]);
  expect(result.sidecar.sidecar.lastSyncedSnapshot).toEqual(favorite);
});

test("Applying recovery local diverged 转 durable conflict，保留用户值", async ({ page }) => {
  const candidate = makeFavorite("favorite:recovery-diverged", { meaning: "remote" });
  const diverged = { ...candidate, meaning: "user edit", updatedAt: "2026-09-01T03:00:00.000Z" };
  const result = await page.evaluate(async ({ owner, candidate, diverged }) => {
    const state = window.LingoFlowSyncStateRepository;
    const repository = window.LingoFlowFavoriteRepository;
    await state.bindWorkspace(owner);
    const fake = window.LingoFlowFakeSyncService.create();
    window.__remoteMutation(fake, owner, candidate);
    const normal = window.__makePullWorker(fake);
    await normal.receiveOnce(owner);
    const crashing = window.LingoFlowSyncFavoritePullWorker.create({
      pull: (wireOwner, cursor) => fake.pull(wireOwner, cursor),
      favoriteRepository: {
        getById: (...args) => repository.getById(...args),
        commitExactSnapshot: () => { throw new Error("stop-after-prepare"); }
      }
    });
    await crashing.applyNext(owner);
    window.__putLocalFavorite(diverged);
    const recovered = await normal.applyNext(owner);
    return {
      recovered,
      current: repository.getById(candidate.id, { includeDeleted: true }),
      sidecar: await state.getSidecar(owner.ownerId, candidate.id),
      inbox: await state.listInbox(owner),
      issues: await state.listIssues({ ownerId: owner.ownerId, bindingId: owner.bindingId })
    };
  }, { owner: OWNER, candidate, diverged });
  expect(result.recovered).toMatchObject({
    status: "conflict",
    reason: "apply-recovery-local-diverged"
  });
  expect(result.current).toEqual(diverged);
  expect(result.sidecar.status).toBe("missing");
  expect(result.inbox.items).toEqual([]);
  expect(result.issues.issues).toHaveLength(1);
  expect(result.issues.issues[0].localSnapshot).toEqual(diverged);
});

test("Historical Anchor：不解析 opaque revision，按 exact R6 anchor 消费历史并应用 R7", async ({ page }) => {
  const seed = makeFavorite("favorite:history-anchor", { meaning: "version 1" });
  const result = await page.evaluate(async ({ owner, seed }) => {
    const state = window.LingoFlowSyncStateRepository;
    const favorites = window.LingoFlowFavoriteRepository;
    await state.bindWorkspace(owner);
    const fake = window.LingoFlowFakeSyncService.create();
    const versions = [];
    const remoteResults = [];
    let baseRevision = null;
    for (let number = 1; number <= 7; number += 1) {
      const snapshot = {
        ...seed,
        meaning: `version ${number}`,
        updatedAt: `2026-09-01T0${number}:00:00.000Z`
      };
      versions.push(snapshot);
      const remote = window.__remoteMutation(fake, owner, snapshot, { baseRevision });
      remoteResults.push(remote);
      baseRevision = remote.revision;
    }
    window.__putLocalFavorite(versions[5]);
    await window.__putSidecar(owner, versions[5], remoteResults[5].revision);
    const worker = window.__makePullWorker(fake);
    const received = await worker.receiveOnce(owner);
    const outcomes = [];
    for (let index = 0; index < 7; index += 1) outcomes.push(await worker.applyNext(owner));
    return {
      received,
      outcomes,
      versions,
      remoteResults,
      current: favorites.getById(seed.id, { includeDeleted: true }),
      sidecar: await state.getSidecar(owner.ownerId, seed.id),
      progress: await state.getPullProgress(owner),
      inbox: await state.listInbox(owner)
    };
  }, { owner: OWNER, seed });
  expect(result.received.received).toBe(7);
  expect(result.outcomes.slice(0, 5).map(value => value.reason)).toEqual([
    "historical", "historical", "historical", "historical", "historical"
  ]);
  expect(result.outcomes[5]).toMatchObject({ status: "unchanged", reason: "own-echo" });
  expect(result.outcomes[6]).toMatchObject({ status: "applied", written: true });
  expect(result.current).toEqual(result.versions[6]);
  expect(result.sidecar.sidecar.serverRevision).toBe(result.remoteResults[6].revision);
  expect(result.progress.progress.appliedCursor).toBe(result.remoteResults[6].cursor);
  expect(result.inbox.items).toEqual([]);
});

test("Historical Anchor + local drift：R1…R6 全部 no-op，保留 successor", async ({ page }) => {
  const seed = makeFavorite("favorite:history-drift", { meaning: "version 1" });
  const result = await page.evaluate(async ({ owner, seed }) => {
    const state = window.LingoFlowSyncStateRepository;
    const capture = window.LingoFlowSyncFavoriteService;
    const favorites = window.LingoFlowFavoriteRepository;
    await capture.bindWorkspace(owner);
    const fake = window.LingoFlowFakeSyncService.create();
    const versions = [];
    const remotes = [];
    let baseRevision = null;
    for (let number = 1; number <= 6; number += 1) {
      const snapshot = {
        ...seed,
        meaning: `version ${number}`,
        updatedAt: `2026-09-01T0${number}:00:00.000Z`
      };
      versions.push(snapshot);
      const remote = window.__remoteMutation(fake, owner, snapshot, { baseRevision });
      remotes.push(remote);
      baseRevision = remote.revision;
    }
    window.__putLocalFavorite(versions[5]);
    await window.__putSidecar(owner, versions[5], remotes[5].revision);
    const local = await capture.update(owner, seed.id, { meaning: "local B" });
    const outboxBefore = await state.listOutbox({ ownerId: owner.ownerId });
    const worker = window.__makePullWorker(fake);
    await worker.receiveOnce(owner);
    const outcomes = [];
    for (let index = 0; index < 6; index += 1) outcomes.push(await worker.applyNext(owner));
    return {
      local,
      outcomes,
      current: favorites.getById(seed.id, { includeDeleted: true }),
      outboxBefore,
      outboxAfter: await state.listOutbox({ ownerId: owner.ownerId }),
      issues: await state.listIssues({ ownerId: owner.ownerId, bindingId: owner.bindingId })
    };
  }, { owner: OWNER, seed });
  expect(result.outcomes.map(value => value.status)).toEqual([
    "unchanged", "unchanged", "unchanged", "unchanged", "unchanged", "unchanged"
  ]);
  expect(result.outcomes[5].reason).toBe("own-echo");
  expect(result.current).toEqual(result.local.favorite);
  expect(result.outboxAfter).toEqual(result.outboxBefore);
  expect(result.issues.issues).toEqual([]);
});

test("无法找到 sidecar historical anchor 时保守阻断，不猜 revision 新旧", async ({ page }) => {
  const baseline = makeFavorite("favorite:anchor-missing", { meaning: "known A" });
  const incoming = { ...baseline, meaning: "unknown order", updatedAt: "2026-09-01T02:00:00.000Z" };
  const result = await page.evaluate(async ({ owner, baseline, incoming }) => {
    const state = window.LingoFlowSyncStateRepository;
    await state.bindWorkspace(owner);
    window.__putLocalFavorite(baseline);
    await window.__putSidecar(owner, baseline, "revision:known-but-absent");
    const change = window.__makeChange(incoming, {
      cursor: "cursor:unanchored",
      revision: "revision:opaque"
    });
    const worker = window.LingoFlowSyncFavoritePullWorker.create({
      pull: () => ({ status: "ready", changes: [change], nextCursor: change.cursor })
    });
    await worker.receiveOnce(owner);
    const applied = await worker.applyNext(owner);
    return {
      applied,
      inbox: await state.listInbox(owner),
      progress: await state.getPullProgress(owner),
      issues: await state.listIssues({ ownerId: owner.ownerId, bindingId: owner.bindingId })
    };
  }, { owner: OWNER, baseline, incoming });
  expect(result.applied).toMatchObject({ status: "blocked", reason: "awaiting-historical-anchor" });
  expect(result.inbox.items).toHaveLength(1);
  expect(result.progress.progress.appliedCursor).toBeNull();
  expect(result.issues.issues).toEqual([]);
});

test("Favorite X 的 pull issue 不阻塞后续 Favorite Y apply", async ({ page }) => {
  const localX = makeFavorite("favorite:issue-x", { meaning: "local X" });
  const remoteX = { ...localX, meaning: "remote X", updatedAt: "2026-09-01T02:00:00.000Z" };
  const remoteY = makeFavorite("favorite:clean-y", { meaning: "remote Y" });
  const result = await page.evaluate(async ({ owner, localX, remoteX, remoteY }) => {
    const state = window.LingoFlowSyncStateRepository;
    const favorites = window.LingoFlowFavoriteRepository;
    await state.bindWorkspace(owner);
    window.__putLocalFavorite(localX);
    const changes = [
      window.__makeChange(remoteX, { cursor: "cursor:x", revision: "revision:x" }),
      window.__makeChange(remoteY, { cursor: "cursor:y", revision: "revision:y" })
    ];
    const worker = window.LingoFlowSyncFavoritePullWorker.create({
      pull: () => ({ status: "ready", changes, nextCursor: "cursor:y" })
    });
    await worker.receiveOnce(owner);
    const first = await worker.applyNext(owner);
    const progressAfterFirst = await state.getPullProgress(owner);
    const second = await worker.applyNext(owner);
    return {
      first,
      second,
      progressAfterFirst,
      progressAfterSecond: await state.getPullProgress(owner),
      x: favorites.getById(localX.id, { includeDeleted: true }),
      y: favorites.getById(remoteY.id, { includeDeleted: true }),
      issues: await state.listIssues({ ownerId: owner.ownerId, bindingId: owner.bindingId })
    };
  }, { owner: OWNER, localX, remoteX, remoteY });
  expect(result.first).toMatchObject({ status: "conflict", reason: "unsynced-local" });
  expect(result.progressAfterFirst.progress.appliedCursor).toBe("cursor:x");
  expect(result.second.status).toBe("applied");
  expect(result.progressAfterSecond.progress.appliedCursor).toBe("cursor:y");
  expect(result.x).toEqual(localX);
  expect(result.y).toEqual(remoteY);
  expect(result.issues.issues).toHaveLength(1);
});

test("sidecar 存在但 physical local missing 被判 corrupted-local-state", async ({ page }) => {
  const baseline = makeFavorite("favorite:missing-local", { meaning: "A" });
  const incoming = { ...baseline, meaning: "B", updatedAt: "2026-09-01T01:00:00.000Z" };
  const result = await page.evaluate(async ({ owner, baseline, incoming }) => {
    const state = window.LingoFlowSyncStateRepository;
    await state.bindWorkspace(owner);
    await window.__putSidecar(owner, baseline, "revision:1");
    const change = window.__makeChange(incoming, {
      cursor: "cursor:missing-local",
      revision: "revision:2"
    });
    const worker = window.LingoFlowSyncFavoritePullWorker.create({
      pull: () => ({ status: "ready", changes: [change], nextCursor: change.cursor })
    });
    await worker.receiveOnce(owner);
    const applied = await worker.applyNext(owner);
    return {
      applied,
      inbox: await state.listInbox(owner),
      progress: await state.getPullProgress(owner)
    };
  }, { owner: OWNER, baseline, incoming });
  expect(result.applied).toMatchObject({ status: "blocked", reason: "corrupted-local-state" });
  expect(result.inbox.items).toHaveLength(1);
  expect(result.progress.progress.appliedCursor).toBeNull();
});

test("Scenario H1：Pull 网络期间 binding 改变，旧 response 不入 Inbox", async ({ page }) => {
  const favorite = makeFavorite("favorite:binding-receive");
  const result = await page.evaluate(async ({ owner, favorite }) => {
    const state = window.LingoFlowSyncStateRepository;
    await state.bindWorkspace(owner);
    const change = window.__makeChange(favorite, {
      cursor: "cursor:binding-receive",
      revision: "revision:binding-receive"
    });
    const worker = window.LingoFlowSyncFavoritePullWorker.create({
      pull: async () => {
        await window.__putSyncStore("control", {
          key: "workspace-binding",
          ownerId: owner.ownerId,
          bindingId: "binding:changed-during-network"
        });
        return { status: "ready", changes: [change], nextCursor: change.cursor };
      }
    });
    const received = await worker.receiveOnce(owner);
    return {
      received,
      stores: {
        inbox: await window.__getAllSyncStore("inbox"),
        control: await window.__getAllSyncStore("control")
      }
    };
  }, { owner: OWNER, favorite });
  expect(result.received).toMatchObject({ status: "blocked", reason: "workspace-binding-mismatch" });
  expect(result.stores.inbox).toEqual([]);
  expect(result.stores.control.some(value => Object.hasOwn(value, "receivedCursor"))).toBe(false);
});

test("Scenario H2：applying 后 commit 前 binding 改变，Favorite 不写且 intent 保留", async ({ page }) => {
  const favorite = makeFavorite("favorite:binding-before-commit");
  const result = await page.evaluate(async ({ owner, favorite }) => {
    const state = window.LingoFlowSyncStateRepository;
    const repository = window.LingoFlowFavoriteRepository;
    await state.bindWorkspace(owner);
    const change = window.__makeChange(favorite, {
      cursor: "cursor:binding-before-commit",
      revision: "revision:binding-before-commit"
    });
    const receiveWorker = window.LingoFlowSyncFavoritePullWorker.create({
      pull: () => ({ status: "ready", changes: [change], nextCursor: change.cursor })
    });
    await receiveWorker.receiveOnce(owner);
    const stateChangingAfterPrepare = {
      ...state,
      prepareInboxApply: async context => {
        const prepared = await state.prepareInboxApply(context);
        if (prepared.status === "applying") {
          await window.__putSyncStore("control", {
            key: "workspace-binding",
            ownerId: owner.ownerId,
            bindingId: "binding:changed-before-commit"
          });
        }
        return prepared;
      }
    };
    let commits = 0;
    const worker = window.LingoFlowSyncFavoritePullWorker.create({
      pull: () => ({ status: "ready", changes: [], nextCursor: change.cursor }),
      syncStateRepository: stateChangingAfterPrepare,
      favoriteRepository: {
        getById: (...args) => repository.getById(...args),
        commitExactSnapshot: value => {
          commits += 1;
          return repository.commitExactSnapshot(value);
        }
      }
    });
    const applied = await worker.applyNext(owner);
    return {
      applied,
      commits,
      current: repository.getById(favorite.id, { includeDeleted: true }),
      rawInbox: await window.__getAllSyncStore("inbox")
    };
  }, { owner: OWNER, favorite });
  expect(result.applied).toMatchObject({
    status: "blocked",
    reason: "workspace-binding-mismatch",
    applying: true
  });
  expect(result.commits).toBe(0);
  expect(result.current).toBeNull();
  expect(result.rawInbox).toHaveLength(1);
  expect(result.rawInbox[0].status).toBe("applying");
});

test("Scenario H3：commit 后 finalize 前 binding 改变，已写 Favorite 与 intent 均保留", async ({ page }) => {
  const favorite = makeFavorite("favorite:binding-before-finalize");
  const result = await page.evaluate(async ({ owner, favorite }) => {
    const state = window.LingoFlowSyncStateRepository;
    const repository = window.LingoFlowFavoriteRepository;
    await state.bindWorkspace(owner);
    const change = window.__makeChange(favorite, {
      cursor: "cursor:binding-before-finalize",
      revision: "revision:binding-before-finalize"
    });
    const receiveWorker = window.LingoFlowSyncFavoritePullWorker.create({
      pull: () => ({ status: "ready", changes: [change], nextCursor: change.cursor })
    });
    await receiveWorker.receiveOnce(owner);
    const changingState = {
      ...state,
      finalizeInboxApply: async context => {
        await window.__putSyncStore("control", {
          key: "workspace-binding",
          ownerId: owner.ownerId,
          bindingId: "binding:changed-before-finalize"
        });
        return await state.finalizeInboxApply(context);
      }
    };
    const worker = window.LingoFlowSyncFavoritePullWorker.create({
      pull: () => ({ status: "ready", changes: [], nextCursor: change.cursor }),
      syncStateRepository: changingState
    });
    const applied = await worker.applyNext(owner);
    return {
      applied,
      current: repository.getById(favorite.id, { includeDeleted: true }),
      rawInbox: await window.__getAllSyncStore("inbox"),
      sidecars: await window.__getAllSyncStore("entitySidecars")
    };
  }, { owner: OWNER, favorite });
  expect(result.applied).toMatchObject({
    status: "blocked",
    reason: "workspace-binding-mismatch",
    localCommitted: true
  });
  expect(result.current).toEqual(favorite);
  expect(result.rawInbox).toHaveLength(1);
  expect(result.rawInbox[0].status).toBe("applying");
  expect(result.sidecars).toEqual([]);
});

test("malformed Pull Progress 严格失败，不退化为 initial state", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    await state.bindWorkspace(owner);
    const worker = window.LingoFlowSyncFavoritePullWorker.create({
      pull: () => ({ status: "ready", changes: [], nextCursor: "cursor:0" })
    });
    await worker.receiveOnce(owner);
    const control = await window.__getAllSyncStore("control");
    const progress = control.find(value => Object.hasOwn(value, "receivedCursor"));
    progress.unexpected = true;
    await window.__putSyncStore("control", progress);
    return {
      progress: await state.getPullProgress(owner),
      lease: await state.acquirePullLease(owner)
    };
  }, OWNER);
  expect(result.progress).toMatchObject({ status: "failed", reason: "pull-progress-read-failed" });
  expect(result.lease).toMatchObject({ status: "failed", reason: "pull-lease-acquire-failed" });
});

test("malformed Inbox 严格失败且 appliedCursor 不推进", async ({ page }) => {
  const favorite = makeFavorite("favorite:malformed-inbox");
  const result = await page.evaluate(async ({ owner, favorite }) => {
    const state = window.LingoFlowSyncStateRepository;
    await state.bindWorkspace(owner);
    const change = window.__makeChange(favorite, {
      cursor: "cursor:malformed-inbox",
      revision: "revision:malformed-inbox"
    });
    const worker = window.LingoFlowSyncFavoritePullWorker.create({
      pull: () => ({ status: "ready", changes: [change], nextCursor: change.cursor })
    });
    await worker.receiveOnce(owner);
    const inbox = (await window.__getAllSyncStore("inbox"))[0];
    inbox.unexpected = true;
    await window.__putSyncStore("inbox", inbox);
    return {
      applied: await worker.applyNext(owner),
      progress: await state.getPullProgress(owner),
      rawInbox: await window.__getAllSyncStore("inbox")
    };
  }, { owner: OWNER, favorite });
  expect(result.applied).toMatchObject({ status: "failed", reason: "inbox-list-failed" });
  expect(result.progress.progress.appliedCursor).toBeNull();
  expect(result.rawInbox).toHaveLength(1);
});

test("malformed applying intent 严格失败，不重新生成 candidate", async ({ page }) => {
  const favorite = makeFavorite("favorite:malformed-intent");
  const result = await page.evaluate(async ({ owner, favorite }) => {
    const state = window.LingoFlowSyncStateRepository;
    const repository = window.LingoFlowFavoriteRepository;
    await state.bindWorkspace(owner);
    const change = window.__makeChange(favorite, {
      cursor: "cursor:malformed-intent",
      revision: "revision:malformed-intent"
    });
    const normal = window.LingoFlowSyncFavoritePullWorker.create({
      pull: () => ({ status: "ready", changes: [change], nextCursor: change.cursor })
    });
    await normal.receiveOnce(owner);
    const crashing = window.LingoFlowSyncFavoritePullWorker.create({
      pull: () => ({ status: "ready", changes: [], nextCursor: change.cursor }),
      favoriteRepository: {
        getById: (...args) => repository.getById(...args),
        commitExactSnapshot: () => { throw new Error("stop-after-prepare"); }
      }
    });
    await crashing.applyNext(owner);
    const inbox = (await window.__getAllSyncStore("inbox"))[0];
    inbox.applyIntent.candidateFingerprint = "fingerprint:wrong";
    await window.__putSyncStore("inbox", inbox);
    return {
      applied: await normal.applyNext(owner),
      current: repository.getById(favorite.id, { includeDeleted: true }),
      rawInbox: await window.__getAllSyncStore("inbox")
    };
  }, { owner: OWNER, favorite });
  expect(result.applied).toMatchObject({ status: "failed", reason: "inbox-list-failed" });
  expect(result.current).toBeNull();
  expect(result.rawInbox).toHaveLength(1);
});

test("receive/result 与 listInbox 返回对象均与 durable snapshot 深隔离", async ({ page }) => {
  const favorite = makeFavorite("favorite:snapshot-isolation", {
    futureRemoteFact: { nested: ["original"] }
  });
  const result = await page.evaluate(async ({ owner, favorite }) => {
    const state = window.LingoFlowSyncStateRepository;
    await state.bindWorkspace(owner);
    const change = window.__makeChange(favorite, {
      cursor: "cursor:isolation",
      revision: "revision:isolation"
    });
    const pullResult = { status: "ready", changes: [change], nextCursor: change.cursor };
    const worker = window.LingoFlowSyncFavoritePullWorker.create({ pull: () => pullResult });
    const received = await worker.receiveOnce(owner);
    pullResult.changes[0].payload.futureRemoteFact.nested[0] = "mutated-source";
    received.items[0].change.payload.futureRemoteFact.nested[0] = "mutated-return";
    const firstRead = await state.listInbox(owner);
    firstRead.items[0].change.payload.futureRemoteFact.nested[0] = "mutated-read";
    const secondRead = await state.listInbox(owner);
    return { secondRead };
  }, { owner: OWNER, favorite });
  expect(result.secondRead.items[0].change.payload.futureRemoteFact.nested).toEqual(["original"]);
});

test("appliedCursor 严格逐 inboxSeq 推进，不跳过未处理 item", async ({ page }) => {
  const first = makeFavorite("favorite:cursor-first");
  const second = makeFavorite("favorite:cursor-second");
  const result = await page.evaluate(async ({ owner, first, second }) => {
    const state = window.LingoFlowSyncStateRepository;
    await state.bindWorkspace(owner);
    const changes = [
      window.__makeChange(first, { cursor: "cursor:first", revision: "revision:first" }),
      window.__makeChange(second, { cursor: "cursor:second", revision: "revision:second" })
    ];
    const worker = window.LingoFlowSyncFavoritePullWorker.create({
      pull: () => ({ status: "ready", changes, nextCursor: "cursor:second" })
    });
    await worker.receiveOnce(owner);
    const firstApplied = await worker.applyNext(owner);
    const afterFirst = await state.getPullProgress(owner);
    const remaining = await state.listInbox(owner);
    const secondApplied = await worker.applyNext(owner);
    return {
      firstApplied,
      afterFirst,
      remaining,
      secondApplied,
      afterSecond: await state.getPullProgress(owner)
    };
  }, { owner: OWNER, first, second });
  expect(result.firstApplied.status).toBe("applied");
  expect(result.afterFirst.progress).toMatchObject({
    receivedCursor: "cursor:second",
    appliedCursor: "cursor:first"
  });
  expect(result.remaining.items.map(item => item.cursor)).toEqual(["cursor:second"]);
  expect(result.secondApplied.status).toBe("applied");
  expect(result.afterSecond.progress.appliedCursor).toBe("cursor:second");
});

test("两个 Apply Worker 共享 Favorite global writer lock 并串行消费", async ({ page }) => {
  const first = makeFavorite("favorite:apply-tab-one");
  const second = makeFavorite("favorite:apply-tab-two");
  const result = await page.evaluate(async ({ owner, first, second }) => {
    const state = window.LingoFlowSyncStateRepository;
    const favorites = window.LingoFlowFavoriteRepository;
    await state.bindWorkspace(owner);
    const changes = [
      window.__makeChange(first, { cursor: "cursor:tab-one", revision: "revision:tab-one" }),
      window.__makeChange(second, { cursor: "cursor:tab-two", revision: "revision:tab-two" })
    ];
    const pull = () => ({ status: "ready", changes, nextCursor: "cursor:tab-two" });
    const workerA = window.LingoFlowSyncFavoritePullWorker.create({ pull });
    const workerB = window.LingoFlowSyncFavoritePullWorker.create({ pull });
    await workerA.receiveOnce(owner);
    const outcomes = await Promise.all([workerA.applyNext(owner), workerB.applyNext(owner)]);
    return {
      outcomes,
      current: [
        favorites.getById(first.id, { includeDeleted: true }),
        favorites.getById(second.id, { includeDeleted: true })
      ],
      inbox: await state.listInbox(owner)
    };
  }, { owner: OWNER, first, second });
  expect(result.outcomes.map(value => value.status).sort()).toEqual(["applied", "applied"]);
  expect(result.current).toEqual([first, second]);
  expect(result.inbox.items).toEqual([]);
});

test("Push result cursor 永不创建或推进 Pull Progress", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    const capture = window.LingoFlowSyncFavoriteService;
    await capture.bindWorkspace(owner);
    await capture.create(owner, { type: "word", text: "push does not move pull" });
    const fake = window.LingoFlowFakeSyncService.create();
    const worker = window.LingoFlowSyncFavoritePushWorker.create({
      push: (wireOwner, request) => fake.push(wireOwner, request)
    });
    const pushed = await worker.runOnce(owner);
    return {
      pushed,
      progress: await state.getPullProgress(owner),
      controls: await window.__getAllSyncStore("control")
    };
  }, OWNER);
  expect(result.pushed.status).toBe("applied");
  expect(result.progress).toEqual({ status: "missing", progress: null });
  expect(result.controls.some(value => Object.hasOwn(value, "receivedCursor"))).toBe(false);
});

test("local edit 与 remote apply 共享 writer lock，不发生 lost update", async ({ page }) => {
  const baseline = makeFavorite("favorite:concurrent-edit", { meaning: "A" });
  const remoteNext = { ...baseline, meaning: "remote C", updatedAt: "2026-09-01T02:00:00.000Z" };
  const result = await page.evaluate(async ({ owner, baseline, remoteNext }) => {
    const state = window.LingoFlowSyncStateRepository;
    const capture = window.LingoFlowSyncFavoriteService;
    const favorites = window.LingoFlowFavoriteRepository;
    await capture.bindWorkspace(owner);
    const fake = window.LingoFlowFakeSyncService.create();
    const synced = await window.__syncRemoteCreate(fake, owner, baseline);
    window.__remoteMutation(fake, owner, remoteNext, { baseRevision: synced.remote.revision });
    const pullWorker = window.__makePullWorker(fake);
    await pullWorker.receiveOnce(owner);
    const [local, remote] = await Promise.all([
      capture.update(owner, baseline.id, { meaning: "concurrent local B" }),
      pullWorker.applyNext(owner)
    ]);
    return {
      local,
      remote,
      current: favorites.getById(baseline.id, { includeDeleted: true }),
      outbox: await state.listOutbox({ ownerId: owner.ownerId }),
      issues: await state.listIssues({ ownerId: owner.ownerId, bindingId: owner.bindingId })
    };
  }, { owner: OWNER, baseline, remoteNext });
  expect(result.local.status).toBe("ready");
  expect(result.current).toEqual(result.local.favorite);
  expect(result.current.meaning).toBe("concurrent local B");
  expect(result.outbox.items).toHaveLength(1);
  expect(["applied", "conflict"]).toContain(result.remote.status);
  if (result.remote.status === "conflict") expect(result.issues.issues).toHaveLength(1);
});

test("真实 v2 fixture 升级 v3 保留 binding/sidecar/attempted/successor/push issue", async ({ page }) => {
  await page.goto("/");
  await page.addScriptTag({ url: "/js/sync-canonical.js" });
  await page.addScriptTag({ url: "/js/cloud-sync-protocol.js" });
  const fixture = await page.evaluate(async owner => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase("LingoFlowSyncDB");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("v2 fixture deletion blocked"));
    });
    const canonical = window.LingoFlowSyncCanonical;
    const baseline = {
      id: "favorite:v2-retained",
      type: "word",
      text: "v2 retained",
      meaning: "A",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      deletedAt: null
    };
    const headPayload = {
      ...baseline,
      meaning: "B",
      updatedAt: "2026-09-01T01:00:00.000Z"
    };
    const successorPayload = {
      ...baseline,
      meaning: "C",
      updatedAt: "2026-09-01T02:00:00.000Z"
    };
    const makeRequest = (mutationId, payload) => ({
      mutationId,
      entityType: "favorites",
      entityId: baseline.id,
      scope: "record",
      schemaVersion: "1",
      operation: "put",
      baseRevision: "revision:5",
      observedCursor: null,
      payload
    });
    const makeOutbox = (mutationId, payload, dependsOnMutationId, attemptedAt, attemptCount) => ({
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      mutationId,
      status: "ready",
      entityType: "favorites",
      entityId: baseline.id,
      scope: "record",
      createdAt: attemptedAt || "2026-09-01T03:00:00.000Z",
      localOperation: "update",
      localBeforeSnapshot: baseline,
      localBeforeFingerprint: canonical.fingerprint(baseline),
      candidateFingerprint: canonical.fingerprint(payload),
      request: makeRequest(mutationId, payload),
      attemptedAt,
      attemptCount,
      leaseToken: null,
      leaseExpiresAt: null,
      dependsOnMutationId
    });
    const head = makeOutbox(
      "mutation:v2:attempted",
      headPayload,
      null,
      "2026-09-01T03:00:00.000Z",
      1
    );
    const successor = makeOutbox(
      "mutation:v2:successor",
      successorPayload,
      head.mutationId,
      null,
      0
    );
    const issueRequest = makeRequest("mutation:v2:issue", headPayload);
    const issueResult = {
      status: "conflict",
      mutationId: issueRequest.mutationId,
      entityType: "favorites",
      entityId: baseline.id,
      scope: "record",
      schemaVersion: "1",
      reason: "base-revision-mismatch",
      currentRevision: "revision:6",
      currentCursor: "cursor:6",
      currentPayload: baseline
    };
    const sidecar = {
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      entityType: "favorites",
      entityId: baseline.id,
      scope: "record",
      schemaVersion: "1",
      serverRevision: "revision:5",
      lastSyncedSnapshot: baseline,
      lastSyncedFingerprint: canonical.fingerprint(baseline)
    };
    const issue = {
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      mutationId: issueRequest.mutationId,
      entityType: "favorites",
      entityId: baseline.id,
      scope: "record",
      schemaVersion: "1",
      kind: "conflict",
      reason: issueResult.reason,
      request: issueRequest,
      result: issueResult,
      createdAt: "2026-09-01T04:00:00.000Z"
    };
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("LingoFlowSyncDB", 2);
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
        const issues = db.createObjectStore("syncIssues", { keyPath: ["ownerId", "mutationId"] });
        issues.createIndex("byOwnerRecord", ["ownerId", "entityType", "entityId", "scope"]);
        issues.createIndex("byOwnerKindCreatedAt", ["ownerId", "kind", "createdAt"]);
        control.add({ key: "workspace-binding", ...owner });
        sidecars.add(sidecar);
        outbox.add(head);
        outbox.add(successor);
        issues.add(issue);
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    return { sidecar, head, successor, issue };
  }, OWNER);

  await page.addScriptTag({ url: "/js/sync-state-repository.js" });
  const upgraded = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    const db = await state.openDatabase();
    return {
      version: db.version,
      stores: Array.from(db.objectStoreNames).sort(),
      binding: await state.getWorkspaceBinding(),
      sidecar: await state.getSidecar(owner.ownerId, "favorite:v2-retained"),
      outbox: await state.listOutbox({ ownerId: owner.ownerId }),
      issues: await state.listIssues({ ownerId: owner.ownerId, bindingId: owner.bindingId })
    };
  }, OWNER);
  expect(upgraded.version).toBe(3);
  expect(upgraded.stores).toEqual(["control", "entitySidecars", "inbox", "outbox", "syncIssues"]);
  expect(upgraded.binding.binding).toMatchObject(OWNER);
  expect(upgraded.sidecar.sidecar).toEqual(fixture.sidecar);
  expect(upgraded.outbox.items).toEqual([fixture.head, fixture.successor]);
  expect(upgraded.issues.issues).toEqual([fixture.issue]);
});
