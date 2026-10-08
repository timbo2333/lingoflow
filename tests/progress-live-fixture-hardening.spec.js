"use strict";

const { test, expect, chromium } = require("./progress-strict-test");
const fixture = require("./progress-live-fixture-helpers");
const runtime = require("./progress-live-fixture-runtime");
const { seedFromMockVerification, closeMockSession } = require("./progress-live-fixture-test-support");
test.afterEach(async ({ page }) => closeMockSession(page));
const { inspectExistingRuntime } = require("./progress-live-runtime-inspector");
const { trapProgressNetwork } = require("./progress-transport-helpers");
const E1 = "11111111-2222-4333-8444-555555555555", E2 = "22222222-2222-4333-8444-555555555555";
const TIME = "2026-10-04T00:00:00.000Z";
const def = fixture.definition("b3-2b-live-fixture-a-00000000-0000-4000-8000-000000000031",
  "00000000-0000-4000-8000-000000000032", "00000000-0000-4000-8000-000000000033", TIME);
const env = { LF_PROGRESS_LIVE_TEST: "1", LF_PROGRESS_FIXTURE_PREPARE: "1", LF_PROGRESS_OWNER_A: fixture.OWNER,
  LF_PROGRESS_JWT_A: "mock.test.only", LF_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_mock",
  LF_SUPABASE_URL: "https://yebabpjplbgidzwpjhoy.supabase.co" };
const clone = value => structuredClone(value);
function serverState() {
  const article = { ownerId: fixture.OWNER, articleId: def.articleId, title: fixture.TITLE,
    revision: "revision:1", cursor: "cursor:7", readingEpoch: E1, contentFingerprint: fixture.DIGEST,
    computedFingerprint: fixture.DIGEST, contentBytes: fixture.BYTES, lifecycle: "active", deletedAt: null,
    createdAt: TIME, updatedAt: TIME, serverCreatedAt: TIME, serverUpdatedAt: TIME };
  const progress = { ownerId: fixture.OWNER, articleId: def.articleId, revision: "revision:1", cursor: "cursor:9",
    parentReadingEpoch: E1, contentFingerprint: fixture.DIGEST, progress: 0.2, paragraphIndex: 4, serverUpdatedAt: TIME };
  return { article, progress, history: { articleChanges: "1", articleReceipts: "1", progressChanges: "1",
    progressReceipts: "1", articleSetupReceipt: "1", progressSetupReceipt: "1" },
  articleResult: { status: "applied", mutationId: def.articleMutationId, articleId: def.articleId,
    operation: "put", revision: article.revision, cursor: article.cursor, readingEpoch: E1, contentFingerprint: fixture.DIGEST },
  progressResult: { ...progress, status: "applied", mutationId: def.progressMutationId } };
}
// MOCK setup only. The actual preparation runner may never hydrate or invent these records.
async function setup(page) {
  await trapProgressNetwork(page); await page.goto("/");
  await page.evaluate(async input => {
    const r = window.LingoFlowSyncStateRepository, l = window.LingoFlowArticleLibrary;
    window.fixtureOwner = { ownerId: input.owner, bindingId: "hardening-binding" };
    window.LingoFlowSupabaseAuth = { getState: () => ({ status: "authenticated", user: { id: input.owner } }) };
    await r.bindWorkspace(fixtureOwner);
    await l.commitArticleSyncProjection(input.def.articleId, null, { id: input.def.articleId, title: input.title,
      content: input.content, sourceType: "paste", createdAt: input.def.createdAt, updatedAt: input.def.createdAt, deletedAt: null });
    await l.getProgressContext(input.def.articleId, fixtureOwner);
    await r.bindArticleRemoteRevision(input.owner, fixtureOwner.bindingId, input.def.articleId, "revision:1", "a".repeat(64), "active",
      { articleRevision: "revision:1", readingEpoch: input.epoch, contentFingerprint: input.digest, lifecycle: "active" });
    const bs = await r.beginArticleBootstrap(input.owner, fixtureOwner.bindingId), db = await r.openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("control", "readwrite");
      tx.objectStore("control").put({ ...bs.state, status: "complete", phase: "complete", finalCursor: "cursor:0",
        pendingCursor: null, pendingHasMore: false, issueCount: 0 }); tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
    });
    window.fixtureID = input.def.articleId;
    window.readFixtureObservation = async () => {
      const db = await r.openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("progressRemoteObservations", "readonly"); let row;
        tx.objectStore("progressRemoteObservations").get([input.owner, fixtureOwner.bindingId, fixtureID]).onsuccess = e => { row = e.target.result; };
        tx.oncomplete = () => resolve(row || null); tx.onabort = () => reject(tx.error);
      });
    };
  }, { owner: fixture.OWNER, def, content: fixture.CONTENT, digest: fixture.DIGEST, title: fixture.TITLE, epoch: E1 });
  const base = await page.evaluate(inspectExistingRuntime, { ownerId: fixture.OWNER, articleId: def.articleId, scopeOnly: true });
  return { gates: { live: true, fixture: true, dedicated: true }, definition: def,
    runtimeIdentity: "hardening-runtime", baseline: { ...base, runtimeIdentity: "hardening-runtime" },
    server: { article: serverState().article, progress: serverState().progress } };
}
async function verifiedSeed(page, input) { return seedFromMockVerification(page, input); }

test("P1-A parent advances during fingerprint await after final valid inspector", async ({ page }) => {
  const input = await setup(page);
  expect((await page.evaluate(inspectExistingRuntime, { ownerId: fixture.OWNER, articleId: def.articleId })).parent.readingEpoch).toBe(E1);
  const arm = () => page.evaluate(({ epoch, digest }) => {
    const original = LingoFlowReadingResume.fingerprintContent;
    window.LingoFlowReadingResume = { ...LingoFlowReadingResume, fingerprintContent: async content => {
      window.fixtureSeedHashHookRan = true;
      await LingoFlowSyncStateRepository.bindArticleRemoteRevision(fixtureOwner.ownerId, fixtureOwner.bindingId, fixtureID,
        "revision:2", "b".repeat(64), "active", { articleRevision: "revision:2", readingEpoch: epoch, contentFingerprint: digest, lifecycle: "active" });
      return original(content);
    } };
  }, { epoch: E2, digest: fixture.DIGEST });
  expect((await seedFromMockVerification(page, input, null, arm)).status).toBe("blocked");
  expect(await page.evaluate(() => window.fixtureSeedHashHookRan)).toBe(true);
  expect(await page.evaluate(() => readFixtureObservation())).toBeNull();
});
test("P1-B actual CDP same-document navigation after put must roll back", async () => {
  const browser = await chromium.launch({ args: ["--remote-debugging-port=19992", "--remote-debugging-address=127.0.0.1"] });
  let session;
  try {
    const page = await browser.newPage(), input = await setup(page);
    session = await runtime.openFixtureRuntimeSession({ ownerId: fixture.OWNER, articleId: def.articleId },
      { cdpURL: "http://127.0.0.1:19992/", runtimeURL: "http://127.0.0.1:4173/" });
    input.baseline = await session.captureScope();
    input.runtimeIdentity = input.baseline.runtimeIdentity;
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(...args) {
        const req = put.apply(this, args);
        if (this.name === "progressRemoteObservations") req.addEventListener("success", () => {
          window.fixturePutQueued = true; history.pushState({}, "", "/?fixture-navigation=1");
        });
        return req;
      };
    });
    await seedFromMockVerification(page, input, session);
    expect(await page.evaluate(() => window.fixturePutQueued)).toBe(true);
    expect(await page.evaluate(() => readFixtureObservation())).toBeNull();
  } finally { await session?.close(); await browser.close(); }
});
test("P2-A handwritten revision/cursor cannot enter exported seed", async ({ page }) => {
  const input = await setup(page); input.server.progress.revision = "revision:123456"; input.server.progress.cursor = "cursor:123456";
  expect(runtime).not.toHaveProperty("seedExistingFixtureObservation");
  const session = await runtime.openFixtureRuntimeSession({ ownerId: fixture.OWNER, articleId: def.articleId },
    { cdpURL: "http://127.0.0.1:19993/", runtimeURL: "http://127.0.0.1:4173/" });
  try { expect((await session.seedObservation(input)).status).toBe("blocked"); }
  finally { await session.close(); }
  expect(await page.evaluate(() => readFixtureObservation())).toBeNull();
});
for (const kind of ["article", "progress"]) test(`P2-B ${kind} mutation ID lookup uses owner-wide namespace`, () => {
  const sql = fixture.inspectionSQL(def);
  const countQuery = sql.match(new RegExp(`'${kind}SetupReceipt',\\(select count\\(\\*\\)::text from public\\.${kind}_sync_mutations ([^)]+)\\)`))[1];
  expect(countQuery).toContain("owner_id="); expect(countQuery).toContain("mutation_id=");
  expect(countQuery).not.toContain("article_id=");
});
for (const id of ["bad'", "bad;select 1", "bad\n", "`command`", "$(command)", "-- sql", "../path", "a".repeat(10000),
  "b3-contract-old", "b3-2b-live-fixture-a-invalid-uuid", def.articleId + "\n", def.articleId + "\r\n"]) test(`P2-C invalid ID ${id.slice(0, 20).replace(/\n/g, "newline")} length ${id.length} has zero IO`, async () => {
  const calls = []; const io = Object.fromEntries(["verifyOwner", "inspectServer", "articleSetup", "progressSeed", "openRuntime",
    "readJournal", "writeJournal", "acquireJournalLock", "releaseJournalLock"].map(name => [name, async () => { calls.push(name); return null; }]));
  expect((await fixture.runPreparation(env, { dedicatedTestAccount: true, articleId: id }, io)).status).toBe("NO-GO");
  expect(calls).toEqual([]);
});
for (const endpoint of ["article_sync_records", "rpc/lingoflow_progress_sync_push", "auth/v1/user"]) {
  test(`P2-D forbidden request ${endpoint} is counted even when aborted`, async () => {
    const routes = [], handlers = {};
    const page = { on: (event, fn) => { (handlers[event] ||= []).push(fn); }, route: async (pattern, fn) => routes.push({ pattern, fn }), addInitScript: async () => {} };
    await trapProgressNetwork(page);
    const request = { url: () => `https://yebabpjplbgidzwpjhoy.supabase.co/rest/v1/${endpoint}` };
    handlers.request.forEach(fn => fn(request));
    expect(page.forbiddenNetworkAttempts?.length).toBe(1);
    expect(() => require("./progress-forbidden-network").assertNoForbiddenNetwork(page.forbiddenNetworkAttempts)).toThrow("Forbidden network attempt count: 1");
  });
}

// Exercise the repository directly to prove the validation is inside the write
// transaction, not merely an extra orchestration inspector before it.
for (const field of ["epoch", "fingerprint", "lifecycle", "diagnostic", "fingerprint-only", "lifecycle-only"]) {
  for (const timing of ["before-transaction", "after-put"]) test(`parent ${field} ${timing}: actual SyncDB ordering`, async ({ page }) => {
    const input = await setup(page);
    const result = await page.evaluate(async ({ input, field, timing, e2 }) => {
      const repo = LingoFlowSyncStateRepository, db = await repo.openDatabase(), order = [];
      const nativeTx = IDBDatabase.prototype.transaction, nativePut = IDBObjectStore.prototype.put;
      let changed, armed = true, changedParent;
      const change = database => {
        changed = new Promise((resolve, reject) => {
          const tx = nativeTx.call(database, "articleSidecars", "readwrite"), table = tx.objectStore("articleSidecars");
          const req = table.get([fixtureOwner.ownerId, fixtureID]);
          req.onsuccess = () => {
            order.push("parent-write"); const row = req.result;
            if (!field.endsWith("-only")) {
              row.knownRevision = "revision:2"; row.serverReadingContext.articleRevision = "revision:2";
            }
            if (field === "epoch") row.serverReadingContext.readingEpoch = e2;
            if (field === "fingerprint") { row.serverReadingContext.readingEpoch = e2; row.serverReadingContext.contentFingerprint = "sha256:" + "b".repeat(64); }
            if (field === "lifecycle") { row.serverReadingContext.readingEpoch = e2; row.serverReadingContext.lifecycle = "deleted"; row.lastSyncedLifecycle = "deleted"; }
            if (field === "diagnostic") row.serverReadingContextDiagnostic = { reason: "inconsistent-parent-context" };
            if (field === "fingerprint-only") row.serverReadingContext.contentFingerprint = "sha256:" + "b".repeat(64);
            if (field === "lifecycle-only") row.serverReadingContext.lifecycle = "deleted";
            changedParent = structuredClone(row.serverReadingContext);
            table.put(row);
          };
          tx.oncomplete = () => { order.push("parent-commit"); resolve(); }; tx.onabort = () => reject(tx.error);
        });
      };
      IDBDatabase.prototype.transaction = function(names, mode, ...args) {
        const list = typeof names === "string" ? [names] : Array.from(names);
        const observation = this.name === "LingoFlowSyncDB" && mode === "readwrite" && list.includes("progressRemoteObservations");
        if (observation && armed && timing === "before-transaction") { armed = false; change(this); }
        const tx = nativeTx.call(this, names, mode, ...args);
        if (observation) tx.addEventListener("complete", () => order.push("observation-commit"));
        return tx;
      };
      IDBObjectStore.prototype.put = function(...args) {
        const req = nativePut.apply(this, args);
        if (this.name === "progressRemoteObservations") req.addEventListener("success", () => {
          order.push("put-success"); if (armed && timing === "after-put") { armed = false; change(db); }
        });
        return req;
      };
      const p = input.server.progress;
      const parent = { articleRevision: "revision:1", readingEpoch: p.parentReadingEpoch, contentFingerprint: p.contentFingerprint, lifecycle: "active" };
      try {
        const status = await repo.recordProgressRemoteObservation(fixtureOwner.ownerId, fixtureOwner.bindingId, fixtureID,
          { kind: "revision", revision: p.revision, cursor: p.cursor, parentReadingEpoch: p.parentReadingEpoch,
            contentFingerprint: p.contentFingerprint, checkpoint: { progress: p.progress, paragraphIndex: p.paragraphIndex } }, () => true, parent);
        await changed;
        return { status: status.status, row: await readFixtureObservation(), order, changedParent };
      } finally { IDBDatabase.prototype.transaction = nativeTx; IDBObjectStore.prototype.put = nativePut; }
    }, { input, field, timing, e2: E2 });
    if (field.endsWith("-only")) {
      expect(result.changedParent.articleRevision).toBe("revision:1");
      expect(result.changedParent.readingEpoch).toBe(E1);
      expect(result.changedParent.contentFingerprint).toBe(field === "fingerprint-only" ? "sha256:" + "b".repeat(64) : input.server.progress.contentFingerprint);
      expect(result.changedParent.lifecycle).toBe(field === "lifecycle-only" ? "deleted" : "active");
    }
    if (timing === "before-transaction") {
      expect(result.status).toBe("blocked"); expect(result.row).toBeNull();
      expect(result.order.indexOf("parent-commit")).toBeLessThan(result.order.indexOf("observation-commit"));
    } else {
      expect(result.status).toBe("recorded"); expect(result.row.parentReadingEpoch).toBe(E1);
      expect(result.order.indexOf("put-success")).toBeLessThan(result.order.indexOf("observation-commit"));
      expect(result.order.indexOf("parent-write")).toBeGreaterThan(result.order.indexOf("observation-commit"));
    }
  });
}

for (const field of ["lifecycle", "content", "fence", "scopeToken", "binding"]) {
  test(`Library ${field} remains locked THROUGH SyncDB commit`, async ({ page }) => {
    const input = await setup(page);
    await page.evaluate(async field => {
      window.libraryOrder = [];
      const db = await new Promise(resolve => { const r = indexedDB.open("LingoFlowLibraryDB"); r.onsuccess = () => resolve(r.result); });
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(...args) {
        const req = put.apply(this, args);
        if (this.name === "progressRemoteObservations") {
          this.transaction.addEventListener("complete", () => libraryOrder.push("sync-commit"));
          req.addEventListener("success", () => {
            libraryOrder.push("put-success");
            window.libraryChange = new Promise((resolve, reject) => {
              const name = ["lifecycle", "content"].includes(field) ? "articles" : field === "fence" ? "progressFences" : "progressControl";
              const tx = db.transaction(name, "readwrite"), table = tx.objectStore(name);
              libraryOrder.push("library-queued");
              const read = table.get(name === "progressControl" ? "workspace" : fixtureID);
              read.onsuccess = () => {
                libraryOrder.push("library-write"); const row = read.result;
                if (field === "lifecycle") row.deletedAt = "2026-10-04T00:00:01.000Z";
                if (field === "content") row.content += " changed";
                if (field === "fence") row.lifecycleToken += "-changed";
                if (field === "scopeToken") row.scopeToken += "-changed";
                if (field === "binding") row.bindingId += "-changed";
                table.put(row);
              };
              tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
            });
          });
        }
        return req;
      };
    }, field);
    await verifiedSeed(page, input);
    const order = await page.evaluate(async () => { await libraryChange; return libraryOrder; });
    expect(order).toContain("put-success");
    expect(order.indexOf("library-queued")).toBeLessThan(order.indexOf("sync-commit"));
    expect(order.indexOf("library-write")).toBeGreaterThan(order.indexOf("sync-commit"));
  });
}
test("private generation microtask AFTER put success aborts before commit", async ({ page }) => {
  const input = await setup(page);
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(...args) {
      const req = put.apply(this, args);
      if (this.name === "progressRemoteObservations") req.addEventListener("success", () => queueMicrotask(() => {
        window.fixturePutQueued = true;
        window.dispatchEvent(new CustomEvent("lingoflow:auth-state", { detail: { status: "authenticated" } }));
      }));
      return req;
    };
  });
  expect((await verifiedSeed(page, input)).status).toBe("blocked");
  expect(await page.evaluate(() => window.fixturePutQueued)).toBe(true);
  expect(await page.evaluate(() => readFixtureObservation())).toBeNull();
});
for (const action of ["push-same-url", "replace", "history-back", "reload", "close", "crash", "target-replacement"]) {
  test(`actual runtime ${action} after put has no durable observation`, async ({ page, context }) => {
    const input = await setup(page); let inspectedPage = page, session, queued = false, reloadCompletion;
    try {
      if (action === "history-back") await page.evaluate(() => history.pushState({}, "", "/?history-prior=1"));
      session = await runtime.openFixtureRuntimeSession({ ownerId: fixture.OWNER, articleId: def.articleId },
        { cdpURL: "http://127.0.0.1:19993/", runtimeURL: "http://127.0.0.1:4173/" });
      input.baseline = await session.captureScope(); input.runtimeIdentity = input.baseline.runtimeIdentity;
      await page.exposeFunction("fixtureDestroy", async () => {
        queued = true;
        if (action === "reload") { reloadCompletion = page.reload(); await reloadCompletion; }
        if (action === "close" || action === "target-replacement") await page.close({ runBeforeUnload: true });
        if (action === "crash") {
          const cdp = await context.newCDPSession(page);
          await cdp.send("Page.crash").catch(() => {});
        }
      });
      await page.evaluate(action => {
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function(...args) {
          const req = put.apply(this, args);
          if (this.name === "progressRemoteObservations") req.addEventListener("success", () => {
            window.fixturePutQueued = true;
            if (action === "push-same-url") history.pushState({}, "", location.href);
            else if (action === "replace") history.replaceState({}, "", "/?replace=1");
            else if (action === "history-back") history.back();
            else {
              // Keep the actual transaction pending until the real Document is
              // destroyed/cancelled, rather than testing a synthetic pagehide.
              const keep = () => {
                try { const get = this.get([fixtureOwner.ownerId, fixtureOwner.bindingId, fixtureID]); get.onsuccess = keep; } catch { /* aborted */ }
              };
              keep(); void window.fixtureDestroy();
            }
          });
          return req;
        };
      }, action);
      expect((await seedFromMockVerification(page, input, session)).status).toBe("blocked");
      if (["reload", "close", "crash", "target-replacement"].includes(action)) expect(queued).toBe(true);
      else expect(await page.evaluate(() => window.fixturePutQueued)).toBe(true);
      // Seed cancellation may settle before the replacement Document loads.
      // Read the durable state only after the test-triggered reload completes.
      if (action === "reload") await reloadCompletion;
      if (action !== "reload" && ["close", "crash", "target-replacement"].includes(action)) {
        inspectedPage = await context.newPage(); await trapProgressNetwork(inspectedPage); await inspectedPage.goto("/");
      }
      const row = await inspectedPage.evaluate(async ({ owner, articleId }) => {
        const db = await new Promise(resolve => { const req = indexedDB.open("LingoFlowSyncDB"); req.onsuccess = () => resolve(req.result); });
        return new Promise(resolve => {
          const tx = db.transaction("progressRemoteObservations", "readonly"); let value;
          tx.objectStore("progressRemoteObservations").get([owner, "hardening-binding", articleId]).onsuccess = e => { value = e.target.result; };
          tx.oncomplete = () => { db.close(); resolve(value || null); };
        });
      }, { owner: fixture.OWNER, articleId: def.articleId });
      expect(row).toBeNull();
      expect((await session.seedObservation(input)).status).toBe("blocked");
    } finally { await session?.close(); if (inspectedPage !== page) await inspectedPage.close(); }
  });
}
for (const field of ["revision", "cursor", "checkpoint", "epoch", "fingerprint"]) {
  test(`public runtime rejects handwritten ${field} without capability`, async ({ page }) => {
    const input = await setup(page);
    const session = await runtime.openFixtureRuntimeSession({ ownerId: fixture.OWNER, articleId: def.articleId },
      { cdpURL: "http://127.0.0.1:19993/", runtimeURL: "http://127.0.0.1:4173/" });
    try {
      input.baseline = await session.captureScope();
      if (field === "revision") input.server.progress.revision = "revision:123456";
      if (field === "cursor") input.server.progress.cursor = "cursor:123456";
      if (field === "checkpoint") input.server.progress.progress = 0.4;
      if (field === "epoch") input.server.progress.parentReadingEpoch = E2;
      if (field === "fingerprint") input.server.progress.contentFingerprint = "sha256:" + "b".repeat(64);
      expect((await session.seedObservation(input)).status).toBe("blocked");
      expect(await page.evaluate(() => readFixtureObservation())).toBeNull();
    } finally { await session.close(); }
  });
}
test("fresh capability is private, non-cloneable, single-use and absent from journal", async ({ page }) => {
  const input = await setup(page); let capability;
  const session = await runtime.openFixtureRuntimeSession({ ownerId: fixture.OWNER, articleId: def.articleId },
    { cdpURL: "http://127.0.0.1:19993/", runtimeURL: "http://127.0.0.1:4173/" });
  try {
    input.baseline = await session.captureScope(); input.runtimeIdentity = input.baseline.runtimeIdentity;
    const result = await seedFromMockVerification(page, input, session, async token => {
      capability = token;
      expect((await session.seedObservation(structuredClone(token))).status).toBe("blocked");
    });
    expect(result.status).toBe("recorded");
    expect((await session.seedObservation(capability)).status).toBe("blocked");
    expect(fixture.consumeVerifiedFixtureSeed(capability)).toBeNull();
    expect(Object.keys(capability)).toEqual([]);
  } finally { await session.close(); }
});
test("unconsumed capability revoked on interrupted preparation cannot seed later", async ({ page }) => {
  const input = await setup(page); let capability;
  const result = await seedFromMockVerification(page, input, null, token => { capability = token; throw new Error("mock interruption"); });
  expect(result.status).toBe("blocked"); expect(capability).toBeTruthy();
  expect(fixture.consumeVerifiedFixtureSeed(capability)).toBeNull();
  expect(await page.evaluate(() => readFixtureObservation())).toBeNull();
});
for (const kind of ["article", "progress"]) test(`${kind} receipt used on another Article stops before mutation`, async () => {
  const calls = []; let journal = null;
  const scope = { status: "ready", ownerId: fixture.OWNER, bindingId: "mock-binding", generation: 0,
    scopeToken: "mock-scope", runtimeIdentity: "mock-page", stable: true, transitionInactive: true };
  const io = { acquireJournalLock: async () => {}, releaseJournalLock: async () => {},
    readJournal: async () => journal, writeJournal: async j => { journal = j; }, verifyOwner: async () => fixture.OWNER,
    openRuntime: async () => ({ captureScope: async () => scope, close: async () => {} }),
    inspectServer: async (_scope, d) => {
      const sql = fixture.inspectionSQL(d), h = { articleChanges: "0", articleReceipts: "0", progressChanges: "0",
        progressReceipts: "0", articleSetupReceipt: "0", progressSetupReceipt: "0" };
      // Observed owner-wide receipt namespace: a different Article X already
      // used this exact M. An article_id filter would hide it from Article Y.
      const query = sql.match(new RegExp(`'${kind}SetupReceipt',\\(select count\\(\\*\\)::text from public\\.${kind}_sync_mutations ([^)]+)\\)`))[1];
      h[`${kind}SetupReceipt`] = query.includes("article_id=") ? "0" : "1";
      return { article: null, progress: null, history: h, articleResult: null, progressResult: null };
    }, articleSetup: async () => { calls.push("article"); }, progressSeed: async () => { calls.push("progress"); } };
  expect((await fixture.runPreparation(env, { dedicatedTestAccount: true, articleId: def.articleId }, io)).reason).toBe("fixture-history-collision");
  expect(calls).toEqual([]);
});
for (const path of ["rest/v1/article_sync_records", "rest/v1/rpc/lingoflow_progress_sync_push", "auth/v1/user", "unmocked-other-host"]) {
  test(`shared automatic teardown fails a forbidden ${path} attempt, not just aborts it`, async () => {
    const network = require("./progress-forbidden-network"), handlers = new Map(), routes = []; let aborted = 0;
    const context = { on: (event, fn) => handlers.set(event, fn), off: event => handlers.delete(event),
      addInitScript: async () => {}, route: async (pattern, fn) => routes.push({ pattern, fn }) };
    const request = { url: () => path === "unmocked-other-host" ? "https://unmocked.invalid/" : `https://yebabpjplbgidzwpjhoy.supabase.co/${path}` };
    await expect(network.runStrictNetworkCase(context, async () => {
      handlers.get("request")(request);
      await routes.find(r => r.pattern === "**/*").fn({ request: () => request, abort: async () => { aborted++; } });
    })).rejects.toThrow("Forbidden network attempt count: 1");
    expect(aborted).toBe(1); expect(handlers.size).toBe(0);
  });
}
for (const kind of ["higher", "contradictory-diagnostic"]) test(`guarded seed preserves existing ${kind} observation`, async ({ page }) => {
  const input = await setup(page);
  const previous = await page.evaluate(async ({ input, kind }) => {
    const repo = LingoFlowSyncStateRepository, p = input.server.progress;
    const fact = { kind: "revision", revision: kind === "higher" ? "revision:2" : p.revision,
      cursor: kind === "higher" ? "cursor:10" : p.cursor, parentReadingEpoch: p.parentReadingEpoch,
      contentFingerprint: p.contentFingerprint, checkpoint: { progress: 0.4, paragraphIndex: 4 } };
    await repo.recordProgressRemoteObservation(fixtureOwner.ownerId, fixtureOwner.bindingId, fixtureID, fact);
    if (kind !== "higher") await repo.recordProgressRemoteObservation(fixtureOwner.ownerId, fixtureOwner.bindingId, fixtureID,
      { ...fact, checkpoint: { progress: 0.5, paragraphIndex: 4 } });
    return readFixtureObservation();
  }, { input, kind });
  expect((await verifiedSeed(page, input)).status).toBe("blocked");
  expect(await page.evaluate(() => readFixtureObservation())).toEqual(previous);
});
for (const guard of ["false", "throw", "async"]) test(`optional repository ${guard} guard never commits`, async ({ page }) => {
  const input = await setup(page);
  const result = await page.evaluate(async ({ input, guard }) => {
    const p = input.server.progress;
    try {
      await LingoFlowSyncStateRepository.recordProgressRemoteObservation(fixtureOwner.ownerId, fixtureOwner.bindingId, fixtureID,
        { kind: "revision", revision: p.revision, cursor: p.cursor, parentReadingEpoch: p.parentReadingEpoch,
          contentFingerprint: p.contentFingerprint, checkpoint: { progress: p.progress, paragraphIndex: p.paragraphIndex } },
        guard === "false" ? () => false : guard === "throw" ? () => { throw new Error("mock-only"); } : async () => true);
    } catch { /* expected transaction cancellation */ }
    return readFixtureObservation();
  }, { input, guard });
  expect(result).toBeNull();
});
