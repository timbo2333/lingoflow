(function() {
  "use strict";

  const STORAGE_KEY = "EnglishReaderV052QueryEvents";
  const DEVICE_ID_KEY = "EnglishReaderV052DeviceId";
  const MAX_ID_ATTEMPTS = 12;

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
    const schema = window.LingoFlowQueryEventBackupSchema;
    if (!schema ||
        typeof schema.validateQueryEvent !== "function" ||
        typeof schema.validateQueryEvents !== "function") {
      throw createRepositoryError(
        "query-event-schema-unavailable",
        "QueryEvent Schema Validator 不可用。"
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

  function isArrayIndexKey(key) {
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)) return false;
    const index = Number(key);
    return Number.isInteger(index) && index >= 0 && index < 4294967295;
  }

  function cloneJsonSafe(value, path = "value", ancestors = new WeakSet()) {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      if (Number.isFinite(value)) return value;
      throw createRepositoryError(
        "invalid-query-event-create-input",
        `${path} 必须是有限数字。`
      );
    }
    if (!value || typeof value !== "object") {
      throw createRepositoryError(
        "invalid-query-event-create-input",
        `${path} 必须是 JSON 可表达的数据。`
      );
    }
    if (!Array.isArray(value) && !isPlainObject(value)) {
      throw createRepositoryError(
        "invalid-query-event-create-input",
        `${path} 必须是普通 JSON 对象或数组。`
      );
    }
    if (ancestors.has(value)) {
      throw createRepositoryError(
        "invalid-query-event-create-input",
        `${path} 不能包含循环引用。`
      );
    }

    ancestors.add(value);
    const clone = Array.isArray(value) ? new Array(value.length) : Object.create(null);
    let arrayIndexCount = 0;
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === "length") continue;
      if (typeof key === "symbol" || (Array.isArray(value) && !isArrayIndexKey(key))) {
        ancestors.delete(value);
        throw createRepositoryError(
          "invalid-query-event-create-input",
          `${path} 包含 JSON 无法保留的属性。`
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor ||
          !descriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        ancestors.delete(value);
        throw createRepositoryError(
          "invalid-query-event-create-input",
          `${path}.${String(key)} 必须是可枚举的数据属性。`
        );
      }
      defineDataProperty(
        clone,
        key,
        cloneJsonSafe(descriptor.value, `${path}.${String(key)}`, ancestors)
      );
      if (Array.isArray(value)) arrayIndexCount += 1;
    }
    ancestors.delete(value);

    if (Array.isArray(value) && arrayIndexCount !== value.length) {
      throw createRepositoryError(
        "invalid-query-event-create-input",
        `${path} 不能是稀疏数组。`
      );
    }
    return clone;
  }

  function getCandidateId(value) {
    try {
      if (!isPlainObject(value)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, "id");
      if (!descriptor ||
          !descriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
          typeof descriptor.value !== "string" ||
          !descriptor.value.trim() ||
          descriptor.value !== descriptor.value.trim()) {
        return null;
      }
      return descriptor.value;
    } catch {
      return null;
    }
  }

  function validateAndSnapshotQueryEvent(value) {
    const validation = getSchema().validateQueryEvent(value);
    if (validation.status !== "valid") {
      throw createRepositoryError(
        "invalid-query-event",
        "QueryEvent 不符合 Backup Schema。",
        { errors: validation.errors }
      );
    }
    return validation.queryEvent;
  }

  function readStorageRaw() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      throw createRepositoryError(
        "query-event-storage-read-failed",
        error?.message || "QueryEvent 存储读取失败。"
      );
    }
  }

  function parseRecords(raw) {
    if (raw === null) return Object.create(null);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw createRepositoryError(
        "query-event-storage-malformed",
        "QueryEvent 存储不是合法 JSON。"
      );
    }

    if (!isPlainObject(parsed)) {
      throw createRepositoryError(
        "query-event-storage-invalid-root",
        "QueryEvent 存储顶层必须是普通对象 map。"
      );
    }

    const records = Object.create(null);
    for (const [outerId, value] of Object.entries(parsed)) {
      let snapshot;
      try {
        snapshot = validateAndSnapshotQueryEvent(value);
      } catch (error) {
        if (error?.code === "query-event-schema-unavailable") throw error;
        throw createRepositoryError(
          "query-event-storage-invalid-record",
          `QueryEvent 存储记录 ${outerId} 无效。`,
          { queryEventId: getCandidateId(value), errors: error?.details?.errors || [] }
        );
      }
      if (snapshot.id !== outerId) {
        throw createRepositoryError(
          "query-event-storage-identity-mismatch",
          `QueryEvent 存储索引 ${outerId} 与实体 ID 不一致。`,
          { outerId, queryEventId: snapshot.id }
        );
      }
      defineDataProperty(records, outerId, snapshot);
    }
    return records;
  }

  function readRecordsSnapshot() {
    const raw = readStorageRaw();
    return { raw, records: parseRecords(raw) };
  }

  function serializeRecords(records) {
    try {
      return JSON.stringify(records);
    } catch (error) {
      throw createRepositoryError(
        "query-event-storage-serialize-failed",
        error?.message || "QueryEvent 存储序列化失败。"
      );
    }
  }

  function writeSerializedRecords(serialized) {
    try {
      localStorage.setItem(STORAGE_KEY, serialized);
    } catch (error) {
      throw createRepositoryError(
        "query-event-storage-write-failed",
        error?.message || "QueryEvent 存储写入失败。"
      );
    }
  }

  function writeRecords(records) {
    writeSerializedRecords(serializeRecords(records));
  }

  function removeStoredRecords() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      throw createRepositoryError(
        "query-event-storage-write-failed",
        error?.message || "QueryEvent 存储清除失败。"
      );
    }
  }

  function assertStorageUnchanged(expectedRaw, message) {
    if (readStorageRaw() !== expectedRaw) {
      throw createRepositoryError(
        "query-event-storage-changed",
        message
      );
    }
  }

  function getOwnRecord(records, id) {
    return Object.prototype.hasOwnProperty.call(records, id) ? records[id] : null;
  }

  function makeId(prefix) {
    if (window.crypto?.randomUUID) return `${prefix}:${window.crypto.randomUUID()}`;
    return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}:${Math.random().toString(36).slice(2)}`;
  }

  function allocateQueryEventId(records) {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
      const id = makeId("query");
      if (!Object.prototype.hasOwnProperty.call(records, id)) return id;
    }
    throw createRepositoryError(
      "query-event-id-collision",
      "无法生成未被占用的 QueryEvent ID。"
    );
  }

  function getOrCreateDeviceId() {
    let deviceId;
    try {
      deviceId = localStorage.getItem(DEVICE_ID_KEY);
    } catch (error) {
      throw createRepositoryError(
        "query-event-device-storage-read-failed",
        error?.message || "设备 ID 读取失败。"
      );
    }

    if (deviceId) return deviceId;
    deviceId = makeId("device");
    try {
      localStorage.setItem(DEVICE_ID_KEY, deviceId);
    } catch (error) {
      throw createRepositoryError(
        "query-event-device-storage-write-failed",
        error?.message || "设备 ID 写入失败。"
      );
    }
    return deviceId;
  }

  function normalizeWord(word) {
    return word.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, "");
  }

  function snapshotDictionaryResult(value) {
    if (value === undefined || value === null) return value;
    if (!isPlainObject(value)) {
      throw createRepositoryError(
        "invalid-query-event-create-input",
        "QueryEvent dictionaryResult 必须是普通 JSON 对象、null 或 undefined。"
      );
    }
    return cloneJsonSafe(value, "dictionaryResult");
  }

  function buildCreatedEvent(word, dictionaryResult, source, id, deviceId, timestamp) {
    if (typeof word !== "string") {
      throw createRepositoryError(
        "invalid-query-event-create-input",
        "QueryEvent word 必须是字符串。"
      );
    }
    const result = snapshotDictionaryResult(dictionaryResult);
    const baseWord = result?.baseWord || word;
    if (typeof baseWord !== "string") {
      throw createRepositoryError(
        "invalid-query-event-create-input",
        "QueryEvent dictionaryResult.baseWord 必须是字符串。"
      );
    }
    const candidate = {
      id,
      deviceId,
      word: normalizeWord(baseWord),
      displayWord: word,
      phonetic: result?.phonetic || "",
      pos: result?.pos || "",
      meaning: result?.meaning || "",
      dictionaryFound: Boolean(result),
      source,
      timestamp
    };
    try {
      return validateAndSnapshotQueryEvent(candidate);
    } catch (error) {
      if (error?.code === "query-event-schema-unavailable") throw error;
      throw createRepositoryError(
        "invalid-query-event-create-input",
        "QueryEvent append 输入不符合实体边界。",
        error?.details || {}
      );
    }
  }

  function append(word, dictionaryResult, source = "article") {
    if (typeof word !== "string") {
      throw createRepositoryError(
        "invalid-query-event-create-input",
        "QueryEvent word 必须是字符串。"
      );
    }
    const resultSnapshot = snapshotDictionaryResult(dictionaryResult);
    const storageSnapshot = readRecordsSnapshot();
    const records = storageSnapshot.records;
    const id = allocateQueryEventId(records);
    const deviceId = getOrCreateDeviceId();
    const event = buildCreatedEvent(
      word,
      resultSnapshot,
      source,
      id,
      deviceId,
      new Date().toISOString()
    );

    if (Object.prototype.hasOwnProperty.call(records, event.id)) {
      throw createRepositoryError(
        "query-event-id-collision",
        "QueryEvent ID 已存在，不能覆盖原事件。"
      );
    }
    const currentRaw = readStorageRaw();
    if (currentRaw !== storageSnapshot.raw) {
      throw createRepositoryError(
        "query-event-storage-changed",
        "QueryEvent 存储在 append 期间发生变化。"
      );
    }
    defineDataProperty(records, event.id, event);
    writeRecords(records);
    return validateAndSnapshotQueryEvent(event);
  }

  function get(id) {
    if (typeof id !== "string" || !id.trim() || id !== id.trim()) return null;
    const record = getOwnRecord(readRecordsSnapshot().records, id);
    return record ? validateAndSnapshotQueryEvent(record) : null;
  }

  function list() {
    return Object.values(readRecordsSnapshot().records)
      .map(record => validateAndSnapshotQueryEvent(record));
  }

  function removeById(id) {
    if (typeof id !== "string" || !id.trim() || id !== id.trim()) return null;
    const storageSnapshot = readRecordsSnapshot();
    const records = storageSnapshot.records;
    const current = getOwnRecord(records, id);
    if (!current) return null;

    delete records[id];
    assertStorageUnchanged(
      storageSnapshot.raw,
      "QueryEvent 存储在按 ID 删除期间发生变化。"
    );
    writeRecords(records);
    return validateAndSnapshotQueryEvent(current);
  }

  function removeByWord(word) {
    if (typeof word !== "string") {
      return { word: null, removedCount: 0, queryEventIds: [] };
    }

    const storageSnapshot = readRecordsSnapshot();
    const records = storageSnapshot.records;
    const queryEventIds = [];
    for (const [id, event] of Object.entries(records)) {
      if (event.word === word) queryEventIds.push(id);
    }
    queryEventIds.sort();
    if (!queryEventIds.length) {
      return { word, removedCount: 0, queryEventIds: [] };
    }

    for (const id of queryEventIds) delete records[id];
    assertStorageUnchanged(
      storageSnapshot.raw,
      "QueryEvent 存储在按 word 删除期间发生变化。"
    );
    writeRecords(records);
    return {
      word,
      removedCount: queryEventIds.length,
      queryEventIds: queryEventIds.slice()
    };
  }

  function clear() {
    const storageSnapshot = readRecordsSnapshot();
    const queryEventIds = Object.keys(storageSnapshot.records).sort();
    if (storageSnapshot.raw === null) {
      return { removedCount: 0, queryEventIds: [], written: false };
    }

    assertStorageUnchanged(
      storageSnapshot.raw,
      "QueryEvent 存储在清除期间发生变化。"
    );
    removeStoredRecords();
    return {
      removedCount: queryEventIds.length,
      queryEventIds,
      written: true
    };
  }

  function valuesEqual(left, right) {
    if (Object.is(left, right)) return true;
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

  function createRestoreResult(status, queryEventId, details = {}) {
    return {
      status,
      queryEventId: queryEventId || null,
      written: Boolean(details.written),
      conflictFields: details.conflictFields || [],
      ...(details.reason ? { reason: details.reason } : {})
    };
  }

  function classifyBackupRestore(current, incoming) {
    if (!current) return createRestoreResult("restorable", incoming.id);

    const fields = Array.from(new Set([
      ...Object.keys(current),
      ...Object.keys(incoming)
    ])).sort();
    const conflictFields = fields.filter(field => !valuesEqual(current[field], incoming[field]));
    return conflictFields.length
      ? createRestoreResult("conflict", incoming.id, { conflictFields })
      : createRestoreResult("unchanged", incoming.id);
  }

  function assessBackupRestore(value) {
    let incoming;
    try {
      incoming = validateAndSnapshotQueryEvent(value);
    } catch (error) {
      return createRestoreResult("rejected", getCandidateId(value), {
        reason: error?.code === "query-event-schema-unavailable"
          ? error.code
          : "invalid-query-event"
      });
    }

    try {
      const records = readRecordsSnapshot().records;
      return classifyBackupRestore(getOwnRecord(records, incoming.id), incoming);
    } catch (error) {
      return createRestoreResult("failed", incoming.id, {
        reason: error?.code || "query-event-storage-read-failed"
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
    const total = Array.isArray(values) ? values.length : 0;
    const validationItems = new Map(
      (validation.items || []).map(item => [item.index, item])
    );
    const items = Array.from({ length: total }, (_, index) => {
      const validationItem = validationItems.get(index);
      const queryEventId = validationItem?.queryEventId ||
        getCandidateId(getArrayCandidate(values, index));
      if (validationItem?.status === "rejected") {
        return {
          index,
          ...createRestoreResult("rejected", queryEventId, {
            reason: validationItem.errors?.[0]?.code || "invalid-query-event"
          })
        };
      }
      return {
        index,
        ...createRestoreResult("not-attempted", queryEventId)
      };
    });
    return {
      status: "rejected",
      summary: summarizeRestoreItems(total, items),
      items,
      errors: (validation.errors || []).map(error => ({ ...error }))
    };
  }

  function interruptBeforeWrite(snapshots, error) {
    const items = snapshots.map((event, index) => ({
      index,
      ...createRestoreResult("not-attempted", event.id)
    }));
    return {
      status: "interrupted",
      summary: summarizeRestoreItems(snapshots.length, items),
      items,
      errors: [{
        code: error?.code || "query-event-storage-read-failed",
        ...(error?.message ? { message: error.message } : {})
      }]
    };
  }

  function interruptDuringWrite(snapshots, items, failedIndex, error) {
    const interruptedItems = items.map((item, index) => {
      if (index < failedIndex) return item;
      if (index === failedIndex) {
        return {
          index,
          ...createRestoreResult("failed", snapshots[index].id, {
            reason: error?.code || "query-event-restore-failed"
          })
        };
      }
      return {
        index,
        ...createRestoreResult("not-attempted", snapshots[index].id)
      };
    });
    return {
      status: "interrupted",
      summary: summarizeRestoreItems(snapshots.length, interruptedItems),
      items: interruptedItems,
      errors: [{
        code: error?.code || "query-event-restore-failed",
        index: failedIndex,
        queryEventId: snapshots[failedIndex].id,
        ...(error?.message ? { message: error.message } : {})
      }]
    };
  }

  function restoreBackupRecords(values) {
    const validation = getSchema().validateQueryEvents(values);
    if (validation.status !== "valid") {
      return rejectedBackupBatch(values, validation);
    }
    const snapshots = validation.queryEvents;
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
      storageSnapshot = readRecordsSnapshot();
    } catch (error) {
      return interruptBeforeWrite(snapshots, error);
    }

    const records = storageSnapshot.records;
    const assessments = snapshots.map((event, index) => ({
      index,
      ...classifyBackupRestore(getOwnRecord(records, event.id), event)
    }));
    const items = assessments.map(item => ({ ...item }));
    let expectedRaw = storageSnapshot.raw;

    for (let index = 0; index < snapshots.length; index += 1) {
      if (assessments[index].status !== "restorable") continue;

      try {
        const currentRaw = readStorageRaw();
        if (currentRaw !== expectedRaw) {
          throw createRepositoryError(
            "query-event-storage-changed",
            "QueryEvent 存储在恢复期间发生变化。"
          );
        }

        defineDataProperty(records, snapshots[index].id, snapshots[index]);
        const serialized = serializeRecords(records);
        writeSerializedRecords(serialized);
        expectedRaw = serialized;
        items[index] = {
          index,
          ...createRestoreResult("restored", snapshots[index].id, { written: true })
        };
      } catch (error) {
        return interruptDuringWrite(snapshots, items, index, error);
      }
    }

    const summary = summarizeRestoreItems(snapshots.length, items);
    return {
      status: summary.conflicts ? "completed-with-conflicts" : "completed",
      summary,
      items,
      errors: []
    };
  }

  window.LingoFlowQueryEventRepository = Object.freeze({
    append,
    get,
    list,
    removeById,
    removeByWord,
    clear,
    assessBackupRestore,
    restoreBackupRecords
  });
})();
