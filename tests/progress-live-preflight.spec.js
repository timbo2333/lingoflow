"use strict";

// Deterministic only: sentinel strings are NOT credentials; every external
// request is mocked/trapped. Fixture setup below is explicitly test-local.
const { test, expect, chromium } = require("./progress-strict-test");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const helper = require("./progress-live-preflight-helpers");
const { inspectExistingRuntime, loopbackURL, inspectRuntime, openRuntimeSession } = require("./progress-live-runtime-inspector");
const { main, optionsFromArgs } = require("../scripts/progress-live-preflight");
const config = require("../playwright.progress-preflight.config");
const { installHarness, trapProgressNetwork } = require("./progress-transport-helpers");
const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EPOCH = "11111111-2222-4333-8444-555555555555";
const ARTICLE = "b3-2b-live-readonly-fixture";
const FP = "sha256:" + "a".repeat(64);
const SECRET = "sentinel.notcredential.neverlog";
const env = () => ({ LF_PROGRESS_LIVE_TEST: "1", LF_SUPABASE_URL: `https://${helper.PROJECT_REF}.supabase.co`,
  LF_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_mockonly", LF_PROGRESS_OWNER_A: OWNER,
  LF_PROGRESS_JWT_A: SECRET, LF_PROGRESS_ARTICLE_A: ARTICLE });
const scope = () => ({ ownerId: OWNER, articleId: ARTICLE });
const options = { dedicatedTestAccount: true };
function server() {
  return { article: { ownerId: OWNER, articleId: ARTICLE, revision: "revision:1", cursor: "cursor:2",
    readingEpoch: EPOCH, contentFingerprint: FP, computedFingerprint: FP, lifecycle: "active", contentBytes: 2048 },
  progress: { ownerId: OWNER, articleId: ARTICLE, revision: "revision:10", cursor: "cursor:20",
    parentReadingEpoch: EPOCH, contentFingerprint: FP, progress: 0.2, paragraphIndex: 2 } };
}
function local() {
  return { status: "ready", ownerId: OWNER, bindingId: "readonly-binding", generation: 3, stable: true,
    transitionInactive: true, scopeValid: true, fencePresent: true, articleId: ARTICLE,
    articleActive: true, contentFingerprint: FP, contentBytes: 2048,
    parent: { articleRevision: "revision:1", readingEpoch: EPOCH, contentFingerprint: FP, lifecycle: "active" },
    bootstrapSafe: true, hasConflict: false, hasMutation: false, pendingMovement: false, quarantinedMovement: false,
    unsettledAttempts: false, observationDiagnostic: false,
    observation: { kind: "revision", revision: "revision:10", cursor: "cursor:20",
      parentReadingEpoch: EPOCH, contentFingerprint: FP, checkpoint: { progress: 0.2, paragraphIndex: 2 } },
    reader: { articleId: ARTICLE, baselineArticleId: ARTICLE, baselineFingerprint: FP,
      baseline: { progress: 0.2, paragraphIndex: 2 }, pendingSave: false,
      startY: 0, scrollRange: 2000, anchorOffset: 200, maxScrollY: 2000, currentScrollY: 400,
      paragraphs: [{ index: 3, top: 1000 }, { index: 4, top: 1400 }] } };
}
function mockIO(state = server(), runtime = local()) {
  const calls = [];
  const mutationCalls = [];
  const forbidden = () => { mutationCalls.push("forbidden"); throw new Error("Mutation / setup / cleanup / inventory / pull trap"); };
  const runtimeScope = { status: "ready", ownerId: OWNER, bindingId: "readonly-binding", generation: 3,
    transitionInactive: true, stable: true, scopeToken: "readonly-scope", runtimeIdentity: "readonly-runtime" };
  const io = { calls, mutationCalls, runtimeScope,
    verifyOwner: async () => { calls.push("auth-get"); return OWNER; },
    inspectServer: async () => { calls.push("server-select"); return state; },
    inspectRuntime: async () => { calls.push("runtime-readonly"); return { ...runtime,
      scopeToken: runtimeScope.scopeToken, runtimeIdentity: runtimeScope.runtimeIdentity }; },
    progressPush: forbidden, articlePush: forbidden, cleanup: forbidden,
    create: forbidden, update: forbidden, delete: forbidden, pull: forbidden, inventory: forbidden,
    bootstrap: forbidden, oldLiveSetup: forbidden,
    prepareCloudAttempt: forbidden, dispatchProgressCloudAttempt: forbidden };
  io.openRuntime = async () => {
    calls.push("runtime-connect");
    return { captureScope: async () => { calls.push("scope-read"); return { ...runtimeScope }; },
      inspectRuntime: () => io.inspectRuntime(), close: async () => { calls.push("runtime-close"); } };
  };
  return io;
}

for (const value of [undefined, "0", "true"]) {
  test(`gate ${String(value)} denies before any IO`, async () => {
    const input = env(); input.LF_PROGRESS_LIVE_TEST = value;
    const io = mockIO();
    expect((await helper.runPreflight(input, options, io)).reason).toBe("live-gate-disabled");
    expect(io.calls).toEqual([]);
  });
}
for (const name of helper.REQUIRED.filter(name => name !== "LF_PROGRESS_LIVE_TEST")) {
  test(`missing ${name} denies before any IO`, async () => {
    const input = env(); delete input[name]; const io = mockIO();
    expect((await helper.runPreflight(input, options, io)).reason).toBe("required-account-a-env-missing");
    expect(io.calls).toEqual([]);
  });
}
test("A ready, B absent is permitted; GO stops with zero mutation capability use", async () => {
  const io = mockIO(); const report = await helper.runPreflight(env(), options, io);
  expect(report.decision).toBe("GO");
  expect(report.env.LF_PROGRESS_JWT_B).toBe("missing");
  expect(report.requiresSeparateUpdateAuthorization).toBe(true);
  expect(io.calls).toEqual(["runtime-connect", "scope-read", "auth-get", "server-select", "scope-read",
    "runtime-readonly", "scope-read", "runtime-close"]);
  expect(io.mutationCalls).toEqual([]);
  expect(report.targetCandidate).toEqual({ scrollY: 800, estimatedProgress: 0.4, paragraphIndex: 3,
    authority: "proposal-only-use-real-reader-movement-next-round" });
});
test("whole-preflight scope: original SQL generation 3 to 5 counterexample must be NO-GO", async () => {
  const runtime = local();
  let generation = 3;
  const io = mockIO(server(), runtime);
  io.openRuntime = async () => ({
    captureScope: async () => ({ status: "ready", ownerId: OWNER, bindingId: runtime.bindingId,
      generation, transitionInactive: true, stable: true, scopeToken: "readonly-scope",
      runtimeIdentity: "readonly-runtime" }),
    inspectRuntime: io.inspectRuntime,
    close: async () => {}
  });
  io.inspectServer = async () => { generation = runtime.generation = 5; return server(); };
  const report = await helper.runPreflight(env(), options, io);
  expect(report.decision).toBe("NO-GO");
  expect(report.reason).toBe("runtime-scope-changed-during-preflight");
  expect(io.mutationCalls).toEqual([]);
});
const trustChanges = [
  ["Auth logout/relogin", "verifyOwner", s => { s.generation += 2; }],
  ["Auth token refresh", "verifyOwner", s => { s.generation++; }],
  ["SQL logout/relogin", "inspectServer", s => { s.generation += 2; }],
  ["SQL token refresh", "inspectServer", s => { s.generation++; }],
  ["SQL binding replacement", "inspectServer", s => { s.bindingId = "replacement-binding"; }],
  ["SQL A to B to A", "inspectServer", s => { s.ownerId = EPOCH; s.generation++; s.ownerId = OWNER; s.generation++; }],
  ["SQL binding replacement then original binding", "inspectServer", s => {
    s.bindingId = "replacement-binding"; s.generation++; s.bindingId = "readonly-binding"; s.generation++;
  }],
  ["SQL Library scope token replacement", "inspectServer", s => { s.scopeToken = "replacement-scope"; }],
  ["SQL active workspace transition", "inspectServer", s => { s.transitionInactive = false; }],
  ["SQL completed/rolled-back switch preparation", "inspectServer", s => {
    // Existing production prepareAccountSwitch advances generation BEFORE
    // starting the durable transition, even if that transition is rolled back.
    s.generation++; s.transitionInactive = false; s.transitionInactive = true;
  }],
  ["SQL runtime identity replacement", "inspectServer", s => { s.runtimeIdentity = "replacement-runtime"; }]
];
for (const [name, stage, mutate] of trustChanges) {
  test(`whole-preflight scope: ${name} stops before local comparison/target with zero mutations`, async () => {
    const io = mockIO(); const original = io[stage];
    io[stage] = async (...args) => { const result = await original(...args); mutate(io.runtimeScope); return result; };
    const report = await helper.runPreflight(env(), options, io);
    expect(report.reason).toBe("runtime-scope-changed-during-preflight");
    expect(report.decision).toBe("NO-GO");
    for (const key of ["articleRevision", "progressRevision", "currentProgress", "localArticleAligned", "targetCandidate"]) {
      expect(report).not.toHaveProperty(key);
    }
    expect(io.calls).not.toContain("runtime-readonly");
    expect(io.calls.at(-1)).toBe("runtime-close"); expect(io.mutationCalls).toEqual([]);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });
}
test("whole-preflight scope: changed remote scope prevents even reading server Article/Progress getters", async () => {
  const io = mockIO(); let comparisons = 0;
  io.inspectServer = async () => {
    io.runtimeScope.generation++;
    return { get article() { comparisons++; throw new Error("Server comparison trap"); } };
  };
  expect((await helper.runPreflight(env(), options, io)).reason).toBe("runtime-scope-changed-during-preflight");
  expect(comparisons).toBe(0); expect(io.mutationCalls).toEqual([]);
});
for (const patch of [{ ownerId: EPOCH }, { bindingId: null }, { generation: -1 },
  { transitionInactive: false }, { stable: false }, { scopeToken: null }, { runtimeIdentity: null }]) {
  test(`whole-preflight scope: invalid baseline ${Object.keys(patch)[0]} prevents all remote IO`, async () => {
    const io = mockIO(); Object.assign(io.runtimeScope, patch);
    expect((await helper.runPreflight(env(), options, io)).reason).toBe("local-runtime-scope-baseline-unavailable");
    expect(io.calls).toEqual(["runtime-connect", "scope-read", "runtime-close"]);
    expect(io.mutationCalls).toEqual([]);
  });
}
test("whole-preflight scope: generation changes during local inspection, even with stale local result", async () => {
  const io = mockIO(); const original = io.inspectRuntime;
  io.inspectRuntime = async () => { const result = await original(); io.runtimeScope.generation++; return result; };
  const report = await helper.runPreflight(env(), options, io);
  expect(report.reason).toBe("runtime-scope-changed-during-preflight");
  expect(report).not.toHaveProperty("targetCandidate"); expect(io.mutationCalls).toEqual([]);
});
test("whole-preflight scope: final GO check rejects a last-moment generation change", async () => {
  const io = mockIO(); const open = io.openRuntime;
  io.openRuntime = async () => {
    const runtime = await open(); const capture = runtime.captureScope; let checks = 0;
    runtime.captureScope = async () => {
      if (++checks === 3) io.runtimeScope.generation++;
      return capture();
    };
    return runtime;
  };
  const report = await helper.runPreflight(env(), options, io);
  expect(report.reason).toBe("runtime-scope-changed-during-preflight");
  expect(report.baselineGeneration).toBe(3); expect(report.currentGeneration).toBe(4);
  expect(report).not.toHaveProperty("targetCandidate"); expect(io.mutationCalls).toEqual([]);
});
test("whole-preflight scope: baseline copy cannot move with a reused mutable adapter object", async () => {
  const io = mockIO(); io.openRuntime = async () => ({ captureScope: async () => io.runtimeScope,
    inspectRuntime: io.inspectRuntime, close: async () => {} });
  io.inspectServer = async () => { io.runtimeScope.generation++; return server(); };
  const report = await helper.runPreflight(env(), options, io);
  expect(report.reason).toBe("runtime-scope-changed-during-preflight");
  expect(report.baselineGeneration).toBe(3); expect(report.currentGeneration).toBe(4);
  expect(io.mutationCalls).toEqual([]);
});
for (const at of [1, 2, 3]) {
  test(`whole-preflight scope: scope check ${at} raw failure is sanitized and fail-closed`, async () => {
    const io = mockIO(); const open = io.openRuntime;
    io.openRuntime = async () => {
      const runtime = await open(); const capture = runtime.captureScope; let checks = 0;
      runtime.captureScope = async () => {
        if (++checks === at) throw new Error(`Authorization ${SECRET}`);
        return capture();
      };
      return runtime;
    };
    const report = await helper.runPreflight(env(), options, io);
    expect(report.reason).toBe(at === 1 ? "local-runtime-scope-baseline-unavailable" : "runtime-scope-changed-during-preflight");
    expect(JSON.stringify(report)).not.toContain(SECRET); expect(io.mutationCalls).toEqual([]);
    expect(io.calls.at(-1)).toBe("runtime-close");
    if (at === 1) expect(io.calls).not.toContain("auth-get");
  });
}
test("whole-preflight scope: session disconnect failure cannot leak a raw error or publish GO", async () => {
  const io = mockIO(); const open = io.openRuntime;
  io.openRuntime = async () => { const runtime = await open();
    runtime.close = async () => { throw new Error(`Authorization ${SECRET}`); }; return runtime; };
  const report = await helper.runPreflight(env(), options, io);
  expect(report.decision).toBe("NO-GO"); expect(report.reason).toBe("local-runtime-disconnect-failed");
  expect(report).not.toHaveProperty("targetCandidate");
  expect(JSON.stringify(report)).not.toContain(SECRET); expect(io.mutationCalls).toEqual([]);
});
for (const name of ["trace", "video", "screenshot", "HAR"]) {
  test(`${name} recording is explicitly off`, () => {
    expect(helper.SAFETY[name]).toBe("off");
    if (name !== "HAR") expect(config.use[name]).toBe("off");
    else expect(config.use.recordHar).toBeUndefined();
    expect(helper.SAFETY.requestRecording).toBe(false);
    expect(config.webServer.stderr).toBe("ignore");
    expect(Object.isFrozen(helper.SAFETY)).toBe(true);
  });
}
for (const name of ["DEBUG", "NODE_DEBUG", "PWDEBUG"]) {
  test(`${name} refuses IO rather than risking external credential logging`, async () => {
    const io = mockIO();
    expect((await helper.runPreflight({ ...env(), [name]: "enabled" }, options, io)).reason).toBe("debug-recording-env-enabled");
    expect(io.calls).toEqual([]);
  });
}
test("presence report contains only present/missing, never values", () => {
  expect(new Set(Object.values(helper.envReadiness(env())))).toEqual(new Set(["present", "missing"]));
  expect(JSON.stringify(helper.envReadiness(env()))).not.toContain(SECRET);
});
test("invalid project / credentials deny before network", async () => {
  for (const patch of [{ LF_SUPABASE_URL: "https://other.invalid" }, { LF_PROGRESS_OWNER_A: "not-owner" },
    { LF_PROGRESS_JWT_A: "bad" }, { LF_SUPABASE_PUBLISHABLE_KEY: "service_role_not_allowed" }]) {
    const io = mockIO();
    expect((await helper.runPreflight({ ...env(), ...patch }, options, io)).decision).toBe("NO-GO");
    expect(io.calls).toEqual([]);
  }
});
test("explicit fixture is mandatory; no arbitrary user Article or SQL interpolation", async () => {
  for (const value of [undefined, "ordinary-article", "b3-contract-';delete from public.x", "b3-contract-contains space"]) {
    const io = mockIO(); const input = { ...env(), LF_PROGRESS_ARTICLE_A: value };
    expect((await helper.runPreflight(input, options, io)).decision).toBe("NO-GO");
    expect(io.calls).toEqual([]);
    if (value) expect(() => helper.inspectionSQL(OWNER, value)).toThrow("unsafe-inspection-identity");
  }
});
test("dedicated account attestation is required, not inferred from UUID", async () => {
  const io = mockIO();
  expect((await helper.runPreflight(env(), {}, io)).reason).toBe("dedicated-test-account-not-confirmed");
  expect(io.calls).toEqual([]);
});
test("Auth owner mismatch stops before SQL / full local inspection", async () => {
  const io = mockIO(); io.verifyOwner = async () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const report = await helper.runPreflight(env(), options, io);
  expect(report.reason).toBe("authenticated-owner-mismatch");
  expect(report.authOwner).toBe("mismatch");
  expect(io.calls).toEqual(["runtime-connect", "scope-read", "runtime-close"]);
  expect(JSON.stringify(report)).not.toContain(OWNER);
});
for (const stage of ["openRuntime", "verifyOwner", "inspectServer", "inspectRuntime"]) {
  test(`${stage} raw error/credential/body never enters report or logs`, async () => {
    const io = mockIO(); io[stage] = async () => { throw new Error(`Authorization Bearer ${SECRET} session refresh_token`); };
    const report = JSON.stringify(await helper.runPreflight(env(), options, io));
    expect(report).not.toContain(SECRET); expect(report).not.toContain("Bearer"); expect(report).not.toContain("refresh_token");
    expect(JSON.parse(report).decision).toBe("NO-GO");
  });
}
const serverCases = [
  ["Article absent", s => { s.article = null; }, "fixture-article-absent"],
  ["Article deleted", s => { s.article.lifecycle = "deleted"; }, "fixture-article-deleted"],
  ["oversized", s => { s.article.contentBytes = 1048577; }, "fixture-article-local-only"],
  ["Progress absent, no CREATE", s => { s.progress = null; }, "fixture-progress-row-absent-no-create"],
  ["server epoch mismatch", s => { s.progress.parentReadingEpoch = OWNER; }, "server-article-progress-epoch-or-fingerprint-mismatch"],
  ["server fingerprint mismatch", s => { s.progress.contentFingerprint = "sha256:" + "b".repeat(64); }, "server-article-progress-epoch-or-fingerprint-mismatch"],
  ["int32 overflow", s => { s.progress.paragraphIndex = 2147483648; }, "fixture-progress-invalid"],
  ["numeric revision rejected", s => { s.progress.revision = 10; }, "fixture-progress-invalid"],
  ["fingerprint corruption", s => { s.article.computedFingerprint = "wrong"; }, "server-article-fingerprint-invalid"]
];
for (const [name, change, reason] of serverCases) {
  test(`${name} fails closed without local setup`, async () => {
    const s = server(); change(s); const io = mockIO(s);
    expect((await helper.runPreflight(env(), options, io)).reason).toBe(reason);
    expect(io.calls).toEqual(["runtime-connect", "scope-read", "auth-get", "server-select", "scope-read", "runtime-close"]);
  });
}
const localCases = [
  ["Article mismatch", l => { l.contentFingerprint = "bad"; }, "local-server-article-mismatch"],
  ["unresolved binding", l => { l.bindingId = null; }, "runtime-scope-changed-during-preflight"],
  ["active transition", l => { l.transitionInactive = false; }, "local-workspace-transition"],
  ["unstable generation", l => { l.stable = false; }, "local-generation-or-state-unstable"],
  ["local owner mismatch", l => { l.ownerId = EPOCH; }, "runtime-scope-changed-during-preflight"],
  ["parent context mismatch", l => { l.parent.readingEpoch = OWNER; }, "local-server-parent-context-mismatch"],
  ["bootstrap unsafe", l => { l.bootstrapSafe = false; }, "local-article-parent-not-safe"],
  ["Article conflict", l => { l.hasConflict = true; }, "local-article-parent-not-safe"],
  ["Article pending mutation", l => { l.hasMutation = true; }, "local-article-parent-not-safe"],
  ["pending movement", l => { l.pendingMovement = true; }, "local-progress-intent-or-attempt-unsettled"],
  ["uncertain old attempt", l => { l.unsettledAttempts = true; }, "local-progress-intent-or-attempt-unsettled"],
  ["observation absent", l => { l.observation = { kind: "unknown" }; }, "local-progress-observation-missing"],
  ["observation anomaly", l => { l.observationDiagnostic = true; }, "local-progress-observation-anomaly"],
  ["stale causal revision", l => { l.observation.revision = "revision:9"; }, "local-progress-causal-base-mismatch"],
  ["stale checkpoint", l => { l.observation.checkpoint.progress = 0.1; }, "local-progress-causal-base-mismatch"],
  ["no Reader fixture", l => { l.reader = null; }, "reader-fixture-not-open-with-baseline"],
  ["pending Reader debounce", l => { l.reader.pendingSave = true; }, "no-obvious-forward-reader-target"]
];
for (const [name, change, reason] of localCases) {
  test(`${name}: NO-GO without repair / ingestion`, async () => {
    const l = local(); change(l); const io = mockIO(server(), l);
    expect((await helper.runPreflight(env(), options, io)).reason).toBe(reason);
    expect(io.calls).toEqual(["runtime-connect", "scope-read", "auth-get", "server-select", "scope-read",
      "runtime-readonly", "runtime-close"]);
  });
}
test("near end denies epsilon target; target must have reachable actual geometry", () => {
  expect(helper.planForwardTarget(local().reader, 0.9, FP)).toBeNull();
  const reader = local().reader; reader.paragraphs = [{ index: 3, top: 9000 }];
  expect(helper.planForwardTarget(reader, 0.2, FP)).toBeNull();
  reader.paragraphs = [];
  expect(helper.planForwardTarget(reader, 0.2, FP)).toBeNull();
});
test("fixed SQL is SELECT-only and stringifies every bigint at SQL boundary", () => {
  const sql = helper.inspectionSQL(OWNER, ARTICLE);
  expect(sql.trim().toLowerCase().startsWith("select ")).toBe(true);
  expect(sql).not.toMatch(/\b(insert|update|delete|truncate|alter|call|create|drop|lingoflow_.*_push)\b/i);
  expect(sql).not.toContain(";");
  expect(sql).toContain("revision:' || revision::text");
  expect(sql).toContain("revision:' || server_revision::text");
  expect(sql.match(/cursor:' \|\| cursor::text/g)).toHaveLength(2);
  expect(sql).not.toContain("'content',"); expect(sql).not.toContain(SECRET);
});
test("bigint max is lossless; overflow / zero revision / leading zeros fail closed", async () => {
  const s = server(); const l = local();
  s.progress.revision = l.observation.revision = "revision:9223372036854775807";
  s.progress.cursor = l.observation.cursor = "cursor:9223372036854775807";
  const report = await helper.runPreflight(env(), options, mockIO(s, l));
  expect(report.decision).toBe("GO"); expect(report.progressRevision).toBe(s.progress.revision);
  for (const value of ["revision:9223372036854775808", "revision:0", "revision:01", 9223372036854775807]) {
    expect(helper.validOrdinal(value, "revision")).toBe(false);
  }
});
test("actual Auth adapter permits exactly GET /auth/v1/user, redirects denied", async () => {
  const calls = [];
  const owner = await helper.verifyOwner(env(), async (url, init) => {
    if (/rpc|rest\/v1/.test(url) || init.method !== "GET") throw new Error("mutation endpoint trap");
    calls.push({ url, method: init.method, redirect: init.redirect });
    return { status: 200, json: async () => ({ id: OWNER, session: SECRET }) };
  });
  expect(owner).toBe(OWNER);
  expect(calls).toEqual([{ url: env().LF_SUPABASE_URL + "/auth/v1/user", method: "GET", redirect: "error" }]);
});
test("linked query uses only correct Project A and supports two observed CLI shapes", async () => {
  for (const envelope of [[{ state: server() }], { boundary: true, rows: [{ state: server() }], warning: null }]) {
    let calls = 0;
    const result = await helper.inspectServer(scope(), { readFileImpl: async () => helper.PROJECT_REF,
      execFileImpl: async (file, args, options) => {
        calls++; expect(file).toBe("supabase"); expect(args.slice(0, 5)).toEqual(["db", "query", "--linked", "--output", "json"]);
        expect(args[5]).toBe(helper.inspectionSQL(OWNER, ARTICLE)); expect(options.timeout).toBe(90000);
        expect(options.env.LF_PROGRESS_JWT_A).toBeUndefined(); expect(options.env.LF_PROGRESS_JWT_B).toBeUndefined();
        return { stdout: JSON.stringify(envelope) };
      } });
    expect(calls).toBe(1); expect(result).toEqual(server());
  }
});
test("linked project mismatch causes zero database calls", async () => {
  let calls = 0;
  await expect(helper.inspectServer(scope(), { readFileImpl: async () => "other",
    execFileImpl: async () => { calls++; } })).rejects.toThrow("linked-project-mismatch");
  expect(calls).toBe(0);
});
test("unknown/ambiguous inspection shape fails closed", async () => {
  for (const envelope of [{ data: [{ state: server() }] }, [{ state: server() }, { state: server() }], [{ state: [] }]]) {
    await expect(helper.inspectServer(scope(), { readFileImpl: async () => helper.PROJECT_REF,
      execFileImpl: async () => ({ stdout: JSON.stringify(envelope) }) })).rejects.toThrow();
  }
});
test("runner gate off logs only safe presence facts, even with malicious arguments", async () => {
  let output = "";
  const code = await main({ ...env(), LF_PROGRESS_LIVE_TEST: "0" }, [SECRET], text => { output += text; });
  expect(code).toBe(2); expect(JSON.parse(output).reason).toBe("live-gate-disabled");
  expect(output).not.toContain(SECRET);
});
test("runtime URLs are loopback-only, credential-free; inspector never navigates or dispatches", () => {
  for (const url of ["https://127.0.0.1:9222", "http://remote.invalid/", "http://user:password@localhost/", "http://localhost/?jwt=secret"]) {
    expect(() => loopbackURL(url)).toThrow();
  }
  expect(optionsFromArgs(["--dedicated-test-account", "--cdp", "http://127.0.0.1:9222/",
    "--runtime-url", "http://127.0.0.1:4173/"]).dedicatedTestAccount).toBe(true);
  const source = inspectRuntime.toString() + openRuntimeSession.toString() + inspectExistingRuntime.toString();
  expect(source).not.toMatch(/\.(goto|newPage|newContext|screenshot|recordProgressRemoteObservation|prepareCloudAttempt|dispatchProgressCloudAttempt|writeRealMovement|tracing\.start)\s*\(/);
  expect(source).not.toContain("initialize: true");
  expect(source).toContain("noDefaults: true");
});

async function browserFixture(page) {
  await trapProgressNetwork(page);
  page.__mutationCalls = [];
  page.on("request", req => {
    if (/\/rpc\/(?:lingoflow_)?(?:progress|article).*push|\/rest\/v1\/(?:progress|article)_sync/i.test(req.url())) {
      page.__mutationCalls.push(req.method());
    }
  });
  await page.goto("/");
  await installHarness(page);
  await page.evaluate(async () => { await h.lib.getProgressContext(h.article.id, h.owner); }); // Fixture setup only.
}
test("scope-only baseline uses readonly IDB and never inspects/initializes Article or causal state", async ({ page }) => {
  await browserFixture(page);
  const before = await page.evaluate(() => h.snapshot());
  await page.evaluate(() => {
    const forbidden = () => { throw new Error("Baseline must not inspect Article/causal state"); };
    window.LingoFlowArticleLibrary = { ...h.lib, getProgressContext: forbidden };
    window.LingoFlowSyncStateRepository = { ...h.repo, getProgressCausalSnapshot: forbidden };
    const tx = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function(stores, mode, ...rest) {
      if (mode && mode !== "readonly") throw new Error("Baseline write trap");
      return tx.call(this, stores, mode, ...rest);
    };
    for (const name of ["put", "add", "delete", "clear"]) IDBObjectStore.prototype[name] = forbidden;
  });
  const fixture = await page.evaluate(() => ({ ownerId: h.owner.ownerId, articleId: h.article.id, scopeOnly: true }));
  const baseline = await page.evaluate(inspectExistingRuntime, fixture);
  expect(baseline.status).toBe("ready"); expect(baseline.ownerId).toBe(OWNER);
  expect(baseline.bindingId).toBe("transport-binding"); expect(baseline.transitionInactive).toBe(true);
  expect(baseline.scopeToken).toBeTruthy(); expect(baseline.stable).toBe(true);
  expect(baseline).not.toHaveProperty("observation"); expect(baseline).not.toHaveProperty("reader");
  expect(await page.evaluate(() => h.snapshot())).toEqual(before);
  expect(page.__mutationCalls).toEqual([]); expect(page.__realProgress).toEqual([]);
  expect(await page.evaluate(() => h.authState.calls)).toBe(0);
});
test("real IndexedDB inspection uses readonly transactions; all protocol stores remain byte-identical", async ({ page }) => {
  await browserFixture(page);
  const before = await page.evaluate(() => h.snapshot());
  await page.evaluate(() => {
    window.readonlyViolations = [];
    const tx = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function(stores, mode, ...rest) {
      if (mode && mode !== "readonly") { readonlyViolations.push(mode); throw new Error("local write trap"); }
      return tx.call(this, stores, mode, ...rest);
    };
    for (const name of ["put", "add", "delete", "clear"]) IDBObjectStore.prototype[name] = function() {
      readonlyViolations.push(name); throw new Error("local write trap");
    };
  });
  const fixture = await page.evaluate(() => ({ ownerId: h.owner.ownerId, articleId: h.article.id }));
  const inspected = await page.evaluate(inspectExistingRuntime, fixture);
  expect(inspected.status).toBe("ready"); expect(inspected.stable).toBe(true);
  expect(inspected.parent.readingEpoch).toBe(EPOCH);
  expect(inspected.observation.revision).toBe("revision:10");
  expect(inspected.reader).toBeNull(); // Preflight must not open the Reader to fix this.
  expect(await page.evaluate(() => h.snapshot())).toEqual(before);
  expect(await page.evaluate(() => readonlyViolations)).toEqual([]);
  expect(await page.evaluate(() => h.authState.calls)).toBe(0);
  expect(page.__mutationCalls).toEqual([]); expect(page.__realProgress).toEqual([]);
  expect(JSON.stringify(inspected)).not.toContain("Mock transport fixture");
});
test("actual loopback CDP attach/detach preserves the existing browser and has zero protocol effects", async () => {
  const server = require("node:net").createServer();
  const port = await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
  // A newly launched MOCK-only dedicated context, never the user's profile.
  const context = await chromium.launchPersistentContext("", {
    headless: true, args: [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"] });
  try {
    const page = context.pages()[0];
    await browserFixture(page);
    const fixture = await page.evaluate(() => ({ ownerId: h.owner.ownerId, articleId: h.article.id }));
    const before = await page.evaluate(() => h.snapshot());
    const session = await openRuntimeSession(fixture, { cdpURL: `http://127.0.0.1:${port}/`, runtimeURL: "http://127.0.0.1:4173/" });
    try {
      const baseline = await session.captureScope();
      const result = await session.inspectRuntime();
      const final = await session.captureScope();
      expect(result.status).toBe("ready"); expect(final).toEqual(baseline);
      expect(result.runtimeIdentity).toBe(baseline.runtimeIdentity);
      expect(result.generation).toBe(baseline.generation);
      expect(result.scopeToken).toBe(baseline.scopeToken);
      expect(await page.evaluate(() => h.snapshot())).toEqual(before);
      // Real existing auth notification strategy: same-owner logout/relogin
      // advances generation even when owner/binding end up unchanged.
      await page.evaluate(() => { h.authEvent("signed-out"); h.authEvent("authenticated"); });
      const refreshed = await session.captureScope();
      expect(refreshed.ownerId).toBe(baseline.ownerId); expect(refreshed.bindingId).toBe(baseline.bindingId);
      expect(refreshed.generation).toBe(baseline.generation + 2);
      expect(await page.evaluate(() => h.snapshot())).toEqual(before);
      expect(page.__mutationCalls).toEqual([]); expect(page.__realProgress).toEqual([]);
      expect(await page.evaluate(() => h.authState.calls)).toBe(0);
      // A new document in the same tab cannot reuse the earlier runtime scope.
      await page.route("**/__readonly_identity", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Mock only</title>" }));
      await page.goto("/__readonly_identity");
      expect((await session.captureScope()).status).toBe("unavailable");
    } finally { await session.close(); }
    expect(page.isClosed()).toBe(false);
    expect(context.browser().isConnected()).toBe(true);
    expect(page.__mutationCalls).toEqual([]); expect(page.__realProgress).toEqual([]);
  } finally { await context.close(); }
});
test("real Reader geometry produces proposal without scrolling, recording action, or changing resume", async ({ page }) => {
  await browserFixture(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await page.evaluate(async () => {
    const article = await h.lib.createArticle({ content: Array.from({ length: 40 }, (_, i) =>
      `Paragraph ${i}. ` + "This is a deterministic Reader geometry fixture for readonly planning. ".repeat(12)).join("\n\n") });
    const fp = await h.resume.fingerprintContent(article.content);
    await h.repo.bindArticleRemoteRevision(h.owner.ownerId, h.owner.bindingId, article.id, "revision:1", "b".repeat(64), "active", {
      articleRevision: "revision:1", readingEpoch: h.epoch, contentFingerprint: fp, lifecycle: "active" });
    await h.repo.recordProgressRemoteObservation(h.owner.ownerId, h.owner.bindingId, article.id, {
      kind: "revision", revision: "revision:10", cursor: "cursor:10", parentReadingEpoch: h.epoch,
      contentFingerprint: fp, checkpoint: { progress: 0.2, paragraphIndex: 2 } });
    await h.lib.getProgressContext(article.id, h.owner);
    await openSavedArticle(article.id);
    return { ownerId: h.owner.ownerId, articleId: article.id, fp };
  });
  await expect.poll(() => page.evaluate(() => Boolean(readingProgressSession?.resumeBaseline &&
    !readingProgressSession.dirty && !readingProgressSession.resumeDirty && !readingProgressSaveTimer))).toBe(true);
  const before = await page.evaluate(async id => ({ article: await h.lib.getArticle(id),
    scrollY, records: (await h.snapshot()).records }), fixture.articleId);
  const inspected = await page.evaluate(inspectExistingRuntime, { ownerId: fixture.ownerId, articleId: fixture.articleId });
  expect(inspected.status).toBe("ready");
  const target = helper.planForwardTarget(inspected.reader, 0.2, fixture.fp);
  expect(target).not.toBeNull(); expect(target.estimatedProgress).toBeGreaterThanOrEqual(0.3);
  expect(target.estimatedProgress).toBeLessThanOrEqual(0.85);
  expect(await page.evaluate(async id => ({ article: await h.lib.getArticle(id),
    scrollY, records: (await h.snapshot()).records }), fixture.articleId)).toEqual(before);
  expect(page.__mutationCalls).toEqual([]); expect(page.__realProgress).toEqual([]);
});
for (const existingVersion of [null, 6]) {
  test(`absent / older DB ${existingVersion} is never created or upgraded by inspector`, async ({ page }) => {
    await page.route("**/__readonly_blank", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Mock only</title>" }));
    await page.goto("/__readonly_blank");
    await page.evaluate(async version => {
      window.LingoFlowSyncStateRepository = {}; window.LingoFlowArticleLibrary = {};
      window.LingoFlowProgressLocalDesired = {}; window.LingoFlowProgressCausalState = {}; window.LingoFlowSupabaseAuth = {};
      if (version) await new Promise((resolve, reject) => {
        const req = indexedDB.open("LingoFlowSyncDB", version);
        req.onupgradeneeded = () => req.result.createObjectStore("control");
        req.onsuccess = () => { req.result.close(); resolve(); }; req.onerror = reject;
      });
    }, existingVersion);
    const before = await page.evaluate(() => indexedDB.databases());
    expect((await page.evaluate(inspectExistingRuntime, scope())).status).toBe("unavailable");
    expect(await page.evaluate(() => indexedDB.databases())).toEqual(before);
  });
}
test("production wiring is untouched: no new script, HTTP adapter, or automatic callers", () => {
  const html = readFileSync(path.resolve(__dirname, "../index.html"), "utf8");
  expect(html).not.toContain("progress-live-preflight"); expect(html).not.toContain("progress-live-runtime-inspector");
  const runner = readFileSync(path.resolve(__dirname, "../scripts/progress-live-preflight.js"), "utf8");
  expect(runner).not.toMatch(/dispatchProgressCloudAttempt\(|prepareCloudAttempt\(|reserveCloudAttemptForDispatch\(/);
});
