const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_URL = "https://project-ref.supabase.co";
const PUBLISHABLE_KEY = "sb_publishable_test_key";
const ACCESS_TOKEN = "test-user-jwt";

function makeFavorite(id, overrides = {}) {
  return {
    id,
    type: "word",
    text: "ambiguous",
    meaning: "having more than one interpretation",
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    deletedAt: null,
    ...overrides
  };
}

function makeMutation(favorite, overrides = {}) {
  return {
    mutationId: "mutation:supabase:1",
    entityType: "favorites",
    entityId: favorite.id,
    scope: "record",
    schemaVersion: "1",
    operation: "put",
    baseRevision: null,
    observedCursor: null,
    payload: favorite,
    ...overrides
  };
}

function makeLearningMutation(favoriteId, mastered = true, overrides = {}) {
  const payload = {
    favoriteId,
    mastered,
    createdAt: "2026-09-04T00:01:00.000Z",
    updatedAt: "2026-09-04T00:01:00.000Z",
    deletedAt: null
  };
  return {
    mutationId: "mutation:supabase:learning:1",
    entityType: "favoriteLearningStates",
    entityId: favoriteId,
    scope: "record",
    schemaVersion: "1",
    operation: "put",
    baseRevision: null,
    observedCursor: null,
    payload,
    ...overrides
  };
}

async function loadAdapter(page) {
  await page.goto("/");
  await page.addScriptTag({ url: "/js/sync-canonical.js" });
  await page.addScriptTag({ url: "/js/cloud-sync-protocol.js" });
  await page.addScriptTag({ url: "/js/supabase-sync-service.js" });
}

test.beforeEach(async ({ page }) => {
  await loadAdapter(page);
});

test("Supabase Adapter push 保持现有 API，并只通过 RPC 传递 expected owner", async ({ page }) => {
  const favorite = makeFavorite("favorite:supabase-push");
  const mutation = makeMutation(favorite);
  const result = await page.evaluate(async ({ ownerId, projectUrl, key, token, mutation }) => {
    const calls = [];
    const expected = {
      status: "applied",
      mutationId: mutation.mutationId,
      entityType: mutation.entityType,
      entityId: mutation.entityId,
      scope: mutation.scope,
      schemaVersion: mutation.schemaVersion,
      revision: "revision:1",
      cursor: "cursor:1"
    };
    const adapter = window.LingoFlowSupabaseSyncService.create({
      projectUrl,
      publishableKey: key,
      getAccessToken: async context => {
        calls.push({ tokenContext: context });
        return token;
      },
      fetchImpl: async (url, options) => {
        calls.push({ url, options: structuredClone(options) });
        return { ok: true, status: 200, json: async () => structuredClone(expected) };
      }
    });
    const output = await adapter.push({ ownerId }, mutation);
    return { output, calls };
  }, {
    ownerId: OWNER_ID,
    projectUrl: PROJECT_URL,
    key: PUBLISHABLE_KEY,
    token: ACCESS_TOKEN,
    mutation
  });

  expect(result.output).toMatchObject({ status: "applied", revision: "revision:1" });
  expect(result.calls[0]).toEqual({ tokenContext: { ownerId: OWNER_ID } });
  expect(result.calls[1].url).toBe(
    `${PROJECT_URL}/rest/v1/rpc/lingoflow_favorite_sync_push`
  );
  expect(result.calls[1].options.method).toBe("POST");
  expect(result.calls[1].options.headers).toMatchObject({
    apikey: PUBLISHABLE_KEY,
    Authorization: `Bearer ${ACCESS_TOKEN}`,
    "Content-Type": "application/json"
  });
  const body = JSON.parse(result.calls[1].options.body);
  expect(body).toEqual({ p_expected_owner_id: OWNER_ID, p_mutation: mutation });
  expect(body.p_mutation.ownerId).toBeUndefined();
});

test("Supabase Adapter pull 保持 opaque cursor 和 validatePullResult 合同", async ({ page }) => {
  const favorite = makeFavorite("favorite:supabase-pull");
  const change = {
    cursor: "cursor:12",
    entityType: "favorites",
    entityId: favorite.id,
    scope: "record",
    schemaVersion: "1",
    revision: "revision:2",
    operation: "put",
    payload: favorite
  };
  const result = await page.evaluate(async ({ ownerId, projectUrl, key, token, change }) => {
    const calls = [];
    const adapter = window.LingoFlowSupabaseSyncService.create({
      projectUrl,
      publishableKey: key,
      getAccessToken: async () => token,
      fetchImpl: async (url, options) => {
        calls.push({ url, options: structuredClone(options) });
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: "ready", changes: [change], nextCursor: change.cursor })
        };
      }
    });
    return {
      output: await adapter.pull({ ownerId }, "cursor:7"),
      calls
    };
  }, {
    ownerId: OWNER_ID,
    projectUrl: PROJECT_URL,
    key: PUBLISHABLE_KEY,
    token: ACCESS_TOKEN,
    change
  });

  expect(result.output).toEqual({ status: "ready", changes: [change], nextCursor: "cursor:12" });
  expect(result.calls[0].url).toBe(
    `${PROJECT_URL}/rest/v1/rpc/lingoflow_favorite_sync_pull`
  );
  expect(JSON.parse(result.calls[0].options.body)).toEqual({
    p_expected_owner_id: OWNER_ID,
    p_after_cursor: "cursor:7"
  });
});

test("Supabase Adapter 将 Learning push 路由到专用 authenticated RPC", async ({ page }) => {
  const mutation = makeLearningMutation("favorite:supabase-learning");
  const result = await page.evaluate(async ({ ownerId, projectUrl, key, token, mutation }) => {
    const calls = [];
    const adapter = window.LingoFlowSupabaseSyncService.create({
      projectUrl,
      publishableKey: key,
      getAccessToken: async () => token,
      fetchImpl: async (url, options) => {
        calls.push({ url, options: structuredClone(options) });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "applied",
            mutationId: mutation.mutationId,
            entityType: mutation.entityType,
            entityId: mutation.entityId,
            scope: mutation.scope,
            schemaVersion: mutation.schemaVersion,
            revision: "revision:1",
            cursor: "cursor:2"
          })
        };
      }
    });
    return {
      output: await adapter.push({ ownerId }, mutation),
      calls
    };
  }, {
    ownerId: OWNER_ID,
    projectUrl: PROJECT_URL,
    key: PUBLISHABLE_KEY,
    token: ACCESS_TOKEN,
    mutation
  });

  expect(result.output).toMatchObject({
    status: "applied",
    entityType: "favoriteLearningStates"
  });
  expect(result.calls[0].url).toBe(
    `${PROJECT_URL}/rest/v1/rpc/lingoflow_favorite_learning_sync_push`
  );
  expect(JSON.parse(result.calls[0].options.body)).toEqual({
    p_expected_owner_id: OWNER_ID,
    p_mutation: mutation
  });
});

test("非法 owner/mutation/cursor 在网络前 formal rejected", async ({ page }) => {
  const favorite = makeFavorite("favorite:supabase-invalid");
  const mutation = makeMutation(favorite);
  const result = await page.evaluate(async ({ projectUrl, key, token, mutation }) => {
    let calls = 0;
    const adapter = window.LingoFlowSupabaseSyncService.create({
      projectUrl,
      publishableKey: key,
      getAccessToken: async () => token,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("network must not run");
      }
    });
    return {
      owner: await adapter.push({ ownerId: "" }, mutation),
      mutation: await adapter.push({ ownerId: "owner:valid" }, {
        ...mutation,
        entityType: "articles"
      }),
      cursor: await adapter.pull({ ownerId: "owner:valid" }, " cursor:1"),
      calls
    };
  }, { projectUrl: PROJECT_URL, key: PUBLISHABLE_KEY, token: ACCESS_TOKEN, mutation });

  expect(result.owner).toMatchObject({ status: "rejected", reason: "invalid-owner-context" });
  expect(result.mutation).toMatchObject({ status: "rejected", reason: "unsupported-entity" });
  expect(result.cursor).toEqual({
    status: "rejected",
    changes: [],
    nextCursor: null,
    reason: "invalid-cursor"
  });
  expect(result.calls).toBe(0);
});

test("HTTP、JSON 和 protocol result failure 不伪装成业务结果", async ({ page }) => {
  const favorite = makeFavorite("favorite:supabase-failure");
  const mutation = makeMutation(favorite);
  const messages = await page.evaluate(async ({ ownerId, projectUrl, key, token, mutation }) => {
    async function capture(fetchImpl) {
      const adapter = window.LingoFlowSupabaseSyncService.create({
        projectUrl,
        publishableKey: key,
        getAccessToken: async () => token,
        fetchImpl
      });
      try {
        await adapter.push({ ownerId }, mutation);
        return null;
      } catch (error) {
        return error.message;
      }
    }
    return [
      await capture(async () => ({ ok: false, status: 401, json: async () => ({}) })),
      await capture(async () => ({
        ok: true,
        status: 200,
        json: async () => { throw new Error("bad json"); }
      })),
      await capture(async () => ({ ok: true, status: 200, json: async () => ({ status: "applied" }) }))
    ];
  }, {
    ownerId: OWNER_ID,
    projectUrl: PROJECT_URL,
    key: PUBLISHABLE_KEY,
    token: ACCESS_TOKEN,
    mutation
  });

  expect(messages[0]).toContain("RPC failed (401)");
  expect(messages[1]).toContain("非法 JSON");
  expect(messages[2]).toContain("非法 protocol result");
});

test("Push result identity mismatch 被 Adapter 阻断", async ({ page }) => {
  const favorite = makeFavorite("favorite:supabase-identity");
  const mutation = makeMutation(favorite);
  const message = await page.evaluate(async ({ ownerId, projectUrl, key, token, mutation }) => {
    const adapter = window.LingoFlowSupabaseSyncService.create({
      projectUrl,
      publishableKey: key,
      getAccessToken: async () => token,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          status: "applied",
          mutationId: "mutation:wrong",
          entityType: "favorites",
          entityId: mutation.entityId,
          scope: "record",
          schemaVersion: "1",
          revision: "revision:1",
          cursor: "cursor:1"
        })
      })
    });
    try {
      await adapter.push({ ownerId }, mutation);
      return null;
    } catch (error) {
      return error.message;
    }
  }, {
    ownerId: OWNER_ID,
    projectUrl: PROJECT_URL,
    key: PUBLISHABLE_KEY,
    token: ACCESS_TOKEN,
    mutation
  });
  expect(message).toContain("identity 不一致");
});

test("Supabase migration 锁定三表、server ordering、RLS 和 authenticated-only RPC", () => {
  const migration = fs.readFileSync(path.join(
    __dirname,
    "../supabase/migrations/20260904000000_favorite_sync_dev.sql"
  ), "utf8");

  expect(migration).toContain("create table public.favorite_sync_records");
  expect(migration).toContain("create table public.favorite_sync_changes");
  expect(migration).toContain("create table public.favorite_sync_mutations");
  expect(migration).toContain("cursor bigint generated always as identity primary key");
  expect(migration).toContain("primary key (owner_id, mutation_id)");
  expect(migration.match(/enable row level security/g)).toHaveLength(3);
  expect(migration).toContain("owner_id = (select auth.uid())");
  expect(migration).toContain("revoke all on public.favorite_sync_records from anon, authenticated");
  expect(migration).toContain("security definer\nset search_path = ''");
  expect(migration).toContain("grant execute on function public.lingoflow_favorite_sync_push");
  expect(migration).toContain("grant execute on function public.lingoflow_favorite_sync_pull");
  expect(migration).toContain("'reason', 'idempotency-key-reused'");
  expect(migration).toContain("'reason', 'explicit-restore-required'");
});

test("Learning migration 复用全局 change/receipt，并锁定 RLS、依赖与 RPC", () => {
  const migration = fs.readFileSync(path.join(
    __dirname,
    "../supabase/migrations/20260905180000_add_favorite_learning_sync.sql"
  ), "utf8");

  expect(migration).toContain("add column entity_type text not null default 'favorites'");
  expect(migration).toContain("create table public.favorite_learning_sync_records");
  expect(migration).toContain("alter table public.favorite_learning_sync_records enable row level security");
  expect(migration).toContain("owner_id = (select auth.uid())");
  expect(migration).toContain("from public.favorite_sync_mutations");
  expect(migration).toContain("insert into public.favorite_sync_changes");
  expect(migration).toContain("from public.favorite_sync_records");
  expect(migration).toContain("'reason', 'favorite-reference-deleted'");
  expect(migration).toContain("security definer\nset search_path = ''");
  expect(migration).toContain(
    "grant execute on function public.lingoflow_favorite_learning_sync_push"
  );
  expect(migration).not.toMatch(/pg_catalog\.coalesce\s*\(/);
});

const liveConfig = {
  projectUrl: process.env.LINGOFLOW_SUPABASE_URL,
  publishableKey: process.env.LINGOFLOW_SUPABASE_PUBLISHABLE_KEY,
  ownerId: process.env.LINGOFLOW_SUPABASE_OWNER_ID,
  accessToken: process.env.LINGOFLOW_SUPABASE_ACCESS_TOKEN
};
const liveConfigured = Object.values(liveConfig).every(Boolean);

async function readSanitizedSupabaseError(response) {
  const allowedFields = ["code", "message", "details", "hint", "error", "error_description"];
  const secrets = [liveConfig.accessToken, liveConfig.publishableKey].filter(Boolean);
  let body;
  try {
    body = await response.json();
  } catch (_error) {
    return { message: "non-json response body omitted" };
  }
  const sanitized = {};
  for (const field of allowedFields) {
    if (typeof body?.[field] !== "string") continue;
    let value = body[field];
    for (const secret of secrets) value = value.split(secret).join("[REDACTED]");
    value = value
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
      .replace(/\bsb_(?:publishable|secret)_[A-Za-z0-9_-]+\b/g, "[REDACTED_KEY]");
    sanitized[field] = value.slice(0, 1000);
  }
  return Object.keys(sanitized).length > 0
    ? sanitized
    : { message: "response body contained no diagnostic fields" };
}

async function verifyLiveAuthBoundary() {
  const authHeaders = {
    apikey: liveConfig.publishableKey,
    Authorization: `Bearer ${liveConfig.accessToken}`
  };
  const userResponse = await fetch(`${liveConfig.projectUrl}/auth/v1/user`, {
    headers: authHeaders
  });
  expect(userResponse.ok).toBe(true);
  const user = await userResponse.json();
  expect(user.id).toBe(liveConfig.ownerId);

  const rpcUrl = `${liveConfig.projectUrl}/rest/v1/rpc/lingoflow_favorite_sync_pull`;
  const rpcBody = JSON.stringify({
    p_expected_owner_id: liveConfig.ownerId,
    p_after_cursor: null
  });
  const anonymousResponse = await fetch(rpcUrl, {
    method: "POST",
    headers: {
      apikey: liveConfig.publishableKey,
      "Content-Type": "application/json"
    },
    body: rpcBody
  });
  expect(anonymousResponse.ok).toBe(false);

  const authenticatedResponse = await fetch(rpcUrl, {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": "application/json"
    },
    body: rpcBody
  });
  if (!authenticatedResponse.ok) {
    const diagnostic = await readSanitizedSupabaseError(authenticatedResponse);
    throw new Error([
      "AUTH_RPC_FAILED",
      `status=${authenticatedResponse.status}`,
      `statusText=${authenticatedResponse.statusText}`,
      `body=${JSON.stringify(diagnostic)}`
    ].join("\n"));
  }
  expect(await authenticatedResponse.json()).toMatchObject({
    status: "ready",
    changes: expect.any(Array)
  });
}

async function bootLiveClient(page, bindingId) {
  await page.addInitScript(() => {
    localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
  });
  await page.goto("/");
  for (const script of [
    "sync-canonical.js",
    "cloud-sync-protocol.js",
    "sync-state-repository.js",
    "sync-favorite-service.js",
    "sync-favorite-push-worker.js",
    "sync-favorite-pull-worker.js",
    "supabase-sync-service.js"
  ]) {
    await page.addScriptTag({ url: `/js/${script}` });
  }
  await page.evaluate(async ({ config, bindingId }) => {
    const owner = { ownerId: config.ownerId, bindingId };
    const adapter = window.LingoFlowSupabaseSyncService.create({
      projectUrl: config.projectUrl,
      publishableKey: config.publishableKey,
      getAccessToken: async () => config.accessToken
    });
    await window.LingoFlowSyncFavoriteService.bindWorkspace(owner);
    window.__liveSync = {
      owner,
      adapter,
      push: window.LingoFlowSyncFavoritePushWorker.create({ push: adapter.push }),
      pull: window.LingoFlowSyncFavoritePullWorker.create({ pull: adapter.pull })
    };
  }, { config: liveConfig, bindingId });
}

async function receiveAndDrain(page) {
  return await page.evaluate(async () => {
    const sync = window.__liveSync;
    const received = await sync.pull.receiveOnce(sync.owner);
    const applied = [];
    for (let index = 0; index < 500; index += 1) {
      const outcome = await sync.pull.applyNext(sync.owner);
      if (outcome.status === "idle") return { received, applied };
      applied.push(outcome);
      if (!["applied", "unchanged", "conflict"].includes(outcome.status)) {
        return { received, applied };
      }
    }
    throw new Error("Live Pull Inbox 未在限制内清空。");
  });
}

test("LIVE：Browser A → Supabase → Browser B 主链路/update/tombstone/local dirty", async ({ browser }) => {
  test.skip(!liveConfigured, "需要 LINGOFLOW_SUPABASE_* Dev 配置并先应用 migration。");
  test.setTimeout(120_000);
  await verifyLiveAuthBoundary();
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  try {
    await bootLiveClient(pageA, `binding:live:a:${Date.now()}`);
    await bootLiveClient(pageB, `binding:live:b:${Date.now()}`);

    const created = await pageA.evaluate(async () => {
      const sync = window.__liveSync;
      const capture = await window.LingoFlowSyncFavoriteService.create(sync.owner, {
        type: "word",
        text: "ambiguous",
        meaning: "live cloud create"
      });
      const pushed = await sync.push.runOnce(sync.owner);
      return { capture, pushed };
    });
    expect(created.capture.status).toBe("ready");
    expect(created.pushed.status).toBe("applied");
    const favoriteId = created.capture.favorite.id;

    await receiveAndDrain(pageB);
    expect(await pageB.evaluate(id => (
      window.LingoFlowFavoriteRepository.getById(id, { includeDeleted: true })
    ), favoriteId)).toEqual(created.capture.favorite);

    const updated = await pageA.evaluate(async id => {
      const sync = window.__liveSync;
      const capture = await window.LingoFlowSyncFavoriteService.update(sync.owner, id, {
        meaning: "live cloud update",
        note: "A updated"
      });
      return { capture, pushed: await sync.push.runOnce(sync.owner) };
    }, favoriteId);
    expect(updated.pushed.status).toBe("applied");
    await receiveAndDrain(pageB);
    expect(await pageB.evaluate(id => window.LingoFlowFavoriteRepository.getById(id).meaning, favoriteId))
      .toBe("live cloud update");

    const deleted = await pageA.evaluate(async id => {
      const sync = window.__liveSync;
      const capture = await window.LingoFlowSyncFavoriteService.softDelete(sync.owner, id);
      return { capture, pushed: await sync.push.runOnce(sync.owner) };
    }, favoriteId);
    expect(deleted.pushed.status).toBe("applied");
    await receiveAndDrain(pageB);
    expect(await pageB.evaluate(id => (
      window.LingoFlowFavoriteRepository.getById(id, { includeDeleted: true }).deletedAt
    ), favoriteId)).not.toBeNull();

    await pageB.evaluate(async id => {
      const sync = window.__liveSync;
      await window.LingoFlowSyncFavoriteService.restore(sync.owner, id);
      await window.LingoFlowSyncFavoriteService.update(sync.owner, id, {
        meaning: "B unsynced local"
      });
    }, favoriteId);
    const remoteRestore = await pageA.evaluate(async id => {
      const sync = window.__liveSync;
      await window.LingoFlowSyncFavoriteService.restore(sync.owner, id);
      await window.LingoFlowSyncFavoriteService.update(sync.owner, id, {
        meaning: "A remote restore"
      });
      return await sync.push.runOnce(sync.owner);
    }, favoriteId);
    expect(remoteRestore.status).toBe("applied");
    const dirtyPull = await receiveAndDrain(pageB);
    expect(dirtyPull.applied.some(value => value.status === "conflict")).toBe(true);
    expect(await pageB.evaluate(id => window.LingoFlowFavoriteRepository.getById(id).meaning, favoriteId))
      .toBe("B unsynced local");
  } finally {
    await contextA.close();
    await contextB.close();
  }
});
