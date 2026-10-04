"use strict";

// Test-only foundation. No import-time IO, default network, cleanup, or
// production dispatcher. Every external operation is explicitly injected.
const { createHash, randomUUID } = require("node:crypto");
const preflight = require("./progress-live-preflight-helpers");
const OWNER = "db4f9c1c-4563-47a9-8649-150a4fb87a6a";
const ID = /^b3-2b-live-fixture-a-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$(?![\s\S])/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$(?![\s\S])/;
const TITLE = "Progress LIVE Fixture A";
const TEMPLATE = "progress-live-fixture-a-v1";
const CONTENT = Array.from({ length: 20 }, (_, index) =>
  `Section ${index + 1}. ` +
  "A careful reader follows an idea through a sequence of ordinary observations. " +
  "The morning light falls across the desk, and a quiet room leaves space for attention. " +
  "Each paragraph offers a small part of a longer account rather than a final conclusion. " +
  "Reading slowly makes it easier to notice how one sentence prepares the next. " +
  "A useful pause can reveal a connection that a hurried glance would overlook. " +
  "The reader can move forward, return to an earlier passage, and continue at a comfortable pace."
).join("\n\n");
const DIGEST = `sha256:${createHash("sha256").update(CONTENT, "utf8").digest("hex")}`;
const BYTES = Buffer.byteLength(CONTENT, "utf8");
const STAGES = ["planned", "article_created", "progress_seeded", "local_article_ready", "observation_seeded", "ready"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length && fields.every(k => Object.hasOwn(value, k));
const date = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value) && Number.isFinite(Date.parse(value));
const ordinal = (value, prefix) => preflight.validOrdinal(value, prefix);
const count = value => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 9223372036854775807n;
const fail = reason => { throw new Error(reason); };
const REASONS = new Set(["runtime-scope-changed", "fixture-history-collision", "server-facts-invalid",
  "article-result-invalid", "progress-result-invalid", "article-outcome-unknown", "progress-outcome-unknown",
  "local-article-not-ready", "observation-seed-failed", "journal-server-mismatch", "preparation-io-failed", "fixture-journal-busy"]);

// Only runPreparation's fresh verification path may mint a capability. It is
// consumed once in Node, never serialized/persisted or used as a future lease.
const verifiedSeeds = new WeakMap();
function consumeVerifiedFixtureSeed(capability) {
  if (!object(capability)) return null;
  const input = verifiedSeeds.get(capability);
  verifiedSeeds.delete(capability);
  return input || null;
}

function environmentError(env, options) {
  if (env.LF_PROGRESS_LIVE_TEST !== "1") return "live-gate-disabled";
  if (env.LF_PROGRESS_FIXTURE_PREPARE !== "1") return "fixture-gate-disabled";
  if (options.dedicatedTestAccount !== true) return "dedicated-test-account-not-confirmed";
  if (env.LF_PROGRESS_OWNER_A !== OWNER) return "dedicated-owner-mismatch";
  return preflight.validateEnvironment({ ...env, LF_PROGRESS_ARTICLE_A:
    `b3-2b-live-fixture-a-00000000-0000-4000-8000-000000000000` }, options);
}

function definition(articleId, articleMutationId, progressMutationId, createdAt) {
  if (!ID.test(articleId) || !UUID.test(articleMutationId) || !UUID.test(progressMutationId) ||
      articleMutationId === progressMutationId || !date(createdAt)) fail("invalid-fixture-definition");
  return Object.freeze({ articleId, articleMutationId, progressMutationId, createdAt,
    templateVersion: TEMPLATE, contentDigest: DIGEST, progress: 0.2, paragraphIndex: 4 });
}

function validateDefinition(value) {
  if (!exact(value, ["articleId", "articleMutationId", "progressMutationId", "createdAt",
    "templateVersion", "contentDigest", "progress", "paragraphIndex"]) || value.templateVersion !== TEMPLATE ||
    value.contentDigest !== DIGEST || value.progress !== 0.2 || value.paragraphIndex !== 4 ||
    value.paragraphIndex >= CONTENT.split("\n\n").length) fail("invalid-fixture-definition");
  return definition(value.articleId, value.articleMutationId, value.progressMutationId, value.createdAt);
}

function articleFacts(raw, def) {
  if (!object(raw) || raw.ownerId !== OWNER || raw.articleId !== def.articleId || raw.title !== TITLE ||
      raw.revision !== "revision:1" || !ordinal(raw.cursor, "cursor") || !UUID.test(raw.readingEpoch) ||
      raw.contentFingerprint !== DIGEST || raw.computedFingerprint !== DIGEST || raw.contentBytes !== BYTES ||
      raw.lifecycle !== "active" || raw.deletedAt !== null || raw.createdAt !== def.createdAt ||
      raw.updatedAt !== def.createdAt || !date(raw.serverCreatedAt) || !date(raw.serverUpdatedAt)) fail("server-facts-invalid");
  return { ownerId: OWNER, articleId: def.articleId, title: TITLE, revision: raw.revision, cursor: raw.cursor,
    readingEpoch: raw.readingEpoch, contentFingerprint: DIGEST, computedFingerprint: DIGEST,
    contentBytes: BYTES, lifecycle: "active", deletedAt: null, createdAt: def.createdAt, updatedAt: def.createdAt,
    serverCreatedAt: raw.serverCreatedAt, serverUpdatedAt: raw.serverUpdatedAt };
}

function progressFacts(raw, def, parent) {
  if (!object(raw) || raw.ownerId !== OWNER || raw.articleId !== def.articleId || raw.revision !== "revision:1" ||
      !ordinal(raw.cursor, "cursor") || raw.parentReadingEpoch !== parent.readingEpoch ||
      raw.contentFingerprint !== parent.contentFingerprint || raw.progress !== def.progress ||
      raw.paragraphIndex !== def.paragraphIndex || !date(raw.serverUpdatedAt)) fail("server-facts-invalid");
  return { ownerId: OWNER, articleId: def.articleId, revision: raw.revision, cursor: raw.cursor,
    parentReadingEpoch: raw.parentReadingEpoch, contentFingerprint: DIGEST,
    progress: def.progress, paragraphIndex: def.paragraphIndex, serverUpdatedAt: raw.serverUpdatedAt };
}

function history(raw) {
  const fields = ["articleChanges", "articleReceipts", "progressChanges", "progressReceipts",
    "articleSetupReceipt", "progressSetupReceipt"];
  if (!exact(raw, fields) || fields.some(k => !count(raw[k]))) fail("server-facts-invalid");
  return Object.fromEntries(fields.map(k => [k, raw[k]]));
}

function verifyState(raw, def, articleExpected, progressExpected) {
  if (!object(raw)) fail("server-facts-invalid");
  const h = history(raw.history);
  const a = articleExpected ? articleFacts(raw.article, def) : null;
  const p = progressExpected ? progressFacts(raw.progress, def, a) : null;
  if ((!articleExpected && raw.article !== null) || (!progressExpected && raw.progress !== null) ||
      h.articleChanges !== (articleExpected ? "1" : "0") || h.articleReceipts !== (articleExpected ? "1" : "0") ||
      h.articleSetupReceipt !== (articleExpected ? "1" : "0") ||
      h.progressChanges !== (progressExpected ? "1" : "0") || h.progressReceipts !== (progressExpected ? "1" : "0") ||
      h.progressSetupReceipt !== (progressExpected ? "1" : "0")) fail("fixture-history-collision");
  // The exact setup receipt must agree with current, not just its row count.
  if (a) verifyResult(raw.articleResult, "article", def, a);
  if (p) verifyResult(raw.progressResult, "progress", def, p);
  return { article: a, progress: p };
}

function verifyResult(raw, kind, def, current = null) {
  if (!object(raw) || raw.status !== "applied" || raw.articleId !== def.articleId ||
      raw.mutationId !== def[`${kind}MutationId`] || raw.revision !== "revision:1" ||
      !ordinal(raw.cursor, "cursor") || raw.contentFingerprint !== DIGEST) fail(`${kind}-result-invalid`);
  if (kind === "article" ? raw.operation !== "put" || !UUID.test(raw.readingEpoch)
    : !UUID.test(raw.parentReadingEpoch) || raw.progress !== def.progress || raw.paragraphIndex !== def.paragraphIndex ||
      !date(raw.serverUpdatedAt)) fail(`${kind}-result-invalid`);
  if (current && (raw.cursor !== current.cursor || (kind === "article"
    ? raw.readingEpoch !== current.readingEpoch
    : raw.parentReadingEpoch !== current.parentReadingEpoch || raw.serverUpdatedAt !== current.serverUpdatedAt))) fail(`${kind}-result-invalid`);
}

function newJournal(def) {
  return { version: 1, ownerId: OWNER, definition: def, stage: "planned", completedStage: "planned",
    articleAttempted: false, progressAttempted: false, article: null, progress: null, reason: null };
}

function validateJournal(raw) {
  if (!exact(raw, ["version", "ownerId", "definition", "stage", "completedStage", "articleAttempted",
    "progressAttempted", "article", "progress", "reason"]) || raw.version !== 1 || raw.ownerId !== OWNER ||
    ![...STAGES, "attention", "partial"].includes(raw.stage) || !STAGES.includes(raw.completedStage) ||
    typeof raw.articleAttempted !== "boolean" || typeof raw.progressAttempted !== "boolean" ||
    (raw.reason !== null && !REASONS.has(raw.reason))) fail("invalid-preparation-journal");
  const def = validateDefinition(raw.definition);
  const rank = STAGES.indexOf(raw.completedStage);
  const a = raw.article === null ? null : articleFacts(raw.article, def);
  const p = raw.progress === null ? null : progressFacts(raw.progress, def, a || {});
  if ((rank >= 1) !== Boolean(a) || (rank >= 2) !== Boolean(p) ||
      (a && !raw.articleAttempted) || (raw.progressAttempted && !a) ||
      (p && !raw.progressAttempted) || (STAGES.includes(raw.stage) && raw.stage !== raw.completedStage)) fail("invalid-preparation-journal");
  return { ...raw, definition: def, article: a, progress: p };
}

function localArticleError(local, server, baseline) {
  if (!object(local) || local.status !== "ready" || local.stable !== true ||
      ["ownerId", "bindingId", "generation", "scopeToken", "runtimeIdentity"].some(k => local[k] !== baseline[k]) ||
      local.scopeValid !== true || local.transitionInactive !== true || local.fencePresent !== true ||
      local.articleId !== server.article.articleId || local.articleActive !== true || local.contentFingerprint !== DIGEST ||
      local.contentBytes !== BYTES || local.bootstrapSafe !== true || local.hasConflict !== false || local.hasMutation !== false ||
      local.pendingMovement !== false || local.quarantinedMovement !== false || local.unsettledAttempts !== false ||
      local.observationDiagnostic) return "local-article-not-ready";
  if (!same(local.parent, { articleRevision: server.article.revision, readingEpoch: server.article.readingEpoch,
    contentFingerprint: DIGEST, lifecycle: "active" })) return "local-article-not-ready";
  const expected = observation(server.progress);
  if (!same(local.observation, { kind: "unknown" }) && !same(local.observation, expected)) return "local-article-not-ready";
  return null;
}

const observation = p => ({ kind: "revision", revision: p.revision, cursor: p.cursor,
  parentReadingEpoch: p.parentReadingEpoch, contentFingerprint: p.contentFingerprint,
  checkpoint: { progress: p.progress, paragraphIndex: p.paragraphIndex } });

async function runPreparation(env, options = {}, io = null) {
  const report = (reason, journal = null) => ({ status: "NO-GO", reason, safety: preflight.SAFETY,
    ...(journal ? { articleId: journal.definition.articleId, stage: journal.stage, completedStage: journal.completedStage } : {}),
    productionClientUpdate: 0, productionClientCreate: 0 });
  const error = environmentError(env, options);
  if (error) return report(error);
  if ((Object.hasOwn(options, "articleId") || options.articleId !== undefined) &&
      (typeof options.articleId !== "string" || !ID.test(options.articleId))) {
    return report("invalid-fixture-definition");
  }
  if (!io || ["verifyOwner", "inspectServer", "articleSetup", "progressSeed", "openRuntime", "readJournal", "writeJournal",
    "acquireJournalLock", "releaseJournalLock"]
    .some(k => typeof io[k] !== "function")) return report("fixture-transport-not-injected");
  let journal, runtime, locked = false;
  try {
    await io.acquireJournalLock(); locked = true;
    journal = await io.readJournal();
    if (journal) journal = validateJournal(journal);
    else {
      const def = definition(options.articleId || `b3-2b-live-fixture-a-${randomUUID()}`,
        randomUUID(), randomUUID(), new Date().toISOString());
      journal = newJournal(def);
      await io.writeJournal(journal);
    }
    if (options.articleId && options.articleId !== journal.definition.articleId) fail("invalid-fixture-definition");
    const def = journal.definition;
    const scope = { ownerId: OWNER, articleId: def.articleId };
    runtime = await io.openRuntime(scope);
    const baseline = Object.freeze({ ...await runtime.captureScope() });
    if (!scopeReady(baseline)) fail("runtime-scope-changed");
    const check = async () => {
      const current = await runtime.captureScope();
      if (!scopeReady(current) || ["ownerId", "bindingId", "generation", "scopeToken", "runtimeIdentity"]
        .some(k => current[k] !== baseline[k])) fail("runtime-scope-changed");
    };
    const save = async (patch = {}) => { journal = { ...journal, ...patch }; await io.writeJournal(journal); };
    const advance = stage => save({ stage, completedStage: stage, reason: null });
    if (await io.verifyOwner(env) !== OWNER) return report("authenticated-owner-mismatch", journal);
    await check();
    const read = async () => { const state = await io.inspectServer(scope, def); await check(); return state; };
    let server = await read(); // ALWAYS verify before continuing a journal.
    if (journal.article) {
      const verified = verifyState(server, def, true, Boolean(journal.progress));
      if (!same(verified.article, journal.article) || !same(verified.progress, journal.progress)) fail("journal-server-mismatch");
    } else if (journal.articleAttempted) fail("article-outcome-unknown");
    else {
      verifyState(server, def, false, false);
      await save({ articleAttempted: true }); // Durable BEFORE the request.
      await check();
      const result = await io.articleSetup(def);
      verifyResult(result, "article", def);
      await check();
      server = await read();
      const verified = verifyState(server, def, true, false);
      verifyResult(result, "article", def, verified.article);
      await save({ article: verified.article, stage: "article_created", completedStage: "article_created", reason: null });
    }
    if (!journal.progress) {
      if (journal.progressAttempted) fail("progress-outcome-unknown");
      server = await read();
      const verified = verifyState(server, def, true, false);
      if (!same(verified.article, journal.article)) fail("journal-server-mismatch");
      await save({ progressAttempted: true });
      await check();
      const result = await io.progressSeed(def, journal.article);
      verifyResult(result, "progress", def);
      await check();
      server = await read();
      const seeded = verifyState(server, def, true, true);
      if (!same(seeded.article, journal.article)) fail("journal-server-mismatch");
      verifyResult(result, "progress", def, seeded.progress);
      await save({ progress: seeded.progress, stage: "progress_seeded", completedStage: "progress_seeded", reason: null });
    }
    const inspectLocal = async () => {
      const local = await runtime.inspectRuntime(); await check();
      const reason = localArticleError(local, { article: journal.article, progress: journal.progress }, baseline);
      if (reason) fail(reason);
      return local;
    };
    let local = await inspectLocal(); // No hydrate/create/repair capability.
    if (journal.completedStage === "ready") {
      if (!same(local.observation, observation(journal.progress))) fail("local-article-not-ready");
      return { status: "ready", mode: "verify-only", articleId: def.articleId,
        productionClientUpdate: 0, productionClientCreate: 0, safety: preflight.SAFETY };
    }
    await advance("local_article_ready");
    server = await read(); // FRESH current, not the earlier seed response.
    const fresh = verifyState(server, def, true, true);
    if (!same(fresh.article, journal.article) || !same(fresh.progress, journal.progress)) fail("journal-server-mismatch");
    await inspectLocal();
    if (typeof runtime.seedObservation !== "function") fail("observation-seed-failed");
    const capability = Object.freeze({});
    verifiedSeeds.set(capability, structuredClone({ gates: { live: true, fixture: true, dedicated: true },
      baseline, server: fresh, definition: def }));
    let seeded;
    try { seeded = await runtime.seedObservation(capability); }
    finally { verifiedSeeds.delete(capability); }
    await check();
    if (!["recorded", "unchanged"].includes(seeded?.status)) fail("observation-seed-failed");
    await advance("observation_seeded");
    local = await inspectLocal();
    if (!same(local.observation, observation(fresh.progress))) fail("observation-seed-failed");
    await advance("ready");
    return { status: "ready", articleId: def.articleId, stage: "ready", safety: preflight.SAFETY,
      productionClientUpdate: 0, productionClientCreate: 0, requiresSeparateUpdateAuthorization: true };
  } catch (error) {
    const reason = REASONS.has(error?.message) ? error.message : "preparation-io-failed";
    if (journal) {
      journal = { ...journal, stage: journal.article ? "partial" : "attention", reason };
      try { await io.writeJournal(validateJournal(journal)); } catch { /* Keep the last durable journal. */ }
    }
    return report(reason, journal);
  } finally {
    try { await runtime?.close(); } catch { /* No cleanup of fixture or browser. */ }
    if (locked) { try { await io.releaseJournalLock(); } catch { /* A stale lock fails closed on restart. */ } }
  }
}

function scopeReady(scope) {
  return object(scope) && scope.status === "ready" && scope.ownerId === OWNER && scope.stable === true &&
    scope.transitionInactive === true && Number.isSafeInteger(scope.generation) && scope.generation >= 0 &&
    [scope.bindingId, scope.scopeToken, scope.runtimeIdentity].every(s => typeof s === "string" && /^[a-zA-Z0-9:_-]{1,160}$/.test(s));
}

// Explicit future adapter injection. Reuses ONLY two single test-side seams;
// never imports/calls the older suite, cleanup, pull/inventory, or client path.
function serverContractAdapter(helpers, who, env, options) {
  if (environmentError(env || {}, options || {})) fail("fixture-adapter-gate-disabled");
  if (who?.owner !== OWNER || typeof who.jwt !== "string" || !who.jwt ||
      who.jwt !== env.LF_PROGRESS_JWT_A ||
      typeof helpers?.articlePush !== "function" || typeof helpers?.progressPush !== "function") fail("invalid-fixture-adapter");
  let articles = 0, progress = 0;
  return {
    articleSetup: async def => {
      validateDefinition(def);
      if (++articles > 1) fail("article-outcome-unknown");
      return helpers.articlePush(who, def.articleId, "put", { id: def.articleId, title: TITLE,
        content: CONTENT, sourceType: "paste", createdAt: def.createdAt, updatedAt: def.createdAt, deletedAt: null },
      null, def.articleMutationId);
    },
    progressSeed: async (def, parent) => {
      validateDefinition(def); articleFacts(parent, def);
      if (++progress > 1) fail("progress-outcome-unknown");
      return helpers.progressPush(who, def.articleId, { expectedState: "absent", expectedProgressRevision: null,
        parentReadingEpoch: parent.readingEpoch, contentFingerprint: parent.contentFingerprint,
        progress: def.progress, paragraphIndex: def.paragraphIndex }, def.progressMutationId);
    }
  };
}

function inspectionSQL(def) {
  validateDefinition(def);
  const where = `owner_id='${OWNER}'::uuid and article_id='${def.articleId}'`;
  return `select jsonb_build_object(
    'article', (select jsonb_build_object('ownerId',owner_id::text,'articleId',article_id,'title',title,
      'revision','revision:'||revision::text,'cursor','cursor:'||cursor::text,
      'readingEpoch',reading_epoch::text,'contentFingerprint',content_fingerprint,
      'computedFingerprint','sha256:'||encode(sha256(convert_to(content,'UTF8')),'hex'),
      'contentBytes',octet_length(content),'lifecycle',case when deleted_at_client is null then 'active' else 'deleted' end,
      'deletedAt',deleted_at_client,'createdAt',created_at_client,'updatedAt',updated_at_client,
      'serverCreatedAt',created_at_server,'serverUpdatedAt',updated_at_server)
      from public.article_sync_records where ${where}),
    'progress', (select jsonb_build_object('ownerId',owner_id::text,'articleId',article_id,
      'revision','revision:'||server_revision::text,'cursor','cursor:'||cursor::text,
      'parentReadingEpoch',parent_reading_epoch::text,'contentFingerprint',content_fingerprint,
      'progress',progress,'paragraphIndex',paragraph_index,'serverUpdatedAt',server_updated_at)
      from public.progress_sync_records where ${where}),
    'history', jsonb_build_object(
      'articleChanges',(select count(*)::text from public.article_sync_changes where ${where}),
      'articleReceipts',(select count(*)::text from public.article_sync_mutations where ${where}),
      'progressChanges',(select count(*)::text from public.progress_sync_changes where ${where}),
      'progressReceipts',(select count(*)::text from public.progress_sync_mutations where ${where}),
      'articleSetupReceipt',(select count(*)::text from public.article_sync_mutations where owner_id='${OWNER}'::uuid and mutation_id='${def.articleMutationId}'),
      'progressSetupReceipt',(select count(*)::text from public.progress_sync_mutations where owner_id='${OWNER}'::uuid and mutation_id='${def.progressMutationId}')),
    'articleResult',(select mutation_result from public.article_sync_mutations where owner_id='${OWNER}'::uuid and mutation_id='${def.articleMutationId}'),
    'progressResult',(select mutation_result from public.progress_sync_mutations where owner_id='${OWNER}'::uuid and mutation_id='${def.progressMutationId}')
  ) as state`;
}

async function inspectFixtureServer(scope, def, options = {}) {
  if (scope?.ownerId !== OWNER || scope.articleId !== def.articleId) fail("invalid-fixture-scope");
  const fs = require("node:fs/promises");
  const path = require("node:path");
  const cwd = path.resolve(__dirname, "..");
  const read = options.readFileImpl || fs.readFile;
  if ((await read(path.join(cwd, "supabase/.temp/project-ref"), "utf8")).trim() !== preflight.PROJECT_REF) fail("linked-project-mismatch");
  const exec = options.execFileImpl || require("node:util").promisify(require("node:child_process").execFile);
  const childEnv = { ...process.env };
  delete childEnv.LF_PROGRESS_JWT_A; delete childEnv.LF_PROGRESS_JWT_B;
  const { stdout } = await exec("supabase", ["db", "query", "--linked", "--output", "json", inspectionSQL(def)],
    { cwd, env: childEnv, timeout: 90000, maxBuffer: 1024 * 1024 });
  return require("./progress-cloud-live-helpers").parseLinkedStateOutput(stdout);
}

module.exports = { OWNER, ID, TITLE, TEMPLATE, CONTENT, DIGEST, BYTES, STAGES, environmentError, definition,
  validateDefinition, newJournal, validateJournal, articleFacts, progressFacts, verifyState, observation,
  localArticleError, runPreparation, serverContractAdapter, scopeReady, inspectionSQL, inspectFixtureServer, consumeVerifiedFixtureSeed };
