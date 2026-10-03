const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  const forbidden = [];
  page.on("request", request => {
    if (/\/rpc\/.*(?:progress|article).*sync/i.test(request.url())) forbidden.push(request.url().split("?")[0]);
  });
  page.__causalRequests = forbidden;
  await page.route("https://**/*", route => route.abort());
  await page.addInitScript(() => localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1"));
  await page.goto("/");
  await page.evaluate(async () => {
    const repo = window.LingoFlowSyncStateRepository;
    const lib = window.LingoFlowArticleLibrary;
    const resume = window.LingoFlowReadingResume;
    const flow = window.LingoFlowProgressLocalDesired;
    const binding = { ownerId: "causal-owner", bindingId: "causal-binding" };
    await repo.bindWorkspace(binding);
    window.LingoFlowSupabaseAuth = { getState: () => ({ status: "authenticated", user: { id: binding.ownerId } }) };
    const article = await lib.createArticle({ content: "Causal local reading fixture content." });
    const fp = await resume.fingerprintContent(article.content);
    const E1 = "11111111-2222-4333-8444-555555555555";
    const E2 = "22222222-2222-4333-8444-555555555555";
    const args = [binding.ownerId, binding.bindingId, article.id];
    const parent = (rev = 1, e = E1, f = fp) => ({ articleRevision: `revision:${rev}`, readingEpoch: e,
      contentFingerprint: f, lifecycle: "active" });
    const observation = (rev = 10, e = E1) => ({ kind: "revision", revision: `revision:${rev}`,
      cursor: `cursor:${rev}`, parentReadingEpoch: e, contentFingerprint: fp,
      checkpoint: { progress: 0.2, paragraphIndex: 2 } });
    const absent = (high = 0, through = high) => ({ kind: "absent", evidence: {
      kind: "completed-inventory-catchup", highWaterCursor: `cursor:${high}`, throughCursor: `cursor:${through}` } });
    const raw = async (store, update) => {
      const db = await repo.openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        update(tx.objectStore(store));
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
    };
    const complete = async () => {
      const result = await repo.beginArticleBootstrap(binding.ownerId, binding.bindingId);
      await raw("control", store => store.put({ ...result.state, status: "complete", phase: "complete",
        finalCursor: "cursor:0", pendingCursor: null, pendingHasMore: false, issueCount: 0 }));
    };
    const setup = async (kind = "revision") => {
      await repo.bindArticleRemoteRevision(...args, "revision:1", "a".repeat(64), "active");
      await repo.recordArticleServerReadingContext(...args, parent());
      await complete();
      if (kind !== "unknown") await repo.recordProgressRemoteObservation(...args,
        kind === "absent" ? absent() : observation());
    };
    const target = n => resume.createCheckpoint({ progress: n, paragraphIndex: Math.round(n * 10) }, fp);
    const movement = n => flow.writeRealMovement(article.id, target(n));
    const prepare = async n => {
      const context = await lib.getProgressContext(article.id, binding);
      return repo.prepareProgressMovement({ ...binding, articleId: article.id, target: target(n),
        beforeResume: resume.normalizeCheckpoint(context.article.reading.resume),
        articleFence: context.fence, scope: context.scope });
    };
    const desired = async () => (await repo.getProgressDesired(...args)).record;
    const evaluate = () => flow.evaluateCloudCandidate(...args);
    const input = async () => {
      const snapshot = await repo.getProgressCausalSnapshot(...args);
      return { ...snapshot, scopeValid: true, transitionInactive: true, fenceValid: true,
        articleActive: true, cloudEligible: true, localFingerprint: fp };
    };
    window.h = { repo, lib, flow, resume, binding, article, fp, E1, E2, args, parent, observation,
      absent, raw, complete, setup, target, movement, prepare, desired, evaluate, input };
  });
});

test.afterEach(async ({ page }) => {
  expect(page.__causalRequests, "local causal operations must not call Article/Progress RPC").toEqual([]);
});

test("fresh v6: missing observation is explicit unknown, Library remains v3", async ({ page }) => {
  const r = await page.evaluate(async () => ({ observation: await h.repo.getProgressRemoteObservation(...h.args),
    sync: (await h.repo.openDatabase()).version, library: (await h.lib.openDatabase()).version }));
  expect(r).toEqual({ observation: { status: "ready", observation: { kind: "unknown" }, diagnostic: null }, sync: 6, library: 3 });
});

for (const kind of ["revision", "absent", "unknown"]) test(`real movement captures ${kind} without fabricating context`, async ({ page }) => {
  const r = await page.evaluate(async kind => {
    await h.setup(kind); await h.movement(0.3);
    return { base: (await h.desired()).confirmed.causalBase, gate: await h.evaluate() };
  }, kind);
  expect(r.base.kind).toBe(kind);
  expect(r.base.parent.articleRevision).toBe("revision:1");
  expect(r.gate).toEqual(kind === "unknown" ? { status: "not-ready", reason: "unknown-base" }
    : { status: "ready", mode: kind === "absent" ? "create" : "update" });
});

for (const bad of [null, { kind: "absent" }, { kind: "absent", evidence: { kind: "empty-pull" } },
  { kind: "absent", evidence: { kind: "completed-inventory-catchup", highWaterCursor: "cursor:3", throughCursor: "cursor:2" } },
  { kind: "absent", evidence: { kind: "timeout" } }, { changes: [], hasMore: false }, { kind: "unknown" }]) {
  test(`untrusted absence rejected: ${JSON.stringify(bad)}`, async ({ page }) => {
    const r = await page.evaluate(async bad => ({ write: await h.repo.recordProgressRemoteObservation(...h.args, bad),
      read: await h.repo.getProgressRemoteObservation(...h.args) }), bad);
    expect(r.write.status).toBe("invalid-observation");
    expect(r.read.observation).toEqual({ kind: "unknown" });
  });
}

test("server parent missing never uses projection hash or local fence as epoch", async ({ page }) => {
  const r = await page.evaluate(async () => {
    await h.repo.bindArticleRemoteRevision(...h.args, "revision:1", "a".repeat(64), "active");
    await h.repo.recordProgressRemoteObservation(...h.args, h.observation());
    await h.movement(0.3); return (await h.desired()).confirmed.causalBase;
  });
  expect(r.kind).toBe("revision"); expect(r.parent).toBeNull();
});

test("forward/backward coalescing retains base; observation advance cannot rebase; NEW movement captures advance", async ({ page }) => {
  const r = await page.evaluate(async () => {
    await h.setup();
    const positions = [];
    for (const n of [0.2, 0.4, 0.6, 0.8, 0.3]) {
      await h.movement(n); positions.push((await h.desired()).confirmed);
    }
    const before = await h.desired();
    await h.repo.recordProgressRemoteObservation(...h.args, h.observation(11));
    const after = await h.desired(); const stale = await h.evaluate();
    await h.movement(0.32);
    return { positions, before, after, stale, fresh: await h.desired(), gate: await h.evaluate(),
      outbox: (await h.repo.listArticleMutations(...h.args.slice(0, 2))).items };
  });
  expect(r.positions.map(v => v.checkpoint.progress)).toEqual([0.2, 0.4, 0.6, 0.8, 0.3]);
  expect(r.positions.map(v => v.causalBase.revision)).toEqual(Array(5).fill("revision:10"));
  expect(r.after).toEqual(r.before); expect(r.stale.reason).toBe("stale-base");
  expect(r.fresh.confirmed.causalBase.revision).toBe("revision:11");
  expect(r.gate).toEqual({ status: "ready", mode: "update" }); expect(r.outbox).toEqual([]);
});

for (const applied of [false, true]) test(`crash recovery preserves frozen base, Resume applied=${applied}`, async ({ page }) => {
  const r = await page.evaluate(async applied => {
    await h.setup(); const first = await h.prepare(0.3);
    if (applied) await h.lib.commitReadingResumeIfCurrent({ articleId: h.article.id,
      expectedContent: h.article.content, contentFingerprint: h.fp, beforeResume: null,
      target: first.pending.target, scope: first.pending.scope, expectedFence: first.pending.articleFence, action: first.pending });
    await h.repo.recordProgressRemoteObservation(...h.args, h.observation(11));
    await h.flow.reconcile(); const once = await h.desired();
    await h.flow.reconcile(); return { base: first.pending.causalBase, once, twice: await h.desired() };
  }, applied);
  expect(r.once.confirmed.causalBase).toEqual(r.base); expect(r.base.revision).toBe("revision:10");
  expect(r.twice).toEqual(r.once);
});

for (const field of ["pending", "confirmed"]) test(`legacy B2 ${field} stays unanchored, raw read does not migrate`, async ({ page }) => {
  const r = await page.evaluate(async field => {
    await h.setup();
    if (field === "pending") await h.prepare(0.3); else await h.movement(0.3);
    await h.raw("progressDesired", store => { const req = store.get(h.args); req.onsuccess = () => {
      delete req.result[field].causalBase; store.put(req.result);
    }; });
    const before = await h.desired();
    const db = await h.repo.openDatabase();
    const raw = await new Promise(resolve => { const req = db.transaction("progressDesired").objectStore("progressDesired").get(h.args);
      req.onsuccess = () => resolve(req.result); });
    await h.flow.reconcile(); return { before, raw, after: await h.desired(), gate: await h.evaluate() };
  }, field);
  expect(r.before[field].causalBase).toEqual({ kind: "unanchored", parent: null });
  expect(r.raw[field]).not.toHaveProperty("causalBase");
  expect(r.after.confirmed.causalBase).toEqual({ kind: "unanchored", parent: null });
  expect(r.gate.reason).toBe("unanchored");
});

test("prepare retry after transient failure reuses original base and localSeq", async ({ page }) => {
  const r = await page.evaluate(async () => {
    await h.setup(); const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, ...args) {
      if (this.name === "articles" && value.reading?.resume) {
        this.transaction.abort();
        throw new Error("fixture interruption");
      }
      return original.call(this, value, ...args);
    };
    const first = await h.movement(0.3); const before = await h.desired();
    await h.repo.recordProgressRemoteObservation(...h.args, h.observation(11));
    IDBObjectStore.prototype.put = original;
    const second = await h.movement(0.3); return { first, second, before, after: await h.desired() };
  });
  expect(r.first.status).toBe("retryable"); expect(r.second.status).toBe("confirmed");
  expect(r.after.localSeq).toBe(r.before.localSeq);
  expect(r.after.confirmed.causalBase).toEqual(r.before.pending.causalBase);
});

for (const order of ["before", "after"]) test(`atomic observation/context fixture ${order} prepare: no torn base`, async ({ page }) => {
  const r = await page.evaluate(async order => {
    await h.setup(); const db = await h.repo.openDatabase();
    const advance = () => new Promise((resolve, reject) => {
      const tx = db.transaction(["progressRemoteObservations", "articleSidecars"], "readwrite");
      tx.objectStore("progressRemoteObservations").put({ ...h.binding, articleId: h.article.id, ...h.observation(11, h.E2) });
      const side = tx.objectStore("articleSidecars"); const req = side.get([h.binding.ownerId, h.article.id]);
      req.onsuccess = () => side.put({ ...req.result, knownRevision: "revision:2",
        serverReadingContext: h.parent(2, h.E2) });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    // Start competing transactions without sleeps. Invocation order defines the IDB order.
    const context = await h.lib.getProgressContext(h.article.id, h.binding);
    const prepare = () => h.repo.prepareProgressMovement({ ...h.binding, articleId: h.article.id,
      target: h.target(0.3), beforeResume: null, scope: context.scope, articleFence: context.fence });
    let action;
    if (order === "before") { const update = advance(); action = prepare(); await update; }
    else { action = prepare(); await Promise.resolve(); await advance(); }
    return (await action).pending.causalBase;
  }, order);
  expect(r.revision).toBe(order === "before" ? "revision:11" : "revision:10");
  expect(r.parent.readingEpoch).toBe(order === "before" ? "22222222-2222-4333-8444-555555555555" : "11111111-2222-4333-8444-555555555555");
});

test("older observation cannot replace newer; weak or newer absence cannot erase existing row", async ({ page }) => {
  const r = await page.evaluate(async () => {
    await h.setup(); await h.repo.recordProgressRemoteObservation(...h.args, h.observation(11));
    return { old: await h.repo.recordProgressRemoteObservation(...h.args, h.observation(10)),
      absent: await h.repo.recordProgressRemoteObservation(...h.args, h.absent(20)),
      current: await h.repo.getProgressRemoteObservation(...h.args) };
  });
  expect(r.old.status).toBe("stale-observation"); expect(r.absent.status).toBe("absence-after-revision");
  expect(r.current.observation.revision).toBe("revision:11"); expect(r.current.diagnostic).toBeTruthy();
});

for (const field of ["parentReadingEpoch", "contentFingerprint", "checkpoint", "cursor"]) {
  test(`same revision inconsistent ${field} is durably diagnosed, desired unchanged`, async ({ page }) => {
    const r = await page.evaluate(async field => {
      await h.setup(); await h.movement(0.3); const before = await h.desired();
      const next = h.observation();
      next[field] = ({ parentReadingEpoch: h.E2, contentFingerprint: "sha256:" + "b".repeat(64),
        checkpoint: { progress: 0.4, paragraphIndex: 4 }, cursor: "cursor:11" })[field];
      const result = await h.repo.recordProgressRemoteObservation(...h.args, next);
      return { result, before, after: await h.desired(), current: await h.repo.getProgressRemoteObservation(...h.args), gate: await h.evaluate() };
    }, field);
    expect(r.result.status).toBe("inconsistent-observation"); expect(r.after).toEqual(r.before);
    expect(r.current.observation.cursor).toBe("cursor:10"); expect(r.current.diagnostic.reason).toBe("inconsistent-observation");
    expect(r.gate.reason).toBe("observation-anomaly");
  });
}

test("absence completion is monotonic, strengthens proof without rebasing desired", async ({ page }) => {
  const r = await page.evaluate(async () => {
    await h.setup("absent"); await h.movement(0.3); const before = await h.desired();
    await h.repo.recordProgressRemoteObservation(...h.args, h.absent(2, 3));
    return { before, after: await h.desired(), gate: await h.evaluate(),
      stale: await h.repo.recordProgressRemoteObservation(...h.args, h.absent()),
      inconsistent: await h.repo.recordProgressRemoteObservation(...h.args, { ...h.observation(), cursor: "cursor:2" }) };
  });
  expect(r.before).toEqual(r.after); expect(r.gate.mode).toBe("create");
  expect(r.stale.status).toBe("stale-observation"); expect(r.inconsistent.status).toBe("inconsistent-observation");
});

test("title-only newer Article revision does not stale desired", async ({ page }) => {
  const r = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    await h.repo.bindArticleRemoteRevision(...h.args, "revision:2", "b".repeat(64), "active");
    const result = await h.repo.recordArticleServerReadingContext(...h.args, h.parent(2));
    return { result, base: (await h.desired()).confirmed.causalBase, gate: await h.evaluate() };
  });
  expect(r.result.status).toBe("recorded"); expect(r.base.parent.articleRevision).toBe("revision:1"); expect(r.gate.mode).toBe("update");
});

test("old epoch action blocked; NEW E2 action can CAS against observed rev10/E1", async ({ page }) => {
  const r = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    await h.repo.bindArticleRemoteRevision(...h.args, "revision:2", "b".repeat(64), "active");
    await h.repo.recordArticleServerReadingContext(...h.args, h.parent(2, h.E2));
    const old = await h.evaluate(); await h.movement(0.4);
    return { old, base: (await h.desired()).confirmed.causalBase, gate: await h.evaluate() };
  });
  expect(r.old.reason).toBe("parent-epoch-mismatch"); expect(r.base.parentReadingEpoch).not.toBe(r.base.parent.readingEpoch);
  expect(r.base.revision).toBe("revision:10"); expect(r.gate).toEqual({ status: "ready", mode: "update" });
});

test("new content generation freezes E2/F2 while Progress base remains rev10/E1", async ({ page }) => {
  const r = await page.evaluate(async () => {
    await h.setup();
    await h.movement(0.3);
    const newContent = "A different article body defines a new reading generation.";
    const F2 = await h.resume.fingerprintContent(newContent);
    await h.lib.updateArticle(h.article.id, { content: newContent });
    await h.repo.bindArticleRemoteRevision(...h.args, "revision:2", "b".repeat(64), "active");
    await h.repo.recordArticleServerReadingContext(...h.args, h.parent(2, h.E2, F2));
    const old = await h.evaluate();
    const moved = await h.flow.writeRealMovement(h.article.id,
      h.resume.createCheckpoint({ progress: 0.4, paragraphIndex: 4 }, F2));
    return { old, moved: moved.status, base: (await h.desired()).confirmed.causalBase,
      gate: await h.evaluate(), F2 };
  });
  expect(r.old.reason).toBe("parent-epoch-mismatch");
  expect(r.moved).toBe("confirmed");
  expect(r.base.revision).toBe("revision:10");
  expect(r.base.parentReadingEpoch).toBe("11111111-2222-4333-8444-555555555555");
  expect(r.base.parent.readingEpoch).toBe("22222222-2222-4333-8444-555555555555");
  expect(r.base.contentFingerprint).not.toBe(r.F2);
  expect(r.base.parent.contentFingerprint).toBe(r.F2);
  expect(r.gate).toEqual({ status: "ready", mode: "update" });
});

test("server context rejects stale and inconsistent same-revision, retaining diagnostic", async ({ page }) => {
  const r = await page.evaluate(async () => {
    await h.setup(); await h.repo.recordArticleServerReadingContext(...h.args, h.parent(2));
    return { old: await h.repo.recordArticleServerReadingContext(...h.args, h.parent(1)),
      inconsistent: await h.repo.recordArticleServerReadingContext(...h.args, h.parent(2, h.E2)),
      current: await h.repo.getArticleServerReadingContext(...h.args) };
  });
  expect(r.old.status).toBe("stale-parent-context"); expect(r.inconsistent.status).toBe("inconsistent-parent-context");
  expect(r.current.context).toBeNull(); expect(r.current.diagnostic).toBeTruthy();
});

for (const [field, bad, reason] of [["scopeValid", false, "scope-mismatch"],
  ["transitionInactive", false, "workspace-transition"], ["fenceValid", false, "stale-fence"],
  ["articleActive", false, "parent-inactive"], ["cloudEligible", false, "parent-local-only"],
  ["hasConflict", true, "parent-conflict"], ["hasMutation", true, "parent-mutation-pending"],
  ["bootstrapSafe", false, "parent-bootstrap-unsafe"], ["localFingerprint", "sha256:" + "b".repeat(64), "fingerprint-mismatch"]]) {
  test(`pure evaluator gate: ${reason}`, async ({ page }) => {
    const r = await page.evaluate(async ({ field, bad }) => {
      await h.setup(); await h.movement(0.3);
      const input = await h.input(); input[field] = bad;
      return window.LingoFlowProgressCausalState.evaluate(input);
    }, { field, bad });
    expect(r).toEqual({ status: "not-ready", reason });
  });
}

test("async evaluator reads actual pending/bootstrap/conflict/outbox facts", async ({ page }) => {
  const r = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3); await h.prepare(0.4);
    const pending = await h.evaluate(); await h.flow.reconcile();
    const state = await h.repo.getArticleBootstrapState(...h.args.slice(0, 2));
    await h.raw("control", store => store.put({ ...state.state, phase: "catching-up", status: "in_progress" }));
    const bootstrap = await h.evaluate(); await h.complete();
    await h.raw("articleOutbox", store => store.put({ ...h.binding, articleId: h.article.id, mutationId: "fixture-pending", status: "prepared" }));
    const mutation = await h.evaluate();
    await h.raw("articleOutbox", store => store.delete([h.binding.ownerId, "fixture-pending"]));
    const key = "article-runtime-issue:" + window.LingoFlowSyncCanonical.serialize([...h.args]);
    await h.raw("control", store => store.put({ key, kind: "article-runtime-issue", ...h.binding, articleId: h.article.id }));
    return { pending, bootstrap, mutation, conflict: await h.evaluate() };
  });
  expect(r.pending.reason).toBe("pending-movement"); expect(r.bootstrap.reason).toBe("parent-bootstrap-unsafe");
  expect(r.mutation.reason).toBe("parent-mutation-pending"); expect(r.conflict.reason).toBe("parent-conflict");
});

test("Account Switch retains A observations but rejects all old-scope normal APIs", async ({ page }) => {
  const r = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    await h.repo.replaceWorkspaceBinding({ from: h.binding, to: { ownerId: "B", bindingId: "binding-B" }, accountLabel: "B" });
    const checks = await Promise.all([h.repo.getProgressRemoteObservation(...h.args),
      h.repo.listProgressRemoteObservations(...h.args.slice(0, 2)),
      h.repo.recordProgressRemoteObservation(...h.args, h.observation(11)), h.repo.getProgressCausalSnapshot(...h.args),
      h.repo.getArticleServerReadingContext(...h.args), h.repo.recordArticleServerReadingContext(...h.args, h.parent(2))]);
    const db = await h.repo.openDatabase();
    const retained = await new Promise(resolve => { const req = db.transaction("progressRemoteObservations").objectStore("progressRemoteObservations").get(h.args);
      req.onsuccess = () => resolve(req.result); });
    return { checks, retained, B: await h.repo.listProgressRemoteObservations("B", "binding-B"), gate: await h.evaluate() };
  });
  expect(r.checks.every(c => c.status === "blocked")).toBe(true);
  expect(r.retained.revision).toBe("revision:10"); expect(r.B.records).toEqual([]); expect(r.gate.reason).toBe("scope-mismatch");
});

test("anonymous movement remains local-only and never creates observation or desired", async ({ page }) => {
  const r = await page.evaluate(async () => {
    window.LingoFlowSupabaseAuth = { getState: () => ({ status: "anonymous" }) };
    const result = await h.movement(0.3);
    return { result: result.status, desired: await h.desired(), observation: await h.repo.getProgressRemoteObservation(...h.args) };
  });
  expect(r.result).toBe("local-only"); expect(r.desired).toBeNull(); expect(r.observation.observation.kind).toBe("unknown");
});

test("malformed stored base fails closed, rather than becoming absent", async ({ page }) => {
  const r = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    await h.raw("progressDesired", store => { const req = store.get(h.args); req.onsuccess = () => {
      req.result.confirmed.causalBase = { kind: "absent", parent: null }; store.put(req.result);
    }; });
    return { read: await h.repo.getProgressDesired(...h.args), gate: await h.evaluate() };
  });
  expect(r.read.status).toBe("malformed-progress-record"); expect(r.gate.status).toBe("not-ready");
});

test("absent base becomes dynamically stale after first observed revision", async ({ page }) => {
  const r = await page.evaluate(async () => {
    await h.setup("absent"); await h.movement(0.3); const before = await h.desired();
    await h.repo.recordProgressRemoteObservation(...h.args, h.observation());
    return { before, after: await h.desired(), gate: await h.evaluate() };
  });
  expect(r.before).toEqual(r.after); expect(r.gate.reason).toBe("stale-base");
});

test("evaluation is read-only, and checks a real Library workspace transition", async ({ page }) => {
  const r = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const writes = [];
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function(names, mode, ...rest) {
      if (mode === "readwrite") writes.push([this.name, names]);
      return original.call(this, names, mode, ...rest);
    };
    let gate;
    try { gate = await h.evaluate(); } finally { IDBDatabase.prototype.transaction = original; }
    const db = await h.lib.openDatabase();
    await new Promise(resolve => { const tx = db.transaction("progressControl", "readwrite");
      tx.objectStore("progressControl").put({ key: "workspace-transition", transitionId: "fixture" }); tx.oncomplete = resolve; });
    return { writes, gate, blocked: await h.evaluate() };
  });
  expect(r.writes).toEqual([]); expect(r.gate.status).toBe("ready"); expect(r.blocked.reason).toBe("workspace-transition");
});

test("pending remote Article apply blocks locally evaluated readiness", async ({ page }) => {
  const r = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    await h.raw("control", store => store.put({ key: "article-runtime-pending:fixture",
      kind: "article-runtime-pending-change", ...h.binding, articleId: h.article.id, cursor: "cursor:99" }));
    return h.evaluate();
  });
  expect(r.reason).toBe("parent-mutation-pending");
});

test("observation and parent context are durable across close/reopen", async ({ page }) => {
  const r = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3); const before = await h.desired();
    await h.repo.closeDatabase();
    return { before, after: await h.desired(), observation: await h.repo.getProgressRemoteObservation(...h.args), gate: await h.evaluate() };
  });
  expect(r.before).toEqual(r.after); expect(r.observation.observation.revision).toBe("revision:10"); expect(r.gate.mode).toBe("update");
});

test("two connections: higher revision wins without rebasing prepared action", async ({ page, context }) => {
  const fixture = await page.evaluate(async () => {
    await h.setup(); await h.prepare(0.3);
    return { args: h.args, observation: h.observation(12) };
  });
  const other = await context.newPage();
  try {
    await other.goto("/");
    const results = await Promise.all([
      other.evaluate(async f => window.LingoFlowSyncStateRepository.recordProgressRemoteObservation(...f.args, f.observation), fixture),
      page.evaluate(async () => h.repo.recordProgressRemoteObservation(...h.args, h.observation(11)))
    ]);
    expect(results[0].status).toBe("recorded");
    const r = await page.evaluate(async () => ({ observation: await h.repo.getProgressRemoteObservation(...h.args), desired: await h.desired() }));
    expect(r.observation.observation.revision).toBe("revision:12");
    expect(r.desired.pending.causalBase.revision).toBe("revision:10");
  } finally { await other.close(); }
});

test("context revision never drops below established Article knownRevision", async ({ page }) => {
  const r = await page.evaluate(async () => {
    await h.setup();
    await h.repo.bindArticleRemoteRevision(...h.args, "revision:5", "b".repeat(64), "active");
    return { old: await h.repo.recordArticleServerReadingContext(...h.args, h.parent(4)),
      read: await h.repo.getArticleServerReadingContext(...h.args) };
  });
  expect(r.old.status).toBe("stale-parent-context"); expect(r.read.context).toBeNull();
});

test("conflicting known lifecycle cannot leave optional server context trusted", async ({ page }) => {
  const r = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    await h.repo.setArticleSidecarLifecycle(...h.args, "revision:1", "deleted");
    return { read: await h.repo.getArticleServerReadingContext(...h.args), gate: await h.evaluate() };
  });
  expect(r.read.context).toBeNull(); expect(r.gate.reason).toBe("parent-context-unknown");
});

test("bootstrap complete label alone is insufficient without scope and final cursor", async ({ page }) => {
  const r = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const { state } = await h.repo.getArticleBootstrapState(...h.args.slice(0, 2));
    const results = [];
    for (const override of [{ finalCursor: null }, { ownerId: "other-owner" }, { bindingId: "other-binding" }]) {
      await h.raw("control", store => store.put({ ...state, ...override }));
      results.push(await h.evaluate());
    }
    return results;
  });
  expect(r.every(gate => gate.reason === "parent-bootstrap-unsafe")).toBe(true);
});

test("Article rebinding without additive fields retains a known server context", async ({ page }) => {
  const r = await page.evaluate(async () => {
    await h.setup();
    const before = await h.repo.getArticleServerReadingContext(...h.args);
    const same = await h.repo.bindArticleRemoteRevision(...h.args,
      "revision:1", "a".repeat(64), "active");
    const afterSame = await h.repo.getArticleServerReadingContext(...h.args);
    const newer = await h.repo.bindArticleRemoteRevision(...h.args,
      "revision:2", "b".repeat(64), "active");
    const afterNewer = await h.repo.getArticleServerReadingContext(...h.args);
    const raw = (await h.repo.getArticleSidecar(...h.args)).sidecar;
    return { before, same: same.status, afterSame, newer: newer.status, afterNewer,
      rawContext: raw.serverReadingContext };
  });
  expect(r.same).toBe("bound"); expect(r.newer).toBe("bound");
  expect(r.afterSame.context).toEqual(r.before.context);
  expect(r.rawContext).toEqual(r.before.context);
  expect(r.afterNewer.context).toBeNull(); // older evidence stays durable but is no longer trusted
});

test("same owner with a new binding never inherits old observation or desired", async ({ page }) => {
  const r = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.3);
    const newBinding = "different-binding";
    await h.raw("control", store => store.put({ key: "workspace-binding",
      ownerId: h.binding.ownerId, bindingId: newBinding }));
    const oldObservation = await h.repo.getProgressRemoteObservation(...h.args);
    const oldDesired = await h.repo.getProgressDesired(...h.args);
    const nextObservation = await h.repo.getProgressRemoteObservation(h.binding.ownerId, newBinding, h.article.id);
    const nextDesired = await h.repo.getProgressDesired(h.binding.ownerId, newBinding, h.article.id);
    const staleWrite = await h.repo.recordProgressRemoteObservation(...h.args, h.observation(11));
    return { oldObservation, oldDesired, nextObservation, nextDesired, staleWrite };
  });
  expect(r.oldObservation.status).toBe("blocked"); expect(r.oldDesired.status).toBe("blocked");
  expect(r.staleWrite.status).toBe("blocked");
  expect(r.nextObservation.observation).toEqual({ kind: "unknown" });
  expect(r.nextDesired.record).toBeNull();
});

test("legacy mixed confirmed/pending/quarantine retains provenance through recovery", async ({ page }) => {
  const r = await page.evaluate(async () => {
    await h.setup(); await h.movement(0.2); await h.prepare(0.4);
    await h.raw("progressDesired", store => {
      const request = store.get(h.args);
      request.onsuccess = () => {
        const record = request.result;
        delete record.confirmed.causalBase;
        delete record.pending.causalBase;
        record.quarantined = { pending: { ...record.pending, actionId: "older-quarantined" },
          reason: "historical-conflict" };
        store.put(record);
      };
    });
    const before = await h.desired();
    const first = await h.flow.reconcile();
    const after = await h.desired();
    await h.repo.recordProgressRemoteObservation(...h.args, h.observation(11));
    return { before, first, after, unchanged: await h.desired() };
  });
  expect(r.before.confirmed.causalBase).toEqual({ kind: "unanchored", parent: null });
  expect(r.before.pending.causalBase).toEqual({ kind: "unanchored", parent: null });
  expect(r.before.quarantined.pending.actionId).toBe("older-quarantined");
  expect(r.first.results[0].status).toBe("confirmed");
  expect(r.after.confirmed.causalBase).toEqual({ kind: "unanchored", parent: null });
  expect(r.after.confirmed.checkpoint.progress).toBe(0.4);
  expect(r.after.quarantined).toEqual(r.before.quarantined);
  expect(r.unchanged).toEqual(r.after);
});

test("anonymous Resume is not promoted into desired after login", async ({ page }) => {
  const r = await page.evaluate(async () => {
    const real = window.LingoFlowSupabaseAuth;
    window.LingoFlowSupabaseAuth = { getState: () => ({ status: "anonymous" }) };
    const local = await h.movement(0.3);
    window.LingoFlowSupabaseAuth = real;
    const recovery = await h.flow.reconcile();
    return { local: local.status, recovery, desired: await h.desired(),
      observation: await h.repo.getProgressRemoteObservation(...h.args) };
  });
  expect(r.local).toBe("local-only"); expect(r.recovery.results).toEqual([]);
  expect(r.desired).toBeNull(); expect(r.observation.observation.kind).toBe("unknown");
});
