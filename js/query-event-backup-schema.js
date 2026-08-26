(function() {
  "use strict";

  const REQUIRED_FIELDS = [
    "id",
    "deviceId",
    "word",
    "displayWord",
    "phonetic",
    "pos",
    "meaning",
    "dictionaryFound",
    "source",
    "timestamp"
  ];
  const SNAPSHOT_STRING_FIELDS = ["phonetic", "pos", "meaning"];
  const SOURCES = new Set(["article", "search"]);
  const RESERVED_FIELDS = new Set([
    "count",
    "articleCount",
    "searchCount",
    "firstSeen",
    "lastSeen",
    "vocab",
    "vocabCache",
    "createdAt",
    "updatedAt",
    "deletedAt",
    "tombstone",
    "migrationState",
    "migrationCompleted",
    "migrationVersion",
    "syncStatus",
    "remoteId",
    "serverRevision",
    "dirty",
    "lastSyncedAt",
    "vectorClock",
    "normalizedKey",
    "searchIndex",
    "dictionaryResource",
    "dictionaryEntries",
    "dictionaryData",
    "lemmaResource",
    "lemmaMappings",
    "lemmaData"
  ]);
  const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  function createError(code, path, details = {}) {
    return {
      code,
      path,
      ...(Number.isInteger(details.index) ? { index: details.index } : {}),
      ...(details.queryEventId ? { queryEventId: details.queryEventId } : {}),
      ...(details.conflictingQueryEventId
        ? { conflictingQueryEventId: details.conflictingQueryEventId }
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

  function cloneJsonValue(value) {
    if (value === null || typeof value !== "object") return value;

    const inspection = inspectJsonProperties(value, "$clone");
    if (inspection.error) throw new Error("Cannot clone an invalid JSON value.");

    if (Array.isArray(value)) {
      const clone = new Array(value.length);
      for (const property of inspection.properties) {
        clone[Number(property.key)] = cloneJsonValue(property.value);
      }
      return clone;
    }

    if (!isPlainObject(value)) {
      throw new Error("Cannot clone a non-plain JSON object.");
    }
    const clone = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
    for (const property of inspection.properties) {
      Object.defineProperty(clone, property.key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cloneJsonValue(property.value)
      });
    }
    return clone;
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

  function isNonEmptyUnpaddedString(value) {
    return typeof value === "string" && Boolean(value.trim()) && value === value.trim();
  }

  function isValidWord(value) {
    return typeof value === "string" &&
      (value === "" || (Boolean(value.trim()) && value === value.trim()));
  }

  function isCanonicalTimestamp(value) {
    if (typeof value !== "string" || !CANONICAL_TIMESTAMP.test(value)) return false;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  }

  function getQueryEventId(queryEvent) {
    try {
      if (!isPlainObject(queryEvent) || !hasOwnDataProperty(queryEvent, "id")) {
        return null;
      }
      const id = getOwnDataValue(queryEvent, "id");
      return isNonEmptyUnpaddedString(id) ? id : null;
    } catch (error) {
      return null;
    }
  }

  function addMissingFieldErrors(queryEvent, errors) {
    for (const field of REQUIRED_FIELDS) {
      if (!hasOwnDataProperty(queryEvent, field)) {
        errors.push(createError("missing-field", field));
      }
    }
  }

  function validateKnownFields(queryEvent, errors) {
    if (hasOwnDataProperty(queryEvent, "id") &&
        !isNonEmptyUnpaddedString(getOwnDataValue(queryEvent, "id"))) {
      errors.push(createError("invalid-id", "id"));
    }

    if (hasOwnDataProperty(queryEvent, "deviceId") &&
        !isNonEmptyUnpaddedString(getOwnDataValue(queryEvent, "deviceId"))) {
      errors.push(createError("invalid-device-id", "deviceId"));
    }

    if (hasOwnDataProperty(queryEvent, "word") &&
        !isValidWord(getOwnDataValue(queryEvent, "word"))) {
      errors.push(createError("invalid-word", "word"));
    }

    if (hasOwnDataProperty(queryEvent, "displayWord") &&
        !isNonEmptyUnpaddedString(getOwnDataValue(queryEvent, "displayWord"))) {
      errors.push(createError("invalid-display-word", "displayWord"));
    }

    for (const field of SNAPSHOT_STRING_FIELDS) {
      if (hasOwnDataProperty(queryEvent, field) &&
          typeof getOwnDataValue(queryEvent, field) !== "string") {
        errors.push(createError("invalid-field", field));
      }
    }

    if (hasOwnDataProperty(queryEvent, "dictionaryFound") &&
        typeof getOwnDataValue(queryEvent, "dictionaryFound") !== "boolean") {
      errors.push(createError("invalid-dictionary-found", "dictionaryFound"));
    }

    if (hasOwnDataProperty(queryEvent, "source") &&
        !SOURCES.has(getOwnDataValue(queryEvent, "source"))) {
      errors.push(createError("invalid-source", "source"));
    }

    if (hasOwnDataProperty(queryEvent, "timestamp") &&
        !isCanonicalTimestamp(getOwnDataValue(queryEvent, "timestamp"))) {
      errors.push(createError("invalid-timestamp", "timestamp"));
    }
  }

  function addReservedFieldErrors(value, path, errors) {
    if (!Array.isArray(value) && !isPlainObject(value)) return;
    const inspection = inspectJsonProperties(value, path);
    if (inspection.error) return;

    for (const property of inspection.properties) {
      const childPath = Array.isArray(value)
        ? `${path}[${property.key}]`
        : path === "$" ? property.key : `${path}.${property.key}`;
      if (RESERVED_FIELDS.has(property.key)) {
        errors.push(createError("reserved-field", childPath));
      }
      addReservedFieldErrors(property.value, childPath, errors);
    }
  }

  function rejectedQueryEvent(queryEvent, errors) {
    return {
      status: "rejected",
      queryEventId: getQueryEventId(queryEvent),
      queryEvent: null,
      errors
    };
  }

  function validateQueryEvent(queryEvent) {
    try {
      if (!isPlainObject(queryEvent)) {
        return rejectedQueryEvent(queryEvent, [
          createError("invalid-query-event", "$")
        ]);
      }

      const jsonError = findJsonError(queryEvent);
      if (jsonError) return rejectedQueryEvent(queryEvent, [jsonError]);

      const errors = [];
      addMissingFieldErrors(queryEvent, errors);
      validateKnownFields(queryEvent, errors);
      addReservedFieldErrors(queryEvent, "$", errors);
      if (errors.length) return rejectedQueryEvent(queryEvent, errors);

      const snapshot = cloneJsonValue(queryEvent);

      return {
        status: "valid",
        queryEventId: snapshot.id,
        queryEvent: snapshot,
        errors: []
      };
    } catch (error) {
      return rejectedQueryEvent(queryEvent, [
        createError("invalid-query-event", "$")
      ]);
    }
  }

  function withBatchContext(error, index, queryEventId) {
    return {
      ...error,
      index,
      ...(queryEventId ? { queryEventId } : {})
    };
  }

  function rejectedCollection(error) {
    return {
      status: "rejected",
      summary: { total: 0, valid: 0, rejected: 0 },
      queryEvents: [],
      items: [],
      errors: [error]
    };
  }

  function validateQueryEvents(queryEvents) {
    if (!Array.isArray(queryEvents)) {
      return rejectedCollection(createError("invalid-query-events", "$"));
    }

    const collectionShape = inspectJsonProperties(queryEvents, "$");
    if (collectionShape.error) return rejectedCollection(collectionShape.error);

    const values = new Array(queryEvents.length);
    for (const property of collectionShape.properties) {
      values[Number(property.key)] = property.value;
    }

    const snapshots = new Array(values.length);
    const items = values.map((queryEvent, index) => {
      const result = validateQueryEvent(queryEvent);
      snapshots[index] = result.queryEvent;
      return {
        index,
        status: result.status,
        queryEventId: result.queryEventId,
        errors: result.errors.slice()
      };
    });
    const ids = new Map();

    for (const item of items) {
      if (!item.queryEventId) continue;
      if (ids.has(item.queryEventId)) {
        item.errors.push(createError("duplicate-query-event-id", "id", {
          queryEventId: item.queryEventId,
          conflictingQueryEventId: item.queryEventId
        }));
      } else {
        ids.set(item.queryEventId, item.index);
      }
    }

    const errors = [];
    for (const item of items) {
      if (item.errors.length) item.status = "rejected";
      for (const error of item.errors) {
        errors.push(withBatchContext(error, item.index, item.queryEventId));
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
      queryEvents: status === "valid" ? snapshots : [],
      items,
      errors
    };
  }

  window.LingoFlowQueryEventBackupSchema = Object.freeze({
    validateQueryEvent,
    validateQueryEvents
  });
})();
