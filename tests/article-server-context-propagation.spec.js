const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  const progressCalls = [];
  page.on("request", request => {
    if (/\/rpc\/.*progress/i.test(request.url())) progressCalls.push(request.url().split("?")[0]);
  });
  page.__progressCalls = progressCalls;
  await page.route("https://**/*", route => route.abort());
  await page.addInitScript(() => localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1"));
  await page.goto("/");
  await page.evaluate(async () => {
    const owner = { ownerId: "context-owner", bindingId: "context-binding" };
    const state = window.LingoFlowSyncStateRepository;
    const library = window.LingoFlowArticleLibrary;
    const resume = window.LingoFlowReadingResume;
    const protocol = window.LingoFlowArticleSyncCloudProtocol;
    const flow = window.LingoFlowProgressLocalDesired;
    const epochs = ["11111111-2222-4333-8444-555555555555",
      "22222222-2222-4333-8444-555555555555",
      "33333333-2222-4333-8444-555555555555"];
    const projection = (id, content = "A server Article body.", deletedAt = null) => ({
      id, title: id, content, sourceType: "paste",
      createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:01.000Z",
      deletedAt
    });
    const context = async (revision, epoch, body, lifecycle = "active") => ({
      articleRevision: `revision:${revision}`, readingEpoch: epoch,
      contentFingerprint: await resume.fingerprintContent(body), lifecycle
    });
    const change = async (cursor, revision, epoch, item, operation = "put", complete = true) => {
      const raw = { cursor: `cursor:${cursor}`, revision: `revision:${revision}`,
        articleId: item.id, operation, projection: item };
      if (complete) {
        raw.readingEpoch = epoch;
        raw.contentFingerprint = await resume.fingerprintContent(item.content);
      }
      return raw;
    };
    const pageOf = (changes, afterCursor = null) => protocol.validatePullResult({
      status: "ready", changes, nextCursor: changes.at(-1)?.cursor || afterCursor || "cursor:0",
      hasMore: false
    }, afterCursor, 10);
    const auth = { getState: () => ({ status: "authenticated", user: { id: owner.ownerId } }),
      getSessionContext: async () => ({ status: "ready", user: { id: owner.ownerId } }) };
    window.LingoFlowSupabaseAuth = auth;
    await state.bindWorkspace(owner);
    window.contextTest = { owner, state, library, resume, protocol, flow, epochs,
      projection, context, change, pageOf, auth };
  });
});

test.afterEach(async ({ page }) => {
  expect(page.__progressCalls).toEqual([]);
});

test("Article parser accepts only complete server context; old and partial replies remain compatible", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const h = window.contextTest;
    const item = h.projection("protocol-item");
    const fp = await h.resume.fingerprintContent(item.content);
    const mutation = { mutationId: "m1", articleId: item.id, operation: "put" };
    const raw = { status: "applied", ...mutation, revision: "revision:1", cursor: "cursor:1",
      readingEpoch: h.epochs[0], contentFingerprint: fp };
    const complete = h.protocol.validatePushResult(raw, mutation);
    const unchanged = h.protocol.validatePushResult({ ...raw, status: "unchanged" }, mutation);
    const partial = h.protocol.validatePushResult({ ...raw, contentFingerprint: undefined }, mutation);
    const missingEpoch = h.protocol.validatePushResult({ ...raw, readingEpoch: undefined }, mutation);
    const legacy = h.protocol.validatePushResult({ ...raw, readingEpoch: undefined,
      contentFingerprint: undefined }, mutation);
    const pull = h.pageOf([await h.change(1, 1, h.epochs[0], item)]);
    const pullWithoutEpoch = h.pageOf([await h.change(1, 1, h.epochs[0], item, "put", false)]);
    const pullWithoutFingerprint = h.pageOf([{ ...await h.change(1, 1, h.epochs[0], item),
      contentFingerprint: undefined }]);
    const deletedItem = { ...item, deletedAt: "2026-10-03T00:02:00.000Z" };
    const partialDelete = h.pageOf([{ ...await h.change(1, 1, h.epochs[1], deletedItem, "delete"),
      contentFingerprint: undefined }]);
    const snapshot = h.protocol.validateSnapshotResult({ status: "found", articleId: item.id,
      projection: item, revision: "revision:1", cursor: "cursor:1", lifecycle: "active",
      readingEpoch: h.epochs[0], contentFingerprint: fp }, item.id);
    return { complete: complete.serverReadingContext, unchanged: unchanged.serverReadingContext,
      partial: partial.serverReadingContext || null,
      missingEpoch: missingEpoch.serverReadingContext || null,
      legacy: legacy.serverReadingContext || null,
      pull: pull.changes[0].serverReadingContext, snapshot: snapshot.serverReadingContext,
      pullWithoutEpoch: pullWithoutEpoch.changes[0].serverReadingContext || null,
      pullWithoutFingerprint: pullWithoutFingerprint.changes[0].serverReadingContext || null,
      partialDelete: partialDelete.changes[0].serverReadingContext || null };
  });
  expect(r.complete).toEqual(r.pull);
  expect(r.complete).toEqual(r.snapshot);
  expect(r.unchanged).toEqual(r.complete);
  expect(r.partial).toBeNull();
  expect(r.missingEpoch).toBeNull();
  expect(r.legacy).toBeNull();
  expect(r.pullWithoutEpoch).toBeNull();
  expect(r.pullWithoutFingerprint).toBeNull();
  expect(r.partialDelete).toBeNull();
});

test("canonical conflict snapshot supplies context, never the rejected candidate", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const h = window.contextTest;
    const item = h.projection("conflict-context", "SERVER body");
    const proposed = h.projection(item.id, "CLIENT body");
    const parent = await h.context(2, h.epochs[1], item.content);
    const mutation = { ...h.owner, status: "ready", mutationId: "conflict-mutation",
      articleId: item.id, operation: "put", baseRevision: "revision:1", candidate: proposed };
    await h.state.bindArticleRemoteRevision(h.owner.ownerId, h.owner.bindingId,
      item.id, "revision:1", "a".repeat(64), "active");
    const service = window.LingoFlowArticleSyncCloudService.create({
      projectUrl: "https://example.supabase.co", publishableKey: "test-publishable-key",
      captureSnapshotGuard: () => () => true,
      auth: { getSessionContext: async () => ({ status: "ready", user: { id: h.owner.ownerId } }),
        getAccessToken: async () => "test-token" },
      fetchImpl: async url => ({ ok: true, status: 200, json: async () => url.endsWith("_push")
        ? { status: "conflict", mutationId: mutation.mutationId, articleId: item.id,
          reason: "revision-mismatch", currentRevision: "revision:2" }
        : { status: "found", articleId: item.id, revision: "revision:2", cursor: "cursor:2",
          lifecycle: "active", projection: item, readingEpoch: parent.readingEpoch,
          contentFingerprint: parent.contentFingerprint } })
    });
    const result = await service.pushArticleMutation(h.owner, mutation);
    const observed = await h.state.recordArticleServerReadingContext(h.owner.ownerId,
      h.owner.bindingId, item.id, result.remoteServerReadingContext);
    const beforeBind = await h.state.getArticleServerReadingContext(h.owner.ownerId, h.owner.bindingId, item.id);
    await h.state.bindArticleRemoteRevision(h.owner.ownerId, h.owner.bindingId,
      item.id, "revision:2", "b".repeat(64), "active", result.remoteServerReadingContext);
    const afterBind = await h.state.getArticleServerReadingContext(h.owner.ownerId, h.owner.bindingId, item.id);
    return { result, observed, beforeBind, afterBind, parent };
  });
  expect(r.result.status).toBe("conflict");
  expect(r.result.remoteServerReadingContext).toEqual(r.parent);
  // The real snapshot seam ingests the context/evidence before returning.
  // Copying that context into the conflict pipeline is not another observation.
  expect(r.observed.status).toBe("unchanged");
  expect(r.beforeBind.context).toBeNull();
  expect(r.afterBind.context).toEqual(r.parent);
});

test("use-remote conflict resolution binds snapshot context with the resolved Article", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const h = window.contextTest;
    const created = await h.library.createArticle({ content: "Local conflict body." });
    const localProjection = await window.LingoFlowArticleSyncRepository.getProjection(created.id);
    const remoteProjection = { ...localProjection, content: "Canonical remote body.",
      updatedAt: "2026-10-03T00:01:00.000Z" };
    const before = await h.context(1, h.epochs[0], localProjection.content);
    const after = await h.context(2, h.epochs[1], remoteProjection.content);
    await h.state.bindArticleRemoteRevision(h.owner.ownerId, h.owner.bindingId,
      created.id, "revision:1", "a".repeat(64), "active", before);
    await h.state.captureArticleRuntimeIssue({ ...h.owner, articleId: created.id,
      reason: "remote-content-conflict", localProjection, remoteProjection,
      remoteRevision: "revision:2", remoteCursor: "cursor:2", mutationId: null });
    const service = window.LingoFlowArticleSyncConflictService.create({
      state: h.state,
      repository: window.LingoFlowArticleSyncRepository,
      engine: window.LingoFlowArticleSyncLocalEngine,
      cloud: { snapshot: async () => ({ status: "found", articleId: created.id,
        revision: "revision:2", cursor: "cursor:2", lifecycle: "active",
        projection: remoteProjection, serverReadingContext: after }) },
      app: { getResolutionContext: () => ({ status: "ready", owner: h.owner, generation: 1 }),
        isResolutionContextCurrent: () => true, start: async () => ({ status: "inactive" }) }
    });
    const resolved = await service.useRemote(created.id);
    const context = await h.state.getArticleServerReadingContext(h.owner.ownerId, h.owner.bindingId, created.id);
    const article = await h.library.getArticle(created.id);
    return { resolved, context, article, after };
  });
  expect(r.resolved.status).toBe("resolved");
  expect(r.context.context).toEqual(r.after);
  expect(r.article.content).toBe("Canonical remote body.");
});

test("push settlement atomically saves context and real movement freezes it", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const h = window.contextTest;
    const local = window.LingoFlowArticleSyncLocalEngine.create();
    const created = await local.createArticle({ content: "Push-confirmed content." }, h.owner);
    const articleId = created.article.id;
    const mutation = (await h.state.listArticleMutations(h.owner.ownerId, h.owner.bindingId)).items[0];
    const parent = await h.context(1, h.epochs[0], mutation.candidate.content);
    const ack = h.protocol.validatePushResult({ status: "applied", mutationId: mutation.mutationId,
      articleId, operation: "put", revision: "revision:1", cursor: "cursor:1",
      readingEpoch: parent.readingEpoch, contentFingerprint: parent.contentFingerprint }, mutation);
    const settled = await h.state.settleArticleMutationSuccess(h.owner.ownerId,
      h.owner.bindingId, mutation.mutationId, ack);
    const sidecar = (await h.state.getArticleSidecar(h.owner.ownerId, h.owner.bindingId, articleId)).sidecar;
    const moved = await h.flow.writeRealMovement(articleId,
      h.resume.createCheckpoint({ progress: 0.3, paragraphIndex: 3 }, parent.contentFingerprint));
    const desired = (await h.state.getProgressDesired(h.owner.ownerId, h.owner.bindingId, articleId)).record;
    return { settled: settled.status, sidecar, moved: moved.status,
      frozen: desired.confirmed.causalBase.parent, expected: parent };
  });
  expect(r.settled).toBe("settled");
  expect(r.sidecar.knownRevision).toBe("revision:1");
  expect(r.sidecar.serverReadingContext).toEqual(r.expected);
  expect(r.moved).toBe("confirmed");
  expect(r.frozen).toEqual(r.expected);
});

test("unchanged receipt saves its historical context without inventing a revision", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const h = window.contextTest;
    const created = await window.LingoFlowArticleSyncLocalEngine.create()
      .createArticle({ content: "No-op push body." }, h.owner);
    const mutation = (await h.state.listArticleMutations(h.owner.ownerId, h.owner.bindingId)).items[0];
    const parent = await h.context(1, h.epochs[0], mutation.candidate.content);
    const ack = h.protocol.validatePushResult({ status: "unchanged",
      mutationId: mutation.mutationId, articleId: created.article.id, operation: "put",
      revision: "revision:1", cursor: "cursor:1", readingEpoch: parent.readingEpoch,
      contentFingerprint: parent.contentFingerprint }, mutation);
    const result = await h.state.settleArticleMutationSuccess(h.owner.ownerId,
      h.owner.bindingId, mutation.mutationId, ack);
    const sidecar = (await h.state.getArticleSidecar(h.owner.ownerId,
      h.owner.bindingId, created.article.id)).sidecar;
    return { result: result.status, revision: sidecar.knownRevision,
      context: sidecar.serverReadingContext, parent };
  });
  expect(r.result).toBe("settled");
  expect(r.revision).toBe("revision:1");
  expect(r.context).toEqual(r.parent);
});

for (const responseStatus of ["applied", "unchanged"]) {
test(`delayed ${responseStatus} receipt cannot roll back a newer sidecar`, async ({ page }) => {
  const r = await page.evaluate(async responseStatus => {
    const h = window.contextTest;
    const created = await window.LingoFlowArticleSyncLocalEngine.create()
      .createArticle({ content: "Delayed acknowledgement body." }, h.owner);
    const mutation = (await h.state.listArticleMutations(h.owner.ownerId, h.owner.bindingId)).items[0];
    const parent = await h.context(2, h.epochs[1], mutation.candidate.content);
    const db = await h.state.openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("articleSidecars", "readwrite");
      const store = tx.objectStore("articleSidecars");
      const request = store.get([h.owner.ownerId, created.article.id]);
      request.onsuccess = () => store.put({ ...request.result, knownRevision: "revision:2",
        lastSyncedLifecycle: "active", serverReadingContext: parent });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    const stale = await h.state.settleArticleMutationSuccess(h.owner.ownerId,
      h.owner.bindingId, mutation.mutationId, { status: responseStatus,
        mutationId: mutation.mutationId, articleId: created.article.id, operation: "put",
        revision: "revision:1", cursor: "cursor:1",
        serverReadingContext: await h.context(1, h.epochs[0], mutation.candidate.content) });
    const after = (await h.state.getArticleSidecar(h.owner.ownerId,
      h.owner.bindingId, created.article.id)).sidecar;
    return { stale, after, parent };
  }, responseStatus);
  expect(r.stale).toMatchObject({ status: "blocked", reason: "article-stale-acknowledgement" });
  expect(r.after.knownRevision).toBe("revision:2");
  expect(r.after.serverReadingContext).toEqual(r.parent);
});
}

test("bootstrap inventory and later runtime pull propagate distinct server generations", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const h = window.contextTest;
    const item = h.projection("remote-article");
    const initial = await h.change(1, 1, h.epochs[0], item);
    let nextChange = null;
    const cloud = {
      pullArticleChanges: async (_owner, after) => {
        if (after === null) return h.pageOf([initial]);
        if (after === "cursor:1" && nextChange) return h.pageOf([nextChange], after);
        return h.pageOf([], after);
      },
      pushArticleMutation: async () => { throw new Error("unexpected Article push"); },
      snapshot: async () => ({ status: "missing" })
    };
    const bootstrap = window.LingoFlowArticleSyncBootstrapCoordinator.create({ cloud, auth: h.auth });
    const boot = await bootstrap.run(h.owner);
    const first = await h.state.getArticleServerReadingContext(
      h.owner.ownerId, h.owner.bindingId, item.id);
    const article = await h.library.getArticle(item.id);
    const observed = { kind: "revision", revision: "revision:10", cursor: "cursor:10",
      parentReadingEpoch: h.epochs[0], contentFingerprint: first.context.contentFingerprint,
      checkpoint: { progress: 0.2, paragraphIndex: 2 } };
    await h.state.recordProgressRemoteObservation(h.owner.ownerId, h.owner.bindingId, item.id, observed);
    const moved = await h.flow.writeRealMovement(item.id,
      h.resume.createCheckpoint({ progress: 0.3, paragraphIndex: 3 }, first.context.contentFingerprint));
    const frozen = (await h.state.getProgressDesired(h.owner.ownerId, h.owner.bindingId, item.id))
      .record.confirmed.causalBase.parent;
    const ready = await h.flow.evaluateCloudCandidate(h.owner.ownerId, h.owner.bindingId, item.id);
    const runtime = window.LingoFlowArticleSyncApp.create({ gateEnabled: () => true,
      listenAccountEvents: false, auth: h.auth, cloud, bootstrap,
      state: h.state, localEngine: window.LingoFlowArticleSyncLocalEngine.create() });
    const started = await runtime.start();
    const updatedItem = h.projection(item.id, "A new body and generation.");
    nextChange = await h.change(2, 2, h.epochs[1], updatedItem);
    await runtime.syncNow();
    runtime.stop("test-complete");
    const second = await h.state.getArticleServerReadingContext(
      h.owner.ownerId, h.owner.bindingId, item.id);
    const oldGate = await h.flow.evaluateCloudCandidate(h.owner.ownerId, h.owner.bindingId, item.id);
    const secondMovement = await h.flow.writeRealMovement(item.id,
      h.resume.createCheckpoint({ progress: 0.4, paragraphIndex: 4 }, second.context.contentFingerprint));
    const secondBase = (await h.state.getProgressDesired(h.owner.ownerId, h.owner.bindingId, item.id))
      .record.confirmed.causalBase;
    return { boot: boot.status, article: Boolean(article), first: first.context,
      moved: moved.status, frozen, ready, started: started.status, second: second.context,
      oldGate, secondMovement: secondMovement.status, secondBase };
  });
  expect(r.boot).toBe("complete");
  expect(r.article).toBe(true);
  expect(r.moved).toBe("confirmed");
  expect(r.frozen).toEqual(r.first);
  expect(r.ready).toEqual({ status: "ready", mode: "update" });
  expect(r.started).toBe("active");
  expect(r.second.articleRevision).toBe("revision:2");
  expect(r.second.readingEpoch).not.toBe(r.first.readingEpoch);
  expect(r.oldGate.status).toBe("not-ready");
  expect(r.secondMovement).toBe("confirmed");
  expect(r.secondBase.parent).toEqual(r.second);
  expect(r.secondBase.revision).toBe("revision:10");
});

test("runtime pull A→B→A keeps the original movement blocked by server epoch", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const h = window.contextTest;
    const firstArticle = h.projection("runtime-aba", "The exact original A bytes.");
    const firstChange = await h.change(1, 1, h.epochs[0], firstArticle);
    const changes = new Map();
    const cloud = {
      pullArticleChanges: async (_owner, after) => {
        if (after === null) return h.pageOf([firstChange]);
        return changes.has(after) ? h.pageOf([changes.get(after)], after) : h.pageOf([], after);
      },
      pushArticleMutation: async () => { throw new Error("unexpected Article push"); },
      snapshot: async () => ({ status: "missing" })
    };
    const bootstrap = window.LingoFlowArticleSyncBootstrapCoordinator.create({ cloud, auth: h.auth });
    await bootstrap.run(h.owner);
    const args = [h.owner.ownerId, h.owner.bindingId, firstArticle.id];
    const initial = (await h.state.getArticleServerReadingContext(...args)).context;
    await h.state.recordProgressRemoteObservation(...args, { kind: "revision",
      revision: "revision:10", cursor: "cursor:10", parentReadingEpoch: h.epochs[0],
      contentFingerprint: initial.contentFingerprint,
      checkpoint: { progress: 0.2, paragraphIndex: 2 } });
    await h.flow.writeRealMovement(firstArticle.id,
      h.resume.createCheckpoint({ progress: 0.3, paragraphIndex: 3 }, initial.contentFingerprint));
    const runtime = window.LingoFlowArticleSyncApp.create({ gateEnabled: () => true,
      listenAccountEvents: false, auth: h.auth, cloud, bootstrap,
      state: h.state, localEngine: window.LingoFlowArticleSyncLocalEngine.create() });
    await runtime.start();
    const changedBody = h.projection(firstArticle.id, "Different B bytes.");
    changes.set("cursor:1", await h.change(2, 2, h.epochs[1], changedBody));
    await runtime.syncNow();
    const middle = (await h.state.getArticleServerReadingContext(...args)).context;
    changes.set("cursor:2", await h.change(3, 3, h.epochs[2], firstArticle));
    await runtime.syncNow();
    runtime.stop("test-complete");
    const finalContext = (await h.state.getArticleServerReadingContext(...args)).context;
    const desired = (await h.state.getProgressDesired(...args)).record.confirmed;
    const candidate = await h.flow.evaluateCloudCandidate(...args);
    const currentArticle = await h.library.getArticle(firstArticle.id);
    return { initial, middle, finalContext, desired, candidate,
      finalContent: currentArticle.content };
  });
  expect(r.finalContent).toBe("The exact original A bytes.");
  expect(r.initial.contentFingerprint).toBe(r.finalContext.contentFingerprint);
  expect(r.middle.contentFingerprint).not.toBe(r.initial.contentFingerprint);
  expect(r.desired.causalBase.parent).toEqual(r.initial);
  expect(r.finalContext.articleRevision).toBe("revision:3");
  expect(r.finalContext.readingEpoch).not.toBe(r.initial.readingEpoch);
  expect(r.candidate).toEqual({ status: "not-ready", reason: "parent-epoch-mismatch" });
});

test("sidecar revision and complete context advance together; partial and delayed responses fail closed", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const h = window.contextTest;
    const id = "sidecar-ordering";
    const parent20 = await h.context(20, h.epochs[0], "Version A");
    const parent21 = await h.context(21, h.epochs[0], "Version A");
    const parent21Bad = await h.context(21, h.epochs[1], "Version B");
    const first = await h.state.bindArticleRemoteRevision(h.owner.ownerId, h.owner.bindingId,
      id, "revision:20", "a".repeat(64), "active", parent20);
    const partial = await h.state.bindArticleRemoteRevision(h.owner.ownerId, h.owner.bindingId,
      id, "revision:21", "b".repeat(64), "active");
    const stale = await h.state.getArticleServerReadingContext(h.owner.ownerId, h.owner.bindingId, id);
    const rawStale = (await h.state.getArticleSidecar(h.owner.ownerId, h.owner.bindingId, id)).sidecar;
    const titleOnly = await h.state.bindArticleRemoteRevision(h.owner.ownerId, h.owner.bindingId,
      id, "revision:21", "b".repeat(64), "active", parent21);
    const identical = await h.state.bindArticleRemoteRevision(h.owner.ownerId, h.owner.bindingId,
      id, "revision:21", "b".repeat(64), "active", parent21);
    const delayed = await h.state.bindArticleRemoteRevision(h.owner.ownerId, h.owner.bindingId,
      id, "revision:20", "a".repeat(64), "active", parent20);
    const conflict = await h.state.bindArticleRemoteRevision(h.owner.ownerId, h.owner.bindingId,
      id, "revision:21", "b".repeat(64), "active", parent21Bad);
    const after = await h.state.getArticleServerReadingContext(h.owner.ownerId, h.owner.bindingId, id);
    const rawAfter = (await h.state.getArticleSidecar(h.owner.ownerId, h.owner.bindingId, id)).sidecar;
    return { first, partial, stale, rawStale, titleOnly, identical, delayed, conflict,
      after, rawAfter, parent20, parent21 };
  });
  expect(r.first.status).toBe("bound");
  expect(r.partial.status).toBe("bound");
  expect(r.stale.context).toBeNull();
  expect(r.rawStale.serverReadingContext).toEqual(r.parent20);
  expect(r.titleOnly.sidecar.serverReadingContext).toEqual(r.parent21);
  expect(r.identical.sidecar.serverReadingContextDiagnostic).toBeNull();
  expect(r.delayed).toMatchObject({ status: "blocked", reason: "article-stale-remote-revision" });
  expect(r.conflict.sidecar.serverReadingContext).toEqual(r.parent21);
  expect(r.after.context).toBeNull();
  expect(r.rawAfter.serverReadingContextDiagnostic.reason).toBe("inconsistent-parent-context");
});

for (const changed of ["readingEpoch", "contentFingerprint", "lifecycle"]) {
  test(`same server revision with different ${changed} retains fact and blocks Progress`, async ({ page }) => {
    const r = await page.evaluate(async changed => {
      const h = window.contextTest;
      const id = "inconsistent-" + changed;
      const original = await h.context(1, h.epochs[0], "Original body");
      const alternate = { ...original, [changed]: ({ readingEpoch: h.epochs[1],
        contentFingerprint: await h.resume.fingerprintContent("Different body"),
        lifecycle: "deleted" })[changed] };
      await h.state.bindArticleRemoteRevision(h.owner.ownerId, h.owner.bindingId,
        id, "revision:1", "a".repeat(64), "active", original);
      const written = await h.state.bindArticleRemoteRevision(h.owner.ownerId, h.owner.bindingId,
        id, "revision:1", "a".repeat(64), "active", alternate);
      const raw = (await h.state.getArticleSidecar(h.owner.ownerId, h.owner.bindingId, id)).sidecar;
      const trusted = await h.state.getArticleServerReadingContext(h.owner.ownerId, h.owner.bindingId, id);
      return { written, raw, trusted, original };
    }, changed);
    expect(r.written.status).toBe("bound");
    expect(r.raw.serverReadingContext).toEqual(r.original);
    expect(r.raw.serverReadingContextDiagnostic.reason).toBe("inconsistent-parent-context");
    expect(r.trusted.context).toBeNull();
  });
}

test("a consistent newer server revision clears an earlier context diagnostic", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const h = window.contextTest;
    const id = "diagnostic-recovery";
    const first = await h.context(1, h.epochs[0], "Before edit");
    const inconsistent = { ...first, readingEpoch: h.epochs[1] };
    const later = await h.context(2, h.epochs[2], "After edit");
    await h.state.bindArticleRemoteRevision(h.owner.ownerId, h.owner.bindingId,
      id, "revision:1", "a".repeat(64), "active", first);
    const rejected = await h.state.bindArticleRemoteRevision(h.owner.ownerId, h.owner.bindingId,
      id, "revision:1", "a".repeat(64), "active", inconsistent);
    const disabled = await h.state.getArticleServerReadingContext(h.owner.ownerId, h.owner.bindingId, id);
    const advanced = await h.state.bindArticleRemoteRevision(h.owner.ownerId, h.owner.bindingId,
      id, "revision:2", "b".repeat(64), "active", later);
    const recovered = await h.state.getArticleServerReadingContext(h.owner.ownerId, h.owner.bindingId, id);
    return { rejected, disabled, advanced, recovered, first, later };
  });
  expect(r.rejected.sidecar.serverReadingContext).toEqual(r.first);
  expect(r.disabled.context).toBeNull();
  expect(r.disabled.diagnostic.reason).toBe("inconsistent-parent-context");
  expect(r.advanced.status).toBe("bound");
  expect(r.recovered.context).toEqual(r.later);
  expect(r.recovered.diagnostic).toBeNull();
});

test("title-only server revision keeps an existing Progress desired eligible", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const h = window.contextTest;
    const article = await h.library.createArticle({ content: "Unchanged body for title edit." });
    const id = article.id;
    const args = [h.owner.ownerId, h.owner.bindingId, id];
    const first = await h.context(1, h.epochs[0], article.content);
    await h.state.bindArticleRemoteRevision(...args, "revision:1", "a".repeat(64), "active", first);
    const bootstrap = await h.state.beginArticleBootstrap(h.owner.ownerId, h.owner.bindingId);
    const db = await h.state.openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("control", "readwrite");
      tx.objectStore("control").put({ ...bootstrap.state, status: "complete", phase: "complete",
        finalCursor: "cursor:0", pendingCursor: null, pendingHasMore: false, issueCount: 0 });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    await h.state.recordProgressRemoteObservation(...args, { kind: "revision",
      revision: "revision:10", cursor: "cursor:10", parentReadingEpoch: h.epochs[0],
      contentFingerprint: first.contentFingerprint,
      checkpoint: { progress: 0.2, paragraphIndex: 2 } });
    await h.flow.writeRealMovement(id,
      h.resume.createCheckpoint({ progress: 0.3, paragraphIndex: 3 }, first.contentFingerprint));
    const before = await h.flow.evaluateCloudCandidate(...args);
    await h.library.updateArticle(id, { title: "New title, same bytes" });
    const second = { ...first, articleRevision: "revision:2" };
    await h.state.bindArticleRemoteRevision(...args, "revision:2", "b".repeat(64), "active", second);
    const after = await h.flow.evaluateCloudCandidate(...args);
    const desired = (await h.state.getProgressDesired(...args)).record.confirmed;
    return { before, after, desired, first, second,
      current: await h.state.getArticleServerReadingContext(...args) };
  });
  expect(r.before).toEqual({ status: "ready", mode: "update" });
  expect(r.after).toEqual({ status: "ready", mode: "update" });
  expect(r.desired.causalBase.parent).toEqual(r.first);
  expect(r.current.context).toEqual(r.second);
});

test("server epoch prevents A→B→A revival and delete/restore requires a new movement", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const h = window.contextTest;
    const article = await h.library.createArticle({ content: "Article A" });
    const id = article.id;
    const FA = await h.resume.fingerprintContent("Article A");
    const FB = await h.resume.fingerprintContent("Article B");
    const args = [h.owner.ownerId, h.owner.bindingId, id];
    const first = await h.context(1, h.epochs[0], "Article A");
    await h.state.bindArticleRemoteRevision(...args, "revision:1", "a".repeat(64), "active", first);
    const bootstrap = await h.state.beginArticleBootstrap(h.owner.ownerId, h.owner.bindingId);
    const db = await h.state.openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("control", "readwrite");
      tx.objectStore("control").put({ ...bootstrap.state, status: "complete", phase: "complete",
        finalCursor: "cursor:0", pendingCursor: null, pendingHasMore: false, issueCount: 0 });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    await h.state.recordProgressRemoteObservation(...args, { kind: "revision",
      revision: "revision:10", cursor: "cursor:10", parentReadingEpoch: h.epochs[0],
      contentFingerprint: FA, checkpoint: { progress: 0.2, paragraphIndex: 2 } });
    await h.flow.writeRealMovement(id,
      h.resume.createCheckpoint({ progress: 0.3, paragraphIndex: 3 }, FA));
    const old = (await h.state.getProgressDesired(...args)).record;
    await h.library.updateArticle(id, { content: "Article B" });
    const second = await h.context(2, h.epochs[1], "Article B");
    await h.state.bindArticleRemoteRevision(...args, "revision:2", "b".repeat(64), "active", second);
    const afterB = await h.flow.evaluateCloudCandidate(...args);
    await h.flow.writeRealMovement(id,
      h.resume.createCheckpoint({ progress: 0.4, paragraphIndex: 4 }, FB));
    const newParent = (await h.state.getProgressDesired(...args)).record.confirmed.causalBase.parent;
    await h.library.updateArticle(id, { content: "Article A" });
    const third = await h.context(3, h.epochs[2], "Article A");
    await h.state.bindArticleRemoteRevision(...args, "revision:3", "c".repeat(64), "active", third);
    const afterA = await h.flow.evaluateCloudCandidate(...args);
    const deleted = { ...third, articleRevision: "revision:4", readingEpoch: crypto.randomUUID(), lifecycle: "deleted" };
    await h.library.updateArticle(id, { deletedAt: "2026-10-03T00:10:00.000Z" });
    await h.state.bindArticleRemoteRevision(...args, "revision:4", "d".repeat(64), "deleted", deleted);
    const afterDelete = await h.flow.evaluateCloudCandidate(...args);
    await h.library.updateArticle(id, { deletedAt: null });
    const restored = { ...third, articleRevision: "revision:5", readingEpoch: crypto.randomUUID() };
    await h.state.bindArticleRemoteRevision(...args, "revision:5", "e".repeat(64), "active", restored);
    const afterRestore = await h.flow.evaluateCloudCandidate(...args);
    const moved = await h.flow.writeRealMovement(id,
      h.resume.createCheckpoint({ progress: 0.5, paragraphIndex: 5 }, FA));
    const newest = (await h.state.getProgressDesired(...args)).record.confirmed.causalBase.parent;
    return { oldParent: old.confirmed.causalBase.parent, afterB, newParent, afterA,
      afterDelete, afterRestore, moved: moved.status, newest, restored };
  });
  expect(r.oldParent.readingEpoch).not.toBe(r.newParent.readingEpoch);
  expect(r.afterB.reason).toBe("parent-epoch-mismatch");
  expect(r.afterA.reason).toBe("parent-epoch-mismatch");
  expect(r.afterDelete.status).toBe("not-ready");
  expect(["stale-fence", "parent-epoch-mismatch"]).toContain(r.afterRestore.reason);
  expect(r.moved).toBe("confirmed");
  expect(r.newest).toEqual(r.restored);
});

test("an untouched E1 desired cannot revive when body bytes return to A under E3", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const h = window.contextTest;
    const article = await h.library.createArticle({ content: "Exact A bytes" });
    const id = article.id;
    const args = [h.owner.ownerId, h.owner.bindingId, id];
    const first = await h.context(1, h.epochs[0], article.content);
    await h.state.bindArticleRemoteRevision(...args, "revision:1", "a".repeat(64), "active", first);
    const bootstrap = await h.state.beginArticleBootstrap(h.owner.ownerId, h.owner.bindingId);
    const db = await h.state.openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("control", "readwrite");
      tx.objectStore("control").put({ ...bootstrap.state, status: "complete", phase: "complete",
        finalCursor: "cursor:0", pendingCursor: null, pendingHasMore: false, issueCount: 0 });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    await h.state.recordProgressRemoteObservation(...args, { kind: "revision",
      revision: "revision:10", cursor: "cursor:10", parentReadingEpoch: h.epochs[0],
      contentFingerprint: first.contentFingerprint,
      checkpoint: { progress: 0.1, paragraphIndex: 1 } });
    await h.flow.writeRealMovement(id,
      h.resume.createCheckpoint({ progress: 0.3, paragraphIndex: 3 }, first.contentFingerprint));
    await h.library.updateArticle(id, { content: "Different B bytes" });
    const second = await h.context(2, h.epochs[1], "Different B bytes");
    await h.state.bindArticleRemoteRevision(...args, "revision:2", "b".repeat(64), "active", second);
    await h.library.updateArticle(id, { content: "Exact A bytes" });
    const third = await h.context(3, h.epochs[2], "Exact A bytes");
    await h.state.bindArticleRemoteRevision(...args, "revision:3", "c".repeat(64), "active", third);
    const desired = (await h.state.getProgressDesired(...args)).record.confirmed;
    return { desired, third, gate: await h.flow.evaluateCloudCandidate(...args) };
  });
  expect(r.desired.causalBase.parent.contentFingerprint).toBe(r.third.contentFingerprint);
  expect(r.desired.causalBase.parent.readingEpoch).not.toBe(r.third.readingEpoch);
  expect(r.gate).toEqual({ status: "not-ready", reason: "parent-epoch-mismatch" });
});

test("Account Switch and same-owner new binding do not inherit context", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const h = window.contextTest;
    const id = "owner-scoped-context";
    const parent = await h.context(1, h.epochs[0], "Owned body");
    await h.state.bindArticleRemoteRevision(h.owner.ownerId, h.owner.bindingId,
      id, "revision:1", "a".repeat(64), "active", parent);
    await h.state.replaceWorkspaceBinding({ from: h.owner,
      to: { ownerId: "different-owner", bindingId: "different-binding" },
      accountLabel: "different@example.test" });
    const stale = await h.state.bindArticleRemoteRevision(h.owner.ownerId, h.owner.bindingId,
      id, "revision:2", "b".repeat(64), "active", { ...parent, articleRevision: "revision:2" });
    const other = await h.state.getArticleServerReadingContext("different-owner", "different-binding", id);
    const sameOwnerBinding = "new-binding";
    await h.state.replaceWorkspaceBinding({
      from: { ownerId: "different-owner", bindingId: "different-binding" },
      to: { ownerId: h.owner.ownerId, bindingId: sameOwnerBinding },
      accountLabel: "original@example.test"
    });
    const oldBindingCallback = await h.state.bindArticleRemoteRevision(
      h.owner.ownerId, h.owner.bindingId, id, "revision:3", "c".repeat(64),
      "active", { ...parent, articleRevision: "revision:3" });
    const sameOwner = await h.state.getArticleServerReadingContext(h.owner.ownerId, sameOwnerBinding, id);
    return { stale, other, oldBindingCallback, sameOwner };
  });
  expect(r.stale.status).toBe("blocked");
  expect(r.other.context).toBeNull();
  expect(r.oldBindingCallback).toMatchObject({ status: "blocked", reason: "workspace-binding-mismatch" });
  expect(r.sameOwner).toMatchObject({ status: "ready", context: null });
});
