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
    "reviewInterval",
    "nextReviewAt",
    "dictionaryFound",
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
          (typeof value.origin.articleId !== "string" || !value.origin.articleId.trim())) {
        throw new Error("Favorite origin.articleId 必须是非空字符串。");
      }
      if (Object.prototype.hasOwnProperty.call(value.origin, "articleTitleSnapshot") &&
          typeof value.origin.articleTitleSnapshot !== "string") {
        throw new Error("Favorite origin.articleTitleSnapshot 必须是字符串。");
      }
    }
  }

  function readRecords() {
    const raw = localStorage.getItem(STORAGE_KEY);
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

  function create(input) {
    if (!isPlainObject(input)) throw new Error("Favorite 创建输入必须是普通 JSON 对象。");

    for (const key of CREATE_RESERVED_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(input, key)) {
        throw new Error(`Favorite 创建输入不能指定 ${key}。`);
      }
    }

    const snapshot = cloneJson(input, "favorite");
    validateFavorite(snapshot, { requireIdentity: false });

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
    count,
    getStorageBytes
  });
})();
