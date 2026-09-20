(function() {
  "use strict";

  // Backup v2 deliberately serializes the complete local record. Article Cloud Sync
  // has a narrower contract: reading and lastReadAt never cross this boundary.
  const REQUIRED_FIELDS = [
    "id", "title", "content", "sourceType", "createdAt", "updatedAt", "deletedAt"
  ];
  const OPTIONAL_SOURCE_FIELDS = ["sourceId", "sourceTitle", "sourceAttribution"];
  const SYNC_FIELDS = new Set([...REQUIRED_FIELDS, ...OPTIONAL_SOURCE_FIELDS]);
  const SOURCE_TYPES = new Set(["paste", "txt", "library"]);

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function isTimestamp(value, nullable = false) {
    if (nullable && value === null) return true;
    return typeof value === "string" && Boolean(value.trim()) &&
      Number.isFinite(Date.parse(value));
  }

  function sanitizeArticleSyncProjection(value) {
    if (!isPlainObject(value) ||
        Object.keys(value).some(key => !SYNC_FIELDS.has(key)) ||
        REQUIRED_FIELDS.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
      throw new Error("Article sync projection 字段无效。");
    }
    if (typeof value.id !== "string" || !value.id.trim() || value.id !== value.id.trim() ||
        typeof value.title !== "string" || !value.title.trim() ||
        typeof value.content !== "string" || !value.content.trim() ||
        !SOURCE_TYPES.has(value.sourceType) ||
        !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) ||
        !isTimestamp(value.deletedAt, true)) {
      throw new Error("Article sync projection 内容无效。");
    }

    const projection = {};
    for (const field of REQUIRED_FIELDS) projection[field] = value[field];
    for (const field of OPTIONAL_SOURCE_FIELDS) {
      const text = value[field];
      if (text === undefined || text === null) continue;
      if (typeof text !== "string" || !text.trim()) {
        throw new Error(`Article sync projection ${field} 无效。`);
      }
      projection[field] = text;
    }
    if (value.sourceType === "library") {
      if (!projection.sourceId) throw new Error("Article sync projection 缺少 sourceId。");
    } else if (projection.sourceId) {
      throw new Error("Article sync projection sourceId 无效。");
    }
    return projection;
  }

  function projectArticleForSync(article) {
    if (!isPlainObject(article)) throw new Error("Article record 无效。");
    const selected = {};
    for (const field of SYNC_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(article, field)) selected[field] = article[field];
    }
    return sanitizeArticleSyncProjection(selected);
  }

  function compareArticleSyncProjection(left, right) {
    const first = projectArticleForSync(left);
    const second = projectArticleForSync(right);
    return Array.from(SYNC_FIELDS).every(field => Object.is(first[field], second[field]));
  }

  function mergeRemoteArticleProjection(localArticle, remoteProjection) {
    const remote = sanitizeArticleSyncProjection(remoteProjection);
    if (localArticle !== null && localArticle !== undefined) {
      if (projectArticleForSync(localArticle).id !== remote.id) {
        throw new Error("Article sync projection ID 不匹配。");
      }
    }

    const merged = localArticle === null || localArticle === undefined
      ? {
          // These are local-only compatibility defaults, not remote reading state.
          lastReadAt: remote.createdAt,
          reading: { progress: 0, paragraphIndex: 0, updatedAt: null }
        }
      : structuredClone(localArticle);
    for (const field of OPTIONAL_SOURCE_FIELDS) delete merged[field];
    for (const field of REQUIRED_FIELDS) merged[field] = remote[field];
    for (const field of OPTIONAL_SOURCE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(remote, field)) merged[field] = remote[field];
    }
    return merged;
  }

  window.LingoFlowArticleSyncProjection = Object.freeze({
    projectArticleForSync,
    sanitizeArticleSyncProjection,
    compareArticleSyncProjection,
    mergeRemoteArticleProjection
  });
})();
