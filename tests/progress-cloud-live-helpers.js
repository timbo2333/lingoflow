"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { randomUUID, createHash } = require("node:crypto");
const { articlePushArgs, progressPushArgs } = require("./progress-fixture-wire");

const execFileAsync = promisify(execFile);
const TEST_PREFIX = "b3-contract-";
const RPC = Object.freeze({
  articlePush: "lingoflow_article_sync_push",
  articleSnapshot: "lingoflow_article_sync_snapshot",
  progressPush: "lingoflow_progress_sync_push",
  progressPull: "lingoflow_progress_sync_pull",
  progressInventory: "lingoflow_progress_sync_inventory"
});

const config = Object.freeze({
  enabled: process.env.LF_PROGRESS_LIVE_TEST === "1",
  projectUrl: process.env.LF_SUPABASE_URL || "",
  publishableKey: process.env.LF_SUPABASE_PUBLISHABLE_KEY || "",
  a: Object.freeze({
    owner: process.env.LF_PROGRESS_OWNER_A || "",
    jwt: process.env.LF_PROGRESS_JWT_A || ""
  }),
  b: Object.freeze({
    owner: process.env.LF_PROGRESS_OWNER_B || "",
    jwt: process.env.LF_PROGRESS_JWT_B || ""
  })
});

const validOwner = who => /^[0-9a-f-]{36}$/i.test(who.owner) && Boolean(who.jwt);
const hasOwnerA = config.enabled && /^https:\/\/[^/]+\/?$/.test(config.projectUrl) &&
  config.publishableKey.startsWith("sb_publishable_") && validOwner(config.a);
const hasOwnerB = hasOwnerA && validOwner(config.b) && config.b.owner !== config.a.owner &&
  config.b.jwt !== config.a.jwt;

function id(suffix = "") {
  return `${TEST_PREFIX}${randomUUID()}${suffix}`;
}

function mutationId() {
  return `${TEST_PREFIX}mutation-${randomUUID()}`;
}

function fingerprint(content) {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

function projection(articleId, content = "Progress test body", title = "B3 contract test") {
  const now = new Date().toISOString();
  return {
    id: articleId, title, content, sourceType: "paste",
    createdAt: now, updatedAt: now, deletedAt: null
  };
}

async function rpc(who, name, args) {
  const response = await fetch(`${config.projectUrl.replace(/\/$/, "")}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: config.publishableKey,
      Authorization: `Bearer ${who.jwt}`,
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(args)
  });
  if (!response.ok) throw new Error(`${name} returned HTTP ${response.status}`);
  try { return await response.json(); }
  catch { throw new Error(`${name} returned invalid JSON`); }
}

function articlePush(who, articleId, operation, value, baseRevision = null,
    key = mutationId()) {
  return rpc(who, RPC.articlePush,
    articlePushArgs(who.owner, articleId, operation, value, baseRevision, key));
}

function articleSnapshot(who, articleId) {
  return rpc(who, RPC.articleSnapshot, {
    p_expected_owner_id: who.owner, p_article_id: articleId
  });
}

function progressPush(who, articleId, value, key = mutationId(), expectedOwner = who.owner) {
  return rpc(who, RPC.progressPush,
    progressPushArgs(expectedOwner, articleId, value, key));
}

function progressPull(who, afterCursor = "cursor:0", limit = 10) {
  return rpc(who, RPC.progressPull, {
    p_expected_owner_id: who.owner, p_after_cursor: afterCursor, p_limit: limit
  });
}

function progressInventory(who, afterArticleId = null, highWaterCursor = null, limit = 10) {
  return rpc(who, RPC.progressInventory, {
    p_expected_owner_id: who.owner, p_after_article_id: afterArticleId,
    p_high_water_cursor: highWaterCursor, p_limit: limit
  });
}

function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function inspect(who, articleId, key = null) {
  if (!articleId.startsWith(TEST_PREFIX) || !validOwner(who)) {
    throw new Error("Refusing to inspect a non-test Article or invalid owner.");
  }
  // This is a read-only admin inspection of an exact dedicated-test identity.
  // No table privileges are added to the production browser roles.
  const owner = quote(who.owner);
  const article = quote(articleId);
  const receipt = key === null ? "null::text" : quote(key);
  const sql = `select jsonb_build_object(
    'current', (select jsonb_build_object(
      'revision', server_revision, 'cursor', cursor, 'progress', progress,
      'paragraphIndex', paragraph_index, 'epoch', parent_reading_epoch,
      'fingerprint', content_fingerprint, 'updatedAt', server_updated_at)
      from public.progress_sync_records where owner_id=${owner} and article_id=${article}),
    'changes', (select count(*) from public.progress_sync_changes
      where owner_id=${owner} and article_id=${article}),
    'latestCursor', (select max(cursor) from public.progress_sync_changes
      where owner_id=${owner} and article_id=${article}),
    'receipts', (select count(*) from public.progress_sync_mutations
      where owner_id=${owner} and article_id=${article}),
    'targetReceipt', (select count(*) from public.progress_sync_mutations
      where owner_id=${owner} and article_id=${article} and mutation_id=${receipt}),
    'targetResult', (select mutation_result from public.progress_sync_mutations
      where owner_id=${owner} and article_id=${article} and mutation_id=${receipt}),
    'article', (select jsonb_build_object(
      'revision', revision, 'cursor', cursor, 'epoch', reading_epoch,
      'fingerprint', content_fingerprint, 'deleted', deleted_at_client is not null)
      from public.article_sync_records where owner_id=${owner} and article_id=${article}),
    'articleChanges', (select count(*) from public.article_sync_changes
      where owner_id=${owner} and article_id=${article}),
    'articleReceipts', (select count(*) from public.article_sync_mutations
      where owner_id=${owner} and article_id=${article})
  ) as state`;
  return linkedState(sql);
}

async function linkedState(sql) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync("supabase", [
      "db", "query", "--linked", "--output", "json", sql
    ], {
      cwd: process.cwd(), timeout: 90000, maxBuffer: 1024 * 1024
    }));
  } catch (error) {
    const detail = error.killed ? "timeout" :
      /LegacyDbConnectError|ECONN|ENOTFOUND|ETIMEDOUT|network/i.test(error.stderr || "") ?
        "connection" : `exit ${typeof error.code === "number" ? error.code : "unknown"}`;
    // Never include raw CLI output: it may contain connection details.
    throw new Error(`Project A read-only test-state inspection failed (${detail}).`);
  }
  return parseLinkedStateOutput(stdout);
}

function describeKeys(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "none";
  return Object.keys(value).slice(0, 12)
    .map(key => /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(key) ? key : "<other>")
    .join(",");
}

function parseLinkedStateOutput(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`Project A inspection returned non-JSON stdout (${Buffer.byteLength(stdout)} bytes).`);
  }
  const rows = Array.isArray(envelope) ? envelope :
    envelope && typeof envelope === "object" && !Array.isArray(envelope) &&
      Array.isArray(envelope.rows) ? envelope.rows : null;
  if (!rows) {
    const kind = Array.isArray(envelope) ? "array" :
      envelope === null ? "null" : typeof envelope;
    throw new Error(`Project A inspection JSON shape is unsupported (${kind}; keys=${describeKeys(envelope)}).`);
  }
  if (rows.length !== 1) {
    throw new Error(`Project A inspection returned unexpected row count (${rows.length}).`);
  }
  const row = rows[0];
  const state = row && typeof row === "object" && !Array.isArray(row) ? row.state : undefined;
  if (!Object.hasOwn(row || {}, "state") || state === null ||
      typeof state !== "object" || Array.isArray(state)) {
    const rowKind = Array.isArray(row) ? "array" : row === null ? "null" : typeof row;
    const stateKind = Array.isArray(state) ? "array" : state === null ? "null" : typeof state;
    throw new Error(`Project A inspection row is invalid (${rowKind}; keys=${describeKeys(row)}; state=${stateKind}).`);
  }
  return state;
}

function canonicalNumericRepresentation() {
  return linkedState(`select jsonb_build_object(
    'equal', '0.30'::jsonb = '0.3'::jsonb,
    'left', '0.30'::jsonb::text,
    'right', '0.3'::jsonb::text,
    'hashEqual', pg_catalog.sha256(pg_catalog.convert_to('0.30'::jsonb::text, 'UTF8')) =
      pg_catalog.sha256(pg_catalog.convert_to('0.3'::jsonb::text, 'UTF8'))
  ) as state`);
}

async function cleanup(who, articleIds) {
  for (const articleId of articleIds) {
    if (!articleId.startsWith(TEST_PREFIX)) {
      throw new Error("Refusing to clean a non-test Article.");
    }
    const snapshot = await articleSnapshot(who, articleId);
    if (snapshot.status !== "found" || snapshot.lifecycle !== "active") continue;
    const now = new Date().toISOString();
    const deleted = await articlePush(who, articleId, "delete", {
      ...snapshot.projection, updatedAt: now, deletedAt: now
    }, snapshot.revision);
    if (deleted.status !== "applied") throw new Error("Exact test Article cleanup failed.");
  }
}

module.exports = {
  config, hasOwnerA, hasOwnerB, id, mutationId, fingerprint, projection,
  articlePush, articleSnapshot, progressPush, progressPull, progressInventory,
  inspect, canonicalNumericRepresentation, parseLinkedStateOutput, cleanup, rpc, RPC
};
