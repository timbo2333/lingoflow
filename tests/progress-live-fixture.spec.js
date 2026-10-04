"use strict";

const { test, expect } = require("./progress-strict-test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const helper = require("./progress-live-fixture-helpers");
const runner = require("../scripts/progress-live-fixture-prepare");
const { seedFromMockVerification, closeMockSession } = require("./progress-live-fixture-test-support");
test.afterEach(async ({ page }) => closeMockSession(page));
const { inspectExistingRuntime } = require("./progress-live-runtime-inspector");
const { trapProgressNetwork } = require("./progress-transport-helpers");
const SECRET = "sentinel.notcredential.neverlog";
const EPOCH = "11111111-2222-4333-8444-555555555555";
const TIME = "2026-10-04T00:00:00.000Z";
const ARTICLE = "b3-2b-live-fixture-a-00000000-0000-4000-8000-000000000001";
const env = () => ({ LF_PROGRESS_LIVE_TEST: "1", LF_PROGRESS_FIXTURE_PREPARE: "1",
  LF_SUPABASE_URL: "https://yebabpjplbgidzwpjhoy.supabase.co", LF_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_mockonly",
  LF_PROGRESS_OWNER_A: helper.OWNER, LF_PROGRESS_JWT_A: SECRET });
const options = { dedicatedTestAccount: true, articleId: ARTICLE };
const clone = value => JSON.parse(JSON.stringify(value));
const def = () => helper.definition(ARTICLE, "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003", TIME);
function articleFacts(d) {
  return { ownerId: helper.OWNER, articleId: d.articleId, title: helper.TITLE, revision: "revision:1", cursor: "cursor:9007199254740993",
    readingEpoch: EPOCH, contentFingerprint: helper.DIGEST, computedFingerprint: helper.DIGEST,
    contentBytes: helper.BYTES, lifecycle: "active", deletedAt: null, createdAt: d.createdAt, updatedAt: d.createdAt,
    serverCreatedAt: TIME, serverUpdatedAt: TIME };
}
function progressFacts(d) {
  return { ownerId: helper.OWNER, articleId: d.articleId, revision: "revision:1", cursor: "cursor:9007199254740995",
    parentReadingEpoch: EPOCH, contentFingerprint: helper.DIGEST, progress: 0.2, paragraphIndex: 4, serverUpdatedAt: TIME };
}
function fakeIO() {
  let journal = null, localObservation = { kind: "unknown" };
  const calls = [], scope = { status: "ready", ownerId: helper.OWNER, bindingId: "fixture-binding",
    generation: 3, scopeToken: "fixture-scope", runtimeIdentity: "fixture-runtime", stable: true, transitionInactive: true };
  const state = { article: null, progress: null, articleResult: null, progressResult: null,
    history: { articleChanges: "0", articleReceipts: "0", progressChanges: "0", progressReceipts: "0",
      articleSetupReceipt: "0", progressSetupReceipt: "0" } };
  const local = () => ({ ...clone(scope), scopeValid: true, fencePresent: true,
    articleId: ARTICLE, articleActive: true, contentFingerprint: helper.DIGEST, contentBytes: helper.BYTES,
    parent: { articleRevision: "revision:1", readingEpoch: EPOCH, contentFingerprint: helper.DIGEST, lifecycle: "active" },
    bootstrapSafe: true, hasConflict: false, hasMutation: false, pendingMovement: false, quarantinedMovement: false,
    unsettledAttempts: false, observationDiagnostic: false, observation: clone(localObservation) });
  const runtime = { captureScope: async () => clone(scope), inspectRuntime: async () => local(),
    seedObservation: async capability => {
      const input = helper.consumeVerifiedFixtureSeed(capability);
      if (!input) return { status: "blocked" };
      calls.push("observation"); localObservation = helper.observation(input.server.progress); return { status: "recorded" };
    },
    close: async () => { calls.push("disconnect"); } };
  let journalLocked = false;
  const io = { calls, state, scope, runtime, local,
    acquireJournalLock: async () => { if (journalLocked) throw new Error("fixture-journal-busy"); journalLocked = true; },
    releaseJournalLock: async () => { journalLocked = false; },
    get journal() { return journal; }, set journal(value) { journal = clone(value); },
    readJournal: async () => { calls.push("journal-read"); return journal && clone(journal); },
    writeJournal: async value => { expect(JSON.stringify(value)).not.toContain(SECRET); journal = clone(helper.validateJournal(value)); },
    verifyOwner: async () => helper.OWNER,
    inspectServer: async () => { calls.push("select"); return clone(state); },
    articleSetup: async d => {
      calls.push("article"); state.article = articleFacts(d);
      state.history.articleChanges = state.history.articleReceipts = state.history.articleSetupReceipt = "1";
      state.articleResult = { status: "applied", operation: "put", mutationId: d.articleMutationId,
        articleId: d.articleId, revision: state.article.revision, cursor: state.article.cursor, readingEpoch: EPOCH, contentFingerprint: helper.DIGEST };
      return clone(state.articleResult);
    },
    progressSeed: async d => {
      calls.push("progress"); state.progress = progressFacts(d);
      state.history.progressChanges = state.history.progressReceipts = state.history.progressSetupReceipt = "1";
      state.progressResult = { status: "applied", mutationId: d.progressMutationId, articleId: d.articleId,
        ...Object.fromEntries(["revision", "cursor", "parentReadingEpoch", "contentFingerprint", "progress", "paragraphIndex", "serverUpdatedAt"]
          .map(k => [k, state.progress[k]])) };
      return clone(state.progressResult);
    },
    openRuntime: async () => runtime,
    productionDispatch: () => { throw new Error("Production path forbidden"); },
    cleanup: () => { throw new Error("Cleanup forbidden"); } };
  return io;
}
const run = (io, input = env(), opts = options) => helper.runPreparation(input, opts, io);
const writes = io => io.calls.filter(k => ["article", "progress"].includes(k));

for (const [name, change, opts] of [
  ["missing LIVE gate", e => { delete e.LF_PROGRESS_LIVE_TEST; }],
  ["missing fixture gate", e => { delete e.LF_PROGRESS_FIXTURE_PREPARE; }],
  ["missing dedicated flag", () => {}, { ...options, dedicatedTestAccount: false }],
  ["wrong owner", e => { e.LF_PROGRESS_OWNER_A = EPOCH; }],
  ["wrong project", e => { e.LF_SUPABASE_URL = "https://other.invalid"; }],
  ["debug recording", e => { e.DEBUG = "*"; }],
  ["malformed fixture ID", () => {}, { ...options, articleId: "b3-contract-old" }]
]) test(`${name} fails with zero server writes`, async () => {
  const io = fakeIO(), input = env(); change(input);
  expect((await run(io, input, opts || options)).status).toBe("NO-GO"); expect(writes(io)).toEqual([]);
});

test("JWT identity, not dedicated flag, is authority", async () => {
  const io = fakeIO(); io.verifyOwner = async () => EPOCH;
  expect((await run(io)).reason).toBe("authenticated-owner-mismatch"); expect(writes(io)).toEqual([]);
});
test("CLI and import have no real adapter even with all gates", async () => {
  const output = [];
  expect(await runner.main(env(), ["--dedicated-test-account"], null, s => output.push(s))).toBe(2);
  expect(output.join("")).toContain("fixture-transport-not-injected"); expect(output.join("")).not.toContain(SECRET);
});
test("fixed content: twenty paragraphs, stable UTF-8 digest, independent frozen setup IDs", async () => {
  const d = def(); expect(Object.isFrozen(d)).toBe(true); expect(helper.CONTENT.split("\n\n")).toHaveLength(20);
  expect(helper.BYTES).toBeGreaterThan(5000); expect(helper.BYTES).toBeLessThan(1048576);
  expect(helper.CONTENT).not.toMatch(/2026|Conflict|Account Switch|oversized|size gate/);
  expect(d.articleMutationId).not.toBe(d.progressMutationId);
});
test("single setup seams use existing helpers; absent is test seed only; mutation budget one each", async () => {
  const calls = []; const who = { owner: helper.OWNER, jwt: SECRET };
  const adapter = helper.serverContractAdapter({ articlePush: async (...args) => calls.push(args),
    progressPush: async (...args) => calls.push(args) }, who, env(), options);
  const d = def(); await adapter.articleSetup(d); await adapter.progressSeed(d, articleFacts(d));
  expect(calls[0].slice(1, 3)).toEqual([ARTICLE, "put"]); expect(calls[0][4]).toBeNull();
  expect(calls[1][2]).toMatchObject({ expectedState: "absent", expectedProgressRevision: null, progress: 0.2, paragraphIndex: 4 });
  expect(calls[0][5]).not.toBe(calls[1][3]);
  await expect(adapter.articleSetup(d)).rejects.toThrow("article-outcome-unknown");
  await expect(adapter.progressSeed(d, articleFacts(d))).rejects.toThrow("progress-outcome-unknown"); expect(calls).toHaveLength(2);
});
for (const name of ["articleChanges", "articleReceipts", "progressChanges", "progressReceipts"]) {
  test(`${name} history collision rejects fresh identity`, async () => {
    const io = fakeIO(); io.state.history[name] = "1";
    expect((await run(io)).status).toBe("NO-GO"); expect(writes(io)).toEqual([]);
  });
}
test("existing Article collision cannot be overwritten", async () => {
  const io = fakeIO(); io.state.article = articleFacts(def());
  expect((await run(io)).status).toBe("NO-GO"); expect(writes(io)).toEqual([]);
});
test("mock full preparation: one Article, one seed, fresh SELECT, local seed, no production path", async () => {
  const io = fakeIO(); const result = await run(io);
  expect(result.status).toBe("ready"); expect(writes(io)).toEqual(["article", "progress"]);
  expect(io.journal.stage).toBe("ready"); expect(result.productionClientUpdate).toBe(0); expect(result.productionClientCreate).toBe(0);
  expect(io.calls.indexOf("observation")).toBeGreaterThan(io.calls.lastIndexOf("select"));
  expect(io.journal.article.cursor).toBe("cursor:9007199254740993"); expect(io.journal.progress.cursor).toBe("cursor:9007199254740995");
});
test("malformed Article response stops; exact frozen identity survives", async () => {
  const io = fakeIO(), original = io.articleSetup;
  io.articleSetup = async d => ({ ...await original(d), revision: 1 });
  expect((await run(io)).reason).toBe("article-result-invalid"); expect(writes(io)).toEqual(["article"]);
  expect(io.journal.definition.articleId).toBe(ARTICLE); expect(io.journal.articleAttempted).toBe(true);
});
test("Article accepted, Progress failure persists partial journal; rerun SELECT first, no blind retry/new ID", async () => {
  const io = fakeIO(); io.progressSeed = async () => { io.calls.push("progress"); throw new Error(SECRET); };
  expect((await run(io)).status).toBe("NO-GO"); expect(io.journal.stage).toBe("partial");
  expect(io.journal.article.revision).toBe("revision:1"); const frozen = clone(io.journal.definition); io.calls.length = 0;
  expect((await run(io)).reason).toBe("progress-outcome-unknown"); expect(writes(io)).toEqual([]);
  expect(io.calls).toContain("select"); expect(io.journal.definition).toEqual(frozen);
});
test("successful server stages survive generation interruption; resume same identity under fresh scope", async () => {
  const io = fakeIO(); const original = io.runtime.inspectRuntime;
  io.runtime.inspectRuntime = async () => { io.scope.generation++; return original(); };
  expect((await run(io)).reason).toBe("runtime-scope-changed"); expect(io.journal.progress).toBeTruthy();
  io.runtime.inspectRuntime = original; io.calls.length = 0;
  expect((await run(io)).status).toBe("ready"); expect(writes(io)).toEqual([]);
});
for (const [name, change] of [
  ["epoch mismatch", s => { s.article.readingEpoch = "22222222-2222-4333-8444-555555555555"; }],
  ["fingerprint mismatch", s => { s.article.contentFingerprint = "sha256:" + "0".repeat(64); }]
]) test(`${name} in reverified parent prevents Progress seed`, async () => {
  const io = fakeIO(), original = io.inspectServer; let reads = 0;
  io.inspectServer = async () => { const s = await original(); if (++reads === 3) change(s); return s; };
  expect((await run(io)).status).toBe("NO-GO"); expect(writes(io)).toEqual(["article"]);
});
test("illegal checkpoint cannot reach the seed helper", async () => {
  const calls = []; const adapter = helper.serverContractAdapter({ articlePush: async () => {}, progressPush: async () => calls.push(1) },
    { owner: helper.OWNER, jwt: SECRET }, env(), options);
  for (const paragraphIndex of [-1, 20, 2147483648]) await expect(adapter.progressSeed({ ...def(), paragraphIndex }, articleFacts(def()))).rejects.toThrow();
  expect(calls).toEqual([]);
});
for (const [name, mutate] of [
  ["local Article missing", l => { l.articleActive = false; }],
  ["local epoch mismatch", l => { l.parent.readingEpoch = helper.OWNER; }],
  ["local fingerprint mismatch", l => { l.contentFingerprint = "sha256:" + "0".repeat(64); }],
  ["bootstrap unsafe", l => { l.bootstrapSafe = false; }],
  ["local conflict", l => { l.hasConflict = true; }],
  ["pending Article mutation", l => { l.hasMutation = true; }],
  ["existing pending movement", l => { l.pendingMovement = true; }],
  ["binding missing", l => { l.bindingId = null; }]
]) test(`${name} stops before observation seed`, async () => {
  const io = fakeIO(); io.runtime.inspectRuntime = async () => { const l = io.local(); mutate(l); return l; };
  expect((await run(io)).reason).toBe("local-article-not-ready"); expect(io.calls).not.toContain("observation");
});
test("fresh server mismatch immediately before observation blocks local write", async () => {
  const io = fakeIO(); const original = io.inspectServer; let reads = 0;
  io.inspectServer = async () => { const s = await original(); if (++reads === 5) s.progress.progress = 0.4; return s; };
  expect((await run(io)).status).toBe("NO-GO"); expect(io.calls).not.toContain("observation");
});
test("completed journal rerun is verify-only, no setup or observation writes", async () => {
  const io = fakeIO(); await run(io); io.calls.length = 0;
  expect((await run(io)).mode).toBe("verify-only"); expect(writes(io)).toEqual([]); expect(io.calls).not.toContain("observation");
});
test("journal/server contradiction and unknown CLI shapes fail closed", async () => {
  const io = fakeIO(); await run(io); io.calls.length = 0; io.state.progress.cursor = "cursor:9999999999999999";
  expect((await run(io)).status).toBe("NO-GO"); expect(writes(io)).toEqual([]);
  const parse = require("./progress-cloud-live-helpers").parseLinkedStateOutput;
  expect(() => parse('{"data":[]}')).toThrow();
});
test("fixed SELECT with bigint strings, checked linked Project A, no JWT passed to CLI", async () => {
  const d = def(), sql = helper.inspectionSQL(d);
  expect(sql).not.toMatch(/\b(insert|update|delete|create|alter|drop|set_config)\b/i);
  expect(sql).toContain("count(*)::text"); expect(sql).toContain("server_revision::text");
  expect(sql).not.toContain(SECRET); const io = fakeIO(); let calls = 0;
  const inspected = await helper.inspectFixtureServer({ ownerId: helper.OWNER, articleId: ARTICLE }, d, {
    readFileImpl: async () => "yebabpjplbgidzwpjhoy",
    execFileImpl: async (file, args, opts) => { calls++; expect(file).toBe("supabase");
      expect(args.slice(0, 5)).toEqual(["db", "query", "--linked", "--output", "json"]);
      expect(opts.env).not.toHaveProperty("LF_PROGRESS_JWT_A"); return { stdout: JSON.stringify([{ state: io.state }]) }; } });
  expect(inspected).toEqual(io.state); expect(calls).toBe(1);
  await expect(helper.inspectFixtureServer({ ownerId: helper.OWNER, articleId: ARTICLE }, d,
    { readFileImpl: async () => "wrong" })).rejects.toThrow("linked-project-mismatch");
});
test("private temp journal: atomic safe roundtrip, no credentials, malformed unknown keys rejected", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lingoflow-progress-fixture-"));
  const file = path.join(dir, "preparation.json"), store = await runner.createJournalStore(file);
  await expect(store.readJournal()).rejects.toThrow("fixture-journal-lock-required");
  await store.acquireJournalLock();
  try {
    expect(await store.readJournal()).toBeNull(); const journal = helper.newJournal(def());
    await store.writeJournal(journal); expect(await store.readJournal()).toEqual(journal);
    expect((await fs.readFile(file, "utf8"))).not.toContain(SECRET); expect((await fs.stat(file)).mode & 0o077).toBe(0);
    await expect(store.writeJournal({ ...journal, jwt: SECRET })).rejects.toThrow();
    await expect(runner.createJournalStore(path.resolve("preparation.json"))).rejects.toThrow();
  } finally { await store.releaseJournalLock(); }
});
test("journal exclusive lease rejects concurrent runner and stale lock, without changing frozen identity", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lingoflow-progress-fixture-"));
  const file = path.join(dir, "preparation.json"), a = await runner.createJournalStore(file), b = await runner.createJournalStore(file);
  await a.acquireJournalLock();
  await a.writeJournal(helper.newJournal(def()));
  await expect(b.acquireJournalLock()).rejects.toThrow("fixture-journal-busy");
  const frozen = await fs.readFile(file, "utf8");
  await a.releaseJournalLock();
  await b.acquireJournalLock();
  expect((await b.readJournal()).definition.articleId).toBe(ARTICLE);
  await b.releaseJournalLock();
  await fs.writeFile(path.join(dir, ".preparation.lock"), "", { flag: "wx", mode: 0o600 });
  await expect(a.acquireJournalLock()).rejects.toThrow("fixture-journal-busy");
  expect(await fs.readFile(file, "utf8")).toBe(frozen);
});
test("safety config and production isolation are explicit; no auto wiring / cleanup", async () => {
  const config = require("../playwright.progress-fixture.config");
  expect(config.use).toMatchObject({ trace: "off", video: "off", screenshot: "off" });
  for (const file of ["progress-live-fixture-helpers.js", "progress-live-fixture-runtime.js"]) {
    const source = await fs.readFile(path.join(__dirname, file), "utf8");
    expect(source).not.toMatch(/\.(dispatchProgressCloudAttempt|prepareProgressCloudAttempt|reserveCloudAttemptForDispatch|cleanup|progressPull|progressInventory)\s*\(/);
  }
  const index = await fs.readFile(path.join(__dirname, "../index.html"), "utf8");
  expect(index).not.toContain("progress-live-fixture");
});

for (const crash of ["planned", "attempted-before-http", "article-http-unknown", "article-before-accepted-journal",
  "article-accepted-before-progress", "progress-http-unknown", "progress-before-accepted-journal"]) {
  test(`journal crash window ${crash}: frozen identity, verify first, no blind resend`, async () => {
    const io = fakeIO(), write = io.writeJournal, article = io.articleSetup, progress = io.progressSeed;
    let powered = true, first = true;
    const die = () => { powered = false; throw new Error("mock-process-crash"); };
    io.writeJournal = async j => {
      if (!powered) throw new Error("mock-disk-offline");
      if (first && ((crash === "article-before-accepted-journal" && j.article) ||
          (crash === "progress-before-accepted-journal" && j.progress))) die();
      await write(j);
      if (first && ((crash === "planned" && !j.articleAttempted) ||
          (crash === "attempted-before-http" && j.articleAttempted) ||
          (crash === "article-accepted-before-progress" && j.completedStage === "article_created"))) die();
    };
    io.articleSetup = async d => {
      if (first && crash === "article-http-unknown") { io.calls.push("article"); die(); }
      return article(d);
    };
    io.progressSeed = async d => {
      const result = await progress(d); if (first && crash === "progress-http-unknown") die(); return result;
    };
    expect((await run(io)).status).toBe("NO-GO");
    const frozen = clone(io.journal.definition);
    powered = true; first = false; io.calls.length = 0;
    const result = await run(io);
    expect(io.journal.definition).toEqual(frozen);
    const read = io.calls.indexOf("select"); expect(read).toBeGreaterThanOrEqual(0);
    for (const send of ["article", "progress"]) if (io.calls.includes(send)) expect(io.calls.indexOf(send)).toBeGreaterThan(read);
    if (["planned", "article-accepted-before-progress"].includes(crash)) expect(result.status).toBe("ready");
    else { expect(result.status).toBe("NO-GO"); expect(writes(io)).toEqual([]); }
  });
}

// Actual browser IndexedDB, but MOCK auth/server and no external HTTP.
async function browserFixture(page) {
  await trapProgressNetwork(page); await page.goto("/");
  const d = def();
  const input = await page.evaluate(async input => {
    const repo = window.LingoFlowSyncStateRepository, lib = window.LingoFlowArticleLibrary;
    const owner = { ownerId: input.ownerId, bindingId: "fixture-binding" };
    window.fixtureAuth = { status: "authenticated", user: { id: owner.ownerId } };
    window.LingoFlowSupabaseAuth = { getState: () => window.fixtureAuth };
    await repo.bindWorkspace(owner);
    await lib.commitArticleSyncProjection(input.def.articleId, null, { id: input.def.articleId, title: "Progress LIVE Fixture A",
      content: input.content, sourceType: "paste", createdAt: input.def.createdAt, updatedAt: input.def.createdAt, deletedAt: null });
    await repo.bindArticleRemoteRevision(owner.ownerId, owner.bindingId, input.def.articleId, "revision:1", "a".repeat(64), "active", {
      articleRevision: "revision:1", readingEpoch: input.epoch, contentFingerprint: input.def.contentDigest, lifecycle: "active" });
    const bootstrap = await repo.beginArticleBootstrap(owner.ownerId, owner.bindingId);
    const db = await repo.openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("control", "readwrite");
      tx.objectStore("control").put({ ...bootstrap.state, status: "complete", phase: "complete", finalCursor: "cursor:0",
        pendingCursor: null, pendingHasMore: false, issueCount: 0 }); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    await lib.getProgressContext(input.def.articleId, owner);
    window.fixtureSnapshot = async () => {
      const db = await repo.openDatabase();
      const rows = await new Promise((resolve, reject) => {
        const stores = Array.from(db.objectStoreNames), tx = db.transaction(stores, "readonly"), result = {};
        for (const name of stores) tx.objectStore(name).getAll().onsuccess = e => { result[name] = e.target.result; };
        tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error);
      });
      return { rows, article: await lib.getArticle(input.def.articleId) };
    };
    return { ownerId: owner.ownerId, articleId: input.def.articleId };
  }, { ownerId: helper.OWNER, def: d, content: helper.CONTENT, epoch: EPOCH });
  const base = await page.evaluate(inspectExistingRuntime, { ...input, scopeOnly: true });
  return { gates: { live: true, fixture: true, dedicated: true }, definition: d, runtimeIdentity: "fixture-runtime",
    baseline: { ...base, runtimeIdentity: "fixture-runtime" }, server: { article: articleFacts(d), progress: progressFacts(d) } };
}

test("real IDB stable observation seed commits once: Resume/desired/attempt/outbox unchanged", async ({ page }) => {
  const input = await browserFixture(page), before = await page.evaluate(() => fixtureSnapshot());
  expect(await seedFromMockVerification(page, input)).toEqual({ status: "recorded" });
  const after = await page.evaluate(() => fixtureSnapshot());
  const observations = after.rows.progressRemoteObservations; after.rows.progressRemoteObservations = before.rows.progressRemoteObservations;
  expect(after).toEqual(before); expect(observations).toHaveLength(1);
  expect(observations[0]).toMatchObject({ revision: "revision:1", cursor: "cursor:9007199254740995" });
  expect(await seedFromMockVerification(page, input)).toEqual({ status: "unchanged" });
  expect(page.__realProgress).toEqual([]);
});
for (const kind of ["same-user-relogin", "token-refresh", "account-switch", "A-B-A", "page-identity"]) {
  test(`observation put queued then ${kind} before commit aborts entire transaction`, async ({ page }) => {
    const input = await browserFixture(page), before = await page.evaluate(() => fixtureSnapshot());
    await page.evaluate(kind => {
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function(...args) {
        const req = original.apply(this, args);
        if (this.name === "progressRemoteObservations") req.addEventListener("success", () => {
          const event = (status, ownerId = "db4f9c1c-4563-47a9-8649-150a4fb87a6a") => {
            window.fixtureAuth = { status, user: status === "authenticated" ? { id: ownerId } : null };
            window.dispatchEvent(new CustomEvent("lingoflow:auth-state", { detail: { status } }));
          };
          if (kind === "account-switch") void window.LingoFlowProgressLocalDesired.prepareAccountSwitch();
          else if (kind === "page-identity") window.dispatchEvent(new Event("pagehide"));
          else if (kind === "token-refresh") event("authenticated");
          else if (kind === "A-B-A") {
            event("authenticated", "22222222-2222-4333-8444-555555555555"); event("authenticated");
          }
          else { event("signed-out"); event("authenticated"); }
        });
        return req;
      };
    }, kind);
    expect((await seedFromMockVerification(page, input)).status).toBe("blocked");
    expect(await page.evaluate(() => fixtureSnapshot())).toEqual(before); expect(page.__realProgress).toEqual([]);
  });
}
test("same-owner generation changes BEFORE transaction rejects without writes", async ({ page }) => {
  const input = await browserFixture(page), before = await page.evaluate(() => fixtureSnapshot());
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lingoflow:auth-state", { detail: { status: "authenticated" } })));
    expect((await seedFromMockVerification(page, input)).status).toBe("blocked");
  expect(await page.evaluate(() => fixtureSnapshot())).toEqual(before);
});
test("binding replacement after scope capture cannot commit old observation", async ({ page }) => {
  const input = await browserFixture(page);
  await page.evaluate(async () => {
    const repo = window.LingoFlowSyncStateRepository, db = await repo.openDatabase();
    await new Promise(resolve => {
      const tx = db.transaction("control", "readwrite"), store = tx.objectStore("control"), read = store.get("workspace-binding");
      read.onsuccess = () => store.put({ ...read.result, bindingId: "replacement-binding" }); tx.oncomplete = resolve;
    });
  });
  const before = await page.evaluate(() => fixtureSnapshot());
    expect((await seedFromMockVerification(page, input)).status).toBe("blocked");
  expect(await page.evaluate(() => fixtureSnapshot())).toEqual(before);
});
for (const [kind, change] of [
  ["missing test gate", i => { i.gates.fixture = false; }],
  ["wrong owner", i => { i.baseline.ownerId = EPOCH; }],
  ["wrong Article", i => { i.definition = { ...i.definition, articleId: "b3-contract-old" }; }],
  ["wrong epoch", i => { i.server.progress.parentReadingEpoch = helper.OWNER; }],
  ["wrong fingerprint", i => { i.server.progress.contentFingerprint = "sha256:" + "0".repeat(64); }],
  ["malformed checkpoint", i => { i.server.progress.paragraphIndex = -1; }],
  ["wrong scope token", i => { i.baseline.scopeToken = "different"; }],
  ["wrong runtime identity", i => { i.runtimeIdentity = "lost"; }]
]) test(`page seed ${kind} rejects with no observation or local asset effects`, async ({ page }) => {
  const input = await browserFixture(page), before = await page.evaluate(() => fixtureSnapshot()); change(input);
    expect((await seedFromMockVerification(page, input)).status).toBe("blocked");
  expect(await page.evaluate(() => fixtureSnapshot())).toEqual(before);
});
test("default capture response shape and unguarded observation writer remain compatible", async ({ page }) => {
  const input = await browserFixture(page);
  const result = await page.evaluate(async input => {
    const flow = window.LingoFlowProgressLocalDesired, repo = window.LingoFlowSyncStateRepository;
    const context = await flow.captureCloudResponseContext(input.baseline.ownerId, input.baseline.bindingId);
    const p = input.server.progress;
    const result = await repo.recordProgressRemoteObservation(input.baseline.ownerId, input.baseline.bindingId, input.definition.articleId,
      { kind: "revision", revision: p.revision, cursor: p.cursor, parentReadingEpoch: p.parentReadingEpoch,
        contentFingerprint: p.contentFingerprint, checkpoint: { progress: p.progress, paragraphIndex: p.paragraphIndex } });
    return { keys: Object.keys(context), status: result.status };
  }, input);
  expect(result).toEqual({ keys: ["ownerId", "bindingId", "generation"], status: "recorded" });
});
