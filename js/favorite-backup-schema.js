(function() {
  "use strict";

  const FAVORITE_TYPES = new Set(["word", "phrase"]);
  const REQUIRED_FIELDS = [
    "id",
    "type",
    "text",
    "createdAt",
    "updatedAt",
    "deletedAt"
  ];
  const OPTIONAL_TEXT_FIELDS = [
    "displayText",
    "phonetic",
    "partOfSpeech",
    "meaning",
    "context",
    "note"
  ];
  const RESERVED_FIELDS = new Set([
    "mastered",
    "reviewCount",
    "dueAt",
    "interval",
    "proficiency",
    "reviewInterval",
    "nextReviewAt",
    "dictionaryFound",
    "dictionaryVersion",
    "lemma",
    "syncStatus",
    "remoteId",
    "serverRevision",
    "deviceId",
    "dirty",
    "lastSyncedAt",
    "vectorClock",
    "normalizedKey",
    "searchIndex"
  ]);
  const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  function createError(code, path, details = {}) {
    return {
      code,
      path,
      ...(Number.isInteger(details.index) ? { index: details.index } : {}),
      ...(details.favoriteId ? { favoriteId: details.favoriteId } : {}),
      ...(details.conflictingFavoriteId
        ? { conflictingFavoriteId: details.conflictingFavoriteId }
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

  function getJsonProperties(value, path) {
    const properties = [];
    let arrayIndexCount = 0;

    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === "length") continue;
      if (typeof key === "symbol") {
        return { properties: [], error: createError("invalid-json-value", path) };
      }
      if (Array.isArray(value) && !isArrayIndexKey(key)) {
        return { properties: [], error: createError("invalid-json-value", path) };
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor ||
          !descriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        const propertyPath = Array.isArray(value)
          ? `${path}[${key}]`
          : path === "$" ? key : `${path}.${key}`;
        return {
          properties: [],
          error: createError("invalid-json-value", propertyPath)
        };
      }

      properties.push({ key, value: descriptor.value });
      if (Array.isArray(value)) arrayIndexCount += 1;
    }

    if (Array.isArray(value) && arrayIndexCount !== value.length) {
      return { properties: [], error: createError("invalid-json-value", path) };
    }
    return { properties, error: null };
  }

  function findJsonError(value, path = "$", ancestors = new WeakSet()) {
    if (value === null) return null;
    if (typeof value === "string" || typeof value === "boolean") return null;
    if (typeof value === "number") {
      return Number.isFinite(value) ? null : createError("invalid-json-value", path);
    }
    if (typeof value !== "object") return createError("invalid-json-value", path);
    if (!Array.isArray(value) && !isPlainObject(value)) {
      return createError("invalid-json-value", path);
    }
    if (ancestors.has(value)) return createError("invalid-json-value", path);

    ancestors.add(value);
    const result = getJsonProperties(value, path);
    if (result.error) {
      ancestors.delete(value);
      return result.error;
    }

    for (const property of result.properties) {
      const childPath = Array.isArray(value)
        ? `${path}[${property.key}]`
        : path === "$" ? property.key : `${path}.${property.key}`;
      const error = findJsonError(property.value, childPath, ancestors);
      if (error) {
        ancestors.delete(value);
        return error;
      }
    }
    ancestors.delete(value);
    return null;
  }

  function hasOwnDataProperty(value, key) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor) &&
      descriptor.enumerable &&
      Object.prototype.hasOwnProperty.call(descriptor, "value");
  }

  function getOwnDataValue(value, key) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
      ? descriptor.value
      : undefined;
  }

  function isCanonicalTimestamp(value, nullable = false) {
    if (nullable && value === null) return true;
    if (typeof value !== "string" || !CANONICAL_TIMESTAMP.test(value)) return false;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  }

  function getFavoriteId(favorite) {
    try {
      if (!isPlainObject(favorite) || !hasOwnDataProperty(favorite, "id")) return null;
      const id = getOwnDataValue(favorite, "id");
      return typeof id === "string" && id.trim() && id === id.trim() ? id : null;
    } catch (error) {
      return null;
    }
  }

  function addMissingFieldErrors(favorite, errors) {
    for (const field of REQUIRED_FIELDS) {
      if (!hasOwnDataProperty(favorite, field)) {
        errors.push(createError("missing-field", field));
      }
    }
  }

  function validateKnownFields(favorite, errors) {
    if (hasOwnDataProperty(favorite, "id")) {
      const id = getOwnDataValue(favorite, "id");
      if (typeof id !== "string" || !id.trim() || id !== id.trim()) {
        errors.push(createError("invalid-id", "id"));
      }
    }

    if (hasOwnDataProperty(favorite, "type") &&
        !FAVORITE_TYPES.has(getOwnDataValue(favorite, "type"))) {
      errors.push(createError("invalid-type", "type"));
    }

    if (hasOwnDataProperty(favorite, "text")) {
      const text = getOwnDataValue(favorite, "text");
      if (typeof text !== "string" || !text.trim()) {
        errors.push(createError("invalid-text", "text"));
      }
    }

    for (const field of OPTIONAL_TEXT_FIELDS) {
      if (hasOwnDataProperty(favorite, field) &&
          typeof getOwnDataValue(favorite, field) !== "string") {
        errors.push(createError("invalid-field", field));
      }
    }

    if (hasOwnDataProperty(favorite, "tags")) {
      const tags = getOwnDataValue(favorite, "tags");
      let validTags = Array.isArray(tags);
      if (validTags) {
        const tagProperties = getJsonProperties(tags, "tags");
        validTags = !tagProperties.error;
        for (const property of tagProperties.properties) {
          if (typeof property.value !== "string") validTags = false;
        }
      }
      if (!validTags) {
        errors.push(createError("invalid-tags", "tags"));
      }
    }

    if (hasOwnDataProperty(favorite, "origin")) {
      const origin = getOwnDataValue(favorite, "origin");
      if (origin !== null && !isPlainObject(origin)) {
        errors.push(createError("invalid-origin", "origin"));
      } else if (origin !== null) {
        if (hasOwnDataProperty(origin, "kind")) {
          const kind = getOwnDataValue(origin, "kind");
          if (typeof kind !== "string" || !kind.trim()) {
            errors.push(createError("invalid-origin", "origin.kind"));
          }
        }
        if (hasOwnDataProperty(origin, "articleId")) {
          const articleId = getOwnDataValue(origin, "articleId");
          if (typeof articleId !== "string" ||
              !articleId.trim() ||
              articleId !== articleId.trim()) {
            errors.push(createError("invalid-origin", "origin.articleId"));
          }
        }
        if (hasOwnDataProperty(origin, "articleTitleSnapshot") &&
            typeof getOwnDataValue(origin, "articleTitleSnapshot") !== "string") {
          errors.push(createError("invalid-origin", "origin.articleTitleSnapshot"));
        }
      }
    }

    for (const field of ["createdAt", "updatedAt"]) {
      if (hasOwnDataProperty(favorite, field) &&
          !isCanonicalTimestamp(getOwnDataValue(favorite, field))) {
        errors.push(createError("invalid-timestamp", field));
      }
    }
    if (hasOwnDataProperty(favorite, "deletedAt") &&
        !isCanonicalTimestamp(getOwnDataValue(favorite, "deletedAt"), true)) {
      errors.push(createError("invalid-timestamp", "deletedAt"));
    }

    const createdAt = getOwnDataValue(favorite, "createdAt");
    const updatedAt = getOwnDataValue(favorite, "updatedAt");
    const deletedAt = getOwnDataValue(favorite, "deletedAt");
    if (isCanonicalTimestamp(createdAt) && isCanonicalTimestamp(updatedAt) &&
        Date.parse(createdAt) > Date.parse(updatedAt)) {
      errors.push(createError("invalid-lifecycle", "updatedAt"));
    }
    if (isCanonicalTimestamp(createdAt) && isCanonicalTimestamp(updatedAt) &&
        isCanonicalTimestamp(deletedAt, true) && deletedAt !== null &&
        (Date.parse(deletedAt) < Date.parse(createdAt) ||
          Date.parse(deletedAt) > Date.parse(updatedAt))) {
      errors.push(createError("invalid-lifecycle", "deletedAt"));
    }
  }

  function addReservedFieldErrors(value, path, errors) {
    if (!Array.isArray(value) && !isPlainObject(value)) return;
    const properties = getJsonProperties(value, path);
    if (properties.error) return;

    for (const property of properties.properties) {
      const childPath = Array.isArray(value)
        ? `${path}[${property.key}]`
        : path === "$" ? property.key : `${path}.${property.key}`;
      if (RESERVED_FIELDS.has(property.key)) {
        errors.push(createError("reserved-field", childPath));
      }
      addReservedFieldErrors(property.value, childPath, errors);
    }
  }

  function rejectedFavorite(favorite, errors) {
    return {
      status: "rejected",
      favoriteId: getFavoriteId(favorite),
      favorite: null,
      errors
    };
  }

  function validateFavorite(favorite) {
    try {
      if (!isPlainObject(favorite)) {
        return rejectedFavorite(favorite, [createError("invalid-favorite", "$")]);
      }

      const jsonError = findJsonError(favorite);
      if (jsonError) return rejectedFavorite(favorite, [jsonError]);

      const errors = [];
      addMissingFieldErrors(favorite, errors);
      validateKnownFields(favorite, errors);
      addReservedFieldErrors(favorite, "$", errors);
      if (errors.length) return rejectedFavorite(favorite, errors);

      return {
        status: "valid",
        favoriteId: favorite.id,
        favorite,
        errors: []
      };
    } catch (error) {
      return rejectedFavorite(favorite, [createError("invalid-favorite", "$")]);
    }
  }

  function withBatchContext(error, index, favoriteId) {
    return {
      ...error,
      index,
      ...(favoriteId ? { favoriteId } : {})
    };
  }

  function invalidCollection(error) {
    return {
      status: "rejected",
      summary: { total: 0, valid: 0, rejected: 0 },
      favorites: [],
      items: [],
      errors: [error]
    };
  }

  function validateFavorites(favorites) {
    if (!Array.isArray(favorites)) {
      return invalidCollection(createError("invalid-favorites", "$"));
    }

    const arrayProperties = getJsonProperties(favorites, "$");
    if (arrayProperties.error) return invalidCollection(arrayProperties.error);

    const values = new Array(favorites.length);
    for (const property of arrayProperties.properties) {
      values[Number(property.key)] = property.value;
    }

    const items = values.map((favorite, index) => {
      const result = validateFavorite(favorite);
      return {
        index,
        status: result.status,
        favoriteId: result.favoriteId,
        errors: result.errors.slice()
      };
    });
    const ids = new Map();

    for (const item of items) {
      if (!item.favoriteId) continue;
      if (ids.has(item.favoriteId)) {
        item.errors.push(createError("duplicate-favorite-id", "id", {
          favoriteId: item.favoriteId,
          conflictingFavoriteId: item.favoriteId
        }));
      } else {
        ids.set(item.favoriteId, item.index);
      }
    }

    const errors = [];
    for (const item of items) {
      if (item.errors.length) item.status = "rejected";
      for (const error of item.errors) {
        errors.push(withBatchContext(error, item.index, item.favoriteId));
      }
    }

    const rejected = items.filter(item => item.status === "rejected").length;
    const status = rejected ? "rejected" : "valid";
    return {
      status,
      summary: {
        total: values.length,
        valid: values.length - rejected,
        rejected
      },
      favorites: status === "valid" ? values : [],
      items,
      errors
    };
  }

  window.LingoFlowFavoriteBackupSchema = Object.freeze({
    validateFavorite,
    validateFavorites
  });
})();
