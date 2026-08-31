(function() {
  "use strict";

  const STORAGE_KEY = "EnglishReaderV052ReadingPrefs";
  const KEY_ERROR_CODES = new Set(["invalid-key", "reserved-key"]);

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function createRepositoryError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
  }

  function getSchema() {
    const schema = window.LingoFlowPreferencesBackupSchema;
    if (!schema ||
        typeof schema.validatePreference !== "function" ||
        typeof schema.validatePreferences !== "function") {
      throw createRepositoryError(
        "preferences-schema-unavailable",
        "Preferences Schema Validator 不可用。"
      );
    }
    return schema;
  }

  function defineDataProperty(target, key, value) {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value
    });
  }

  function getOwnDataValue(value, key) {
    try {
      if (!isPlainObject(value)) return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor &&
        descriptor.enumerable &&
        Object.prototype.hasOwnProperty.call(descriptor, "value")
        ? descriptor.value
        : undefined;
    } catch {
      return undefined;
    }
  }

  function getCandidateKey(value) {
    const key = getOwnDataValue(value, "key");
    return typeof key === "string" ? key : null;
  }

  function publicError(error, fallbackCode) {
    return {
      code: error?.code || fallbackCode,
      ...(error?.message ? { message: error.message } : {})
    };
  }

  function validateAndSnapshotPreference(value) {
    const validation = getSchema().validatePreference(value);
    if (validation.status !== "valid") {
      throw createRepositoryError(
        "invalid-preference",
        "Preference 不符合 Backup Schema。",
        { errors: validation.errors || [] }
      );
    }
    return validation.preference;
  }

  function validateLookupKey(key) {
    if (typeof key !== "string") return false;

    const validation = getSchema().validatePreference({ key, value: null });
    return !(validation.errors || []).some(error => (
      error?.path === "key" && KEY_ERROR_CODES.has(error.code)
    ));
  }

  function readStorageRaw() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      throw createRepositoryError(
        "preferences-storage-read-failed",
        error?.message || "Preferences 存储读取失败。"
      );
    }
  }

  function parseStorageRoot(raw) {
    if (raw === null) return null;

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw createRepositoryError(
        "preferences-storage-malformed",
        "Preferences 存储不是合法 JSON。"
      );
    }

    if (!isPlainObject(parsed)) {
      throw createRepositoryError(
        "preferences-storage-invalid-root",
        "Preferences 存储顶层必须是普通对象。"
      );
    }
    return parsed;
  }

  function storageObjectToItems(storageObject) {
    const items = [];
    for (const key of Reflect.ownKeys(storageObject)) {
      if (typeof key !== "string") {
        throw createRepositoryError(
          "preferences-storage-invalid-entry",
          "Preferences 存储包含无法表达的 key。"
        );
      }

      const descriptor = Object.getOwnPropertyDescriptor(storageObject, key);
      if (!descriptor ||
          !descriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        throw createRepositoryError(
          "preferences-storage-invalid-entry",
          `Preference ${key} 不是可枚举数据属性。`
        );
      }

      const item = Object.create(null);
      defineDataProperty(item, "key", key);
      defineDataProperty(item, "value", descriptor.value);
      items.push(item);
    }
    return items;
  }

  function preferencesToStorageObject(preferences) {
    const storageObject = Object.create(null);
    for (const preference of preferences) {
      defineDataProperty(storageObject, preference.key, preference.value);
    }
    return storageObject;
  }

  function readStorageSnapshot() {
    const raw = readStorageRaw();
    if (raw === null) {
      return {
        raw,
        storageStatus: "missing",
        preferences: [],
        storageObject: Object.create(null)
      };
    }

    const storageRoot = parseStorageRoot(raw);
    const validation = getSchema().validatePreferences(
      storageObjectToItems(storageRoot)
    );
    if (validation.status !== "valid") {
      throw createRepositoryError(
        "preferences-storage-invalid-entry",
        "Preferences 存储包含不符合 Backup Schema 的值。",
        { errors: validation.errors || [] }
      );
    }

    return {
      raw,
      storageStatus: "present",
      preferences: validation.preferences,
      storageObject: preferencesToStorageObject(validation.preferences)
    };
  }

  function serializeStorageObject(storageObject) {
    try {
      return JSON.stringify(storageObject);
    } catch (error) {
      throw createRepositoryError(
        "preferences-storage-serialize-failed",
        error?.message || "Preferences 存储序列化失败。"
      );
    }
  }

  function writeSerializedStorage(serialized) {
    try {
      localStorage.setItem(STORAGE_KEY, serialized);
    } catch (error) {
      throw createRepositoryError(
        "preferences-storage-write-failed",
        error?.message || "Preferences 存储写入失败。"
      );
    }
  }

  function getOwnPreference(storageObject, key) {
    return Object.prototype.hasOwnProperty.call(storageObject, key)
      ? storageObject[key]
      : undefined;
  }

  function listFailure(error) {
    const reason = error?.code || "preferences-storage-read-failed";
    return {
      status: "failed",
      storageStatus: "failed",
      preferences: [],
      reason,
      errors: [publicError(error, reason)]
    };
  }

  function list() {
    try {
      const snapshot = readStorageSnapshot();
      return {
        status: "ready",
        storageStatus: snapshot.storageStatus,
        preferences: snapshot.preferences,
        errors: []
      };
    } catch (error) {
      return listFailure(error);
    }
  }

  function get(key) {
    const preferenceKey = typeof key === "string" ? key : null;
    try {
      if (!validateLookupKey(key)) {
        return {
          status: "rejected",
          preferenceKey,
          reason: "invalid-preference-key",
          errors: [{ code: "invalid-preference-key" }]
        };
      }

      const snapshot = readStorageSnapshot();
      if (!Object.prototype.hasOwnProperty.call(snapshot.storageObject, key)) {
        return {
          status: "missing",
          preferenceKey: key,
          errors: []
        };
      }
      return {
        status: "found",
        preferenceKey: key,
        value: getOwnPreference(snapshot.storageObject, key),
        errors: []
      };
    } catch (error) {
      const reason = error?.code || "preferences-storage-read-failed";
      return {
        status: "failed",
        preferenceKey,
        reason,
        errors: [publicError(error, reason)]
      };
    }
  }

  function valuesEqual(left, right) {
    if (left === right) return true;
    if (typeof left !== typeof right || left === null || right === null) return false;

    if (Array.isArray(left) || Array.isArray(right)) {
      return Array.isArray(left) &&
        Array.isArray(right) &&
        left.length === right.length &&
        left.every((value, index) => valuesEqual(value, right[index]));
    }

    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => (
        key === rightKeys[index] && valuesEqual(left[key], right[key])
      ));
  }

  function createRestoreItem(status, preferenceKey, details = {}) {
    return {
      status,
      preferenceKey: preferenceKey || null,
      written: Boolean(details.written),
      conflictFields: details.conflictFields || [],
      ...(details.reason ? { reason: details.reason } : {})
    };
  }

  function classifyBackupRestore(storageObject, incoming) {
    if (!Object.prototype.hasOwnProperty.call(storageObject, incoming.key)) {
      return createRestoreItem("restorable", incoming.key);
    }

    return valuesEqual(getOwnPreference(storageObject, incoming.key), incoming.value)
      ? createRestoreItem("unchanged", incoming.key)
      : createRestoreItem("conflict", incoming.key, {
          conflictFields: ["value"]
        });
  }

  function assessBackupRestore(value) {
    let incoming;
    try {
      incoming = validateAndSnapshotPreference(value);
    } catch (error) {
      return createRestoreItem(
        error?.code === "preferences-schema-unavailable" ? "failed" : "rejected",
        getCandidateKey(value),
        {
          reason: error?.code === "preferences-schema-unavailable"
            ? error.code
            : "invalid-preference"
        }
      );
    }

    try {
      const snapshot = readStorageSnapshot();
      return classifyBackupRestore(snapshot.storageObject, incoming);
    } catch (error) {
      return createRestoreItem("failed", incoming.key, {
        reason: error?.code || "preferences-storage-read-failed"
      });
    }
  }

  function createRestoreSummary(total = 0) {
    return {
      total,
      restored: 0,
      unchanged: 0,
      conflicts: 0,
      rejected: 0,
      failed: 0,
      notAttempted: 0
    };
  }

  function summarizeRestoreItems(total, items) {
    const summary = createRestoreSummary(total);
    for (const item of items) {
      if (item.status === "restored" && item.written) summary.restored += 1;
      else if (item.status === "unchanged") summary.unchanged += 1;
      else if (item.status === "conflict") summary.conflicts += 1;
      else if (item.status === "rejected") summary.rejected += 1;
      else if (item.status === "failed") summary.failed += 1;
      else if (item.status === "not-attempted") summary.notAttempted += 1;
    }
    return summary;
  }

  function getArrayCandidate(values, index) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
      return descriptor &&
        descriptor.enumerable &&
        Object.prototype.hasOwnProperty.call(descriptor, "value")
        ? descriptor.value
        : undefined;
    } catch {
      return undefined;
    }
  }

  function rejectedBackupBatch(values, validation) {
    const validationItems = Array.isArray(validation.items)
      ? validation.items
      : [];
    const total = Array.isArray(values) && validationItems.length === values.length
      ? values.length
      : 0;
    const itemsByIndex = new Map(
      validationItems.map(item => [item.index, item])
    );
    const items = Array.from({ length: total }, (_, index) => {
      const validationItem = itemsByIndex.get(index);
      const preferenceKey = validationItem?.preferenceKey ||
        getCandidateKey(getArrayCandidate(values, index));
      if (validationItem?.status === "rejected") {
        return {
          index,
          ...createRestoreItem("rejected", preferenceKey, {
            reason: validationItem.errors?.[0]?.code || "invalid-preference"
          })
        };
      }
      return {
        index,
        ...createRestoreItem("not-attempted", preferenceKey)
      };
    });
    return {
      status: "rejected",
      summary: summarizeRestoreItems(total, items),
      items,
      errors: (validation.errors || []).map(error => ({ ...error }))
    };
  }

  function interruptedBeforeWrite(snapshots, error) {
    const items = snapshots.map((preference, index) => ({
      index,
      ...createRestoreItem("not-attempted", preference.key)
    }));
    return {
      status: "interrupted",
      summary: summarizeRestoreItems(snapshots.length, items),
      items,
      errors: [publicError(error, "preferences-storage-read-failed")]
    };
  }

  function interruptedAtomicWrite(assessments, error) {
    const reason = error?.code || "preferences-storage-write-failed";
    const items = assessments.map(item => {
      if (item.status !== "restorable") return { ...item };
      return {
        index: item.index,
        ...createRestoreItem("failed", item.preferenceKey, { reason })
      };
    });
    return {
      status: "interrupted",
      summary: summarizeRestoreItems(items.length, items),
      items,
      errors: [publicError(error, reason)]
    };
  }

  function interruptedSchemaUnavailable(values, error) {
    const total = Array.isArray(values) ? values.length : 0;
    const items = Array.from({ length: total }, (_, index) => ({
      index,
      ...createRestoreItem(
        "not-attempted",
        getCandidateKey(getArrayCandidate(values, index))
      )
    }));
    return {
      status: "interrupted",
      summary: summarizeRestoreItems(total, items),
      items,
      errors: [publicError(error, "preferences-schema-unavailable")]
    };
  }

  function restoreBackupItems(values) {
    let validation;
    try {
      validation = getSchema().validatePreferences(values);
    } catch (error) {
      return interruptedSchemaUnavailable(values, error);
    }
    if (validation.status !== "valid") {
      return rejectedBackupBatch(values, validation);
    }

    const snapshots = validation.preferences;
    if (!snapshots.length) {
      return {
        status: "completed",
        summary: createRestoreSummary(0),
        items: [],
        errors: []
      };
    }

    let storageSnapshot;
    try {
      storageSnapshot = readStorageSnapshot();
    } catch (error) {
      return interruptedBeforeWrite(snapshots, error);
    }

    const assessments = snapshots.map((preference, index) => ({
      index,
      ...classifyBackupRestore(storageSnapshot.storageObject, preference)
    }));
    const restorable = assessments.filter(item => item.status === "restorable");
    if (!restorable.length) {
      const summary = summarizeRestoreItems(snapshots.length, assessments);
      return {
        status: summary.conflicts ? "completed-with-conflicts" : "completed",
        summary,
        items: assessments,
        errors: []
      };
    }

    const merged = Object.create(null);
    for (const key of Object.keys(storageSnapshot.storageObject)) {
      defineDataProperty(
        merged,
        key,
        getOwnPreference(storageSnapshot.storageObject, key)
      );
    }
    for (let index = 0; index < snapshots.length; index += 1) {
      if (assessments[index].status !== "restorable") continue;
      defineDataProperty(merged, snapshots[index].key, snapshots[index].value);
    }

    try {
      const currentRaw = readStorageRaw();
      if (currentRaw !== storageSnapshot.raw) {
        throw createRepositoryError(
          "preferences-storage-changed",
          "Preferences 存储在 assessment 后发生变化。"
        );
      }
      writeSerializedStorage(serializeStorageObject(merged));
    } catch (error) {
      return interruptedAtomicWrite(assessments, error);
    }

    const items = assessments.map(item => (
      item.status === "restorable"
        ? {
            index: item.index,
            ...createRestoreItem("restored", item.preferenceKey, { written: true })
          }
        : { ...item }
    ));
    const summary = summarizeRestoreItems(snapshots.length, items);
    return {
      status: summary.conflicts ? "completed-with-conflicts" : "completed",
      summary,
      items,
      errors: []
    };
  }

  window.LingoFlowPreferencesRepository = Object.freeze({
    list,
    get,
    assessBackupRestore,
    restoreBackupItems
  });
})();
