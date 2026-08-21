(function() {
  "use strict";

  const SOURCE_TYPES = new Set(["paste", "txt", "library"]);
  const REQUIRED_FIELDS = [
    "id",
    "title",
    "content",
    "sourceType",
    "createdAt",
    "updatedAt",
    "lastReadAt",
    "deletedAt",
    "reading"
  ];

  function createError(code, path, details = {}) {
    return {
      code,
      path,
      ...(Number.isInteger(details.index) ? { index: details.index } : {}),
      ...(details.articleId ? { articleId: details.articleId } : {}),
      ...(details.conflictingArticleId
        ? { conflictingArticleId: details.conflictingArticleId }
        : {})
    };
  }

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function isArrayIndexKey(key) {
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)) return false;
    const index = Number(key);
    return Number.isInteger(index) && index >= 0 && index < 4294967295;
  }

  function getJsonPropertyKeys(value, path) {
    const keys = Reflect.ownKeys(value);
    const propertyKeys = [];
    let arrayIndexCount = 0;

    for (const key of keys) {
      if (Array.isArray(value) && key === "length") continue;
      if (typeof key === "symbol") {
        return { error: createError("invalid-json-value", path) };
      }
      if (Array.isArray(value) && !isArrayIndexKey(key)) {
        return { error: createError("invalid-json-value", path) };
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor ||
          !descriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        const propertyPath = Array.isArray(value)
          ? `${path}[${key}]`
          : path === "$" ? key : `${path}.${key}`;
        return { error: createError("invalid-json-value", propertyPath) };
      }

      propertyKeys.push({ key, value: descriptor.value });
      if (Array.isArray(value)) arrayIndexCount += 1;
    }

    if (Array.isArray(value) && arrayIndexCount !== value.length) {
      return { error: createError("invalid-json-value", path) };
    }
    return { propertyKeys, error: null };
  }

  function findJsonError(value, path = "$", ancestors = new WeakSet()) {
    if (value === null) return null;
    if (["string", "boolean"].includes(typeof value)) return null;
    if (typeof value === "number") {
      return Number.isFinite(value) ? null : createError("invalid-json-value", path);
    }
    if (typeof value !== "object") {
      return createError("invalid-json-value", path);
    }

    if (!Array.isArray(value) && !isPlainObject(value)) {
      return createError("invalid-json-value", path);
    }
    if (ancestors.has(value)) {
      return createError("invalid-json-value", path);
    }

    ancestors.add(value);
    const properties = getJsonPropertyKeys(value, path);
    if (properties.error) {
      ancestors.delete(value);
      return properties.error;
    }

    for (const property of properties.propertyKeys) {
      const key = property.key;
      const childPath = Array.isArray(value)
        ? `${path}[${key}]`
        : path === "$" ? key : `${path}.${key}`;
      const error = findJsonError(property.value, childPath, ancestors);
      if (error) {
        ancestors.delete(value);
        return error;
      }
    }
    ancestors.delete(value);
    return null;
  }

  function isValidTimestamp(value, nullable = false) {
    if (nullable && value === null) return true;
    return typeof value === "string" &&
      Boolean(value.trim()) &&
      Number.isFinite(Date.parse(value));
  }

  function getArticleId(article) {
    try {
      if (!isPlainObject(article)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(article, "id");
      if (!descriptor ||
          !descriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        return null;
      }
      return typeof descriptor.value === "string" && descriptor.value.trim()
        ? descriptor.value
        : null;
    } catch (error) {
      return null;
    }
  }

  function addMissingFieldErrors(article, errors) {
    for (const field of REQUIRED_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(article, field)) {
        errors.push(createError("missing-field", field));
      }
    }
  }

  function validateKnownFields(article, errors) {
    if (Object.prototype.hasOwnProperty.call(article, "id") &&
        (typeof article.id !== "string" ||
          !article.id.trim() ||
          article.id !== article.id.trim())) {
      errors.push(createError("invalid-id", "id"));
    }

    if (Object.prototype.hasOwnProperty.call(article, "title") &&
        (typeof article.title !== "string" || !article.title.trim())) {
      errors.push(createError("invalid-title", "title"));
    }

    if (Object.prototype.hasOwnProperty.call(article, "content") &&
        (typeof article.content !== "string" || !article.content.trim())) {
      errors.push(createError("invalid-content", "content"));
    }

    if (Object.prototype.hasOwnProperty.call(article, "sourceType")) {
      if (typeof article.sourceType !== "string" || !SOURCE_TYPES.has(article.sourceType)) {
        errors.push(createError("invalid-source", "sourceType"));
      } else if (article.sourceType === "library") {
        if (typeof article.sourceId !== "string" || !article.sourceId.trim()) {
          errors.push(createError("invalid-source", "sourceId"));
        }
      } else if (Object.prototype.hasOwnProperty.call(article, "sourceId")) {
        errors.push(createError("invalid-source", "sourceId"));
      }
    }

    for (const field of ["sourceTitle", "sourceAttribution"]) {
      if (Object.prototype.hasOwnProperty.call(article, field) &&
          (typeof article[field] !== "string" || !article[field].trim())) {
        errors.push(createError("invalid-source", field));
      }
    }

    for (const field of ["createdAt", "updatedAt", "lastReadAt"]) {
      if (Object.prototype.hasOwnProperty.call(article, field) &&
          !isValidTimestamp(article[field])) {
        errors.push(createError("invalid-timestamp", field));
      }
    }

    if (Object.prototype.hasOwnProperty.call(article, "deletedAt") &&
        !isValidTimestamp(article.deletedAt, true)) {
      errors.push(createError("invalid-timestamp", "deletedAt"));
    }

    if (!Object.prototype.hasOwnProperty.call(article, "reading")) return;
    if (!isPlainObject(article.reading)) {
      errors.push(createError("invalid-reading", "reading"));
      return;
    }

    const reading = article.reading;
    if (!Object.prototype.hasOwnProperty.call(reading, "progress")) {
      errors.push(createError("missing-field", "reading.progress"));
    } else if (typeof reading.progress !== "number" ||
        !Number.isFinite(reading.progress) ||
        reading.progress < 0 ||
        reading.progress > 1) {
      errors.push(createError("invalid-reading", "reading.progress"));
    }

    if (!Object.prototype.hasOwnProperty.call(reading, "paragraphIndex")) {
      errors.push(createError("missing-field", "reading.paragraphIndex"));
    } else if (!Number.isInteger(reading.paragraphIndex) || reading.paragraphIndex < 0) {
      errors.push(createError("invalid-reading", "reading.paragraphIndex"));
    }

    if (!Object.prototype.hasOwnProperty.call(reading, "updatedAt")) {
      errors.push(createError("missing-field", "reading.updatedAt"));
    } else if (!isValidTimestamp(reading.updatedAt, true)) {
      errors.push(createError("invalid-reading", "reading.updatedAt"));
    }
  }

  function rejectedArticle(article, errors) {
    return {
      status: "rejected",
      articleId: getArticleId(article),
      article: null,
      errors
    };
  }

  function validateArticle(article) {
    try {
      if (!isPlainObject(article)) {
        return rejectedArticle(article, [createError("invalid-article", "$")]);
      }

      const jsonError = findJsonError(article);
      if (jsonError) return rejectedArticle(article, [jsonError]);

      const errors = [];
      addMissingFieldErrors(article, errors);
      validateKnownFields(article, errors);
      if (errors.length) return rejectedArticle(article, errors);

      return {
        status: "valid",
        articleId: article.id,
        article,
        errors: []
      };
    } catch (error) {
      return rejectedArticle(article, [createError("invalid-article", "$")]);
    }
  }

  function withBatchContext(error, index, articleId) {
    return {
      ...error,
      index,
      ...(articleId ? { articleId } : {})
    };
  }

  function validateArticles(articles) {
    if (!Array.isArray(articles)) {
      return {
        status: "rejected",
        summary: { total: 0, valid: 0, rejected: 0 },
        articles: [],
        items: [],
        errors: [createError("invalid-articles", "$")]
      };
    }

    const items = articles.map((article, index) => {
      const result = validateArticle(article);
      return {
        index,
        status: result.status,
        articleId: result.articleId,
        errors: result.errors.slice()
      };
    });
    const ids = new Map();
    const sources = new Map();

    articles.forEach((article, index) => {
      if (items[index].status !== "valid") return;
      const articleId = items[index].articleId;
      if (articleId) {
        if (ids.has(articleId)) {
          items[index].errors.push(createError("duplicate-article-id", "id", {
            articleId,
            conflictingArticleId: articleId
          }));
        } else {
          ids.set(articleId, index);
        }
      }

      if (!isPlainObject(article) ||
          article.sourceType !== "library" ||
          typeof article.sourceId !== "string" ||
          !article.sourceId.trim() ||
          !articleId) {
        return;
      }

      const sourceKey = article.sourceId.trim();
      const existing = sources.get(sourceKey);
      if (existing && existing.articleId !== articleId) {
        items[index].errors.push(createError("duplicate-article-source", "sourceId", {
          articleId,
          conflictingArticleId: existing.articleId
        }));
      } else if (!existing) {
        sources.set(sourceKey, { articleId, index });
      }
    });

    const errors = [];
    for (const item of items) {
      if (item.errors.length) item.status = "rejected";
      for (const error of item.errors) {
        errors.push(withBatchContext(error, item.index, item.articleId));
      }
    }

    const rejected = items.filter(item => item.status === "rejected").length;
    const status = rejected ? "rejected" : "valid";
    return {
      status,
      summary: {
        total: articles.length,
        valid: articles.length - rejected,
        rejected
      },
      articles: status === "valid" ? articles.slice() : [],
      items,
      errors
    };
  }

  window.LingoFlowBackupV2Schema = Object.freeze({
    validateArticle,
    validateArticles
  });
})();
