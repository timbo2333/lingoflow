"use strict";

// Deterministic infrastructure only. Record structural violations, never URLs,
// headers, payloads or credentials. Page routes cannot bypass the request spy.
const requestSeen = new WeakMap();
const contextGuards = new WeakMap();
const browserGuards = new WeakMap();
const pageGuards = new WeakSet();
const { AsyncLocalStorage } = require("node:async_hooks");
const scopeStorage = new AsyncLocalStorage();
const liveScopes = new Set();
function requireOpenScope(scope) {
  if (!scope || scope.closed) throw new Error("Strict network scope is closed");
}
function activeScope() {
  const stored = scopeStorage.getStore();
  if (stored && !stored.closed) return stored;
  // Playwright's fixture use() may resume test code in its own async resource.
  // Each worker executes one test at a time. Ambiguous scopes fail closed;
  // concurrent helper calls otherwise have their own AsyncLocalStorage scope.
  if (liveScopes.size === 1) return [...liveScopes][0];
  if (liveScopes.size > 1) throw new Error("Strict network scope is ambiguous");
  return null;
}
function mockAnnouncements() {
  const key = Symbol.for("lingoflow.strictNetworkAnnouncements");
  if (window[key]) return;
  window[key] = true;
  const original = window.fetch;
  window.fetch = function(resource, ...args) {
    const url = new URL(typeof resource === "string" ? resource : resource.url, location.href);
    if (["mock.invalid", "product-auth.test.supabase.co"].includes(url.hostname) && url.pathname === "/rest/v1/announcements") {
      return Promise.resolve(new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    return original.call(this, resource, ...args);
  };
}
const local = value => {
  try {
    const url = new URL(value);
    return !url.username && !url.password && url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.port === "4173";
  } catch { return false; }
};
function observeForbiddenRequest(request, attempts) {
  let seen = requestSeen.get(attempts);
  if (!seen) { seen = new WeakSet(); requestSeen.set(attempts, seen); }
  if (local(request.url()) || seen.has(request)) return;
  seen.add(request); attempts.push({ kind: "forbidden-external-network" });
}
function assertNoForbiddenNetwork(attempts) {
  if (attempts.length) throw new Error(`Forbidden network attempt count: ${attempts.length}`);
}

const configMock = route => route.fulfill({ contentType: "application/javascript",
  body: 'window.LingoFlowSupabaseConfig=Object.freeze({projectUrl:"https://mock.invalid",publishableKey:"mock-public",sdkUrl:"http://127.0.0.1:4173/__fixture_mock_sdk"});' });
const sdkMock = route => route.fulfill({ contentType: "application/javascript", body: "/* explicit SDK mock */" });

async function disposeContextGuard(guard) {
  guard.context.off("request", guard.request);
  guard.context.off("close", guard.close);
  if (!guard.closed && typeof guard.context.unroute === "function") {
    for (const [pattern, handler] of guard.routes) await guard.context.unroute(pattern, handler);
  }
  if (contextGuards.get(guard.context) === guard) contextGuards.delete(guard.context);
}

async function protectContext(context, scope) {
  requireOpenScope(scope);
  if (scope.contexts.has(context)) {
    await contextGuards.get(context)?.ready;
    requireOpenScope(scope);
    return;
  }
  let guard = contextGuards.get(context);
  if (guard) {
    await guard.ready;
    requireOpenScope(scope);
    scope.contexts.set(context, guard.owner);
    guard.owner = scope;
    return;
  }
  guard = { context, owner: scope, closed: false, routes: [] };
  scope.contexts.set(context, null);
  contextGuards.set(context, guard);
  guard.request = request => observeForbiddenRequest(request, guard.owner.attempts);
  guard.close = () => { guard.closed = true; };
  guard.ready = (async () => {
    context.on("request", guard.request);
    context.on("close", guard.close);
    try {
      await context.addInitScript(mockAnnouncements);
      requireOpenScope(scope);
      const deny = route => local(route.request().url()) ? route.fallback() : route.abort();
      for (const entry of [["**/*", deny], ["**/js/supabase-config.js*", configMock], ["**/__fixture_mock_sdk", sdkMock]]) {
        // Register before awaiting so a partial installation can be unwound.
        guard.routes.push(entry);
        await context.route(...entry);
        requireOpenScope(scope);
      }
    } catch (error) {
      try { await disposeContextGuard(guard); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "Guard installation and cleanup failed"); }
      throw error;
    }
  })();
  await guard.ready;
  requireOpenScope(scope);
}

async function protectBrowser(browser, scope) {
  requireOpenScope(scope);
  let guard = browserGuards.get(browser);
  if (!guard) {
    const original = browser.newContext, own = Object.getOwnPropertyDescriptor(browser, "newContext");
    guard = { browser, original, own, scopes: [] };
    guard.wrapped = async function(...args) {
      // Capture before the original async operation; no late reassignment.
      const owner = guard.scopes.at(-1);
      requireOpenScope(owner);
      const context = await Reflect.apply(original, this, args);
      try { await protectContext(context, owner); }
      catch (error) { try { await context.close(); } catch { /* preserve installation error */ } throw error; }
      return context;
    };
    browser.newContext = guard.wrapped;
    browserGuards.set(browser, guard);
  }
  if (!scope.browsers.has(browser)) { guard.scopes.push(scope); scope.browsers.add(browser); }
  // Existing default/persistent contexts are protected too. Each gets one
  // listener/routes installation; nested verification temporarily transfers
  // accounting ownership rather than adding listeners or double-counting.
  for (const context of browser.contexts()) await protectContext(context, scope);
  requireOpenScope(scope);
}

function releaseBrowsers(scope) {
  for (const browser of scope.browsers) {
    const guard = browserGuards.get(browser);
    guard.scopes = guard.scopes.filter(owner => owner !== scope);
    if (!guard.scopes.length) {
      if (guard.own) Object.defineProperty(browser, "newContext", guard.own);
      else delete browser.newContext;
      browserGuards.delete(browser);
    }
  }
}

function strictBrowserType(type) {
  const methods = new Map();
  return new Proxy(type, { get(target, name) {
    const value = Reflect.get(target, name, target);
    if (typeof value !== "function") return value;
    if (!methods.has(name)) methods.set(name, asyncCapableMethod(name, value));
    return methods.get(name);
    function asyncCapableMethod(name, original) {
      if (!["launch", "launchPersistentContext", "connect", "connectOverCDP"].includes(name)) return original.bind(target);
      return async function(...args) {
        const scope = activeScope();
        const result = await Reflect.apply(original, target, args);
        if (!scope) return result; // Not running a strict deterministic test.
        try {
          const browser = name === "launchPersistentContext" ? result.browser() : result;
          if (browser) await protectBrowser(browser, scope);
          if (name === "launchPersistentContext") await protectContext(result, scope);
          requireOpenScope(scope);
          return result;
        } catch (error) { try { await result.close(); } catch { /* preserve installation error */ } throw error; }
      };
    }
  } });
}

async function installForbiddenNetwork(page) {
  if (pageGuards.has(page)) return;
  pageGuards.add(page);
  page.forbiddenNetworkAttempts ||= [];
  const scope = activeScope();
  const context = typeof page.context === "function" ? page.context() : null;
  if (context && scope) await protectContext(context, scope);
  page.on("request", request => {
    observeForbiddenRequest(request, page.forbiddenNetworkAttempts);
    const owner = contextGuards.get(context)?.owner || scope;
    if (context && owner && !owner.closed) observeForbiddenRequest(request, owner.attempts);
  });
  if (contextGuards.has(context)) return; // Context routes cover every new page/popup.
  await page.addInitScript(mockAnnouncements);
  await page.route("**/*", route => local(route.request().url()) ? route.fallback() : route.abort());
  // Explicit MOCK configuration and SDK, not a wildcard external allowlist.
  await page.route("**/js/supabase-config.js*", configMock);
  await page.route("**/__fixture_mock_sdk", sdkMock);
}
async function runStrictNetworkCase(context, use, browser = context.browser?.()) {
  const scope = { attempts: [], contexts: new Map(), browsers: new Set(), closed: false };
  return scopeStorage.run(scope, async () => {
    liveScopes.add(scope);
    let result, error;
    try {
      if (browser) await protectBrowser(browser, scope);
      await protectContext(context, scope);
      result = await use();
    } catch (failure) { error = failure; }
    finally {
      scope.closed = true; liveScopes.delete(scope); releaseBrowsers(scope);
      for (const [context, previous] of scope.contexts) {
        const guard = contextGuards.get(context);
        if (!guard || guard.owner !== scope) continue;
        const next = previous && !previous.closed ? previous : browserGuards.get(context.browser?.())?.scopes.at(-1);
        if (next && !guard.closed) {
          guard.owner = next;
          if (!next.contexts.has(context)) next.contexts.set(context, null);
        } else {
          try { await disposeContextGuard(guard); }
          catch (failure) { error = error ? new AggregateError([error, failure], "Test body and guard teardown failed") : failure; }
        }
      }
    }
    let violation;
    try { assertNoForbiddenNetwork(scope.attempts); } catch (failure) { violation = failure; }
    if (error && violation) throw new AggregateError([error, violation], "Test body and network policy failed");
    if (error || violation) throw error || violation;
    return result;
  });
}
module.exports = { local, observeForbiddenRequest, assertNoForbiddenNetwork, installForbiddenNetwork,
  runStrictNetworkCase, strictBrowserType };
