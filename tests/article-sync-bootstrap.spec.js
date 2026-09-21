const { test, expect } = require("@playwright/test");

const OWNER = { ownerId: "article-bootstrap-owner", bindingId: "article-bootstrap-binding" };

function createSharedServer() {
  const changes = [];
  const records = new Map();
  const receipts = new Map();

  function append(projection, operation) {
    const current = records.get(projection.id);
    const record = {
      cursor: changes.length + 1,
      revision: (current?.revision || 0) + 1,
      articleId: projection.id,
      operation,
      projection: structuredClone(projection)
    };
    records.set(projection.id, record);
    changes.push(record);
    return record;
  }

  return {
    pull(afterCursor, limit) {
      const after = afterCursor === null ? 0 : Number(afterCursor.slice(7));
      const available = changes.filter(item => item.cursor > after);
      const page = available.slice(0, limit);
      return {
        status: "ready",
        changes: page.map(item => ({
          cursor: `cursor:${item.cursor}`,
          revision: `revision:${item.revision}`,
          articleId: item.articleId,
          operation: item.operation,
          projection: structuredClone(item.projection)
        })),
        nextCursor: `cursor:${page.at(-1)?.cursor || after}`,
        hasMore: available.length > page.length
      };
    },
    push(mutation) {
      const receipt = receipts.get(mutation.mutationId);
      if (receipt) return structuredClone(receipt);
      const current = records.get(mutation.articleId);
      const currentRevision = current ? `revision:${current.revision}` : null;
      if (currentRevision !== mutation.baseRevision) {
        return {
          status: "conflict",
          reason: "revision-mismatch",
          mutationId: mutation.mutationId,
          articleId: mutation.articleId,
          currentRevision,
          currentLifecycle: current?.projection.deletedAt ? "deleted" :
            current ? "active" : "missing",
          remoteProjection: current ? structuredClone(current.projection) : undefined
        };
      }
      const record = append(mutation.candidate, mutation.operation);
      const result = {
        status: "applied",
        mutationId: mutation.mutationId,
        articleId: mutation.articleId,
        operation: mutation.operation,
        revision: `revision:${record.revision}`,
        cursor: `cursor:${record.cursor}`
      };
      receipts.set(mutation.mutationId, result);
      return structuredClone(result);
    },
    snapshot() {
      return Array.from(records.values()).map(item => structuredClone(item));
    }
  };
}

async function openSharedDevice(browser, server, owner) {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:4173" });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
  });
  await page.exposeFunction("__a41SharedPull", (afterCursor, limit) => (
    server.pull(afterCursor, limit)
  ));
  await page.exposeFunction("__a41SharedPush", mutation => server.push(mutation));
  await page.goto("/");
  await expect(page.locator("#inputText")).toBeVisible();
  await page.evaluate(currentOwner => {
    window.__a41SharedOwner = currentOwner;
    window.__a41SharedCloud = {
      pullArticleChanges: async (_owner, afterCursor, limit) => (
        window.__a41SharedPull(afterCursor, limit)
      ),
      pushArticleMutation: async (_owner, mutation) => window.__a41SharedPush(mutation)
    };
    window.__a41SharedCoordinator = () => (
      window.LingoFlowArticleSyncBootstrapCoordinator.create({
        cloud: window.__a41SharedCloud,
        auth: { getSessionContext: async () => ({
          status: "ready", user: { id: currentOwner.ownerId }
        }) }
      })
    );
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
    const timestamp = index => `2026-09-21T00:${String(index).padStart(2, "0")}:00.000Z`;

    function projection(id, options = {}) {
      const value = {
        id,
        title: options.title || `Title ${id}`,
        content: options.content || `Content ${id}`,
        sourceType: options.sourceType || "paste",
        createdAt: options.createdAt || timestamp(0),
        updatedAt: options.updatedAt || timestamp(1),
        deletedAt: options.deletedAt ?? null
      };
      if (options.sourceType === "library") value.sourceId = options.sourceId;
      if (options.sourceTitle) value.sourceTitle = options.sourceTitle;
      if (options.sourceAttribution) value.sourceAttribution = options.sourceAttribution;
      return value;
    }

    function article(value, reading = {}) {
      return {
        ...value,
        lastReadAt: reading.lastReadAt || timestamp(2),
        reading: {
          progress: reading.progress ?? 0,
          paragraphIndex: reading.paragraphIndex ?? 0,
          updatedAt: reading.updatedAt ?? null
        }
      };
    }

    function createServer(initial = [], options = {}) {
      const changes = [];
      const records = new Map();
      const receipts = new Map();
      const counters = { pulls: 0, pushes: 0, bytes: 0 };
      let pushFailures = options.pushFailures || 0;
      let pullFailures = options.pullFailures || 0;

      function append(remote, operation = remote.deletedAt === null ? "put" : "delete") {
        const previous = records.get(remote.id);
        const revision = (previous?.revision || 0) + 1;
        const cursor = changes.length + 1;
        const record = { articleId: remote.id, operation, revision, cursor,
          projection: structuredClone(remote) };
        records.set(remote.id, record);
        changes.push(record);
        return record;
      }

      for (const item of initial) append(item);

      const cloud = {
        pullArticleChanges: async (_owner, afterCursor, limit) => {
          counters.pulls += 1;
          if (pullFailures > 0) {
            pullFailures -= 1;
            return { status: "unavailable", reason: "network-unavailable" };
          }
          const after = afterCursor === null ? 0 : Number(afterCursor.slice(7));
          const available = changes.filter(item => item.cursor > after);
          const page = available.slice(0, limit);
          const normalized = page.map(item => ({
            cursor: `cursor:${item.cursor}`,
            articleId: item.articleId,
            operation: item.operation,
            revision: `revision:${item.revision}`,
            projection: structuredClone(item.projection)
          }));
          counters.bytes += normalized.reduce((sum, item) => (
            sum + new TextEncoder().encode(item.projection.content).length
          ), 0);
          return {
            status: "ready",
            changes: normalized,
            nextCursor: `cursor:${page.at(-1)?.cursor || after}`,
            hasMore: available.length > page.length
          };
        },
        pushArticleMutation: async (_owner, mutation) => {
          counters.pushes += 1;
          if (pushFailures > 0) {
            pushFailures -= 1;
            return { status: "unavailable", reason: "network-unavailable" };
          }
          if (receipts.has(mutation.mutationId)) {
            return structuredClone(receipts.get(mutation.mutationId));
          }
          const current = records.get(mutation.articleId);
          const currentRevision = current ? `revision:${current.revision}` : null;
          if (currentRevision !== mutation.baseRevision) {
            return {
              status: "conflict",
              reason: "revision-mismatch",
              mutationId: mutation.mutationId,
              articleId: mutation.articleId,
              currentRevision,
              currentLifecycle: current?.projection.deletedAt ? "deleted" :
                current ? "active" : "missing",
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
          return result;
        }
      };

      return {
        cloud,
        append,
        setPushFailures(value) { pushFailures = value; },
        setPullFailures(value) { pullFailures = value; },
        snapshot() {
          return {
            records: Array.from(records.values()).map(item => structuredClone(item)),
            changes: changes.map(item => structuredClone(item)),
            counters: { ...counters }
          };
        }
      };
    }

    function coordinator(server, authState, hooks = {}, localEngine = null) {
      return window.LingoFlowArticleSyncBootstrapCoordinator.create({
        cloud: server.cloud,
        auth: {
          getSessionContext: async () => authState.status === "ready"
            ? { status: "ready", user: { id: authState.ownerId } }
            : { status: authState.status }
        },
        hooks,
        ...(localEngine ? { localEngine } : {})
      });
    }

    async function bindAndSeed(owner, local = []) {
      await window.LingoFlowSyncStateRepository.bindWorkspace(owner);
      for (const item of local) {
        const restored = await window.LingoFlowArticleLibrary.restoreArticle(article(
          item.projection || item,
          item.reading || {}
        ));
        if (restored.status !== "restored") throw new Error(`seed failed: ${restored.status}`);
      }
    }

    async function inspect(owner, server) {
      const state = window.LingoFlowSyncStateRepository;
      const articles = await window.LingoFlowArticleLibrary.listArticles({ includeDeleted: true });
      const sidecars = await Promise.all(articles.map(item => (
        state.getArticleSidecar(owner.ownerId, owner.bindingId, item.id)
      )));
      return {
        articles,
        sidecars,
        outbox: await state.listArticleMutations(owner.ownerId, owner.bindingId),
        bootstrap: await state.getArticleBootstrapState(owner.ownerId, owner.bindingId),
        issues: await state.listArticleBootstrapIssues(owner.ownerId, owner.bindingId),
        server: server.snapshot()
      };
    }

    window.__articleBootstrapHarness = Object.freeze({
      projection,
      article,
      createServer,
      coordinator,
      bindAndSeed,
      inspect
    });
  });
});

test("0 Article bootstrap completes with a durable final cursor", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = window.__articleBootstrapHarness;
    await h.bindAndSeed(owner);
    const server = h.createServer();
    const output = await h.coordinator(server, { status: "ready", ownerId: owner.ownerId }).run(owner);
    return { output, snapshot: await h.inspect(owner, server) };
  }, OWNER);
  expect(result.output.status).toBe("complete");
  expect(result.snapshot.bootstrap.state).toMatchObject({
    status: "complete", phase: "complete", inventoryCursor: "cursor:0",
    remoteTailCursor: "cursor:0", finalCursor: "cursor:0"
  });
  expect(result.snapshot.server.counters).toMatchObject({ pulls: 2, pushes: 0 });
});

test("local active/tombstone bootstrap preserves stable IDs and duplicate source IDs", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = window.__articleBootstrapHarness;
    const local = Array.from({ length: 25 }, (_, index) => ({
      projection: h.projection(`article:local:${index}`, {
        content: `Local ${index}`,
        sourceType: index < 2 ? "library" : "paste",
        sourceId: index < 2 ? "shared-source" : undefined,
        deletedAt: index >= 20 ? "2026-09-21T00:05:00.000Z" : null
      })
    }));
    await h.bindAndSeed(owner, local);
    const server = h.createServer();
    const output = await h.coordinator(server, { status: "ready", ownerId: owner.ownerId }).run(owner);
    return { output, snapshot: await h.inspect(owner, server) };
  }, OWNER);
  expect(result.output.status).toBe("complete");
  expect(result.snapshot.server.records).toHaveLength(25);
  expect(result.snapshot.server.records.filter(item => item.projection.deletedAt)).toHaveLength(5);
  expect(result.snapshot.server.records.filter(item => item.projection.sourceId === "shared-source"))
    .toHaveLength(2);
  expect(result.snapshot.server.records.map(item => item.articleId)).toEqual(
    expect.arrayContaining(Array.from({ length: 25 }, (_, index) => `article:local:${index}`))
  );
  expect(result.snapshot.outbox.items).toEqual([]);
  expect(result.output.metrics.uploaded).toBe(25);
  expect(result.output.metrics.catchupPages).toBe(3);
});

test("remote active/tombstone hydrate uses reading defaults, sidecars, and zero echo", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = window.__articleBootstrapHarness;
    const remote = Array.from({ length: 13 }, (_, index) => h.projection(
      `article:remote:${index}`,
      { content: `Remote ${index}`,
        deletedAt: index >= 10 ? "2026-09-21T00:05:00.000Z" : null }
    ));
    await h.bindAndSeed(owner);
    const server = h.createServer(remote);
    const output = await h.coordinator(server, { status: "ready", ownerId: owner.ownerId }).run(owner);
    return { output, snapshot: await h.inspect(owner, server) };
  }, OWNER);
  expect(result.output.status).toBe("complete");
  expect(result.snapshot.articles).toHaveLength(13);
  expect(result.snapshot.articles.filter(item => item.deletedAt)).toHaveLength(3);
  for (const article of result.snapshot.articles) {
    expect(article.reading).toEqual({ progress: 0, paragraphIndex: 0, updatedAt: null });
    expect(article.lastReadAt).toBe(article.createdAt);
  }
  expect(result.snapshot.outbox.items).toEqual([]);
  expect(result.snapshot.sidecars.every(item => item.status === "ready" &&
    /^revision:[1-9][0-9]*$/.test(item.sidecar.knownRevision))).toBe(true);
  expect(result.output.metrics.hydrated).toBe(13);
});

test("exact projection binds revision without put and preserves local reading", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = window.__articleBootstrapHarness;
    const exact = h.projection("article:exact", { content: "Same projection" });
    await h.bindAndSeed(owner, [{ projection: exact,
      reading: { progress: 0.72, paragraphIndex: 4,
        updatedAt: "2026-09-21T00:04:00.000Z" } }]);
    const server = h.createServer([exact]);
    const output = await h.coordinator(server, { status: "ready", ownerId: owner.ownerId }).run(owner);
    return { output, snapshot: await h.inspect(owner, server) };
  }, OWNER);
  expect(result.output.status).toBe("complete");
  expect(result.snapshot.server.counters.pushes).toBe(0);
  expect(result.snapshot.articles[0].reading.progress).toBe(0.72);
  expect(result.snapshot.sidecars[0].sidecar.knownRevision).toBe("revision:1");
  expect(result.output.metrics.exactMatches).toBe(1);
});

test("a higher existing sidecar revision is never downgraded and becomes a durable issue", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = window.__articleBootstrapHarness;
    const exact = h.projection("article:sidecar-ahead", { content: "Same projection" });
    await h.bindAndSeed(owner, [exact]);
    const fingerprint = await window.LingoFlowArticleSyncLocalEngine.fingerprint(exact);
    const seeded = await window.LingoFlowSyncStateRepository.bindArticleRemoteRevision(
      owner.ownerId, owner.bindingId, exact.id, "revision:3", fingerprint
    );
    const server = h.createServer([exact]);
    const output = await h.coordinator(server, { status: "ready", ownerId: owner.ownerId }).run(owner);
    return { seeded, output, snapshot: await h.inspect(owner, server) };
  }, OWNER);
  expect(result.seeded.status).toBe("bound");
  expect(result.output.status).toBe("blocked");
  expect(result.snapshot.sidecars[0].sidecar.knownRevision).toBe("revision:3");
  expect(result.snapshot.issues.issues).toHaveLength(1);
  expect(result.snapshot.issues.issues[0].reason).toBe("ambiguous-local-state");
});

for (const conflict of [
  { name: "active/active", localDeleted: null, remoteDeleted: null,
    reason: "bootstrap-content-conflict" },
  { name: "active/deleted", localDeleted: null,
    remoteDeleted: "2026-09-21T00:05:00.000Z", reason: "bootstrap-lifecycle-conflict" },
  { name: "deleted/active", localDeleted: "2026-09-21T00:05:00.000Z",
    remoteDeleted: null, reason: "bootstrap-lifecycle-conflict" },
  { name: "deleted/deleted", localDeleted: "2026-09-21T00:05:00.000Z",
    remoteDeleted: "2026-09-21T00:06:00.000Z", reason: "bootstrap-content-conflict" }
]) {
  test(`${conflict.name} mismatch is a durable conflict and neither copy is overwritten`, async ({ page }) => {
    const result = await page.evaluate(async ({ owner, conflict }) => {
      const h = window.__articleBootstrapHarness;
      const local = h.projection("article:conflict", {
        content: "Local copy", deletedAt: conflict.localDeleted
      });
      const remote = h.projection("article:conflict", {
        content: "Remote copy", deletedAt: conflict.remoteDeleted,
        updatedAt: "2026-09-21T00:07:00.000Z"
      });
      await h.bindAndSeed(owner, [local]);
      const server = h.createServer([remote]);
      const output = await h.coordinator(server, { status: "ready", ownerId: owner.ownerId }).run(owner);
      return { output, snapshot: await h.inspect(owner, server) };
    }, { owner: OWNER, conflict });
    expect(result.output.status).toBe("blocked");
    expect(result.snapshot.issues.issues).toHaveLength(1);
    expect(result.snapshot.issues.issues[0]).toMatchObject({
      reason: conflict.reason,
      localProjection: { content: "Local copy" },
      remoteProjection: { content: "Remote copy" },
      remoteRevision: "revision:1"
    });
    expect(result.snapshot.articles[0].content).toBe("Local copy");
    expect(result.snapshot.server.records[0].projection.content).toBe("Remote copy");
  });
}

test("auth expiry and outgoing network failure pause without losing state or ready WAL", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = window.__articleBootstrapHarness;
    const local = h.projection("article:offline", { content: "Keep me" });
    await h.bindAndSeed(owner, [local]);
    const server = h.createServer([], { pushFailures: 1 });
    const authState = { status: "ready", ownerId: owner.ownerId };
    const first = await h.coordinator(server, authState).run(owner);
    const afterFailure = await h.inspect(owner, server);
    authState.status = "signed-out";
    const signedOut = await h.coordinator(server, authState).run(owner);
    authState.status = "ready";
    const resumed = await h.coordinator(server, authState).run(owner);
    return { first, afterFailure, signedOut, resumed, final: await h.inspect(owner, server) };
  }, OWNER);
  expect(result.first).toMatchObject({ status: "paused", reason: "network-unavailable" });
  expect(result.afterFailure.outbox.items).toHaveLength(1);
  expect(result.afterFailure.outbox.items[0].status).toBe("ready");
  expect(result.signedOut).toMatchObject({ status: "paused", reason: "article-bootstrap-auth-unavailable" });
  expect(result.resumed.status).toBe("complete");
  expect(result.final.outbox.items).toEqual([]);
  expect(result.final.server.records[0].projection.content).toBe("Keep me");
});

test("remote inventory and reconciliation crash windows resume idempotently", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = window.__articleBootstrapHarness;
    const remote = Array.from({ length: 25 }, (_, index) => h.projection(
      `article:remote-crash:${index}`
    ));
    await h.bindAndSeed(owner);
    const server = h.createServer(remote);
    const auth = { status: "ready", ownerId: owner.ownerId };
    let fetchCrash = true;
    try {
      await h.coordinator(server, auth, {
        afterRemotePageFetch: async ({ phase }) => {
          if (phase === "inventory" && fetchCrash) {
            fetchCrash = false;
            throw new Error("crash-after-fetch");
          }
        }
      }).run(owner);
    } catch {}
    const afterFetch = await h.inspect(owner, server);
    let checkpointCrash = true;
    try {
      await h.coordinator(server, auth, {
        afterInventoryPersist: async () => {
          if (checkpointCrash) {
            checkpointCrash = false;
            throw new Error("crash-after-checkpoint");
          }
        }
      }).run(owner);
    } catch {}
    const afterCheckpoint = await h.inspect(owner, server);
    let reconcileCrash = true;
    try {
      await h.coordinator(server, auth, {
        afterReconcileItem: async () => {
          if (reconcileCrash) {
            reconcileCrash = false;
            throw new Error("crash-mid-reconcile");
          }
        }
      }).run(owner);
    } catch {}
    const resumed = await h.coordinator(server, auth).run(owner);
    return { afterFetch, afterCheckpoint, resumed, final: await h.inspect(owner, server) };
  }, OWNER);
  expect(result.afterFetch.bootstrap.state.inventoryCursor).toBeNull();
  expect(result.afterCheckpoint.bootstrap.state.inventoryCursor).toBe("cursor:10");
  expect(result.resumed.status).toBe("complete");
  expect(result.final.articles).toHaveLength(25);
  expect(result.final.server.counters.pushes).toBe(0);
  expect(result.final.issues.issues).toEqual([]);
});

test("prepared, ready, and acknowledged bootstrap writes survive restart without duplicate server revisions", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = window.__articleBootstrapHarness;
    const local = [
      h.projection("article:prepared"),
      h.projection("article:ready"),
      h.projection("article:ack")
    ];
    await h.bindAndSeed(owner, local);
    const server = h.createServer();
    const auth = { status: "ready", ownerId: owner.ownerId };
    let preparedCrash = true;
    try {
      await h.coordinator(server, auth, {}, window.LingoFlowArticleSyncLocalEngine.create({
        hooks: { afterBootstrapPrepared: async () => {
          if (preparedCrash) { preparedCrash = false; throw new Error("prepared-crash"); }
        } }
      })).run(owner);
    } catch {}
    const afterPrepared = await h.inspect(owner, server);
    let readyCrash = true;
    try {
      await h.coordinator(server, auth, {}, window.LingoFlowArticleSyncLocalEngine.create({
        hooks: { afterBootstrapReady: async () => {
          if (readyCrash) { readyCrash = false; throw new Error("ready-crash"); }
        } }
      })).run(owner);
    } catch {}
    const afterReady = await h.inspect(owner, server);
    let ackCrash = true;
    try {
      await h.coordinator(server, auth, {
        afterOutgoingAck: async () => {
          if (ackCrash) { ackCrash = false; throw new Error("ack-crash"); }
        }
      }).run(owner);
    } catch {}
    const afterAck = await h.inspect(owner, server);
    const resumed = await h.coordinator(server, auth).run(owner);
    return { afterPrepared, afterReady, afterAck, resumed,
      final: await h.inspect(owner, server) };
  }, OWNER);
  expect(result.afterPrepared.outbox.items.some(item => item.status === "prepared")).toBe(true);
  expect(result.afterReady.outbox.items.some(item => item.status === "ready")).toBe(true);
  expect(result.afterAck.server.records.length).toBeGreaterThanOrEqual(1);
  expect(result.resumed.status).toBe("complete");
  expect(result.final.server.records).toHaveLength(3);
  expect(result.final.server.records.every(item => item.revision === 1)).toBe(true);
  expect(result.final.outbox.items).toEqual([]);
});

test("catch-up race persists remote apply before cursor and safely replays after crash", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = window.__articleBootstrapHarness;
    const local = h.projection("article:local-race");
    const raced = h.projection("article:remote-race", { content: "Arrived during bootstrap" });
    await h.bindAndSeed(owner, [local]);
    const server = h.createServer();
    const originalPush = server.cloud.pushArticleMutation;
    let appended = false;
    server.cloud.pushArticleMutation = async (...args) => {
      const value = await originalPush(...args);
      if (!appended) { appended = true; server.append(raced); }
      return value;
    };
    const auth = { status: "ready", ownerId: owner.ownerId };
    let applyCrash = true;
    try {
      await h.coordinator(server, auth, {
        afterRemoteApply: async ({ articleId }) => {
          if (articleId === raced.id && applyCrash) {
            applyCrash = false;
            throw new Error("apply-before-cursor-crash");
          }
        }
      }).run(owner);
    } catch {}
    const afterCrash = await h.inspect(owner, server);
    const pending = await window.LingoFlowSyncStateRepository
      .listArticleBootstrapPendingChanges(owner.ownerId, owner.bindingId);
    const resumed = await h.coordinator(server, auth).run(owner);
    return { afterCrash, pending, resumed, final: await h.inspect(owner, server) };
  }, OWNER);
  expect(result.afterCrash.bootstrap.state.finalCursor).toBe("cursor:0");
  expect(result.afterCrash.bootstrap.state.pendingCursor).toBe("cursor:2");
  expect(result.pending.changes).toHaveLength(2);
  expect(result.resumed.status).toBe("complete");
  expect(result.final.bootstrap.state.finalCursor).toBe("cursor:2");
  expect(result.final.articles.find(item => item.id === "article:remote-race").content)
    .toBe("Arrived during bootstrap");
  expect(result.final.issues.issues).toEqual([]);
});

test("restart after catch-up cursor persistence finalizes without replay or duplicate push", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = window.__articleBootstrapHarness;
    await h.bindAndSeed(owner, [h.projection("article:cursor-persisted")]);
    const server = h.createServer();
    const auth = { status: "ready", ownerId: owner.ownerId };
    let cursorCrash = true;
    try {
      await h.coordinator(server, auth, {
        afterCursorPersist: async () => {
          if (cursorCrash) { cursorCrash = false; throw new Error("cursor-persisted-crash"); }
        }
      }).run(owner);
    } catch {}
    const afterCrash = await h.inspect(owner, server);
    const resumed = await h.coordinator(server, auth).run(owner);
    return { afterCrash, resumed, final: await h.inspect(owner, server) };
  }, OWNER);
  expect(result.afterCrash.bootstrap.state).toMatchObject({
    status: "in_progress", phase: "finalizing", finalCursor: "cursor:1",
    pendingCursor: null
  });
  expect(result.afterCrash.server.counters.pushes).toBe(1);
  expect(result.resumed.status).toBe("complete");
  expect(result.final.server.counters.pushes).toBe(1);
  expect(result.final.server.records).toHaveLength(1);
});

test("100-article bounded hydrate supports mixed 50KB/250KB/1MB payloads", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = window.__articleBootstrapHarness;
    const remote = Array.from({ length: 100 }, (_, index) => h.projection(
      `article:scale:${index}`,
      { content: index === 97 ? "a".repeat(50_000) :
          index === 98 ? "b".repeat(250_000) :
          index === 99 ? "c".repeat(1_000_000) : `small-${index}` }
    ));
    await h.bindAndSeed(owner);
    const server = h.createServer(remote);
    const started = performance.now();
    const output = await h.coordinator(server, { status: "ready", ownerId: owner.ownerId }).run(owner);
    const elapsedMs = performance.now() - started;
    return { output, elapsedMs, snapshot: await h.inspect(owner, server) };
  }, OWNER);
  expect(result.output.status).toBe("complete");
  expect(result.snapshot.articles).toHaveLength(100);
  expect(result.output.metrics.inventoryPages).toBe(10);
  expect(result.output.metrics.remoteBytes).toBeGreaterThan(1_300_000);
  expect(result.snapshot.articles.find(item => item.id === "article:scale:99").content)
    .toHaveLength(1_000_000);
  expect(result.snapshot.outbox.items).toEqual([]);
});

test("two isolated devices upload, edit/delete, then hydrate the same owner safely", async ({ browser }) => {
  const server = createSharedServer();
  const ownerA = { ownerId: "shared-article-owner", bindingId: "shared-device-a" };
  const ownerB = { ownerId: "shared-article-owner", bindingId: "shared-device-b" };
  const deviceA = await openSharedDevice(browser, server, ownerA);
  const deviceB = await openSharedDevice(browser, server, ownerB);
  try {
    const a = await deviceA.page.evaluate(async owner => {
      const state = window.LingoFlowSyncStateRepository;
      const library = window.LingoFlowArticleLibrary;
      await state.bindWorkspace(owner);
      for (let index = 0; index < 10; index += 1) {
        await library.restoreArticle({
          id: `article:shared:${index}`,
          title: `Shared ${index}`,
          content: `Version one ${index}`,
          sourceType: index < 2 ? "library" : "paste",
          ...(index < 2 ? { sourceId: "same-source" } : {}),
          createdAt: "2026-09-21T00:00:00.000Z",
          updatedAt: "2026-09-21T00:01:00.000Z",
          deletedAt: null,
          lastReadAt: "2026-09-21T00:02:00.000Z",
          reading: { progress: 0.4, paragraphIndex: 2, updatedAt: null }
        });
      }
      const bootstrapped = await window.__a41SharedCoordinator().run(owner);
      const engine = window.LingoFlowArticleSyncLocalEngine.create();
      await engine.editArticle("article:shared:0", { content: "Version two" }, owner);
      await engine.deleteArticle("article:shared:1", owner);
      const ready = await state.listArticleMutations(owner.ownerId, owner.bindingId);
      for (const mutation of ready.items) {
        const ack = await window.__a41SharedCloud.pushArticleMutation(owner, mutation);
        await state.settleArticleMutationSuccess(
          owner.ownerId, owner.bindingId, mutation.mutationId, ack
        );
      }
      return { bootstrapped, outbox: await state.listArticleMutations(
        owner.ownerId, owner.bindingId
      ) };
    }, ownerA);
    expect(a.bootstrapped.status).toBe("complete");
    expect(a.outbox.items).toEqual([]);

    const b = await deviceB.page.evaluate(async owner => {
      const state = window.LingoFlowSyncStateRepository;
      await state.bindWorkspace(owner);
      const output = await window.__a41SharedCoordinator().run(owner);
      const articles = await window.LingoFlowArticleLibrary.listArticles({ includeDeleted: true });
      const outbox = await state.listArticleMutations(owner.ownerId, owner.bindingId);
      return { output, articles, outbox };
    }, ownerB);
    expect(b.output.status).toBe("complete");
    expect(b.articles).toHaveLength(10);
    expect(b.articles.find(item => item.id === "article:shared:0").content).toBe("Version two");
    expect(b.articles.find(item => item.id === "article:shared:1").deletedAt).not.toBeNull();
    expect(b.articles.find(item => item.id === "article:shared:0").reading)
      .toEqual({ progress: 0, paragraphIndex: 0, updatedAt: null });
    expect(b.articles.filter(item => item.sourceId === "same-source")).toHaveLength(2);
    expect(b.outbox.items).toEqual([]);
    expect(server.snapshot()).toHaveLength(10);
  } finally {
    await deviceA.context.close();
    await deviceB.context.close();
  }
});

test("workspace confirmation is mandatory and Account Switch clears bootstrap state", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    const h = window.__articleBootstrapHarness;
    const server = h.createServer();
    const unbound = await h.coordinator(server, { status: "ready", ownerId: owner.ownerId }).run(owner);
    await h.bindAndSeed(owner, [h.projection("article:switch")]);
    server.setPushFailures(1);
    const paused = await h.coordinator(server, { status: "ready", ownerId: owner.ownerId }).run(owner);
    const before = await window.LingoFlowSyncStateRepository
      .getArticleBootstrapState(owner.ownerId, owner.bindingId);
    const switched = await window.LingoFlowSyncStateRepository.replaceWorkspaceBinding({
      from: owner,
      to: { ownerId: "article-bootstrap-owner-b", bindingId: "article-bootstrap-binding-b" },
      accountLabel: "B"
    });
    const db = await window.LingoFlowSyncStateRepository.openDatabase();
    const control = await new Promise((resolve, reject) => {
      const request = db.transaction("control").objectStore("control").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const oldState = await window.LingoFlowSyncStateRepository
      .getArticleBootstrapState(owner.ownerId, owner.bindingId);
    return { unbound, paused, before, switched, control, oldState };
  }, OWNER);
  expect(result.unbound).toMatchObject({ status: "blocked",
    reason: "article-bootstrap-workspace-mismatch" });
  expect(result.paused.status).toBe("paused");
  expect(result.before.status).toBe("ready");
  expect(result.switched.status).toBe("replaced");
  expect(result.control.some(item => String(item.kind || "").startsWith("article-bootstrap")))
    .toBe(false);
  expect(result.oldState.status).toBe("not_started");
});

test("normal production startup never constructs or runs Article bootstrap", async ({ page }) => {
  const result = await page.evaluate(async owner => {
    await window.LingoFlowSyncStateRepository.bindWorkspace(owner);
    await window.LingoFlowArticleLibrary.createArticle({ content: "Remain local" });
    return {
      factory: typeof window.LingoFlowArticleSyncBootstrapCoordinator.create,
      state: await window.LingoFlowSyncStateRepository
        .getArticleBootstrapState(owner.ownerId, owner.bindingId),
      outbox: await window.LingoFlowSyncStateRepository
        .listArticleMutations(owner.ownerId, owner.bindingId)
    };
  }, OWNER);
  expect(result.factory).toBe("function");
  expect(result.state.status).toBe("not_started");
  expect(result.outbox.items).toEqual([]);
});
