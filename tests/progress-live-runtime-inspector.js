"use strict";

// Serialized into an ALREADY OPEN dedicated runtime. Never navigate, scroll,
// log in, initialize DBs, ingest observations, reconcile, or prepare an action.
async function inspectExistingRuntime(scope) {
  const handles = [];
  const unavailable = reason => ({ status: "unavailable", ...(reason ? { reason } : {}) });
  async function openExisting(name, version, stores) {
    const known = (await indexedDB.databases()).find(db => db.name === name);
    if (known?.version !== version) return null; // Known absence, not a read failure.
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(name); // No version, no schema migration.
      req.onupgradeneeded = () => { req.transaction.abort(); };
      req.onerror = () => reject(new Error("existing-db-open-failed"));
      req.onblocked = () => reject(new Error("existing-db-blocked"));
      req.onsuccess = () => resolve(req.result);
    });
    handles.push(db);
    if (db.version !== version || stores.some(store => !db.objectStoreNames.contains(store))) throw new Error("existing-db-shape-invalid");
    return db;
  }
  async function read(db, store, key, index = null) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const target = index ? tx.objectStore(store).index(index) : tx.objectStore(store);
      const req = index ? target.getAll(IDBKeyRange.only(key)) : target.get(key);
      let value;
      req.onsuccess = () => { value = req.result; };
      tx.oncomplete = () => resolve(value);
      tx.onabort = tx.onerror = () => reject(new Error("read-only-transaction-failed"));
    });
  }
  try {
    const repo = window.LingoFlowSyncStateRepository;
    const lib = window.LingoFlowArticleLibrary;
    const flow = window.LingoFlowProgressLocalDesired;
    const causal = window.LingoFlowProgressCausalState;
    const auth = window.LingoFlowSupabaseAuth;
    if (!repo || !lib || !flow || !causal || !auth || !indexedDB.databases) return unavailable();
    // Hold connections throughout inspection: deletion/recreation cannot race
    // the production readonly APIs into creating a fresh database.
    const sync = await openExisting("LingoFlowSyncDB", 7, ["control", "progressDesired",
      "progressRemoteObservations", "progressCloudAttempts", "articleSidecars", "articleOutbox"]);
    if (!sync) return unavailable("local-databases-missing-or-version-mismatch");
    const library = await openExisting("LingoFlowLibraryDB", 3, ["articles", "progressFences", "progressControl"]);
    if (!library) return unavailable("local-databases-missing-or-version-mismatch");
    const binding = await read(sync, "control", "workspace-binding");
    if (!binding) return unavailable("local-binding-unresolved");
    if (binding.ownerId !== scope.ownerId || auth.getState()?.status !== "authenticated" ||
        auth.getState()?.user?.id !== scope.ownerId) return unavailable("local-owner-mismatch");
    const owner = { ownerId: scope.ownerId, bindingId: binding.bindingId };
    const captureScope = async () => ({
      generation: await flow.captureCloudResponseContext(owner.ownerId, owner.bindingId),
      transition: await lib.getWorkspaceTransition(),
      workspace: await read(library, "progressControl", "workspace") });
    const scopeBefore = await captureScope();
    const scopeAfter = await captureScope();
    if (scopeBefore.transition || scopeAfter.transition) return unavailable("local-workspace-transition");
    if (!scopeBefore.generation || JSON.stringify(scopeBefore) !== JSON.stringify(scopeAfter)) {
      return unavailable("local-generation-or-state-unstable");
    }
    if (scopeBefore.workspace?.ownerId !== owner.ownerId ||
        scopeBefore.workspace?.bindingId !== owner.bindingId || !scopeBefore.workspace.scopeToken) {
      return unavailable("local-workspace-or-fence-unresolved");
    }
    const scopeFacts = { status: "ready", ...owner,
      generation: scopeBefore.generation.generation, scopeToken: scopeBefore.workspace.scopeToken,
      stable: true, transitionInactive: true };
    if (scope.scopeOnly === true) return scopeFacts; // No Article/causal inspection yet.
    const args = [owner.ownerId, owner.bindingId, scope.articleId];
    const capture = async () => ({ generation: await flow.captureCloudResponseContext(owner.ownerId, owner.bindingId),
      transition: await lib.getWorkspaceTransition(),
      local: await lib.getProgressContext(scope.articleId, owner, { initialize: false }),
      sync: await repo.getProgressCausalSnapshot(...args),
      attempts: await read(sync, "progressCloudAttempts", args, "byScope") });
    const before = await capture();
    if (before.transition || before.local.status === "workspace-transition") return unavailable("local-workspace-transition");
    if (before.local.status !== "ready") return unavailable("local-workspace-or-fence-unresolved");
    if (before.sync.status !== "ready") return unavailable("local-causal-snapshot-unavailable");
    if (!before.generation) return unavailable("local-generation-or-state-unstable");
    const article = before.local.article;
    const contentFingerprint = await window.LingoFlowReadingResume.fingerprintContent(article.content);
    const after = await capture();
    const stable = JSON.stringify(before) === JSON.stringify(after);
    const observation = before.sync.observation;
    const reader = (() => {
      // Only read existing main.js geometry/session. No showArticle() or scroll.
      if (typeof getArticleReadingMetrics !== "function" || typeof readingProgressSession === "undefined" ||
          typeof activeArticleId === "undefined" || activeArticleId !== scope.articleId ||
          readingProgressSession?.articleId !== scope.articleId) return null;
      const metrics = getArticleReadingMetrics();
      if (!metrics || !readingProgressSession.resumeBaseline) return null;
      const paragraphs = [];
      const seen = new Set();
      for (const word of metrics.article.querySelectorAll(".word[data-paragraph-index]")) {
        const index = Number(word.dataset.paragraphIndex);
        if (seen.has(index)) continue;
        if (paragraphs.length >= 4096) return null;
        seen.add(index);
        paragraphs.push({ index, top: window.scrollY + word.getBoundingClientRect().top });
      }
      return { articleId: activeArticleId, baselineArticleId: readingProgressSession.resumeBaseline.articleId,
        baselineFingerprint: readingProgressSession.contentFingerprint,
        baseline: { progress: readingProgressSession.resumeBaseline.progress,
          paragraphIndex: readingProgressSession.resumeBaseline.paragraphIndex },
        pendingSave: Boolean(readingProgressSession.resumeDirty || readingProgressSession.dirty ||
          (typeof readingProgressSaveTimer !== "undefined" && readingProgressSaveTimer) ||
          (typeof suppressReadingProgressSave !== "undefined" && suppressReadingProgressSave)),
        startY: metrics.startY, scrollRange: metrics.scrollRange, anchorOffset: metrics.anchorOffset,
        currentScrollY: window.scrollY,
        maxScrollY: Math.max(0, document.scrollingElement.scrollHeight - window.innerHeight), paragraphs };
    })();
    const parent = causal.trustedParent(before.sync.sidecar);
    const record = before.sync.record;
    return { status: "ready", ownerId: owner.ownerId, bindingId: owner.bindingId,
      generation: before.generation.generation, scopeToken: before.local.scope?.scopeToken,
      stable, transitionInactive: !before.transition && !after.transition,
      scopeValid: before.local.scope?.ownerId === owner.ownerId && before.local.scope?.bindingId === owner.bindingId &&
        Boolean(before.local.scope.scopeToken), fencePresent: before.local.fence?.articleId === scope.articleId &&
          typeof before.local.fence.lifecycleToken === "string" && before.local.fence.lifecycleToken.length > 0 &&
          Number.isSafeInteger(before.local.fence.resumeRevision) && before.local.fence.resumeRevision >= 0,
      articleId: article.id, articleActive: !article.deletedAt, contentFingerprint,
      contentBytes: new TextEncoder().encode(article.content).length, parent,
      bootstrapSafe: before.sync.bootstrapSafe, hasConflict: before.sync.hasConflict, hasMutation: before.sync.hasMutation,
      pendingMovement: Boolean(record?.pending), quarantinedMovement: Boolean(record?.quarantined),
      // A fresh first UPDATE must not compete with an existing uncertain call.
      unsettledAttempts: before.attempts.some(attempt => !["succeeded", "terminal", "superseded", "blocked_before_dispatch"].includes(attempt.status)),
      observation, observationDiagnostic: Boolean(before.sync.observationDiagnostic), reader };
  } finally { for (const db of handles) db.close(); }
}

// Shape only, never a readiness/send authority. False flags, unknown/absent
// observations and nullable parent/reader remain valid facts for the existing
// upper gate to reject. Error messages contain schema names, never data values.
function validateRuntimeInspectionResult(value, scopeOnly) {
  const invalid = field => { throw new Error(`invalid runtime inspection result: ${field}`); };
  const object = item => item !== null && typeof item === "object" && !Array.isArray(item);
  const text = item => typeof item === "string" && item.length > 0;
  const bool = item => typeof item === "boolean";
  const integer = item => Number.isSafeInteger(item) && item >= 0;
  const fingerprint = item => typeof item === "string" && /^sha256:[a-f0-9]{64}$/.test(item);
  const revision = item => typeof item === "string" && /^revision:[1-9][0-9]*$/.test(item);
  const cursor = item => typeof item === "string" && /^cursor:(0|[1-9][0-9]*)$/.test(item);
  const epoch = item => typeof item === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(item);
  function field(record, key, predicate, label = key) {
    if (!object(record)) invalid(label);
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !predicate(descriptor.value)) invalid(label);
    return descriptor.value;
  }
  function shape(record, keys, label) {
    if (!object(record) || Object.keys(record).some(key => !keys.includes(key))) invalid(label);
  }
  function checkpoint(record, label) {
    shape(record, ["progress", "paragraphIndex"], label);
    field(record, "progress", item => Number.isFinite(item) && item >= 0 && item <= 1, `${label}.progress`);
    field(record, "paragraphIndex", integer, `${label}.paragraphIndex`);
  }
  const status = field(value, "status", item => ["ready", "unavailable"].includes(item));
  if (status === "unavailable") {
    shape(value, ["status", "reason"], "result fields");
    if (Object.hasOwn(value, "reason")) field(value, "reason", text);
    return;
  }
  const scopeFields = ["status", "ownerId", "bindingId", "generation", "scopeToken", "stable", "transitionInactive"];
  const flags = ["scopeValid", "fencePresent", "articleActive", "bootstrapSafe", "hasConflict", "hasMutation",
    "pendingMovement", "quarantinedMovement", "unsettledAttempts", "observationDiagnostic"];
  shape(value, scopeOnly ? scopeFields : [...scopeFields, ...flags, "articleId", "contentFingerprint",
    "contentBytes", "parent", "observation", "reader"], "result fields");
  for (const key of ["ownerId", "bindingId", "scopeToken"]) field(value, key, text);
  field(value, "generation", integer);
  for (const key of ["stable", "transitionInactive"]) field(value, key, bool);
  if (scopeOnly) return;
  for (const key of flags) field(value, key, bool);
  field(value, "articleId", text);
  field(value, "contentFingerprint", fingerprint);
  field(value, "contentBytes", integer);
  const parent = field(value, "parent", item => item === null || object(item));
  if (parent !== null) {
    shape(parent, ["articleRevision", "readingEpoch", "contentFingerprint", "lifecycle"], "parent fields");
    field(parent, "articleRevision", revision, "parent.articleRevision");
    field(parent, "readingEpoch", epoch, "parent.readingEpoch");
    field(parent, "contentFingerprint", fingerprint, "parent.contentFingerprint");
    field(parent, "lifecycle", item => ["active", "deleted"].includes(item), "parent.lifecycle");
  }
  const observation = field(value, "observation", item => item === null || object(item));
  if (observation !== null) {
    const kind = field(observation, "kind", item => ["unknown", "absent", "revision"].includes(item), "observation.kind");
    shape(observation, kind === "unknown" ? ["kind"] : kind === "absent" ? ["kind", "evidence"] :
      ["kind", "revision", "cursor", "parentReadingEpoch", "contentFingerprint", "checkpoint"], "observation fields");
    if (kind === "revision") {
      field(observation, "revision", revision, "observation.revision");
      field(observation, "cursor", cursor, "observation.cursor");
      field(observation, "parentReadingEpoch", epoch, "observation.parentReadingEpoch");
      field(observation, "contentFingerprint", fingerprint, "observation.contentFingerprint");
      checkpoint(field(observation, "checkpoint", object), "observation.checkpoint");
    } else if (kind === "absent") {
      const evidence = field(observation, "evidence", object);
      shape(evidence, ["kind", "highWaterCursor", "throughCursor"], "observation.evidence fields");
      field(evidence, "kind", item => item === "completed-inventory-catchup", "observation.evidence.kind");
      for (const key of ["highWaterCursor", "throughCursor"]) field(evidence, key, cursor, `observation.evidence.${key}`);
    }
  }
  const reader = field(value, "reader", item => item === null || object(item));
  if (reader !== null) {
    shape(reader, ["articleId", "baselineArticleId", "baselineFingerprint", "baseline", "pendingSave",
      "startY", "scrollRange", "anchorOffset", "currentScrollY", "maxScrollY", "paragraphs"], "reader fields");
    for (const key of ["articleId", "baselineArticleId"]) field(reader, key, text, `reader.${key}`);
    field(reader, "baselineFingerprint", fingerprint, "reader.baselineFingerprint");
    field(reader, "pendingSave", bool, "reader.pendingSave");
    checkpoint(field(reader, "baseline", object), "reader.baseline");
    for (const key of ["startY", "scrollRange", "anchorOffset", "currentScrollY", "maxScrollY"]) {
      field(reader, key, Number.isFinite, `reader.${key}`);
    }
    const paragraphs = field(reader, "paragraphs", item => Array.isArray(item) && item.length <= 4096, "reader.paragraphs");
    for (const paragraph of paragraphs) {
      shape(paragraph, ["index", "top"], "reader.paragraph fields");
      field(paragraph, "index", integer, "reader.paragraph.index");
      field(paragraph, "top", Number.isFinite, "reader.paragraph.top");
    }
  }
}

function loopbackURL(value, runtime = false) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || (!runtime && url.pathname !== "/")) {
    throw new Error("local-runtime-url-invalid");
  }
  return url;
}

async function openRuntimeSession(scope, { cdpURL, runtimeURL }) {
  const cdp = loopbackURL(cdpURL);
  const runtime = loopbackURL(runtimeURL, true);
  const { chromium } = require("playwright");
  // Installed Playwright supports noDefaults: do not emulate focus/media or
  // alter download settings in the existing runtime while attaching.
  const browser = await chromium.connectOverCDP(cdp.href, { timeout: 15000, noDefaults: true });
  try {
    const pages = browser.contexts().flatMap(context => context.pages()).filter(page => {
      try { const url = new URL(page.url()); return url.origin === runtime.origin && url.pathname === runtime.pathname; }
      catch { return false; }
    });
    if (pages.length !== 1) throw new Error("existing-runtime-page-not-unique");
    const page = pages[0];
    const runtimeIdentity = require("node:crypto").randomUUID();
    let identityChanged = false;
    const invalidate = () => { identityChanged = true; };
    const navigated = frame => { if (frame === page.mainFrame()) invalidate(); };
    page.on("close", invalidate); page.on("crash", invalidate); page.on("framenavigated", navigated);
    // Only lifecycle invalidation listeners above: no tracing, HAR, screenshot,
    // video, request/console recording, or credential-bearing evaluate args.
    const evaluate = async scopeOnly => {
      if (identityChanged) return { status: "unavailable" };
      let timer;
      try {
        const result = await Promise.race([page.evaluate(inspectExistingRuntime, { ...scope, scopeOnly }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("read-only-runtime-timeout")), 30000); })]);
        if (identityChanged) return { status: "unavailable" };
        validateRuntimeInspectionResult(result, scopeOnly);
        return { ...result, runtimeIdentity };
      } catch (error) {
        // Observed Playwright/Chromium evaluate errors when another CDP
        // connection navigates/closes before this connection gets its event.
        // Exact messages only: page JS/IDB/serialization errors still throw.
        if (error?.name !== "Error" || ![
          "page.evaluate: Execution context was destroyed, most likely because of a navigation.",
          "page.evaluate: Target page, context or browser has been closed"
        ].includes(error.message)) throw error;
        invalidate(); // Permanent: do not retry/rebind even at the same URL.
        return { status: "unavailable", reason: "runtime-document-unavailable" };
      } finally { clearTimeout(timer); }
    };
    return { captureScope: () => evaluate(true), inspectRuntime: () => evaluate(false),
      close: async () => {
        page.off("close", invalidate); page.off("crash", invalidate); page.off("framenavigated", navigated);
        await browser.close(); // Disconnect only; existing browser/page stay open.
      } };
  } catch (error) { await browser.close(); throw error; }
}

async function inspectRuntime(scope, options) {
  const session = await openRuntimeSession(scope, options);
  try { return await session.inspectRuntime(); }
  finally { await session.close(); }
}

module.exports = { inspectExistingRuntime, loopbackURL, inspectRuntime, openRuntimeSession };
