// /Users/jinbo/Desktop/vibecoding/lingoflow/js/core-lemma-pack.js
// Independent Lightweight Core Lemma Pack loader.
//
// Storage layout (independent from EnglishReaderECDICT):
//   IndexedDB  : LingoFlowCoreLemmaDB (version 1)
//   Stores     : "meta" (single record: { key:"pack", manifest, text })
//
// Load flow on first need (lazy, non-blocking on startup):
//   memory map ← IndexedDB "meta" → if version-valid and parseable
//                                 → else drop cache entry
//               ← fetch manifest + pack JSON over network
//                                 → re-validate version
//                                 → on success: write to "meta" + memory map
//
// Version binding: a cached pack whose (dictionaryDataVersion,
// coreSnapshotSha256) does not match the expected baseline is treated as
// "unavailable" — never silently used.
//
// Failure semantics:
//   * Network failure / parse failure / schema mismatch / version mismatch:
//     - never cache a partial / failed payload as "not_found"
//     - never modify the memory map
//     - getCandidates(surface) returns null → caller falls back to legacy
//   * Surface form not present in the loaded pack:
//     - getCandidates returns null → caller falls back to legacy
//
// This module NEVER reads from or writes to EnglishReaderECDICT.

(function initCoreLemmaPackModule(global) {
  "use strict";

  const DB_NAME = "LingoFlowCoreLemmaDB";
  const DB_VERSION = 1;
  const META_STORE = "meta";
  const META_KEY = "pack";

  // Version lock — keep in sync with manifest dictionaryDataVersion
  // and coreSnapshotSha256 baked by scripts/build-dictionary-poc.py
  // --mode core-lemma-pack.
  const EXPECTED_DATA_VERSION = "core-2026-08-16-e15991ce6e92";
  const EXPECTED_LEMMA_PACK_VERSION = "core-lemma-pack-v1";
  const EXPECTED_CORE_RULE = "dictionary-core-high-confidence-v1";
  const EXPECTED_CORE_SHA256 =
    "e15991ce6e9213ebdf73f7c494587866d5129fc217c81dd40d43c57e73632415";
  const EXPECTED_LEMMA_SOURCE_SHA256 =
    "e255b097404e3e0052060e2ddf6e15a1414f577071d63d51d2ca0ce9dacee0fc";
  const EXPECTED_PACK_SHA256 =
    "4d32fee17e33289a7529abe6dfee02557c417d033fa36703ee1e06cb8620bb39";
  const EXPECTED_FORMAT_VERSION = "1";
  const EXPECTED_FORM_COUNT = 86993;
  const EXPECTED_CANDIDATE_PAIR_COUNT = 89112;
  const EXPECTED_AMBIGUOUS_FORM_COUNT = 2101;
  const EXPECTED_MAX_CANDIDATES_PER_FORM = 3;
  const VALID_TOKEN = /^[a-z]+(?:['-][a-z]+)*$/;

  // Pack filename (used when caller does not supply explicit URLs).
  const DEFAULT_MANIFEST_FILENAME = "core-lemma-manifest.json";
  const DEFAULT_PACK_FILENAME = "core-lemma-candidates.json";

  const DEFAULT_LOAD_TIMEOUT_MS = 8000;

  // --- internal state ---------------------------------------------------
  let memoryMap = null; // Map<surface, Array<{lemma, frequency}>>
  let cachedManifest = null;
  let loadPromise = null; // concurrent dedupe
  let lastStatus = null; // { status, reason?, manifest? }

  // --- IndexedDB helpers ------------------------------------------------
  function openCacheDb(indexedDBFactory) {
    const idb = indexedDBFactory || global.indexedDB;
    if (!idb || typeof idb.open !== "function") {
      return Promise.reject(new Error("IndexedDB is unavailable."));
    }
    return new Promise((resolve, reject) => {
      const request = idb.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(META_STORE)) {
          database.createObjectStore(META_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB open failed."));
      request.onblocked = () => reject(new Error("IndexedDB open was blocked."));
    });
  }

  function closeDbSafe(db) {
    try { db && db.close(); } catch { /* ignore */ }
  }

  async function readCachedMeta() {
    let db;
    try {
      db = await openCacheDb();
    } catch {
      return null;
    }
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(META_STORE, "readonly");
        const request = tx.objectStore(META_STORE).get(META_KEY);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error("IndexedDB read failed."));
        transactionOnAbort(tx, reject);
      });
    } catch {
      return null;
    } finally {
      closeDbSafe(db);
    }
  }

  async function writeCachedMeta(manifest, text) {
    let db;
    try {
      db = await openCacheDb();
    } catch (err) {
      // IndexedDB write failures must never break lookup — best effort.
      return false;
    }
    try {
      const record = { key: META_KEY, manifest, text };
      await new Promise((resolve, reject) => {
        const tx = db.transaction(META_STORE, "readwrite");
        tx.objectStore(META_STORE).put(record);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error("IndexedDB write failed."));
        tx.onabort = () => reject(tx.error || new Error("IndexedDB write aborted."));
      });
      return true;
    } catch {
      return false;
    } finally {
      closeDbSafe(db);
    }
  }

  async function clearCachedMeta() {
    let db;
    try {
      db = await openCacheDb();
    } catch {
      return false;
    }
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(META_STORE, "readwrite");
        tx.objectStore(META_STORE).delete(META_KEY);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error("IndexedDB delete failed."));
        tx.onabort = () => reject(tx.error || new Error("IndexedDB delete aborted."));
      });
      return true;
    } catch {
      return false;
    } finally {
      closeDbSafe(db);
    }
  }

  function transactionOnAbort(tx, reject) {
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted."));
  }

  // --- manifest / pack validation --------------------------------------
  function manifestMatchesExpected(manifest) {
    if (!manifest || typeof manifest !== "object") return false;
    if (manifest.formatVersion !== EXPECTED_FORMAT_VERSION) return false;
    if (manifest.lemmaPackVersion !== EXPECTED_LEMMA_PACK_VERSION) return false;
    if (manifest.dictionaryDataVersion !== EXPECTED_DATA_VERSION) return false;
    if (manifest.coreRule !== EXPECTED_CORE_RULE) return false;
    if (manifest.coreSnapshotSha256 !== EXPECTED_CORE_SHA256) return false;
    if (manifest.lemmaSourceSha256 !== EXPECTED_LEMMA_SOURCE_SHA256) return false;
    if (manifest.packSha256 !== EXPECTED_PACK_SHA256) return false;
    if (manifest.packFilename !== DEFAULT_PACK_FILENAME) return false;
    if (manifest.entryCount !== EXPECTED_FORM_COUNT) return false;
    if (manifest.candidatePairCount !== EXPECTED_CANDIDATE_PAIR_COUNT) return false;
    if (manifest.ambiguousFormCount !== EXPECTED_AMBIGUOUS_FORM_COUNT) return false;
    if (manifest.maxCandidatesPerForm !== EXPECTED_MAX_CANDIDATES_PER_FORM) return false;
    return true;
  }

  async function sha256Hex(text) {
    if (!global.crypto?.subtle) {
      const error = new Error("Core Lemma Pack integrity check is unavailable.");
      error.code = "integrity_check_unavailable";
      throw error;
    }
    const bytes = new TextEncoder().encode(text);
    const digest = await global.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function parsePackText(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`pack parse failed: ${err.message || "invalid JSON"}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("pack root must be an object map");
    }
    const map = new Map();
    let candidatePairCount = 0;
    let ambiguousFormCount = 0;
    let maxCandidatesPerForm = 0;
    for (const [form, value] of Object.entries(parsed)) {
      if (!VALID_TOKEN.test(form) || !Array.isArray(value) || value.length === 0) {
        throw new Error("pack entry schema is invalid");
      }
      const candidates = [];
      const seen = new Set();
      for (const pair of value) {
        if (!Array.isArray(pair) || pair.length !== 2) {
          throw new Error("pack candidate schema is invalid");
        }
        const lemma = pair[0];
        const frequency = pair[1];
        if (!VALID_TOKEN.test(lemma) || !Number.isInteger(frequency) || frequency < 0 ||
            seen.has(lemma)) {
          throw new Error("pack candidate value is invalid");
        }
        seen.add(lemma);
        candidates.push({ lemma, frequency });
      }
      const sorted = candidates.slice().sort(
        (a, b) =>
          b.frequency - a.frequency ||
          (a.lemma < b.lemma ? -1 : a.lemma > b.lemma ? 1 : 0)
      );
      if (candidates.some((candidate, index) => candidate !== sorted[index])) {
        throw new Error("pack candidates are not deterministically ordered");
      }
      map.set(form, candidates);
      candidatePairCount += candidates.length;
      if (candidates.length > 1) ambiguousFormCount += 1;
      maxCandidatesPerForm = Math.max(maxCandidatesPerForm, candidates.length);
    }
    return {
      map,
      counts: {
        formCount: map.size,
        candidatePairCount,
        ambiguousFormCount,
        maxCandidatesPerForm
      }
    };
  }

  function countsMatchExpected(counts, manifest) {
    return counts.formCount === manifest.entryCount &&
      counts.candidatePairCount === manifest.candidatePairCount &&
      counts.ambiguousFormCount === manifest.ambiguousFormCount &&
      counts.maxCandidatesPerForm === manifest.maxCandidatesPerForm;
  }

  async function validatePackText(text, manifest) {
    const packSha = await sha256Hex(text);
    if (packSha !== EXPECTED_PACK_SHA256 || packSha !== manifest.packSha256) {
      const error = new Error("Core Lemma Pack SHA-256 mismatch.");
      error.code = "lemma_pack_integrity_mismatch";
      throw error;
    }
    const parsed = parsePackText(text);
    if (!countsMatchExpected(parsed.counts, manifest)) {
      const error = new Error("Core Lemma Pack counts do not match its manifest.");
      error.code = "lemma_pack_count_mismatch";
      throw error;
    }
    return parsed.map;
  }

  function buildUrl(filename, baseUrl) {
    if (baseUrl) {
      try {
        return new URL(filename, baseUrl).toString();
      } catch {
        return `${baseUrl.replace(/\/+$/, "")}/${filename}`;
      }
    }
    return `data/dictionary/${filename}`;
  }

  async function fetchTextWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const externalSignal = options.signal;
    let timedOut = false;
    const forwardAbort = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener("abort", forwardAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs);

    try {
      const response = await fetch(url, {
        cache: "no-store",
        signal: controller.signal
      });
      if (!response.ok) {
        const error = new Error(`${options.label} HTTP request failed.`);
        error.code = `${options.reasonPrefix}_unavailable`;
        throw error;
      }
      return await response.text();
    } catch (error) {
      if (error?.code) throw error;
      const wrapped = new Error(`${options.label} fetch failed.`);
      wrapped.code = timedOut
        ? `${options.reasonPrefix}_timeout`
        : `${options.reasonPrefix}_unavailable`;
      throw wrapped;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", forwardAbort);
    }
  }

  async function fetchManifest(manifestUrl, options) {
    const text = await fetchTextWithTimeout(manifestUrl, {
      ...options,
      label: "Core Lemma manifest",
      reasonPrefix: "lemma_pack_manifest"
    });
    let parsed;
    try { parsed = JSON.parse(text); }
    catch {
      const error = new Error("Core Lemma manifest JSON is invalid.");
      error.code = "lemma_pack_manifest_invalid";
      throw error;
    }
    return parsed;
  }

  async function fetchPack(packUrl, options) {
    return await fetchTextWithTimeout(packUrl, {
      ...options,
      label: "Core Lemma Pack",
      reasonPrefix: "lemma_pack"
    });
  }

  function resolvePackUrl(filename, manifestUrl) {
    try {
      const manifestAbsolute = new URL(manifestUrl, global.document?.baseURI);
      return new URL(filename, manifestAbsolute).toString();
    } catch {
      return buildUrl(filename);
    }
  }

  function unavailable(reason) {
    return { status: "unavailable", reason };
  }

  function errorReason(error, fallback) {
    return typeof error?.code === "string" && error.code
      ? error.code
      : fallback;
  }

  // --- public API --------------------------------------------------------

  function getStatus() {
    return lastStatus
      ? { ...lastStatus }
      : { status: memoryMap ? "ready" : "idle" };
  }

  function isReady() {
    return memoryMap !== null;
  }

  function getCandidates(surface) {
    if (!memoryMap) return null;
    if (typeof surface !== "string" || !surface) return null;
    return memoryMap.get(surface) || null;
  }

  function getCachedManifest() {
    return cachedManifest ? { ...cachedManifest } : null;
  }

  /**
   * Lazily load the Core Lemma Pack.
   *
   * @param {object} options
   * @param {string} [options.manifestUrl] absolute or relative URL of manifest
   * @param {string} [options.packUrl] absolute or relative URL of pack JSON
   * @param {string} [options.baseUrl] base for resolving DEFAULT_* filenames
   * @param {number} [options.timeoutMs]
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<{status: "ready"} | {status: "unavailable", reason: string}>}
   */
  async function ensureLoaded(options = {}) {
    if (memoryMap) {
      lastStatus = { status: "ready", manifest: cachedManifest };
      return lastStatus;
    }
    if (loadPromise) return loadPromise;

    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_LOAD_TIMEOUT_MS;
    const baseUrl = options.baseUrl;
    const manifestUrl = options.manifestUrl || buildUrl(DEFAULT_MANIFEST_FILENAME, baseUrl);

    loadPromise = (async () => {
      // Phase 1: try IndexedDB cache (only accept if version matches)
      try {
        const cached = await readCachedMeta();
        if (cached && cached.manifest && cached.text) {
          if (manifestMatchesExpected(cached.manifest)) {
            try {
              memoryMap = await validatePackText(cached.text, cached.manifest);
              cachedManifest = cached.manifest;
              lastStatus = { status: "ready", manifest: cachedManifest };
              return lastStatus;
            } catch (error) {
              if (errorReason(error, "") === "integrity_check_unavailable") {
                lastStatus = unavailable("integrity_check_unavailable");
                return lastStatus;
              }
              // Corrupt cached payload — drop it.
              await clearCachedMeta().catch(() => {});
              memoryMap = null;
              cachedManifest = null;
            }
          } else {
            // Version mismatch — drop the stale cache.
            await clearCachedMeta().catch(() => {});
          }
        }
      } catch {
        // IndexedDB read failure — continue to network fetch.
      }

      // Phase 2: network fetch.
      let manifest, text;
      try {
        manifest = await fetchManifest(manifestUrl, {
          signal: options.signal,
          timeoutMs
        });
      } catch (err) {
        lastStatus = unavailable(errorReason(err, "lemma_pack_manifest_unavailable"));
        return lastStatus;
      }

      if (!manifestMatchesExpected(manifest)) {
        await clearCachedMeta().catch(() => {});
        lastStatus = unavailable("lemma_pack_version_mismatch");
        return lastStatus;
      }

      const packUrl = options.packUrl || resolvePackUrl(manifest.packFilename, manifestUrl);
      try {
        text = await fetchPack(packUrl, {
          signal: options.signal,
          timeoutMs
        });
      } catch (err) {
        lastStatus = unavailable(errorReason(err, "lemma_pack_unavailable"));
        return lastStatus;
      }

      let parsedMap;
      try {
        parsedMap = await validatePackText(text, manifest);
      } catch (err) {
        await clearCachedMeta().catch(() => {});
        lastStatus = unavailable(errorReason(err, "lemma_pack_invalid"));
        return lastStatus;
      }

      memoryMap = parsedMap;
      cachedManifest = manifest;

      // Persistence is best effort, but the attempt completes before callers
      // observe a ready state so an immediate reload has deterministic behavior.
      await writeCachedMeta(manifest, text);

      lastStatus = { status: "ready", manifest };
      return lastStatus;
    })();

    try {
      return await loadPromise;
    } finally {
      loadPromise = null;
    }
  }

  /**
   * Get lemma candidates for a surface word.
   * Returns null if the pack has not loaded yet (caller must await ensureLoaded
   * first, or rely on the resolveAndGetCandidates convenience wrapper below).
   */
  function resolveAndGetCandidates(surface, options = {}) {
    return ensureLoaded(options).then(status => {
      if (status.status !== "ready") return null;
      return getCandidates(surface);
    });
  }

  function resetForTest() {
    memoryMap = null;
    cachedManifest = null;
    loadPromise = null;
    lastStatus = null;
  }

  // Reset only the in-memory map but keep the IndexedDB cache intact.
  function resetMemoryOnly() {
    memoryMap = null;
    cachedManifest = null;
    lastStatus = null;
  }

  global.LingoFlowCoreLemmaPack = Object.freeze({
    DB_NAME,
    DB_VERSION,
    EXPECTED_DATA_VERSION,
    EXPECTED_LEMMA_PACK_VERSION,
    EXPECTED_CORE_SHA256,
    EXPECTED_LEMMA_SOURCE_SHA256,
    EXPECTED_PACK_SHA256,
    EXPECTED_CORE_RULE,
    EXPECTED_FORMAT_VERSION,
    EXPECTED_FORM_COUNT,
    EXPECTED_CANDIDATE_PAIR_COUNT,
    EXPECTED_AMBIGUOUS_FORM_COUNT,
    EXPECTED_MAX_CANDIDATES_PER_FORM,
    DEFAULT_MANIFEST_FILENAME,
    DEFAULT_PACK_FILENAME,
    ensureLoaded,
    resolveAndGetCandidates,
    getCandidates,
    getCachedManifest,
    getStatus,
    isReady,
    resetForTest,
    resetMemoryOnly,
    clearCachedMeta,
    parsePackText,
    validatePackText,
    manifestMatchesExpected
  });
})(window);
