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

  function createLocalDataError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function readStorageValue(key, failureCode, label) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      throw createLocalDataError(
        failureCode,
        error?.message || `${label} storage read failed.`
      );
    }
  }

  function parseStoredJson(raw, malformedCode, label) {
    try {
      return JSON.parse(raw);
    } catch {
      throw createLocalDataError(malformedCode, `${label} storage is malformed JSON.`);
    }
  }

  function readHistoryMigrationState() {
    const raw = readStorageValue(
      HISTORY_MIGRATION_STATE_KEY,
      "history-migration-state-storage-read-failed",
      "Query History migration state"
    );
    if (raw === null) return { status: "missing", state: null, raw: null };

    const value = parseStoredJson(
      raw,
      "history-migration-state-malformed",
      "Query History migration state"
    );
    const keys = isPlainObject(value) ? Object.keys(value).sort() : [];
    if (!isPlainObject(value) ||
        keys.length !== 2 ||
        keys[0] !== "status" ||
        keys[1] !== "version" ||
        value.version !== HISTORY_MIGRATION_COMPLETED_STATE.version ||
        value.status !== HISTORY_MIGRATION_COMPLETED_STATE.status) {
      throw createLocalDataError(
        "history-migration-state-invalid",
        "Query History migration state has an unsupported shape or value."
      );
    }

    return {
      status: "completed",
      state: {
        version: HISTORY_MIGRATION_COMPLETED_STATE.version,
        status: HISTORY_MIGRATION_COMPLETED_STATE.status
      },
      raw
    };
  }

  function readVocabForHistoryMigration() {
    const raw = readStorageValue(
      VOCAB_STORAGE_KEY,
      "history-migration-vocab-storage-read-failed",
      "Legacy Vocab"
    );
    if (raw === null) return { status: "missing", vocab: {}, raw: null };

    const value = parseStoredJson(
      raw,
      "history-migration-vocab-malformed",
      "Legacy Vocab"
    );
    if (!isPlainObject(value)) {
      throw createLocalDataError(
        "history-migration-vocab-invalid-root",
        "Legacy Vocab storage root must be a plain JSON object."
      );
    }
    return { status: "present", vocab: value, raw };
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

    readHistoryMigrationState,

    hasHistoryMigrationState() {
      return readHistoryMigrationState().status === "completed";
    },

    getVocabForHistoryMigration() {
      return readVocabForHistoryMigration().vocab;
    },

    readVocabForHistoryMigration,

    markHistoryMigrationCompleted(expectedRaw) {
      if (arguments.length > 0) {
        const currentRaw = readStorageValue(
          HISTORY_MIGRATION_STATE_KEY,
          "history-migration-state-storage-read-failed",
          "Query History migration state"
        );
        if (currentRaw !== expectedRaw) {
          throw createLocalDataError(
            "history-migration-state-storage-changed",
            "Query History migration state changed before completion."
          );
        }
      }

      try {
        localStorage.setItem(
          HISTORY_MIGRATION_STATE_KEY,
          JSON.stringify(HISTORY_MIGRATION_COMPLETED_STATE)
        );
      } catch (error) {
        throw createLocalDataError(
          "history-migration-state-storage-write-failed",
          error?.message || "Query History migration state storage write failed."
        );
      }
      return {
        version: HISTORY_MIGRATION_COMPLETED_STATE.version,
        status: HISTORY_MIGRATION_COMPLETED_STATE.status
      };
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
