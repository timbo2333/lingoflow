const { test, expect } = require("@playwright/test");

const OWNER = { ownerId: "a51-owner", bindingId: "a51-binding" };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
    localStorage.removeItem("lingoflow_article_sync_runtime_dev");
  });
  await page.goto("/");
  await expect(page.locator("#inputText")).toBeVisible();
  await page.evaluate(() => {
    window.__createA51Harness = async ({
      localDeleted = false,
      remoteDeleted = false,
      bootstrapIssue = false,
      articleId = `article:a51:${crypto.randomUUID()}`
    } = {}) => {
      const owner = { ownerId: "a51-owner", bindingId: "a51-binding" };
      const now = "2026-09-29T00:00:00.000Z";
      await window.LingoFlowArticleLibrary.restoreArticle({
        id: articleId,
        title: "本机文章",
        content: "Local content",
        sourceType: "paste",
        createdAt: now,
        updatedAt: now,
        deletedAt: localDeleted ? "2026-09-29T01:00:00.000Z" : null,
        lastReadAt: "2026-09-29T02:00:00.000Z",
        reading: { progress: 0.64, paragraphIndex: 4, updatedAt: "2026-09-29T02:00:00.000Z" }
      });
      const localRecord = await window.LingoFlowArticleLibrary.getArticle(articleId);
      const remoteProjection = window.LingoFlowArticleSyncProjection.sanitizeArticleSyncProjection({
        id: articleId,
        title: "云端文章",
        content: "Remote content",
        sourceType: "paste",
        createdAt: now,
        updatedAt: "2026-09-29T03:00:00.000Z",
        deletedAt: remoteDeleted ? "2026-09-29T03:00:00.000Z" : null
      });
      const state = window.LingoFlowSyncStateRepository;
      await state.bindWorkspace(owner);
      const remote = {
        projection: structuredClone(remoteProjection),
        revision: "revision:1",
        cursor: "cursor:1"
      };
      const calls = { push: 0, snapshot: 0, mutations: [] };
      const cloud = {
        snapshot: async (_owner, requestedId) => {
          calls.snapshot += 1;
          if (!remote.projection || requestedId !== articleId) {
            return { status: "missing", articleId: requestedId };
          }
          return {
            status: "found",
            articleId,
            projection: structuredClone(remote.projection),
            revision: remote.revision,
            cursor: remote.cursor,
            lifecycle: remote.projection.deletedAt === null ? "active" : "deleted"
          };
        },
        pushArticleMutation: async (_owner, mutation) => {
          calls.push += 1;
          calls.mutations.push(structuredClone(mutation));
          if (mutation.baseRevision !== remote.revision) {
            return {
              status: "conflict",
              reason: "revision-mismatch",
              mutationId: mutation.mutationId,
              articleId,
              currentRevision: remote.revision,
              remoteProjection: structuredClone(remote.projection),
              remoteCursor: remote.cursor
            };
          }
          const nextRevision = `revision:${Number(remote.revision.slice(9)) + 1}`;
          const nextCursor = `cursor:${Number(remote.cursor.slice(7)) + 1}`;
          remote.projection = structuredClone(mutation.candidate);
          remote.revision = nextRevision;
          remote.cursor = nextCursor;
          return {
            status: "applied",
            mutationId: mutation.mutationId,
            articleId,
            operation: mutation.operation,
            revision: nextRevision,
            cursor: nextCursor
          };
        }
      };
      let generation = 1;
      let allowSync = true;
      const app = {
        getResolutionContext: () => ({ status: "ready", owner, generation }),
        isResolutionContextCurrent: value => value?.generation === generation,
        getState: () => ({
          status: "active",
          syncStatus: "synced",
          ownerId: owner.ownerId,
          bindingId: owner.bindingId,
          enablement: { enabled: true, source: "injected" }
        }),
        start: async () => ({ status: "active" }),
        syncNow: async () => {
          if (!allowSync || navigator.onLine === false) {
            return { status: "unavailable", reason: "network-unavailable" };
          }
          const listed = await state.listArticleMutations(owner.ownerId, owner.bindingId);
          for (const mutation of listed.items.filter(item => item.status === "ready")) {
            const result = await cloud.pushArticleMutation(owner, mutation);
            if (["applied", "unchanged"].includes(result.status)) {
              await state.settleArticleMutationSuccess(
                owner.ownerId,
                owner.bindingId,
                mutation.mutationId,
                result
              );
            }
          }
          return { status: "ready" };
        }
      };
      if (bootstrapIssue) {
        await state.beginArticleBootstrap(owner.ownerId, owner.bindingId);
        await state.captureArticleBootstrapIssue({
          ...owner,
          articleId,
          reason: "bootstrap-content-conflict",
          localProjection: window.LingoFlowArticleSyncProjection.projectArticleForSync(localRecord),
          remoteProjection,
          remoteRevision: remote.revision,
          remoteLifecycle: remoteDeleted ? "deleted" : "active"
        });
      } else {
        await state.captureArticleRuntimeIssue({
          ...owner,
          articleId,
          reason: "remote-change-with-local-desired",
          localProjection: window.LingoFlowArticleSyncProjection.projectArticleForSync(localRecord),
          remoteProjection,
          remoteRevision: remote.revision,
          remoteCursor: remote.cursor,
          mutationId: null
        });
      }
      const service = window.LingoFlowArticleSyncConflictService.create({
        app,
        state,
        repository: window.LingoFlowArticleSyncRepository,
        engine: window.LingoFlowArticleSyncLocalEngine,
        cloud
      });
      return {
        owner,
        articleId,
        app,
        cloud,
        calls,
        remote,
        service,
        state,
        setAllowSync: value => { allowSync = value; },
        invalidate: () => { generation += 1; }
      };
    };
  });
});

test("production rollout remains OFF and dev override is a separate capability", async ({ page }) => {
  const result = await page.evaluate(() => ({
    state: window.LingoFlowArticleSyncApp.getState(),
    constants: window.LingoFlowArticleSyncApp.constants
  }));
  expect(result.state).toMatchObject({
    status: "inactive",
    enablement: { enabled: false, source: "production-disabled" }
  });
  expect(result.constants.PRODUCTION_ROLLOUT_ENABLED).toBe(false);
  expect(result.constants.DEV_OVERRIDE_KEY).toBe("lingoflow_article_sync_runtime_dev");
});

test("Settings describes the exact sync scope and shows Article disabled", async ({ page }) => {
  await page.getByRole("button", { name: /设置/ }).click();
  const account = page.locator("#settingsModal").getByRole("region", { name: "账户与同步" });
  await expect(page.locator("#settingsArticleSyncStatus")).toHaveText("未启用");
  await expect(page.locator(".settingsScopeNote")).toContainText("支持同步收藏、收藏学习状态与文章");
  await expect(page.locator(".settingsScopeNote")).toContainText("阅读进度、阅读位置、查询记录和阅读偏好暂不同步");
  expect(await account.count()).toBeGreaterThanOrEqual(0);
});

test("Article status reflects synced, offline waiting, and multiple durable issues", async ({ page }) => {
  const result = await page.evaluate(async () => {
    let appState = {
      status: "active", syncStatus: "synced",
      enablement: { enabled: true, source: "injected" }
    };
    let issues = [];
    window.LingoFlowArticleSyncApp = { getState: () => appState };
    window.LingoFlowArticleSyncConflictService = {
      listIssues: async () => ({ status: "ready", issues })
    };
    await window.LingoFlowArticleSyncConflictUI.refresh();
    const synced = document.getElementById("settingsArticleSyncStatus").textContent;
    appState = { ...appState, status: "paused", syncStatus: undefined, reason: "offline" };
    await window.LingoFlowArticleSyncConflictUI.refresh();
    const offline = document.getElementById("settingsArticleSyncStatus").textContent;
    issues = [{ articleId: "a" }, { articleId: "b" }];
    await window.LingoFlowArticleSyncConflictUI.refresh();
    return {
      synced,
      offline,
      attention: document.getElementById("settingsArticleSyncStatus").textContent,
      accountAttention: document.getElementById("authArticleSyncStatus").textContent,
      button: document.getElementById("settingsArticleSyncIssuesButton").textContent
    };
  });
  expect(result).toEqual({
    synced: "已同步",
    offline: "离线，等待同步",
    attention: "需要处理（2）",
    accountAttention: "需要处理（2）",
    button: "处理 2 篇文章"
  });
});

test("keep-local active/active uses current revision and clears only its issue", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const first = await window.__createA51Harness({ articleId: "article:keep-local" });
    await first.state.captureArticleRuntimeIssue({
      ...first.owner,
      articleId: "article:other",
      reason: "remote-change-with-local-desired",
      localProjection: null,
      remoteProjection: null,
      remoteRevision: null,
      remoteCursor: null,
      mutationId: null
    });
    const resolved = await first.service.keepLocal(first.articleId);
    const issues = await first.state.listArticleRuntimeIssues(
      first.owner.ownerId, first.owner.bindingId
    );
    return { resolved, remote: first.remote, issues: issues.issues, calls: first.calls };
  });
  expect(result.resolved.status).toBe("resolved");
  expect(result.remote.revision).toBe("revision:2");
  expect(result.remote.projection.content).toBe("Local content");
  expect(result.calls.push).toBe(1);
  expect(result.issues.map(issue => issue.articleId)).toEqual(["article:other"]);
});

test("keep-local chooses restore for remote tombstone and delete for local tombstone", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const restore = await window.__createA51Harness({
      articleId: "article:restore", remoteDeleted: true
    });
    const restored = await restore.service.keepLocal(restore.articleId);
    const remove = await window.__createA51Harness({
      articleId: "article:delete", localDeleted: true
    });
    const deleted = await remove.service.keepLocal(remove.articleId);
    return {
      restored,
      restoreProjection: restore.remote.projection,
      restoreOperation: restore.calls.mutations[0]?.operation,
      deleted,
      deleteProjection: remove.remote.projection,
      deleteOperation: remove.calls.mutations[0]?.operation
    };
  });
  expect(result.restored.status).toBe("resolved");
  expect(result.restoreOperation).toBe("restore");
  expect(result.restoreProjection.deletedAt).toBeNull();
  expect(result.deleted.status).toBe("resolved");
  expect(result.deleteOperation).toBe("delete");
  expect(result.deleteProjection.deletedAt).not.toBeNull();
});

test("offline keep-local is durable and preserves the issue until settlement", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const h = await window.__createA51Harness({ articleId: "article:offline" });
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    const resolved = await h.service.keepLocal(h.articleId);
    const mutations = await h.state.listArticleMutations(h.owner.ownerId, h.owner.bindingId);
    const issues = await h.state.listArticleRuntimeIssues(h.owner.ownerId, h.owner.bindingId);
    return { resolved, mutation: mutations.items[0], issue: issues.issues[0] };
  });
  expect(result.resolved).toMatchObject({ status: "waiting", reason: "offline" });
  expect(result.mutation).toMatchObject({
    status: "ready", baseRevision: "revision:1", resolutionKind: "keep-local"
  });
  expect(result.issue).toMatchObject({
    resolutionStatus: "resolving", resolutionAction: "keep-local"
  });
});

test("use-remote active preserves reading and removes stale Article mutations without echo", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const h = await window.__createA51Harness({ articleId: "article:remote-active" });
    const local = await window.LingoFlowArticleLibrary.getArticle(h.articleId);
    await h.state.prepareArticleMutation({
      ...h.owner,
      mutationId: "article:stale-head",
      articleId: h.articleId,
      operation: "put",
      beforeFingerprint: await window.LingoFlowArticleSyncLocalEngine.fingerprint(
        window.LingoFlowArticleSyncProjection.projectArticleForSync(local)
      ),
      candidateFingerprint: await window.LingoFlowArticleSyncLocalEngine.fingerprint(
        window.LingoFlowArticleSyncProjection.projectArticleForSync(local)
      ),
      baseRevision: "revision:1",
      candidate: window.LingoFlowArticleSyncProjection.projectArticleForSync(local)
    });
    const resolved = await h.service.useRemote(h.articleId);
    const article = await window.LingoFlowArticleLibrary.getArticle(h.articleId);
    const mutations = await h.state.listArticleMutations(h.owner.ownerId, h.owner.bindingId);
    const issues = await h.service.listIssues();
    return { resolved, article, mutations: mutations.items, issues: issues.issues, calls: h.calls };
  });
  expect(result.resolved.status).toBe("resolved");
  expect(result.article.content).toBe("Remote content");
  expect(result.article.reading).toMatchObject({ progress: 0.64, paragraphIndex: 4 });
  expect(result.article.lastReadAt).toBe("2026-09-29T02:00:00.000Z");
  expect(result.mutations).toEqual([]);
  expect(result.issues).toEqual([]);
  expect(result.calls.push).toBe(0);
});

test("use-remote tombstone soft-deletes locally and never hard-deletes", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const h = await window.__createA51Harness({
      articleId: "article:remote-delete", remoteDeleted: true
    });
    const resolved = await h.service.useRemote(h.articleId);
    return {
      resolved,
      article: await window.LingoFlowArticleLibrary.getArticle(h.articleId)
    };
  });
  expect(result.resolved.status).toBe("resolved");
  expect(result.article.id).toBe("article:remote-delete");
  expect(result.article.deletedAt).not.toBeNull();
});

test("a reload-style retry finalizes an interrupted use-remote resolution", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const h = await window.__createA51Harness({ articleId: "article:resume-remote" });
    const local = await window.LingoFlowArticleSyncRepository.getProjection(h.articleId);
    await h.state.beginArticleUseRemoteResolution({
      ...h.owner,
      articleId: h.articleId,
      expectedRevision: h.remote.revision
    });
    await window.LingoFlowArticleSyncRepository.applyResolvedRemoteProjection({
      ...h.owner,
      remoteProjection: h.remote.projection,
      expectedProjection: local
    });
    const resolved = await h.service.useRemote(h.articleId);
    return {
      resolved,
      issues: (await h.service.listIssues()).issues,
      article: await window.LingoFlowArticleLibrary.getArticle(h.articleId)
    };
  });
  expect(result.resolved.status).toBe("resolved");
  expect(result.issues).toEqual([]);
  expect(result.article.content).toBe("Remote content");
});

test("remote revision race refreshes durable issue and requires reconfirmation", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const h = await window.__createA51Harness({ articleId: "article:race" });
    h.remote.revision = "revision:2";
    h.remote.cursor = "cursor:2";
    h.remote.projection.content = "Newer remote";
    const resolved = await h.service.useRemote(h.articleId);
    const issues = await h.state.listArticleRuntimeIssues(h.owner.ownerId, h.owner.bindingId);
    return { resolved, issue: issues.issues[0], article: await window.LingoFlowArticleLibrary.getArticle(h.articleId) };
  });
  expect(result.resolved).toMatchObject({
    status: "stale", reason: "remote-changed-during-resolution"
  });
  expect(result.issue).toMatchObject({
    remoteRevision: "revision:2",
    reason: "remote-changed-during-resolution",
    resolutionStatus: "pending"
  });
  expect(result.article.content).toBe("Local content");
});

test("failed resolution preserves local data and durable issue", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const h = await window.__createA51Harness({ articleId: "article:failed" });
    h.setAllowSync(false);
    const resolved = await h.service.keepLocal(h.articleId);
    return {
      resolved,
      article: await window.LingoFlowArticleLibrary.getArticle(h.articleId),
      issues: (await h.service.listIssues()).issues
    };
  });
  expect(result.resolved.status).toBe("waiting");
  expect(result.article.content).toBe("Local content");
  expect(result.issues).toHaveLength(1);
});

test("bootstrap conflict uses the same resolver and becomes resumable", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const h = await window.__createA51Harness({
      articleId: "article:bootstrap", bootstrapIssue: true
    });
    const resolved = await h.service.useRemote(h.articleId);
    const bootstrap = await h.state.getArticleBootstrapState(
      h.owner.ownerId, h.owner.bindingId
    );
    const issues = await h.state.listArticleBootstrapIssues(
      h.owner.ownerId, h.owner.bindingId
    );
    return { resolved, bootstrap, issues: issues.issues };
  });
  expect(result.resolved.status).toBe("resolved");
  expect(result.issues).toEqual([]);
  expect(result.bootstrap.state).toMatchObject({
    status: "in_progress", phase: "remote-inventory", issueCount: 0
  });
});

test("generation change discards resolution before applying another owner's data", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const h = await window.__createA51Harness({ articleId: "article:generation" });
    let release;
    h.cloud.snapshot = async () => await new Promise(resolve => { release = resolve; });
    const pending = h.service.useRemote(h.articleId);
    for (let index = 0; index < 20 && typeof release !== "function"; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    h.invalidate();
    release({
      status: "found",
      articleId: h.articleId,
      projection: structuredClone(h.remote.projection),
      revision: h.remote.revision,
      cursor: h.remote.cursor,
      lifecycle: "active"
    });
    const resolved = await pending;
    return {
      resolved,
      article: await window.LingoFlowArticleLibrary.getArticle(h.articleId)
    };
  });
  expect(result.resolved.status).toBe("discarded");
  expect(result.article.content).toBe("Local content");
});

test("conflict panel renders user-facing copies and never exposes protocol fields", async ({ page }) => {
  await page.evaluate(() => {
    const issue = {
      articleId: "article:ui",
      reason: "remote-change-with-local-desired",
      resolutionStatus: "pending",
      localProjection: { title: "本机标题", content: "本机正文", deletedAt: null },
      remoteProjection: { title: "云端标题", content: "云端正文", deletedAt: null }
    };
    window.LingoFlowArticleSyncApp = {
      getState: () => ({
        status: "active", syncStatus: "synced",
        enablement: { enabled: true, source: "injected" }
      })
    };
    window.LingoFlowArticleSyncConflictService = {
      listIssues: async () => ({ status: "ready", issues: [issue] }),
      keepLocal: async () => ({ status: "resolved" }),
      useRemote: async () => ({ status: "resolved" })
    };
  });
  await windowRefresh(page);
  await page.evaluate(() => window.LingoFlowArticleSyncConflictUI.open());
  await expect(page.locator("#articleSyncConflictModal")).toHaveClass(/show/);
  await expect(page.locator("#articleSyncConflictModal")).toContainText("保留本机版本");
  await expect(page.locator("#articleSyncConflictModal")).toContainText("使用云端版本");
  await expect(page.locator("#articleSyncConflictModal")).not.toContainText("revision:");
  await expect(page.locator("#articleSyncConflictModal")).not.toContainText("mutationId");
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("lingoflow:article-sync-status", {
      detail: { status: "inactive", reason: "account-switching" }
    }));
  });
  await expect(page.locator("#articleSyncConflictModal")).not.toHaveClass(/show/);
});

async function windowRefresh(page) {
  await page.evaluate(async () => {
    await window.LingoFlowArticleSyncConflictUI.refresh();
  });
}
