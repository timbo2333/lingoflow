"use strict";

// Test boundary only. This module has no import-time IO, dotenv, RPC, or setup /
// cleanup capability. A GO is a point-in-time advisory, never a send lease.
const PROJECT_REF = "yebabpjplbgidzwpjhoy";
const PROJECT_URL = `https://${PROJECT_REF}.supabase.co`;
const SAFETY = Object.freeze({ trace: "off", video: "off", screenshot: "off",
  HAR: "off", requestRecording: false, credentialLogging: false });
const REQUIRED = Object.freeze(["LF_PROGRESS_LIVE_TEST", "LF_SUPABASE_URL",
  "LF_SUPABASE_PUBLISHABLE_KEY", "LF_PROGRESS_OWNER_A", "LF_PROGRESS_JWT_A"]);
const OPTIONAL = Object.freeze(["LF_PROGRESS_OWNER_B", "LF_PROGRESS_JWT_B"]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const FINGERPRINT = /^sha256:[a-f0-9]{64}$/;
const FIXTURE = /^(b3-contract-|b3-1-live-|b3-1-browser-|b3-2b-live-)[a-zA-Z0-9-]{1,120}$/;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const LOCAL_FAILURES = new Set(["local-databases-missing-or-version-mismatch", "local-binding-unresolved",
  "local-owner-mismatch", "local-workspace-transition", "local-workspace-or-fence-unresolved",
  "local-causal-snapshot-unavailable", "local-generation-or-state-unstable"]);

function envReadiness(env) {
  return Object.fromEntries([...REQUIRED, "LF_PROGRESS_ARTICLE_A", ...OPTIONAL]
    .map(name => [name, typeof env[name] === "string" && env[name].length > 0 ? "present" : "missing"]));
}

function no(reason, facts = {}) {
  return { decision: "NO-GO", reason, safety: SAFETY, ...facts };
}

function validOrdinal(value, prefix, positive = true) {
  if (typeof value !== "string" || !new RegExp(`^${prefix}:(0|[1-9][0-9]{0,18})$`).test(value)) return false;
  const n = BigInt(value.slice(prefix.length + 1));
  return n >= (positive ? 1n : 0n) && n <= 9223372036854775807n;
}

const checkpoint = value => object(value) && Number.isFinite(value.progress) &&
  value.progress >= 0 && value.progress <= 1 && Number.isInteger(value.paragraphIndex) &&
  value.paragraphIndex >= 0 && value.paragraphIndex <= 2147483647;

function validateEnvironment(env, options) {
  if (env.LF_PROGRESS_LIVE_TEST !== "1") return "live-gate-disabled";
  if (REQUIRED.some(name => !env[name])) return "required-account-a-env-missing";
  if (env.LF_SUPABASE_URL !== PROJECT_URL ||
      !/^sb_publishable_[a-zA-Z0-9_-]+$/.test(env.LF_SUPABASE_PUBLISHABLE_KEY) ||
      !UUID.test(env.LF_PROGRESS_OWNER_A) ||
      !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(env.LF_PROGRESS_JWT_A)) {
    return "invalid-account-a-env-or-project";
  }
  if (!env.LF_PROGRESS_ARTICLE_A) return "explicit-fixture-missing";
  if (!FIXTURE.test(env.LF_PROGRESS_ARTICLE_A)) return "not-a-dedicated-test-fixture-id";
  if (options.dedicatedTestAccount !== true) return "dedicated-test-account-not-confirmed";
  // HTTP / browser debug output could expose headers independently of our
  // logger. Do not try to redact it after the fact or silently change the env.
  if (["DEBUG", "NODE_DEBUG", "PWDEBUG"].some(name => Boolean(env[name]))) return "debug-recording-env-enabled";
  return null;
}

function serverReadiness(state, scope) {
  if (!object(state)) return "server-inspection-invalid";
  const a = state.article;
  const p = state.progress;
  if (a === null) return "fixture-article-absent";
  if (!object(a) || a.ownerId !== scope.ownerId || a.articleId !== scope.articleId ||
      !validOrdinal(a.revision, "revision") || !validOrdinal(a.cursor, "cursor") ||
      !UUID.test(a.readingEpoch) || !FINGERPRINT.test(a.contentFingerprint) ||
      !Number.isSafeInteger(a.contentBytes) || a.contentBytes < 1 ||
      !["active", "deleted"].includes(a.lifecycle)) return "fixture-article-invalid";
  if (a.lifecycle !== "active") return "fixture-article-deleted";
  if (a.contentBytes > 1048576) return "fixture-article-local-only";
  if (a.computedFingerprint !== a.contentFingerprint) return "server-article-fingerprint-invalid";
  if (p === null) return "fixture-progress-row-absent-no-create";
  if (!object(p) || p.ownerId !== scope.ownerId || p.articleId !== scope.articleId ||
      !validOrdinal(p.revision, "revision") || !validOrdinal(p.cursor, "cursor") ||
      !checkpoint(p) || !UUID.test(p.parentReadingEpoch) ||
      !FINGERPRINT.test(p.contentFingerprint)) return "fixture-progress-invalid";
  if (p.parentReadingEpoch !== a.readingEpoch || p.contentFingerprint !== a.contentFingerprint) {
    return "server-article-progress-epoch-or-fingerprint-mismatch";
  }
  return null;
}

function localReadiness(local, server, scope) {
  if (!object(local) || local.status !== "ready") return LOCAL_FAILURES.has(local?.reason)
    ? local.reason : "local-runtime-read-only-inspection-unavailable";
  if (local.ownerId !== scope.ownerId) return "local-owner-mismatch";
  if (typeof local.bindingId !== "string" || !/^[a-zA-Z0-9:_-]{1,160}$/.test(local.bindingId)) return "local-binding-unresolved";
  if (local.transitionInactive !== true) return "local-workspace-transition";
  if (local.stable !== true || !Number.isSafeInteger(local.generation) || local.generation < 0) return "local-generation-or-state-unstable";
  if (local.scopeValid !== true || local.fencePresent !== true) return "local-workspace-or-fence-unresolved";
  if (local.articleId !== scope.articleId || local.articleActive !== true ||
      local.contentFingerprint !== server.article.contentFingerprint ||
      local.contentBytes !== server.article.contentBytes) return "local-server-article-mismatch";
  const parent = local.parent;
  if (!object(parent) || parent.articleRevision !== server.article.revision ||
      parent.readingEpoch !== server.article.readingEpoch ||
      parent.contentFingerprint !== server.article.contentFingerprint || parent.lifecycle !== "active") {
    return "local-server-parent-context-mismatch";
  }
  if (local.bootstrapSafe !== true || local.hasConflict !== false || local.hasMutation !== false) return "local-article-parent-not-safe";
  if (local.pendingMovement !== false || local.quarantinedMovement !== false ||
      local.unsettledAttempts !== false) return "local-progress-intent-or-attempt-unsettled";
  const obs = local.observation;
  if (!object(obs) || obs.kind !== "revision") return "local-progress-observation-missing";
  if (local.observationDiagnostic) return "local-progress-observation-anomaly";
  if (!checkpoint(obs.checkpoint) || obs.revision !== server.progress.revision ||
      obs.cursor !== server.progress.cursor || obs.parentReadingEpoch !== server.progress.parentReadingEpoch ||
      obs.contentFingerprint !== server.progress.contentFingerprint ||
      obs.checkpoint.progress !== server.progress.progress ||
      obs.checkpoint.paragraphIndex !== server.progress.paragraphIndex) return "local-progress-causal-base-mismatch";
  return null;
}

// Plan a scroll destination from REAL existing Reader geometry, not a mutation
// value. Next round must actually scroll and use the resulting Reader action.
function planForwardTarget(reader, serverProgress, fingerprint) {
  if (!object(reader) || reader.articleId !== reader.baselineArticleId ||
      reader.baselineFingerprint !== fingerprint || reader.pendingSave !== false ||
      !checkpoint(reader.baseline) || !Array.isArray(reader.paragraphs) ||
      ![reader.startY, reader.scrollRange, reader.anchorOffset, reader.maxScrollY,
        reader.currentScrollY].every(Number.isFinite) || reader.scrollRange <= 0) return null;
  const current = Math.max(0, Math.min(1, (reader.currentScrollY - reader.startY) / reader.scrollRange));
  const floor = Math.max(serverProgress, reader.baseline.progress, current) + 0.10;
  if (floor > 0.85) return null; // No P + epsilon near article end.
  for (const paragraph of reader.paragraphs) {
    if (!Number.isInteger(paragraph.index) || paragraph.index < 0 || paragraph.index > 2147483647 ||
        !Number.isFinite(paragraph.top)) return null;
    const scrollY = Math.round(paragraph.top - reader.anchorOffset);
    if (scrollY < 0 || scrollY > reader.maxScrollY) continue;
    const progress = Number(Math.max(0, Math.min(1,
      (scrollY - reader.startY) / reader.scrollRange)).toFixed(6));
    if (progress >= floor && progress <= 0.85) return { scrollY,
      estimatedProgress: progress, paragraphIndex: paragraph.index,
      authority: "proposal-only-use-real-reader-movement-next-round" };
  }
  return null;
}

// Fixed SELECT only. Owner UUID and test-only ID are validated before SQL is
// constructed; no caller-supplied SQL/function/table names. Bigints never go
// through a JS Number. No content, title, JWT, or session is returned.
function inspectionSQL(ownerId, articleId) {
  if (!UUID.test(ownerId) || !FIXTURE.test(articleId)) throw new Error("unsafe-inspection-identity");
  const where = `owner_id='${ownerId}'::uuid and article_id='${articleId}'`;
  return `select jsonb_build_object(
    'article', (select jsonb_build_object(
      'ownerId', owner_id::text, 'articleId', article_id,
      'revision', 'revision:' || revision::text, 'cursor', 'cursor:' || cursor::text,
      'readingEpoch', reading_epoch::text, 'contentFingerprint', content_fingerprint,
      'computedFingerprint', 'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(content, 'UTF8')), 'hex'),
      'lifecycle', case when deleted_at_client is null then 'active' else 'deleted' end,
      'contentBytes', octet_length(content)) from public.article_sync_records where ${where}),
    'progress', (select jsonb_build_object(
      'ownerId', owner_id::text, 'articleId', article_id,
      'revision', 'revision:' || server_revision::text, 'cursor', 'cursor:' || cursor::text,
      'parentReadingEpoch', parent_reading_epoch::text, 'contentFingerprint', content_fingerprint,
      'progress', progress, 'paragraphIndex', paragraph_index)
      from public.progress_sync_records where ${where})
  ) as state`;
}

// Ephemeral readiness only. These values never become a send lease or protocol
// state; the runtime session stays attached to the SAME page for all checks.
function runtimeScopeReady(value, scope) {
  return object(value) && value.status === "ready" && value.stable === true &&
    value.ownerId === scope.ownerId && value.transitionInactive === true &&
    Number.isSafeInteger(value.generation) && value.generation >= 0 &&
    [value.bindingId, value.scopeToken, value.runtimeIdentity].every(item =>
      typeof item === "string" && /^[a-zA-Z0-9:_-]{1,160}$/.test(item));
}

function sameRuntimeScope(value, baseline, scope) {
  return runtimeScopeReady(value, scope) && ["ownerId", "bindingId", "generation",
    "scopeToken", "runtimeIdentity"].every(key => value[key] === baseline[key]);
}

// Gate precedes ALL injected IO. Failures are stage codes, never exception
// messages or raw objects. Private env values never appear in the report.
async function runPreflight(env, options, io) {
  const facts = { env: envReadiness(env), accountB: "optional-for-first-account-a-update" };
  const environmentError = validateEnvironment(env, options);
  if (environmentError) return no(environmentError, facts);
  const scope = { ownerId: env.LF_PROGRESS_OWNER_A, articleId: env.LF_PROGRESS_ARTICLE_A };
  facts.ownerLabel = `${scope.ownerId.slice(0, 4)}…${scope.ownerId.slice(-4)}`;
  facts.articleId = scope.articleId;
  let runtime;
  try { runtime = await io.openRuntime(scope); }
  catch { return no("local-runtime-read-only-inspection-unavailable", facts); }
  try {
    let baseline;
    try { baseline = await runtime.captureScope(); }
    catch { return no("local-runtime-scope-baseline-unavailable", facts); }
    if (!runtimeScopeReady(baseline, scope)) return no("local-runtime-scope-baseline-unavailable", facts);
    baseline = Object.freeze({ ...baseline }); // Do not retain a mutable adapter reference.
    facts.baselineGeneration = baseline.generation;
    const changed = current => no("runtime-scope-changed-during-preflight", {
      ...facts, ...(Number.isSafeInteger(current?.generation) && current.generation >= 0
        ? { currentGeneration: current.generation } : {}) });
    const checkScope = async () => {
      try { return await runtime.captureScope(); }
      catch { return null; } // Loss of an existing scope fails closed.
    };
    let owner;
    try { owner = await io.verifyOwner(env); } catch { return no("read-only-auth-verification-failed", facts); }
    facts.authOwner = owner === scope.ownerId ? "match" : "mismatch";
    if (facts.authOwner !== "match") return no("authenticated-owner-mismatch", facts);
    let server;
    try { server = await io.inspectServer(scope); } catch { return no("read-only-server-inspection-failed", facts); }
    // Check BEFORE comparing/publishing any server facts, not after local
    // inspection has settled into a newer generation.
    const postRemote = await checkScope();
    if (!sameRuntimeScope(postRemote, baseline, scope)) return changed(postRemote);
    const serverError = serverReadiness(server, scope);
    if (serverError) return no(serverError, facts);
    let local;
    try { local = await runtime.inspectRuntime(); }
    catch { return no("local-runtime-read-only-inspection-unavailable", facts); }
    if (local?.status === "ready" && ["ownerId", "bindingId", "generation", "scopeToken", "runtimeIdentity"]
      .some(key => local[key] !== baseline[key])) return changed(local);
    const localError = localReadiness(local, server, scope);
    if (localError) return no(localError, facts);
    if (local.reader?.articleId !== scope.articleId) return no("reader-fixture-not-open-with-baseline", facts);
    const target = planForwardTarget(local.reader, server.progress.progress, server.article.contentFingerprint);
    if (!target) return no("no-obvious-forward-reader-target", facts);
    const finalScope = await checkScope();
    if (!sameRuntimeScope(finalScope, baseline, scope)) return changed(finalScope);
    // Publish success facts only AFTER the final check. No async work to a
    // dispatcher follows; finally only disconnects our read-only CDP client.
    return { decision: "GO", reason: "read-only-preflight-passed-stop-before-update",
      safety: SAFETY, ...facts, articleRevision: server.article.revision,
      progressRevision: server.progress.revision, progressCursor: server.progress.cursor,
      currentProgress: server.progress.progress, paragraphIndex: server.progress.paragraphIndex,
      serverEpochFingerprintMatch: true, bindingLabel: `…${baseline.bindingId.slice(-6)}`,
      generation: baseline.generation, localArticleAligned: true, localCausalBaseMatch: true,
      targetCandidate: target, requiresSeparateUpdateAuthorization: true };
  } finally {
    try { await runtime.close(); }
    catch { return no("local-runtime-disconnect-failed", facts); }
  }
}

async function verifyOwner(env, fetchImpl = globalThis.fetch) {
  const result = await fetchImpl(`${PROJECT_URL}/auth/v1/user`, {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(15000),
    headers: { apikey: env.LF_SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${env.LF_PROGRESS_JWT_A}` }
  });
  if (result.status !== 200) throw new Error("read-only-auth-failed");
  const user = await result.json();
  if (!object(user) || !UUID.test(user.id)) throw new Error("read-only-auth-invalid");
  return user.id;
}

async function inspectServer(scope, { projectDir, execFileImpl, readFileImpl } = {}) {
  const { execFile } = require("node:child_process");
  const { promisify } = require("node:util");
  const fs = require("node:fs/promises");
  const path = require("node:path");
  const cwd = projectDir || path.resolve(__dirname, "..");
  const readFile = readFileImpl || fs.readFile;
  const linked = await readFile(path.join(cwd, "supabase/.temp/project-ref"), "utf8");
  if (linked.trim() !== PROJECT_REF) throw new Error("linked-project-mismatch");
  const exec = execFileImpl || promisify(execFile);
  const childEnv = { ...process.env };
  // The database CLI may need its own existing CLI credentials/network env,
  // but never needs the browser JWTs. Do not forward those to the child.
  delete childEnv.LF_PROGRESS_JWT_A;
  delete childEnv.LF_PROGRESS_JWT_B;
  const { stdout } = await exec("supabase", ["db", "query", "--linked", "--output", "json",
    inspectionSQL(scope.ownerId, scope.articleId)], { cwd, timeout: 90000, maxBuffer: 1024 * 1024, env: childEnv });
  // Reuse ONLY the verified pure parser. None of the older module's mutation,
  // setup, inventory, pull, or cleanup helpers is ever called.
  const { parseLinkedStateOutput } = require("./progress-cloud-live-helpers");
  return parseLinkedStateOutput(stdout);
}

module.exports = { SAFETY, REQUIRED, OPTIONAL, PROJECT_REF, envReadiness, validateEnvironment,
  validOrdinal, serverReadiness, localReadiness, planForwardTarget, inspectionSQL,
  runPreflight, verifyOwner, inspectServer };
