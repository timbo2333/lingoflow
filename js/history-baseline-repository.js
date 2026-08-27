(function() {
  "use strict";

  const STORAGE_KEY = "EnglishReaderV052HistoryBaselines";

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
    const schema = window.LingoFlowHistoryBaselineBackupSchema;
    if (!schema ||
        typeof schema.validateHistoryBaseline !== "function" ||
        typeof schema.validateHistoryBaselines !== "function") {
      throw createRepositoryError(
        "history-baseline-schema-unavailable",
        "History Baseline Schema Validator 不可用。"
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

  function validateAndSnapshotBaseline(value) {
    const validation = getSchema().validateHistoryBaseline(value);
    if (validation.status !== "valid") {
      throw createRepositoryError(
        "invalid-history-baseline",
        "History Baseline 不符合 Backup Schema。",
        { errors: validation.errors }
      );
    }
    return validation.historyBaseline;
  }

  function readStorageRaw() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      throw createRepositoryError(
        "history-baseline-storage-read-failed",
        error?.message || "History Baseline 存储读取失败。"
      );
    }
  }

  function parseBaselines(raw) {
    if (raw === null) return Object.create(null);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw createRepositoryError(
        "history-baseline-storage-malformed",
        "History Baseline 存储不是合法 JSON。"
      );
    }

    if (!isPlainObject(parsed)) {
      throw createRepositoryError(
        "history-baseline-storage-invalid-root",
        "History Baseline 存储顶层必须是普通对象 map。"
      );
    }

    const baselines = Object.create(null);
    for (const [outerId, value] of Object.entries(parsed)) {
      let snapshot;
      try {
        snapshot = validateAndSnapshotBaseline(value);
      } catch (error) {
        if (error?.code === "history-baseline-schema-unavailable") throw error;
        throw createRepositoryError(
          "history-baseline-storage-invalid-record",
          `History Baseline 存储记录 ${outerId} 无效。`,
          {
            historyBaselineId: getCandidateId(value),
            errors: error?.details?.errors || []
          }
        );
      }
      if (snapshot.id !== outerId) {
        throw createRepositoryError(
          "history-baseline-storage-identity-mismatch",
          `History Baseline 存储索引 ${outerId} 与实体 ID 不一致。`,
          { outerId, historyBaselineId: snapshot.id }
        );
      }
      defineDataProperty(baselines, outerId, snapshot);
    }
    return baselines;
  }

  function readBaselinesSnapshot() {
    const raw = readStorageRaw();
    return { raw, baselines: parseBaselines(raw) };
  }

  function serializeBaselines(baselines) {
    try {
      return JSON.stringify(baselines);
    } catch (error) {
      throw createRepositoryError(
        "history-baseline-storage-serialize-failed",
        error?.message || "History Baseline 存储序列化失败。"
      );
    }
  }

  function writeSerializedBaselines(serialized) {
    try {
      localStorage.setItem(STORAGE_KEY, serialized);
    } catch (error) {
      throw createRepositoryError(
        "history-baseline-storage-write-failed",
        error?.message || "History Baseline 存储写入失败。"
      );
    }
  }

  function getOwnBaseline(baselines, id) {
    return Object.prototype.hasOwnProperty.call(baselines, id)
      ? baselines[id]
      : null;
  }

  function get(id) {
    if (typeof id !== "string" || !id.trim() || id !== id.trim()) return null;
    const baseline = getOwnBaseline(readBaselinesSnapshot().baselines, id);
    return baseline ? validateAndSnapshotBaseline(baseline) : null;
  }

  function list() {
    return Object.values(readBaselinesSnapshot().baselines)
      .map(baseline => validateAndSnapshotBaseline(baseline));
  }

  function findRecordLocatorsByWord(word) {
    if (typeof word !== "string") return [];
    const matches = [];
    for (const baseline of Object.values(readBaselinesSnapshot().baselines)) {
      for (const [locator, record] of Object.entries(baseline.records)) {
        if (record.word === word) {
          matches.push({ historyBaselineId: baseline.id, locator });
        }
      }
    }
    return matches;
  }

  function removeRecordsByWord(word) {
    if (typeof word !== "string") {
      return { word: null, removedCount: 0, items: [] };
    }

    const storageSnapshot = readBaselinesSnapshot();
    const baselines = storageSnapshot.baselines;
    const items = [];
    let removedCount = 0;

    for (const baseline of Object.values(baselines)) {
      const locators = [];
      for (const [locator, record] of Object.entries(baseline.records)) {
        if (record.word !== word) continue;
        locators.push(locator);
      }
      if (!locators.length) continue;

      for (const locator of locators) delete baseline.records[locator];
      validateAndSnapshotBaseline(baseline);
      removedCount += locators.length;
      items.push({ historyBaselineId: baseline.id, locators: locators.slice() });
    }

    if (!removedCount) return { word, removedCount: 0, items: [] };

    const currentRaw = readStorageRaw();
    if (currentRaw !== storageSnapshot.raw) {
      throw createRepositoryError(
        "history-baseline-storage-changed",
        "History Baseline 存储在 records 删除期间发生变化。"
      );
    }
    writeSerializedBaselines(serializeBaselines(baselines));
    return { word, removedCount, items };
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

  function createRestoreResult(status, historyBaselineId, details = {}) {
    return {
      status,
      historyBaselineId: historyBaselineId || null,
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
      incoming = validateAndSnapshotBaseline(value);
    } catch (error) {
      return createRestoreResult("rejected", getCandidateId(value), {
        reason: error?.code === "history-baseline-schema-unavailable"
          ? error.code
          : "invalid-history-baseline"
      });
    }

    try {
      const baselines = readBaselinesSnapshot().baselines;
      return classifyBackupRestore(getOwnBaseline(baselines, incoming.id), incoming);
    } catch (error) {
      return createRestoreResult("failed", incoming.id, {
        reason: error?.code || "history-baseline-storage-read-failed"
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
    const validationItemList = Array.isArray(validation.items)
      ? validation.items
      : [];
    const total = Array.isArray(values) && validationItemList.length === values.length
      ? values.length
      : 0;
    const validationItems = new Map(
      validationItemList.map(item => [item.index, item])
    );
    const items = Array.from({ length: total }, (_, index) => {
      const validationItem = validationItems.get(index);
      const historyBaselineId = validationItem?.baselineId ||
        getCandidateId(getArrayCandidate(values, index));
      if (validationItem?.status === "rejected") {
        return {
          index,
          ...createRestoreResult("rejected", historyBaselineId, {
            reason: validationItem.errors?.[0]?.code || "invalid-history-baseline"
          })
        };
      }
      return {
        index,
        ...createRestoreResult("not-attempted", historyBaselineId)
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
    const items = snapshots.map((baseline, index) => ({
      index,
      ...createRestoreResult("not-attempted", baseline.id)
    }));
    return {
      status: "interrupted",
      summary: summarizeRestoreItems(snapshots.length, items),
      items,
      errors: [{
        code: error?.code || "history-baseline-storage-read-failed",
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
            reason: error?.code || "history-baseline-restore-failed"
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
        code: error?.code || "history-baseline-restore-failed",
        index: failedIndex,
        historyBaselineId: snapshots[failedIndex].id,
        ...(error?.message ? { message: error.message } : {})
      }]
    };
  }

  function restoreBackupRecords(values) {
    const validation = getSchema().validateHistoryBaselines(values);
    if (validation.status !== "valid") {
      return rejectedBackupBatch(values, validation);
    }
    const snapshots = validation.historyBaselines;
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
      storageSnapshot = readBaselinesSnapshot();
    } catch (error) {
      return interruptBeforeWrite(snapshots, error);
    }

    const baselines = storageSnapshot.baselines;
    const assessments = snapshots.map((baseline, index) => ({
      index,
      ...classifyBackupRestore(getOwnBaseline(baselines, baseline.id), baseline)
    }));
    const items = assessments.map(item => ({ ...item }));
    let expectedRaw = storageSnapshot.raw;

    for (let index = 0; index < snapshots.length; index += 1) {
      if (assessments[index].status !== "restorable") continue;

      try {
        const currentRaw = readStorageRaw();
        if (currentRaw !== expectedRaw) {
          throw createRepositoryError(
            "history-baseline-storage-changed",
            "History Baseline 存储在恢复期间发生变化。"
          );
        }

        defineDataProperty(baselines, snapshots[index].id, snapshots[index]);
        const serialized = serializeBaselines(baselines);
        writeSerializedBaselines(serialized);
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

  window.LingoFlowHistoryBaselineRepository = Object.freeze({
    get,
    list,
    findRecordLocatorsByWord,
    removeRecordsByWord,
    assessBackupRestore,
    restoreBackupRecords
  });
})();
