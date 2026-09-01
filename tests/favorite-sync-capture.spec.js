const { test, expect } = require("@playwright/test");

const projectErrors = new WeakMap();
const OWNER = Object.freeze({ ownerId: "owner:capture", bindingId: "binding:capture" });

async function loadCaptureScripts(page) {
  await page.addScriptTag({ url: "/js/sync-canonical.js" });
  await page.addScriptTag({ url: "/js/cloud-sync-protocol.js" });
  await page.addScriptTag({ url: "/js/sync-state-repository.js" });
  await page.addScriptTag({ url: "/js/sync-favorite-service.js" });
  await page.evaluate(() => {
    window.__makeCaptureItem = (owner, plan, overrides = {}) => {
      const canonical = window.LingoFlowSyncCanonical;
      const mutationId = overrides.mutationId || `mutation:${crypto.randomUUID()}`;
      const before = plan.before === null ? null : canonical.snapshot(plan.before);
      const payload = canonical.snapshot(plan.candidate);
      return {
        ownerId: owner.ownerId,
        bindingId: owner.bindingId,
        mutationId,
        status: "prepared",
        entityType: "favorites",
        entityId: plan.entityId,
        scope: "record",
        createdAt: new Date().toISOString(),
        localOperation: overrides.localOperation || plan.operation,
        localBeforeSnapshot: before,
        localBeforeFingerprint: before === null ? null : canonical.fingerprint(before),
        candidateFingerprint: canonical.fingerprint(payload),
        request: {
          mutationId,
          entityType: "favorites",
          entityId: plan.entityId,
          scope: "record",
          schemaVersion: "1",
          operation: overrides.operation || "put",
          baseRevision: overrides.baseRevision ?? null,
          observedCursor: null,
          payload
        }
      };
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
    window.__getAllSyncStore = async storeName => {
      const db = await window.LingoFlowSyncStateRepository.openDatabase();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const request = tx.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    };
  });
}

async function openApp(page) {
  await page.goto("/");
  await expect(page.locator("#inputText")).toBeVisible();
  await loadCaptureScripts(page);
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

test("LingoFlowSyncDB v1 只创建 control、entitySidecars、outbox", async ({ page }) => {
  const schema = await page.evaluate(async () => {
    const repository = window.LingoFlowSyncStateRepository;
    const db = await repository.openDatabase();
    const sidecarStore = db.transaction("entitySidecars", "readonly").objectStore("entitySidecars");
    const outboxStore = db.transaction("outbox", "readonly").objectStore("outbox");
    return {
      name: db.name,
      version: db.version,
      stores: Array.from(db.objectStoreNames).sort(),
      sidecarKeyPath: sidecarStore.keyPath,
      sidecarIndexes: Array.from(sidecarStore.indexNames).sort().map(name => ({
        name,
        keyPath: sidecarStore.index(name).keyPath
      })),
      outboxKeyPath: outboxStore.keyPath,
      outboxIndexes: Array.from(outboxStore.indexNames).sort().map(name => ({
        name,
        keyPath: outboxStore.index(name).keyPath
      }))
    };
  });

  expect(schema).toEqual({
    name: "LingoFlowSyncDB",
    version: 1,
    stores: ["control", "entitySidecars", "outbox"],
    sidecarKeyPath: ["ownerId", "entityType", "entityId", "scope"],
    sidecarIndexes: [{
      name: "byOwnerEntityType",
      keyPath: ["ownerId", "entityType"]
    }],
    outboxKeyPath: ["ownerId", "mutationId"],
    outboxIndexes: [
      {
        name: "byOwnerRecord",
        keyPath: ["ownerId", "entityType", "entityId", "scope"]
      },
      {
        name: "byOwnerStatusCreatedAt",
        keyPath: ["ownerId", "status", "createdAt"]
      }
    ]
  });
});

test("malformed persisted sidecar/outbox 明确 failed 而不是 missing 或 empty", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const service = window.LingoFlowSyncFavoriteService;
    const state = window.LingoFlowSyncStateRepository;
    const favorites = window.LingoFlowFavoriteRepository;
    const canonical = window.LingoFlowSyncCanonical;
    await service.bindWorkspace(owner);
    const favorite = favorites.create({ type: "word", text: "malformed state" });

    const malformedSidecar = {
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      entityType: "favorites",
      entityId: favorite.id,
      scope: "record",
      schemaVersion: "999",
      serverRevision: "revision:bad",
      lastSyncedSnapshot: favorite,
      lastSyncedFingerprint: canonical.fingerprint(favorite)
    };
    await window.__putSyncStore("entitySidecars", malformedSidecar);
    const sidecarRead = await state.getSidecar(owner.ownerId, favorite.id);
    await window.__deleteSyncStore("entitySidecars", [
      owner.ownerId,
      "favorites",
      favorite.id,
      "record"
    ]);

    const plan = favorites.planUpdate(favorite.id, { note: "candidate" });
    const unknownStatus = window.__makeCaptureItem(owner, plan);
    unknownStatus.status = "unknown";
    await window.__putSyncStore("outbox", unknownStatus);
    const unknownStatusRead = await state.getOutbox(owner.ownerId, unknownStatus.mutationId);
    const unknownStatusList = await state.listOutbox({ ownerId: owner.ownerId });
    await window.__deleteSyncStore("outbox", [owner.ownerId, unknownStatus.mutationId]);

    const identityMismatch = window.__makeCaptureItem(owner, plan);
    identityMismatch.request.mutationId = `mutation:${crypto.randomUUID()}`;
    await window.__putSyncStore("outbox", identityMismatch);
    const identityMismatchRead = await state.getOutbox(
      owner.ownerId,
      identityMismatch.mutationId
    );
    const stillStored = await window.__getAllSyncStore("outbox");
    return {
      sidecarRead,
      unknownStatusRead,
      unknownStatusList,
      identityMismatchRead,
      identityMismatch,
      stillStored
    };
  }, OWNER);

  expect(result.sidecarRead).toMatchObject({
    status: "failed",
    reason: "favorite-sidecar-read-failed"
  });
  expect(result.unknownStatusRead).toMatchObject({
    status: "failed",
    reason: "outbox-read-failed"
  });
  expect(result.unknownStatusList).toMatchObject({
    status: "failed",
    reason: "outbox-list-failed"
  });
  expect(result.identityMismatchRead).toMatchObject({
    status: "failed",
    reason: "outbox-read-failed"
  });
  expect(result.stillStored).toEqual([result.identityMismatch]);
});

test("workspace binding 严格绑定单一 owner 且不保存 auth token", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const service = window.LingoFlowSyncFavoriteService;
    const first = await service.bindWorkspace(owner);
    const repeat = await service.bindWorkspace(owner);
    const mismatch = await service.bindWorkspace({
      ownerId: "owner:other",
      bindingId: "binding:other"
    });
    const stored = await window.LingoFlowSyncStateRepository.getWorkspaceBinding();
    return { first, repeat, mismatch, stored };
  }, OWNER);

  expect(result.first.status).toBe("bound");
  expect(result.repeat.status).toBe("unchanged");
  expect(result.mismatch).toMatchObject({ status: "blocked", reason: "workspace-owner-mismatch" });
  expect(result.stored.binding).toEqual({ key: "workspace-binding", ...OWNER });
  expect(JSON.stringify(result.stored)).not.toContain("token");
});

test("canonical snapshot 确定性、mutation-safe 且拒绝 accessor/cycle/sparse/Symbol/BigInt", async ({ page }) => {
  const result = await page.evaluate(() => {
    const canonical = window.LingoFlowSyncCanonical;
    const first = { z: [3, { b: true, a: null }], a: "value" };
    const second = { a: "value", z: [3, { a: null, b: true }] };
    const snapshot = canonical.snapshot(first);
    first.z[1].a = "caller-change";

    let getterRuns = 0;
    const accessor = {};
    Object.defineProperty(accessor, "unsafe", {
      enumerable: true,
      get() {
        getterRuns += 1;
        return "unsafe";
      }
    });
    const cycle = {};
    cycle.self = cycle;
    const sparse = new Array(2);
    sparse[1] = "x";
    const symbol = { [Symbol("x")]: true };
    const invalid = [accessor, cycle, sparse, symbol, { big: 1n }, { value: NaN }]
      .map(value => {
        try {
          canonical.snapshot(value);
          return null;
        } catch (error) {
          return error.code;
        }
      });
    return {
      equalFingerprint: canonical.fingerprint(snapshot) === canonical.fingerprint(second),
      arrayOrderDifferent: canonical.fingerprint({ values: [1, 2] }) !==
        canonical.fingerprint({ values: [2, 1] }),
      snapshot,
      getterRuns,
      invalid
    };
  });

  expect(result.equalFingerprint).toBe(true);
  expect(result.arrayOrderDifferent).toBe(true);
  expect(result.snapshot).toEqual({ z: [3, { b: true, a: null }], a: "value" });
  expect(result.getterRuns).toBe(0);
  expect(result.invalid).toEqual(Array(6).fill("invalid-json-value"));
});

test("Favorite sidecar roundtrip 保留完整独立 snapshot", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const service = window.LingoFlowSyncFavoriteService;
    const state = window.LingoFlowSyncStateRepository;
    const canonical = window.LingoFlowSyncCanonical;
    await service.bindWorkspace(owner);
    const favorite = window.LingoFlowFavoriteRepository.create({
      type: "word",
      text: "sidecar",
      futureAsset: { nested: ["kept"] }
    });
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
    const written = await state.putSidecar(sidecar);
    favorite.futureAsset.nested.push("caller-only");
    sidecar.lastSyncedSnapshot.text = "caller-only";
    const read = await state.getSidecar(owner.ownerId, written.sidecar.entityId);
    read.sidecar.lastSyncedSnapshot.futureAsset.nested.push("returned-only");
    const reread = await state.getSidecar(owner.ownerId, written.sidecar.entityId);
    return { written, read, reread };
  }, OWNER);

  expect(result.written.status).toBe("ready");
  expect(result.reread.sidecar.lastSyncedSnapshot.text).toBe("sidecar");
  expect(result.reread.sidecar.lastSyncedSnapshot.futureAsset).toEqual({ nested: ["kept"] });
});

test("旧 binding sidecar 阻断 mutation 且不会被当成 missing", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const service = window.LingoFlowSyncFavoriteService;
    const state = window.LingoFlowSyncStateRepository;
    const favorites = window.LingoFlowFavoriteRepository;
    const canonical = window.LingoFlowSyncCanonical;
    await service.bindWorkspace(owner);
    const favorite = favorites.create({
      type: "word",
      text: "binding sidecar",
      note: "before"
    });
    const staleSidecar = {
      ownerId: owner.ownerId,
      bindingId: "binding:old",
      entityType: "favorites",
      entityId: favorite.id,
      scope: "record",
      schemaVersion: "1",
      serverRevision: "revision:old",
      lastSyncedSnapshot: favorite,
      lastSyncedFingerprint: canonical.fingerprint(favorite)
    };
    await window.__putSyncStore("entitySidecars", staleSidecar);
    const captured = await service.update(owner, favorite.id, { note: "must-not-commit" });
    return {
      captured,
      favorite,
      current: favorites.getById(favorite.id),
      sidecars: await window.__getAllSyncStore("entitySidecars"),
      outbox: await state.listOutbox({ ownerId: owner.ownerId })
    };
  }, OWNER);

  expect(result.captured).toMatchObject({
    status: "blocked",
    reason: "workspace-binding-mismatch"
  });
  expect(result.current).toEqual(result.favorite);
  expect(result.sidecars).toHaveLength(1);
  expect(result.sidecars[0].bindingId).toBe("binding:old");
  expect(result.outbox.items).toEqual([]);
});

test("旧 binding ready outbox 不能被替换或 coalesce", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const service = window.LingoFlowSyncFavoriteService;
    const state = window.LingoFlowSyncStateRepository;
    const favorites = window.LingoFlowFavoriteRepository;
    await service.bindWorkspace(owner);
    const favorite = favorites.create({
      type: "word",
      text: "binding outbox",
      note: "before"
    });
    const oldOwner = { ownerId: owner.ownerId, bindingId: "binding:old" };
    const oldPlan = favorites.planUpdate(favorite.id, { note: "old candidate" });
    const oldItem = window.__makeCaptureItem(oldOwner, oldPlan);
    oldItem.status = "ready";
    await window.__putSyncStore("outbox", oldItem);

    const captured = await service.update(owner, favorite.id, { note: "new candidate" });
    const directPlan = favorites.planUpdate(favorite.id, { note: "direct candidate" });
    const directItem = window.__makeCaptureItem(owner, directPlan);
    const direct = await state.withFavoriteWriterLock(owner, lease => (
      state.prepareOutbox(directItem, {
        leaseToken: lease.leaseToken,
        replaceReady: true
      })
    ));
    return {
      favorite,
      captured,
      direct,
      current: favorites.getById(favorite.id),
      oldItem,
      stored: await window.__getAllSyncStore("outbox")
    };
  }, OWNER);

  expect(result.captured).toMatchObject({
    status: "blocked",
    reason: "workspace-binding-mismatch"
  });
  expect(result.direct).toMatchObject({
    status: "blocked",
    reason: "workspace-binding-mismatch"
  });
  expect(result.current).toEqual(result.favorite);
  expect(result.stored).toEqual([result.oldItem]);
});

test("prepared 写失败时 Favorite 零修改", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const service = window.LingoFlowSyncFavoriteService;
    const original = window.LingoFlowSyncStateRepository;
    await service.bindWorkspace(owner);
    window.LingoFlowSyncStateRepository = Object.freeze({
      ...original,
      async prepareOutbox() {
        return { status: "failed", reason: "injected-prepare-failure" };
      }
    });
    try {
      const captured = await service.create(owner, { type: "word", text: "must-not-write" });
      return {
        captured,
        favorites: window.LingoFlowFavoriteRepository.list({ includeDeleted: true }),
        outbox: await original.listOutbox({ ownerId: owner.ownerId })
      };
    } finally {
      window.LingoFlowSyncStateRepository = original;
    }
  }, OWNER);

  expect(result.captured).toMatchObject({ status: "failed", reason: "injected-prepare-failure" });
  expect(result.favorites).toEqual([]);
  expect(result.outbox.items).toEqual([]);
});

test("prepared 后 binding 改变会在 Favorite commit 前阻断并保留原 intent", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const service = window.LingoFlowSyncFavoriteService;
    const original = window.LingoFlowSyncStateRepository;
    await service.bindWorkspace(owner);
    window.LingoFlowSyncStateRepository = Object.freeze({
      ...original,
      async prepareOutbox(item, options) {
        const prepared = await original.prepareOutbox(item, options);
        if (prepared.status === "prepared") {
          await window.__putSyncStore("control", {
            key: "workspace-binding",
            ownerId: owner.ownerId,
            bindingId: "binding:changed-during-operation"
          });
        }
        return prepared;
      }
    });
    try {
      const captured = await service.create(owner, {
        type: "word",
        text: "binding changed"
      });
      return {
        captured,
        favorites: window.LingoFlowFavoriteRepository.list({ includeDeleted: true }),
        outbox: await original.listOutbox({ ownerId: owner.ownerId }),
        binding: await original.getWorkspaceBinding()
      };
    } finally {
      window.LingoFlowSyncStateRepository = original;
    }
  }, OWNER);

  expect(result.captured).toMatchObject({
    status: "blocked",
    reason: "workspace-binding-mismatch",
    prepared: true
  });
  expect(result.favorites).toEqual([]);
  expect(result.outbox.items).toHaveLength(1);
  expect(result.outbox.items[0].status).toBe("prepared");
  expect(result.outbox.items[0].bindingId).toBe(OWNER.bindingId);
  expect(result.binding.binding.bindingId).toBe("binding:changed-during-operation");
});

test("未绑定 workspace 与 prepared 前 crash 都不会产生 Favorite 或 outbox", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const service = window.LingoFlowSyncFavoriteService;
    const repository = window.LingoFlowFavoriteRepository;
    const unbound = await service.create(owner, { type: "word", text: "unbound" });
    const planOnly = repository.planCreate({ type: "word", text: "crash-a" });
    return {
      unbound,
      planOnly,
      favorites: repository.list({ includeDeleted: true }),
      outbox: await window.LingoFlowSyncStateRepository.listOutbox({ ownerId: owner.ownerId })
    };
  }, OWNER);

  expect(result.unbound).toMatchObject({ status: "blocked", reason: "workspace-unbound" });
  expect(result.planOnly.candidate.id).toMatch(/^favorite:/);
  expect(result.favorites).toEqual([]);
  expect(result.outbox.items).toEqual([]);
});

test("create 在 prepared 前冻结 ID/时间，commit 不重新生成并进入 ready", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const service = window.LingoFlowSyncFavoriteService;
    await service.bindWorkspace(owner);
    const captured = await service.create(owner, {
      type: "word",
      text: "durable",
      futureAsset: { flags: [true, false] }
    });
    const stored = window.LingoFlowFavoriteRepository.getById(captured.favorite.id, {
      includeDeleted: true
    });
    const outbox = await window.LingoFlowSyncStateRepository.listOutbox({
      ownerId: owner.ownerId
    });
    return { captured, stored, outbox };
  }, OWNER);

  expect(result.captured.status).toBe("ready");
  expect(result.outbox.items).toHaveLength(1);
  expect(result.outbox.items[0].status).toBe("ready");
  expect(result.outbox.items[0].request.payload).toEqual(result.stored);
  expect(result.outbox.items[0].request.entityId).toBe(result.stored.id);
  expect(result.outbox.items[0].request.payload.createdAt).toBe(result.stored.createdAt);
  expect(result.outbox.items[0].request.payload.updatedAt).toBe(result.stored.updatedAt);
  expect(result.outbox.items[0].request.baseRevision).toBeNull();
  expect(result.outbox.items[0].request.observedCursor).toBeNull();
});

test("update coalesce 为新 mutationId，旧 frozen request 不被修改", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const service = window.LingoFlowSyncFavoriteService;
    const state = window.LingoFlowSyncStateRepository;
    await service.bindWorkspace(owner);
    const created = await service.create(owner, { type: "word", text: "coalesce", note: "start" });
    const first = (await state.listOutbox({ ownerId: owner.ownerId })).items[0];
    const firstFrozen = structuredClone(first);
    const updateA = await service.update(owner, created.favorite.id, { note: "A" });
    const updateB = await service.update(owner, created.favorite.id, { note: "B" });
    const updateC = await service.update(owner, created.favorite.id, { note: "C" });
    const finalItems = (await state.listOutbox({ ownerId: owner.ownerId })).items;
    return {
      ids: [created.mutationId, updateA.mutationId, updateB.mutationId, updateC.mutationId],
      first,
      firstFrozen,
      finalItems,
      favorite: window.LingoFlowFavoriteRepository.getById(created.favorite.id)
    };
  }, OWNER);

  expect(new Set(result.ids).size).toBe(4);
  expect(result.first).toEqual(result.firstFrozen);
  expect(result.finalItems).toHaveLength(1);
  expect(result.finalItems[0].mutationId).toBe(result.ids[3]);
  expect(result.finalItems[0].request.payload.note).toBe("C");
  expect(result.favorite.note).toBe("C");
});

test("coalescing 新 insertion 失败时 transaction 回滚并保留不同 Favorite intent", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const service = window.LingoFlowSyncFavoriteService;
    const state = window.LingoFlowSyncStateRepository;
    const favorites = window.LingoFlowFavoriteRepository;
    await service.bindWorkspace(owner);
    const first = await service.create(owner, {
      type: "word",
      text: "rollback first",
      note: "before"
    });
    const second = await service.create(owner, {
      type: "word",
      text: "rollback second"
    });
    const before = await state.listOutbox({ ownerId: owner.ownerId });
    const firstStored = before.items.find(item => item.mutationId === first.mutationId);
    const secondStored = before.items.find(item => item.mutationId === second.mutationId);
    const plan = favorites.planUpdate(first.favorite.id, { note: "candidate" });
    const colliding = window.__makeCaptureItem(owner, plan, {
      mutationId: second.mutationId
    });
    const prepared = await state.withFavoriteWriterLock(owner, lease => (
      state.prepareOutbox(colliding, {
        leaseToken: lease.leaseToken,
        replaceReady: true
      })
    ));
    return {
      first,
      second,
      firstStored,
      secondStored,
      prepared,
      after: await state.listOutbox({ ownerId: owner.ownerId }),
      current: favorites.getById(first.favorite.id)
    };
  }, OWNER);

  expect(result.prepared).toMatchObject({
    status: "failed",
    reason: "outbox-prepare-failed"
  });
  expect(result.after.items).toHaveLength(2);
  expect(result.after.items).toContainEqual(result.firstStored);
  expect(result.after.items).toContainEqual(result.secondStored);
  expect(result.after.items.find(item => item.entityId === result.first.favorite.id).request)
    .toEqual(result.firstStored.request);
  expect(result.current).toEqual(result.first.favorite);
  expect(result.current.note).toBe("before");
});

test("已同步 Favorite 的本地更新使用 sidecar R5 且完整 snapshot mutation-safe", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const service = window.LingoFlowSyncFavoriteService;
    const state = window.LingoFlowSyncStateRepository;
    const canonical = window.LingoFlowSyncCanonical;
    await service.bindWorkspace(owner);
    const favorite = window.LingoFlowFavoriteRepository.create({
      type: "word",
      text: "revision base",
      futureAsset: { values: ["base"] }
    });
    await state.putSidecar({
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      entityType: "favorites",
      entityId: favorite.id,
      scope: "record",
      schemaVersion: "1",
      serverRevision: "revision:R5",
      lastSyncedSnapshot: favorite,
      lastSyncedFingerprint: canonical.fingerprint(favorite)
    });
    const patch = { note: "local", futureAsset: { values: ["base", "next"] } };
    const captured = await service.update(owner, favorite.id, patch);
    patch.futureAsset.values.push("caller-only");
    captured.favorite.futureAsset.values.push("returned-only");
    const item = (await state.listOutbox({ ownerId: owner.ownerId })).items[0];
    const stored = window.LingoFlowFavoriteRepository.getById(favorite.id);
    return { captured, item, stored };
  }, OWNER);

  expect(result.item.request.baseRevision).toBe("revision:R5");
  expect(result.item.request.payload.futureAsset.values).toEqual(["base", "next"]);
  expect(result.stored.futureAsset.values).toEqual(["base", "next"]);
  expect(result.stored).not.toHaveProperty("ownerId");
  expect(result.stored).not.toHaveProperty("serverRevision");
});

test("delete 使用 tombstone put；可靠 tombstone sidecar 的 restore 使用显式 restore", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const service = window.LingoFlowSyncFavoriteService;
    const state = window.LingoFlowSyncStateRepository;
    const canonical = window.LingoFlowSyncCanonical;
    await service.bindWorkspace(owner);
    const favorite = window.LingoFlowFavoriteRepository.create({ type: "word", text: "lifecycle" });
    const deleted = await service.softDelete(owner, favorite.id);
    const deleteItem = (await state.listOutbox({ ownerId: owner.ownerId })).items[0];
    await state.putSidecar({
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      entityType: "favorites",
      entityId: favorite.id,
      scope: "record",
      schemaVersion: "1",
      serverRevision: "revision:tombstone",
      lastSyncedSnapshot: deleted.favorite,
      lastSyncedFingerprint: canonical.fingerprint(deleted.favorite)
    });
    const restored = await service.restore(owner, favorite.id);
    const restoreItem = (await state.listOutbox({ ownerId: owner.ownerId })).items[0];
    return { deleted, deleteItem, restored, restoreItem };
  }, OWNER);

  expect(result.deleteItem.request.operation).toBe("put");
  expect(result.deleteItem.request.payload.deletedAt).not.toBeNull();
  expect(result.restored.status).toBe("ready");
  expect(result.restoreItem.request.operation).toBe("restore");
  expect(result.restoreItem.request.baseRevision).toBe("revision:tombstone");
  expect(result.restoreItem.request.payload.deletedAt).toBeNull();
  expect(result.restoreItem.localOperation).toBe("restore");
});

test("没有可靠 tombstone revision 的 restore 明确 blocked 且不修改 Favorite", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const service = window.LingoFlowSyncFavoriteService;
    await service.bindWorkspace(owner);
    const favorite = window.LingoFlowFavoriteRepository.create({ type: "word", text: "blocked restore" });
    const deleted = window.LingoFlowFavoriteRepository.softDelete(favorite.id);
    const restored = await service.restore(owner, favorite.id);
    return {
      deleted,
      restored,
      current: window.LingoFlowFavoriteRepository.getById(favorite.id, { includeDeleted: true }),
      outbox: await window.LingoFlowSyncStateRepository.listOutbox({ ownerId: owner.ownerId })
    };
  }, OWNER);

  expect(result.restored).toMatchObject({
    status: "blocked",
    reason: "restore-tombstone-revision-unavailable"
  });
  expect(result.current).toEqual(result.deleted);
  expect(result.outbox.items).toEqual([]);
});

test("FavoriteRepository expected-before mismatch 返回 stale-local-state 且零覆盖", async ({ page }) => {
  const result = await page.evaluate(() => {
    const repository = window.LingoFlowFavoriteRepository;
    const favorite = repository.create({ type: "word", text: "expected", note: "before" });
    const plan = repository.planUpdate(favorite.id, { note: "planned" });
    const concurrent = repository.update(favorite.id, { note: "concurrent" });
    const committed = repository.commitPlannedMutation(plan);
    return {
      plan,
      concurrent,
      committed,
      current: repository.getById(favorite.id)
    };
  });

  expect(result.committed).toMatchObject({ status: "stale-local-state", written: false });
  expect(result.current).toEqual(result.concurrent);
  expect(result.current.note).toBe("concurrent");
  expect(result.current.note).not.toBe(result.plan.candidate.note);
});

test("crash B：prepared 重启后仍存在并 commit 原 candidate", async ({ page }) => {
  const initial = await page.evaluate(async owner => {
    const service = window.LingoFlowSyncFavoriteService;
    const state = window.LingoFlowSyncStateRepository;
    const favorites = window.LingoFlowFavoriteRepository;
    await service.bindWorkspace(owner);
    let plan;
    let item;
    await state.withFavoriteWriterLock(owner, async lease => {
      plan = favorites.planCreate({ type: "word", text: "crash-b" });
      item = window.__makeCaptureItem(owner, plan);
      return await state.prepareOutbox(item, {
        leaseToken: lease.leaseToken,
        replaceReady: false
      });
    });
    const before = favorites.getById(plan.entityId, { includeDeleted: true });
    const stored = await state.getOutbox(owner.ownerId, item.mutationId);
    state.closeDatabase();
    return { plan, item, before, stored };
  }, OWNER);

  await page.reload();
  await loadCaptureScripts(page);
  const restarted = await page.evaluate(async ({ owner, entityId, mutationId }) => {
    const state = window.LingoFlowSyncStateRepository;
    const beforeReconcile = await state.getOutbox(owner.ownerId, mutationId);
    const reconciled = await window.LingoFlowSyncFavoriteService.reconcile(owner);
    const current = window.LingoFlowFavoriteRepository.getById(entityId, {
      includeDeleted: true
    });
    const stored = await state.getOutbox(owner.ownerId, mutationId);
    return { beforeReconcile, reconciled, current, stored };
  }, {
    owner: OWNER,
    entityId: initial.plan.entityId,
    mutationId: initial.item.mutationId
  });

  expect(initial.before).toBeNull();
  expect(initial.stored.item.status).toBe("prepared");
  expect(restarted.beforeReconcile.item.status).toBe("prepared");
  expect(restarted.reconciled.status).toBe("ready");
  expect(restarted.current).toEqual(initial.plan.candidate);
  expect(restarted.stored.item.status).toBe("ready");
  expect(restarted.stored.item.mutationId).toBe(initial.item.mutationId);
});

test("crash C/D：已 commit 的 prepared 只 mark ready；ready 重启后原样保留", async ({ page }) => {
  const initial = await page.evaluate(async owner => {
    const service = window.LingoFlowSyncFavoriteService;
    const state = window.LingoFlowSyncStateRepository;
    const favorites = window.LingoFlowFavoriteRepository;
    await service.bindWorkspace(owner);
    let plan;
    let item;
    await state.withFavoriteWriterLock(owner, async lease => {
      plan = favorites.planCreate({ type: "word", text: "crash-c" });
      item = window.__makeCaptureItem(owner, plan);
      const prepared = await state.prepareOutbox(item, {
        leaseToken: lease.leaseToken,
        replaceReady: false
      });
      const committed = favorites.commitPlannedMutation(plan);
      return { prepared, committed };
    });
    const beforeReconcile = favorites.getById(plan.entityId, { includeDeleted: true });
    const reconciled = await service.reconcile(owner);
    const afterReconcile = favorites.getById(plan.entityId, { includeDeleted: true });
    const ready = await state.getOutbox(owner.ownerId, item.mutationId);
    state.closeDatabase();
    return { plan, item, beforeReconcile, reconciled, afterReconcile, ready };
  }, OWNER);

  await page.reload();
  await loadCaptureScripts(page);
  const restarted = await page.evaluate(async ({ owner, mutationId }) => (
    window.LingoFlowSyncStateRepository.getOutbox(owner.ownerId, mutationId)
  ), { owner: OWNER, mutationId: initial.item.mutationId });

  expect(initial.beforeReconcile).toEqual(initial.plan.candidate);
  expect(initial.afterReconcile).toEqual(initial.beforeReconcile);
  expect(initial.ready.item.status).toBe("ready");
  expect(restarted.item).toEqual(initial.ready.item);
});

test("ready transition 失败后重启只恢复原 prepared request", async ({ page }) => {
  const initial = await page.evaluate(async owner => {
    const service = window.LingoFlowSyncFavoriteService;
    const original = window.LingoFlowSyncStateRepository;
    await service.bindWorkspace(owner);
    let injected = false;
    window.LingoFlowSyncStateRepository = Object.freeze({
      ...original,
      async markOutboxReady(context) {
        if (!injected) {
          injected = true;
          return { status: "failed", reason: "injected-ready-transition-failure" };
        }
        return await original.markOutboxReady(context);
      }
    });
    let captured;
    try {
      captured = await service.create(owner, {
        type: "word",
        text: "ready recovery"
      });
    } finally {
      window.LingoFlowSyncStateRepository = original;
    }
    const current = window.LingoFlowFavoriteRepository.getById(captured.favorite.id, {
      includeDeleted: true
    });
    const stored = await original.getOutbox(owner.ownerId, captured.mutationId);
    original.closeDatabase();
    return { captured, current, stored };
  }, OWNER);

  await page.reload();
  await loadCaptureScripts(page);
  const restarted = await page.evaluate(async ({ owner, entityId, mutationId }) => {
    const service = window.LingoFlowSyncFavoriteService;
    const state = window.LingoFlowSyncStateRepository;
    const before = await state.getOutbox(owner.ownerId, mutationId);
    const currentBefore = window.LingoFlowFavoriteRepository.getById(entityId, {
      includeDeleted: true
    });
    const reconciled = await service.reconcile(owner);
    const after = await state.getOutbox(owner.ownerId, mutationId);
    const currentAfter = window.LingoFlowFavoriteRepository.getById(entityId, {
      includeDeleted: true
    });
    return { before, currentBefore, reconciled, after, currentAfter };
  }, {
    owner: OWNER,
    entityId: initial.captured.favorite.id,
    mutationId: initial.captured.mutationId
  });

  expect(initial.captured).toMatchObject({
    status: "local-committed-pending-reconciliation",
    reason: "injected-ready-transition-failure"
  });
  expect(initial.current).toEqual(initial.captured.favorite);
  expect(initial.stored.item.status).toBe("prepared");
  expect(restarted.before.item).toEqual(initial.stored.item);
  expect(restarted.currentBefore).toEqual(initial.current);
  expect(restarted.reconciled.status).toBe("ready");
  expect(restarted.after.item.status).toBe("ready");
  expect(restarted.after.item.mutationId).toBe(initial.stored.item.mutationId);
  expect(restarted.after.item.request).toEqual(initial.stored.item.request);
  expect(restarted.currentAfter).toEqual(restarted.currentBefore);
});

test("prepared 当前既非 before 也非 candidate 时 reconciliation blocked 并保留 intent", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const service = window.LingoFlowSyncFavoriteService;
    const state = window.LingoFlowSyncStateRepository;
    const favorites = window.LingoFlowFavoriteRepository;
    await service.bindWorkspace(owner);
    const favorite = favorites.create({ type: "word", text: "blocked", note: "before" });
    let item;
    await state.withFavoriteWriterLock(owner, async lease => {
      const plan = favorites.planUpdate(favorite.id, { note: "candidate" });
      item = window.__makeCaptureItem(owner, plan);
      return await state.prepareOutbox(item, {
        leaseToken: lease.leaseToken,
        replaceReady: false
      });
    });
    const concurrent = favorites.update(favorite.id, { note: "other" });
    const reconciled = await service.reconcile(owner);
    const stored = await state.getOutbox(owner.ownerId, item.mutationId);
    return { item, concurrent, reconciled, stored, current: favorites.getById(favorite.id) };
  }, OWNER);

  expect(result.reconciled).toMatchObject({ status: "blocked", reason: "reconciliation-blocked" });
  expect(result.stored.item.status).toBe("prepared");
  expect(result.current).toEqual(result.concurrent);
  expect(result.current.note).toBe("other");
});

test("两个页面修改不同 Favorite 仍由全局 writer lock 串行且不丢整表数据", async ({ page, context }) => {
  const second = await context.newPage();
  const secondErrors = [];
  second.on("pageerror", error => secondErrors.push(error.message));
  await openApp(second);
  await page.evaluate(owner => window.LingoFlowSyncFavoriteService.bindWorkspace(owner), OWNER);

  const [firstResult, secondResult] = await Promise.all([
    page.evaluate(owner => window.LingoFlowSyncFavoriteService.create(owner, {
      type: "word",
      text: "tab-one"
    }), OWNER),
    second.evaluate(owner => window.LingoFlowSyncFavoriteService.create(owner, {
      type: "word",
      text: "tab-two"
    }), OWNER)
  ]);
  const final = await page.evaluate(async owner => ({
    favorites: window.LingoFlowFavoriteRepository.list({ includeDeleted: true }),
    outbox: await window.LingoFlowSyncStateRepository.listOutbox({ ownerId: owner.ownerId }),
    lease: await window.LingoFlowSyncStateRepository.getFavoriteWriterLease()
  }), OWNER);
  await second.close();

  expect(firstResult.status).toBe("ready");
  expect(secondResult.status).toBe("ready");
  expect(final.favorites.map(item => item.text).sort()).toEqual(["tab-one", "tab-two"]);
  expect(final.outbox.items).toHaveLength(2);
  expect(final.lease.status).toBe("missing");
  expect(secondErrors).toEqual([]);
});

test("崩溃遗留 stale writer marker 不阻止 Web Lock 安全接管", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const service = window.LingoFlowSyncFavoriteService;
    const state = window.LingoFlowSyncStateRepository;
    await service.bindWorkspace(owner);
    const db = await state.openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("control", "readwrite");
      tx.objectStore("control").put({
        key: "favorite-writer-lock",
        ownerId: owner.ownerId,
        bindingId: owner.bindingId,
        leaseToken: "favorite-writer:stale",
        acquiredAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:00:01.000Z"
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    const captured = await service.create(owner, { type: "word", text: "takeover" });
    const lease = await state.getFavoriteWriterLease();
    return { captured, lease };
  }, OWNER);

  expect(result.captured.status).toBe("ready");
  expect(result.lease.status).toBe("missing");
});

test("不支持 Web Locks 时明确 blocked 且不使用内存锁降级", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const service = window.LingoFlowSyncFavoriteService;
    await service.bindWorkspace(owner);
    const hadOwnLocks = Object.prototype.hasOwnProperty.call(navigator, "locks");
    const ownDescriptor = hadOwnLocks
      ? Object.getOwnPropertyDescriptor(navigator, "locks")
      : null;
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: null
    });
    try {
      const captured = await service.create(owner, {
        type: "word",
        text: "no unsafe fallback"
      });
      return {
        captured,
        favorites: window.LingoFlowFavoriteRepository.list({ includeDeleted: true }),
        outbox: await window.LingoFlowSyncStateRepository.listOutbox({
          ownerId: owner.ownerId
        })
      };
    } finally {
      if (hadOwnLocks) Object.defineProperty(navigator, "locks", ownDescriptor);
      else delete navigator.locks;
    }
  }, OWNER);

  expect(result.captured).toMatchObject({
    status: "blocked",
    reason: "favorite-writer-lock-unavailable"
  });
  expect(result.favorites).toEqual([]);
  expect(result.outbox.items).toEqual([]);
});

test("drift scan 捕获 active、tombstone 与 explicit restore；physical missing blocked", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const service = window.LingoFlowSyncFavoriteService;
    const state = window.LingoFlowSyncStateRepository;
    const favorites = window.LingoFlowFavoriteRepository;
    const canonical = window.LingoFlowSyncCanonical;
    await service.bindWorkspace(owner);

    const active = favorites.create({ type: "word", text: "active drift" });
    const deleted = favorites.create({ type: "word", text: "delete drift" });
    favorites.softDelete(deleted.id);
    const remoteDeleted = favorites.create({ type: "word", text: "remote tombstone" });
    const tombstoneSnapshot = {
      ...remoteDeleted,
      updatedAt: new Date(Date.parse(remoteDeleted.updatedAt) + 1000).toISOString(),
      deletedAt: new Date(Date.parse(remoteDeleted.updatedAt) + 1000).toISOString()
    };
    await state.putSidecar({
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      entityType: "favorites",
      entityId: remoteDeleted.id,
      scope: "record",
      schemaVersion: "1",
      serverRevision: "revision:deleted",
      lastSyncedSnapshot: tombstoneSnapshot,
      lastSyncedFingerprint: canonical.fingerprint(tombstoneSnapshot)
    });
    const first = await service.reconcile(owner);
    const items = (await state.listOutbox({ ownerId: owner.ownerId })).items;

    const missing = favorites.create({ type: "word", text: "physical missing" });
    await state.putSidecar({
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      entityType: "favorites",
      entityId: missing.id,
      scope: "record",
      schemaVersion: "1",
      serverRevision: "revision:missing",
      lastSyncedSnapshot: missing,
      lastSyncedFingerprint: canonical.fingerprint(missing)
    });
    const raw = JSON.parse(localStorage.getItem("LingoFlowFavoriteEntities"));
    delete raw[missing.id];
    localStorage.setItem("LingoFlowFavoriteEntities", JSON.stringify(raw));
    const second = await service.reconcile(owner);
    return { ids: { active: active.id, deleted: deleted.id, remoteDeleted: remoteDeleted.id, missing: missing.id }, first, items, second };
  }, OWNER);

  expect(result.first.status).toBe("ready");
  const byId = new Map(result.items.map(item => [item.entityId, item]));
  expect(byId.get(result.ids.active).request.operation).toBe("put");
  expect(byId.get(result.ids.deleted).request.operation).toBe("put");
  expect(byId.get(result.ids.deleted).request.payload.deletedAt).not.toBeNull();
  expect(byId.get(result.ids.remoteDeleted).request.operation).toBe("restore");
  expect(result.second).toMatchObject({ status: "blocked", reason: "reconciliation-blocked" });
  expect(result.second.blocked).toContainEqual({
    entityId: result.ids.missing,
    reason: "local-favorite-missing"
  });
});

test("delete→restore never-sent 安全替换旧 mutation，并保留本地 restore intent", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const service = window.LingoFlowSyncFavoriteService;
    const state = window.LingoFlowSyncStateRepository;
    await service.bindWorkspace(owner);
    const created = await service.create(owner, { type: "word", text: "net lifecycle" });
    const deleted = await service.softDelete(owner, created.favorite.id);
    const deleteItem = (await state.listOutbox({ ownerId: owner.ownerId })).items[0];
    const restored = await service.restore(owner, created.favorite.id);
    const items = (await state.listOutbox({ ownerId: owner.ownerId })).items;
    return { created, deleted, deleteItem, restored, items };
  }, OWNER);

  expect(result.deleted.status).toBe("ready");
  expect(result.restored.status).toBe("ready");
  expect(result.restored.coalescedRestore).toBe(true);
  expect(result.items).toHaveLength(1);
  expect(result.items[0].mutationId).not.toBe(result.deleteItem.mutationId);
  expect(result.items[0].localOperation).toBe("restore");
  expect(result.items[0].request.operation).toBe("put");
  expect(result.items[0].request.payload.deletedAt).toBeNull();
});

test("active server R5 的 never-sent delete→restore 保持普通 put 因果", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const service = window.LingoFlowSyncFavoriteService;
    const state = window.LingoFlowSyncStateRepository;
    const favorites = window.LingoFlowFavoriteRepository;
    const canonical = window.LingoFlowSyncCanonical;
    await service.bindWorkspace(owner);
    const baseline = favorites.create({
      type: "word",
      text: "active R5",
      note: "server baseline"
    });
    await state.putSidecar({
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      entityType: "favorites",
      entityId: baseline.id,
      scope: "record",
      schemaVersion: "1",
      serverRevision: "revision:R5",
      lastSyncedSnapshot: baseline,
      lastSyncedFingerprint: canonical.fingerprint(baseline)
    });

    const deleted = await service.softDelete(owner, baseline.id);
    const deleteItem = (await state.listOutbox({ ownerId: owner.ownerId })).items[0];
    const restored = await service.restore(owner, baseline.id);
    const restoreItem = (await state.listOutbox({ ownerId: owner.ownerId })).items[0];
    const updated = await service.update(owner, baseline.id, {
      note: "latest local active"
    });
    const finalItems = (await state.listOutbox({ ownerId: owner.ownerId })).items;
    return {
      baseline,
      deleted,
      deleteItem,
      restored,
      restoreItem,
      updated,
      finalItems,
      current: favorites.getById(baseline.id)
    };
  }, OWNER);

  expect(result.deleteItem.request.operation).toBe("put");
  expect(result.deleteItem.request.baseRevision).toBe("revision:R5");
  expect(result.deleteItem.request.payload.deletedAt).not.toBeNull();
  expect(result.restored.coalescedRestore).toBe(true);
  expect(result.restoreItem.request.operation).toBe("put");
  expect(result.restoreItem.request.baseRevision).toBe("revision:R5");
  expect(result.restoreItem.mutationId).not.toBe(result.deleteItem.mutationId);
  expect(result.finalItems).toHaveLength(1);
  expect(result.finalItems[0].request.operation).toBe("put");
  expect(result.finalItems[0].request.baseRevision).toBe("revision:R5");
  expect(result.finalItems[0].request.payload.note).toBe("latest local active");
  expect(result.finalItems[0].request.payload.deletedAt).toBeNull();
  expect(result.finalItems[0].mutationId).toBe(result.updated.mutationId);
  expect(result.current).toEqual(result.finalItems[0].request.payload);
});

test("Sync metadata 不进入 Favorite 或 Backup v2，capture 不访问网络/Fake Service", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const service = window.LingoFlowSyncFavoriteService;
    let fetchCalls = 0;
    let xhrCalls = 0;
    let socketCalls = 0;
    let fakeCalls = 0;
    const originalFetch = window.fetch;
    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const OriginalSocket = window.WebSocket;
    const originalFake = window.LingoFlowFakeSyncService;
    window.fetch = () => {
      fetchCalls += 1;
      throw new Error("network forbidden");
    };
    XMLHttpRequest.prototype.open = function() {
      xhrCalls += 1;
      throw new Error("network forbidden");
    };
    window.WebSocket = function() {
      socketCalls += 1;
      throw new Error("network forbidden");
    };
    window.LingoFlowFakeSyncService = new Proxy({}, {
      get() {
        fakeCalls += 1;
        throw new Error("Fake Service forbidden");
      }
    });
    try {
      await service.bindWorkspace(owner);
      const captured = await service.create(owner, { type: "word", text: "isolated" });
      const backup = await window.LingoFlowBackupV2Export.exportBackup();
      const favorite = window.LingoFlowFavoriteRepository.getById(captured.favorite.id, {
        includeDeleted: true
      });
      return {
        captured,
        favorite,
        backup,
        fetchCalls,
        xhrCalls,
        socketCalls,
        fakeCalls
      };
    } finally {
      window.fetch = originalFetch;
      XMLHttpRequest.prototype.open = originalXhrOpen;
      window.WebSocket = OriginalSocket;
      window.LingoFlowFakeSyncService = originalFake;
    }
  }, OWNER);

  expect(result.captured.status).toBe("ready");
  expect(result.fetchCalls).toBe(0);
  expect(result.xhrCalls).toBe(0);
  expect(result.socketCalls).toBe(0);
  expect(result.fakeCalls).toBe(0);
  for (const key of ["ownerId", "bindingId", "serverRevision", "syncStatus", "dirty"] ) {
    expect(result.favorite).not.toHaveProperty(key);
  }
  expect(result.backup.status).toBe("ready");
  const serialized = JSON.stringify(result.backup.payload);
  expect(serialized).not.toContain(OWNER.ownerId);
  expect(serialized).not.toContain("mutation:");
  expect(serialized).not.toContain("LingoFlowSyncDB");
});
