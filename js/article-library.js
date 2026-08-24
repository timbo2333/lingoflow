(function() {
  "use strict";

  const DB_NAME = "LingoFlowLibraryDB";
  const DB_VERSION = 1;
  const ARTICLE_STORE = "articles";
  const SOURCE_TYPES = new Set(["paste", "txt", "library"]);
  let databasePromise = null;

  function ensureIndexedDB() {
    if (!("indexedDB" in window)) {
      throw new Error("当前浏览器不支持 IndexedDB，无法保存文章。");
    }
  }

  function createArticleId() {
    if (window.crypto?.randomUUID) return `article:${window.crypto.randomUUID()}`;
    return `article:${Date.now()}:${Math.random().toString(36).slice(2)}:${Math.random().toString(36).slice(2)}`;
  }

  function normalizeSourceType(value) {
    const sourceType = String(value || "paste");
    if (!SOURCE_TYPES.has(sourceType)) {
      throw new Error(`不支持的文章来源：${sourceType}`);
    }
    return sourceType;
  }

  function normalizeReading(reading = {}, fallback = null) {
    const defaults = {
      progress: 0,
      paragraphIndex: 0,
      updatedAt: null
    };
    const base = isPlainObject(fallback) ? fallback : defaults;
    const readingState = isPlainObject(reading) ? { ...reading } : {};
    delete readingState.lastReadAt;

    const progress = Number(readingState.progress ?? base.progress ?? 0);
    const paragraphIndex = Number(readingState.paragraphIndex ?? base.paragraphIndex ?? 0);

    const normalized = {
      ...base,
      ...readingState,
      progress: Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0,
      paragraphIndex: Number.isFinite(paragraphIndex)
        ? Math.max(0, Math.trunc(paragraphIndex))
        : 0,
      updatedAt: readingState.updatedAt ?? base.updatedAt ?? null
    };
    delete normalized.lastReadAt;
    return normalized;
  }

  function applyOptionalText(target, key, value) {
    const text = String(value || "").trim();
    if (text) target[key] = text;
    else delete target[key];
  }

  function buildArticleRecord(input) {
    const now = new Date().toISOString();
    const sourceType = normalizeSourceType(input?.sourceType);
    const title = String(input?.title || "").trim() || "未命名文章";
    const content = String(input?.content || "");

    if (!content.trim()) throw new Error("文章正文不能为空。");

    const record = {
      id: createArticleId(),
      title,
      content,
      sourceType,
      createdAt: now,
      updatedAt: now,
      lastReadAt: now,
      reading: normalizeReading(),
      deletedAt: null
    };

    if (sourceType === "library") {
      const sourceId = String(input?.sourceId || "").trim();
      if (!sourceId) throw new Error("内置文章来源缺少 sourceId。");
      record.sourceId = sourceId;
    }

    applyOptionalText(record, "sourceTitle", input?.sourceTitle);
    applyOptionalText(record, "sourceAttribution", input?.sourceAttribution);
    return record;
  }

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function isJsonCompatible(value) {
    if (value === null) return true;
    if (["string", "boolean"].includes(typeof value)) return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) return value.every(isJsonCompatible);
    if (!isPlainObject(value)) return false;
    return Object.values(value).every(isJsonCompatible);
  }

  function isValidTimestamp(value, nullable = false) {
    if (nullable && value === null) return true;
    return typeof value === "string" &&
      Boolean(value.trim()) &&
      Number.isFinite(Date.parse(value));
  }

  function createRestoreResult(status, articleId, details = {}) {
    return {
      status,
      articleId: articleId || null,
      written: Boolean(details.written),
      conflicts: details.conflicts || [],
      conflictFields: details.conflictFields || [],
      ...(details.reason ? { reason: details.reason } : {}),
      ...(details.conflictingArticleId
        ? { conflictingArticleId: details.conflictingArticleId }
        : {})
    };
  }

  function rejectRestoreArticle(article, reason) {
    const articleId = typeof article?.id === "string" && article.id.trim()
      ? article.id
      : null;
    return createRestoreResult("rejected", articleId, { reason });
  }

  function validateRestoreArticle(article) {
    if (!isPlainObject(article) || !isJsonCompatible(article)) {
      return { result: rejectRestoreArticle(article, "invalid-article") };
    }

    if (typeof article.id !== "string" || !article.id.trim() || article.id !== article.id.trim()) {
      return { result: rejectRestoreArticle(article, "invalid-id") };
    }
    if (typeof article.title !== "string" || !article.title.trim()) {
      return { result: rejectRestoreArticle(article, "invalid-title") };
    }
    if (typeof article.content !== "string" || !article.content.trim()) {
      return { result: rejectRestoreArticle(article, "invalid-content") };
    }
    if (typeof article.sourceType !== "string" || !SOURCE_TYPES.has(article.sourceType)) {
      return { result: rejectRestoreArticle(article, "invalid-source") };
    }

    if (article.sourceType === "library") {
      if (typeof article.sourceId !== "string" || !article.sourceId.trim()) {
        return { result: rejectRestoreArticle(article, "invalid-source") };
      }
    } else if (Object.prototype.hasOwnProperty.call(article, "sourceId")) {
      return { result: rejectRestoreArticle(article, "invalid-source") };
    }

    for (const key of ["sourceTitle", "sourceAttribution"]) {
      if (Object.prototype.hasOwnProperty.call(article, key) &&
          (typeof article[key] !== "string" || !article[key].trim())) {
        return { result: rejectRestoreArticle(article, "invalid-source") };
      }
    }

    if (!isValidTimestamp(article.createdAt) ||
        !isValidTimestamp(article.updatedAt) ||
        !isValidTimestamp(article.lastReadAt) ||
        !isValidTimestamp(article.deletedAt, true)) {
      return { result: rejectRestoreArticle(article, "invalid-lifecycle") };
    }

    const reading = article.reading;
    if (!isPlainObject(reading) ||
        typeof reading.progress !== "number" ||
        reading.progress < 0 ||
        reading.progress > 1 ||
        !Number.isInteger(reading.paragraphIndex) ||
        reading.paragraphIndex < 0 ||
        !isValidTimestamp(reading.updatedAt, true)) {
      return { result: rejectRestoreArticle(article, "invalid-reading") };
    }

    return { article: structuredClone(article) };
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

  function classifyArticleRestore(current, incoming) {
    const fields = Array.from(new Set([
      ...Object.keys(current),
      ...Object.keys(incoming)
    ])).sort();
    const conflictFields = fields.filter(key => !valuesEqual(current[key], incoming[key]));

    if (!conflictFields.length) {
      return createRestoreResult("unchanged", incoming.id);
    }

    const conflictTypes = new Set();
    const lifecycleFields = new Set([
      "createdAt",
      "updatedAt",
      "lastReadAt",
      "deletedAt"
    ]);

    for (const field of conflictFields) {
      if (field === "content") conflictTypes.add("content");
      else if (field === "reading") conflictTypes.add("reading");
      else if (lifecycleFields.has(field)) conflictTypes.add("lifecycle");
      else if (field !== "id") conflictTypes.add("metadata");
    }

    return createRestoreResult("conflict", incoming.id, {
      conflicts: Array.from(conflictTypes).sort(),
      conflictFields
    });
  }

  function createSourceConflictResult(incoming, current) {
    return createRestoreResult("conflict", incoming.id, {
      conflicts: ["source"],
      conflictFields: ["sourceType", "sourceId"],
      conflictingArticleId: current.id
    });
  }

  function openDatabase() {
    ensureIndexedDB();
    if (databasePromise) return databasePromise;

    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      let blocked = false;

      request.onupgradeneeded = () => {
        const db = request.result;
        const store = db.objectStoreNames.contains(ARTICLE_STORE)
          ? request.transaction.objectStore(ARTICLE_STORE)
          : db.createObjectStore(ARTICLE_STORE, { keyPath: "id" });

        if (!store.indexNames.contains("byLastReadAt")) {
          store.createIndex("byLastReadAt", "lastReadAt", { unique: false });
        }
        if (!store.indexNames.contains("byDeletedAt")) {
          store.createIndex("byDeletedAt", "deletedAt", { unique: false });
        }
        if (!store.indexNames.contains("bySource")) {
          store.createIndex("bySource", ["sourceType", "sourceId"], { unique: true });
        }
      };

      request.onsuccess = () => {
        if (blocked) {
          request.result.close();
          return;
        }

        const db = request.result;
        db.onversionchange = () => {
          db.close();
          databasePromise = null;
        };
        resolve(db);
      };

      request.onerror = () => {
        databasePromise = null;
        reject(request.error || new Error("无法打开文章数据库。"));
      };

      request.onblocked = () => {
        blocked = true;
        databasePromise = null;
        reject(new Error("文章数据库正在被其他页面占用，请关闭其他 LingoFlow 页面后重试。"));
      };
    });

    return databasePromise;
  }

  async function createArticle(input) {
    const db = await openDatabase();
    const record = buildArticleRecord(input);

    return await new Promise((resolve, reject) => {
      const tx = db.transaction(ARTICLE_STORE, "readwrite");
      tx.objectStore(ARTICLE_STORE).add(record);
      tx.oncomplete = () => resolve(record);
      tx.onerror = () => reject(tx.error || new Error("文章保存失败。"));
      tx.onabort = () => reject(tx.error || new Error("文章保存事务已中止。"));
    });
  }

  async function getArticle(id) {
    const articleId = String(id || "").trim();
    if (!articleId) return null;

    const db = await openDatabase();
    const tx = db.transaction(ARTICLE_STORE, "readonly");
    const request = tx.objectStore(ARTICLE_STORE).get(articleId);

    return await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("文章读取失败。"));
    });
  }

  async function updateRecord(id, update) {
    const articleId = String(id || "").trim();
    if (!articleId) throw new Error("缺少 article id。");

    const db = await openDatabase();

    return await new Promise((resolve, reject) => {
      const tx = db.transaction(ARTICLE_STORE, "readwrite");
      const store = tx.objectStore(ARTICLE_STORE);
      const request = store.get(articleId);
      let updatedRecord = null;
      let updateError = null;

      request.onsuccess = () => {
        const current = request.result;
        if (!current) {
          updateError = new Error("要更新的文章不存在。");
          tx.abort();
          return;
        }

        try {
          updatedRecord = update(current);
          store.put(updatedRecord);
        } catch (error) {
          updateError = error;
          tx.abort();
        }
      };

      request.onerror = () => {
        updateError = request.error || new Error("文章读取失败。");
      };

      tx.oncomplete = () => resolve(updatedRecord);
      tx.onerror = () => reject(updateError || tx.error || new Error("文章更新失败。"));
      tx.onabort = () => reject(updateError || tx.error || new Error("文章更新事务已中止。"));
    });
  }

  async function updateArticle(id, changes = {}) {
    return await updateRecord(id, current => {
      const next = { ...current };

      if (Object.prototype.hasOwnProperty.call(changes, "title")) {
        next.title = String(changes.title || "").trim() || current.title || "未命名文章";
      }
      if (Object.prototype.hasOwnProperty.call(changes, "content")) {
        const content = String(changes.content || "");
        if (!content.trim()) throw new Error("文章正文不能为空。");
        next.content = content;
      }
      if (Object.prototype.hasOwnProperty.call(changes, "lastReadAt")) {
        next.lastReadAt = changes.lastReadAt || current.lastReadAt;
      }
      if (Object.prototype.hasOwnProperty.call(changes, "deletedAt")) {
        next.deletedAt = changes.deletedAt || null;
      }

      if (Object.prototype.hasOwnProperty.call(changes, "sourceType")) {
        next.sourceType = normalizeSourceType(changes.sourceType);
      }

      if (next.sourceType === "library") {
        const sourceId = Object.prototype.hasOwnProperty.call(changes, "sourceId")
          ? String(changes.sourceId || "").trim()
          : String(next.sourceId || "").trim();
        if (!sourceId) throw new Error("内置文章来源缺少 sourceId。");
        next.sourceId = sourceId;
      } else {
        delete next.sourceId;
      }

      if (Object.prototype.hasOwnProperty.call(changes, "sourceTitle")) {
        applyOptionalText(next, "sourceTitle", changes.sourceTitle);
      }
      if (Object.prototype.hasOwnProperty.call(changes, "sourceAttribution")) {
        applyOptionalText(next, "sourceAttribution", changes.sourceAttribution);
      }

      next.reading = normalizeReading(current.reading);
      next.updatedAt = new Date().toISOString();
      return next;
    });
  }

  async function updateArticleReading(id, readingChanges = {}) {
    return await updateRecord(id, current => ({
      ...current,
      lastReadAt: readingChanges.lastReadAt || current.lastReadAt,
      reading: normalizeReading(readingChanges, current.reading)
    }));
  }

  async function listArticles(options = {}) {
    const db = await openDatabase();
    const tx = db.transaction(ARTICLE_STORE, "readonly");
    const store = tx.objectStore(ARTICLE_STORE);
    const deletedOnly = Boolean(options.deletedOnly);
    const request = deletedOnly
      ? store.index("byDeletedAt").getAll()
      : store.getAll();
    const includeDeleted = Boolean(options.includeDeleted);

    return await new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const items = (request.result || [])
          .filter(item => deletedOnly ? Boolean(item.deletedAt) : includeDeleted || !item.deletedAt)
          .sort((a, b) => deletedOnly
            ? String(b.deletedAt || "").localeCompare(String(a.deletedAt || ""))
            : String(b.lastReadAt || "").localeCompare(String(a.lastReadAt || "")));
        resolve(items);
      };
      request.onerror = () => reject(request.error || new Error("文章列表读取失败。"));
    });
  }

  async function findArticleBySource(sourceType, sourceId) {
    const type = normalizeSourceType(sourceType);
    const id = String(sourceId || "").trim();
    if (!id) return null;

    const db = await openDatabase();
    const tx = db.transaction(ARTICLE_STORE, "readonly");
    const request = tx.objectStore(ARTICLE_STORE).index("bySource").get([type, id]);

    return await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("文章来源查询失败。"));
    });
  }

  async function assessArticleRestore(article) {
    const validation = validateRestoreArticle(article);
    if (validation.result) return validation.result;

    const incoming = validation.article;
    const current = await getArticle(incoming.id);
    if (current) return classifyArticleRestore(current, incoming);

    if (incoming.sourceType === "library") {
      const sourceMatch = await findArticleBySource(incoming.sourceType, incoming.sourceId);
      if (sourceMatch) {
        return sourceMatch.id === incoming.id
          ? classifyArticleRestore(sourceMatch, incoming)
          : createSourceConflictResult(incoming, sourceMatch);
      }
    }

    return createRestoreResult("restored", incoming.id);
  }

  async function restoreArticle(article) {
    const validation = validateRestoreArticle(article);
    if (validation.result) return validation.result;

    const incoming = validation.article;
    const db = await openDatabase();

    return await new Promise((resolve, reject) => {
      const tx = db.transaction(ARTICLE_STORE, "readwrite");
      const store = tx.objectStore(ARTICLE_STORE);
      const request = store.get(incoming.id);
      let result = null;
      let restoreError = null;

      function addIncomingArticle() {
        try {
          const addRequest = store.add(incoming);
          addRequest.onsuccess = () => {
            result = createRestoreResult("restored", incoming.id, { written: true });
          };
          addRequest.onerror = () => {
            restoreError = addRequest.error || new Error("文章恢复失败。");
          };
        } catch (error) {
          restoreError = error;
          tx.abort();
        }
      }

      request.onsuccess = () => {
        const current = request.result;
        if (current) {
          result = classifyArticleRestore(current, incoming);
          return;
        }

        if (incoming.sourceType !== "library") {
          addIncomingArticle();
          return;
        }

        const sourceRequest = store.index("bySource").get([
          incoming.sourceType,
          incoming.sourceId
        ]);
        sourceRequest.onsuccess = () => {
          const sourceMatch = sourceRequest.result;
          if (sourceMatch) {
            result = sourceMatch.id === incoming.id
              ? classifyArticleRestore(sourceMatch, incoming)
              : createSourceConflictResult(incoming, sourceMatch);
            return;
          }
          addIncomingArticle();
        };
        sourceRequest.onerror = () => {
          restoreError = sourceRequest.error || new Error("文章来源查询失败。");
        };
      };

      request.onerror = () => {
        restoreError = request.error || new Error("文章读取失败。");
      };

      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(restoreError || tx.error || new Error("文章恢复失败。"));
      tx.onabort = () => reject(restoreError || tx.error || new Error("文章恢复事务已中止。"));
    });
  }

  window.LingoFlowArticleLibrary = Object.freeze({
    DB_NAME,
    DB_VERSION,
    openDatabase,
    createArticle,
    getArticle,
    updateArticle,
    updateArticleReading,
    listArticles,
    findArticleBySource,
    assessArticleRestore,
    restoreArticle
  });
})();
