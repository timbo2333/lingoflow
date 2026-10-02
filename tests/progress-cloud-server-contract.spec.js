const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { parseLinkedStateOutput } = require("./progress-cloud-live-helpers");

const migration = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations",
  "20261001120000_add_progress_cloud_protocol.sql"), "utf8");

test("CLI inspection parser accepts only verified one-row JSON shapes", () => {
  const state = { equal: true, hashEqual: false };
  expect(parseLinkedStateOutput(JSON.stringify([{ state }]))).toEqual(state);
  expect(parseLinkedStateOutput(JSON.stringify({
    boundary: "test", rows: [{ state }], warning: "test"
  }))).toEqual(state);
  for (const invalid of [{ data: [{ state }] }, [], [{ state: null }],
    [{ state }, { state }]]) {
    expect(() => parseLinkedStateOutput(JSON.stringify(invalid))).toThrow();
  }
});

test("B3-1 migration keeps Progress direct tables private and RPC-only", () => {
  for (const table of ["progress_sync_records", "progress_sync_changes",
    "progress_sync_mutations"]) {
    expect(migration).toContain(`alter table public.${table} enable row level security`);
    expect(migration).toContain(`revoke all on public.${table} from public, anon, authenticated`);
  }
  for (const name of ["push", "pull", "inventory"]) {
    expect(migration).toContain(`create or replace function public.lingoflow_progress_sync_${name}`);
    expect(migration).toContain(`grant execute on function public.lingoflow_progress_sync_${name}`);
  }
  expect(migration).not.toMatch(/grant\s+(insert|update|delete|all)\s+on\s+public\.progress_sync_/i);
});

test("Article browser protocol accepts additive server reading context", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(() => {
    const protocol = window.LingoFlowArticleSyncCloudProtocol;
    const projection = {
      id: "article:epoch-compatible", title: "Title", content: "Body",
      sourceType: "paste", createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z", deletedAt: null
    };
    const readingEpoch = "11111111-2222-4333-8444-555555555555";
    const contentFingerprint = `sha256:${"a".repeat(64)}`;
    const change = { cursor: "cursor:1", articleId: projection.id,
      operation: "put", revision: "revision:1", projection,
      readingEpoch, contentFingerprint };
    const pull = protocol.validatePullResult({ status: "ready", changes: [change],
      nextCursor: "cursor:1", hasMore: false }, null, 10);
    const push = protocol.validatePushResult({ status: "applied",
      mutationId: "mutation:epoch", articleId: projection.id, operation: "put",
      revision: "revision:1", cursor: "cursor:1", readingEpoch,
      contentFingerprint }, { mutationId: "mutation:epoch", articleId: projection.id,
      operation: "put" });
    const snapshot = protocol.validateSnapshotResult({ status: "found",
      articleId: projection.id, revision: "revision:1", cursor: "cursor:1",
      lifecycle: "active", projection, readingEpoch, contentFingerprint }, projection.id);
    return { pull: Boolean(pull), push: Boolean(push), snapshot: Boolean(snapshot),
      projectionHasEpoch: Object.hasOwn(pull?.changes[0]?.projection || {}, "readingEpoch") };
  });
  expect(result).toEqual({ pull: true, push: true, snapshot: true,
    projectionHasEpoch: false });
});

test("B1 fingerprint matches exact UTF-8 server fixtures without text normalization", async ({ page }) => {
  await page.goto("/");
  const cases = [
    ["Read 123.", 9, "31a578b36177fcb4e86200cafbe429e2db313491c9472927a6d32d4712c6c373"],
    ["中文", 6, "72726d8818f693066ceb69afa364218b692e62ea92b385782363780f47529c21"],
    ["🙂", 4, "d06f1525f791397809f9bc98682b5c13318eca4c3123433467fd4dffda44fd14"],
    ["a\r\nb", 4, "18745f36a05e29072709042d6062ce54f1b08ff36c27ba80c39f81fb010c8ce2"],
    ["a\nb", 3, "7e18f737311b2dc3b2f269dd78396b0351f14fb66efa879f768cb23181883c78"],
    ["é", 2, "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c"],
    ["e\u0301", 3, "bf12767b0f2a56b2190075bae8169f656e3ce8d6357d4aff184bc6c7ea48f9f6"],
    [" a \n", 4, "c4042d6c47e5cdee0906df461d0cd66b73068c8a4d92de8d5f99226bb46c4f62"]
  ];
  const actual = await page.evaluate(async values => Promise.all(values.map(async ([content]) => ({
    bytes: new TextEncoder().encode(content).length,
    fingerprint: await window.LingoFlowReadingResume.fingerprintContent(content)
  }))), cases);
  expect(actual).toEqual(cases.map(([, bytes, hash]) => ({
    bytes, fingerprint: `sha256:${hash}`
  })));
  expect(actual[3].fingerprint).not.toBe(actual[4].fingerprint);
  expect(actual[5].fingerprint).not.toBe(actual[6].fingerprint);
});
