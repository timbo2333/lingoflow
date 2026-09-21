(function() {
  "use strict";

  const DEFAULT_PAGE_SIZE = 10;
  const MAX_PAGE_SIZE = 25;
  const OPERATIONS = new Set(["put", "delete", "restore"]);

  function opaque(value) {
    return typeof value === "string" && Boolean(value.trim()) && value === value.trim();
  }

  function cursorNumber(value, allowZero = true) {
    if (typeof value !== "string" || !/^cursor:(0|[1-9][0-9]*)$/.test(value)) return null;
    const number = BigInt(value.slice(7));
    return !allowZero && number === 0n ? null : number;
  }

  function revisionNumber(value) {
    if (typeof value !== "string" || !/^revision:[1-9][0-9]*$/.test(value)) return null;
    return BigInt(value.slice(9));
  }

  function validateOwner(owner) {
    return owner && opaque(owner.ownerId) && opaque(owner.bindingId);
  }

  function validateReadyMutation(owner, value) {
    if (!validateOwner(owner) || !value || value.status !== "ready" ||
        value.ownerId !== owner.ownerId || value.bindingId !== owner.bindingId ||
        !opaque(value.mutationId) || !opaque(value.articleId) ||
        !OPERATIONS.has(value.operation) ||
        (value.baseRevision !== null && revisionNumber(value.baseRevision) === null)) {
      return { status: "invalid", reason: "invalid-payload" };
    }
    let projection;
    try {
      projection = window.LingoFlowArticleSyncProjection
        .sanitizeArticleSyncProjection(value.candidate);
    } catch {
      return { status: "invalid", reason: "invalid-payload" };
    }
    if (projection.id !== value.articleId ||
        (value.operation === "delete") !== (projection.deletedAt !== null)) {
      return { status: "invalid", reason: "invalid-payload" };
    }
    return {
      status: "valid",
      mutation: {
        mutationId: value.mutationId,
        articleId: value.articleId,
        operation: value.operation,
        baseRevision: value.baseRevision,
        projection
      }
    };
  }

  function validatePushResult(raw, mutation) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
        !["applied", "unchanged", "conflict", "rejected"].includes(raw.status)) return null;
    if (raw.mutationId !== mutation.mutationId || raw.articleId !== mutation.articleId) return null;
    if (["applied", "unchanged"].includes(raw.status)) {
      if (raw.operation !== mutation.operation || revisionNumber(raw.revision) === null ||
          cursorNumber(raw.cursor, false) === null) return null;
    } else if (!opaque(raw.reason)) return null;
    if (raw.status === "conflict" &&
        (raw.currentRevision !== null && revisionNumber(raw.currentRevision) === null)) return null;
    return raw;
  }

  function validatePullResult(raw, afterCursor, requestedLimit) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (raw.status === "rejected") {
      return opaque(raw.reason) ? {
        status: "rejected", reason: raw.reason,
        changes: [], nextCursor: null, hasMore: false
      } : null;
    }
    if (raw.status !== "ready" || !Array.isArray(raw.changes) ||
        raw.changes.length > requestedLimit || typeof raw.hasMore !== "boolean" ||
        cursorNumber(raw.nextCursor) === null) return null;
    let previous = afterCursor === null ? 0n : cursorNumber(afterCursor);
    if (previous === null) return null;
    const changes = [];
    for (const change of raw.changes) {
      if (!change || typeof change !== "object" || Array.isArray(change) ||
          !opaque(change.articleId) || !OPERATIONS.has(change.operation) ||
          revisionNumber(change.revision) === null) return null;
      const cursor = cursorNumber(change.cursor, false);
      if (cursor === null || cursor <= previous) return null;
      let projection;
      try {
        projection = window.LingoFlowArticleSyncProjection
          .sanitizeArticleSyncProjection(change.projection);
      } catch {
        return null;
      }
      if (projection.id !== change.articleId ||
          (change.operation === "delete") !== (projection.deletedAt !== null)) return null;
      changes.push({ ...change, projection });
      previous = cursor;
    }
    if (cursorNumber(raw.nextCursor) !== previous ||
        (raw.hasMore && changes.length === 0)) return null;
    return { status: "ready", changes, nextCursor: raw.nextCursor, hasMore: raw.hasMore };
  }

  function validateSnapshotResult(raw, articleId) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
        raw.articleId !== articleId) return null;
    if (raw.status === "missing") return { status: "missing", articleId };
    if (raw.status !== "found" || revisionNumber(raw.revision) === null ||
        cursorNumber(raw.cursor, false) === null ||
        !["active", "deleted"].includes(raw.lifecycle)) return null;
    try {
      const projection = window.LingoFlowArticleSyncProjection
        .sanitizeArticleSyncProjection(raw.projection);
      if (projection.id !== articleId ||
          (raw.lifecycle === "deleted") !== (projection.deletedAt !== null)) return null;
      return { ...raw, projection };
    } catch {
      return null;
    }
  }

  window.LingoFlowArticleSyncCloudProtocol = Object.freeze({
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
    cursorNumber,
    revisionNumber,
    validateOwner,
    validateReadyMutation,
    validatePushResult,
    validatePullResult,
    validateSnapshotResult
  });
})();
