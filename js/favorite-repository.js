(function() {
  "use strict";

  const STORAGE_KEY = "LingoFlowFavoriteEntities";
  const FAVORITE_TYPES = new Set(["word", "phrase"]);
  const CREATE_RESERVED_FIELDS = new Set([
    "id",
    "createdAt",
    "updatedAt",
    "deletedAt"
  ]);
  const UPDATE_PROTECTED_FIELDS = CREATE_RESERVED_FIELDS;
  const OUT_OF_BOUND_FIELDS = new Set([
    "mastered",
    "proficiency",
    "reviewCount",
    "reviewInterval",
    "dueAt",
    "interval",
    "nextReviewAt",
    "dictionaryFound",
    "dictionaryVersion",
    "lemma",
    "normalizedKey",
    "searchIndex",
    "deviceId",
    "remoteId",
    "syncStatus",
    "dirty",
    "lastSyncedAt",
    "serverRevision",
    "vectorClock"
  ]);
  const OPTIONAL_TEXT_FIELDS = [
    "displayText",
    "phonetic",
    "partOfSpeech",
    "meaning",
    "context",
    "note"
  ];
  const BACKUP_CONTENT_FIELDS = new Set([
    "type",
    "text",
    ...OPTIONAL_TEXT_FIELDS,
    "tags"
  ]);
  const BACKUP_LIFECYCLE_FIELDS = new Set([
    "createdAt",
    "updatedAt",
    "deletedAt"
  ]);
  const PLANNED_OPERATIONS = new Set([
    "create",
    "update",
    "soft-delete",
    "restore"
  ]);

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function findJsonError(value, path = "value", ancestors = new WeakSet()) {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return null;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? null : `${path} 必须是有限数字。`;
    }
    if (!value || typeof value !== "object") {
      return `${path} 必须是 JSON 可表达的数据。`;
    }
    if (!Array.isArray(value) && !isPlainObject(value)) {
      return `${path} 必须是普通 JSON 对象或数组。`;
    }
    if (ancestors.has(value)) return `${path} 不能包含循环引用。`;

    ancestors.add(value);
    const keys = Reflect.ownKeys(value);

    if (Array.isArray(value)) {
      const expectedKeys = new Set(Array.from({ length: value.length }, (_, index) => String(index)));

      for (const key of keys) {
        if (key === "length") continue;
        if (typeof key !== "string" || !expectedKeys.has(key)) {
          ancestors.delete(value);
          return `${path} 包含无法用 JSON 保留的数组属性。`;
        }
        expectedKeys.delete(key);
      }
      if (expectedKeys.size) {
        ancestors.delete(value);
        return `${path} 不能是稀疏数组。`;
      }
    }

    for (const key of keys) {
      if (Array.isArray(value) && key === "length") continue;
      if (typeof key === "symbol") {
        ancestors.delete(value);
        return `${path} 不能包含 Symbol 属性。`;
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || descriptor.get || descriptor.set || !("value" in descriptor)) {
        ancestors.delete(value);
        return `${path}.${key} 必须是可枚举的数据属性。`;
      }

      const nestedError = findJsonError(descriptor.value, `${path}.${key}`, ancestors);
      if (nestedError) {
        ancestors.delete(value);
        return nestedError;
      }
    }

    ancestors.delete(value);
    return null;
  }

  function cloneJson(value, path = "value") {
    const error = findJsonError(value, path);
    if (error) throw new Error(error);
    return structuredClone(value);
  }

  function isValidTimestamp(value, nullable = false) {
    if (nullable && value === null) return true;
    return typeof value === "string" &&
      Boolean(value.trim()) &&
      Number.isFinite(Date.parse(value));
  }

  function isCanonicalTimestamp(value, nullable = false) {
    if (nullable && value === null) return true;
    if (typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
      return false;
    }
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  }

  function findOutOfBoundField(value, path = "favorite") {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) {
        const nested = findOutOfBoundField(value[index], `${path}[${index}]`);
        if (nested) return nested;
      }
      return null;
    }
    if (!isPlainObject(value)) return null;

    for (const [key, nestedValue] of Object.entries(value)) {
      if (OUT_OF_BOUND_FIELDS.has(key)) return `${path}.${key}`;
      const nested = findOutOfBoundField(nestedValue, `${path}.${key}`);
      if (nested) return nested;
    }
    return null;
  }

  function validateFieldBoundaries(value) {
    const path = findOutOfBoundField(value);
    if (path) throw new Error(`${path} 不属于 Favorite Entity。`);
  }

  function validateFavorite(value, options = {}) {
    if (!isPlainObject(value)) throw new Error("Favorite 必须是普通 JSON 对象。");
    const jsonError = findJsonError(value, "favorite");
    if (jsonError) throw new Error(jsonError);

    validateFieldBoundaries(value);

    if (options.requireIdentity !== false) {
      if (typeof value.id !== "string" || !value.id.trim() || value.id !== value.id.trim()) {
        throw new Error("Favorite 缺少有效的稳定 ID。");
      }
      if (!isValidTimestamp(value.createdAt) ||
          !isValidTimestamp(value.updatedAt) ||
          !isValidTimestamp(value.deletedAt, true)) {
        throw new Error("Favorite 生命周期时间无效。");
      }
      const createdTime = Date.parse(value.createdAt);
      const updatedTime = Date.parse(value.updatedAt);
      const deletedTime = value.deletedAt === null ? null : Date.parse(value.deletedAt);
      if (createdTime > updatedTime ||
          (deletedTime !== null && (deletedTime < createdTime || deletedTime > updatedTime))) {
        throw new Error("Favorite 生命周期时间顺序无效。");
      }
    }

    if (!FAVORITE_TYPES.has(value.type)) {
      throw new Error("Favorite type 必须是 word 或 phrase。");
    }
    if (typeof value.text !== "string" || !value.text.trim()) {
      throw new Error("Favorite text 不能为空。");
    }

    for (const key of OPTIONAL_TEXT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(value, key) && typeof value[key] !== "string") {
        throw new Error(`Favorite ${key} 必须是字符串。`);
      }
    }

    if (Object.prototype.hasOwnProperty.call(value, "tags")) {
      if (!Array.isArray(value.tags) || value.tags.some(tag => typeof tag !== "string")) {
        throw new Error("Favorite tags 必须是字符串数组。");
      }
    }

    if (Object.prototype.hasOwnProperty.call(value, "origin") && value.origin !== null) {
      if (!isPlainObject(value.origin)) throw new Error("Favorite origin 必须是普通 JSON 对象。");
      if (Object.prototype.hasOwnProperty.call(value.origin, "kind") &&
          (typeof value.origin.kind !== "string" || !value.origin.kind.trim())) {
        throw new Error("Favorite origin.kind 不能为空。");
      }
      if (Object.prototype.hasOwnProperty.call(value.origin, "articleId") &&
          (typeof value.origin.articleId !== "string" ||
           !value.origin.articleId.trim() ||
           value.origin.articleId !== value.origin.articleId.trim())) {
        throw new Error("Favorite origin.articleId 必须是非空字符串。");
      }
      if (Object.prototype.hasOwnProperty.call(value.origin, "articleTitleSnapshot") &&
          typeof value.origin.articleTitleSnapshot !== "string") {
        throw new Error("Favorite origin.articleTitleSnapshot 必须是字符串。");
      }
    }
  }

  function parseRecords(raw) {
    if (raw === null) return Object.create(null);

    let records;
    try {
      records = JSON.parse(raw);
    } catch {
      throw new Error("Favorite 存储数据损坏，无法读取。");
    }

    if (!isPlainObject(records)) {
      throw new Error("Favorite 存储根结构无效。");
    }

    const safeRecords = Object.create(null);
    for (const [id, favorite] of Object.entries(records)) {
      validateFavorite(favorite);
      if (favorite.id !== id) {
        throw new Error("Favorite 存储索引与实体 ID 不一致。");
      }
      Object.defineProperty(safeRecords, id, {
        value: favorite,
        enumerable: true,
        configurable: true,
        writable: true
      });
    }

    return safeRecords;
  }

  function readRecordsSnapshot() {
    const raw = localStorage.getItem(STORAGE_KEY);
    return { raw, records: parseRecords(raw) };
  }

  function readRecords() {
    return readRecordsSnapshot().records;
  }

  function writeRecords(records) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  }

  function createFavoriteId() {
    if (window.crypto?.randomUUID) return `favorite:${window.crypto.randomUUID()}`;

    if (window.crypto?.getRandomValues) {
      const bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      return `favorite:${Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
    }

    throw new Error("当前浏览器不支持安全随机数，无法创建 Favorite。");
  }

  function allocateFavoriteId(records) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const id = createFavoriteId();
      if (!Object.prototype.hasOwnProperty.call(records, id)) return id;
    }
    throw new Error("无法生成唯一的 Favorite ID。");
  }

  function nextTimestamp(previous = null) {
    const now = Date.now();
    const previousTime = Date.parse(previous || "");
    return new Date(Number.isFinite(previousTime) ? Math.max(now, previousTime + 1) : now).toISOString();
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

  function getBackupCandidateId(value) {
    if (!isPlainObject(value)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, "id");
    return descriptor &&
      descriptor.enumerable &&
      !descriptor.get &&
      !descriptor.set &&
      typeof descriptor.value === "string" &&
      descriptor.value.trim() &&
      descriptor.value === descriptor.value.trim()
      ? descriptor.value
      : null;
  }

  function validateBackupFavorite(value) {
    validateFavorite(value);
    if (!isCanonicalTimestamp(value.createdAt) ||
        !isCanonicalTimestamp(value.updatedAt) ||
        !isCanonicalTimestamp(value.deletedAt, true)) {
      throw new Error("Favorite Backup 生命周期时间必须是规范的 ISO 8601 UTC 字符串。");
    }
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
    if (!current) return createBackupRestoreResult("restored", incoming.id);

    const fields = Array.from(new Set([
      ...Object.keys(current),
      ...Object.keys(incoming)
    ])).sort();
    const conflictFields = fields.filter(field => !valuesEqual(current[field], incoming[field]));
    if (!conflictFields.length) {
      return createBackupRestoreResult("unchanged", incoming.id);
    }

    const conflicts = new Set();
    for (const field of conflictFields) {
      if (BACKUP_LIFECYCLE_FIELDS.has(field)) conflicts.add("lifecycle");
      else if (field === "origin") conflicts.add("source");
      else if (BACKUP_CONTENT_FIELDS.has(field)) conflicts.add("content");
      else if (field !== "id") conflicts.add("metadata");
    }

    return createBackupRestoreResult("conflict", incoming.id, {
      conflicts: Array.from(conflicts).sort(),
      conflictFields
    });
  }

  function snapshotBackupFavorite(value) {
    const snapshot = cloneJson(value, "favorite");
    validateBackupFavorite(snapshot);
    return snapshot;
  }

  function assessBackupRestore(value) {
    let incoming;
    try {
      incoming = snapshotBackupFavorite(value);
    } catch {
      return createBackupRestoreResult("rejected", getBackupCandidateId(value), {
        reason: "invalid-favorite"
      });
    }

    try {
      return classifyBackupRestore(getOwnRecord(readRecords(), incoming.id), incoming);
    } catch {
      return createBackupRestoreResult("rejected", incoming.id, {
        reason: "favorite-storage-read-failed"
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

  function rejectBackupBatch(total, invalidItems, errors, candidates = []) {
    const invalidIndexes = new Set(invalidItems.map(item => item.index));
    const items = Array.from({ length: total }, (_, index) => {
      const invalid = invalidItems.find(item => item.index === index);
      if (invalid) return invalid;
      return {
        index,
        favoriteId: getBackupCandidateId(candidates[index]),
        status: "not-attempted",
        written: false,
        conflicts: [],
        conflictFields: []
      };
    });
    const summary = summarizeRestoreItems(total, items);
    summary.notAttempted = total - invalidIndexes.size;
    return { status: "rejected", summary, items, errors };
  }

  function snapshotBackupFavorites(values) {
    if (!Array.isArray(values)) {
      return {
        rejection: rejectBackupBatch(0, [], [{ code: "invalid-favorites" }])
      };
    }

    let snapshots;
    try {
      snapshots = cloneJson(values, "favorites");
    } catch (error) {
      return {
        rejection: rejectBackupBatch(values.length, [], [{
          code: "invalid-favorites",
          message: error.message
        }])
      };
    }

    const invalidItems = [];
    const errors = [];
    const identities = new Map();
    for (let index = 0; index < snapshots.length; index += 1) {
      const favorite = snapshots[index];
      let favoriteId = getBackupCandidateId(favorite);
      try {
        validateBackupFavorite(favorite);
        favoriteId = favorite.id;
      } catch (error) {
        invalidItems.push({
          index,
          favoriteId,
          status: "rejected",
          written: false,
          conflicts: [],
          conflictFields: [],
          reason: "invalid-favorite"
        });
        errors.push({
          code: "invalid-favorite",
          index,
          ...(favoriteId ? { favoriteId } : {}),
          message: error.message
        });
        continue;
      }

      if (identities.has(favoriteId)) {
        invalidItems.push({
          index,
          favoriteId,
          status: "rejected",
          written: false,
          conflicts: [],
          conflictFields: [],
          reason: "duplicate-favorite-id"
        });
        errors.push({
          code: "duplicate-favorite-id",
          index,
          favoriteId,
          conflictingIndex: identities.get(favoriteId)
        });
      } else {
        identities.set(favoriteId, index);
      }
    }

    return invalidItems.length
      ? { rejection: rejectBackupBatch(snapshots.length, invalidItems, errors, snapshots) }
      : { snapshots };
  }

  function interruptBackupRestore(total, assessedItems, details, candidates = []) {
    let failedAssigned = false;
    const items = assessedItems.length
      ? assessedItems.map(item => {
          if (item.status !== "restored") return item;
          if (details.markFailed && !failedAssigned) {
            failedAssigned = true;
            return {
              index: item.index,
              favoriteId: item.favoriteId,
              status: "failed",
              written: false,
              conflicts: [],
              conflictFields: []
            };
          }
          return {
            index: item.index,
            favoriteId: item.favoriteId,
            status: "not-attempted",
            written: false,
            conflicts: [],
            conflictFields: []
          };
        })
      : Array.from({ length: total }, (_, index) => ({
          index,
          favoriteId: getBackupCandidateId(candidates[index]),
          status: "not-attempted",
          written: false,
          conflicts: [],
          conflictFields: []
        }));
    return {
      status: "interrupted",
      summary: summarizeRestoreItems(total, items),
      items,
      errors: [{
        code: details.code,
        ...(details.message ? { message: details.message } : {})
      }]
    };
  }

  function restoreBackupRecords(values) {
    const batch = snapshotBackupFavorites(values);
    if (batch.rejection) return batch.rejection;

    let storageSnapshot;
    try {
      storageSnapshot = readRecordsSnapshot();
    } catch (error) {
      return interruptBackupRestore(batch.snapshots.length, [], {
        code: "favorite-storage-read-failed",
        message: error.message
      }, batch.snapshots);
    }
    const records = storageSnapshot.records;
    const assessedItems = batch.snapshots.map((favorite, index) => ({
      index,
      ...classifyBackupRestore(getOwnRecord(records, favorite.id), favorite)
    }));

    const restorableIndexes = assessedItems
      .filter(item => item.status === "restored")
      .map(item => item.index);

    if (restorableIndexes.length) {
      for (const index of restorableIndexes) {
        const favorite = batch.snapshots[index];
        Object.defineProperty(records, favorite.id, {
          value: favorite,
          enumerable: true,
          configurable: true,
          writable: true
        });
      }
      let currentRaw;
      try {
        currentRaw = localStorage.getItem(STORAGE_KEY);
      } catch (error) {
        return interruptBackupRestore(batch.snapshots.length, assessedItems, {
          code: "favorite-storage-read-failed",
          message: error.message
        });
      }
      if (currentRaw !== storageSnapshot.raw) {
        return interruptBackupRestore(batch.snapshots.length, assessedItems, {
          code: "favorite-storage-changed"
        });
      }
      try {
        writeRecords(records);
      } catch (error) {
        return interruptBackupRestore(batch.snapshots.length, assessedItems, {
          code: "favorite-storage-write-failed",
          message: error.message,
          markFailed: true
        });
      }
    }

    const items = assessedItems.map(item => item.status === "restored"
      ? { ...item, written: true }
      : item);
    const summary = summarizeRestoreItems(batch.snapshots.length, items);
    return {
      status: summary.conflicts ? "completed-with-conflicts" : "completed",
      summary,
      items,
      errors: []
    };
  }

  function mergeJsonObjects(base, patch) {
    const result = cloneJson(base, "favorite");
    for (const [key, value] of Object.entries(patch)) {
      const currentValue = Object.prototype.hasOwnProperty.call(result, key)
        ? result[key]
        : undefined;
      const nextValue = isPlainObject(currentValue) && isPlainObject(value)
        ? mergeJsonObjects(currentValue, value)
        : cloneJson(value, `patch.${key}`);
      Object.defineProperty(result, key, {
        value: nextValue,
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return result;
  }

  function normalizeId(id) {
    return typeof id === "string" ? id.trim() : "";
  }

  function normalizeOptions(options, path = "options") {
    if (options === undefined) return {};
    if (!isPlainObject(options)) throw new Error(`${path} 必须是普通 JSON 对象。`);
    const snapshot = cloneJson(options, path);
    for (const key of ["includeDeleted", "deletedOnly"]) {
      if (Object.prototype.hasOwnProperty.call(snapshot, key) && typeof snapshot[key] !== "boolean") {
        throw new Error(`${path}.${key} 必须是布尔值。`);
      }
    }
    return snapshot;
  }

  function getOwnRecord(records, id) {
    return Object.prototype.hasOwnProperty.call(records, id) ? records[id] : null;
  }

  function normalizeContentText(value) {
    return String(value || "")
      .replace(/’/g, "'")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function createPlan(operation, before, candidate, changed) {
    return {
      operation,
      entityId: candidate.id,
      before: before === null ? null : cloneJson(before, "favorite"),
      candidate: cloneJson(candidate, "favorite"),
      changed: Boolean(changed)
    };
  }

  function validateCreateInput(input) {
    if (!isPlainObject(input)) throw new Error("Favorite 创建输入必须是普通 JSON 对象。");
    for (const key of CREATE_RESERVED_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(input, key)) {
        throw new Error(`Favorite 创建输入不能指定 ${key}。`);
      }
    }
    const snapshot = cloneJson(input, "favorite");
    validateFavorite(snapshot, { requireIdentity: false });
    return snapshot;
  }

  function planCreate(input) {
    const snapshot = validateCreateInput(input);
    const records = readRecords();
    const id = allocateFavoriteId(records);
    const now = nextTimestamp();
    const candidate = {
      ...snapshot,
      id,
      type: snapshot.type,
      text: snapshot.text,
      createdAt: now,
      updatedAt: now,
      deletedAt: null
    };
    validateFavorite(candidate);
    return createPlan("create", null, candidate, true);
  }

  function planUpdate(id, patch = {}) {
    const favoriteId = normalizeId(id);
    if (!favoriteId) throw new Error("缺少 Favorite ID。");
    if (!isPlainObject(patch)) throw new Error("Favorite 更新必须是普通 JSON 对象。");
    for (const key of UPDATE_PROTECTED_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        throw new Error(`Favorite 更新不能修改 ${key}。`);
      }
    }

    const patchSnapshot = cloneJson(patch, "patch");
    validateFieldBoundaries(patchSnapshot);
    const current = getOwnRecord(readRecords(), favoriteId);
    if (!current) throw new Error("要更新的 Favorite 不存在。");
    if (current.deletedAt) throw new Error("已删除的 Favorite 必须先恢复再更新。");

    const candidate = mergeJsonObjects(current, patchSnapshot);
    candidate.id = current.id;
    candidate.createdAt = current.createdAt;
    candidate.updatedAt = current.updatedAt;
    candidate.deletedAt = null;
    validateFavorite(candidate);
    if (valuesEqual(current, candidate)) {
      return createPlan("update", current, current, false);
    }
    candidate.updatedAt = nextTimestamp(current.updatedAt);
    validateFavorite(candidate);
    return createPlan("update", current, candidate, true);
  }

  function planSoftDelete(id) {
    const favoriteId = normalizeId(id);
    if (!favoriteId) return null;
    const current = getOwnRecord(readRecords(), favoriteId);
    if (!current) return null;
    if (current.deletedAt) return createPlan("soft-delete", current, current, false);

    const deletedAt = nextTimestamp(current.updatedAt);
    const candidate = {
      ...current,
      updatedAt: deletedAt,
      deletedAt
    };
    validateFavorite(candidate);
    return createPlan("soft-delete", current, candidate, true);
  }

  function planRestore(id) {
    const favoriteId = normalizeId(id);
    if (!favoriteId) return null;
    const current = getOwnRecord(readRecords(), favoriteId);
    if (!current) return null;
    if (!current.deletedAt) return createPlan("restore", current, current, false);

    const candidate = {
      ...current,
      updatedAt: nextTimestamp(current.updatedAt),
      deletedAt: null
    };
    validateFavorite(candidate);
    return createPlan("restore", current, candidate, true);
  }

  function snapshotPlannedMutation(value) {
    if (!isPlainObject(value)) throw new Error("Favorite mutation plan 必须是普通对象。");
    const plan = cloneJson(value, "plan");
    const keys = Object.keys(plan).sort();
    const expectedKeys = ["before", "candidate", "changed", "entityId", "operation"].sort();
    if (keys.length !== expectedKeys.length ||
        !keys.every((key, index) => key === expectedKeys[index]) ||
        !PLANNED_OPERATIONS.has(plan.operation) ||
        typeof plan.changed !== "boolean" ||
        typeof plan.entityId !== "string" ||
        !plan.entityId.trim() ||
        plan.entityId !== plan.entityId.trim()) {
      throw new Error("Favorite mutation plan 结构无效。");
    }

    if (plan.before !== null) validateFavorite(plan.before);
    validateFavorite(plan.candidate);
    if (plan.candidate.id !== plan.entityId ||
        (plan.before !== null && plan.before.id !== plan.entityId)) {
      throw new Error("Favorite mutation plan identity 不一致。");
    }
    if (plan.operation === "create") {
      if (plan.before !== null || plan.candidate.deletedAt !== null || !plan.changed) {
        throw new Error("Favorite create plan 无效。");
      }
    } else if (plan.before === null) {
      throw new Error("非 create plan 缺少 expected-current snapshot。");
    }
    if (plan.before !== null && plan.candidate.createdAt !== plan.before.createdAt) {
      throw new Error("Favorite mutation plan 不能修改 createdAt。");
    }
    if (plan.operation === "update" &&
        (plan.before.deletedAt !== null || plan.candidate.deletedAt !== null)) {
      throw new Error("Favorite update plan 生命周期无效。");
    }
    if (plan.operation === "soft-delete" &&
        (plan.before.deletedAt !== null || plan.candidate.deletedAt === null)) {
      throw new Error("Favorite delete plan 生命周期无效。");
    }
    if (plan.operation === "restore" &&
        (plan.before.deletedAt === null || plan.candidate.deletedAt !== null)) {
      throw new Error("Favorite restore plan 生命周期无效。");
    }
    if (plan.changed === valuesEqual(plan.before, plan.candidate)) {
      throw new Error("Favorite mutation plan changed 标记无效。");
    }
    return plan;
  }

  function commitPlannedMutation(value) {
    const plan = snapshotPlannedMutation(value);
    const storageSnapshot = readRecordsSnapshot();
    const current = getOwnRecord(storageSnapshot.records, plan.entityId);
    if (!valuesEqual(current, plan.before)) {
      return {
        status: "stale-local-state",
        entityId: plan.entityId,
        written: false,
        favorite: current === null ? null : cloneJson(current, "favorite")
      };
    }
    if (!plan.changed) {
      return {
        status: "unchanged",
        entityId: plan.entityId,
        written: false,
        favorite: cloneJson(plan.candidate, "favorite")
      };
    }

    if (localStorage.getItem(STORAGE_KEY) !== storageSnapshot.raw) {
      return {
        status: "stale-local-state",
        entityId: plan.entityId,
        written: false,
        favorite: current === null ? null : cloneJson(current, "favorite")
      };
    }
    Object.defineProperty(storageSnapshot.records, plan.entityId, {
      value: plan.candidate,
      enumerable: true,
      configurable: true,
      writable: true
    });
    writeRecords(storageSnapshot.records);
    return {
      status: "committed",
      entityId: plan.entityId,
      written: true,
      favorite: cloneJson(plan.candidate, "favorite")
    };
  }

  function commitExactSnapshot(value) {
    if (!isPlainObject(value)) throw new Error("Favorite exact snapshot commit 必须是普通对象。");
    const input = cloneJson(value, "commit");
    const keys = Object.keys(input).sort();
    const expectedKeys = ["candidate", "entityId", "expectedCurrent"].sort();
    if (keys.length !== expectedKeys.length ||
        !keys.every((key, index) => key === expectedKeys[index])) {
      throw new Error("Favorite exact snapshot commit 结构无效。");
    }

    const entityId = normalizeId(input.entityId);
    if (!entityId || entityId !== input.entityId) {
      throw new Error("Favorite exact snapshot commit identity 无效。");
    }
    if (input.expectedCurrent !== null) validateFavorite(input.expectedCurrent);
    validateFavorite(input.candidate);
    if (input.candidate.id !== entityId ||
        (input.expectedCurrent !== null && input.expectedCurrent.id !== entityId)) {
      throw new Error("Favorite exact snapshot commit identity 不一致。");
    }

    const storageSnapshot = readRecordsSnapshot();
    const current = getOwnRecord(storageSnapshot.records, entityId);
    if (valuesEqual(current, input.candidate)) {
      return {
        status: "unchanged",
        entityId,
        written: false,
        favorite: cloneJson(input.candidate, "favorite")
      };
    }
    if (!valuesEqual(current, input.expectedCurrent)) {
      return {
        status: "stale-local-state",
        entityId,
        written: false,
        favorite: current === null ? null : cloneJson(current, "favorite")
      };
    }
    if (localStorage.getItem(STORAGE_KEY) !== storageSnapshot.raw) {
      return {
        status: "stale-local-state",
        entityId,
        written: false,
        favorite: current === null ? null : cloneJson(current, "favorite")
      };
    }

    Object.defineProperty(storageSnapshot.records, entityId, {
      value: input.candidate,
      enumerable: true,
      configurable: true,
      writable: true
    });
    writeRecords(storageSnapshot.records);
    return {
      status: "committed",
      entityId,
      written: true,
      favorite: cloneJson(input.candidate, "favorite")
    };
  }

  function create(input) {
    const snapshot = validateCreateInput(input);

    const records = readRecords();
    const id = allocateFavoriteId(records);
    const now = nextTimestamp();
    const favorite = {
      ...snapshot,
      id,
      type: snapshot.type,
      text: snapshot.text,
      createdAt: now,
      updatedAt: now,
      deletedAt: null
    };

    validateFavorite(favorite);
    records[id] = favorite;
    writeRecords(records);
    return cloneJson(favorite, "favorite");
  }

  function getById(id, options = {}) {
    const favoriteId = normalizeId(id);
    if (!favoriteId) return null;

    const normalizedOptions = normalizeOptions(options);
    const favorite = getOwnRecord(readRecords(), favoriteId);
    if (!favorite || (normalizedOptions.includeDeleted === false && favorite.deletedAt)) return null;
    return cloneJson(favorite, "favorite");
  }

  function list(options = {}) {
    const normalizedOptions = normalizeOptions(options);
    const includeDeleted = Boolean(normalizedOptions.includeDeleted);
    const deletedOnly = Boolean(normalizedOptions.deletedOnly);

    return Object.values(readRecords())
      .filter(favorite => deletedOnly ? Boolean(favorite.deletedAt) : includeDeleted || !favorite.deletedAt)
      .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
      .map(favorite => cloneJson(favorite, "favorite"));
  }

  function findByContent(query = {}) {
    if (!isPlainObject(query)) throw new Error("Favorite 内容查询必须是普通 JSON 对象。");
    const normalizedQuery = cloneJson(query, "query");
    if (!FAVORITE_TYPES.has(normalizedQuery.type)) {
      throw new Error("Favorite 内容查询需要有效的 type。");
    }
    if (typeof normalizedQuery.text !== "string" || !normalizedQuery.text.trim()) {
      throw new Error("Favorite 内容查询需要非空 text。");
    }
    if (Object.prototype.hasOwnProperty.call(normalizedQuery, "includeDeleted") &&
        typeof normalizedQuery.includeDeleted !== "boolean") {
      throw new Error("query.includeDeleted 必须是布尔值。");
    }

    const identity = normalizeContentText(normalizedQuery.text);
    return list({ includeDeleted: Boolean(normalizedQuery.includeDeleted) })
      .filter(favorite => (
        favorite.type === normalizedQuery.type && normalizeContentText(favorite.text) === identity
      ));
  }

  function update(id, patch = {}) {
    const favoriteId = normalizeId(id);
    if (!favoriteId) throw new Error("缺少 Favorite ID。");
    if (!isPlainObject(patch)) throw new Error("Favorite 更新必须是普通 JSON 对象。");

    for (const key of UPDATE_PROTECTED_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        throw new Error(`Favorite 更新不能修改 ${key}。`);
      }
    }

    const patchSnapshot = cloneJson(patch, "patch");
    validateFieldBoundaries(patchSnapshot);

    const records = readRecords();
    const current = getOwnRecord(records, favoriteId);
    if (!current) throw new Error("要更新的 Favorite 不存在。");
    if (current.deletedAt) throw new Error("已删除的 Favorite 必须先恢复再更新。");

    const next = mergeJsonObjects(current, patchSnapshot);
    next.id = current.id;
    next.createdAt = current.createdAt;
    next.updatedAt = current.updatedAt;
    next.deletedAt = null;
    validateFavorite(next);

    if (valuesEqual(current, next)) return cloneJson(current, "favorite");

    next.updatedAt = nextTimestamp(current.updatedAt);
    records[favoriteId] = next;
    writeRecords(records);
    return cloneJson(next, "favorite");
  }

  function softDelete(id) {
    const favoriteId = normalizeId(id);
    if (!favoriteId) return null;

    const records = readRecords();
    const current = getOwnRecord(records, favoriteId);
    if (!current) return null;
    if (current.deletedAt) return cloneJson(current, "favorite");

    const deletedAt = nextTimestamp(current.updatedAt);
    const next = {
      ...current,
      updatedAt: deletedAt,
      deletedAt
    };
    validateFavorite(next);
    records[favoriteId] = next;
    writeRecords(records);
    return cloneJson(next, "favorite");
  }

  function restore(id) {
    const favoriteId = normalizeId(id);
    if (!favoriteId) return null;

    const records = readRecords();
    const current = getOwnRecord(records, favoriteId);
    if (!current) return null;
    if (!current.deletedAt) return cloneJson(current, "favorite");

    const next = {
      ...current,
      updatedAt: nextTimestamp(current.updatedAt),
      deletedAt: null
    };
    validateFavorite(next);
    records[favoriteId] = next;
    writeRecords(records);
    return cloneJson(next, "favorite");
  }

  function count(options = {}) {
    return list(options).length;
  }

  function getStorageBytes() {
    const value = localStorage.getItem(STORAGE_KEY) || "";
    return new TextEncoder().encode(value).length;
  }

  window.LingoFlowFavoriteRepository = Object.freeze({
    create,
    getById,
    list,
    findByContent,
    update,
    softDelete,
    restore,
    planCreate,
    planUpdate,
    planSoftDelete,
    planRestore,
    commitPlannedMutation,
    commitExactSnapshot,
    assessBackupRestore,
    restoreBackupRecords,
    count,
    getStorageBytes
  });
})();
