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
  const responseIdentity = raw => [raw.mutationId, raw.articleId].every(value =>
    typeof value === "string" && value.length > 0 && value === value.trim());
  const successFields = ["status", "mutationId", "articleId", "revision", "cursor",
    "progress", "paragraphIndex", "parentReadingEpoch", "contentFingerprint", "serverUpdatedAt"];
  const conflictFields = ["status", "reason", "mutationId", "articleId",
    "currentRevision", "currentCursor"];
  const identifiedRejections = new Set(["parent-not-ready", "article-deleted",
    "parent-epoch-mismatch", "fingerprint-mismatch", "mutation-id-reuse"]);
  const plainRejections = new Set(["authentication-required", "owner-context-mismatch",
    "invalid-mutation", "invalid-checkpoint"]);
  const identityFields = ["mutationId", "articleId", "parentReadingEpoch",
    "contentFingerprint", "progress", "paragraphIndex"];

  function identityFacts(raw, request, fields) {
    return { mutationIdMatches: raw.mutationId === request.mutationId,
      articleIdMatches: raw.articleId === request.articleId,
      mismatchedFields: fields.filter(field => raw[field] !== request[field]),
      hadAcceptedCanonicalResult: false };
  }

  function validAttentionFacts(value, reason) {
    if (!["success-identity-mismatch", "conflict-identity-mismatch", "rejection-identity-mismatch"].includes(reason)) return false;
    const fields = reason === "success-identity-mismatch" ? identityFields
      : ["mutationId", "articleId"];
    return exact(value, ["mutationIdMatches", "articleIdMatches", "mismatchedFields",
      "hadAcceptedCanonicalResult"]) && typeof value.mutationIdMatches === "boolean" &&
      typeof value.articleIdMatches === "boolean" &&
      typeof value.hadAcceptedCanonicalResult === "boolean" &&
      Array.isArray(value.mismatchedFields) && value.mismatchedFields.length > 0 &&
      fields.filter(field => value.mismatchedFields.includes(field)).join() ===
        value.mismatchedFields.join() &&
      value.mismatchedFields.includes("mutationId") === !value.mutationIdMatches &&
      value.mismatchedFields.includes("articleId") === !value.articleIdMatches;
  }

  // Taxonomy is derived from facts, never stored as permanent recovery permission.
  function attentionCategory(reason, facts) {
    if (reason === "conflicting-duplicate-result") return "canonical-contradiction";
    if (["inconsistent-observation", "absence-after-revision", "malformed-observation",
      "invalid-observation"].includes(reason)) return "local-authority-contradiction";
    if (reason === "owner-context-mismatch") return "scope-auth-contradiction";
    if (reason === "mutation-id-reuse") return "protocol-identity-conflict";
    if (!validAttentionFacts(facts, reason)) return "unknown-attention";
    return !facts.hadAcceptedCanonicalResult &&
      (!facts.mutationIdMatches || !facts.articleIdMatches)
      ? "settlement-uncertainty" : "protocol-identity-conflict";
  }

  function evaluateReceiptRecovery(attempt) {
    if (attempt?.status !== "settlement_attention") return { status: "blocked", reason: "not-attention" };
    const category = attentionCategory(attempt.reason, attempt.settlement?.facts);
    return category === "settlement-uncertainty" && attempt.settlement.priorResult === null
      ? { status: "recoverable" } : { status: "blocked", reason: category };
  }

  function parse(raw, request) {
    if (!object(request) || request.expectedState !== "revision" || !object(raw)) {
      return { status: "unparseable" };
    }
    if (raw.status === "applied" || raw.status === "unchanged") {
      if (!exact(raw, successFields) || !responseIdentity(raw) || !revision(raw.revision) || !cursor(raw.cursor) ||
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
        return { status: "attention", reason: "success-identity-mismatch",
          facts: identityFacts(raw, request, identityFields) };
      }
      // Normalize field order before durable storage/comparison. JSON object
      // insertion order is not part of the server's canonical result identity.
      return { status: "success", result: Object.fromEntries(
        successFields.map(field => [field, raw[field]])) };
    }
    if (raw.status === "conflict") {
      if (!exact(raw, conflictFields) || !responseIdentity(raw) || raw.reason !== "revision-mismatch" ||
          !(raw.currentRevision === null || revision(raw.currentRevision)) ||
          !(raw.currentCursor === null || cursor(raw.currentCursor)) ||
          (raw.currentRevision === null) !== (raw.currentCursor === null)) {
        return { status: "unparseable" };
      }
      if (raw.mutationId !== request.mutationId || raw.articleId !== request.articleId) {
        return { status: "attention", reason: "conflict-identity-mismatch",
          facts: identityFacts(raw, request, ["mutationId", "articleId"]) };
      }
      return { status: "terminal", reason: raw.reason,
        currentRevisionHint: raw.currentRevision, currentCursorHint: raw.currentCursor };
    }
    if (raw.status !== "rejected" || typeof raw.reason !== "string") {
      return { status: "unparseable" };
    }
    if (identifiedRejections.has(raw.reason)) {
      if (!exact(raw, ["status", "reason", "mutationId", "articleId"]) || !responseIdentity(raw)) {
        return { status: "unparseable" };
      }
      if (raw.mutationId !== request.mutationId || raw.articleId !== request.articleId) {
        return { status: "attention", reason: "rejection-identity-mismatch",
          facts: identityFacts(raw, request, ["mutationId", "articleId"]) };
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

  window.LingoFlowProgressCloudResult = Object.freeze({ parse, evaluateCoverage, same,
    validAttentionFacts, attentionCategory, evaluateReceiptRecovery });
})();
