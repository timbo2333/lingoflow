"use strict";

// Explicit test/LIVE IO composition. Not imported by index.html or production.
// Import does no IO. Default CLI never calls this factory without a mode flag.
const fixture = require("./progress-live-fixture-helpers");
const preflight = require("./progress-live-preflight-helpers");
const { inspectExistingRuntime, loopbackURL } = require("./progress-live-runtime-inspector");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { articlePushArgs, progressPushArgs, canonicalFixtureResult, validFixtureSeedWire, freezePlainWire } = require("./progress-fixture-wire");
const { randomUUID } = require("node:crypto");
const { withPageAuthorityBarriers } = require("./progress-page-authority-barriers");
const COUNTS = () => ({ articleSetup: 0, progressSeed: 0, authenticatedClientUpdate: 0, productionClientCreate: 0 });
const SAFE = new Set(["live-gate-disabled", "fixture-gate-disabled", "dedicated-test-account-not-confirmed",
  "dedicated-owner-mismatch", "required-account-a-env-missing", "invalid-account-a-env-or-project",
  "debug-recording-env-enabled", "invalid-fixture-definition", "invalid-fixture-options",
  "fixture-execution-not-authorized", "local-runtime-url-invalid", "linked-project-mismatch",
  "authenticated-owner-mismatch", "read-only-auth-verification-failed", "runtime-scope-changed",
  "existing-runtime-page-not-unique", "local-runtime-unavailable", "fixture-transport-unavailable", "invalid-journal-path",
  "invalid-journal-directory", "invalid-journal-file", "recovery-journal-missing", "fixture-journal-busy",
  "fixture-adapter-request-forbidden", "fixture-adapter-budget-exceeded", "fixture-send-authority-missing",
  "fixture-journal-authority-lost", "recovery-journal-replaced", "invalid-preparation-journal", "hydrate-timeout"]);
const safeReason = error => SAFE.has(error?.message) ? error.message : "fixture-execution-io-failed";
const fail = reason => { throw new Error(reason); };

function checkOptions(env, options) {
  if (Object.hasOwn(options, "consumeSendPermit")) fail("invalid-fixture-options");
  const reason = fixture.environmentError(env, options);
  if (reason) fail(reason);
  if ((options.executeLiveFixture === true) === (options.validateOnly === true)) fail("fixture-execution-not-authorized");
  if (options.articleId !== undefined && (typeof options.articleId !== "string" || !fixture.ID.test(options.articleId))) {
    fail("invalid-fixture-definition");
  }
  try {
    const cdp = loopbackURL(options.cdpURL), runtime = loopbackURL(options.runtimeURL, true);
    if (!cdp.port || runtime.href !== "http://127.0.0.1:4173/") fail("local-runtime-url-invalid");
  } catch { fail("local-runtime-url-invalid"); }
}

// Executed ONLY by our pre-document bootstrap. Both bridge and native fetch
// remain lexical. No global rendezvous, iframe, native-string test or late
// transport capture. The debugger owns the object BEFORE resuming page code.
function createPageSender(trustedNativeFetch, originalDocument, originalURL, barrier, canonical, validWire) {
  let input = null, lifetime = null, documentInvalid = false;
  const revokeDocument = () => { documentInvalid = true; };
  addEventListener("pagehide", revokeDocument, true);
  addEventListener("beforeunload", revokeDocument, true);
  navigation?.addEventListener("navigate", revokeDocument);
  const parse = JSON.parse, stringify = JSON.stringify;
  const readItem = Storage.prototype.getItem;
  const storageKey = "sb-yebabpjplbgidzwpjhoy-auth-token";
  const project = "https://yebabpjplbgidzwpjhoy.supabase.co";
  // This implementation authorizes localhost mocks ONLY. A dedicated LIVE
  // Document must be separately bootstrapped/reviewed; no existing CDP target
  // is retroactively trusted and no production endpoint can be sent here.
  const endpointOrigin = "http://127.0.0.1:4173";
  const prepared = new WeakMap(), entries = new Set(), issued = new Set(), boundaryEvents = [];
  const appendEvent = Array.prototype.push.bind(boundaryEvents);
  const freeze = value => {
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) freeze(item);
      Object.freeze(value);
    }
    return value;
  };
  let disposed = false;
  const currentDocument = () => !!input && !disposed && !documentInvalid && document === originalDocument &&
    location.href === originalURL && originalURL === "http://127.0.0.1:4173/" && lifetime?.authorityCurrent() === true;
  function readBrowserSessionSnapshot() {
    // No SDK token API, enumeration, alternate key or memory fallback.
    try {
      const raw = readItem.call(window.localStorage, storageKey);
      if (typeof raw !== "string") return null;
      const value = parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          typeof value.access_token !== "string" || !value.access_token.trim() ||
          value.access_token.trim() !== value.access_token || typeof value.refresh_token !== "string" ||
          value.token_type !== "bearer" || !value.user || typeof value.user !== "object" || Array.isArray(value.user) ||
          typeof value.user.id !== "string" || !value.user.id.trim() ||
          !Number.isSafeInteger(value.expires_at) || value.expires_at <= 0 ||
          !Number.isFinite(value.expires_in) || value.expires_in <= 0) return null;
      return { token: value.access_token, owner: value.user.id };
    } catch { return null; }
  }
  const configuration = () => {
    const config = Object.getOwnPropertyDescriptor(window, "LingoFlowSupabaseConfig")?.value;
    const url = config && Object.getOwnPropertyDescriptor(config, "projectUrl")?.value;
    const key = config && Object.getOwnPropertyDescriptor(config, "publishableKey")?.value;
    return url === project && typeof key === "string" && /^sb_publishable_[a-zA-Z0-9_-]+$/.test(key) ? key : null;
  };
  const pinned = () => Array.from(document.scripts).some(script =>
    script.src === "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js" &&
    script.integrity === "sha256-WdOUh8NYmEO0EDItij1WLOAiq6HlzLFomO8/sqDaLs0=" && script.crossOrigin === "anonymous") &&
    !Array.from(document.scripts).some(script => /@supabase\/supabase-js@2(?:$|[/?#])/.test(script.src));
  const openExisting = async (name, version, store) => {
    if (!(await indexedDB.databases()).some(db => db.name === name && db.version === version)) return null;
    return new Promise(resolve => {
      let settled = false;
      const finish = db => { if (!settled) { settled = true; resolve(db); } else db?.close(); };
      const req = indexedDB.open(name);
      req.onupgradeneeded = () => req.transaction.abort();
      req.onblocked = req.onerror = () => finish(null);
      req.onsuccess = () => {
        if (req.result.version !== version || !req.result.objectStoreNames.contains(store)) {
          req.result.close(); finish(null);
        } else finish(req.result);
      };
    });
  };
  return {
    evidence: () => boundaryEvents.slice(), // Names only; no session/wire/transport.
    configure: value => {
      if (input || disposed || documentInvalid || originalURL !== "http://127.0.0.1:4173/" ||
          value?.isolatedMock !== true) return false;
      input = Object.freeze(value);
      lifetime = window[input.lifetimeKey];
      return !!lifetime;
    },
    prepare: async packetText => {
      let packet;
      try { packet = freeze(parse(packetText)); } catch { return null; }
      const { lane, scope, wire, publicKey, documentIdentity } = packet;
      if (!currentDocument() || !pinned() || documentIdentity !== input.runtimeIdentity ||
          !["article", "progress"].includes(lane) || issued.has(lane) || publicKey !== configuration() ||
          scope.ownerId !== "db4f9c1c-4563-47a9-8649-150a4fb87a6a" || scope.runtimeIdentity !== input.runtimeIdentity ||
          wire.p_expected_owner_id !== scope.ownerId || wire.p_mutation.articleId !== input.articleId) return null;
      issued.add(lane); // A failed preparation cannot mint a replacement lane.
      if (packet.wireText !== stringify(wire) || typeof packet.wireDigest !== "string" ||
          !validWire(lane, wire, packet.seedContract)) return null;
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(packet.wireText));
      if (Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("") !== packet.wireDigest) return null;
      const callGuard = () => currentDocument();
      const context = await window.LingoFlowProgressLocalDesired.captureCloudResponseContext(scope.ownerId, scope.bindingId, callGuard);
      if (!context?.guard || context.generation !== scope.generation || !context.guard()) return null;
      const snapshot = readBrowserSessionSnapshot();
      if (!snapshot || snapshot.owner !== scope.ownerId) return null;
      let verified = false, timer;
      const controller = new AbortController();
      try {
        timer = setTimeout(() => controller.abort(), 15000);
        const response = await trustedNativeFetch(`${endpointOrigin}/auth/v1/user`, {
          method: "GET", redirect: "error", signal: controller.signal,
          headers: { apikey: publicKey, Authorization: `Bearer ${snapshot.token}`, Accept: "application/json" }
        });
        if (response.ok) verified = (await response.json())?.id === scope.ownerId;
      } catch { /* sanitized, NO-GO */ } finally { clearTimeout(timer); }
      if (!verified || !currentDocument() || !context.guard()) return null;
      const unsubscribe = context.guard.subscribe(() => appendEvent("generation-invalidated"));
      const ticket = Object.freeze(Object.create(null));
      const suffix = lane === "article" ? "lingoflow_article_sync_push" : "lingoflow_progress_sync_push";
      const headers = Object.freeze(Object.assign(Object.create(null), {
        apikey: publicKey, Authorization: `Bearer ${snapshot.token}`,
        Accept: "application/json", "Content-Type": "application/json" }));
      const options = Object.freeze(Object.assign(Object.create(null), { method: "POST", redirect: "error", headers,
        body: packet.wireText, signal: AbortSignal.timeout(30000) }));
      const entry = { lane, scope: Object.freeze(scope), wire, context, token: snapshot.token,
        key: publicKey, url: `${endpointOrigin}/rest/v1/rpc/${suffix}`, options,
        notAfter: performance.now() + 2000, used: false, unsubscribe };
      prepared.set(ticket, entry); entries.add(entry);
      return ticket;
    },
    dispatch: async ticket => {
      const entry = prepared.get(ticket);
      prepared.delete(ticket);
      if (!entry || entry.used) return { invoked: false, reason: "page-authority-invalid" };
      entry.used = true;
      let sync, library;
      const current = () => {
        try {
          const auth = window.LingoFlowSupabaseAuth.getState();
          return currentDocument() && performance.now() < entry.notAfter && entry.context.guard() === true &&
            auth.status === "authenticated" && auth.user?.id === entry.scope.ownerId && configuration() === entry.key;
        } catch { return false; }
      };
      if (!current()) return { invoked: false, reason: "page-authority-invalid" };
      try {
        sync = await openExisting("LingoFlowSyncDB", 7, "control");
        library = await openExisting("LingoFlowLibraryDB", 3, "progressControl");
        if (!sync || !library || !current()) return { invoked: false, reason: "page-authority-invalid" };
        sync.onversionchange = library.onversionchange = () => { disposed = true; };
        const invocation = await barrier(sync, library, entry.scope, current, () => {
          // All options are already plain/frozen, and token never crossed CDP.
          // FINAL synchronous execution segment: no await/Node/Promise/user
          // continuation between this final guard and pristine native invocation.
          const second = readBrowserSessionSnapshot();
          if (!current() || !second || second.owner !== entry.scope.ownerId || second.token !== entry.token) {
            return { invoked: false, reason: "page-authority-invalid" };
          }
          appendEvent("final-validation");
          const requestPromise = trustedNativeFetch(entry.url, entry.options);
          appendEvent("localhost-fetch-invocation");
          return { invoked: true, requestPromise };
        }, entry.notAfter);
        if (!invocation.invoked) return invocation;
        // The utility has released BOTH readonly locks before response await.
        if (!invocation.requestPromise) return { invoked: true, reason: "page-send-unknown" };
        try {
          const response = await invocation.requestPromise;
          if (!response.ok || documentInvalid || disposed) return { invoked: true, reason: "page-send-unknown" };
          return { invoked: true, result: canonical(await response.json(), entry.lane, entry.wire) };
        } catch { return { invoked: true, reason: "page-send-unknown" }; }
      } catch { return { invoked: false, reason: "page-authority-invalid" }; }
      finally { sync?.close(); library?.close(); entry.token = null; entry.options = null;
        entry.unsubscribe?.(); entries.delete(entry); }
    },
    dispose: () => {
      disposed = true; for (const entry of entries) { entry.token = null; entry.options = null; entry.unsubscribe?.(); } entries.clear();
    }
  };
}

// Test-only, temporary Document capability; never loaded by the application.
// History wrappers cancel synchronously (including same-URL navigation), before
// an IDB transaction can commit. CDP's later navigation event is not authority.
function installPageLifetime({ key, bindingName }) {
  const originalDocument = document, originalURL = location.href;
  let invalid = false, scopeGuard = null, boundScope = null, unsubscribeScope = null;
  const listeners = new Set(), historyMethods = [];
  const invalidate = () => {
    if (invalid) return;
    invalid = true;
    // Empty, test-only CDP notification: no session, owner or payload data.
    try { window[bindingName]?.(""); } catch { /* disconnected CDP still cancels locally */ }
    for (const fn of [...listeners]) fn();
  };
  const events = ["pagehide", "beforeunload", "popstate", "hashchange", "freeze"];
  for (const event of events) window.addEventListener(event, invalidate, true);
  for (const name of ["pushState", "replaceState", "go", "back", "forward"]) {
    const original = history[name];
    const wrapped = function(...args) {
      // go/back/forward may replace the Document asynchronously: cancel before
      // initiating them. State methods cancel synchronously after success.
      if (["go", "back", "forward"].includes(name)) invalidate();
      const result = original.apply(this, args);
      invalidate(); return result;
    };
    history[name] = wrapped; historyMethods.push({ name, original, wrapped });
  }
  window.navigation?.addEventListener("navigate", invalidate);
  const lifetime = Object.freeze({
    isCurrent: () => !invalid && document === originalDocument && location.href === originalURL,
    authorityCurrent: () => lifetime.isCurrent() && (!scopeGuard || scopeGuard()),
    subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    bindScope: async expected => {
      const same = value => ["ownerId", "bindingId", "generation", "scopeToken"]
        .every(k => value?.[k] === expected[k]);
      if (!lifetime.isCurrent()) return false;
      if (boundScope) {
        if (!same(boundScope) || !scopeGuard()) { invalidate(); return false; }
        return true;
      }
      const callGuard = () => lifetime.isCurrent();
      callGuard.subscribe = lifetime.subscribe;
      const context = await window.LingoFlowProgressLocalDesired?.captureCloudResponseContext(
        expected.ownerId, expected.bindingId, callGuard);
      if (!lifetime.isCurrent() || context?.generation !== expected.generation || !context.guard?.()) {
        invalidate(); return false;
      }
      scopeGuard = context.guard; boundScope = Object.freeze({ ...expected });
      unsubscribeScope = scopeGuard.subscribe(invalidate);
      if (!scopeGuard()) { invalidate(); return false; }
      return true;
    },
    dispose: () => {
      invalidate();
      unsubscribeScope?.(); listeners.clear();
      for (const event of events) window.removeEventListener(event, invalidate, true);
      window.navigation?.removeEventListener("navigate", invalidate);
      for (const { name, original, wrapped } of historyMethods) if (history[name] === wrapped) history[name] = original;
      delete window[key];
      delete window[bindingName];
    }
  });
  Object.defineProperty(window, key, { value: lifetime, configurable: true });
}

// Explicit test-only page operation. No HTTP, auth/session lookup, Reader
// movement, hydrate, binding creation, desired or attempt preparation.
// PRIVATE: only the verified Node capability consumer may serialize this call.
async function seedExistingFixtureObservation(input) {
  const OWNER = "db4f9c1c-4563-47a9-8649-150a4fb87a6a";
  const ID = /^b3-2b-live-fixture-a-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const denied = () => ({ status: "blocked", reason: "fixture-scope-invalid" });
  const base = input?.baseline, article = input?.server?.article, progress = input?.server?.progress;
  const def = input?.definition;
  if (input?.gates?.live !== true || input.gates.fixture !== true || input.gates.dedicated !== true ||
      base?.ownerId !== OWNER || !ID.test(def?.articleId || "") || base.runtimeIdentity !== input.runtimeIdentity ||
      !base.runtimeIdentity || base.stable !== true || base.transitionInactive !== true ||
      article?.ownerId !== OWNER || progress?.ownerId !== OWNER ||
      article.articleId !== def.articleId || progress.articleId !== def.articleId ||
      article.lifecycle !== "active" || article.readingEpoch !== progress.parentReadingEpoch ||
      article.contentFingerprint !== progress.contentFingerprint || article.contentFingerprint !== def.contentDigest ||
      progress.progress !== 0.2 || progress.paragraphIndex !== 4) return denied();
  const repo = window.LingoFlowSyncStateRepository, flow = window.LingoFlowProgressLocalDesired;
  const library = window.LingoFlowArticleLibrary, causal = window.LingoFlowProgressCausalState;
  if (!repo || !flow || !library || !causal) return denied();
  const next = causal.normalizeObservation({ kind: "revision", revision: progress.revision, cursor: progress.cursor,
    parentReadingEpoch: progress.parentReadingEpoch, contentFingerprint: progress.contentFingerprint,
    checkpoint: { progress: progress.progress, paragraphIndex: progress.paragraphIndex } });
  if (!next) return denied();
  const lifetime = window[input.pageLifetimeKey];
  if (!lifetime?.isCurrent()) return denied();
  let invalid = false, finished = false, syncDB, libraryDB, barrier;
  const invalidators = new Set();
  const invalidate = () => { invalid = true; for (const fn of [...invalidators]) fn(); };
  const callGuard = () => !invalid && !finished && lifetime.isCurrent();
  callGuard.subscribe = fn => {
    invalidators.add(fn);
    const unsubscribe = lifetime.subscribe(fn);
    return () => { invalidators.delete(fn); unsubscribe(); };
  };
  window.addEventListener("pagehide", invalidate);
  window.addEventListener("beforeunload", invalidate);
  const deadline = window.setTimeout(() => {
    invalidate();
    try { barrier?.abort(); } catch { /* already settled */ }
  }, 30000);
  try {
    const context = await flow.captureCloudResponseContext(OWNER, base.bindingId, callGuard);
    if (!context?.guard || context.generation !== base.generation || !context.guard()) return denied();
    const databases = await indexedDB.databases();
    if (!databases.some(d => d.name === "LingoFlowSyncDB" && d.version === 7) ||
        !databases.some(d => d.name === "LingoFlowLibraryDB" && d.version === 3)) return denied();
    const open = name => new Promise((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onupgradeneeded = () => req.transaction.abort();
      req.onblocked = () => reject(new Error("fixture-db-unavailable"));
      req.onerror = () => reject(new Error("fixture-db-unavailable"));
      req.onsuccess = () => resolve(req.result);
    });
    syncDB = await open("LingoFlowSyncDB"); libraryDB = await open("LingoFlowLibraryDB");
    const local = await library.getProgressContext(def.articleId,
      { ownerId: OWNER, bindingId: base.bindingId }, { initialize: false });
    if (local.status !== "ready" || local.scope.scopeToken !== base.scopeToken || local.article.deletedAt ||
        await window.LingoFlowReadingResume.fingerprintContent(local.article.content) !== article.contentFingerprint ||
        !context.guard()) return denied();
    // Hold the EXISTING Library scope/Article/fence behind a readonly barrier
    // until the SyncDB observation transaction settles. Scope replacement is
    // blocked by real IDB locks, not a fictional cross-DB atomic commit.
    let release;
    const barrierDone = new Promise(resolve => { release = resolve; });
    await new Promise((resolve, reject) => {
      barrier = libraryDB.transaction(["articles", "progressFences", "progressControl"], "readonly");
      let articleChecked = false, fenceChecked = false, scopeChecked = false;
      const ready = () => { if (articleChecked && fenceChecked && scopeChecked) resolve(); };
      const ar = barrier.objectStore("articles").get(def.articleId);
      ar.onsuccess = () => {
        if (ar.result?.id !== def.articleId || ar.result.deletedAt || ar.result.content !== local.article.content) {
          invalidate(); barrier.abort(); return;
        }
        articleChecked = true; ready();
      };
      const fr = barrier.objectStore("progressFences").get(def.articleId);
      fr.onsuccess = () => {
        if (JSON.stringify(fr.result) !== JSON.stringify(local.fence)) { invalidate(); barrier.abort(); return; }
        fenceChecked = true; ready();
      };
      const controls = barrier.objectStore("progressControl");
      const wr = controls.get("workspace");
      wr.onsuccess = () => {
        if (wr.result?.ownerId !== OWNER || wr.result.bindingId !== base.bindingId || wr.result.scopeToken !== base.scopeToken) {
          invalidate(); barrier.abort(); return;
        }
        // Native request keepalive contains only readonly gets. No crypto or
        // network is awaited inside either transaction; no durable lock record.
        const keep = () => {
          const req = controls.get("workspace-transition");
          req.onsuccess = () => {
            if (req.result || !context.guard()) { invalidate(); barrier.abort(); return; }
            if (!scopeChecked) { scopeChecked = true; ready(); }
            if (!finished) keep();
          };
        };
        keep();
      };
      barrier.onabort = barrier.onerror = () => { invalidate(); reject(new Error("fixture-library-barrier-aborted")); release(); };
      barrier.oncomplete = () => { if (!finished) invalidate(); release(); };
    });
    if (!context.guard()) return denied();
    // Production validator and monotonic writer are reused; the only change
    // is an opt-in transaction guard, checking private Progress generation.
    const parent = { articleRevision: article.revision, readingEpoch: article.readingEpoch,
      contentFingerprint: article.contentFingerprint, lifecycle: article.lifecycle };
    const result = await repo.recordProgressRemoteObservation(OWNER, base.bindingId, def.articleId, next, context.guard, parent);
    finished = true;
    window.clearTimeout(deadline);
    await barrierDone;
    return ["recorded", "unchanged"].includes(result.status) ? { status: result.status } : denied();
  } catch { return denied(); }
  finally {
    finished = true;
    window.clearTimeout(deadline);
    try { barrier?.abort(); } catch { /* already completed */ }
    syncDB?.close(); libraryDB?.close();
    window.removeEventListener("pagehide", invalidate);
    window.removeEventListener("beforeunload", invalidate);
  }
}

// Explicit LIVE tooling injection only. Never called by plain CLI or the app.
// Private registry of targets CREATED by this harness. An arbitrary already
// running Chrome/CDP page (including the user's 9222) has no registry proof.
const controlledRoots = new Map();
const ownedPageProofs = new WeakMap();

// Bootstrap only: returns a Page, never a sender, ticket, root or raw fetch.
// Owns an empty, service-worker-disabled context with exactly ONE init script.
// Trusted test controllers must not install additional init scripts/extensions.
// Page code is not handed any bootstrap authority. This is NOT a LIVE adapter.
async function openLocalFixtureTestPage(browser) {
  const browserCDP = await browser.newBrowserCDPSession();
  let args;
  try { ({ arguments: args } = await browserCDP.send("Browser.getBrowserCommandLine")); }
  finally { await browserCDP.detach(); }
  if (!Array.isArray(args) || !["--remote-debugging-port=19993", "--remote-debugging-address=127.0.0.1",
    "--disable-extensions", "--enable-automation"].every(flag => args.includes(flag)) ||
    !args.some(flag => flag === "--headless" || flag.startsWith("--headless="))) {
    throw new Error("fixture-transport-unavailable");
  }
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:4173", serviceWorkers: "block" });
  const violations = [];
  context.on("request", request => {
    if (new URL(request.url()).origin !== "http://127.0.0.1:4173") violations.push("external-request");
  });
  await context.route("**/*", route => new URL(route.request().url()).origin === "http://127.0.0.1:4173"
    ? route.fallback() : route.abort());
  const page = await context.newPage(), cdp = await context.newCDPSession(page);
  const { targetInfo } = await cdp.send("Target.getTargetInfo");
  const source = `(() => {\nconst bridge = Object.freeze((${createPageSender.toString()})(window.fetch.bind(window), document, location.href,\n` +
    `(${withPageAuthorityBarriers.toString()}), (${canonicalFixtureResult.toString()}), (${validFixtureSeedWire.toString()})));\n` +
    `debugger;\n})();\n//# sourceURL=lingoflow-private-document-bootstrap.js`;
  const state = { cdp, targetId: targetInfo.targetId, source, root: null, frameId: null,
    contextId: null, error: false, claimed: false, captures: 0, acquiredBeforeResume: false,
    beforeApplication: false, violations };
  const scripts = new Map(), contexts = new Map();
  controlledRoots.set(state.targetId, state); ownedPageProofs.set(page, state);
  cdp.on("Debugger.scriptParsed", event => scripts.set(event.scriptId, event));
  cdp.on("Runtime.executionContextCreated", ({ context: value }) => contexts.set(value.id, value));
  cdp.on("Runtime.executionContextsCleared", () => {
    contexts.clear(); state.root = null;
    if (state.claimed) state.error = true; // NEVER reacquire for an old attempt.
  });
  cdp.on("Debugger.paused", async event => {
    try {
      const frame = event.callFrames[0], parsed = scripts.get(frame?.location.scriptId);
      const actual = await cdp.send("Debugger.getScriptSource", { scriptId: frame.location.scriptId });
      const execution = contexts.get(parsed?.executionContextId);
      const { frameTree } = await cdp.send("Page.getFrameTree");
      if (state.claimed || state.error || state.root || actual.scriptSource !== source ||
          parsed?.url !== "lingoflow-private-document-bootstrap.js" ||
          execution?.auxData?.isDefault !== true || execution.auxData.frameId !== frameTree.frame.id ||
          frameTree.frame.url !== "http://127.0.0.1:4173/") throw new Error("untrusted-bootstrap");
      const object = await cdp.send("Debugger.evaluateOnCallFrame", { callFrameId: frame.callFrameId,
        expression: "bridge", returnByValue: false, objectGroup: "lingoflow-private-document" });
      if (object.exceptionDetails || !object.result.objectId) throw new Error("untrusted-bootstrap");
      const early = await cdp.send("Debugger.evaluateOnCallFrame", { callFrameId: frame.callFrameId,
        expression: "document.scripts.length === 0", returnByValue: true });
      if (early.result?.value !== true) throw new Error("late-bootstrap");
      state.root = object.result.objectId; state.contextId = execution.id; state.frameId = frameTree.frame.id;
      state.captures++; state.acquiredBeforeResume = true; state.beforeApplication = true;
    } catch { state.error = true; state.root = null; }
    finally { await cdp.send("Debugger.resume").catch(() => {}); }
  });
  await cdp.send("Page.enable"); await cdp.send("Runtime.enable"); await cdp.send("Debugger.enable");
  const installed = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source, runImmediately: false, includeCommandLineAPI: false }); // Main world; no isolated world.
  state.scriptIdentifier = installed.identifier;
  cdp.on("close", () => { state.error = true; state.root = null; });
  page.once("close", () => { state.error = true; state.root = null; controlledRoots.delete(state.targetId); });
  return page;
}

// Non-sensitive evidence only. No RemoteObject id, token, transport or tickets.
function inspectLocalFixtureTestPage(page) {
  const proof = ownedPageProofs.get(page);
  if (!proof) return { controlled: false };
  return { controlled: true, captures: proof.captures, acquiredBeforeResume: proof.acquiredBeforeResume,
    beforeApplication: proof.beforeApplication, current: !!proof.root && !proof.error,
    externalRequests: proof.violations.length };
}

async function readLocalFixtureTestEvidence(page) {
  const proof = ownedPageProofs.get(page);
  if (!proof?.root || proof.error) return [];
  const result = await proof.cdp.send("Runtime.callFunctionOn", { objectId: proof.root,
    functionDeclaration: "function(){return this.evidence()}", returnByValue: true });
  if (result.exceptionDetails || !Array.isArray(result.result?.value)) throw new Error("fixture-evidence-unavailable");
  return result.result.value;
}

async function openOwnedRuntimeSession(scope, options, mutationEnabled = false) {
  if (Object.hasOwn(options, "consumeSendPermit")) throw new Error("invalid-fixture-options");
  if (scope?.ownerId !== fixture.OWNER || !fixture.ID.test(scope.articleId)) throw new Error("invalid-fixture-scope");
  const cdp = loopbackURL(options.cdpURL), runtime = loopbackURL(options.runtimeURL, true);
  const browser = await require("playwright").chromium.connectOverCDP(cdp.href, { timeout: 15000, noDefaults: true });
  try {
    const pages = browser.contexts().flatMap(c => c.pages()).filter(page => {
      try { const url = new URL(page.url()); return options.exactRuntimeURL === true
        ? url.href === runtime.href : url.origin === runtime.origin && url.pathname === runtime.pathname; }
      catch { return false; }
    });
    if (pages.length !== 1) throw new Error("existing-runtime-page-not-unique");
    const page = pages[0], runtimeIdentity = randomUUID(), pageLifetimeKey = `__fixtureLifetime_${randomUUID()}`;
    let rootProof = null;
    if (mutationEnabled) {
      const identityCDP = await page.context().newCDPSession(page);
      const { targetInfo } = await identityCDP.send("Target.getTargetInfo");
      await identityCDP.detach();
      rootProof = controlledRoots.get(targetInfo.targetId);
      if (options.isolatedMock !== true || cdp.port !== "19993" || !rootProof?.root ||
          rootProof.error || rootProof.claimed) throw new Error("fixture-transport-unavailable");
      rootProof.claimed = true;
    }
    let invalid = false, lastScope = null;
    const invalidate = () => { invalid = true; };
    const bindingName = `__fixtureInvalidate_${randomUUID().replaceAll("-", "")}`;
    const authorityCDP = await page.context().newCDPSession(page);
    const notification = event => {
      // Isolated native race probes deliberately withhold Node notifications:
      // final page authority must remain sufficient even with a stale Node view.
      if (options.isolatedMock === true && cdp.port === "19993" && options.holdInvalidationNotifications === true) return;
      if (event.name === bindingName && event.payload === "") invalidate();
    };
    authorityCDP.on("Runtime.bindingCalled", notification);
    await authorityCDP.send("Runtime.enable");
    await authorityCDP.send("Runtime.addBinding", { name: bindingName });
    await page.evaluate(installPageLifetime, { key: pageLifetimeKey, bindingName });
    let sender = rootProof?.root || null, senderPromise = null;
    const pageTickets = new WeakMap();
    const prepareFixtureSend = async (scope, packet) => {
      if (invalid || !fixture.scopeReady(scope) || !lastScope ||
          scope.runtimeIdentity !== runtimeIdentity) throw new Error("runtime-scope-changed");
      freezePlainWire(packet); freezePlainWire(scope);
      const text = JSON.stringify(freezePlainWire({ ...packet, scope, documentIdentity: runtimeIdentity }));
      if (!senderPromise) senderPromise = rootProof.cdp.send("Runtime.callFunctionOn", { objectId: sender,
        functionDeclaration: "function(input){return this.configure(input)}", arguments: [{ value: { lifetimeKey: pageLifetimeKey,
        runtimeIdentity, articleId: scopeTargetArticleId,
        isolatedMock: true } }], returnByValue: true });
      if ((await senderPromise).result?.value !== true || rootProof.error || rootProof.root !== sender) throw new Error("runtime-scope-changed");
      const preparation = await rootProof.cdp.send("Runtime.callFunctionOn", { objectId: sender,
        functionDeclaration: "function(text){return this.prepare(text)}", arguments: [{ value: text }],
        awaitPromise: true, returnByValue: false, objectGroup: "lingoflow-private-document" });
      if (preparation.exceptionDetails || !preparation.result?.objectId) throw new Error("runtime-scope-changed");
      const ticket = Object.freeze({});
      pageTickets.set(ticket, preparation.result.objectId);
      return ticket;
    };
    const scopeTargetArticleId = scope.articleId;
    const dispatchFixtureSend = async ticket => {
      const objectId = pageTickets.get(ticket); pageTickets.delete(ticket);
      if (!objectId || invalid || rootProof.error || rootProof.root !== sender || page.isClosed() || page.url() !== runtime.href) throw new Error("fixture-send-authority-missing");
      // Deadline is page-local; a queued call that outlives this Node timeout
      // cannot send. Timeout/disconnection NEVER means definitely not-sent.
      let timer;
      try {
        const result = await Promise.race([rootProof.cdp.send("Runtime.callFunctionOn", { objectId: sender,
          functionDeclaration: "function(ticket){return this.dispatch(ticket)}", arguments: [{ objectId }],
          awaitPromise: true, returnByValue: true }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("page-send-unknown")), 32000); })]);
        if (result.exceptionDetails) throw new Error("page-send-unknown");
        return result.result?.value;
      } catch { return { invoked: null, reason: "page-send-unknown" }; }
      finally { clearTimeout(timer); }
    };
    const navigation = frame => { if (frame === page.mainFrame()) invalidate(); };
    page.on("close", invalidate); page.on("crash", invalidate); page.on("framenavigated", navigation);
    const inspect = async scopeOnly => {
      if (invalid) return { status: "unavailable" };
      if (!await page.evaluate(key => window[key]?.isCurrent() === true, pageLifetimeKey)) return { status: "unavailable" };
      const value = await page.evaluate(inspectExistingRuntime, { ...scope, scopeOnly });
      if (scopeOnly && fixture.scopeReady({ ...value, runtimeIdentity }) && !await page.evaluate(
        ({ key, expected }) => window[key]?.bindScope(expected), { key: pageLifetimeKey, expected: value })) invalidate();
      // Complete the final page-side guard read on the SAME CDP event channel
      // as cancellation. Earlier notifications cannot remain behind this reply.
      // This is a final asynchronous preflight, NOT part of finalSendGuard.
      if (scopeOnly && !invalid) {
        const checked = await authorityCDP.send("Runtime.evaluate", {
          expression: `window[${JSON.stringify(pageLifetimeKey)}]?.authorityCurrent() === true`, returnByValue: true });
        if (checked.result?.value !== true) invalidate();
      }
      const result = invalid || !await page.evaluate(key => window[key]?.isCurrent() === true, pageLifetimeKey)
        ? { status: "unavailable" } : { ...value, runtimeIdentity };
      if (scopeOnly) lastScope = Object.freeze({ ...result });
      return result;
    };
    return { captureScope: () => inspect(true), inspectRuntime: () => inspect(false),
      ...(mutationEnabled ? { prepareFixtureSend, dispatchFixtureSend } : {}),
      // Node preflight only: NOT the final browser authority/send boundary.
      // The private page dispatch revalidates native scope + token synchronously.
      finalSendGuard: expected => !invalid && !page.isClosed() && page.url() === new URL(options.runtimeURL).href &&
        fixture.scopeReady(lastScope) && ["ownerId", "bindingId", "generation", "scopeToken", "runtimeIdentity"]
          .every(k => lastScope[k] === expected[k]),
      cancel: invalidate,
      seedObservation: async capability => {
        const input = fixture.consumeVerifiedFixtureSeed(capability);
        if (!input || invalid || input.baseline.runtimeIdentity !== runtimeIdentity ||
            input.baseline.ownerId !== scope.ownerId || input.definition.articleId !== scope.articleId) return { status: "blocked" };
        try {
          return await page.evaluate(seedExistingFixtureObservation, { ...input, runtimeIdentity, pageLifetimeKey });
        } catch { return { status: "blocked" }; } // Destroyed Document naturally aborts its IDB transaction.
      },
      close: async () => {
        const wasInvalid = invalid; invalid = true;
        if (sender) {
          // Revoked-but-live Documents also need token/realm cleanup. Queue
          // revocation even when invalid; do not wait for a hung/destroyed page.
          const revoke = rootProof.cdp.send("Runtime.callFunctionOn", { objectId: sender,
            functionDeclaration: "function(){this.dispose()}", returnByValue: true }).catch(() => {});
          if (!wasInvalid) await revoke;
          await rootProof.cdp.send("Runtime.releaseObjectGroup", { objectGroup: "lingoflow-private-document" }).catch(() => {});
        }
        const dispose = page.evaluate(key => window[key]?.dispose(), pageLifetimeKey).catch(() => {});
        if (!wasInvalid) await dispose; // On deadline cancellation detach even if the page is hung.
        page.off("close", invalidate); page.off("crash", invalidate); page.off("framenavigated", navigation);
        authorityCDP.off("Runtime.bindingCalled", notification);
        const detach = authorityCDP.detach().catch(() => {});
        // A crashed target cannot acknowledge Target.detachFromTarget. Closing
        // our CDP connection cancels that pending call without closing Chrome.
        if (!wasInvalid) await detach;
        await browser.close(); // detach only, never closes the user's page
      } };
  } catch (error) { await browser.close(); throw error; }
}


// Public read-only facade. The mutation-enabled constructor above is never
// exported. Caller options cannot enable sending or supply permit authority.
async function openReadOnlyRuntimeSession(scope, options) {
  return openOwnedRuntimeSession(scope, options, false);
}

// Private scoped fixture builders. Only the guarded adapter supplies HTTP.
function createFixturePushHelpers(projectUrl, publishableKey, fetchImpl) {
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

async function createExecutionAdapter(env, input, dependencies = {}) {
  checkOptions(env, input); // BEFORE every dependency, filesystem or network call.
  const options = Object.freeze({ ...input, exactRuntimeURL: true });
  const environment = Object.freeze(Object.fromEntries(["LF_PROGRESS_LIVE_TEST", "LF_PROGRESS_FIXTURE_PREPARE",
    "LF_SUPABASE_URL", "LF_SUPABASE_PUBLISHABLE_KEY", "LF_PROGRESS_OWNER_A", "LF_PROGRESS_JWT_A"].map(k => [k, env[k]])));
  const files = dependencies.files || fs;
  const projectDir = path.resolve(__dirname, "..");
  const counts = COUNTS();
  const linked = async () => {
    if ((await files.readFile(path.join(projectDir, "supabase/.temp/project-ref"), "utf8")).trim() !== preflight.PROJECT_REF) {
      fail("linked-project-mismatch");
    }
  };
  await linked();
  let journalPath = null, lastJournal = null, ioCreated = false, frozen = null, parent = null;
  let currentRuntime = null, authScope = null, sendWindow = null, cancelled = false, failureReason = null;
  const permits = new WeakMap(), issued = new Set(); // Module-private, never returned/serialized/journaled.
  const acceptedPermits = new WeakSet();
  const stop = reason => { failureReason = reason; fail(reason); };
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const consumeSendPermit = (permit, ticket) => {
    const proof = permits.get(permit); permits.delete(permit);
    if (!proof || proof.ticket !== ticket || proof.owner !== fixture.OWNER || cancelled ||
        proof.articleId !== frozen?.articleId || proof.mutationId !== frozen[
          proof.lane === "article" ? "articleMutationId" : "progressMutationId"]) stop("fixture-send-authority-missing");
    if (!proof.window.journal.verifySendAuthority(proof.window.snapshot)) stop("fixture-journal-authority-lost");
    if (!currentRuntime?.finalSendGuard(proof.window.scope)) stop("runtime-scope-changed");
    acceptedPermits.add(permit);
    return true; // Node journal authority, NOT final page runtime authority.
  };
  // This network allowlist is independent of browser test policy. No redirect,
  // SDK refresh, retry, old-suite operations, or arbitrary RPC can pass it.
  const http = async (url, init) => {
    if (require("node:util").types.isProxy(init)) fail("fixture-adapter-request-forbidden");
    const descriptors = Object.getOwnPropertyDescriptors(init || {});
    if (Object.values(descriptors).some(d => !("value" in d))) fail("fixture-adapter-request-forbidden");
    if (descriptors.signal && !(descriptors.signal.value instanceof AbortSignal)) fail("fixture-adapter-request-forbidden");
    freezePlainWire(Object.fromEntries(Object.entries(descriptors).filter(([key]) => key !== "signal")
      .map(([key, descriptor]) => [key, descriptor.value])));
    const auth = url === `${environment.LF_SUPABASE_URL}/auth/v1/user` && init?.method === "GET";
    const a = url === `${environment.LF_SUPABASE_URL}/rest/v1/rpc/lingoflow_article_sync_push` && init?.method === "POST";
    const p = url === `${environment.LF_SUPABASE_URL}/rest/v1/rpc/lingoflow_progress_sync_push` && init?.method === "POST";
    if (!auth && !a && !p) fail("fixture-adapter-request-forbidden");
    if (init.headers?.apikey !== environment.LF_SUPABASE_PUBLISHABLE_KEY ||
        init.headers?.Authorization !== `Bearer ${environment.LF_PROGRESS_JWT_A}`) fail("fixture-adapter-request-forbidden");
    if (a || p) {
      const lane = a ? "article" : "progress";
      if (!options.executeLiveFixture || !frozen || !sendWindow || sendWindow.lane !== lane) stop("fixture-send-authority-missing");
      const window = sendWindow; // Only a synchronous, private caller can enter.
      let body;
      try { body = JSON.parse(init.body); } catch { fail("fixture-adapter-request-forbidden"); }
      const m = body?.p_mutation;
      if (Object.keys(body).length !== 2 || Object.keys(m || {}).length !== (a ? 5 : 8)) fail("fixture-adapter-request-forbidden");
      if (body?.p_expected_owner_id !== fixture.OWNER || m?.articleId !== frozen.articleId ||
          m.mutationId !== frozen[a ? "articleMutationId" : "progressMutationId"]) fail("fixture-adapter-request-forbidden");
      if (a ? m.operation !== "put" || m.baseRevision !== null || m.projection?.id !== frozen.articleId ||
          m.projection.title !== fixture.TITLE || m.projection.content !== fixture.CONTENT ||
          m.projection.sourceType !== "paste" || m.projection.createdAt !== frozen.createdAt ||
          m.projection.updatedAt !== frozen.createdAt || m.projection.deletedAt !== null
        : !parent || m.expectedState !== "absent" || m.expectedProgressRevision !== null || m.progress !== 0.2 ||
          m.paragraphIndex !== 4 || m.parentReadingEpoch !== parent.readingEpoch || m.contentFingerprint !== parent.contentFingerprint) {
        fail("fixture-adapter-request-forbidden");
      }
      const key = a ? "articleSetup" : "progressSeed";
      if (counts[key] >= 1 || issued.has(lane)) stop("fixture-adapter-budget-exceeded");
      issued.add(lane); // At most one permit, including a failed final guard.
      const packet = freezePlainWire({ lane, wire: body, wireText: init.body,
        wireDigest: require("node:crypto").createHash("sha256").update(init.body).digest("hex"),
        publicKey: environment.LF_SUPABASE_PUBLISHABLE_KEY,
        seedContract: { ownerId: fixture.OWNER, definition: frozen, parent,
          title: fixture.TITLE, content: fixture.CONTENT } });
      if (!validFixtureSeedWire(lane, body, packet.seedContract)) stop("fixture-adapter-request-forbidden");
      // NO terminal JWT/Authorization/headers cross into page preparation.
      const ticket = await currentRuntime.prepareFixtureSend(window.scope, packet);
      const permit = Object.freeze({});
      permits.set(permit, Object.freeze({ lane, owner: fixture.OWNER, articleId: frozen.articleId,
        mutationId: m.mutationId, wire: init.body, ticket, window }));
      let outcome;
      try {
        consumeSendPermit(permit, ticket); // PRIVATE issuer, never a caller checker.
        outcome = await currentRuntime.dispatchFixtureSend(ticket);
      }
      catch (error) {
        if (acceptedPermits.has(permit)) {
          counts[key]++; // A lost/invalid response AFTER dispatch is unknown.
          fail(lane === "article" ? "article-outcome-unknown" : "progress-outcome-unknown");
        }
        throw error;
      }
      finally { permits.delete(permit); }
      if (!outcome || outcome.invoked !== false) counts[key]++; // Unknown is conservative; no retry.
      if (outcome?.invoked === false) stop("runtime-scope-changed");
      if (!outcome?.result) fail(lane === "article" ? "article-outcome-unknown" : "progress-outcome-unknown");
      return Response.json(outcome.result);
    }
    return fetchImpl(url, { ...init, redirect: "error", signal: init.signal || AbortSignal.timeout(30000) });
  };
  const auth = () => (dependencies.verifyOwner || preflight.verifyOwner)(environment, http);
  const open = dependencies.openRuntime || ((scope, config) => openOwnedRuntimeSession(scope, config, options.executeLiveFixture === true));
  const journalFactory = dependencies.journalFactory || require("../scripts/progress-live-fixture-prepare").createJournalStore;
  const scopeCheck = (current, baseline) => {
    if (!fixture.scopeReady(current) || ["ownerId", "bindingId", "generation", "scopeToken", "runtimeIdentity"]
      .some(k => current[k] !== baseline[k])) fail("runtime-scope-changed");
  };
  const openRuntime = async scope => {
    let session;
    try { session = await open(scope, options); }
    catch (error) {
      if (error?.message === "fixture-transport-unavailable") stop(error.message);
      fail(error?.message === "existing-runtime-page-not-unique" ? error.message : "local-runtime-unavailable");
    }
    let baseline = null, deadlineAt = null;
    const now = dependencies.now || (() => performance.now());
    const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const timeout = () => { cancelled = true; session.cancel?.(); stop("hydrate-timeout"); };
    const within = async factory => {
      if (cancelled) timeout();
      if (deadlineAt === null) return factory();
      const remaining = deadlineAt - now();
      if (remaining <= 0) timeout();
      let timer;
      try {
        return await Promise.race([Promise.resolve().then(() => {
          if (cancelled || now() >= deadlineAt) timeout();
          return factory();
        }).then(value => {
          if (cancelled || now() >= deadlineAt) timeout();
          return value;
        }), new Promise((_, reject) => { timer = setTimeout(() => {
          cancelled = true; session.cancel?.(); failureReason = "hydrate-timeout";
          reject(new Error("hydrate-timeout"));
        }, remaining); })]);
      } finally { clearTimeout(timer); }
    };
    const captureScope = async () => {
      const current = await within(() => session.captureScope());
      if (cancelled) timeout(); // A late result cannot establish/update authority.
      if (!baseline && fixture.scopeReady(current)) baseline = Object.freeze({ ...current });
      if (baseline) scopeCheck(current, baseline);
      return current;
    };
    currentRuntime = { captureScope,
      prepareFixtureSend: (scope, packet) => {
        if (cancelled || typeof session.prepareFixtureSend !== "function") stop("fixture-send-authority-missing");
        return session.prepareFixtureSend(scope, packet);
      },
      dispatchFixtureSend: ticket => {
        if (cancelled || typeof session.dispatchFixtureSend !== "function") stop("fixture-send-authority-missing");
        return session.dispatchFixtureSend(ticket);
      },
      finalSendGuard: scope => !cancelled && typeof session.finalSendGuard === "function" && session.finalSendGuard(scope),
      seedObservation: cap => { if (cancelled) timeout(); return session.seedObservation(cap); },
      close: async () => {
        if (!cancelled) return session.close();
        // Invalidate first; a hung page/late cleanup cannot keep the CLI pending.
        session.cancel?.(); let timer;
        try { await Promise.race([Promise.resolve().then(() => session.close()),
          new Promise(resolve => { timer = setTimeout(resolve, 100); })]); }
        finally { clearTimeout(timer); }
      },
      inspectRuntime: async () => {
        // Existing Article runtime polls every 60s while visible. Only wait and
        // inspect; do NOT call syncNow/start/reload/focus or synthesize hydration.
        if (deadlineAt === null) deadlineAt = now() + (dependencies.hydrateWaitMs ?? 75000);
        do {
          const local = await within(() => session.inspectRuntime());
          await captureScope();
          if (local?.status === "ready" || local?.reason !== "local-workspace-or-fence-unresolved") return local;
          await within(() => sleep(Math.min(500, deadlineAt - now())));
        } while (true);
      } };
    return currentRuntime;
  };
  const explicitJournal = async () => {
    let info;
    try { info = await files.lstat(options.journalPath); } catch { fail("recovery-journal-missing"); }
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65536 || info.uid !== process.getuid() ||
        (info.mode & 0o077) !== 0) fail("invalid-journal-file");
    return journalFactory(options.journalPath, { recoveryIdentity: { ino: info.ino, dev: info.dev } });
  };
  // Private IO composition. The public adapter exposes only orchestrated
  // execute(), never articleSetup/progressSeed/createIO or permit minting.
  const createIO = async notify => {
    if (!options.executeLiveFixture || ioCreated) fail("fixture-execution-not-authorized");
    ioCreated = true;
    let journal;
    if (options.journalPath) { journal = await explicitJournal(); journalPath = options.journalPath; }
    else {
      const dir = await files.mkdtemp(path.join(os.tmpdir(), "lingoflow-progress-fixture-"));
      journalPath = path.join(dir, "preparation.json");
      journal = await journalFactory(journalPath);
    }
    const push = (dependencies.pushHelpers || createFixturePushHelpers)(
      environment.LF_SUPABASE_URL, environment.LF_SUPABASE_PUBLISHABLE_KEY, http);
    const adapter = fixture.serverContractAdapter(push, { owner: fixture.OWNER, jwt: environment.LF_PROGRESS_JWT_A }, environment, options);
    let announced = false;
    const inspectServer = async (scope, def) => {
      await linked();
      return (dependencies.inspectServer || fixture.inspectFixtureServer)(scope, def, {
        readFileImpl: files.readFile.bind(files), execFileImpl: dependencies.execFileImpl });
    };
    const prepareSend = async (lane, def, a = null) => {
      frozen = fixture.validateDefinition(def); parent = a ? fixture.articleFacts(a, frozen) : null;
      if (!authScope || !currentRuntime || cancelled) stop("fixture-send-authority-missing");
      const snapshot = await journal.readJournal();
      if (!snapshot || JSON.stringify(snapshot) !== JSON.stringify(lastJournal) ||
          JSON.stringify(snapshot.definition) !== JSON.stringify(frozen)) stop("fixture-journal-authority-lost");
      if (lane === "article" ? snapshot.completedStage !== "planned" || snapshot.stage !== "planned" ||
          !snapshot.articleAttempted || snapshot.progressAttempted || snapshot.article !== null || snapshot.progress !== null
        : snapshot.completedStage !== "article_created" || !["article_created", "partial"].includes(snapshot.stage) ||
          !snapshot.articleAttempted || !snapshot.progressAttempted || snapshot.progress !== null ||
          JSON.stringify(snapshot.article) !== JSON.stringify(parent)) stop("fixture-journal-authority-lost");
      // Fresh SELECT is authority, not a cached push response/journal assertion.
      const server = await inspectServer({ ownerId: fixture.OWNER, articleId: frozen.articleId }, frozen);
      const verified = fixture.verifyState(server, frozen, lane === "progress", false);
      if (parent && JSON.stringify(verified.article) !== JSON.stringify(parent)) stop("fixture-journal-authority-lost");
      await linked(); // LAST project await, BEFORE final scope revalidation.
      const scope = await currentRuntime.captureScope();
      scopeCheck(scope, authScope);
      if (typeof journal.verifySendAuthority !== "function" || !journal.verifySendAuthority(snapshot) || cancelled) stop("fixture-journal-authority-lost");
      return Object.freeze({ lane, scope: Object.freeze({ ...scope }), snapshot, journal });
    };
    const send = (window, invoke) => {
      if (sendWindow || cancelled) stop("fixture-send-authority-missing");
      sendWindow = window;
      try { return invoke(); } // Shared builder must enter http synchronously; page preparation follows.
      finally { sendWindow = null; } // An awaited/re-entered helper loses authority.
    };
    return { ...journal, openRuntime,
      verifyOwner: async () => {
        await linked(); const owner = await auth();
        if (owner === fixture.OWNER) authScope = Object.freeze({ ...await currentRuntime.captureScope() });
        return owner;
      }, inspectServer,
      writeJournal: async value => {
        const snapshot = fixture.validateJournal(structuredClone(value));
        await journal.writeJournal(snapshot); lastJournal = snapshot;
        if (!announced) {
          announced = true;
          notify?.({ event: "FIXTURE_JOURNALED", articleId: lastJournal.definition.articleId, journalPath,
            stage: lastJournal.stage, mutationCounts: { ...counts } });
        }
      },
      readJournal: async () => {
        try {
          const value = await journal.readJournal();
          if (options.journalPath && !value) stop("recovery-journal-missing");
          lastJournal = value; return value && structuredClone(value);
        } catch (error) { failureReason = safeReason(error); throw error; }
      },
      articleSetup: async def => {
        const window = await prepareSend("article", def);
        return send(window, () => adapter.articleSetup(frozen));
      },
      progressSeed: async (def, a) => {
        const window = await prepareSend("progress", def, a);
        return send(window, () => adapter.progressSeed(frozen, parent));
      } };
  };
  return {
    validateOnly: async () => {
      let runtime;
      try {
        if (options.journalPath) await explicitJournal(); // metadata only; no lock/write/identity allocation
        else await files.access(os.tmpdir(), require("node:fs").constants.W_OK);
        runtime = await openRuntime({ ownerId: fixture.OWNER,
          articleId: options.articleId || "b3-2b-live-fixture-a-00000000-0000-4000-8000-000000000000" });
        const before = await runtime.captureScope();
        if (!fixture.scopeReady(before)) fail("runtime-scope-changed");
        if (await auth() !== fixture.OWNER) fail("authenticated-owner-mismatch");
        await linked(); scopeCheck(await runtime.captureScope(), before);
        return { status: "VALIDATED", fixtureReady: false, mode: "validate-only", authOwner: "match",
          project: "match", runtimeScope: "stable", journalReadiness: "directory-and-file-metadata-only",
          mutationCounts: { ...counts }, safety: preflight.SAFETY };
      } finally { await runtime?.close(); }
    },
    execute: async notify => fixture.runPreparation(environment, options, await createIO(notify)),
    report: result => ({ status: result.status === "ready" ? "READY" : result.stage === "partial" ? "PARTIAL" : "NO-GO",
      ...((failureReason || result.reason) ? { reason: failureReason || result.reason } : {}), ...(result.mode ? { mode: result.mode } : {}),
      ...(lastJournal ? { articleId: lastJournal.definition.articleId, stage: lastJournal.stage,
        completedStage: lastJournal.completedStage,
        ...(lastJournal.article ? { article: { revision: lastJournal.article.revision, cursor: lastJournal.article.cursor,
          readingEpoch: lastJournal.article.readingEpoch, contentFingerprint: lastJournal.article.contentFingerprint } } : {}),
        ...(lastJournal.progress ? { progress: fixture.observation(lastJournal.progress) } : {}) } : {}),
      ...(journalPath ? { journalPath } : {}), mutationCounts: { ...counts }, safety: preflight.SAFETY,
      requiresSeparateUpdateAuthorization: true })
  };
}

module.exports = { createExecutionAdapter, openReadOnlyRuntimeSession, checkOptions, safeReason, zeroCounts: COUNTS,
  openLocalFixtureTestPage, inspectLocalFixtureTestPage, readLocalFixtureTestEvidence };
