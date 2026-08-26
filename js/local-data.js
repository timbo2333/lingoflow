(function() {
  "use strict";

  const FAVORITES_STORAGE_KEY = "EnglishReaderV051Favorites";
  const QUERY_EVENTS_KEY = "EnglishReaderV052QueryEvents";
  const VOCAB_STORAGE_KEY = "EnglishReaderV05Vocab";
  const HISTORY_BASELINES_KEY = "EnglishReaderV052HistoryBaselines";
  const HISTORY_MIGRATION_STATE_KEY = "EnglishReaderV052HistoryMigrationState";
  const DEVICE_ID_KEY = "EnglishReaderV052DeviceId";
  const READING_PREFS_KEY = "EnglishReaderV052ReadingPrefs";
  const HISTORY_MIGRATION_COMPLETED_STATE = Object.freeze({
    version: 1,
    status: "completed"
  });

  function readJson(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "{}");
    } catch {
      return {};
    }
  }

  function writeJson(key, data) {
    localStorage.setItem(key, JSON.stringify(data));
    return data;
  }

  function readJsonObjectStrict(key) {
    const raw = localStorage.getItem(key);
    if (raw === null) return {};

    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Stored value for ${key} must be a JSON object.`);
    }
    return value;
  }

  function hasStoredJsonObjectEntries(key) {
    const raw = localStorage.getItem(key);
    if (raw === null) return false;

    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) return true;
      return Object.keys(value).length > 0;
    } catch {
      return true;
    }
  }

  function makeId(prefix) {
    if (window.crypto?.randomUUID) {
      return `${prefix}:${window.crypto.randomUUID()}`;
    }
    return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}:${Math.random().toString(36).slice(2)}`;
  }

  const FavoriteData = Object.freeze({
    getAll() {
      return readJson(FAVORITES_STORAGE_KEY);
    },

    setAll(data) {
      return writeJson(FAVORITES_STORAGE_KEY, data);
    },

    getStorageBytes() {
      const value = localStorage.getItem(FAVORITES_STORAGE_KEY) || "";
      return new TextEncoder().encode(value).length;
    },

    remove(favoriteKey) {
      const favorites = readJson(FAVORITES_STORAGE_KEY) || {};
      delete favorites[favoriteKey];
      return writeJson(FAVORITES_STORAGE_KEY, favorites);
    }
  });

  const QueryData = Object.freeze({
    getEvents() {
      return readJson(QUERY_EVENTS_KEY);
    },

    setEvents(data) {
      return writeJson(QUERY_EVENTS_KEY, data || {});
    },

    getVocab() {
      return readJson(VOCAB_STORAGE_KEY);
    },

    setVocab(data) {
      return writeJson(VOCAB_STORAGE_KEY, data);
    },

    getVocabStorageBytes() {
      const value = localStorage.getItem(VOCAB_STORAGE_KEY) || "";
      return new TextEncoder().encode(value).length;
    },

    getHistoryBaselines() {
      return readJson(HISTORY_BASELINES_KEY);
    },

    setHistoryBaselines(data) {
      return writeJson(HISTORY_BASELINES_KEY, data || {});
    },

    hasEventsStorage() {
      return localStorage.getItem(QUERY_EVENTS_KEY) !== null;
    },

    hasHistoryBaselineRecords() {
      return hasStoredJsonObjectEntries(HISTORY_BASELINES_KEY);
    },

    hasHistoryMigrationState() {
      return localStorage.getItem(HISTORY_MIGRATION_STATE_KEY) !== null;
    },

    getVocabForHistoryMigration() {
      return readJsonObjectStrict(VOCAB_STORAGE_KEY);
    },

    markHistoryMigrationCompleted() {
      return writeJson(
        HISTORY_MIGRATION_STATE_KEY,
        HISTORY_MIGRATION_COMPLETED_STATE
      );
    },

    clearHistory() {
      localStorage.removeItem(VOCAB_STORAGE_KEY);
      localStorage.removeItem(QUERY_EVENTS_KEY);
      localStorage.removeItem(HISTORY_BASELINES_KEY);
    },

    getDeviceId() {
      let deviceId = localStorage.getItem(DEVICE_ID_KEY);
      if (!deviceId) {
        deviceId = makeId("device");
        localStorage.setItem(DEVICE_ID_KEY, deviceId);
      }
      return deviceId;
    }
  });

  const PreferenceData = Object.freeze({
    get() {
      return readJson(READING_PREFS_KEY);
    },

    patch(changes) {
      const current = readJson(READING_PREFS_KEY) || {};
      const next = { ...current, ...(changes || {}) };
      return writeJson(READING_PREFS_KEY, next);
    },

    replace(data) {
      return writeJson(READING_PREFS_KEY, data);
    }
  });

  window.LingoFlowLocalData = Object.freeze({
    FavoriteData,
    QueryData,
    PreferenceData
  });
})();
