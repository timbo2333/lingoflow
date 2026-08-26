(function() {
  "use strict";

  const REQUIRED_FIELDS = ["id", "createdAt", "deviceId", "records"];
  const RECORD_REQUIRED_FIELDS = ["word", "count"];
  const OPTIONAL_TEXT_FIELDS = [
    "displayWord",
    "phonetic",
    "pos",
    "meaning"
  ];
  const RESERVED_FIELDS = new Set([
    "updatedAt",
    "deletedAt",
    "tombstone",
    "queryEvents",
    "queryEventIds",
    "vocab",
    "vocabCache",
    "normalizedKey",
    "searchIndex",
    "migrationState",
    "migrationCompleted",
    "migrationVersion",
    "syncStatus",
    "remoteId",
    "serverRevision",
    "dirty",
    "lastSyncedAt",
    "vectorClock",
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
      ...(details.baselineId ? { baselineId: details.baselineId } : {}),
      ...(details.conflictingBaselineId
        ? { conflictingBaselineId: details.conflictingBaselineId }
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

  function appendPropertyPath(path, key) {
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
      return path === "$" ? key : `${path}.${key}`;
    }
    return `${path}[${JSON.stringify(key)}]`;
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
          : appendPropertyPath(path, key);
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
    if (ancestors.has(value)) return createError("invalid-json-value", path);

    ancestors.add(value);
    const inspection = inspectJsonProperties(value, path);
    if (inspection.error) {
      ancestors.delete(value);
      return inspection.error;
    }

    for (const property of inspection.properties) {
      const childPath = Array.isArray(value)
        ? `${path}[${property.key}]`
        : appendPropertyPath(path, property.key);
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

    const inspection = inspectJsonProperties(value, "$");
    if (inspection.error) {
      throw new Error("Cannot clone a value that is not JSON-safe.");
    }

    if (Array.isArray(value)) {
      const clone = new Array(value.length);
      for (const property of inspection.properties) {
        Object.defineProperty(clone, property.key, {
          value: cloneJsonValue(property.value),
          enumerable: true,
          configurable: true,
          writable: true
        });
      }
      return clone;
    }

    const clone = {};
    for (const property of inspection.properties) {
      Object.defineProperty(clone, property.key, {
        value: cloneJsonValue(property.value),
        enumerable: true,
        configurable: true,
        writable: true
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

  function isCanonicalTimestamp(value) {
    if (typeof value !== "string" || !CANONICAL_TIMESTAMP.test(value)) return false;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  }

  function isNonEmptyUnpaddedString(value) {
    return typeof value === "string" && Boolean(value.trim()) && value === value.trim();
  }

  function isPositiveSafeInteger(value) {
    return Number.isSafeInteger(value) && value > 0;
  }

  function isNonNegativeSafeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function getBaselineId(baseline) {
    try {
      if (!isPlainObject(baseline) || !hasOwnDataProperty(baseline, "id")) {
        return null;
      }
      const id = getOwnDataValue(baseline, "id");
      return isNonEmptyUnpaddedString(id) ? id : null;
    } catch (error) {
      return null;
    }
  }

  function addMissingFieldErrors(value, fields, path, errors) {
    for (const field of fields) {
      if (!hasOwnDataProperty(value, field)) {
        errors.push(createError("missing-field", appendPropertyPath(path, field)));
      }
    }
  }

  function validateRecord(record, path, errors) {
    if (!isPlainObject(record)) {
      errors.push(createError("invalid-record", path));
      return;
    }

    addMissingFieldErrors(record, RECORD_REQUIRED_FIELDS, path, errors);

    if (hasOwnDataProperty(record, "word") &&
        !isNonEmptyUnpaddedString(getOwnDataValue(record, "word"))) {
      errors.push(createError("invalid-word", appendPropertyPath(path, "word")));
    }

    const count = getOwnDataValue(record, "count");
    const countValid = hasOwnDataProperty(record, "count") &&
      isPositiveSafeInteger(count);
    if (hasOwnDataProperty(record, "count") && !countValid) {
      errors.push(createError("invalid-count", appendPropertyPath(path, "count")));
    }

    const articleCount = getOwnDataValue(record, "articleCount");
    const articleCountPresent = hasOwnDataProperty(record, "articleCount");
    const articleCountValid = articleCountPresent &&
      isNonNegativeSafeInteger(articleCount);
    if (articleCountPresent && !articleCountValid) {
      errors.push(createError(
        "invalid-article-count",
        appendPropertyPath(path, "articleCount")
      ));
    }

    const searchCount = getOwnDataValue(record, "searchCount");
    const searchCountPresent = hasOwnDataProperty(record, "searchCount");
    const searchCountValid = searchCountPresent &&
      isNonNegativeSafeInteger(searchCount);
    if (searchCountPresent && !searchCountValid) {
      errors.push(createError(
        "invalid-search-count",
        appendPropertyPath(path, "searchCount")
      ));
    }

    if (countValid && articleCountValid && articleCount > count) {
      errors.push(createError(
        "invalid-record-counts",
        appendPropertyPath(path, "articleCount")
      ));
    }
    if (countValid && searchCountValid && searchCount > count) {
      errors.push(createError(
        "invalid-record-counts",
        appendPropertyPath(path, "searchCount")
      ));
    }
    if (countValid && articleCountValid && searchCountValid &&
        articleCount + searchCount > count) {
      errors.push(createError("invalid-record-counts", path));
    }

    const firstSeen = getOwnDataValue(record, "firstSeen");
    const firstSeenPresent = hasOwnDataProperty(record, "firstSeen");
    const firstSeenValid = firstSeenPresent && isCanonicalTimestamp(firstSeen);
    if (firstSeenPresent && !firstSeenValid) {
      errors.push(createError(
        "invalid-timestamp",
        appendPropertyPath(path, "firstSeen")
      ));
    }

    const lastSeen = getOwnDataValue(record, "lastSeen");
    const lastSeenPresent = hasOwnDataProperty(record, "lastSeen");
    const lastSeenValid = lastSeenPresent && isCanonicalTimestamp(lastSeen);
    if (lastSeenPresent && !lastSeenValid) {
      errors.push(createError(
        "invalid-timestamp",
        appendPropertyPath(path, "lastSeen")
      ));
    }
    if (firstSeenValid && lastSeenValid && Date.parse(firstSeen) > Date.parse(lastSeen)) {
      errors.push(createError(
        "invalid-record-time-order",
        appendPropertyPath(path, "lastSeen")
      ));
    }

    for (const field of OPTIONAL_TEXT_FIELDS) {
      if (hasOwnDataProperty(record, field) &&
          typeof getOwnDataValue(record, field) !== "string") {
        errors.push(createError("invalid-field", appendPropertyPath(path, field)));
      }
    }

    if (hasOwnDataProperty(record, "dictionaryFound") &&
        typeof getOwnDataValue(record, "dictionaryFound") !== "boolean") {
      errors.push(createError(
        "invalid-dictionary-found",
        appendPropertyPath(path, "dictionaryFound")
      ));
    }

    if (hasOwnDataProperty(record, "source") &&
        !isNonEmptyUnpaddedString(getOwnDataValue(record, "source"))) {
      errors.push(createError("invalid-source", appendPropertyPath(path, "source")));
    }
  }

  function validateRecords(records, errors) {
    if (!isPlainObject(records)) return;
    const inspection = inspectJsonProperties(records, "records");
    if (inspection.error) return;

    for (const property of inspection.properties) {
      const locator = property.key;
      const recordPath = appendPropertyPath("records", locator);
      if (!isNonEmptyUnpaddedString(locator)) {
        errors.push(createError("invalid-record-locator", recordPath));
      }
      validateRecord(property.value, recordPath, errors);
    }
  }

  function validateKnownFields(baseline, errors) {
    if (hasOwnDataProperty(baseline, "id") &&
        !isNonEmptyUnpaddedString(getOwnDataValue(baseline, "id"))) {
      errors.push(createError("invalid-id", "id"));
    }

    if (hasOwnDataProperty(baseline, "createdAt") &&
        !isCanonicalTimestamp(getOwnDataValue(baseline, "createdAt"))) {
      errors.push(createError("invalid-timestamp", "createdAt"));
    }

    if (hasOwnDataProperty(baseline, "deviceId") &&
        !isNonEmptyUnpaddedString(getOwnDataValue(baseline, "deviceId"))) {
      errors.push(createError("invalid-device-id", "deviceId"));
    }

    if (hasOwnDataProperty(baseline, "records")) {
      const records = getOwnDataValue(baseline, "records");
      if (!isPlainObject(records)) {
        errors.push(createError("invalid-records", "records"));
      } else {
        validateRecords(records, errors);
      }
    }
  }

  function addReservedFieldErrors(value, path, errors) {
    if (!Array.isArray(value) && !isPlainObject(value)) return;
    const inspection = inspectJsonProperties(value, path);
    if (inspection.error) return;

    for (const property of inspection.properties) {
      const childPath = Array.isArray(value)
        ? `${path}[${property.key}]`
        : appendPropertyPath(path, property.key);
      if (RESERVED_FIELDS.has(property.key)) {
        errors.push(createError("reserved-field", childPath));
      }
      addReservedFieldErrors(property.value, childPath, errors);
    }
  }

  function addBaselineReservedFieldErrors(baseline, errors) {
    const inspection = inspectJsonProperties(baseline, "$");
    if (inspection.error) return;

    for (const property of inspection.properties) {
      const childPath = appendPropertyPath("$", property.key);
      if (RESERVED_FIELDS.has(property.key)) {
        errors.push(createError("reserved-field", childPath));
      }

      if (property.key !== "records" || !isPlainObject(property.value)) {
        addReservedFieldErrors(property.value, childPath, errors);
        continue;
      }

      const records = inspectJsonProperties(property.value, "records");
      if (records.error) continue;
      for (const record of records.properties) {
        addReservedFieldErrors(
          record.value,
          appendPropertyPath("records", record.key),
          errors
        );
      }
    }
  }

  function rejectedBaseline(baseline, errors) {
    return {
      status: "rejected",
      baselineId: getBaselineId(baseline),
      historyBaseline: null,
      errors
    };
  }

  function validateHistoryBaseline(baseline) {
    try {
      if (!isPlainObject(baseline)) {
        return rejectedBaseline(baseline, [createError("invalid-baseline", "$")]);
      }

      const jsonError = findJsonError(baseline);
      if (jsonError) return rejectedBaseline(baseline, [jsonError]);

      const errors = [];
      addMissingFieldErrors(baseline, REQUIRED_FIELDS, "$", errors);
      validateKnownFields(baseline, errors);
      addBaselineReservedFieldErrors(baseline, errors);
      if (errors.length) return rejectedBaseline(baseline, errors);

      return {
        status: "valid",
        baselineId: baseline.id,
        historyBaseline: cloneJsonValue(baseline),
        errors: []
      };
    } catch (error) {
      return rejectedBaseline(baseline, [createError("invalid-baseline", "$")]);
    }
  }

  function withBatchContext(error, index, baselineId) {
    return {
      ...error,
      index,
      ...(baselineId ? { baselineId } : {})
    };
  }

  function rejectedCollection(error) {
    return {
      status: "rejected",
      summary: { total: 0, valid: 0, rejected: 0 },
      historyBaselines: [],
      items: [],
      errors: [error]
    };
  }

  function validateHistoryBaselines(baselines) {
    if (!Array.isArray(baselines)) {
      return rejectedCollection(createError("invalid-history-baselines", "$"));
    }

    const collection = inspectJsonProperties(baselines, "$");
    if (collection.error) return rejectedCollection(collection.error);

    const values = new Array(baselines.length);
    for (const property of collection.properties) {
      values[Number(property.key)] = property.value;
    }

    const snapshots = new Array(values.length);
    const items = values.map((baseline, index) => {
      const result = validateHistoryBaseline(baseline);
      snapshots[index] = result.historyBaseline;
      return {
        index,
        status: result.status,
        baselineId: result.baselineId,
        errors: result.errors.slice()
      };
    });
    const ids = new Map();

    for (const item of items) {
      if (!item.baselineId) continue;
      if (ids.has(item.baselineId)) {
        item.errors.push(createError("duplicate-baseline-id", "id", {
          baselineId: item.baselineId,
          conflictingBaselineId: item.baselineId
        }));
      } else {
        ids.set(item.baselineId, item.index);
      }
    }

    const errors = [];
    for (const item of items) {
      if (item.errors.length) item.status = "rejected";
      for (const error of item.errors) {
        errors.push(withBatchContext(error, item.index, item.baselineId));
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
      historyBaselines: status === "valid" ? snapshots : [],
      items,
      errors
    };
  }

  window.LingoFlowHistoryBaselineBackupSchema = Object.freeze({
    validateHistoryBaseline,
    validateHistoryBaselines
  });
})();
