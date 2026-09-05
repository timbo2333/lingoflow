(function() {
  "use strict";

  const STORAGE_PREFIX = "LingoFlowFavoriteLearningState:";
  const STATE_FIELDS = new Set([
    "favoriteId",
    "mastered",
    "createdAt",
    "updatedAt",
    "deletedAt"
  ]);

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function normalizeFavoriteId(favoriteId) {
    if (typeof favoriteId !== "string" || !favoriteId.trim()) return "";
    return favoriteId === favoriteId.trim() ? favoriteId : "";
  }

  function isValidTimestamp(value, nullable = false) {
    if (nullable && value === null) return true;
    if (typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
      return false;
    }
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  }

  function validateState(state, expectedFavoriteId = null) {
    if (!isPlainObject(state)) {
      throw new Error("Favorite Learning State 必须是普通对象。");
    }

    const keys = Reflect.ownKeys(state);
    if (keys.some(key => typeof key !== "string") ||
        keys.length !== STATE_FIELDS.size ||
        keys.some(key => !STATE_FIELDS.has(key))) {
      throw new Error("Favorite Learning State 字段结构无效。");
    }

    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(state, key);
      if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set || !("value" in descriptor)) {
        throw new Error(`Favorite Learning State ${key} 必须是可枚举的数据属性。`);
      }
    }

    const favoriteId = normalizeFavoriteId(state.favoriteId);
    if (!favoriteId || (expectedFavoriteId !== null && favoriteId !== expectedFavoriteId)) {
      throw new Error("Favorite Learning State 的 favoriteId 无效。");
    }
    if (typeof state.mastered !== "boolean") {
      throw new Error("Favorite Learning State 的 mastered 必须是布尔值。");
    }
    if (!isValidTimestamp(state.createdAt) ||
        !isValidTimestamp(state.updatedAt) ||
        !isValidTimestamp(state.deletedAt, true)) {
      throw new Error("Favorite Learning State 生命周期时间无效。");
    }

    const createdTime = Date.parse(state.createdAt);
    const updatedTime = Date.parse(state.updatedAt);
    const deletedTime = state.deletedAt === null ? null : Date.parse(state.deletedAt);
    if (createdTime > updatedTime ||
        (deletedTime !== null && (deletedTime < createdTime || deletedTime > updatedTime))) {
      throw new Error("Favorite Learning State 生命周期时间顺序无效。");
    }
  }

  function getStorageKey(favoriteId) {
    return `${STORAGE_PREFIX}${favoriteId}`;
  }

  function cloneState(state) {
    return state ? structuredClone(state) : null;
  }

  function statesEqual(left, right) {
    if (left === null || right === null) return left === right;
    return Array.from(STATE_FIELDS).every(field => Object.is(left[field], right[field]));
  }

  function getBackupCandidateFavoriteId(value) {
    if (!isPlainObject(value)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, "favoriteId");
    return descriptor &&
      descriptor.enumerable &&
      !descriptor.get &&
      !descriptor.set &&
      normalizeFavoriteId(descriptor.value)
      ? descriptor.value
      : null;
  }

  function createBackupRestoreResult(status, favoriteId, details = {}) {
    return {
      status,
      favoriteId: favoriteId || null,
      written: Boolean(details.written),
      conflicts: details.conflicts || [],
      conflictFields: details.conflictFields || [],
      ...(details.reason ? { reason: details.reason } : {})
    };
  }

  function classifyBackupRestore(current, incoming) {
    if (!current) return createBackupRestoreResult("restored", incoming.favoriteId);

    const conflictFields = Array.from(STATE_FIELDS)
      .filter(field => !Object.is(current[field], incoming[field]));
    if (!conflictFields.length) {
      return createBackupRestoreResult("unchanged", incoming.favoriteId);
    }

    const conflicts = [];
    if (conflictFields.includes("mastered")) conflicts.push("mastered");
    if (conflictFields.some(field => ["createdAt", "updatedAt", "deletedAt"].includes(field))) {
      conflicts.push("lifecycle");
    }
    return createBackupRestoreResult("conflict", incoming.favoriteId, {
      conflicts: conflicts.sort(),
      conflictFields
    });
  }

  function snapshotBackupState(value) {
    validateState(value);
    return cloneState(value);
  }

  function assessBackupRestore(value) {
    let incoming;
    try {
      incoming = snapshotBackupState(value);
    } catch {
      return createBackupRestoreResult("rejected", getBackupCandidateFavoriteId(value), {
        reason: "invalid-favorite-learning-state"
      });
    }
    return classifyBackupRestore(readState(incoming.favoriteId), incoming);
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

  function rejectBackupBatch(total, invalidItems, errors, candidates = []) {
    const items = Array.from({ length: total }, (_, index) => {
      const invalid = invalidItems.find(item => item.index === index);
      if (invalid) return invalid;
      return {
        index,
        favoriteId: getBackupCandidateFavoriteId(candidates[index]),
        status: "not-attempted",
        written: false,
        conflicts: [],
        conflictFields: []
      };
    });
    return {
      status: "rejected",
      summary: summarizeRestoreItems(total, items),
      items,
      errors
    };
  }

  function snapshotBackupStates(values) {
    if (!Array.isArray(values)) {
      return {
        rejection: rejectBackupBatch(0, [], [{ code: "invalid-favorite-learning-states" }])
      };
    }

    const expectedKeys = new Set(
      Array.from({ length: values.length }, (_, index) => String(index))
    );
    const snapshots = [];
    for (const key of Reflect.ownKeys(values)) {
      if (key === "length") continue;
      if (typeof key !== "string" || !expectedKeys.has(key)) {
        return {
          rejection: rejectBackupBatch(values.length, [], [{
            code: "invalid-favorite-learning-states"
          }])
        };
      }
      const descriptor = Object.getOwnPropertyDescriptor(values, key);
      if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set || !("value" in descriptor)) {
        return {
          rejection: rejectBackupBatch(values.length, [], [{
            code: "invalid-favorite-learning-states"
          }])
        };
      }
      expectedKeys.delete(key);
    }
    if (expectedKeys.size) {
      return {
        rejection: rejectBackupBatch(values.length, [], [{
          code: "invalid-favorite-learning-states"
        }])
      };
    }

    const invalidItems = [];
    const errors = [];
    const identities = new Map();
    for (let index = 0; index < values.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(values, String(index));
      const value = descriptor.value;
      const favoriteId = getBackupCandidateFavoriteId(value);
      try {
        const snapshot = snapshotBackupState(value);
        snapshots.push(snapshot);
        if (identities.has(snapshot.favoriteId)) {
          invalidItems.push({
            index,
            favoriteId: snapshot.favoriteId,
            status: "rejected",
            written: false,
            conflicts: [],
            conflictFields: [],
            reason: "duplicate-favorite-id"
          });
          errors.push({
            code: "duplicate-favorite-id",
            index,
            favoriteId: snapshot.favoriteId,
            conflictingIndex: identities.get(snapshot.favoriteId)
          });
        } else {
          identities.set(snapshot.favoriteId, index);
        }
      } catch (error) {
        snapshots.push(null);
        invalidItems.push({
          index,
          favoriteId,
          status: "rejected",
          written: false,
          conflicts: [],
          conflictFields: [],
          reason: "invalid-favorite-learning-state"
        });
        errors.push({
          code: "invalid-favorite-learning-state",
          index,
          ...(favoriteId ? { favoriteId } : {}),
          message: error.message
        });
      }
    }

    return invalidItems.length
      ? { rejection: rejectBackupBatch(values.length, invalidItems, errors, snapshots) }
      : { snapshots };
  }

  function interruptBackupRestore(snapshots, assessedItems, failedIndex, error) {
    const items = snapshots.map((state, index) => {
      const assessment = assessedItems[index];
      if (index < failedIndex && assessment &&
          ["unchanged", "conflict"].includes(assessment.status)) {
        return assessment;
      }
      if (index === failedIndex) {
        return {
          index,
          favoriteId: state.favoriteId,
          status: "failed",
          written: false,
          conflicts: [],
          conflictFields: []
        };
      }
      return {
        index,
        favoriteId: state.favoriteId,
        status: "not-attempted",
        written: false,
        conflicts: [],
        conflictFields: []
      };
    });
    return {
      status: "interrupted",
      summary: summarizeRestoreItems(snapshots.length, items),
      items,
      errors: [{
        code: "favorite-learning-state-storage-read-failed",
        index: failedIndex,
        favoriteId: snapshots[failedIndex].favoriteId,
        message: error.message
      }]
    };
  }

  function restoreBackupRecords(values) {
    const batch = snapshotBackupStates(values);
    if (batch.rejection) return batch.rejection;

    const assessedItems = [];
    for (let index = 0; index < batch.snapshots.length; index += 1) {
      const state = batch.snapshots[index];
      try {
        assessedItems.push({
          index,
          ...classifyBackupRestore(readState(state.favoriteId), state)
        });
      } catch (error) {
        return interruptBackupRestore(batch.snapshots, assessedItems, index, error);
      }
    }
    const items = assessedItems.map(item => ({ ...item }));
    const errors = [];

    for (let index = 0; index < batch.snapshots.length; index += 1) {
      if (assessedItems[index].status !== "restored") continue;
      try {
        const currentAssessment = classifyBackupRestore(
          readState(batch.snapshots[index].favoriteId),
          batch.snapshots[index]
        );
        if (currentAssessment.status !== "restored") {
          items[index] = { index, ...currentAssessment };
          continue;
        }
        writeState(batch.snapshots[index]);
        items[index] = { ...items[index], written: true };
      } catch (error) {
        items[index] = {
          index,
          favoriteId: batch.snapshots[index].favoriteId,
          status: "failed",
          written: false,
          conflicts: [],
          conflictFields: []
        };
        errors.push({
          code: "favorite-learning-state-restore-failed",
          index,
          favoriteId: batch.snapshots[index].favoriteId,
          message: error.message
        });
        for (let pendingIndex = index + 1; pendingIndex < assessedItems.length; pendingIndex += 1) {
          if (assessedItems[pendingIndex].status !== "restored") continue;
          items[pendingIndex] = {
            index: pendingIndex,
            favoriteId: batch.snapshots[pendingIndex].favoriteId,
            status: "not-attempted",
            written: false,
            conflicts: [],
            conflictFields: []
          };
        }
        return {
          status: "interrupted",
          summary: summarizeRestoreItems(batch.snapshots.length, items),
          items,
          errors
        };
      }
    }

    const summary = summarizeRestoreItems(batch.snapshots.length, items);
    return {
      status: summary.conflicts ? "completed-with-conflicts" : "completed",
      summary,
      items,
      errors
    };
  }

  function readState(favoriteId) {
    const raw = localStorage.getItem(getStorageKey(favoriteId));
    if (raw === null) return null;

    let state;
    try {
      state = JSON.parse(raw);
    } catch {
      throw new Error("Favorite Learning State 存储数据损坏，无法读取。");
    }

    validateState(state, favoriteId);
    return state;
  }

  function writeState(state) {
    validateState(state, state.favoriteId);
    localStorage.setItem(getStorageKey(state.favoriteId), JSON.stringify(state));
  }

  function nextTimestamp(previous = null) {
    const now = Date.now();
    const previousTime = Date.parse(previous || "");
    return new Date(Number.isFinite(previousTime) ? Math.max(now, previousTime + 1) : now).toISOString();
  }

  function normalizeOptions(options, allowedFields) {
    if (options === undefined) return {};
    if (!isPlainObject(options)) throw new Error("Favorite Learning State 查询选项必须是普通对象。");

    const snapshot = {};
    for (const key of Reflect.ownKeys(options)) {
      if (typeof key !== "string" || !allowedFields.has(key)) {
        throw new Error("Favorite Learning State 查询选项包含未知字段。");
      }
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set || !("value" in descriptor)) {
        throw new Error(`Favorite Learning State 查询选项 ${key} 必须是数据属性。`);
      }
      if (typeof descriptor.value !== "boolean") {
        throw new Error(`Favorite Learning State 查询选项 ${key} 必须是布尔值。`);
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  }

  function get(favoriteId, options = undefined) {
    const normalizedId = normalizeFavoriteId(favoriteId);
    if (!normalizedId) return null;

    const normalizedOptions = normalizeOptions(options, new Set(["includeDeleted"]));
    const state = readState(normalizedId);
    if (!state || (state.deletedAt && !normalizedOptions.includeDeleted)) return null;
    return cloneState(state);
  }

  function createPlan(operation, before, candidate, changed) {
    return {
      operation,
      entityId: candidate.favoriteId,
      before: cloneState(before),
      candidate: cloneState(candidate),
      changed: Boolean(changed)
    };
  }

  function planSetMastered(favoriteId, value) {
    const normalizedId = normalizeFavoriteId(favoriteId);
    if (!normalizedId) throw new Error("缺少有效的 Favorite ID。");
    if (typeof value !== "boolean") throw new Error("mastered 必须是布尔值。");

    const current = readState(normalizedId);
    if (!current && !value) return null;
    if (current?.deletedAt && !value) {
      return createPlan("set-mastered", current, current, false);
    }
    if (current && !current.deletedAt && current.mastered === value) {
      return createPlan("set-mastered", current, current, false);
    }

    const now = nextTimestamp(current?.updatedAt);
    const candidate = current
      ? {
          ...current,
          mastered: value,
          updatedAt: now,
          deletedAt: null
        }
      : {
          favoriteId: normalizedId,
          mastered: value,
          createdAt: now,
          updatedAt: now,
          deletedAt: null
        };
    validateState(candidate, normalizedId);
    return createPlan(current?.deletedAt ? "restore" : "set-mastered", current, candidate, true);
  }

  function snapshotPlannedMutation(value) {
    if (!isPlainObject(value)) throw new Error("Favorite Learning mutation plan 必须是普通对象。");
    const plan = structuredClone(value);
    const expectedFields = ["before", "candidate", "changed", "entityId", "operation"].sort();
    const keys = Object.keys(plan).sort();
    if (keys.length !== expectedFields.length ||
        !keys.every((key, index) => key === expectedFields[index]) ||
        !new Set(["set-mastered", "restore", "drift"]).has(plan.operation) ||
        typeof plan.changed !== "boolean" ||
        normalizeFavoriteId(plan.entityId) !== plan.entityId) {
      throw new Error("Favorite Learning mutation plan 结构无效。");
    }
    if (plan.before !== null) validateState(plan.before, plan.entityId);
    validateState(plan.candidate, plan.entityId);
    if (plan.before !== null && plan.before.createdAt !== plan.candidate.createdAt) {
      throw new Error("Favorite Learning mutation plan 不能修改 createdAt。");
    }
    if (plan.operation === "restore" &&
        (plan.before === null || plan.before.deletedAt === null || plan.candidate.deletedAt !== null)) {
      throw new Error("Favorite Learning restore plan 生命周期无效。");
    }
    if (plan.operation === "set-mastered" && plan.candidate.deletedAt !== null) {
      if (plan.changed) throw new Error("Favorite Learning set-mastered plan 生命周期无效。");
    }
    if (plan.changed === statesEqual(plan.before, plan.candidate)) {
      throw new Error("Favorite Learning mutation plan changed 标记无效。");
    }
    return plan;
  }

  function commitPlannedMutation(value) {
    const plan = snapshotPlannedMutation(value);
    const current = readState(plan.entityId);
    if (!statesEqual(current, plan.before)) {
      return {
        status: "stale-local-state",
        entityId: plan.entityId,
        written: false,
        favoriteLearningState: cloneState(current)
      };
    }
    if (!plan.changed) {
      return {
        status: "unchanged",
        entityId: plan.entityId,
        written: false,
        favoriteLearningState: cloneState(plan.candidate)
      };
    }
    writeState(plan.candidate);
    return {
      status: "committed",
      entityId: plan.entityId,
      written: true,
      favoriteLearningState: cloneState(plan.candidate)
    };
  }

  function commitExactSnapshot(value) {
    if (!isPlainObject(value)) {
      throw new Error("Favorite Learning exact snapshot commit 必须是普通对象。");
    }
    const input = structuredClone(value);
    const expectedFields = ["candidate", "entityId", "expectedCurrent"].sort();
    const keys = Object.keys(input).sort();
    if (keys.length !== expectedFields.length ||
        !keys.every((key, index) => key === expectedFields[index]) ||
        normalizeFavoriteId(input.entityId) !== input.entityId) {
      throw new Error("Favorite Learning exact snapshot commit 结构无效。");
    }
    if (input.expectedCurrent !== null) validateState(input.expectedCurrent, input.entityId);
    validateState(input.candidate, input.entityId);

    const current = readState(input.entityId);
    if (statesEqual(current, input.candidate)) {
      return {
        status: "unchanged",
        entityId: input.entityId,
        written: false,
        favoriteLearningState: cloneState(input.candidate)
      };
    }
    if (!statesEqual(current, input.expectedCurrent)) {
      return {
        status: "stale-local-state",
        entityId: input.entityId,
        written: false,
        favoriteLearningState: cloneState(current)
      };
    }
    writeState(input.candidate);
    return {
      status: "committed",
      entityId: input.entityId,
      written: true,
      favoriteLearningState: cloneState(input.candidate)
    };
  }

  function setMastered(favoriteId, value) {
    const normalizedId = normalizeFavoriteId(favoriteId);
    if (!normalizedId) throw new Error("缺少有效的 Favorite ID。");
    if (typeof value !== "boolean") throw new Error("mastered 必须是布尔值。");

    const current = readState(normalizedId);
    if (current?.deletedAt) {
      throw new Error("已删除的 Favorite Learning State 必须先恢复再更新。");
    }
    if (current && current.mastered === value) return cloneState(current);

    const now = nextTimestamp(current?.updatedAt);
    const next = current
      ? { ...current, mastered: value, updatedAt: now }
      : {
          favoriteId: normalizedId,
          mastered: value,
          createdAt: now,
          updatedAt: now,
          deletedAt: null
        };

    writeState(next);
    return cloneState(next);
  }

  function remove(favoriteId) {
    const normalizedId = normalizeFavoriteId(favoriteId);
    if (!normalizedId) return null;

    const current = readState(normalizedId);
    if (!current) return null;
    if (current.deletedAt) return cloneState(current);

    const deletedAt = nextTimestamp(current.updatedAt);
    const next = {
      ...current,
      updatedAt: deletedAt,
      deletedAt
    };
    writeState(next);
    return cloneState(next);
  }

  function restore(favoriteId) {
    const normalizedId = normalizeFavoriteId(favoriteId);
    if (!normalizedId) return null;

    const current = readState(normalizedId);
    if (!current) return null;
    if (!current.deletedAt) return cloneState(current);

    const next = {
      ...current,
      updatedAt: nextTimestamp(current.updatedAt),
      deletedAt: null
    };
    writeState(next);
    return cloneState(next);
  }

  function list(options = undefined) {
    const normalizedOptions = normalizeOptions(
      options,
      new Set(["includeDeleted", "deletedOnly"])
    );
    const keys = [];

    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(STORAGE_PREFIX)) keys.push(key);
    }

    return keys
      .sort()
      .map(key => {
        const favoriteId = key.slice(STORAGE_PREFIX.length);
        if (!normalizeFavoriteId(favoriteId)) {
          throw new Error("Favorite Learning State 存储索引无效。");
        }
        return readState(favoriteId);
      })
      .filter(Boolean)
      .filter(state => {
        if (normalizedOptions.deletedOnly) return Boolean(state.deletedAt);
        return normalizedOptions.includeDeleted || !state.deletedAt;
      })
      .sort((left, right) => left.favoriteId.localeCompare(right.favoriteId))
      .map(cloneState);
  }

  function getStorageBytes() {
    let bytes = 0;
    const encoder = new TextEncoder();

    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(STORAGE_PREFIX)) continue;
      bytes += encoder.encode(localStorage.getItem(key) || "").length;
    }

    return bytes;
  }

  window.LingoFlowFavoriteLearningRepository = Object.freeze({
    get,
    planSetMastered,
    commitPlannedMutation,
    commitExactSnapshot,
    setMastered,
    remove,
    restore,
    assessBackupRestore,
    restoreBackupRecords,
    list,
    getStorageBytes
  });
})();
