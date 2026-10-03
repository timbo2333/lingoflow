(function() {
  "use strict";

  // This module interprets an already received RPC value. It performs no IO.
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const exact = (value, fields) => object(value) && Object.keys(value).length === fields.length &&
    fields.every(field => Object.hasOwn(value, field));
  const serverBigint = (value, prefix) => typeof value === "string" &&
    new RegExp(`^${prefix}:[1-9][0-9]*$`).test(value) &&
    BigInt(value.slice(prefix.length + 1)) <= 9223372036854775807n;
  const revision = value => serverBigint(value, "revision");
  const cursor = value => serverBigint(value, "cursor");
  const epoch = value => typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
  const fingerprint = value => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const successFields = ["status", "mutationId", "articleId", "revision", "cursor",
    "progress", "paragraphIndex", "parentReadingEpoch", "contentFingerprint", "serverUpdatedAt"];
  const conflictFields = ["status", "reason", "mutationId", "articleId",
    "currentRevision", "currentCursor"];
  const identifiedRejections = new Set(["parent-not-ready", "article-deleted",
    "parent-epoch-mismatch", "fingerprint-mismatch", "mutation-id-reuse"]);
  const plainRejections = new Set(["authentication-required", "owner-context-mismatch",
    "invalid-mutation", "invalid-checkpoint"]);

  function parse(raw, request) {
    if (!object(request) || request.expectedState !== "revision" || !object(raw)) {
      return { status: "unparseable" };
    }
    if (raw.status === "applied" || raw.status === "unchanged") {
      if (!exact(raw, successFields) || !revision(raw.revision) || !cursor(raw.cursor) ||
          !epoch(raw.parentReadingEpoch) || !fingerprint(raw.contentFingerprint) ||
          typeof raw.progress !== "number" || !Number.isFinite(raw.progress) ||
          raw.progress < 0 || raw.progress > 1 || !Number.isInteger(raw.paragraphIndex) ||
          raw.paragraphIndex < 0 || raw.paragraphIndex > 2147483647 ||
          typeof raw.serverUpdatedAt !== "string" || !Number.isFinite(Date.parse(raw.serverUpdatedAt))) {
        return { status: "unparseable" };
      }
      if (raw.mutationId !== request.mutationId || raw.articleId !== request.articleId ||
          raw.parentReadingEpoch !== request.parentReadingEpoch ||
          raw.contentFingerprint !== request.contentFingerprint ||
          raw.progress !== request.progress || raw.paragraphIndex !== request.paragraphIndex) {
        return { status: "attention", reason: "success-identity-mismatch" };
      }
      // Normalize field order before durable storage/comparison. JSON object
      // insertion order is not part of the server's canonical result identity.
      return { status: "success", result: Object.fromEntries(
        successFields.map(field => [field, raw[field]])) };
    }
    if (raw.status === "conflict") {
      if (!exact(raw, conflictFields) || raw.reason !== "revision-mismatch" ||
          !(raw.currentRevision === null || revision(raw.currentRevision)) ||
          !(raw.currentCursor === null || cursor(raw.currentCursor)) ||
          (raw.currentRevision === null) !== (raw.currentCursor === null)) {
        return { status: "unparseable" };
      }
      if (raw.mutationId !== request.mutationId || raw.articleId !== request.articleId) {
        return { status: "attention", reason: "conflict-identity-mismatch" };
      }
      return { status: "terminal", reason: raw.reason,
        currentRevisionHint: raw.currentRevision, currentCursorHint: raw.currentCursor };
    }
    if (raw.status !== "rejected" || typeof raw.reason !== "string") {
      return { status: "unparseable" };
    }
    if (identifiedRejections.has(raw.reason)) {
      if (!exact(raw, ["status", "reason", "mutationId", "articleId"])) {
        return { status: "unparseable" };
      }
      if (raw.mutationId !== request.mutationId || raw.articleId !== request.articleId) {
        return { status: "attention", reason: "rejection-identity-mismatch" };
      }
      return raw.reason === "mutation-id-reuse"
        ? { status: "attention", reason: raw.reason }
        : { status: "terminal", reason: raw.reason };
    }
    if (!plainRejections.has(raw.reason) || !exact(raw, ["status", "reason"])) {
      return { status: "unparseable" };
    }
    if (raw.reason === "authentication-required") return { status: "auth-paused" };
    if (raw.reason === "owner-context-mismatch") {
      return { status: "attention", reason: raw.reason };
    }
    return { status: "terminal", reason: raw.reason };
  }

  // A successful server mutation and coverage of today's local position are
  // different facts. This pure predicate is never a send authorization.
  function evaluateCoverage({ attempt, desired, observation, parent, local }) {
    if (!attempt || attempt.status !== "succeeded" || !attempt.result) return "unknown";
    if (!local || local.status !== "ready") return "unknown";
    if (local.scope?.ownerId !== attempt.ownerId ||
        local.scope?.bindingId !== attempt.bindingId ||
        local.articleId !== attempt.articleId) return "scope-mismatch";
    if (!local.active || local.fingerprint !== attempt.request.contentFingerprint) {
      return "local-advanced";
    }
    if (!parent || parent.lifecycle !== "active" ||
        parent.readingEpoch !== attempt.result.parentReadingEpoch ||
        parent.contentFingerprint !== attempt.result.contentFingerprint) {
      return "cloud-state-stale";
    }
    if (desired?.pending) return "pending-local";
    if (desired?.confirmed && (desired.localSeq !== attempt.sourceLocalSeq ||
        desired.confirmed.fence?.action?.actionId !== attempt.sourceActionId ||
        !same(desired.confirmed.checkpoint, attempt.sourceCheckpoint) ||
        !same(desired.confirmed.fence, attempt.sourceFence) ||
        !same(desired.confirmed.causalBase, attempt.sourceCausalBase))) {
      return "local-advanced";
    }
    if (!same(local.checkpoint, attempt.sourceCheckpoint) ||
        !same(local.fence, attempt.sourceFence) ||
        !same(local.scope, attempt.sourceScope)) return "local-advanced";
    if (!observation || observation.kind !== "revision" ||
        observation.revision !== attempt.result.revision ||
        observation.cursor !== attempt.result.cursor ||
        observation.parentReadingEpoch !== attempt.result.parentReadingEpoch ||
        observation.contentFingerprint !== attempt.result.contentFingerprint ||
        !same(observation.checkpoint, { progress: attempt.result.progress,
          paragraphIndex: attempt.result.paragraphIndex })) return "cloud-state-stale";
    return "covered";
  }

  window.LingoFlowProgressCloudResult = Object.freeze({ parse, evaluateCoverage, same });
})();
