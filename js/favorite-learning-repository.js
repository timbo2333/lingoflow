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
    if (typeof value !== "string" || !value) return false;
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
    setMastered,
    remove,
    restore,
    list,
    getStorageBytes
  });
})();
