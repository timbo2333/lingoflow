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
    const base = fallback || {
      progress: 0,
      paragraphIndex: 0,
      updatedAt: null
    };

    const progress = Number(reading.progress ?? base.progress ?? 0);
    const paragraphIndex = Number(reading.paragraphIndex ?? base.paragraphIndex ?? 0);

    return {
      progress: Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0,
      paragraphIndex: Number.isFinite(paragraphIndex)
        ? Math.max(0, Math.trunc(paragraphIndex))
        : 0,
      updatedAt: reading.updatedAt ?? base.updatedAt ?? null
    };
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

  window.LingoFlowArticleLibrary = Object.freeze({
    DB_NAME,
    DB_VERSION,
    openDatabase,
    createArticle,
    getArticle,
    updateArticle,
    updateArticleReading,
    listArticles,
    findArticleBySource
  });
})();
