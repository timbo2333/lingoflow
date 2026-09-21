const { test, expect } = require("@playwright/test");

const OWNER = { ownerId: "11111111-1111-4111-8111-111111111111", bindingId: "binding:article-cloud" };
const PROJECT_URL = "https://article-project.supabase.co";
const KEY = "sb_publishable_article_test";

function projection(id = "article:cloud:test", overrides = {}) {
  return {
    id, title: "Cloud Article", content: "Initial content", sourceType: "paste",
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z", deletedAt: null,
    ...overrides
  };
}

function readyMutation(candidate = projection(), overrides = {}) {
  return {
    ...OWNER, mutationId: "article:mutation:1", articleId: candidate.id,
    operation: "put", baseRevision: null, status: "ready", candidate,
    ...overrides
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
  });
  await page.goto("/");
  await expect(page.locator("#inputText")).toBeVisible();
});

test("A2 ready mutation maps to dedicated Article RPC without reading or owner payload", async ({ page }) => {
  const result = await page.evaluate(async ({ owner, mutation, url, key }) => {
    const calls = [];
    const service = window.LingoFlowArticleSyncCloudService.create({
      projectUrl: url, publishableKey: key,
      auth: {
        getSessionContext: async () => ({ status: "ready", user: { id: owner.ownerId } }),
        getAccessToken: async () => "test-access-token"
      },
      fetchImpl: async (target, options) => {
        calls.push({ target, options });
        return { ok: true, status: 200, json: async () => ({
          status: "applied", mutationId: mutation.mutationId,
          articleId: mutation.articleId, operation: "put",
          revision: "revision:1", cursor: "cursor:4"
        }) };
      }
    });
    return { result: await service.pushArticleMutation(owner, mutation), calls };
  }, { owner: OWNER, mutation: readyMutation(), url: PROJECT_URL, key: KEY });
  expect(result.result.status).toBe("applied");
  expect(result.calls).toHaveLength(1);
  expect(result.calls[0].target).toBe(`${PROJECT_URL}/rest/v1/rpc/lingoflow_article_sync_push`);
  const body = JSON.parse(result.calls[0].options.body);
  expect(body.p_expected_owner_id).toBe(OWNER.ownerId);
  expect(body.p_mutation).toEqual({
    mutationId: "article:mutation:1", articleId: "article:cloud:test",
    operation: "put", baseRevision: null, projection: projection()
  });
  expect(JSON.stringify(body)).not.toContain("reading");
  expect(JSON.stringify(body)).not.toContain("lastReadAt");
  expect(body.p_mutation).not.toHaveProperty("ownerId");
});

test("network and auth failures retain A2 ready outbox and never invoke settlement", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    await state.bindWorkspace(owner);
    const created = await window.LingoFlowArticleSyncLocalEngine.create()
      .createArticle({ content: "Keep local" }, owner);
    const mutation = (await state.listArticleMutations(owner.ownerId, owner.bindingId)).items[0];
    const base = { projectUrl: "https://article-project.supabase.co",
      publishableKey: "sb_publishable_article_test" };
    const network = window.LingoFlowArticleSyncCloudService.create({
      ...base,
      auth: { getSessionContext: async () => ({ status: "ready", user: { id: owner.ownerId } }),
        getAccessToken: async () => "test-token" },
      fetchImpl: async () => { throw new Error("offline"); }
    });
    const expired = window.LingoFlowArticleSyncCloudService.create({
      ...base,
      auth: { getSessionContext: async () => ({ status: "signed-out" }),
        getAccessToken: async () => null },
      fetchImpl: async () => { throw new Error("must not fetch"); }
    });
    const first = await network.pushArticleMutation(owner, mutation);
    const second = await expired.pushArticleMutation(owner, mutation);
    return { created: created.status, first, second,
      after: await state.listArticleMutations(owner.ownerId, owner.bindingId) };
  }, OWNER);
  expect(result.created).toBe("ready");
  expect(result.first).toMatchObject({ status: "unavailable", reason: "network-unavailable" });
  expect(result.second).toMatchObject({ status: "unavailable", reason: "unauthenticated" });
  expect(result.after.items).toHaveLength(1);
  expect(result.after.items[0].status).toBe("ready");
});

test("manual/dev success settlement updates sidecar and removes exactly one Article outbox item", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    await state.bindWorkspace(owner);
    const created = await window.LingoFlowArticleSyncLocalEngine.create()
      .createArticle({ content: "Ready" }, owner);
    const mutation = (await state.listArticleMutations(owner.ownerId, owner.bindingId)).items[0];
    const ack = { status: "applied", mutationId: mutation.mutationId,
      articleId: mutation.articleId, operation: "put",
      revision: "revision:1", cursor: "cursor:9" };
    const settled = await state.settleArticleMutationSuccess(
      owner.ownerId, owner.bindingId, mutation.mutationId, ack
    );
    return { created: created.status, settled,
      outbox: await state.listArticleMutations(owner.ownerId, owner.bindingId),
      sidecar: await state.getArticleSidecar(owner.ownerId, owner.bindingId, mutation.articleId),
      favoriteOutbox: await state.listOutbox({ ownerId: owner.ownerId }) };
  }, OWNER);
  expect(result.created).toBe("ready");
  expect(result.settled.status).toBe("settled");
  expect(result.outbox.items).toEqual([]);
  expect(result.sidecar.sidecar.knownRevision).toBe("revision:1");
  expect(result.sidecar.sidecar.lastSyncedFingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(result.favoriteOutbox.items).toEqual([]);
});

test("conflict gets owner-scoped snapshot without discarding the local candidate", async ({ page }) => {
  const mutation = readyMutation(projection("article:conflict", { content: "Local candidate" }));
  const remote = projection("article:conflict", { content: "Remote current" });
  const result = await page.evaluate(async ({ owner, mutation, remote }) => {
    const calls = [];
    const service = window.LingoFlowArticleSyncCloudService.create({
      projectUrl: "https://article-project.supabase.co",
      publishableKey: "sb_publishable_article_test",
      auth: { getSessionContext: async () => ({ status: "ready", user: { id: owner.ownerId } }),
        getAccessToken: async () => "test-token" },
      fetchImpl: async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return { ok: true, status: 200, json: async () => url.endsWith("_push")
          ? { status: "conflict", reason: "revision-mismatch",
            mutationId: mutation.mutationId, articleId: mutation.articleId,
            currentRevision: "revision:2", currentLifecycle: "active" }
          : { status: "found", articleId: mutation.articleId,
            revision: "revision:2", cursor: "cursor:2", lifecycle: "active", projection: remote } };
      }
    });
    const output = await service.pushArticleMutation(owner, mutation);
    return { output, calls, localCandidate: mutation.candidate.content };
  }, { owner: OWNER, mutation, remote });
  expect(result.output).toMatchObject({ status: "conflict", remoteProjection: remote });
  expect(result.localCandidate).toBe("Local candidate");
  expect(result.calls).toHaveLength(2);
  expect(result.calls[1].url).toContain("lingoflow_article_sync_snapshot");
  expect(result.calls[1].body.p_expected_owner_id).toBe(OWNER.ownerId);
});

test("bounded pull validates cursor continuity, limit, and historical snapshots", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const service = window.LingoFlowArticleSyncCloudService.create({
      projectUrl: "https://article-project.supabase.co",
      publishableKey: "sb_publishable_article_test",
      auth: { getSessionContext: async () => ({ status: "ready", user: { id: owner.ownerId } }),
        getAccessToken: async () => "test-token" },
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
        status: "ready", changes: [
          { cursor: "cursor:11", articleId: "article:history", operation: "put",
            revision: "revision:1", projection: {
              id: "article:history", title: "A", content: "First", sourceType: "paste",
              createdAt: "2026-09-21T00:00:00.000Z",
              updatedAt: "2026-09-21T00:00:00.000Z", deletedAt: null } },
          { cursor: "cursor:13", articleId: "article:history", operation: "put",
            revision: "revision:2", projection: {
              id: "article:history", title: "A", content: "Second", sourceType: "paste",
              createdAt: "2026-09-21T00:00:00.000Z",
              updatedAt: "2026-09-21T00:01:00.000Z", deletedAt: null } }
        ], nextCursor: "cursor:13", hasMore: true
      }) })
    });
    return { page: await service.pullArticleChanges(owner, "cursor:10", 2),
      oversized: await service.pullArticleChanges(owner, null, 26) };
  }, OWNER);
  expect(result.page.status).toBe("ready");
  expect(result.page.changes.map(change => change.projection.content)).toEqual(["First", "Second"]);
  expect(result.page.nextCursor).toBe("cursor:13");
  expect(result.oversized).toMatchObject({ status: "rejected", reason: "invalid-payload" });
});

test("manual pulled projection uses A2 reading-preserving apply and no feedback outbox", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const state = window.LingoFlowSyncStateRepository;
    const library = window.LingoFlowArticleLibrary;
    await state.bindWorkspace(owner);
    const local = await library.createArticle({ content: "Local" });
    await library.updateArticleReading(local.id, { progress: 0.73, paragraphIndex: 7 });
    const remote = { ...window.LingoFlowArticleSyncProjection.projectArticleForSync(local),
      content: "Remote", updatedAt: "2026-09-21T01:00:00.000Z" };
    const applied = await window.LingoFlowArticleSyncRepository.applyRemoteProjection({
      ...owner, remoteProjection: remote
    });
    return { applied, article: await library.getArticle(local.id),
      outbox: await state.listArticleMutations(owner.ownerId, owner.bindingId) };
  }, OWNER);
  expect(result.applied.status).toBe("committed");
  expect(result.article.content).toBe("Remote");
  expect(result.article.reading.progress).toBe(0.73);
  expect(result.outbox.items).toEqual([]);
});

test("invalid payload and normal startup never start Article network runtime", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const protocol = window.LingoFlowArticleSyncCloudProtocol;
    const invalid = protocol.validateReadyMutation(owner, {
      ...owner, status: "ready", mutationId: "bad", articleId: "article:x",
      operation: "put", baseRevision: null,
      candidate: { id: "article:x", title: "A", content: "A", sourceType: "paste",
        createdAt: "2026-09-21T00:00:00.000Z", updatedAt: "2026-09-21T00:00:00.000Z",
        deletedAt: null, reading: { progress: 0.5 } }
    });
    const state = window.LingoFlowSyncStateRepository;
    await state.bindWorkspace(owner);
    await window.LingoFlowArticleLibrary.createArticle({ content: "No bootstrap" });
    return { invalid, items: await state.listArticleMutations(owner.ownerId, owner.bindingId),
      transport: typeof window.LingoFlowArticleSyncCloudService.create };
  }, OWNER);
  expect(result.invalid.status).toBe("invalid");
  expect(result.items.items).toEqual([]);
  expect(result.transport).toBe("function");
});
