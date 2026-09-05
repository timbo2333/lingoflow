const { test, expect } = require("@playwright/test");

const OWNER = Object.freeze({
  ownerId: "11111111-1111-4111-8111-111111111111",
  bindingId: "binding:learning:a"
});

function favorite(id, overrides = {}) {
  return {
    id,
    type: "word",
    text: "ambiguous",
    meaning: "有歧义的",
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    deletedAt: null,
    ...overrides
  };
}

function learningState(favoriteId, mastered, overrides = {}) {
  return {
    favoriteId,
    mastered,
    createdAt: "2026-09-05T00:01:00.000Z",
    updatedAt: "2026-09-05T00:01:00.000Z",
    deletedAt: null,
    ...overrides
  };
}

async function openKernel(page) {
  await page.addInitScript(() => {
    localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
  });
  await page.goto("/");
  await expect(page.locator("#inputText")).toBeVisible();
  await page.addScriptTag({ url: "/js/fake-sync-service.js" });
  await page.evaluate(async owner => {
    await window.LingoFlowSyncFavoriteService.bindWorkspace(owner);
    const cloud = window.LingoFlowFakeSyncService.create();
    window.__learningSync = { owner, cloud, offline: false };
    window.__makeLearningWorkers = () => {
      const current = window.__learningSync;
      const recordRepositories = {
        favorites: window.LingoFlowFavoriteRepository,
        favoriteLearningStates: window.LingoFlowFavoriteLearningRepository
      };
      current.push = window.LingoFlowSyncFavoritePushWorker.create({
        push: async (wireOwner, mutation) => {
          if (current.offline) throw new TypeError("simulated offline");
          return current.cloud.push(wireOwner, mutation);
        },
        recordRepositories,
        reconcileServices: [
          window.LingoFlowSyncFavoriteService,
          window.LingoFlowSyncFavoriteLearningService
        ]
      });
      current.pull = window.LingoFlowSyncFavoritePullWorker.create({
        pull: (wireOwner, cursor) => current.cloud.pull(wireOwner, cursor),
        recordRepositories
      });
    };
    window.__makeLearningWorkers();
    window.__drainLearningPush = async () => {
      const outcomes = [];
      for (let index = 0; index < 20; index += 1) {
        const outcome = await window.__learningSync.push.runOnce(
          window.__learningSync.owner
        );
        outcomes.push(outcome);
        if (outcome.status === "idle" || outcome.status === "failed") return outcomes;
        if (!["applied", "unchanged", "conflict", "rejected"].includes(outcome.status)) {
          return outcomes;
        }
      }
      throw new Error("Push 未在限制内清空。");
    };
    window.__receiveAndDrainLearning = async () => {
      const current = window.__learningSync;
      const received = await current.pull.receiveOnce(current.owner);
      const applied = [];
      for (let index = 0; index < 30; index += 1) {
        const outcome = await current.pull.applyNext(current.owner);
        applied.push(outcome);
        if (outcome.status === "idle" ||
            !["applied", "unchanged", "conflict"].includes(outcome.status)) {
          return { received, applied };
        }
      }
      throw new Error("Inbox 未在限制内清空。");
    };
    window.__resetLearningDevice = async bindingId => {
      window.LingoFlowSyncStateRepository.closeDatabase();
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase("LingoFlowSyncDB");
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("Sync DB delete blocked"));
      });
      localStorage.removeItem("LingoFlowFavoriteEntities");
      for (let index = localStorage.length - 1; index >= 0; index -= 1) {
        const key = localStorage.key(index);
        if (key?.startsWith("LingoFlowFavoriteLearningState:")) {
          localStorage.removeItem(key);
        }
      }
      window.__learningSync.owner = {
        ownerId: window.__learningSync.owner.ownerId,
        bindingId
      };
      await window.LingoFlowSyncFavoriteService.bindWorkspace(
        window.__learningSync.owner
      );
      window.__makeLearningWorkers();
    };
    window.__remoteLearning = (ownerId, state, options = {}) => {
      const mutationId = options.mutationId || `mutation:${crypto.randomUUID()}`;
      return window.__learningSync.cloud.push(
        { ownerId },
        {
          mutationId,
          entityType: "favoriteLearningStates",
          entityId: state.favoriteId,
          scope: "record",
          schemaVersion: "1",
          operation: options.operation || "put",
          baseRevision: options.baseRevision ?? null,
          observedCursor: null,
          payload: structuredClone(state)
        }
      );
    };
  }, OWNER);
}

test.beforeEach(async ({ page }) => {
  await openKernel(page);
});

test("mastered 写入本地立即生效并产生 durable Learning mutation", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const favorite = window.LingoFlowFavoriteRepository.create({
      type: "word",
      text: "durable-learning"
    });
    const captured = await window.LingoFlowSyncFavoriteLearningService.setMastered(
      owner,
      favorite.id,
      true
    );
    const outbox = await window.LingoFlowSyncStateRepository.listOutbox({
      ownerId: owner.ownerId,
      entityType: "favoriteLearningStates"
    });
    return {
      captured,
      stored: window.LingoFlowFavoriteLearningRepository.get(favorite.id),
      outbox
    };
  }, OWNER);

  expect(result.captured.status).toBe("ready");
  expect(result.stored.mastered).toBe(true);
  expect(result.outbox.items).toHaveLength(1);
  expect(result.outbox.items[0]).toMatchObject({
    status: "ready",
    entityType: "favoriteLearningStates",
    entityId: result.stored.favoriteId
  });
});

test("A Push 后 B Pull/Apply 得到 mastered=true", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const created = await window.LingoFlowSyncFavoriteService.create(owner, {
      type: "word",
      text: "cross-device-mastered"
    });
    await window.__drainLearningPush();
    await window.LingoFlowSyncFavoriteLearningService.setMastered(
      owner,
      created.favorite.id,
      true
    );
    await window.__drainLearningPush();
    await window.__resetLearningDevice("binding:learning:b");
    const pulled = await window.__receiveAndDrainLearning();
    return {
      pulled,
      favorite: window.LingoFlowFavoriteRepository.getById(created.favorite.id),
      learning: window.LingoFlowFavoriteLearningRepository.get(created.favorite.id)
    };
  }, OWNER);

  expect(result.pulled.received.status).toBe("received");
  expect(result.favorite).not.toBeNull();
  expect(result.learning).toMatchObject({ mastered: true });
});

test("B 改回未掌握后 A 最终得到 mastered=false", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const created = await window.LingoFlowSyncFavoriteService.create(owner, {
      type: "word",
      text: "cross-device-unmastered"
    });
    await window.__drainLearningPush();
    await window.LingoFlowSyncFavoriteLearningService.setMastered(
      owner,
      created.favorite.id,
      true
    );
    await window.__drainLearningPush();
    await window.__resetLearningDevice("binding:learning:b");
    await window.__receiveAndDrainLearning();
    await window.LingoFlowSyncFavoriteLearningService.setMastered(
      window.__learningSync.owner,
      created.favorite.id,
      false
    );
    await window.__drainLearningPush();
    await window.__resetLearningDevice("binding:learning:a2");
    await window.__receiveAndDrainLearning();
    return window.LingoFlowFavoriteLearningRepository.get(created.favorite.id);
  }, OWNER);

  expect(result.mastered).toBe(false);
});

test("离线 Learning 修改 local-first 且 pending 在重试后清空", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const favorite = window.LingoFlowFavoriteRepository.create({
      type: "word",
      text: "offline-learning"
    });
    const captured = await window.LingoFlowSyncFavoriteLearningService.setMastered(
      owner,
      favorite.id,
      true
    );
    window.__learningSync.offline = true;
    const failed = await window.__learningSync.push.runOnce(owner);
    const pending = await window.LingoFlowSyncStateRepository.listOutbox({
      ownerId: owner.ownerId,
      entityType: "favoriteLearningStates"
    });
    window.__learningSync.offline = false;
    const retried = await window.__learningSync.push.runOnce(owner);
    const settled = await window.LingoFlowSyncStateRepository.listOutbox({
      ownerId: owner.ownerId,
      entityType: "favoriteLearningStates"
    });
    return {
      captured,
      failed,
      pendingCount: pending.items.length,
      retried,
      settledCount: settled.items.length,
      stored: window.LingoFlowFavoriteLearningRepository.get(favorite.id)
    };
  }, OWNER);

  expect(result.captured.status).toBe("ready");
  expect(result.failed).toMatchObject({ status: "failed", retryable: true });
  expect(result.pendingCount).toBe(1);
  expect(result.stored.mastered).toBe(true);
  expect(result.retried.status).toBe("applied");
  expect(result.settledCount).toBe(0);
});

test("Learning 先到时保持 pending，Favorite 可用后再正常应用", async ({ page }) => {
  const id = "favorite:pending-learning-reference";
  const remoteLearning = learningState(id, true);
  const remoteFavorite = favorite(id);
  const result = await page.evaluate(async ({ owner, remoteLearning, remoteFavorite }) => {
    window.__remoteLearning(owner.ownerId, remoteLearning);
    const received = await window.__learningSync.pull.receiveOnce(owner);
    const blocked = await window.__learningSync.pull.applyNext(owner);
    const committed = window.LingoFlowFavoriteRepository.commitExactSnapshot({
      entityId: remoteFavorite.id,
      expectedCurrent: null,
      candidate: remoteFavorite
    });
    const applied = await window.__learningSync.pull.applyNext(owner);
    return {
      received,
      blocked,
      committed,
      applied,
      learning: window.LingoFlowFavoriteLearningRepository.get(remoteFavorite.id)
    };
  }, { owner: OWNER, remoteLearning, remoteFavorite });

  expect(result.received.status).toBe("received");
  expect(result.blocked).toEqual({
    status: "blocked",
    reason: "favorite-reference-pending"
  });
  expect(result.committed.status).toBe("committed");
  expect(result.applied.status).toBe("applied");
  expect(result.learning.mastered).toBe(true);
});

test("Favorite tombstone 后旧 Learning 到达不会复活 Favorite", async ({ page }) => {
  const id = "favorite:learning-after-tombstone";
  const tombstone = favorite(id, {
    updatedAt: "2026-09-05T00:02:00.000Z",
    deletedAt: "2026-09-05T00:02:00.000Z"
  });
  const remoteLearning = learningState(id, true);
  const result = await page.evaluate(async ({ owner, tombstone, remoteLearning }) => {
    window.LingoFlowFavoriteRepository.commitExactSnapshot({
      entityId: tombstone.id,
      expectedCurrent: null,
      candidate: tombstone
    });
    window.__remoteLearning(owner.ownerId, remoteLearning);
    await window.__learningSync.pull.receiveOnce(owner);
    const applied = await window.__learningSync.pull.applyNext(owner);
    return {
      applied,
      activeIds: window.LingoFlowFavoriteRepository.list().map(item => item.id),
      stored: window.LingoFlowFavoriteRepository.getById(tombstone.id, {
        includeDeleted: true
      }),
      learning: window.LingoFlowFavoriteLearningRepository.get(tombstone.id)
    };
  }, { owner: OWNER, tombstone, remoteLearning });

  expect(result.applied.status).toBe("applied");
  expect(result.activeIds).not.toContain(tombstone.id);
  expect(result.stored).toEqual(tombstone);
  expect(result.learning.mastered).toBe(true);
});

test("未同步本地 Learning 不会被 remote 静默覆盖", async ({ page }) => {
  const id = "favorite:learning-local-dirty";
  const remoteInitial = learningState(id, true);
  const remoteLater = learningState(id, true, {
    updatedAt: "2026-09-05T00:03:00.000Z"
  });
  const result = await page.evaluate(async ({ owner, id, remoteInitial, remoteLater }) => {
    window.LingoFlowFavoriteRepository.commitExactSnapshot({
      entityId: id,
      expectedCurrent: null,
      candidate: {
        id,
        type: "word",
        text: "local-dirty-learning",
        meaning: "local",
        createdAt: "2026-09-05T00:00:00.000Z",
        updatedAt: "2026-09-05T00:00:00.000Z",
        deletedAt: null
      }
    });
    const first = window.__remoteLearning(owner.ownerId, remoteInitial);
    await window.__learningSync.pull.receiveOnce(owner);
    await window.__learningSync.pull.applyNext(owner);
    const local = await window.LingoFlowSyncFavoriteLearningService.setMastered(
      owner,
      id,
      false
    );
    const remote = window.__remoteLearning(owner.ownerId, remoteLater, {
      baseRevision: first.revision
    });
    await window.__learningSync.pull.receiveOnce(owner);
    const conflict = await window.__learningSync.pull.applyNext(owner);
    const issues = await window.LingoFlowSyncStateRepository.listIssues({
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      entityType: "favoriteLearningStates",
      entityId: id
    });
    return {
      local,
      remote,
      conflict,
      stored: window.LingoFlowFavoriteLearningRepository.get(id),
      issues
    };
  }, { owner: OWNER, id, remoteInitial, remoteLater });

  expect(result.local.status).toBe("ready");
  expect(result.remote.status).toBe("applied");
  expect(result.conflict).toMatchObject({
    status: "conflict",
    reason: "local-mutation-pending"
  });
  expect(result.stored.mastered).toBe(false);
  expect(result.issues.issues).toHaveLength(1);
});

test("Fake cloud 对 Learning 保持 owner isolation", async ({ page }) => {
  const result = await page.evaluate(state => {
    const mutationId = `mutation:${crypto.randomUUID()}`;
    const pushed = window.__learningSync.cloud.push(
      { ownerId: "owner:learning:a" },
      {
        mutationId,
        entityType: "favoriteLearningStates",
        entityId: state.favoriteId,
        scope: "record",
        schemaVersion: "1",
        operation: "put",
        baseRevision: null,
        observedCursor: null,
        payload: state
      }
    );
    return {
      pushed,
      ownerA: window.__learningSync.cloud.pull({ ownerId: "owner:learning:a" }, null),
      ownerB: window.__learningSync.cloud.pull({ ownerId: "owner:learning:b" }, null)
    };
  }, learningState("favorite:owner-isolation", true));

  expect(result.pushed.status).toBe("applied");
  expect(result.ownerA.changes).toHaveLength(1);
  expect(result.ownerB.changes).toHaveLength(0);
});

test("Learning mutation retry 幂等且不增加 revision/cursor/change", async ({ page }) => {
  const result = await page.evaluate(state => {
    const mutation = {
      mutationId: "mutation:learning-idempotent",
      entityType: "favoriteLearningStates",
      entityId: state.favoriteId,
      scope: "record",
      schemaVersion: "1",
      operation: "put",
      baseRevision: null,
      observedCursor: null,
      payload: state
    };
    const first = window.__learningSync.cloud.push({ ownerId: "owner:idempotent" }, mutation);
    const second = window.__learningSync.cloud.push({ ownerId: "owner:idempotent" }, mutation);
    const pulled = window.__learningSync.cloud.pull({ ownerId: "owner:idempotent" }, null);
    return { first, second, pulled };
  }, learningState("favorite:learning-idempotent", true));

  expect(result.first).toEqual(result.second);
  expect(result.pulled.changes).toHaveLength(1);
  expect(result.pulled.nextCursor).toBe(result.first.cursor);
});

test("全新设备一次 Pull 自动恢复 Favorite 与 Learning", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const created = await window.LingoFlowSyncFavoriteService.create(owner, {
      type: "word",
      text: "new-device-learning"
    });
    await window.__drainLearningPush();
    await window.LingoFlowSyncFavoriteLearningService.setMastered(
      owner,
      created.favorite.id,
      true
    );
    await window.__drainLearningPush();
    await window.__resetLearningDevice("binding:learning:new-device");
    const drain = await window.__receiveAndDrainLearning();
    const progress = await window.LingoFlowSyncStateRepository.getPullProgress(
      window.__learningSync.owner
    );
    const inbox = await window.LingoFlowSyncStateRepository.listInbox(
      window.__learningSync.owner
    );
    return {
      drain,
      favorite: window.LingoFlowFavoriteRepository.getById(created.favorite.id),
      learning: window.LingoFlowFavoriteLearningRepository.get(created.favorite.id),
      progress,
      inbox
    };
  }, OWNER);

  expect(result.favorite).not.toBeNull();
  expect(result.learning.mastered).toBe(true);
  expect(result.progress.progress.receivedCursor)
    .toBe(result.progress.progress.appliedCursor);
  expect(result.inbox.items).toHaveLength(0);
});

test("Learning pending 计入统一收藏同步状态并可重试到 synced", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const created = await window.LingoFlowSyncFavoriteService.create(owner, {
      type: "word",
      text: "unified-learning-status"
    });
    await window.__drainLearningPush();
    await window.LingoFlowSyncFavoriteLearningService.setMastered(
      owner,
      created.favorite.id,
      true
    );
    const [outbox, inbox, issues] = await Promise.all([
      window.LingoFlowSyncStateRepository.listOutbox({ ownerId: owner.ownerId }),
      window.LingoFlowSyncStateRepository.listInbox(owner),
      window.LingoFlowSyncStateRepository.listIssues(owner)
    ]);
    window.__learningSync.offline = true;
    const failed = await window.__learningSync.push.runOnce(owner);
    window.__learningSync.offline = false;
    const retried = await window.__learningSync.push.runOnce(owner);
    const settled = await window.LingoFlowSyncStateRepository.listOutbox({
      ownerId: owner.ownerId
    });
    return {
      pendingCount: outbox.items.length + inbox.items.length,
      issueCount: issues.issues.length,
      entityType: outbox.items[0]?.entityType,
      failed,
      retried,
      settledCount: settled.items.length
    };
  }, OWNER);

  expect(result).toMatchObject({
    pendingCount: 1,
    issueCount: 0,
    entityType: "favoriteLearningStates",
    settledCount: 0
  });
  expect(result.failed.status).toBe("failed");
  expect(result.retried.status).toBe("applied");
});
