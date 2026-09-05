const { test, expect } = require("@playwright/test");

const PROJECT_URL = "https://first-device-sync.test.supabase.co";
const OWNER_ID = "11111111-1111-4111-8111-111111111111";

function favorite(id, overrides = {}) {
  return {
    id,
    type: "word",
    text: "remote",
    meaning: "云端收藏",
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    deletedAt: null,
    ...overrides
  };
}

function change(cursor, revision, payload, operation = "put") {
  return {
    cursor: `cursor:${cursor}`,
    entityType: "favorites",
    entityId: payload.id,
    scope: "record",
    schemaVersion: "1",
    revision: `revision:${revision}`,
    operation,
    payload
  };
}

async function installHarness(page, initialChanges = []) {
  await page.route("**/js/supabase-config.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `window.LingoFlowSupabaseConfig = Object.freeze({
      projectUrl: ${JSON.stringify(PROJECT_URL)},
      publishableKey: "sb_publishable_first_device_test",
      sdkUrl: "https://sdk.first-device-sync.test/supabase.js"
    });`
  }));
  await page.addInitScript(({ projectUrl, ownerId, changes }) => {
    localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
    localStorage.setItem("lingoflowSupabaseAuthRequested", "1");
    const session = {
      access_token: "first-device-test-access-token",
      user: { id: ownerId, email: "first-device@example.test" }
    };
    const callbacks = new Set();
    const auth = {
      async getSession() {
        return { data: { session }, error: null };
      },
      async getUser() {
        return { data: { user: session.user }, error: null };
      },
      onAuthStateChange(callback) {
        callbacks.add(callback);
        queueMicrotask(() => callback("INITIAL_SESSION", session));
        return { data: { subscription: { unsubscribe: () => callbacks.delete(callback) } } };
      },
      async signOut() {
        for (const callback of callbacks) callback("SIGNED_OUT", null);
        return { error: null };
      }
    };
    window.supabase = { createClient: () => ({ auth }) };

    const cursorNumber = value => Number(String(value).slice("cursor:".length));
    const revisionNumber = value => Number(String(value).slice("revision:".length));
    const cloud = {
      changes: structuredClone(changes),
      cursor: changes.reduce((max, item) => Math.max(max, cursorNumber(item.cursor)), 0),
      revision: changes.reduce((max, item) => Math.max(max, revisionNumber(item.revision)), 0),
      pullCount: 0,
      pushCount: 0,
      activeRequests: 0,
      maxActiveRequests: 0,
      delayMs: 0,
      failTransport: false,
      conflictPush: false,
      inject(payload, operation = "put") {
        this.cursor += 1;
        this.revision += 1;
        const item = {
          cursor: `cursor:${this.cursor}`,
          entityType: "favorites",
          entityId: payload.id,
          scope: "record",
          schemaVersion: "1",
          revision: `revision:${this.revision}`,
          operation,
          payload: structuredClone(payload)
        };
        this.changes.push(item);
        return item;
      }
    };
    window.__firstDeviceCloud = cloud;
    window.__favoriteSyncStates = [];
    window.addEventListener("lingoflow:favorite-sync-status", event => {
      window.__favoriteSyncStates.push(structuredClone(event.detail));
    });

    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (url, options = {}) => {
      const requestUrl = String(url);
      if (!requestUrl.startsWith(projectUrl)) return await nativeFetch(url, options);
      cloud.activeRequests += 1;
      cloud.maxActiveRequests = Math.max(cloud.maxActiveRequests, cloud.activeRequests);
      try {
        if (cloud.delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, cloud.delayMs));
        }
        if (cloud.failTransport) throw new TypeError("simulated offline");
        const body = JSON.parse(options.body || "{}");
        if (requestUrl.endsWith("/lingoflow_favorite_sync_push")) {
          cloud.pushCount += 1;
          const mutation = body.p_mutation;
          if (cloud.conflictPush) {
            return new Response(JSON.stringify({
              status: "conflict",
              mutationId: mutation.mutationId,
              entityType: mutation.entityType,
              entityId: mutation.entityId,
              scope: mutation.scope,
              schemaVersion: mutation.schemaVersion,
              reason: "revision-mismatch",
              currentRevision: "revision:999",
              currentCursor: "cursor:999",
              currentPayload: { ...mutation.payload, meaning: "云端版本" }
            }), { status: 200, headers: { "Content-Type": "application/json" } });
          }
          const serverChange = cloud.inject(mutation.payload, mutation.operation);
          return new Response(JSON.stringify({
            status: "applied",
            mutationId: mutation.mutationId,
            entityType: mutation.entityType,
            entityId: mutation.entityId,
            scope: mutation.scope,
            schemaVersion: mutation.schemaVersion,
            revision: serverChange.revision,
            cursor: serverChange.cursor
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (requestUrl.endsWith("/lingoflow_favorite_sync_pull")) {
          cloud.pullCount += 1;
          const after = body.p_after_cursor === null ? 0 : cursorNumber(body.p_after_cursor);
          return new Response(JSON.stringify({
            status: "ready",
            changes: cloud.changes.filter(item => cursorNumber(item.cursor) > after),
            nextCursor: `cursor:${cloud.cursor}`
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
      } finally {
        cloud.activeRequests -= 1;
      }
    };
  }, { projectUrl: PROJECT_URL, ownerId: OWNER_ID, changes: initialChanges });
}

async function waitForSyncStatus(page, syncStatus) {
  try {
    await expect.poll(() => page.evaluate(() => (
      window.LingoFlowFavoriteAppSync?.getState().syncStatus
    ))).toBe(syncStatus);
  } catch (error) {
    const state = await page.evaluate(() => {
      const current = window.LingoFlowFavoriteAppSync?.getState?.() || {};
      return {
        status: current.status,
        syncStatus: current.syncStatus,
        reason: current.reason,
        pendingCount: current.pendingCount,
        issueCount: current.issueCount,
        pushedStatus: current.lastSync?.pushed?.status,
        pulledStatus: current.lastSync?.pulled?.status,
        pulledReason: current.lastSync?.pulled?.reason,
        receiveStatus: current.lastSync?.pulled?.received?.status,
        receiveReason: current.lastSync?.pulled?.received?.reason,
        applyStatus: current.lastSync?.pulled?.result?.status,
        applyReason: current.lastSync?.pulled?.result?.reason
      };
    });
    throw new Error(`SYNC_STATUS_DIAGNOSTIC ${JSON.stringify(state)}`, { cause: error });
  }
}

test("全新设备登录后自动 replay 云端 Favorite，并显示同步完成", async ({ page }) => {
  const remote = favorite("favorite:first-device", { text: "ambiguous" });
  await installHarness(page, [change(1, 1, remote)]);
  await page.goto("/");
  await waitForSyncStatus(page, "synced");

  const result = await page.evaluate(async id => {
    const state = window.LingoFlowFavoriteAppSync.getState();
    return {
      state,
      stored: window.LingoFlowFavoriteRepository.getById(id),
      binding: await window.LingoFlowSyncStateRepository.getWorkspaceBinding(),
      progress: await window.LingoFlowSyncStateRepository.getPullProgress({
        ownerId: state.ownerId,
        bindingId: state.bindingId
      }),
      inbox: await window.LingoFlowSyncStateRepository.listInbox({
        ownerId: state.ownerId,
        bindingId: state.bindingId
      })
    };
  }, remote.id);
  expect(result.stored).toEqual(remote);
  expect(result.binding).toMatchObject({ status: "ready", binding: { ownerId: OWNER_ID } });
  expect(result.progress.progress).toMatchObject({
    receivedCursor: "cursor:1",
    appliedCursor: "cursor:1"
  });
  expect(result.inbox).toMatchObject({ status: "ready", items: [] });
  await expect(page.locator("#favoriteSyncStatusBadge")).toHaveText("收藏已同步");
});

test("完整历史按序应用，最终 tombstone 不会在新设备显示为 active", async ({ page }) => {
  const id = "favorite:first-device-tombstone";
  const created = favorite(id, { text: "history", meaning: "初始" });
  const updated = favorite(id, {
    text: "history",
    meaning: "更新后",
    updatedAt: "2026-09-05T00:01:00.000Z"
  });
  const deleted = favorite(id, {
    text: "history",
    meaning: "更新后",
    updatedAt: "2026-09-05T00:02:00.000Z",
    deletedAt: "2026-09-05T00:02:00.000Z"
  });
  await installHarness(page, [
    change(1, 1, created),
    change(2, 2, updated),
    change(3, 3, deleted)
  ]);
  await page.goto("/");
  await waitForSyncStatus(page, "synced");

  const result = await page.evaluate(id => ({
    stored: window.LingoFlowFavoriteRepository.getById(id, { includeDeleted: true }),
    activeIds: window.LingoFlowFavoriteRepository.list().map(item => item.id)
  }), id);
  expect(result.stored).toEqual(deleted);
  expect(result.activeIds).not.toContain(id);
});

test("同步中到已同步可见，且 durable pending 在失败后保留并可点击重试", async ({ page }) => {
  await installHarness(page);
  await page.goto("/");
  await waitForSyncStatus(page, "synced");
  await page.evaluate(() => {
    window.__firstDeviceCloud.delayMs = 120;
    window.__firstDeviceCloud.failTransport = true;
  });
  const created = await page.evaluate(async () => (
    await window.LingoFlowFavoriteAppSync.create({
      type: "word",
      text: "offline-retry",
      meaning: "本地优先"
    })
  ));
  await expect(page.locator("#favoriteSyncStatusBadge")).toHaveText("正在同步收藏…");
  await waitForSyncStatus(page, "unavailable");

  const failed = await page.evaluate(async id => {
    const state = window.LingoFlowFavoriteAppSync.getState();
    return {
      state,
      stored: window.LingoFlowFavoriteRepository.getById(id),
      outbox: await window.LingoFlowSyncStateRepository.listOutbox({ ownerId: state.ownerId }),
      states: window.__favoriteSyncStates.map(item => item.syncStatus).filter(Boolean)
    };
  }, created.favorite.id);
  expect(failed.stored.id).toBe(created.favorite.id);
  expect(failed.outbox.items).toHaveLength(1);
  expect(failed.state.pendingCount).toBe(1);
  expect(failed.states).toContain("pending");
  await expect(page.locator("#favoriteSyncStatusBadge")).toHaveText("同步暂时不可用");

  await page.evaluate(() => {
    window.__firstDeviceCloud.failTransport = false;
    window.__firstDeviceCloud.delayMs = 0;
  });
  await page.click("#accountButton");
  await expect(page.locator("#authSyncNowButton")).toHaveText("重试同步");
  await page.click("#authSyncNowButton");
  await waitForSyncStatus(page, "synced");
  expect(await page.evaluate(async () => {
    const state = window.LingoFlowFavoriteAppSync.getState();
    return (await window.LingoFlowSyncStateRepository.listOutbox({
      ownerId: state.ownerId
    })).items.length;
  })).toBe(0);
});

test("focus 与 visibility 同批唤醒只启动一次同步", async ({ page }) => {
  await installHarness(page);
  await page.goto("/");
  await waitForSyncStatus(page, "synced");
  const remote = favorite("favorite:focus", { text: "focus" });
  const before = await page.evaluate(payload => {
    window.__firstDeviceCloud.inject(payload);
    return window.__firstDeviceCloud.pullCount;
  }, remote);

  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => page.evaluate(() => window.__firstDeviceCloud.pullCount)).toBe(before + 1);
  await waitForSyncStatus(page, "synced");
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => window.__firstDeviceCloud.pullCount)).toBe(before + 1);
  expect(await page.evaluate(id => window.LingoFlowFavoriteRepository.getById(id), remote.id))
    .toEqual(remote);
});

test("unresolved issue 显示需要处理并停止自动重试", async ({ page }) => {
  await installHarness(page);
  await page.goto("/");
  await waitForSyncStatus(page, "synced");
  await page.evaluate(() => { window.__firstDeviceCloud.conflictPush = true; });
  await page.evaluate(async () => {
    await window.LingoFlowFavoriteAppSync.create({
      type: "word",
      text: "conflict",
      meaning: "本地版本"
    });
  });
  await waitForSyncStatus(page, "attention");
  await expect(page.locator("#favoriteSyncStatusBadge")).toHaveText("有收藏需要处理");
  const counts = await page.evaluate(() => ({
    push: window.__firstDeviceCloud.pushCount,
    pull: window.__firstDeviceCloud.pullCount
  }));
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => ({
    push: window.__firstDeviceCloud.pushCount,
    pull: window.__firstDeviceCloud.pullCount
  }))).toEqual(counts);
  expect(await page.evaluate(async () => {
    const state = window.LingoFlowFavoriteAppSync.getState();
    return (await window.LingoFlowSyncStateRepository.listIssues(state)).issues.length;
  })).toBe(1);
});

test("并发 syncNow 共用单一串行循环，不产生并行网络请求", async ({ page }) => {
  await installHarness(page);
  await page.goto("/");
  await waitForSyncStatus(page, "synced");
  const result = await page.evaluate(async () => {
    window.__firstDeviceCloud.delayMs = 80;
    window.__firstDeviceCloud.maxActiveRequests = 0;
    await Promise.all([
      window.LingoFlowFavoriteAppSync.syncNow(),
      window.LingoFlowFavoriteAppSync.syncNow(),
      window.LingoFlowFavoriteAppSync.syncNow()
    ]);
    return {
      maxActiveRequests: window.__firstDeviceCloud.maxActiveRequests,
      state: window.LingoFlowFavoriteAppSync.getState()
    };
  });
  expect(result.maxActiveRequests).toBe(1);
  expect(result.state).toMatchObject({ status: "ready", syncStatus: "synced" });
});
