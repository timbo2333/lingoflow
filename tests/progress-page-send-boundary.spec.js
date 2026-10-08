"use strict";

// This suite deliberately uses native (unwrapped) browser fetch. It installs its
// OWN default-deny route/request spy on every context, rather than the shared
// announcement fetch wrapper. All pages/DBs/CDP belong to isolated Chromium.
const { test: base, expect } = require("@playwright/test");
const fixture = require("./progress-live-fixture-helpers");
const { openFixtureRuntimeSession } = require("./progress-live-fixture-runtime");
const { articlePushArgs, progressPushArgs, freezePlainWire } = require("./progress-fixture-wire");
const { withPageAuthorityBarriers } = require("./progress-page-authority-barriers");
const { createHash } = require("node:crypto");
const { createExecutionAdapter, openLocalFixtureTestPage, inspectLocalFixtureTestPage,
  readLocalFixtureTestEvidence } = require("./progress-live-fixture-adapter");
const runner = require("../scripts/progress-live-fixture-prepare");
const fs = require("node:fs/promises");
const path = require("node:path");
const test = base.extend({ page: async ({ browser }, use) => {
  const page = await openLocalFixtureTestPage(browser);
  try { await use(page); }
  finally {
    expect(inspectLocalFixtureTestPage(page).externalRequests).toBe(0);
    await page.context().close();
  }
}, _nativeNetwork: [async ({ context }, use) => {
  const violations = [];
  context.on("request", request => {
    if (new URL(request.url()).origin !== "http://127.0.0.1:4173") violations.push("external-request");
  });
  await context.route("**/*", route => new URL(route.request().url()).origin === "http://127.0.0.1:4173"
    ? route.fallback() : route.abort());
  await use();
  expect(violations).toEqual([]);
  for (const page of context.pages()) {
    if (!page.isClosed()) expect(await page.evaluate(() => window.forbiddenUpdateCalls || 0)).toBe(0);
  }
}, { auto: true }] });
test.use({ launchOptions: { args: ["--remote-debugging-port=19993", "--remote-debugging-address=127.0.0.1",
  "--enable-automation", "--disable-extensions"] } });
const PROJECT = "https://yebabpjplbgidzwpjhoy.supabase.co";
const KEY = "sb_publishable_mock_native";
const ARTICLE = "b3-2b-live-fixture-a-00000000-0000-4000-8000-000000000091";
const MUTATION = "00000000-0000-4000-8000-000000000092";
const PROGRESS_MUTATION = "00000000-0000-4000-8000-000000000094";
const DATE = "2026-10-07T00:00:00.000Z";
const EPOCH = "00000000-0000-4000-8000-000000000093";
const SDK = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js";
const INTEGRITY = "sha256-WdOUh8NYmEO0EDItij1WLOAiq6HlzLFomO8/sqDaLs0=";
const scripts = ["reading-resume", "article-library", "article-sync-size", "article-sync-projection",
  "sync-canonical", "cloud-sync-protocol", "progress-causal-state", "progress-cloud-result",
  "sync-state-repository", "progress-local-desired"];

async function setup(page, { authOwner = fixture.OWNER, storage = "valid", delayedResponse = false,
  earlyReplacement = null } = {}) {
  const requests = [], events = [];
  const state = { article: null, progress: null, articleResult: null, progressResult: null,
    history: { articleChanges: "0", articleReceipts: "0", progressChanges: "0", progressReceipts: "0",
      articleSetupReceipt: "0", progressSetupReceipt: "0" } };
  const acceptArticle = m => {
    state.article = { ownerId: fixture.OWNER, articleId: ARTICLE, title: fixture.TITLE,
      revision: "revision:1", cursor: "cursor:1", readingEpoch: EPOCH, contentFingerprint: fixture.DIGEST,
      computedFingerprint: fixture.DIGEST, contentBytes: fixture.BYTES, lifecycle: "active", deletedAt: null,
      createdAt: m.projection.createdAt, updatedAt: m.projection.updatedAt,
      serverCreatedAt: DATE, serverUpdatedAt: DATE };
    state.articleResult = { status: "applied", operation: "put", articleId: ARTICLE, mutationId: m.mutationId,
      revision: "revision:1", cursor: "cursor:1", readingEpoch: EPOCH, contentFingerprint: fixture.DIGEST };
    state.history.articleChanges = state.history.articleReceipts = state.history.articleSetupReceipt = "1";
  };
  await page.route("http://127.0.0.1:4173/", route => route.fulfill({ contentType: "text/html", body:
    `<!doctype html><title>Isolated native Page Send</title><script>
    window.scriptPhases=['inline']; window.wrapperCalls=0;
    const replaceFetch=()=>{const native=window.fetch; window.fetch=(...args)=>{
      window.wrapperCalls++;window.dispatchEvent(new CustomEvent('lingoflow:auth-state'));return native(...args);};};
    if (${JSON.stringify(earlyReplacement)}==='inline') replaceFetch();
    addEventListener('DOMContentLoaded',()=>scriptPhases.push('DCL'));
    addEventListener('load',()=>{scriptPhases.push('load');
      if (${JSON.stringify(earlyReplacement)}==='load') replaceFetch();
      // The old late-iframe path would synchronously inherit this wrapper.
      addEventListener('load',event=>{if(event.target?.tagName==='IFRAME'){
        const realm=event.target.contentWindow, original=realm.fetch;
        realm.fetch=(...args)=>{window.wrapperCalls++;
          window.dispatchEvent(new CustomEvent('lingoflow:auth-state'));return original.apply(realm,args);};
      }},true);
    });
    window.LingoFlowSupabaseConfig=Object.freeze({projectUrl:${JSON.stringify(PROJECT)},publishableKey:${JSON.stringify(KEY)}});
    window.mockOwner=${JSON.stringify(fixture.OWNER)};
    window.LingoFlowSupabaseAuth={getState:()=>({status:'authenticated',user:{id:window.mockOwner}})};
    </script><script defer src='/__phase/defer'></script><script async src='/__phase/async'></script>
    <script type='module' src='/__phase/module'></script>
    ${scripts.map(name => `<script src="/js/${name}.js"></script>`).join("")}` }));
  await page.route("**/__phase/*", route => route.fulfill({ contentType: "application/javascript",
    body: `window.scriptPhases.push(${JSON.stringify(route.request().url().split("/").at(-1))});` }));
  await page.route("**/auth/v1/user", route => route.fulfill({ json: { id: authOwner } }));
  let release;
  const responseGate = new Promise(resolve => { release = resolve; });
  await page.route("**/rest/v1/rpc/*", async route => {
    requests.push(route.request().url().endsWith("lingoflow_article_sync_push") ? "article" : "progress");
    events.push("fetch-marker");
    if (delayedResponse) await responseGate;
    const m = route.request().postDataJSON().p_mutation;
    const result = { status: "applied", articleId: m.articleId, mutationId: m.mutationId,
      revision: "revision:1", cursor: "cursor:1", contentFingerprint: fixture.DIGEST };
    if (requests.at(-1) === "article") Object.assign(result, { operation: "put", readingEpoch: EPOCH });
    else Object.assign(result, { parentReadingEpoch: EPOCH, progress: 0.2, paragraphIndex: 4,
      serverUpdatedAt: DATE });
    if (requests.at(-1) === "article") acceptArticle(m);
    else {
      state.progress = { ownerId: fixture.OWNER, articleId: ARTICLE, revision: "revision:1", cursor: "cursor:1",
        parentReadingEpoch: EPOCH, contentFingerprint: fixture.DIGEST, progress: 0.2, paragraphIndex: 4, serverUpdatedAt: DATE };
      state.progressResult = { ...result };
      state.history.progressChanges = state.history.progressReceipts = state.history.progressSetupReceipt = "1";
    }
    // Deliberately unallowlisted fields must NOT be returned over CDP.
    result.content = "unallowlisted-response-content";
    result.session = { access_token: "fake-response-only-not-a-browser-token" };
    await route.fulfill({ json: result }).catch(() => {});
  });
  await page.goto("/");
  await page.evaluate(async ({ owner, articleId, content, storage, sdk, integrity }) => {
    // Explicit FAKE PIN metadata. This test exercises the storage/boundary code,
    // not native CDN/SRI trust (already covered by the sealed PIN gate).
    const metadata = document.createElement("script");
    metadata.type = "application/json"; metadata.src = sdk; metadata.integrity = integrity;
    metadata.crossOrigin = "anonymous"; document.head.appendChild(metadata);
    const scope = { ownerId: owner, bindingId: "native-binding" };
    await LingoFlowSyncStateRepository.bindWorkspace(scope);
    await LingoFlowArticleLibrary.commitArticleSyncProjection(articleId, null, {
      id: articleId, title: "Fake boundary Article", content, sourceType: "paste",
      createdAt: "2026-10-07T00:00:00.000Z", updatedAt: "2026-10-07T00:00:00.000Z", deletedAt: null });
    await LingoFlowArticleLibrary.getProgressContext(articleId, scope);
    // Trap forbidden UPDATE APIs; forward the REAL private-generation capture.
    const flow = LingoFlowProgressLocalDesired;
    window.LingoFlowProgressLocalDesired = new Proxy(flow, { get(target, name) {
      if (["dispatchProgressCloudAttempt", "prepareProgressCloudAttempt", "reserveCloudAttemptForDispatch"].includes(name)) {
        window.forbiddenUpdateCalls = (window.forbiddenUpdateCalls || 0) + 1;
        throw new Error("Forbidden client UPDATE API");
      }
      return Reflect.get(target, name);
    } });
    const state = { access_token: "fake-browser-token-one", refresh_token: "fake-browser-refresh",
      token_type: "bearer", expires_in: 3600, expires_at: 2000000000, user: { id: owner } };
    if (storage !== "valid") {
      if (storage === "missing") return;
      if (storage === "invalid-json") { localStorage.setItem("sb-yebabpjplbgidzwpjhoy-auth-token", "{"); return; }
      if (storage === "missing-token") delete state.access_token;
      if (storage === "malformed-user") state.user = [];
      if (storage === "invalid-type") state.token_type = "unknown";
      if (storage === "invalid-expiry") state.expires_at = "2000000000";
      if (storage === "envelope") { localStorage.setItem("sb-yebabpjplbgidzwpjhoy-auth-token", JSON.stringify({ session: state })); return; }
      if (storage === "storage-denied") {
        Object.defineProperty(window, "localStorage", { get() { throw new DOMException("denied", "SecurityError"); } }); return;
      }
    }
    localStorage.setItem("sb-yebabpjplbgidzwpjhoy-auth-token", JSON.stringify(state));
  }, { owner: fixture.OWNER, articleId: ARTICLE, content: fixture.CONTENT, storage, sdk: SDK, integrity: INTEGRITY });
  // Public runtime is READ-ONLY. Native sends below can only start through
  // createExecutionAdapter.execute() with a real durable attempted journal.
  const readonly = await openFixtureRuntimeSession({ ownerId: fixture.OWNER, articleId: ARTICLE }, {
    cdpURL: "http://127.0.0.1:19993/", runtimeURL: "http://127.0.0.1:4173/", exactRuntimeURL: true,
    isolatedMock: true, holdInvalidationNotifications: true
  });
  const scope = await readonly.captureScope();
  expect(fixture.scopeReady(scope)).toBe(true);
  let adapter, execution, preparationTask, sendingTransport, report, activeLane, privateOutcome, resumeDispatch, enteredDispatch, consumed = false;
  const entered = new Promise(resolve => { enteredDispatch = resolve; });
  const queue = new Promise(resolve => { resumeDispatch = resolve; });
  // Observe/pause ONLY the already-authorized CDP dispatch. This test spy cannot
  // mint a permit or expose a runtime mutation API; private validation precedes it.
  const probe = await page.context().newCDPSession(page), prototype = Object.getPrototypeOf(probe);
  const send = prototype.send;
  prototype.send = async function(method, args) {
    if (method === "Runtime.callFunctionOn" && args?.functionDeclaration === "function(ticket){return this.dispatch(ticket)}") {
      sendingTransport = this;
      enteredDispatch(); await queue;
      const result = await send.call(this, method, args);
      privateOutcome = result.result?.value; return result;
    }
    return send.call(this, method, args);
  };
  await probe.detach();
  const chromium = require("playwright").chromium, connect = chromium.connectOverCDP;
  chromium.connectOverCDP = async (...args) => {
    const browser = await connect.apply(chromium, args);
    return browser;
  };
  const options = { dedicatedTestAccount: true, executeLiveFixture: true, articleId: ARTICLE,
    cdpURL: "http://127.0.0.1:19993/", runtimeURL: "http://127.0.0.1:4173/",
    isolatedMock: true, holdInvalidationNotifications: true };
  const fakeEnv = { LF_PROGRESS_LIVE_TEST: "1", LF_PROGRESS_FIXTURE_PREPARE: "1",
    LF_SUPABASE_URL: PROJECT, LF_SUPABASE_PUBLISHABLE_KEY: KEY, LF_PROGRESS_OWNER_A: fixture.OWNER,
    LF_PROGRESS_JWT_A: "synthetic.terminal.never-enters-page" };
  const dependencies = {
    files: { ...fs, readFile: async (file, ...rest) => file.endsWith("supabase/.temp/project-ref")
      ? "yebabpjplbgidzwpjhoy\n" : fs.readFile(file, ...rest) },
    verifyOwner: async () => fixture.OWNER,
    inspectServer: async () => {
      // Single-lane transport assertions intentionally stop before Progress
      // seed when testing Article. No synthetic success or second send.
      if (activeLane === "article" && state.article && state.articleInspected) throw new Error("isolated-single-lane-stop");
      if (state.article) state.articleInspected = true;
      const { articleInspected, ...facts } = state;
      return structuredClone(facts);
    },
    fetchImpl: () => { throw new Error("Uninjected Node HTTP forbidden"); }
  };
  const prepare = lane => {
    if (preparationTask) return preparationTask.then(async () => {
      await expect(adapter.execute()).rejects.toThrow("fixture-execution-not-authorized");
      throw new Error("runtime-scope-changed");
    });
    preparationTask = (async () => {
    activeLane = lane;
    if (lane === "progress") {
      const def = fixture.definition(ARTICLE, MUTATION, PROGRESS_MUTATION, DATE);
      acceptArticle({ mutationId: MUTATION, projection: { createdAt: DATE, updatedAt: DATE } });
      const dir = await fs.mkdtemp(path.join(require("node:os").tmpdir(), "lingoflow-progress-fixture-"));
      options.journalPath = path.join(dir, "preparation.json");
      const journal = await runner.createJournalStore(options.journalPath);
      await journal.acquireJournalLock();
      try { await journal.writeJournal({ ...fixture.newJournal(def), articleAttempted: true,
        article: state.article, stage: "article_created", completedStage: "article_created" }); }
      finally { await journal.releaseJournalLock(); }
    }
    adapter = await createExecutionAdapter(fakeEnv, options, dependencies);
    execution = adapter.execute().then(value => { report = adapter.report(value); return report; });
    await Promise.race([entered, execution.then(() => { throw new Error(report.reason || "runtime-scope-changed"); })]);
    return Object.freeze({});
    })();
    return preparationTask;
  };
  const dispatch = async () => {
    if (consumed) {
      await expect(adapter.execute()).rejects.toThrow("fixture-execution-not-authorized");
      throw new Error("fixture-send-authority-missing");
    }
    consumed = true; resumeDispatch(); await execution;
    return privateOutcome || { invoked: null, reason: "page-send-unknown" };
  };
  const close = async () => {
    resumeDispatch();
    if (execution) await execution;
    chromium.connectOverCDP = connect;
    prototype.send = send;
    await readonly.close();
  };
  const runtime = { ...readonly, close };
  return { runtime, scope, requests, events, release, prepare, dispatch,
    report: () => report, journalPath: () => options.journalPath,
    detachTransport: () => sendingTransport.detach() };
}

for (const lane of ["article", "progress"]) {
  test(`${lane}: exact pinned-key fake session sends native RPC once and returns only canonical fields`, async ({ page }) => {
    const f = await setup(page);
    try {
      const ticket = await f.prepare(lane);
      const result = await f.dispatch(ticket);
      expect(result.invoked).toBe(true); expect(result.result.status).toBe("applied");
      expect(f.requests).toEqual([lane]);
      expect(JSON.stringify(result)).not.toMatch(/fake-browser|fake-response|session|headers|content"/);
      await expect(f.dispatch(ticket)).rejects.toThrow("fixture-send-authority-missing");
      await expect(f.prepare(lane)).rejects.toThrow("runtime-scope-changed");
      expect(f.requests).toEqual([lane]);
    } finally { await f.runtime.close(); }
  });
  for (const storage of ["missing", "invalid-json", "missing-token", "malformed-user", "invalid-type", "invalid-expiry", "envelope", "storage-denied"]) {
    test(`${lane}: ${storage} session fails closed, zero RPC, no SDK fallback`, async ({ page }) => {
      const f = await setup(page, { storage });
      try { await expect(f.prepare(lane)).rejects.toThrow("runtime-scope-changed"); expect(f.requests).toEqual([]); }
      finally { await f.runtime.close(); }
    });
  }
  test(`${lane}: browser Auth verifies different owner despite current Auth A, zero RPC`, async ({ page }) => {
    const f = await setup(page, { authOwner: EPOCH });
    try { await expect(f.prepare(lane)).rejects.toThrow("runtime-scope-changed"); expect(f.requests).toEqual([]); }
    finally { await f.runtime.close(); }
  });
  for (const change of ["token", "same-owner-relogin", "generation", "account-B", "binding", "transition", "scope-token"]) {
    test(`${lane}: ${change} first defeats stale Node view at final page authority`, async ({ page }) => {
      const f = await setup(page);
      try {
        const ticket = await f.prepare(lane);
        await page.evaluate(async change => {
          if (["token", "same-owner-relogin"].includes(change)) {
            const key = "sb-yebabpjplbgidzwpjhoy-auth-token", value = JSON.parse(localStorage.getItem(key));
            value.access_token = "fake-browser-token-two"; localStorage.setItem(key, JSON.stringify(value));
          }
          if (["generation", "same-owner-relogin", "account-B"].includes(change)) {
            if (change === "account-B") window.mockOwner = "different-fake-owner";
            window.dispatchEvent(new CustomEvent("lingoflow:auth-state"));
          }
          if (["binding", "transition", "scope-token"].includes(change)) {
            const sync = change === "binding";
            const db = await new Promise(resolve => { const r = indexedDB.open(sync ? "LingoFlowSyncDB" : "LingoFlowLibraryDB"); r.onsuccess = () => resolve(r.result); });
            await new Promise(resolve => {
              const tx = db.transaction(sync ? "control" : "progressControl", "readwrite"), store = tx.objectStore(sync ? "control" : "progressControl");
              const key = sync ? "workspace-binding" : change === "transition" ? "workspace-transition" : "workspace";
              if (change === "transition") store.put({ key, stage: "switching" });
              else { const r = store.get(key); r.onsuccess = () => store.put({ ...r.result,
                ...(sync ? { bindingId: "changed-binding" } : { scopeToken: "changed-scope" }) }); }
              tx.oncomplete = resolve;
            }); db.close();
          }
        }, change);
        const result = await f.dispatch(ticket);
        expect(result.invoked).toBe(false); expect(f.requests).toEqual([]);
      } finally { await f.runtime.close(); }
    });
  }
  test(`${lane}: send first then token/generation/writer changes, pending response does not hold IDB locks`, async ({ page }) => {
    const f = await setup(page, { delayedResponse: true });
    try {
      const ticket = await f.prepare(lane), sending = f.dispatch(ticket);
      await expect.poll(() => f.requests.length).toBe(1);
      expect(await readLocalFixtureTestEvidence(page)).toEqual(["final-validation", "localhost-fetch-invocation"]);
      await page.evaluate(() => {
        const key = "sb-yebabpjplbgidzwpjhoy-auth-token", value = JSON.parse(localStorage.getItem(key));
        value.access_token = "fake-browser-token-two"; localStorage.setItem(key, JSON.stringify(value));
        window.dispatchEvent(new CustomEvent("lingoflow:auth-state"));
      });
      f.events.push("token-change");
      f.events.push("generation-advance");
      expect(await readLocalFixtureTestEvidence(page)).toEqual([
        "final-validation", "localhost-fetch-invocation", "generation-invalidated"]);
      await page.evaluate(async () => {
        for (const [name, store, key] of [["LingoFlowSyncDB", "control", "workspace-binding"],
          ["LingoFlowLibraryDB", "progressControl", "workspace-transition"]]) {
          const db = await new Promise(resolve => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); });
          await new Promise(resolve => {
            const tx = db.transaction(store, "readwrite"); tx.objectStore(store).put({ key, ownerId: "after-send" });
            tx.oncomplete = resolve;
          }); db.close();
        }
      });
      f.events.push("writers-committed-before-response");
      f.release();
      expect((await sending).invoked).toBe(true);
      expect(f.events).toEqual(["fetch-marker", "token-change", "generation-advance", "writers-committed-before-response"]);
    } finally { f.release(); await f.runtime.close(); }
  });
}

test("late queued evaluation uses PAGE monotonic deadline and performs zero RPC", async ({ page }) => {
  const f = await setup(page);
  try {
    const ticket = await f.prepare("article");
    // Actual browser main-thread queue delay, not a fake Node counter/clock.
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    await page.exposeBinding("__testQueueStarted", () => started());
    const blocking = page.evaluate(() => {
      window.__testQueueStarted();
      const until = performance.now() + 2100; while (performance.now() < until) {}
    });
    await entered;
    const queued = f.dispatch(ticket);
    await blocking;
    expect((await queued).invoked).toBe(false); expect(f.requests).toEqual([]);
  } finally { await f.runtime.close(); }
});
for (const change of ["same-url-reload", "page-close"]) test(`${change} cannot inherit old Document ticket`, async ({ page }) => {
  const f = await setup(page);
  const ticket = await f.prepare("article");
  if (change === "same-url-reload") await page.reload(); else await page.close();
  // Cross-CDP close notification can arrive late. UNKNOWN is conservative, but
  // the actual closed Document must produce ZERO native RPC invocations.
  const outcome = await f.dispatch(ticket).catch(() => ({ invoked: false }));
  if (outcome.invoked !== false) expect(outcome).toEqual({ invoked: null, reason: "page-send-unknown" });
  expect(f.requests).toEqual([]); await f.runtime.close();
});
test("fetch invocation followed by page close is UNKNOWN, not no-send; no retry", async ({ page }) => {
  const f = await setup(page, { delayedResponse: true });
  try {
    const ticket = await f.prepare("progress"), sending = f.dispatch(ticket);
    await expect.poll(() => f.requests.length).toBe(1);
    await page.close(); f.release();
    expect(await sending).toEqual({ invoked: null, reason: "page-send-unknown" });
    expect(f.requests).toEqual(["progress"]);
    await expect(f.dispatch(ticket)).rejects.toThrow("fixture-send-authority-missing");
  } finally { f.release(); await f.runtime.close(); }
});
for (const malicious of ["getter", "proxy", "toJSON", "function", "symbol"]) test(`wire ${malicious} rejected without reentrant user code`, () => {
  let calls = 0;
  const value = { valid: true };
  let wire = value;
  if (malicious === "getter") Object.defineProperty(value, "trap", { get() { calls++; return 1; } });
  if (malicious === "proxy") wire = new Proxy(value, { ownKeys() { calls++; return []; } });
  if (malicious === "toJSON") value.toJSON = () => { calls++; return {}; };
  if (malicious === "function") value.fn = () => { calls++; };
  if (malicious === "symbol") value[Symbol.toPrimitive] = () => { calls++; return 1; };
  expect(() => freezePlainWire(wire)).toThrow("fixture-wire-not-plain"); expect(calls).toBe(0);
});

for (const lane of ["binding", "transition"]) test(`REAL Chromium ${lane} two-connection barrier: marker, release, writer commit`, async ({ page }) => {
  const f = await setup(page);
  try {
    const result = await page.evaluate(async ({ source, expected, lane }) => {
      const utility = new Function(`return (${source})`)();
      const open = name => new Promise(resolve => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); });
      const syncA = await open("LingoFlowSyncDB"), libraryA = await open("LingoFlowLibraryDB");
      const competing = await open(lane === "binding" ? "LingoFlowSyncDB" : "LingoFlowLibraryDB");
      const events = []; let writing;
      const result = await utility(syncA, libraryA, expected, () => true, () => {
        const tx = competing.transaction(lane === "binding" ? "control" : "progressControl", "readwrite");
        const key = lane === "binding" ? "workspace-binding" : "workspace-transition";
        tx.objectStore(lane === "binding" ? "control" : "progressControl").put({ key,
          ownerId: "writer-owner", bindingId: "writer-binding" });
        writing = new Promise(resolve => { tx.oncomplete = () => { events.push("writer-commit"); resolve(); }; });
        events.push("guard"); events.push("fetch-marker");
        const requestPromise = fetch("/__barrier_marker");
        return { invoked: true, requestPromise };
      }, performance.now() + 2000);
      events.push("barriers-released"); await writing;
      await result.requestPromise;
      for (const db of [syncA, libraryA, competing]) db.close();
      return { invoked: result.invoked, events };
    }, { source: withPageAuthorityBarriers.toString(), expected: f.scope, lane });
    expect(result).toEqual({ invoked: true, events: ["guard", "fetch-marker", "barriers-released", "writer-commit"] });
  } finally { await f.runtime.close(); }
});

for (const fault of ["acquisition-transition", "sync-abort", "library-abort", "sync-early-complete", "library-early-complete"]) {
  test(`REAL Chromium barrier ${fault}: zero native RPC`, async ({ page }) => {
    const f = await setup(page);
    try {
      const ticket = await f.prepare("progress");
      await page.evaluate(async fault => {
        const native = IDBDatabase.prototype.transaction;
        let armed = true;
        const writer = await new Promise(resolve => {
          const r = indexedDB.open("LingoFlowLibraryDB"); r.onsuccess = () => resolve(r.result);
        });
        IDBDatabase.prototype.transaction = function(stores, mode, ...rest) {
          const targeted = fault.startsWith("sync") ? this.name === "LingoFlowSyncDB" && stores === "control"
            : this.name === "LingoFlowLibraryDB" && stores === "progressControl";
          if (armed && targeted && mode === "readonly") {
            armed = false;
            if (fault === "acquisition-transition") {
              // Sync barrier has already checked authority and holds its lock.
              // This REAL second-connection writer queues before Library read.
              const write = native.call(writer, "progressControl", "readwrite");
              write.objectStore("progressControl").put({ key: "workspace-transition", stage: "switching" });
            }
            const tx = native.call(this, stores, mode, ...rest);
            if (fault.endsWith("abort")) tx.abort();
            if (fault.endsWith("complete")) tx.commit();
            return tx;
          }
          return native.call(this, stores, mode, ...rest);
        };
      }, fault);
      expect((await f.dispatch(ticket)).invoked).toBe(false); expect(f.requests).toEqual([]);
    } finally { await f.runtime.close(); }
  });
}
test("concurrent lane preparation shares ONE private Document root and one opaque ticket", async ({ page }) => {
  const f = await setup(page);
  try {
    const prepared = await Promise.allSettled([f.prepare("article"), f.prepare("article")]);
    expect(prepared.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const ticket = prepared.find(r => r.status === "fulfilled").value;
    expect((await f.dispatch(ticket)).invoked).toBe(true); expect(f.requests).toEqual(["article"]);
  } finally { await f.runtime.close(); }
});

for (const lane of ["binding", "transition"]) test(`REAL Chromium ${lane} writer-first commits before barrier and gives zero RPC`, async ({ page }) => {
  const f = await setup(page);
  try {
    const result = await page.evaluate(async ({ source, expected, lane }) => {
      const utility = new Function(`return (${source})`)();
      const open = name => new Promise(resolve => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); });
      const sync = await open("LingoFlowSyncDB"), library = await open("LingoFlowLibraryDB");
      const writer = await open(lane === "binding" ? "LingoFlowSyncDB" : "LingoFlowLibraryDB");
      const storeName = lane === "binding" ? "control" : "progressControl";
      const tx = writer.transaction(storeName, "readwrite"), events = ["writer-queued"];
      tx.objectStore(storeName).put({ key: lane === "binding" ? "workspace-binding" : "workspace-transition",
        ownerId: "different-owner", bindingId: "different-binding", stage: "switching" });
      tx.oncomplete = () => events.push("writer-commit");
      const outcome = await utility(sync, library, expected, () => true, () => {
        events.push("fetch-marker"); return { invoked: true, requestPromise: fetch("/__barrier_marker") };
      }, performance.now() + 2000);
      for (const db of [sync, library, writer]) db.close();
      return { invoked: outcome.invoked, events };
    }, { source: withPageAuthorityBarriers.toString(), expected: f.scope, lane });
    expect(result).toEqual({ invoked: false, events: ["writer-queued", "writer-commit"] });
    expect(f.requests).toEqual([]);
  } finally { await f.runtime.close(); }
});

for (const loss of ["reload", "navigation", "CDP-detach"]) test(`native invocation then ${loss} is UNKNOWN, not retried`, async ({ page }) => {
  const f = await setup(page, { delayedResponse: true });
  try {
    const sending = f.dispatch(await f.prepare("progress"));
    await expect.poll(() => f.requests.length).toBe(1);
    if (loss === "reload") await page.reload();
    else if (loss === "navigation") {
      await page.route("**/__mock_navigated", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>New document</title>" }));
      await page.goto("/__mock_navigated");
    } else await f.detachTransport();
    f.release();
    expect(await sending).toEqual({ invoked: null, reason: "page-send-unknown" });
    expect(f.requests).toEqual(["progress"]);
    expect(JSON.parse(await fs.readFile(f.journalPath(), "utf8")).progressAttempted).toBe(true);
    expect(f.report().mutationCounts.progressSeed).toBe(1);
  } finally { f.release(); await f.runtime.close(); }
});
test("public read-only runtime has no lane preparation or dispatch capability", async ({ page }) => {
  const f = await setup(page);
  try {
    expect(f.runtime.prepareFixtureSend).toBeUndefined();
    expect(f.runtime.dispatchFixtureSend).toBeUndefined();
    expect(f.requests).toEqual([]);
  } finally { await f.runtime.close(); }
});

for (const lane of ["article", "progress"]) for (const phase of ["before", "after"]) {
  test(`${lane}: malicious main fetch wrapper ${phase} preparation never executes`, async ({ page }) => {
    const f = await setup(page);
    const wrap = () => page.evaluate(() => {
      const original = window.fetch;
      window.wrapperCalls = 0;
      window.fetch = function(...args) {
        window.wrapperCalls++;
        window.dispatchEvent(new CustomEvent("lingoflow:auth-state"));
        return original.apply(window, args);
      };
    });
    try {
      if (phase === "before") await wrap();
      const ticket = await f.prepare(lane);
      if (phase === "after") await wrap();
      expect((await f.dispatch(ticket)).invoked).toBe(true);
      expect(await page.evaluate(() => window.wrapperCalls)).toBe(0);
      expect(f.requests).toEqual([lane]);
      const current = await f.runtime.captureScope();
      expect(current.generation).toBe(f.scope.generation);
    } finally { await f.runtime.close(); }
  });
}
for (const attack of ["fetch-getter-proxy", "toString-spoof"]) test(`${attack} cannot supply trusted transport`, async ({ page }) => {
  const f = await setup(page);
  try {
    await page.evaluate(attack => {
      window.wrapperCalls = 0;
      if (attack === "toString-spoof") Function.prototype.toString = () => { window.wrapperCalls++; throw new Error("spoofed native string"); };
      else {
        const original = window.fetch;
        Object.defineProperty(window, "fetch", { configurable: true, get() {
          window.wrapperCalls++;
          return new Proxy(original, { apply() { window.wrapperCalls++; throw new Error("main fetch proxy"); } });
        } });
      }
    }, attack);
    expect((await f.dispatch(await f.prepare("progress"))).invoked).toBe(true);
    expect(await page.evaluate(() => window.wrapperCalls)).toBe(0);
    expect(f.requests).toEqual(["progress"]);
  } finally { await f.runtime.close(); }
});
for (const fault of ["replaceState", "pushState", "reload"]) test(`transport Document ${fault} before guard gives zero RPC`, async ({ page }) => {
  const f = await setup(page);
  try {
    const ticket = await f.prepare("progress");
    if (fault === "reload") await page.reload();
    else await page.evaluate(fault => history[fault]({}, "", location.href), fault);
    const outcome = await f.dispatch(ticket);
    expect(outcome.invoked).not.toBe(true);
    expect(f.requests).toEqual([]);
  } finally { await f.runtime.close(); }
});
test("Document revocation after invocation is UNKNOWN, keeps attempted journal and never retries", async ({ page }) => {
  const f = await setup(page, { delayedResponse: true });
  try {
    const ticket = await f.prepare("progress"), sending = f.dispatch(ticket);
    await expect.poll(() => f.requests.length).toBe(1);
    await page.evaluate(() => history.replaceState({}, "", location.href));
    f.release();
    const result = await sending;
    expect(result.invoked).not.toBe(false);
    expect(result.reason).toBe("page-send-unknown");
    const journal = JSON.parse(await fs.readFile(f.journalPath(), "utf8"));
    expect(journal.progressAttempted).toBe(true);
    expect(f.report().mutationCounts.progressSeed).toBe(1);
    expect(f.requests).toEqual(["progress"]);
  } finally { f.release(); await f.runtime.close(); }
});
for (const lane of ["article", "progress"]) test(`${lane} direct runtime import and fake checker cannot mint mutation capability`, async ({ page }) => {
  const f = await setup(page);
  try {
    const exported = require("./progress-live-fixture-runtime");
    expect(Object.keys(exported)).toEqual(["openFixtureRuntimeSession"]);
    expect(f.runtime.prepareFixtureSend).toBeUndefined();
    expect(f.runtime.dispatchFixtureSend).toBeUndefined();
    await expect(exported.openFixtureRuntimeSession({ ownerId: fixture.OWNER, articleId: ARTICLE }, {
      cdpURL: "http://127.0.0.1:19993/", runtimeURL: "http://127.0.0.1:4173/", consumeSendPermit: () => true
    })).rejects.toThrow("invalid-fixture-options");
    expect(f.requests).toEqual([]);
  } finally { await f.runtime.close(); }
});

for (const lane of ["article", "progress"]) for (const earlyReplacement of ["inline", "load"]) {
  test(`${lane}: pre-document root defeats earliest ${earlyReplacement} replacement and synchronous iframe load attack`, async ({ page }) => {
    const f = await setup(page, { earlyReplacement });
    try {
      expect(inspectLocalFixtureTestPage(page)).toMatchObject({ controlled: true, captures: 1,
        acquiredBeforeResume: true, beforeApplication: true, current: true, externalRequests: 0 });
      expect(await page.evaluate(() => scriptPhases)).toEqual(expect.arrayContaining(["inline", "defer", "async", "module", "DCL", "load"]));
      expect((await f.dispatch(await f.prepare(lane))).invoked).toBe(true);
      expect(f.requests).toEqual([lane]);
      expect(await page.evaluate(() => ({ wrappers: wrapperCalls, iframes: document.querySelectorAll("iframe").length })))
        .toEqual({ wrappers: 0, iframes: 0 });
    } finally { await f.runtime.close(); }
  });
}

test("root/ticket cannot be enumerated in globals, DOM or storage; no raw transport is public", async ({ page }) => {
  const f = await setup(page);
  try {
    const before = await page.evaluate(() => Object.getOwnPropertyNames(window));
    await f.prepare("article");
    const exposed = await page.evaluate(before => {
      const added = Object.getOwnPropertyNames(window).filter(key => !before.includes(key));
      const symbols = Object.getOwnPropertySymbols(window).map(String);
      return { added: added.filter(key => !key.startsWith("__fixtureLifetime_") && !key.startsWith("__fixtureInvalidate_")),
        symbols: symbols.filter(key => /fixture|transport|bridge|ticket/i.test(key)),
        iframes: document.querySelectorAll("iframe").length,
        keys: Object.keys(localStorage).filter(key => /transport|bridge|ticket|nonce/i.test(key)),
        bridge: typeof window.bridge };
    }, before);
    expect(exposed).toEqual({ added: [], symbols: [], iframes: 0, keys: [], bridge: "undefined" });
    expect((await f.dispatch()).invoked).toBe(true);
  } finally { await f.runtime.close(); }
});

test("old private root is not reacquired after reload of a claimed Document", async ({ page }) => {
  const f = await setup(page);
  try {
    await f.prepare("article"); await page.reload();
    expect(inspectLocalFixtureTestPage(page)).toMatchObject({ captures: 1, current: false });
    expect((await f.dispatch()).invoked).not.toBe(true);
    expect(f.requests).toEqual([]);
  } finally { await f.runtime.close(); }
});

test("an ordinary already-running page cannot retroactively acquire transport trust", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:4173", serviceWorkers: "block" });
  await context.route("**/*", route => new URL(route.request().url()).origin === "http://127.0.0.1:4173"
    ? route.fallback() : route.abort());
  const page = await context.newPage();
  const f = await setup(page);
  try {
    expect(inspectLocalFixtureTestPage(page)).toEqual({ controlled: false });
    await expect(f.prepare("article")).rejects.toThrow("fixture-transport-unavailable");
    expect(f.requests).toEqual([]);
  } finally { await f.runtime.close(); await context.close(); }
});
