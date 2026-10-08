"use strict";

// Shared PURE builders/parser: import performs no env, storage, Auth or HTTP IO.
function articlePushArgs(owner, articleId, operation, projection, baseRevision, mutationId) {
  return { p_expected_owner_id: owner, p_mutation: { mutationId, articleId, operation, baseRevision, projection } };
}
function progressPushArgs(owner, articleId, value, mutationId) {
  return { p_expected_owner_id: owner, p_mutation: { mutationId, articleId,
    expectedState: value.expectedState, expectedProgressRevision: value.expectedProgressRevision,
    parentReadingEpoch: value.parentReadingEpoch, contentFingerprint: value.contentFingerprint,
    progress: value.progress, paragraphIndex: value.paragraphIndex } };
}

// Defense in depth, used BEFORE transport in Node and in the private page.
// Pure validation is not a permit issuer and cannot authorize any IO.
function validFixtureSeedWire(lane, wire, expected) {
  const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
  if (!exact(wire, ["p_expected_owner_id", "p_mutation"]) || wire.p_expected_owner_id !== expected.ownerId) return false;
  const m = wire.p_mutation, def = expected.definition;
  if (!def || m?.articleId !== def.articleId || m.mutationId !== def[lane === "article" ? "articleMutationId" : "progressMutationId"]) return false;
  if (lane === "article") return exact(m, ["mutationId", "articleId", "operation", "baseRevision", "projection"]) &&
    m.operation === "put" && m.baseRevision === null &&
    exact(m.projection, ["id", "title", "content", "sourceType", "createdAt", "updatedAt", "deletedAt"]) &&
    m.projection.id === def.articleId && m.projection.title === expected.title && m.projection.content === expected.content &&
    m.projection.sourceType === "paste" && m.projection.createdAt === def.createdAt &&
    m.projection.updatedAt === def.createdAt && m.projection.deletedAt === null;
  return lane === "progress" && exact(m, ["mutationId", "articleId", "expectedState", "expectedProgressRevision",
    "parentReadingEpoch", "contentFingerprint", "progress", "paragraphIndex"]) &&
    m.expectedState === "absent" && m.expectedProgressRevision === null && m.progress === 0.2 && m.paragraphIndex === 4 &&
    m.parentReadingEpoch === expected.parent?.readingEpoch && m.contentFingerprint === expected.parent?.contentFingerprint;
}

// Also serialized into the ephemeral page closure. Never return raw response,
// headers, content or arbitrary server fields over CDP. All output fields are
// validated against the exact request, not arbitrary strings from an endpoint.
function canonicalFixtureResult(raw, lane, wire) {
  const m = wire.p_mutation;
  const fail = () => { throw new Error("fixture-response-invalid"); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.status !== "applied" ||
      raw.articleId !== m.articleId || raw.mutationId !== m.mutationId || raw.revision !== "revision:1" ||
      typeof raw.cursor !== "string" || !/^cursor:[1-9][0-9]{0,18}$/.test(raw.cursor) ||
      BigInt(raw.cursor.slice(7)) > 9223372036854775807n) fail();
  const result = { status: "applied", articleId: m.articleId, mutationId: m.mutationId,
    revision: raw.revision, cursor: raw.cursor };
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  if (lane === "article") {
    if (raw.operation !== "put" || !uuid.test(raw.readingEpoch) ||
        !/^sha256:[a-f0-9]{64}$/.test(raw.contentFingerprint)) fail();
    return { ...result, operation: "put", readingEpoch: raw.readingEpoch, contentFingerprint: raw.contentFingerprint };
  }
  if (lane !== "progress" || raw.parentReadingEpoch !== m.parentReadingEpoch ||
      raw.contentFingerprint !== m.contentFingerprint || raw.progress !== m.progress ||
      raw.paragraphIndex !== m.paragraphIndex || typeof raw.serverUpdatedAt !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(raw.serverUpdatedAt) ||
      !Number.isFinite(Date.parse(raw.serverUpdatedAt))) fail();
  return { ...result, parentReadingEpoch: m.parentReadingEpoch, contentFingerprint: m.contentFingerprint,
    progress: m.progress, paragraphIndex: m.paragraphIndex, serverUpdatedAt: raw.serverUpdatedAt };
}

// Reject reentrancy before serialization or any final segment. Proxy detection
// is a Node intrinsic (cannot be replaced by inspecting the object's keys).
function freezePlainWire(value) {
  const { isProxy } = require("node:util").types;
  const seen = new Set();
  const visit = item => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || isProxy(item) || seen.has(item)) throw new Error("fixture-wire-not-plain");
    const proto = Object.getPrototypeOf(item);
    if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) throw new Error("fixture-wire-not-plain");
    seen.add(item);
    for (const key of Reflect.ownKeys(item)) {
      if (typeof key !== "string" || key === "toJSON") throw new Error("fixture-wire-not-plain");
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !("value" in descriptor)) throw new Error("fixture-wire-not-plain");
      visit(descriptor.value);
    }
    seen.delete(item); Object.freeze(item);
  };
  visit(value);
  return value;
}
module.exports = { articlePushArgs, progressPushArgs, validFixtureSeedWire, canonicalFixtureResult, freezePlainWire };
