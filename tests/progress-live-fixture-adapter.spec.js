"use strict";

const { test, expect } = require("./progress-strict-test");
const fixture = require("./progress-live-fixture-helpers");
const adapterModule = require("./progress-live-fixture-adapter");
const runner = require("../scripts/progress-live-fixture-prepare");
const { openFixtureRuntimeSession } = require("./progress-live-fixture-runtime");
const fs = require("node:fs/promises");
const path = require("node:path");
const SECRET = "mock.sentinel.credential";
const KEY = "sb_publishable_mock_private_sentinel";
const URL = "https://yebabpjplbgidzwpjhoy.supabase.co";
const EPOCH = "11111111-2222-4333-8444-555555555555";
const env = () => ({ LF_PROGRESS_LIVE_TEST: "1", LF_PROGRESS_FIXTURE_PREPARE: "1", LF_SUPABASE_URL: URL,
  LF_SUPABASE_PUBLISHABLE_KEY: KEY, LF_PROGRESS_OWNER_A: fixture.OWNER, LF_PROGRESS_JWT_A: SECRET });
const args = ["--dedicated-test-account", "--execute-live-fixture", "--cdp", "http://127.0.0.1:19993/",
  "--runtime-url", "http://127.0.0.1:4173/"];
const options = () => runner.optionsFromArgs(args);
const clone = value => structuredClone(value);
const { articlePushArgs, progressPushArgs, canonicalFixtureResult } = require("./progress-fixture-wire");
// Test-local injected HTTP model; never exported or used as LIVE tooling.
function fakePushHelpers(projectUrl, publishableKey, fetchImpl) {
  const send = async (who, name, wire, lane) => {
    const response = await fetchImpl(`${projectUrl}/rest/v1/rpc/${name}`, {
      method: "POST", headers: { apikey: publishableKey, Authorization: `Bearer ${who.jwt}`,
        Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(wire)
    });
    if (!response.ok) throw new Error("fixture-response-invalid");
    return canonicalFixtureResult(await response.json(), lane, wire);
  };
  return Object.freeze({
    articlePush: (who, id, op, value, base, key) => send(who, "lingoflow_article_sync_push",
      articlePushArgs(who.owner, id, op, value, base, key), "article"),
    progressPush: (who, id, value, key) => send(who, "lingoflow_progress_sync_push",
      progressPushArgs(who.owner, id, value, key), "progress")
  });
}


// Browser traffic uses the centralized strict fixture policy; Node transports
// also fail on ANY uninjected fetch/CLI call. Only sentinel fake HTTP is used.
let oldFetch, oldExec, forbidden;
test.beforeEach(() => {
  forbidden = []; oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { forbidden.push("uninjected-http"); throw new Error("Forbidden LIVE HTTP"); };
  const child = require("node:child_process"); oldExec = child.execFile;
  child.execFile = () => { forbidden.push("uninjected-cli"); throw new Error("Forbidden LIVE CLI"); };
});
test.afterEach(() => {
  globalThis.fetch = oldFetch; require("node:child_process").execFile = oldExec;
  expect(forbidden).toEqual([]);
});

function fakeExecution() {
  const calls = [], output = [];
  const state = { article: null, progress: null, articleResult: null, progressResult: null,
    history: { articleChanges: "0", articleReceipts: "0", progressChanges: "0", progressReceipts: "0",
      articleSetupReceipt: "0", progressSetupReceipt: "0" } };
  const scope = { status: "ready", ownerId: fixture.OWNER, bindingId: "adapter-binding", generation: 1,
    scopeToken: "adapter-scope", runtimeIdentity: "adapter-runtime", stable: true, transitionInactive: true };
  let observation = { kind: "unknown" }, now = 0;
  const runtime = { captureScope: async () => clone(scope),
    finalSendGuard: baseline => fixture.scopeReady(scope) &&
      ["ownerId", "bindingId", "generation", "scopeToken", "runtimeIdentity"].every(k => scope[k] === baseline[k]),
    inspectRuntime: async () => {
      calls.push("inspect-local");
      return { ...clone(scope), scopeValid: true, fencePresent: true, articleId: state.article?.articleId,
        articleActive: true, contentFingerprint: fixture.DIGEST, contentBytes: fixture.BYTES,
        parent: { articleRevision: "revision:1", readingEpoch: EPOCH, contentFingerprint: fixture.DIGEST, lifecycle: "active" },
        bootstrapSafe: true, hasConflict: false, hasMutation: false, pendingMovement: false,
        quarantinedMovement: false, unsettledAttempts: false, observationDiagnostic: false, observation: clone(observation) };
    }, seedObservation: async capability => {
      const input = fixture.consumeVerifiedFixtureSeed(capability);
      if (!input || input.server.progress.cursor !== state.progress.cursor) return { status: "blocked" };
      calls.push("observation"); observation = fixture.observation(input.server.progress); return { status: "recorded" };
    }, close: async () => { calls.push("detach"); } };
  for (const name of ["dispatchProgressCloudAttempt", "prepareProgressCloudAttempt", "reserveCloudAttemptForDispatch",
    "createArticle", "writeRealMovement", "cleanup", "progressPull", "progressInventory", "syncNow", "start"]) {
    Object.defineProperty(runtime, name, { get: () => { throw new Error(`Forbidden production path ${name}`); } });
  }
  const dependencies = {
    files: { ...fs, readFile: async (file, ...rest) => file.endsWith("supabase/.temp/project-ref")
      ? "yebabpjplbgidzwpjhoy\n" : fs.readFile(file, ...rest) },
    openRuntime: async (target, config) => { expect(fixture.ID.test(target.articleId)).toBe(true);
      expect(config.runtimeURL).toBe("http://127.0.0.1:4173/");
      runtime.prepareFixtureSend = async (baseline, packet) => ({ baseline, packet });
      runtime.dispatchFixtureSend = async ticket => {
        expect(config).not.toHaveProperty("consumeSendPermit");
        const { packet } = ticket;
        const response = await dependencies.fetchImpl(`${URL}/rest/v1/rpc/${packet.lane === "article"
          ? "lingoflow_article_sync_push" : "lingoflow_progress_sync_push"}`, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
          headers: { apikey: KEY, Authorization: `Bearer ${SECRET}` }, body: JSON.stringify(packet.wire)
        });
        return { invoked: true, result: await response.json() };
      };
      calls.push("open-runtime"); return runtime; },
    fetchImpl: async (url, init) => {
      expect(init.redirect).toBe("error"); expect(init.signal).toBeDefined();
      if (url.endsWith("/auth/v1/user")) { calls.push("auth-get"); return Response.json({ id: scope.ownerId }); }
      const body = JSON.parse(init.body), m = body.p_mutation;
      expect(body.p_expected_owner_id).toBe(fixture.OWNER);
      if (url.endsWith("/lingoflow_article_sync_push")) {
        calls.push("article-http"); expect(m.operation).toBe("put"); expect(m.baseRevision).toBeNull();
        state.article = { ownerId: fixture.OWNER, articleId: m.articleId, title: fixture.TITLE, revision: "revision:1",
          cursor: "cursor:9007199254740993", readingEpoch: EPOCH, contentFingerprint: fixture.DIGEST,
          computedFingerprint: fixture.DIGEST, contentBytes: fixture.BYTES, lifecycle: "active", deletedAt: null,
          createdAt: m.projection.createdAt, updatedAt: m.projection.updatedAt,
          serverCreatedAt: m.projection.createdAt, serverUpdatedAt: m.projection.updatedAt };
        state.history.articleChanges = state.history.articleReceipts = state.history.articleSetupReceipt = "1";
        state.articleResult = { status: "applied", operation: "put", mutationId: m.mutationId, articleId: m.articleId,
          revision: "revision:1", cursor: state.article.cursor, readingEpoch: EPOCH, contentFingerprint: fixture.DIGEST };
        return Response.json(state.articleResult);
      }
      expect(url.endsWith("/lingoflow_progress_sync_push")).toBe(true);
      calls.push("progress-http"); expect(m.expectedState).toBe("absent");
      expect(m.expectedProgressRevision).toBeNull(); expect(m.progress).toBe(0.2); expect(m.paragraphIndex).toBe(4);
      state.progress = { ownerId: fixture.OWNER, articleId: m.articleId, revision: "revision:1",
        cursor: "cursor:9007199254740995", parentReadingEpoch: EPOCH, contentFingerprint: fixture.DIGEST,
        progress: 0.2, paragraphIndex: 4, serverUpdatedAt: state.article.serverUpdatedAt };
      state.history.progressChanges = state.history.progressReceipts = state.history.progressSetupReceipt = "1";
      state.progressResult = { status: "applied", mutationId: m.mutationId, ...state.progress };
      return Response.json(state.progressResult);
    },
    execFileImpl: async (name, argv, config) => {
      expect(name).toBe("supabase"); expect(argv.slice(0, 5)).toEqual(["db", "query", "--linked", "--output", "json"]);
      expect(argv[5]).toMatch(/^select /); expect(argv[5]).not.toMatch(/\b(insert|update|delete|create|alter|drop)\b/i);
      expect(config.env).not.toHaveProperty("LF_PROGRESS_JWT_A");
      expect(config.env).not.toHaveProperty("LF_PROGRESS_JWT_B");
      calls.push("select"); return { stdout: JSON.stringify([{ state: clone(state) }]) };
    }, now: () => now, sleep: async ms => { now += ms; }, hydrateWaitMs: 1000
  };
  const run = (input = env(), argv = args) => runner.main(input, argv, null, text => output.push(text), dependencies);
  return { dependencies, calls, state, scope, runtime, output, run,
    report: () => JSON.parse(output.at(-1)), get observation() { return observation; } };
}
const writes = f => f.calls.filter(c => c.endsWith("-http"));

test("plain CLI cannot inject real or supplied IO, even with every environment gate", async () => {
  const f = fakeExecution();
  expect(await f.run(env(), ["--dedicated-test-account"])).toBe(2);
  expect(f.report().reason).toBe("fixture-transport-not-injected"); expect(f.calls).toEqual([]);
});
test("help has zero environment access / filesystem / network / journal / adapter IO", async () => {
  const unreadable = new Proxy({}, { get: () => { throw new Error("Environment must not be read"); } });
  const f = fakeExecution(); expect(await f.run(unreadable, ["--help"])).toBe(0);
  expect(f.output.join("")).toContain("--execute-live-fixture"); expect(f.calls).toEqual([]);
});

test("caller permit checker is rejected before any IO", async () => {
  const f = fakeExecution();
  await expect(adapterModule.createExecutionAdapter(env(), { ...options(), consumeSendPermit: () => true }, f.dependencies))
    .rejects.toThrow("invalid-fixture-options");
  expect(f.calls).toEqual([]);
});
for (const lane of ["article", "progress"]) test(`${lane} missing durable attempted mark blocks private dispatch`, async () => {
  const f = fakeExecution();
  f.dependencies.journalFactory = async (...args) => {
    const store = await runner.createJournalStore(...args);
    return { ...store, writeJournal: value => store.writeJournal({ ...value,
      ...(lane === "article" ? { articleAttempted: false } : { progressAttempted: false }) }) };
  };
  expect(await f.run()).toBe(2);
  expect(writes(f)).toEqual(lane === "article" ? [] : ["article-http"]);
  expect(f.report().reason).toBe("fixture-journal-authority-lost");
});
for (const [name, change, argv] of [
  ["LIVE gate", e => { delete e.LF_PROGRESS_LIVE_TEST; }],
  ["fixture gate", e => { delete e.LF_PROGRESS_FIXTURE_PREPARE; }],
  ["dedicated flag", () => {}, args.filter(a => a !== "--dedicated-test-account")],
  ["JWT missing", e => { delete e.LF_PROGRESS_JWT_A; }],
  ["owner mismatch", e => { e.LF_PROGRESS_OWNER_A = EPOCH; }],
  ["URL project mismatch", e => { e.LF_SUPABASE_URL = "https://other.invalid"; }],
  ["debug env", e => { e.DEBUG = "*"; }],
  ["malformed ID", () => {}, [...args, "--article-id", "b3-2b-live-fixture-a-bad"]],
  ["duplicate flag", () => {}, [...args, "--execute-live-fixture"]],
  ["mixed modes", () => {}, [...args, "--validate-only"]],
  ["secret argv", () => {}, [...args, "--jwt", SECRET]],
  ["missing runtime URL", () => {}, args.slice(0, -2)],
  ["remote CDP", () => {}, args.map(a => a.includes("19993") ? "http://remote.invalid:9222/" : a)]
]) test(`${name}: fail before IO or mutation; no secret output`, async () => {
  const f = fakeExecution(), input = env(); change(input);
  let reads = 0; f.dependencies.files.readFile = async () => { reads++; throw new Error("Unexpected IO"); };
  expect(await f.run(input, argv || args)).toBe(2); expect(f.calls).toEqual([]); expect(reads).toBe(0);
  expect(f.output.join("")).not.toContain(SECRET); expect(f.output.join("")).not.toContain(KEY);
});
test("linked Project mismatch precedes Auth/CDP/journal and returns zero counts", async () => {
  const f = fakeExecution(); f.dependencies.files.readFile = async () => "wrong-project";
  expect(await f.run()).toBe(2); expect(f.report().reason).toBe("linked-project-mismatch"); expect(f.calls).toEqual([]);
});
for (const reason of ["runtime absent", "existing-runtime-page-not-unique"]) test(`${reason}: 0 server writes`, async () => {
  const f = fakeExecution(); f.dependencies.openRuntime = async () => { throw new Error(reason); };
  expect(await f.run()).toBe(2); expect(writes(f)).toEqual([]); expect(f.report().status).toBe("NO-GO");
});
test("Auth GET owner mismatch stops before SELECT and mutation", async () => {
  const f = fakeExecution(); f.dependencies.fetchImpl = async () => Response.json({ id: EPOCH });
  expect(await f.run()).toBe(2); expect(f.report().reason).toBe("authenticated-owner-mismatch");
  expect(writes(f)).toEqual([]); expect(f.calls).not.toContain("select");
});
test("explicit recovery path cannot silently allocate a replacement fixture", async () => {
  const f = fakeExecution(); let allocated = false;
  f.dependencies.files.mkdtemp = async () => { allocated = true; throw new Error("No new identity"); };
  const dir = await fs.mkdtemp(path.join(require("node:os").tmpdir(), "lingoflow-progress-fixture-"));
  expect(await f.run(env(), [...args, "--journal", path.join(dir, "preparation.json")])).toBe(2);
  expect(f.report().reason).toBe("recovery-journal-missing"); expect(allocated).toBe(false); expect(writes(f)).toEqual([]);
});
test("supplied strict fixture ID is frozen; trailing newline performs zero IO", async () => {
  const f = fakeExecution(), id = "b3-2b-live-fixture-a-00000000-0000-4000-8000-000000000041";
  expect(await f.run(env(), [...args, "--article-id", id])).toBe(0); expect(f.report().articleId).toBe(id);
  const invalid = fakeExecution(); expect(await invalid.run(env(), [...args, "--article-id", id + "\n"])).toBe(2);
  expect(invalid.calls).toEqual([]);
});
test("malformed Article HTTP result remains attention, no seed/retry; raw secrets never emitted", async () => {
  const f = fakeExecution(), original = f.dependencies.fetchImpl;
  f.dependencies.fetchImpl = async (url, init) => {
    const response = await original(url, init);
    return url.endsWith("/lingoflow_article_sync_push") ? new Response(SECRET) : response;
  };
  expect(await f.run()).toBe(2); const report = f.report();
  expect(report.status).toBe("NO-GO"); expect(report.stage).toBe("attention"); expect(writes(f)).toEqual(["article-http"]);
  expect(report.mutationCounts.articleSetup).toBe(1); expect(f.output.join("")).not.toContain(SECRET);
  f.calls.length = 0;
  expect(await f.run(env(), [...args, "--journal", report.journalPath])).toBe(2);
  expect(f.report().reason).toBe("article-outcome-unknown"); expect(writes(f)).toEqual([]);
});
test("full mock CLI: generated identity/private journal, reused HTTP builders, fresh SELECT, exact 1/1/0/0", async () => {
  const f = fakeExecution(); expect(await f.run()).toBe(0); const report = f.report();
  expect(report.status).toBe("READY"); expect(fixture.ID.test(report.articleId)).toBe(true);
  expect(report.mutationCounts).toEqual({ articleSetup: 1, progressSeed: 1, authenticatedClientUpdate: 0, productionClientCreate: 0 });
  expect(writes(f)).toEqual(["article-http", "progress-http"]);
  expect(f.calls.indexOf("observation")).toBeGreaterThan(f.calls.lastIndexOf("select"));
  expect(f.observation.kind).toBe("revision"); expect(report.article.cursor).toBe("cursor:9007199254740993");
  const raw = await fs.readFile(report.journalPath, "utf8"), journal = JSON.parse(raw);
  expect(journal.stage).toBe("ready"); expect(journal.definition.articleMutationId).not.toBe(journal.definition.progressMutationId);
  expect((await fs.stat(path.dirname(report.journalPath))).mode & 0o077).toBe(0);
  expect((await fs.stat(report.journalPath)).mode & 0o077).toBe(0);
  for (const secret of [SECRET, KEY, fixture.CONTENT]) { expect(raw).not.toContain(secret); expect(f.output.join("")).not.toContain(secret); }
  expect(f.output[0]).toContain("FIXTURE_JOURNALED");
  // Same explicit journal is verify-only, retains ID, never another seed.
  f.calls.length = 0; f.output.length = 0;
  expect(await f.run(env(), [...args, "--journal", report.journalPath])).toBe(0);
  expect(f.report().mode).toBe("verify-only"); expect(f.report().articleId).toBe(report.articleId);
  expect(writes(f)).toEqual([]); expect(f.calls).not.toContain("observation");
});
test("read-only validate has no journal allocation, setup, SQL, Article inspection or observation", async () => {
  const f = fakeExecution(); f.dependencies.files.mkdtemp = async () => { throw new Error("No allocation"); };
  f.runtime.inspectRuntime = async () => { throw new Error("Scope only"); };
  expect(await f.run(env(), args.map(a => a === "--execute-live-fixture" ? "--validate-only" : a))).toBe(0);
  expect(f.report().status).toBe("VALIDATED"); expect(f.report().fixtureReady).toBe(false);
  expect(writes(f)).toEqual([]); expect(f.calls).toEqual(["open-runtime", "auth-get", "detach"]);
});
test("fresh history collision blocks before both requests", async () => {
  const f = fakeExecution(); f.state.history.articleSetupReceipt = "1";
  expect(await f.run()).toBe(2); expect(writes(f)).toEqual([]); expect(f.report().reason).toBe("fixture-history-collision");
});
test("Article accepted then seed network unknown: PARTIAL with exactly one try, no retry/cleanup", async () => {
  const f = fakeExecution(), original = f.dependencies.fetchImpl;
  f.dependencies.fetchImpl = async (url, init) => {
    if (url.endsWith("/lingoflow_progress_sync_push")) { f.calls.push("progress-http"); throw new Error(SECRET); }
    return original(url, init);
  };
  expect(await f.run()).toBe(2); const report = f.report();
  expect(report.status).toBe("PARTIAL"); expect(report.mutationCounts.progressSeed).toBe(1);
  expect(writes(f)).toEqual(["article-http", "progress-http"]); expect(report.completedStage).toBe("article_created");
  expect(f.output.join("")).not.toContain(SECRET);
  f.calls.length = 0;
  expect(await f.run(env(), [...args, "--journal", report.journalPath])).toBe(2);
  expect(f.report().reason).toBe("progress-outcome-unknown"); expect(writes(f)).toEqual([]);
});
test("normal hydrate can arrive later; only readonly polling, no sync/reload/Reader calls", async () => {
  const f = fakeExecution(), original = f.runtime.inspectRuntime; let reads = 0;
  f.runtime.inspectRuntime = async () => ++reads === 1
    ? { status: "unavailable", reason: "local-workspace-or-fence-unresolved" } : original();
  expect(await f.run()).toBe(0); expect(reads).toBeGreaterThan(1); expect(writes(f)).toHaveLength(2);
});
test("hydrate unavailable returns PARTIAL, leaves server fixture, no local seed", async () => {
  const f = fakeExecution(); f.runtime.inspectRuntime = async () => ({ status: "unavailable", reason: "local-workspace-or-fence-unresolved" });
  expect(await f.run()).toBe(2); expect(f.report().status).toBe("PARTIAL"); expect(writes(f)).toHaveLength(2);
  expect(f.calls).not.toContain("observation"); expect(f.state.progress).not.toBeNull();
});
test("scope changes while waiting: PARTIAL, no rematch / seed", async () => {
  const f = fakeExecution(); f.runtime.inspectRuntime = async () => {
    f.scope.generation++; return { status: "unavailable", reason: "local-workspace-or-fence-unresolved" };
  };
  expect(await f.run()).toBe(2); expect(f.report().reason).toBe("runtime-scope-changed");
  expect(f.calls).not.toContain("observation"); expect(f.calls.filter(c => c === "open-runtime")).toHaveLength(1);
});
test("fresh SELECT mismatch before seed capability: no local observation", async () => {
  const f = fakeExecution(), original = f.dependencies.execFileImpl; let reads = 0;
  f.dependencies.execFileImpl = async (...argv) => {
    if (++reads === 5) f.state.progress.progress = 0.4;
    return original(...argv);
  };
  expect(await f.run()).toBe(2); expect(f.calls).not.toContain("observation");
});
test("guarded observation blocked by race: partial, no UPDATE or new identity", async () => {
  const f = fakeExecution(); f.runtime.seedObservation = async cap => {
    fixture.consumeVerifiedFixtureSeed(cap); return { status: "blocked" };
  };
  expect(await f.run()).toBe(2); expect(f.report().reason).toBe("observation-seed-failed"); expect(f.observation).toEqual({ kind: "unknown" });
  expect(f.report().mutationCounts.authenticatedClientUpdate).toBe(0);
});
test("independent HTTP budget blocks helper double-send and arbitrary/update RPC", async () => {
  const f = fakeExecution(); const originalFactory = fakePushHelpers;
  f.dependencies.pushHelpers = (url, key, http) => {
    const push = originalFactory(url, key, http);
    return { ...push, articlePush: async (...argv) => { await push.articlePush(...argv); return push.articlePush(...argv); } };
  };
  expect(await f.run()).toBe(2); expect(writes(f)).toEqual(["article-http"]); expect(f.report().mutationCounts.articleSetup).toBe(1);
  const second = fakeExecution();
  second.dependencies.pushHelpers = (url, key, http) => ({
    articlePush: async () => http(`${url}/rest/v1/rpc/lingoflow_progress_sync_push`, { method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${SECRET}` }, body: JSON.stringify({
        p_expected_owner_id: fixture.OWNER, p_mutation: { expectedState: "revision" } }) }), progressPush: async () => {} });
  expect(await second.run()).toBe(2); expect(writes(second)).toEqual([]);
});
test("independent Progress HTTP budget and disallowed RPC remain fail-closed", async () => {
  const f = fakeExecution(), factory = fakePushHelpers;
  f.dependencies.pushHelpers = (url, key, http) => {
    const push = factory(url, key, http);
    return { ...push, progressPush: async (...argv) => { await push.progressPush(...argv); return push.progressPush(...argv); } };
  };
  expect(await f.run()).toBe(2); expect(writes(f)).toEqual(["article-http", "progress-http"]);
  expect(f.report().mutationCounts.progressSeed).toBe(1); expect(f.report().status).toBe("PARTIAL");
  const forbiddenRPC = fakeExecution();
  forbiddenRPC.dependencies.pushHelpers = (url, key, http) => ({
    articlePush: async () => http(`${url}/rest/v1/rpc/lingoflow_progress_sync_pull`, { method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${SECRET}` }, body: "{}" }), progressPush: async () => {} });
  expect(await forbiddenRPC.run()).toBe(2); expect(writes(forbiddenRPC)).toEqual([]);
});
test("adapter not imported by production; production UPDATE/CREATE/triggers remain untouched", async () => {
  const source = await fs.readFile(path.join(__dirname, "progress-live-fixture-adapter.js"), "utf8");
  expect(source).not.toMatch(/\.(dispatchProgressCloudAttempt|prepareProgressCloudAttempt|reserveCloudAttemptForDispatch|createArticle|writeRealMovement|syncNow|start|cleanup|progressPull|progressInventory)\s*\(/);
  const index = await fs.readFile(path.join(__dirname, "../index.html"), "utf8"); expect(index).not.toContain("progress-live-fixture");
  expect(adapterModule.zeroCounts()).toMatchObject({ authenticatedClientUpdate: 0, productionClientCreate: 0 });
});
test("existing real test CDP: two matching pages fail closed without creating/rematching a page", async ({ page, context }) => {
  await page.goto("/"); const second = await context.newPage(); await second.goto("/");
  const before = context.pages().length;
  try {
    await expect(openFixtureRuntimeSession({ ownerId: fixture.OWNER,
      articleId: "b3-2b-live-fixture-a-00000000-0000-4000-8000-000000000051" },
    { cdpURL: "http://127.0.0.1:19993/", runtimeURL: "http://127.0.0.1:4173/", exactRuntimeURL: true }))
      .rejects.toThrow("existing-runtime-page-not-unique");
    expect(context.pages()).toHaveLength(before);
  } finally { await second.close(); }
});
test("existing real test CDP: exact LIVE URL rejects a query-variant page", async ({ page }) => {
  await page.goto("/?fixture-test-query=1");
  await expect(openFixtureRuntimeSession({ ownerId: fixture.OWNER,
    articleId: "b3-2b-live-fixture-a-00000000-0000-4000-8000-000000000052" },
  { cdpURL: "http://127.0.0.1:19993/", runtimeURL: "http://127.0.0.1:4173/", exactRuntimeURL: true }))
    .rejects.toThrow("existing-runtime-page-not-unique");
  expect(page.url()).toContain("fixture-test-query=1");
});

test("send authority RED: generation changes during final linked check, zero Article HTTP", async () => {
  const f = fakeExecution(), read = f.dependencies.files.readFile; let linkedReads = 0;
  f.dependencies.files.readFile = async (file, ...rest) => {
    if (file.endsWith("supabase/.temp/project-ref") && ++linkedReads === 5) f.scope.generation++;
    return read(file, ...rest);
  };
  expect(await f.run()).toBe(2); expect(writes(f)).toEqual([]);
});
test("send authority RED: direct IO mutation seams are not exported", async () => {
  const f = fakeExecution();
  const adapter = await adapterModule.createExecutionAdapter(env(), options(), f.dependencies);
  expect(adapter.createIO).toBeUndefined(); expect(adapter.articleSetup).toBeUndefined();
  expect(adapter.progressSeed).toBeUndefined(); expect(writes(f)).toEqual([]);
});
test("recovery authority RED: journal disappears after metadata check, never create fresh", async () => {
  const first = fakeExecution(); expect(await first.run()).toBe(0);
  const old = first.report(), f = fakeExecution(), lstat = f.dependencies.files.lstat;
  f.dependencies.files.lstat = async file => {
    const info = await lstat(file);
    if (file === old.journalPath) await fs.rename(file, file + ".red-evidence");
    return info;
  };
  expect(await f.run(env(), [...args, "--journal", old.journalPath])).toBe(2);
  expect(writes(f)).toEqual([]); expect(f.output.join("")).not.toContain("FIXTURE_JOURNALED");
  expect(f.report().reason).toBe("recovery-journal-missing");
  await expect(fs.lstat(old.journalPath)).rejects.toMatchObject({ code: "ENOENT" });
});
for (const kind of ["inspect", "capture"]) for (const late of [false, true]) {
  test(`hydrate deadline RED: ${kind} ${late ? "late resolution" : "never resolves"} stops continuation`, async () => {
    const f = fakeExecution(); f.dependencies.now = () => performance.now(); f.dependencies.hydrateWaitMs = 25;
    let resolveLate, callsAfterLate = 0;
    const pending = new Promise(resolve => { resolveLate = resolve; });
    const inspect = f.runtime.inspectRuntime, capture = f.runtime.captureScope;
    if (kind === "inspect") f.runtime.inspectRuntime = () => {
      f.calls.push("inspect-hanging"); return pending;
    };
    else f.runtime.captureScope = () => f.calls.includes("inspect-local") ? pending : capture();
    const result = await Promise.race([f.run().then(code => ({ code })),
      new Promise(resolve => setTimeout(() => resolve({ pending: true }), 180))]);
    expect(result.pending).not.toBe(true); expect(result.code).toBe(2);
    expect(f.report().status).toBe("PARTIAL"); expect(f.report().reason).toBe("hydrate-timeout");
    expect(writes(f)).toEqual(["article-http", "progress-http"]); expect(f.calls).not.toContain("observation");
    if (late) {
      const value = kind === "inspect" ? await inspect() : await capture();
      const before = f.calls.length;
      resolveLate(value);
      await new Promise(resolve => setTimeout(resolve, 35)); callsAfterLate = f.calls.length - before;
      expect(callsAfterLate).toBe(0); expect(f.calls).not.toContain("observation");
      expect(f.report().status).toBe("PARTIAL");
    }
  });
}

for (const lane of ["article", "progress"]) for (const field of ["ownerId", "generation", "bindingId", "scopeToken", "runtimeIdentity", "transitionInactive"]) {
  test(`${lane} final synchronous guard rejects changed ${field} before HTTP`, async () => {
    const f = fakeExecution(), factory = fakePushHelpers;
    f.dependencies.pushHelpers = (url, key, http) => {
      const push = factory(url, key, http), name = lane === "article" ? "articlePush" : "progressPush";
      return { ...push, [name]: (...argv) => {
        f.scope[field] = field === "generation" ? f.scope[field] + 1
          : field === "transitionInactive" ? false : "changed-scope";
        return push[name](...argv);
      } };
    };
    expect(await f.run()).toBe(2);
    expect(writes(f)).toEqual(lane === "article" ? [] : ["article-http"]);
    expect(f.report().reason).toBe("runtime-scope-changed"); expect(f.calls).not.toContain("observation");
  });
}
for (const lane of ["article", "progress"]) test(`${lane} permit cannot authorize the wrong mutationId`, async () => {
  const f = fakeExecution(), factory = fakePushHelpers;
  f.dependencies.pushHelpers = (url, key, http) => {
    const push = factory(url, key, http), name = lane === "article" ? "articlePush" : "progressPush";
    return { ...push, [name]: (...argv) => {
      argv[lane === "article" ? 5 : 3] = "00000000-0000-4000-8000-000000000099";
      return push[name](...argv);
    } };
  };
  expect(await f.run()).toBe(2); expect(writes(f)).toEqual(lane === "article" ? [] : ["article-http"]);
});
test("article window cannot mint a Progress permit and fake boolean authority is rejected", async () => {
  const f = fakeExecution();
  f.dependencies.pushHelpers = (url, key, http) => ({
    articlePush: (who, articleId, op, value, base, mutationId) => http(`${url}/rest/v1/rpc/lingoflow_progress_sync_push`, {
      method: "POST", headers: { apikey: key, Authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ p_expected_owner_id: fixture.OWNER, p_mutation: { articleId, mutationId,
        expectedState: "absent", expectedProgressRevision: null, progress: 0.2, paragraphIndex: 4,
        parentReadingEpoch: EPOCH, contentFingerprint: fixture.DIGEST }, permit: {}, ready: true, scopeValid: true }) }),
    progressPush: async () => { throw new Error("Progress must not run"); } });
  expect(await f.run()).toBe(2); expect(writes(f)).toEqual([]);
  expect(f.report().reason).toBe("fixture-send-authority-missing");
});
test("Progress window cannot mint an Article permit", async () => {
  const f = fakeExecution(), factory = fakePushHelpers;
  f.dependencies.pushHelpers = (url, key, http) => {
    const push = factory(url, key, http); let original;
    return { articlePush: (...argv) => { original = argv; return push.articlePush(...argv); },
      progressPush: () => push.articlePush(...original) };
  };
  expect(await f.run()).toBe(2); expect(writes(f)).toEqual(["article-http"]);
  expect(f.report().reason).toBe("fixture-send-authority-missing");
});
test("captured HTTP plus serialized authority cannot be reused after orchestrated execution", async () => {
  const f = fakeExecution(), factory = fakePushHelpers;
  let capturedHTTP, request;
  f.dependencies.pushHelpers = (url, key, http) => {
    capturedHTTP = http;
    return factory(url, key, (target, init) => {
      if (target.endsWith("/lingoflow_article_sync_push")) request = { url: target, init: clone(init) };
      return http(target, init);
    });
  };
  expect(await f.run()).toBe(0);
  await expect(capturedHTTP(request.url, { ...request.init, permit: {}, ready: true })).rejects.toThrow("fixture-send-authority-missing");
  expect(writes(f)).toEqual(["article-http", "progress-http"]);
});
test("a helper await loses its send window; valid payload cannot dispatch later", async () => {
  const f = fakeExecution(), factory = fakePushHelpers;
  f.dependencies.pushHelpers = (url, key, http) => {
    const push = factory(url, key, http);
    return { ...push, articlePush: async (...argv) => { await Promise.resolve(); return push.articlePush(...argv); } };
  };
  expect(await f.run()).toBe(2); expect(writes(f)).toEqual([]);
  expect(f.report().reason).toBe("fixture-send-authority-missing");
});
for (const kind of ["journal", "lock", "symlink", "attempted", "mutationId"]) test(`final send rejects lost ${kind} authority`, async () => {
  const f = fakeExecution(), factory = fakePushHelpers;
  f.dependencies.pushHelpers = (url, key, http) => {
    const push = factory(url, key, http);
    return { ...push, articlePush: (...argv) => {
      const file = JSON.parse(f.output[0]).journalPath, sync = require("node:fs");
      if (kind === "lock") sync.renameSync(path.join(path.dirname(file), ".preparation.lock"), file + ".retained-lock");
      else if (kind === "attempted" || kind === "mutationId") {
        const value = JSON.parse(sync.readFileSync(file, "utf8"));
        if (kind === "attempted") value.articleAttempted = false;
        else value.definition.articleMutationId = "00000000-0000-4000-8000-000000000091";
        sync.writeFileSync(file, JSON.stringify(value));
      } else {
        sync.renameSync(file, file + ".retained-send-evidence");
        if (kind === "symlink") sync.symlinkSync(file + ".retained-send-evidence", file);
      }
      return push.articlePush(...argv);
    } };
  };
  expect(await f.run()).toBe(2); expect(writes(f)).toEqual([]);
  expect(f.report().reason).toBe("fixture-journal-authority-lost");
});
for (const kind of ["replaced", "symlink", "invalid", "empty"]) test(`explicit recovery ${kind} fails closed without a new journal or fixture`, async () => {
  const first = fakeExecution(); expect(await first.run()).toBe(0);
  const old = first.report(), f = fakeExecution(), lstat = f.dependencies.files.lstat;
  const content = await fs.readFile(old.journalPath, "utf8");
  f.dependencies.files.lstat = async file => {
    const info = await lstat(file);
    if (file === old.journalPath) {
      if (kind === "replaced" || kind === "symlink") {
        await fs.rename(file, file + ".retained-recovery-evidence");
        if (kind === "replaced") await fs.writeFile(file, content, { mode: 0o600 });
        else await fs.symlink(file + ".retained-recovery-evidence", file);
      } else await fs.writeFile(file, kind === "empty" ? "" : "{}", { mode: 0o600 });
    }
    return info;
  };
  expect(await f.run(env(), [...args, "--journal", old.journalPath])).toBe(2);
  expect(writes(f)).toEqual([]); expect(f.output.join("")).not.toContain("FIXTURE_JOURNALED");
  expect(f.report().articleId).toBeUndefined();
});
test("absolute hydrate deadline bounds a hanging poll sleep", async () => {
  const f = fakeExecution(); f.dependencies.now = () => performance.now(); f.dependencies.hydrateWaitMs = 25;
  f.runtime.inspectRuntime = async () => ({ status: "unavailable", reason: "local-workspace-or-fence-unresolved" });
  f.dependencies.sleep = () => new Promise(() => {});
  const result = await Promise.race([f.run(), new Promise(resolve => setTimeout(() => resolve("pending"), 180))]);
  expect(result).toBe(2); expect(f.report().status).toBe("PARTIAL"); expect(f.report().reason).toBe("hydrate-timeout");
  expect(writes(f)).toHaveLength(2); expect(f.calls).not.toContain("observation");
});
test("one hydrate deadline survives repeated readiness checks, rather than resetting per call", async () => {
  const f = fakeExecution(), inspect = f.runtime.inspectRuntime;
  f.dependencies.now = () => performance.now(); f.dependencies.hydrateWaitMs = 45;
  f.runtime.inspectRuntime = async () => {
    await new Promise(resolve => setTimeout(resolve, 30)); return inspect();
  };
  expect(await f.run()).toBe(2); expect(f.report().reason).toBe("hydrate-timeout");
  expect(f.calls).not.toContain("observation"); expect(writes(f)).toHaveLength(2);
});
test("Progress final linked await advancing generation sends no Progress HTTP", async () => {
  const f = fakeExecution(), read = f.dependencies.files.readFile; let progressReads = 0;
  f.dependencies.files.readFile = async (file, ...rest) => {
    if (file.endsWith("supabase/.temp/project-ref") && f.output.length) {
      const journal = JSON.parse(await fs.readFile(JSON.parse(f.output[0]).journalPath, "utf8"));
      if (journal.progressAttempted && ++progressReads === 3) f.scope.generation++;
    }
    return read(file, ...rest);
  };
  expect(await f.run()).toBe(2); expect(progressReads).toBe(3);
  expect(writes(f)).toEqual(["article-http"]); expect(f.report().reason).toBe("runtime-scope-changed");
});

for (const change of ["auth trust", "workspace generation", "same URL history"]) {
  test(`actual CDP final send guard rejects ${change} after scope capture`, async ({ page }) => {
    await page.goto("/");
    const articleId = "b3-2b-live-fixture-a-00000000-0000-4000-8000-000000000071";
    await page.evaluate(async ({ owner, articleId, content }) => {
      const scope = { ownerId: owner, bindingId: "adapter-send-binding" };
      window.LingoFlowSupabaseAuth = { getState: () => ({ status: "authenticated", user: { id: owner } }) };
      await LingoFlowSyncStateRepository.bindWorkspace(scope);
      await LingoFlowArticleLibrary.commitArticleSyncProjection(articleId, null,
        { id: articleId, title: "Mock final send", content, sourceType: "paste",
          createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z", deletedAt: null });
      await LingoFlowArticleLibrary.getProgressContext(articleId, scope);
    }, { owner: fixture.OWNER, articleId, content: fixture.CONTENT });
    const session = await openFixtureRuntimeSession({ ownerId: fixture.OWNER, articleId },
      { cdpURL: "http://127.0.0.1:19993/", runtimeURL: "http://127.0.0.1:4173/", exactRuntimeURL: true });
    try {
      const captured = await session.captureScope();
      expect(fixture.scopeReady(captured)).toBe(true); expect(session.finalSendGuard(captured)).toBe(true);
      await page.evaluate(async change => {
        if (change === "auth trust") window.dispatchEvent(new CustomEvent("lingoflow:auth-state"));
        else if (change === "workspace generation") await LingoFlowProgressLocalDesired.prepareAccountSwitch();
        else history.replaceState({}, "", location.href);
      }, change);
      // The test changes the page through a different CDP connection. Delivery
      // of its cancellation event is asynchronous, unlike the adapter's
      // no-await capture-to-send call. Verify revocation, not cross-process
      // simultaneous atomicity or a future send lease.
      await expect.poll(() => session.finalSendGuard(captured), { timeout: 500 }).toBe(false);
    } finally { await session.close(); }
  });
}
