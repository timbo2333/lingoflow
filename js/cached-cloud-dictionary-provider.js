(function initCachedCloudDictionaryProvider(global) {
  "use strict";

  const CACHE_DB_NAME = "LingoFlowDictionaryCacheDB";
  const CACHE_DB_VERSION = 1;
  const CACHE_STORE_NAME = "lookups";
  const DICTIONARY_DATA_VERSION =
    "core-2026-08-16-e15991ce6e92";

  function createCacheKey(dataVersion, canonicalWord) {
    return `${dataVersion}:${canonicalWord}`;
  }

  function nullableText(value) {
    if (value === null || value === undefined || value === "") return null;
    return typeof value === "string" ? value : null;
  }

  function isNullableString(value) {
    return value === null || typeof value === "string";
  }

  function validateRecord(record, expected = {}) {
    if (!record || typeof record !== "object" || Array.isArray(record) ||
        record.cacheKey !== expected.cacheKey ||
        record.dataVersion !== expected.dataVersion ||
        record.canonicalWord !== expected.canonicalWord) {
      return null;
    }

    if (record.status === "not_found") {
      return {
        cacheKey: record.cacheKey,
        dataVersion: record.dataVersion,
        canonicalWord: record.canonicalWord,
        status: "not_found",
        cachedAt: typeof record.cachedAt === "string" ? record.cachedAt : ""
      };
    }

    if (record.status !== "found" ||
        typeof record.word !== "string" || !record.word.trim() ||
        typeof record.translation !== "string" || !record.translation.trim() ||
        !isNullableString(record.phonetic) ||
        !isNullableString(record.pos)) {
      return null;
    }

    return {
      cacheKey: record.cacheKey,
      dataVersion: record.dataVersion,
      canonicalWord: record.canonicalWord,
      status: "found",
      word: record.word,
      phonetic: nullableText(record.phonetic),
      translation: record.translation,
      pos: nullableText(record.pos),
      cachedAt: typeof record.cachedAt === "string" ? record.cachedAt : ""
    };
  }

  function openCacheDatabase(indexedDBFactory = global.indexedDB) {
    if (!indexedDBFactory || typeof indexedDBFactory.open !== "function") {
      return Promise.reject(new Error("Dictionary cache IndexedDB is unavailable."));
    }

    return new Promise((resolve, reject) => {
      const request = indexedDBFactory.open(CACHE_DB_NAME, CACHE_DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(CACHE_STORE_NAME)) {
          database.createObjectStore(CACHE_STORE_NAME, { keyPath: "cacheKey" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Dictionary cache open failed."));
      request.onblocked = () => reject(new Error("Dictionary cache open was blocked."));
    });
  }

  function createPersistentCache(options = {}) {
    let databasePromise = null;
    const getDatabase = () => {
      if (!databasePromise) {
        databasePromise = openCacheDatabase(options.indexedDB || global.indexedDB);
      }
      return databasePromise;
    };

    async function get(cacheKey) {
      const database = await getDatabase();
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(CACHE_STORE_NAME, "readonly");
        const request = transaction.objectStore(CACHE_STORE_NAME).get(cacheKey);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Dictionary cache read failed."));
        transaction.onabort = () => reject(
          transaction.error || new Error("Dictionary cache read aborted.")
        );
      });
    }

    async function put(record) {
      const database = await getDatabase();
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(CACHE_STORE_NAME, "readwrite");
        transaction.objectStore(CACHE_STORE_NAME).put(record);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(
          transaction.error || new Error("Dictionary cache write failed.")
        );
        transaction.onabort = () => reject(
          transaction.error || new Error("Dictionary cache write aborted.")
        );
      });
    }

    async function remove(cacheKey) {
      const database = await getDatabase();
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(CACHE_STORE_NAME, "readwrite");
        transaction.objectStore(CACHE_STORE_NAME).delete(cacheKey);
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(
          transaction.error || new Error("Dictionary cache delete failed.")
        );
        transaction.onabort = () => reject(
          transaction.error || new Error("Dictionary cache delete aborted.")
        );
      });
    }

    return Object.freeze({ get, put, remove });
  }

  function createFoundRecord(result, details) {
    if (typeof result?.headword !== "string" || !result.headword.trim() ||
        typeof result.translation !== "string" || !result.translation.trim()) {
      return null;
    }

    return {
      cacheKey: details.cacheKey,
      dataVersion: details.dataVersion,
      canonicalWord: details.canonicalWord,
      status: "found",
      word: result.headword,
      phonetic: nullableText(result.phonetic),
      translation: result.translation,
      pos: nullableText(result.pos),
      cachedAt: new Date().toISOString()
    };
  }

  function recordToResult(record, query) {
    if (record.status === "not_found") {
      return { status: "not_found", query };
    }

    return {
      status: "found",
      query,
      headword: record.word,
      phonetic: record.phonetic,
      translation: record.translation,
      pos: record.pos,
      relation: "",
      source: "dictionary_cache",
      attribution: "LingoFlow Core Dictionary"
    };
  }

  function create(options = {}) {
    const cloudProvider = options.cloudProvider;
    if (!cloudProvider || typeof cloudProvider.lookup !== "function") {
      throw new TypeError("Cached Cloud Dictionary provider is unavailable.");
    }

    const canonicalizeWord = typeof options.canonicalizeWord === "function"
      ? options.canonicalizeWord
      : global.LingoFlowSupabaseDictionaryProvider?.canonicalizeWord;
    const isCanonicalWord = typeof options.isCanonicalWord === "function"
      ? options.isCanonicalWord
      : global.LingoFlowSupabaseDictionaryProvider?.isCanonicalWord;
    if (typeof canonicalizeWord !== "function" || typeof isCanonicalWord !== "function") {
      throw new TypeError("Cached Cloud Dictionary canonical key helper is unavailable.");
    }

    const dataVersion = String(options.dataVersion || DICTIONARY_DATA_VERSION).trim();
    if (!dataVersion) throw new TypeError("Dictionary data version is required.");

    const persistentCache = options.persistentCache || createPersistentCache(options);
    if (typeof persistentCache?.get !== "function" ||
        typeof persistentCache?.put !== "function") {
      throw new TypeError("Persistent Dictionary cache is unavailable.");
    }
    const memory = new Map();

    return Object.freeze({
      name: "cached_supabase_core",

      async lookup(request = {}) {
        const query = String(request?.word ?? "").trim();
        const canonicalWord = canonicalizeWord(query);
        if (!isCanonicalWord(canonicalWord)) {
          return await cloudProvider.lookup(request);
        }

        const cacheKey = createCacheKey(dataVersion, canonicalWord);
        const expected = { cacheKey, dataVersion, canonicalWord };
        let cachedRecord = validateRecord(memory.get(cacheKey), expected);

        if (!cachedRecord) {
          let storedRecord;
          try {
            storedRecord = await persistentCache.get(cacheKey);
          } catch {
            storedRecord = null;
          }
          cachedRecord = validateRecord(storedRecord, expected);

          if (cachedRecord) {
            memory.set(cacheKey, cachedRecord);
          } else if (storedRecord && typeof persistentCache.remove === "function") {
            try {
              await persistentCache.remove(cacheKey);
            } catch {}
          }
        }

        if (cachedRecord) return recordToResult(cachedRecord, query);

        const result = await cloudProvider.lookup({
          word: canonicalWord,
          context: request?.context ?? ""
        });

        let record = null;
        if (result?.status === "found") {
          record = createFoundRecord(result, expected);
        } else if (result?.status === "not_found") {
          record = {
            ...expected,
            status: "not_found",
            cachedAt: new Date().toISOString()
          };
        }

        if (record) {
          memory.set(cacheKey, record);
          try {
            await persistentCache.put(record);
          } catch {}
        }

        return result && typeof result === "object"
          ? { ...result, query }
          : result;
      }
    });
  }

  global.LingoFlowCachedCloudDictionaryProvider = Object.freeze({
    create,
    createPersistentCache,
    createCacheKey,
    validateRecord,
    CACHE_DB_NAME,
    CACHE_DB_VERSION,
    CACHE_STORE_NAME,
    DICTIONARY_DATA_VERSION
  });
})(window);
