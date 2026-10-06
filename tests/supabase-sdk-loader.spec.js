"use strict";

const { test, expect } = require("./progress-strict-test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const source = fs.readFileSync(path.join(__dirname, "../js/supabase-auth-service.js"), "utf8");
const SRC = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js";
const SRI = "sha256-WdOUh8NYmEO0EDItij1WLOAiq6HlzLFomO8/sqDaLs0=";

// Isolated fake DOM, no browser profile/session/HTTP, no public loader test hook.
function harness() {
  const scripts = [], timers = new Map(), storage = new Map(), events = [];
  const cleanupThrows = new Set(), cleanupAttempts = [];
  const cleanup = name => {
    cleanupAttempts.push(name);
    if (cleanupThrows.has(name)) throw new Error("mock cleanup failure");
  };
  let timerId = 0;
  const window = {
    LingoFlowSupabaseConfig: {
      projectUrl: "https://mock.invalid", publishableKey: "sb_publishable_mock"
    },
    location: { search: "", hash: "" },
    dispatchEvent: event => events.push(event)
  };
  const document = {
    currentScript: null,
    createElement(tag) {
      expect(tag).toBe("script");
      const script = { removed: false, remove() {
        cleanup("script-remove"); this.removed = true;
      } };
      for (const name of ["onload", "onerror"]) {
        let handler;
        Object.defineProperty(script, name, {
          get: () => handler,
          set(value) {
            if (value === null) cleanup(name);
            handler = value;
          }
        });
      }
      return script;
    },
    head: { appendChild(script) {
      // These assertions deliberately fail if production ever omits/changes
      // integrity, downgrades to an alias, or changes to another version.
      expect(script.src).toBe(SRC);
      expect(script.integrity).toBe(SRI);
      expect(script.crossOrigin).toBe("anonymous");
      expect(script.async).toBe(true);
      scripts.push(script);
      return script;
    } }
  };
  const context = vm.createContext({ window, document, URLSearchParams,
    localStorage: { getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value) },
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => { cleanup("clear-timeout"); timers.delete(id); }, queueMicrotask,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } }
  });
  const install = () => { vm.runInContext(source, context); return window.LingoFlowSupabaseAuth; };
  const evaluateSdk = (sdk, script = scripts[0]) => {
    document.currentScript = script;
    try { window.supabase = sdk; } finally { document.currentScript = null; }
  };
  const complete = sdk => { evaluateSdk(sdk); scripts[0].onload?.(); };
  return { window, document, scripts, timers, storage, install, evaluateSdk, complete,
    cleanupThrows, cleanupAttempts, run: code => vm.runInContext(code, context) };
}

function sdkFixture({ failFirstCreation = false } = {}) {
  const calls = [];
  const client = { auth: {
    getSession: async () => ({ data: { session: null }, error: null }),
    getUser: async () => ({ data: { user: null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } })
  } };
  const sdk = { createClient(url, key, options) {
    calls.push({ url, keyIsPublishable: key.startsWith("sb_publishable_"), options });
    if (failFirstCreation && calls.length === 1) throw new Error("mock creation failure");
    return client;
  } };
  return { sdk, client, calls };
}

test("pinned SDK exact src / SRI / anonymous are set before append and trusted load wires unchanged Auth options", async () => {
  const h = harness(), auth = h.install(), f = sdkFixture();
  const result = auth.getPublicClient();
  expect(h.scripts).toHaveLength(1);
  h.complete(f.sdk);
  expect(await result).toBe(f.client);
  expect(f.calls).toEqual([{ url: "https://mock.invalid", keyIsPublishable: true,
    options: { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } } }]);
  expect(h.timers.size).toBe(0);
  expect(h.storage.size).toBe(0);
});

test("concurrent callers share one private load and one client; later callers do not append again", async () => {
  const h = harness(), auth = h.install(), f = sdkFixture();
  const a = auth.getPublicClient(), b = auth.getPublicClient(), c = auth.getPublicClient();
  expect(h.scripts).toHaveLength(1);
  h.complete(f.sdk);
  const clients = await Promise.all([a, b, c]);
  expect(clients.every(client => client === f.client)).toBe(true);
  expect(await auth.getPublicClient()).toBe(f.client);
  expect(f.calls).toHaveLength(1);
  expect(h.scripts).toHaveLength(1);
});

for (const kind of ["createClient", "empty", "undefined", "getter"]) {
  test(`preexisting unknown global (${kind}) is rejected without invoking or replacing it`, async () => {
    const h = harness(); let reads = 0, calls = 0;
    const value = kind === "createClient" ? { createClient() { calls++; } } :
      kind === "undefined" ? undefined : {};
    if (kind === "getter") Object.defineProperty(h.window, "supabase", {
      configurable: true, get() { reads++; throw new Error("must not read"); }
    });
    else h.window.supabase = value;
    const before = Object.getOwnPropertyDescriptor(h.window, "supabase");
    await assert.rejects(Promise.resolve(h.install().getPublicClient()), /unexpected-preexisting-supabase-sdk/);
    expect(Object.getOwnPropertyDescriptor(h.window, "supabase")).toEqual(before);
    expect({ reads, calls }).toEqual({ reads: 0, calls: 0 });
    expect(h.scripts).toHaveLength(0);
  });
}

for (const kind of ["SRI/script-error", "network-error", "timeout", "no-global", "no-createClient"]) {
  test(`SDK ${kind} fails closed; later unknown global cannot supply a fallback`, async () => {
    const h = harness(), auth = h.install();
    const result = auth.getPublicClient();
    const failed = assert.rejects(Promise.resolve(result));
    if (kind.endsWith("error")) h.scripts[0].onerror();
    else if (kind === "timeout") {
      const timer = [...h.timers.values()][0];
      expect(timer.delay).toBe(15000); timer.fn();
    } else if (kind === "no-global") h.scripts[0].onload();
    else h.complete({});
    await failed;
    expect(h.scripts[0].removed).toBe(true);
    expect(h.timers.size).toBe(0);
    let fallbackCalls = 0;
    h.window.supabase = { createClient() { fallbackCalls++; } };
    await assert.rejects(Promise.resolve(auth.getPublicClient()));
    expect(fallbackCalls).toBe(0);
    expect(h.scripts).toHaveLength(1);
  });
}

for (const change of ["missing-integrity", "wrong-integrity", "floating-src", "other-version", "cors"]) {
  test(`post-append ${change} cannot become a trusted load`, async () => {
    const h = harness(), auth = h.install(), f = sdkFixture();
    const result = auth.getPublicClient(), failed = assert.rejects(Promise.resolve(result));
    const script = h.scripts[0];
    if (change === "missing-integrity") delete script.integrity;
    if (change === "wrong-integrity") script.integrity = "sha256-invalid";
    if (change === "floating-src") script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
    if (change === "other-version") script.src = SRC.replace("2.117.2", "2.116.0");
    if (change === "cors") script.crossOrigin = "use-credentials";
    h.complete(f.sdk);
    await failed;
    expect(f.calls).toHaveLength(0);
  });
}

test("foreign assignment after append but before onload is not mistaken for SDK execution", async () => {
  const h = harness(), auth = h.install(), foreign = sdkFixture();
  const result = auth.getPublicClient(), failed = assert.rejects(Promise.resolve(result), /unexpected-supabase-sdk-assignment/);
  h.window.supabase = foreign.sdk;
  h.scripts[0].onload?.();
  await failed;
  expect(h.window.supabase).toBe(foreign.sdk);
  expect(foreign.calls).toHaveLength(0);
});

test("assignment from another currentScript is rejected", async () => {
  const h = harness(), auth = h.install(), f = sdkFixture();
  const result = auth.getPublicClient(), failed = assert.rejects(Promise.resolve(result));
  h.evaluateSdk(f.sdk, {});
  await failed; expect(f.calls).toHaveLength(0);
});

test("replacement after owned execution but before onload fails rather than adopting the replacement", async () => {
  const h = harness(), auth = h.install(), original = sdkFixture(), foreign = sdkFixture();
  const result = auth.getPublicClient(), failed = assert.rejects(Promise.resolve(result));
  h.evaluateSdk(original.sdk);
  h.window.supabase = foreign.sdk;
  h.scripts[0].onload?.();
  await failed;
  expect(original.calls).toHaveLength(0); expect(foreign.calls).toHaveLength(0);
});

test("defineProperty global replacement before onload is rejected and preserved", async () => {
  const h = harness(), auth = h.install(), original = sdkFixture(), foreign = sdkFixture();
  const result = auth.getPublicClient(), failed = assert.rejects(Promise.resolve(result));
  h.evaluateSdk(original.sdk);
  Object.defineProperty(h.window, "supabase", { value: foreign.sdk, configurable: true, writable: true });
  h.scripts[0].onload();
  await failed;
  expect(h.window.supabase).toBe(foreign.sdk); expect(foreign.calls).toHaveLength(0);
});

test("trusted SDK and factory references survive a later global/factory replacement", async () => {
  const h = harness(), auth = h.install(), original = sdkFixture({ failFirstCreation: true }), foreign = sdkFixture();
  const result = auth.getPublicClient(), failed = assert.rejects(Promise.resolve(result), /mock creation failure/);
  h.complete(original.sdk);
  await failed;
  h.window.supabase = foreign.sdk;
  original.sdk.createClient = foreign.sdk.createClient;
  expect(await auth.getPublicClient()).toBe(original.client);
  expect(original.calls).toHaveLength(2); expect(foreign.calls).toHaveLength(0);
  expect(h.scripts).toHaveLength(1);
});

test("replacement between onload and client-creation continuation cannot hijack SDK", async () => {
  const h = harness(), auth = h.install(), original = sdkFixture(), foreign = sdkFixture();
  const result = auth.getPublicClient();
  h.complete(original.sdk);
  h.window.supabase = foreign.sdk;
  original.sdk.createClient = foreign.sdk.createClient;
  expect(await result).toBe(original.client);
  expect(foreign.calls).toHaveLength(0);
});

test("a matching preexisting DOM script does not confer trust", async () => {
  const h = harness();
  h.document.querySelector = () => ({ src: SRC, integrity: SRI });
  h.window.supabase = sdkFixture().sdk;
  await assert.rejects(Promise.resolve(h.install().getPublicClient()), /unexpected-preexisting-supabase-sdk/);
  expect(h.scripts).toHaveLength(0);
});

test("fresh module/Document does not inherit old SDK trust", async () => {
  const h = harness(), auth = h.install(), original = sdkFixture();
  const result = auth.getPublicClient(); h.complete(original.sdk); await result;
  await assert.rejects(Promise.resolve(h.install().getPublicClient()), /unexpected-preexisting-supabase-sdk/);
  const fresh = harness(), next = fresh.install(), nextSdk = sdkFixture();
  const nextResult = next.getPublicClient(); fresh.complete(nextSdk.sdk);
  expect(await nextResult).toBe(nextSdk.client);
  expect(fresh.scripts).toHaveLength(1);
});

test("mutable config sdkUrl cannot downgrade the private trust anchor", async () => {
  const h = harness(); h.window.LingoFlowSupabaseConfig.sdkUrl = "http://127.0.0.1:4173/unknown.js";
  const auth = h.install(), original = sdkFixture();
  const result = auth.getPublicClient(); h.complete(original.sdk);
  expect(await result).toBe(original.client);
  expect(h.scripts[0].src).toBe(SRC);
});

// Explicit budget: a leaking VM Promise must fail this test, not merely be
// abandoned when the worker exits. No production timer/test hook is changed.
async function withinBudget(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("SDK waiter remained pending beyond 250ms")), 250);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function beginConcurrent(h) {
  const auth = h.install();
  const outcomes = Promise.allSettled([
    auth.getPublicClient(), auth.getPublicClient(), auth.getPublicClient()
  ]);
  const script = h.scripts[0];
  return { auth, outcomes, script, lateLoad: script.onload, lateError: script.onerror,
    lateTimeout: [...h.timers.values()][0].fn };
}

async function assertCleanupRejected(h, attempt, factories = []) {
  const outcomes = await withinBudget(attempt.outcomes);
  expect(outcomes.map(result => result.status)).toEqual(["rejected", "rejected", "rejected"]);
  expect(outcomes.map(result => result.reason.message)).toEqual(
    Array(3).fill("supabase-sdk-cleanup-failed")
  );
  expect(outcomes.every(result => result.reason === outcomes[0].reason)).toBe(true);
  // Even saved callbacks that survived a failed handler/timer cleanup are inert.
  attempt.lateLoad(); attempt.lateError(); attempt.lateTimeout();
  if (factories[0]) h.evaluateSdk(factories[0].sdk);
  attempt.lateLoad(); attempt.lateError(); attempt.lateTimeout();
  const retry = await withinBudget(Promise.allSettled([attempt.auth.getPublicClient()]));
  expect(retry[0].status).toBe("rejected");
  expect(retry[0].reason).toBe(outcomes[0].reason);
  expect(h.scripts).toHaveLength(1);
  for (const factory of factories) expect(factory.calls).toHaveLength(0);
}

for (const path of ["script-error", "timeout", "missing-api", "replacement-race", "success-onload"]) {
  test(`nonconfigurable global cleanup during ${path} rejects all waiters and late events cannot establish trust`, async () => {
    const h = harness(), a = sdkFixture(), b = sdkFixture(), attempt = beginConcurrent(h);
    if (path === "replacement-race") h.evaluateSdk(a.sdk);
    Object.defineProperty(h.window, "supabase", { configurable: false });
    if (path === "script-error") attempt.script.onerror();
    else if (path === "timeout") attempt.lateTimeout();
    else if (path === "missing-api") h.complete({});
    else if (path === "replacement-race") h.window.supabase = b.sdk;
    else h.complete(a.sdk);
    await assertCleanupRejected(h, attempt, [a, b]);
    expect(h.timers.size).toBe(0);
    expect(attempt.script.removed).toBe(true);
  });
}

for (const operation of ["clear-timeout", "onload", "onerror", "script-remove"]) {
  test(`failure-path ${operation} cleanup exception does not block rejection or later cleanup`, async () => {
    const h = harness(), attempt = beginConcurrent(h), factory = sdkFixture();
    h.cleanupThrows.add(operation);
    attempt.script.onerror();
    expect(Object.getOwnPropertyDescriptor(h.window, "supabase")).toBeUndefined();
    await assertCleanupRejected(h, attempt, [factory]);
    expect(h.cleanupAttempts).toEqual(expect.arrayContaining([
      "clear-timeout", "onload", "onerror", "script-remove"
    ]));
  });
}

for (const operation of ["clear-timeout", "onload", "onerror"]) {
  test(`success-path ${operation} cleanup exception rejects before trusted SDK/factory commit`, async () => {
    const h = harness(), attempt = beginConcurrent(h), factory = sdkFixture();
    h.cleanupThrows.add(operation);
    h.complete(factory.sdk);
    await assertCleanupRejected(h, attempt, [factory]);
    expect(attempt.script.removed).toBe(true);
  });
}

test("releaseGlobal SecurityError is normalized without leaking diagnostics or committing trust", async () => {
  const h = harness(), attempt = beginConcurrent(h), factory = sdkFixture();
  h.run(`{
    const define = Object.defineProperty;
    Object.defineProperty = function(target, name, descriptor) {
      if (target === window && name === "supabase" && "value" in descriptor) {
        const error = new Error("private cleanup diagnostic");
        error.name = "SecurityError";
        throw error;
      }
      return define(target, name, descriptor);
    };
  }`);
  h.complete(factory.sdk);
  await assertCleanupRejected(h, attempt, [factory]);
});

test("multiple cleanup exceptions still settle all waiters and preserve the foreign descriptor", async () => {
  const h = harness(), attempt = beginConcurrent(h);
  for (const operation of ["clear-timeout", "onload", "onerror", "script-remove"]) h.cleanupThrows.add(operation);
  const foreign = {};
  Object.defineProperty(h.window, "supabase", { value: foreign, configurable: false });
  const before = Object.getOwnPropertyDescriptor(h.window, "supabase");
  attempt.script.onerror();
  await assertCleanupRejected(h, attempt);
  expect(Object.getOwnPropertyDescriptor(h.window, "supabase")).toEqual(before);
});

test("unknown preexisting createClient getter is never evaluated", async () => {
  const h = harness(), foreign = {}; let reads = 0;
  Object.defineProperty(foreign, "createClient", { get() { reads++; throw new Error("must not read"); } });
  h.window.supabase = foreign;
  await assert.rejects(Promise.resolve(h.install().getPublicClient()), /unexpected-preexisting-supabase-sdk/);
  expect(reads).toBe(0); expect(h.scripts).toHaveLength(0);
});

test("owned assignment with createClient getter fails API validation without evaluating the getter", async () => {
  const h = harness(), auth = h.install(), sdk = {}; let reads = 0;
  Object.defineProperty(sdk, "createClient", { get() { reads++; throw new Error("must not read"); } });
  const result = auth.getPublicClient();
  h.complete(sdk);
  await assert.rejects(Promise.resolve(result));
  expect(reads).toBe(0);
});
