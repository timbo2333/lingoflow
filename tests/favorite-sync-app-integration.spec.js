const { test, expect } = require("@playwright/test");

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_URL = "https://favorite-app-integration.supabase.co";
const liveConfig = {
  projectUrl: process.env.LINGOFLOW_SUPABASE_URL,
  publishableKey: process.env.LINGOFLOW_SUPABASE_PUBLISHABLE_KEY,
  ownerId: process.env.LINGOFLOW_SUPABASE_OWNER_ID,
  accessToken: process.env.LINGOFLOW_SUPABASE_ACCESS_TOKEN
};
const liveConfigured = Object.values(liveConfig).every(Boolean);

async function readSafeAppSyncDiagnostic(page) {
  return await page.evaluate(async () => {
    const coordinator = window.LingoFlowFavoriteAppSync;
    const state = coordinator?.getState?.() || {};
    const config = window.LingoFlowSupabaseDevConfig;
    const isReadyString = value => (
      typeof value === "string" && Boolean(value.trim()) && value === value.trim()
    );
    let accessTokenReady = false;
    if (typeof config?.getAccessToken === "function") {
      try {
        accessTokenReady = isReadyString(await config.getAccessToken());
      } catch (_error) {
        accessTokenReady = false;
      }
    }
    const authFailureReasons = new Set([
      "access-token-unavailable",
      "auth-network-unavailable",
      "auth-session-unavailable",
      "auth-session-invalid"
    ]);
    return {
      status: typeof state.status === "string" ? state.status : "missing",
      reason: typeof state.reason === "string" ? state.reason : "none",
      configPresent: Boolean(config),
      configReady: Boolean(
        isReadyString(config?.projectUrl) &&
        isReadyString(config?.publishableKey) &&
        typeof config?.getAccessToken === "function"
      ),
      authReady: accessTokenReady && !authFailureReasons.has(state.reason),
      ownerReady: isReadyString(state.ownerId),
      errorPresent: typeof state.message === "string" && Boolean(state.message)
    };
  });
}

async function waitForSyncState(page, expected, options = {}) {
  try {
    await expect.poll(() => page.evaluate(() => (
      window.LingoFlowFavoriteAppSync?.getState().status
    ))).toBe(expected);
  } catch (error) {
    if (!options.diagnose) throw error;
    const diagnostic = await readSafeAppSyncDiagnostic(page);
    throw new Error([
      "APP_SYNC_INACTIVE",
      `status=${diagnostic.status}`,
      `reason=${diagnostic.reason}`,
      `configPresent=${diagnostic.configPresent}`,
      `configReady=${diagnostic.configReady}`,
      `authReady=${diagnostic.authReady}`,
      `ownerReady=${diagnostic.ownerReady}`,
      `errorPresent=${diagnostic.errorPresent}`
    ].join("\n"), { cause: error });
  }
}

test("页面五个 Favorite writer 全部经过 App Sync boundary", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const repository = window.LingoFlowFavoriteRepository;
    const calls = [];
    window.LingoFlowFavoriteAppSync = {
      create: async input => {
        calls.push("create");
        return { status: "ready", favorite: repository.create(input) };
      },
      update: async (id, patch) => {
        calls.push("update");
        return { status: "ready", favorite: repository.update(id, patch) };
      },
      softDelete: async id => {
        calls.push("softDelete");
        return { status: "ready", favorite: repository.softDelete(id) };
      }
    };
    window.confirm = () => true;

    currentLookupState = {
      word: "Ambiguous",
      result: { baseWord: "ambiguous", meaning: "有歧义的" },
      sentence: "The wording is ambiguous.",
      source: "search"
    };
    const word = await saveCurrentFavorite();
    const phraseResult = await savePhraseFavorite({
      text: "make progress",
      context: "Learners make progress."
    });
    const phrase = repository.findByContent({ type: "phrase", text: "make progress" })[0];

    renderFavorites();
    const wordCard = document.querySelector(`[data-favorite-id="${word.id}"]`);
    wordCard.querySelector(".meaningEditor").value = "updated meaning";
    await saveFavoriteEdit(word.id, wordCard.querySelector("button[onclick^='saveFavoriteEdit']"));
    await toggleCurrentFavorite();
    await removeFavorite(phrase.id);

    return {
      calls,
      phraseResult,
      word: repository.getById(word.id, { includeDeleted: true }),
      phrase: repository.getById(phrase.id, { includeDeleted: true })
    };
  });

  expect(result.calls).toEqual([
    "create",
    "create",
    "update",
    "softDelete",
    "softDelete"
  ]);
  expect(result.phraseResult).toMatchObject({ saved: true, existed: false });
  expect(result.word.meaning).toBe("updated meaning");
  expect(result.word.deletedAt).not.toBeNull();
  expect(result.phrase.deletedAt).not.toBeNull();
});

test("无配置保持 local-only，且不创建 Sync workspace/outbox", async ({ page }) => {
  await page.goto("/");
  await waitForSyncState(page, "inactive");
  const result = await page.evaluate(async () => {
    currentLookupState = {
      word: "Local",
      result: { baseWord: "local", meaning: "本地的" },
      sentence: "Local data remains available.",
      source: "search"
    };
    const favorite = await saveCurrentFavorite();
    return {
      favorite,
      stored: window.LingoFlowFavoriteRepository.getById(favorite.id),
      binding: await window.LingoFlowSyncStateRepository.getWorkspaceBinding(),
      outbox: await window.LingoFlowSyncStateRepository.listOutbox({
        ownerId: "11111111-1111-4111-8111-111111111111"
      })
    };
  });

  expect(result.stored).toEqual(result.favorite);
  expect(result.binding).toEqual({ status: "missing", binding: null });
  expect(result.outbox).toMatchObject({ status: "ready", items: [] });
});

test("配置后离线写入保留 outbox，重载恢复 Push，并能 Pull/Apply", async ({ page }) => {
  await page.route("**/js/supabase-config.local.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `window.LingoFlowSupabaseDevConfig = Object.freeze({
      projectUrl: ${JSON.stringify(PROJECT_URL)},
      publishableKey: "sb_publishable_integration_test",
      expectedOwnerId: ${JSON.stringify(OWNER_ID)},
      async getAccessToken() { return "integration-user-jwt"; }
    });`
  }));
  await page.addInitScript(({ ownerId, projectUrl }) => {
    const nativeFetch = window.fetch.bind(window);
    const cloud = {
      offline: sessionStorage.getItem("favorite-app-cloud-offline") === "1",
      revision: 0,
      cursor: 0,
      pushCount: 0,
      pullCount: 0,
      changes: [],
      inject(payload) {
        this.revision += 1;
        this.cursor += 1;
        this.changes.push({
          cursor: `cursor:${this.cursor}`,
          entityType: "favorites",
          entityId: payload.id,
          scope: "record",
          schemaVersion: "1",
          revision: `revision:${this.revision}`,
          operation: "put",
          payload: structuredClone(payload)
        });
      }
    };
    window.__favoriteAppCloud = cloud;
    window.fetch = async (url, options = {}) => {
      const requestUrl = String(url);
      if (!requestUrl.startsWith(projectUrl)) return await nativeFetch(url, options);
      if (cloud.offline) throw new TypeError("simulated offline");
      if (requestUrl.endsWith("/auth/v1/user")) {
        return new Response(JSON.stringify({ id: ownerId }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      const body = JSON.parse(options.body || "{}");
      if (requestUrl.endsWith("/lingoflow_favorite_sync_push")) {
        const mutation = body.p_mutation;
        cloud.pushCount += 1;
        cloud.inject(mutation.payload);
        return new Response(JSON.stringify({
          status: "applied",
          mutationId: mutation.mutationId,
          entityType: mutation.entityType,
          entityId: mutation.entityId,
          scope: mutation.scope,
          schemaVersion: mutation.schemaVersion,
          revision: `revision:${cloud.revision}`,
          cursor: `cursor:${cloud.cursor}`
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (requestUrl.endsWith("/lingoflow_favorite_sync_pull")) {
        cloud.pullCount += 1;
        const after = body.p_after_cursor === null
          ? 0
          : Number(String(body.p_after_cursor).slice("cursor:".length));
        return new Response(JSON.stringify({
          status: "ready",
          changes: cloud.changes.filter(change => Number(change.cursor.slice(7)) > after),
          nextCursor: `cursor:${cloud.cursor}`
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    };
  }, { ownerId: OWNER_ID, projectUrl: PROJECT_URL });

  await page.goto("/?supabase-sync=dev");
  await waitForSyncState(page, "ready");
  const offlineCreated = await page.evaluate(async () => {
    sessionStorage.setItem("favorite-app-cloud-offline", "1");
    window.__favoriteAppCloud.offline = true;
    currentLookupState = {
      word: "Offline",
      result: { baseWord: "offline", meaning: "离线的" },
      sentence: "Offline work remains local-first.",
      source: "search"
    };
    return await saveCurrentFavorite();
  });
  await expect.poll(() => page.evaluate(async () => (
    (await window.LingoFlowSyncStateRepository.listOutbox({
      ownerId: "11111111-1111-4111-8111-111111111111"
    })).items.length
  ))).toBe(1);
  expect(await page.evaluate(id => window.LingoFlowFavoriteRepository.getById(id), offlineCreated.id))
    .toEqual(offlineCreated);

  await page.evaluate(() => sessionStorage.setItem("favorite-app-cloud-offline", "0"));
  await page.reload();
  await waitForSyncState(page, "ready");
  await expect.poll(() => page.evaluate(() => window.__favoriteAppCloud.pushCount)).toBe(1);
  await expect.poll(() => page.evaluate(async () => (
    (await window.LingoFlowSyncStateRepository.listOutbox({
      ownerId: "11111111-1111-4111-8111-111111111111"
    })).items.length
  ))).toBe(0);

  const remote = {
    id: "favorite:remote-app-integration",
    type: "word",
    text: "remote",
    meaning: "来自 Supabase",
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    deletedAt: null
  };
  const pulled = await page.evaluate(async favorite => {
    window.__favoriteAppCloud.inject(favorite);
    const syncResult = await window.LingoFlowFavoriteAppSync.syncNow();
    return {
      syncResult,
      favorite: window.LingoFlowFavoriteRepository.getById(favorite.id),
      badge: document.getElementById("favoriteCountBadge")?.textContent || ""
    };
  }, remote);

  expect(pulled.syncResult.status).toBe("completed");
  expect(pulled.favorite).toEqual(remote);
  expect(pulled.badge).toBe("(2)");
});

async function bootLiveAppPage(page) {
  await page.addInitScript(config => {
    localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
    window.LingoFlowSupabaseDevConfig = Object.freeze({
      projectUrl: config.projectUrl,
      publishableKey: config.publishableKey,
      expectedOwnerId: config.ownerId,
      async getAccessToken() {
        return config.accessToken;
      }
    });
  }, liveConfig);
  await page.goto("/");
  await waitForSyncState(page, "ready", { diagnose: true });
  await page.evaluate(() => window.LingoFlowFavoriteAppSync.syncNow());
}

async function editFavoriteThroughPage(page, favoriteId, meaning) {
  return await page.evaluate(async ({ favoriteId, meaning }) => {
    renderFavorites();
    const card = document.querySelector(`[data-favorite-id="${favoriteId}"]`);
    if (!card) throw new Error("Favorite card missing");
    card.querySelector(".meaningEditor").value = meaning;
    const button = card.querySelector("button[onclick^='saveFavoriteEdit']");
    await saveFavoriteEdit(favoriteId, button);
    return window.LingoFlowFavoriteRepository.getById(favoriteId, { includeDeleted: true });
  }, { favoriteId, meaning });
}

test("LIVE：正常页面 Favorite writer → Supabase → 正常页面 Pull/Apply", async ({ browser }) => {
  test.skip(!liveConfigured, "需要 LINGOFLOW_SUPABASE_* Dev 配置。");
  test.setTimeout(120_000);

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  try {
    await bootLiveAppPage(pageA);
    await bootLiveAppPage(pageB);

    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const created = await pageA.evaluate(async text => {
      currentLookupState = {
        word: text,
        result: { baseWord: text, meaning: "app live create" },
        sentence: "The normal page created this Favorite.",
        source: "search"
      };
      const favorite = await saveCurrentFavorite();
      const synced = await window.LingoFlowFavoriteAppSync.syncNow();
      return { favorite, synced };
    }, `app-live-${unique}`);
    expect(created.synced.status).toBe("completed");

    await pageB.evaluate(() => window.LingoFlowFavoriteAppSync.syncNow());
    expect(await pageB.evaluate(id => (
      window.LingoFlowFavoriteRepository.getById(id, { includeDeleted: true })
    ), created.favorite.id)).toEqual(created.favorite);

    const updated = await editFavoriteThroughPage(
      pageA,
      created.favorite.id,
      "app live update"
    );
    await pageA.evaluate(() => window.LingoFlowFavoriteAppSync.syncNow());
    await pageB.evaluate(() => window.LingoFlowFavoriteAppSync.syncNow());
    expect(await pageB.evaluate(id => (
      window.LingoFlowFavoriteRepository.getById(id).meaning
    ), created.favorite.id)).toBe(updated.meaning);

    await pageA.evaluate(async id => {
      window.confirm = () => true;
      await removeFavorite(id);
      await window.LingoFlowFavoriteAppSync.syncNow();
    }, created.favorite.id);
    await pageB.evaluate(() => window.LingoFlowFavoriteAppSync.syncNow());
    expect(await pageB.evaluate(id => (
      window.LingoFlowFavoriteRepository.getById(id, { includeDeleted: true }).deletedAt
    ), created.favorite.id)).not.toBeNull();

    const dirtyCreated = await pageA.evaluate(async text => {
      currentLookupState = {
        word: text,
        result: { baseWord: text, meaning: "shared baseline" },
        sentence: "This Favorite checks local dirty protection.",
        source: "search"
      };
      const favorite = await saveCurrentFavorite();
      await window.LingoFlowFavoriteAppSync.syncNow();
      return favorite;
    }, `app-dirty-${unique}`);
    await pageB.evaluate(() => window.LingoFlowFavoriteAppSync.syncNow());

    await contextB.setOffline(true);
    await editFavoriteThroughPage(pageB, dirtyCreated.id, "B unsynced local");
    await editFavoriteThroughPage(pageA, dirtyCreated.id, "A remote update");
    await pageA.evaluate(() => window.LingoFlowFavoriteAppSync.syncNow());
    await contextB.setOffline(false);
    await pageB.evaluate(() => window.LingoFlowFavoriteAppSync.syncNow());

    expect(await pageB.evaluate(id => (
      window.LingoFlowFavoriteRepository.getById(id).meaning
    ), dirtyCreated.id)).toBe("B unsynced local");
    expect(await pageB.evaluate(async id => (
      await window.LingoFlowSyncStateRepository.listIssues({
        ownerId: window.LingoFlowFavoriteAppSync.getState().ownerId,
        bindingId: window.LingoFlowFavoriteAppSync.getState().bindingId,
        entityId: id
      })
    ), dirtyCreated.id)).toMatchObject({
      status: "ready",
      issues: expect.arrayContaining([expect.objectContaining({ entityId: dirtyCreated.id })])
    });
  } finally {
    await contextA.close();
    await contextB.close();
  }
});
