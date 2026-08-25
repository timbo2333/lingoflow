(function() {
  "use strict";

  const REQUIRED_FIELDS = [
    "favoriteId",
    "mastered",
    "createdAt",
    "updatedAt",
    "deletedAt"
  ];
  const REQUIRED_FIELD_SET = new Set(REQUIRED_FIELDS);
  const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  function createError(code, path, details = {}) {
    return {
      code,
      path,
      ...(Number.isInteger(details.index) ? { index: details.index } : {}),
      ...(details.favoriteId ? { favoriteId: details.favoriteId } : {})
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

  function inspectJsonProperties(value, path) {
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
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return null;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? null : createError("invalid-json-value", path);
    }
    if (!value || typeof value !== "object") {
      return createError("invalid-json-value", path);
    }
    if (!Array.isArray(value) && !isPlainObject(value)) {
      return createError("invalid-json-value", path);
    }
    if (ancestors.has(value)) {
      return createError("invalid-json-value", path);
    }

    ancestors.add(value);
    const inspection = inspectJsonProperties(value, path);
    if (inspection.error) {
      ancestors.delete(value);
      return inspection.error;
    }

    for (const property of inspection.properties) {
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

  function getOwnDataValue(value, key) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
      ? descriptor.value
      : undefined;
  }

  function getFavoriteId(state) {
    try {
      if (!isPlainObject(state)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(state, "favoriteId");
      if (!descriptor ||
          !descriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        return null;
      }
      return typeof descriptor.value === "string" &&
        descriptor.value.trim() &&
        descriptor.value === descriptor.value.trim()
        ? descriptor.value
        : null;
    } catch (error) {
      return null;
    }
  }

  function isValidTimestamp(value, nullable = false) {
    if (nullable && value === null) return true;
    if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  }

  function validateFieldStructure(state, errors) {
    const keys = Object.keys(state);
    for (const field of REQUIRED_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(state, field)) {
        errors.push(createError("missing-field", field));
      }
    }
    for (const key of keys) {
      if (!REQUIRED_FIELD_SET.has(key)) {
        errors.push(createError("unknown-field", key));
      }
    }
  }

  function validateKnownFields(state, errors) {
    if (Object.prototype.hasOwnProperty.call(state, "favoriteId")) {
      const favoriteId = getOwnDataValue(state, "favoriteId");
      if (typeof favoriteId !== "string" ||
          !favoriteId.trim() ||
          favoriteId !== favoriteId.trim()) {
        errors.push(createError("invalid-favorite-id", "favoriteId"));
      }
    }

    if (Object.prototype.hasOwnProperty.call(state, "mastered") &&
        typeof getOwnDataValue(state, "mastered") !== "boolean") {
      errors.push(createError("invalid-mastered", "mastered"));
    }

    const timestampValidity = Object.create(null);
    for (const field of ["createdAt", "updatedAt", "deletedAt"]) {
      if (!Object.prototype.hasOwnProperty.call(state, field)) continue;
      const valid = isValidTimestamp(
        getOwnDataValue(state, field),
        field === "deletedAt"
      );
      timestampValidity[field] = valid;
      if (!valid) errors.push(createError("invalid-timestamp", field));
    }

    if (!timestampValidity.createdAt ||
        !timestampValidity.updatedAt ||
        !timestampValidity.deletedAt) {
      return;
    }

    const createdAt = Date.parse(getOwnDataValue(state, "createdAt"));
    const updatedAt = Date.parse(getOwnDataValue(state, "updatedAt"));
    const deletedValue = getOwnDataValue(state, "deletedAt");
    const deletedAt = deletedValue === null ? null : Date.parse(deletedValue);
    if (createdAt > updatedAt ||
        (deletedAt !== null && (deletedAt < createdAt || deletedAt > updatedAt))) {
      errors.push(createError("invalid-lifecycle", "$"));
    }
  }

  function rejectedState(state, errors) {
    return {
      status: "rejected",
      favoriteId: getFavoriteId(state),
      favoriteLearningState: null,
      errors
    };
  }

  function validateFavoriteLearningState(state) {
    try {
      if (!isPlainObject(state)) {
        return rejectedState(state, [createError("invalid-state", "$")]);
      }

      const jsonError = findJsonError(state);
      if (jsonError) return rejectedState(state, [jsonError]);

      const errors = [];
      validateFieldStructure(state, errors);
      validateKnownFields(state, errors);
      if (errors.length) return rejectedState(state, errors);

      return {
        status: "valid",
        favoriteId: state.favoriteId,
        favoriteLearningState: state,
        errors: []
      };
    } catch (error) {
      return rejectedState(state, [createError("invalid-state", "$")]);
    }
  }

  function withBatchContext(error, index, favoriteId) {
    return {
      ...error,
      index,
      ...(favoriteId ? { favoriteId } : {})
    };
  }

  function rejectedCollection(error) {
    return {
      status: "rejected",
      summary: { total: 0, valid: 0, rejected: 0 },
      favoriteLearningStates: [],
      items: [],
      errors: [error]
    };
  }

  function validateFavoriteLearningStates(states) {
    if (!Array.isArray(states)) {
      return rejectedCollection(createError("invalid-states", "$"));
    }

    const collectionShape = inspectJsonProperties(states, "$");
    if (collectionShape.error) {
      return rejectedCollection(collectionShape.error);
    }

    const items = states.map((state, index) => {
      const result = validateFavoriteLearningState(state);
      return {
        index,
        status: result.status,
        favoriteId: result.favoriteId,
        errors: result.errors.slice()
      };
    });
    const favoriteIds = new Map();

    for (const item of items) {
      if (!item.favoriteId) continue;
      if (favoriteIds.has(item.favoriteId)) {
        item.errors.push(createError("duplicate-favorite-id", "favoriteId", {
          favoriteId: item.favoriteId
        }));
      } else {
        favoriteIds.set(item.favoriteId, item.index);
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
        total: states.length,
        valid: states.length - rejected,
        rejected
      },
      favoriteLearningStates: status === "valid" ? states.slice() : [],
      items,
      errors
    };
  }

  window.LingoFlowFavoriteLearningBackupSchema = Object.freeze({
    validateFavoriteLearningState,
    validateFavoriteLearningStates
  });
})();
