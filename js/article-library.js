(function() {
  "use strict";

  const DB_NAME = "LingoFlowLibraryDB";
  const DB_VERSION = 3;
  const ARTICLE_STORE = "articles";
  const PROGRESS_FENCE_STORE = "progressFences";
  const PROGRESS_CONTROL_STORE = "progressControl";
  const WORKSPACE_TRANSITION_KEY = "workspace-transition";
  const SOURCE_TYPES = new Set(["paste", "txt", "library"]);
  let databasePromise = null;
  let accountSwitchWriteBlocked = false;

  function assertWritesAllowed() {
    if (accountSwitchWriteBlocked) {
      throw new Error("账号切换期间暂不能修改文章。");
    }
  }

  function ensureIndexedDB() {
    if (!("indexedDB" in window)) {
      throw new Error("当前浏览器不支持 IndexedDB，无法保存文章。");
    }
  }

  function createArticleId() {
    if (window.crypto?.randomUUID) return `article:${window.crypto.randomUUID()}`;
    return `article:${Date.now()}:${Math.random().toString(36).slice(2)}:${Math.random().toString(36).slice(2)}`;
  }

  function newFenceToken() {
    return window.crypto.randomUUID();
  }

  function initialProgressFence(articleId) {
    return { articleId, lifecycleToken: newFenceToken(), resumeRevision: 0, action: null };
  }

  function sameProgressScope(left, right) {
    if (!left && !right) return true;
    return Boolean(left && right && left.ownerId === right.ownerId &&
      left.bindingId === right.bindingId && left.scopeToken === right.scopeToken);
  }

  function requireStableWorkspace(tx, proceed) {
    const request = tx.objectStore(PROGRESS_CONTROL_STORE).get(WORKSPACE_TRANSITION_KEY);
    request.onsuccess = () => {
      if (request.result) tx.abort();
      else proceed();
    };
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
    const resume = window.LingoFlowReadingResume?.normalizeCheckpoint(normalized.resume);
    if (resume) normalized.resume = resume;
    else delete normalized.resume;
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

    const incoming = structuredClone(article);
    if (Object.prototype.hasOwnProperty.call(incoming.reading, "resume")) {
      incoming.reading = normalizeReading(incoming.reading);
    }
    return { article: incoming };
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
        if (store.indexNames.contains("bySource") && store.index("bySource").unique) {
          store.deleteIndex("bySource");
        }
        if (!store.indexNames.contains("bySource")) {
          store.createIndex("bySource", ["sourceType", "sourceId"], { unique: false });
        }
        if (!db.objectStoreNames.contains(PROGRESS_FENCE_STORE)) {
          db.createObjectStore(PROGRESS_FENCE_STORE, { keyPath: "articleId" });
        }
        if (!db.objectStoreNames.contains(PROGRESS_CONTROL_STORE)) {
          db.createObjectStore(PROGRESS_CONTROL_STORE, { keyPath: "key" });
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
    assertWritesAllowed();
    const db = await openDatabase();
    const record = buildArticleRecord(input);

    return await new Promise((resolve, reject) => {
      const tx = db.transaction([ARTICLE_STORE, PROGRESS_FENCE_STORE, PROGRESS_CONTROL_STORE], "readwrite");
      requireStableWorkspace(tx, () => {
        tx.objectStore(ARTICLE_STORE).add(record);
        tx.objectStore(PROGRESS_FENCE_STORE).put(initialProgressFence(record.id));
      });
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
    assertWritesAllowed();
    const articleId = String(id || "").trim();
    if (!articleId) throw new Error("缺少 article id。");

    const db = await openDatabase();

    return await new Promise((resolve, reject) => {
      const tx = db.transaction([ARTICLE_STORE, PROGRESS_FENCE_STORE, PROGRESS_CONTROL_STORE], "readwrite");
      const store = tx.objectStore(ARTICLE_STORE);
      const fenceStore = tx.objectStore(PROGRESS_FENCE_STORE);
      let request;
      let updatedRecord = null;
      let updateError = null;

      const proceed = () => {
        request = store.get(articleId);
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
            const lifecycleChanged = Boolean(current.deletedAt) !== Boolean(updatedRecord.deletedAt);
            const resumeChanged = !valuesEqual(current.reading?.resume || null,
              updatedRecord.reading?.resume || null);
            if (lifecycleChanged || resumeChanged) {
              const fenceRequest = fenceStore.get(articleId);
              fenceRequest.onsuccess = () => {
                const fence = fenceRequest.result || initialProgressFence(articleId);
                if (lifecycleChanged) fence.lifecycleToken = newFenceToken();
                if (resumeChanged) fence.resumeRevision += 1;
                fence.action = null; // An ordinary write has no movement-action provenance.
                fenceStore.put(fence);
              };
            }
          } catch (error) {
            updateError = error;
            tx.abort();
          }
        };
        request.onerror = () => {
          updateError = request.error || new Error("文章读取失败。");
        };
      };
      requireStableWorkspace(tx, proceed);

      tx.oncomplete = () => resolve(updatedRecord);
      tx.onerror = () => reject(updateError || tx.error || new Error("文章更新失败。"));
      tx.onabort = () => reject(updateError || tx.error || new Error("文章更新事务已中止。"));
    });
  }

  function planUpdatedArticle(current, changes = {}) {
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
  }

  async function updateArticle(id, changes = {}) {
    return await updateRecord(id, current => planUpdatedArticle(current, changes));
  }

  // Projection CAS runs inside the Article transaction. A reading-only write may
  // happen between inspection and commit; merge against the record read here.
  async function commitArticleSyncProjection(articleId, expectedProjection, candidateProjection) {
    assertWritesAllowed();
    const projection = window.LingoFlowArticleSyncProjection;
    const candidate = projection.sanitizeArticleSyncProjection(candidateProjection);
    if (candidate.id !== articleId ||
        (expectedProjection && projection.sanitizeArticleSyncProjection(expectedProjection).id !== articleId)) {
      throw new Error("Article sync projection ID 不匹配。");
    }
    const db = await openDatabase();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction([ARTICLE_STORE, PROGRESS_FENCE_STORE, PROGRESS_CONTROL_STORE], "readwrite");
      const store = tx.objectStore(ARTICLE_STORE);
      const fenceStore = tx.objectStore(PROGRESS_FENCE_STORE);
      let request;
      let result;
      let workError;
      const proceed = () => {
        request = store.get(articleId);
        request.onsuccess = () => {
          try {
            const current = request.result || null;
            const matchesBefore = current === null
              ? expectedProjection === null
              : expectedProjection !== null &&
                projection.compareArticleSyncProjection(current, expectedProjection);
            if (!matchesBefore) {
              result = { status: "stale-local-state", article: current };
              return;
            }
            const merged = projection.mergeRemoteArticleProjection(current, candidate);
            store.put(merged);
            if (current === null) {
              fenceStore.put(initialProgressFence(articleId));
            } else if (Boolean(current.deletedAt) !== Boolean(merged.deletedAt) ||
                !valuesEqual(current?.reading?.resume || null, merged.reading?.resume || null)) {
              const fenceRequest = fenceStore.get(articleId);
              fenceRequest.onsuccess = () => {
                const fence = fenceRequest.result || initialProgressFence(articleId);
                if (Boolean(current?.deletedAt) !== Boolean(merged.deletedAt)) {
                  fence.lifecycleToken = newFenceToken();
                }
                fence.resumeRevision += 1;
                fence.action = null;
                fenceStore.put(fence);
              };
            }
            result = { status: "committed", article: merged };
          } catch (error) {
            workError = error;
            tx.abort();
          }
        };
        request.onerror = () => { workError = request.error; };
      };
      requireStableWorkspace(tx, proceed);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(workError || tx.error);
      tx.onabort = () => reject(workError || tx.error);
    });
  }

  async function updateArticleReading(id, readingChanges = {}) {
    return await updateRecord(id, current => ({
      ...current,
      lastReadAt: readingChanges.lastReadAt || current.lastReadAt,
      reading: normalizeReading(readingChanges, current.reading)
    }));
  }

  // The workspace scope and Article lifecycle live in LibraryDB, so a stale tab
  // cannot validate an old movement against a new owner's identical Article.
  async function getProgressContext(articleId, owner = null, { initialize = true } = {}) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([ARTICLE_STORE, PROGRESS_FENCE_STORE, PROGRESS_CONTROL_STORE], initialize ? "readwrite" : "readonly");
      const articles = tx.objectStore(ARTICLE_STORE);
      const fences = tx.objectStore(PROGRESS_FENCE_STORE);
      const controls = tx.objectStore(PROGRESS_CONTROL_STORE);
      let result;
      const controlRequest = controls.get("workspace");
      controlRequest.onsuccess = () => {
        const transitionRequest = controls.get(WORKSPACE_TRANSITION_KEY);
        transitionRequest.onsuccess = () => {
          if (transitionRequest.result) {
            result = { status: "workspace-transition" };
            return;
          }
          let scope = controlRequest.result || null;
          if (owner && !scope) {
            if (!initialize) { result = { status: "scope-missing" }; return; }
            scope = { key: "workspace", ownerId: owner.ownerId, bindingId: owner.bindingId,
              scopeToken: newFenceToken() };
            controls.put(scope);
          }
          if (owner && (scope.ownerId !== owner.ownerId || scope.bindingId !== owner.bindingId)) {
            result = { status: "scope-mismatch" };
            return;
          }
          const articleRequest = articles.get(articleId);
          articleRequest.onsuccess = () => {
            const article = articleRequest.result || null;
            if (!article) { result = { status: "missing" }; return; }
            const fenceRequest = fences.get(articleId);
            fenceRequest.onsuccess = () => {
              if (!fenceRequest.result && !initialize) { result = { status: "fence-missing" }; return; }
              const fence = fenceRequest.result || initialProgressFence(articleId);
              if (!fenceRequest.result) fences.put(fence);
              result = { status: "ready", article, fence, scope };
            };
          };
        };
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error("Progress Article context 读取失败。"));
      tx.onabort = () => reject(tx.error || new Error("Progress Article context 事务中止。"));
    });
  }

  // Compare-and-set inside the Article transaction. The caller hashes expectedContent
  // before opening this transaction; byte-for-byte content equality makes that hash
  // a safe precondition without awaiting crypto while an IDB transaction is active.
  async function commitReadingResumeIfCurrent(input) {
    assertWritesAllowed();
    const normalize = window.LingoFlowReadingResume?.normalizeCheckpoint;
    const target = normalize?.(input?.target);
    const before = input?.beforeResume === null ? null : normalize?.(input?.beforeResume);
    if (!input?.articleId || typeof input.expectedContent !== "string" || !target ||
        target.contentFingerprint !== input.contentFingerprint ||
        (input.beforeResume !== null && !before) ||
        !input.expectedFence?.lifecycleToken ||
        !Number.isInteger(input.expectedFence.resumeRevision)) {
      throw new Error("Resume CAS 参数无效。");
    }
    if (await window.LingoFlowReadingResume.fingerprintContent(input.expectedContent) !==
        input.contentFingerprint) return { status: "content-mismatch", article: null };
    assertWritesAllowed();
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([ARTICLE_STORE, PROGRESS_FENCE_STORE, PROGRESS_CONTROL_STORE], "readwrite");
      const store = tx.objectStore(ARTICLE_STORE);
      const fences = tx.objectStore(PROGRESS_FENCE_STORE);
      const controls = tx.objectStore(PROGRESS_CONTROL_STORE);
      const request = store.get(input.articleId);
      let result;
      let workError;
      request.onsuccess = () => {
        try {
          const current = request.result;
          if (!current || current.deletedAt) {
            result = { status: "missing", article: current || null };
            return;
          }
          if (current.content !== input.expectedContent) {
            result = { status: "content-mismatch", article: current };
            return;
          }
          const controlRequest = controls.get("workspace");
          controlRequest.onsuccess = () => {
            const transitionRequest = controls.get(WORKSPACE_TRANSITION_KEY);
            transitionRequest.onsuccess = () => {
            if (transitionRequest.result) {
              result = { status: "workspace-transition", article: current };
              return;
            }
            const scope = controlRequest.result || null;
            if (!sameProgressScope(scope, input.scope)) {
              result = { status: "scope-mismatch", article: current };
              return;
            }
            const fenceRequest = fences.get(input.articleId);
            fenceRequest.onsuccess = () => {
              try {
                const fence = fenceRequest.result;
                if (!fence || fence.lifecycleToken !== input.expectedFence.lifecycleToken) {
                  result = { status: "lifecycle-mismatch", article: current };
                  return;
                }
                const rawResume = current.reading?.resume;
                const actual = normalize(rawResume);
                if (rawResume !== undefined && rawResume !== null && !actual) {
                  result = { status: "malformed-resume", article: current, fence };
                  return;
                }
                const action = input.action || null;
                if (action && fence.action?.actionId === action.actionId &&
                    fence.action.localSeq === action.localSeq && valuesEqual(actual, target)) {
                  result = { status: "already-applied", article: current, fence };
                  return;
                }
                if (action && (!Number.isSafeInteger(action.localSeq) || action.localSeq < 1 ||
                    action.ownerId !== scope.ownerId || action.bindingId !== scope.bindingId)) {
                  result = { status: "invalid-action", article: current };
                  return;
                }
                const trustedSuccessor = Boolean(action && fence.action &&
                  fence.action.ownerId === scope.ownerId &&
                  fence.action.bindingId === scope.bindingId &&
                  fence.action.scopeToken === scope.scopeToken &&
                  fence.action.lifecycleToken === fence.lifecycleToken &&
                  fence.action.contentFingerprint === input.contentFingerprint &&
                  fence.action.localSeq < action.localSeq &&
                  valuesEqual(actual, fence.action.target));
                if (action && fence.action?.localSeq >= action.localSeq) {
                  result = { status: "stale-action", article: current, fence };
                  return;
                }
                if (!trustedSuccessor && (fence.resumeRevision !== input.expectedFence.resumeRevision ||
                    !valuesEqual(actual, before))) {
                  result = { status: "unknown-resume-change", article: current, fence };
                  return;
                }
                const reading = { ...current.reading, resume: target };
                const furthest = input.furthest;
                if (furthest && Number.isFinite(furthest.progress) &&
                    furthest.progress > Number(reading.progress || 0)) {
                  reading.progress = Math.min(1, Math.max(0, furthest.progress));
                  reading.paragraphIndex = Math.max(0, Math.trunc(furthest.paragraphIndex || 0));
                  reading.updatedAt = target.updatedAt;
                }
                const article = { ...current, reading: normalizeReading(reading) };
                const nextFence = { ...fence, resumeRevision: fence.resumeRevision + 1,
                  action: action ? { actionId: action.actionId, localSeq: action.localSeq,
                    ownerId: scope.ownerId, bindingId: scope.bindingId,
                    scopeToken: scope.scopeToken, lifecycleToken: fence.lifecycleToken,
                    contentFingerprint: input.contentFingerprint, target } : null };
                store.put(article);
                fences.put(nextFence);
                result = { status: "committed", article, fence: nextFence };
              } catch (error) { workError = error; tx.abort(); }
            };
            };
          };
        } catch (error) {
          workError = error;
          tx.abort();
        }
      };
      request.onerror = () => { workError = request.error; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(workError || tx.error);
      tx.onabort = () => reject(workError || tx.error);
    });
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
    const matches = await findArticlesBySource(sourceType, sourceId);
    return matches.find(article => !article.deletedAt) || matches[0] || null;
  }

  async function findArticlesBySource(sourceType, sourceId) {
    const type = normalizeSourceType(sourceType);
    const id = String(sourceId || "").trim();
    if (!id) return [];

    const db = await openDatabase();
    const tx = db.transaction(ARTICLE_STORE, "readonly");
    const request = tx.objectStore(ARTICLE_STORE).index("bySource").getAll([type, id]);
    return await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error("文章来源查询失败。"));
    });
  }

  async function assessArticleRestore(article) {
    const validation = validateRestoreArticle(article);
    if (validation.result) return validation.result;

    const incoming = validation.article;
    const current = await getArticle(incoming.id);
    if (current) return classifyArticleRestore(current, incoming);

    return createRestoreResult("restored", incoming.id);
  }

  async function restoreArticle(article) {
    assertWritesAllowed();
    const validation = validateRestoreArticle(article);
    if (validation.result) return validation.result;

    const incoming = validation.article;
    const db = await openDatabase();

    return await new Promise((resolve, reject) => {
      const tx = db.transaction([ARTICLE_STORE, PROGRESS_FENCE_STORE, PROGRESS_CONTROL_STORE], "readwrite");
      const store = tx.objectStore(ARTICLE_STORE);
      const fences = tx.objectStore(PROGRESS_FENCE_STORE);
      let request;
      let result = null;
      let restoreError = null;

      function addIncomingArticle() {
        try {
          const addRequest = store.add(incoming);
          fences.put(initialProgressFence(incoming.id));
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

      const proceed = () => {
        request = store.get(incoming.id);
        request.onsuccess = () => {
          const current = request.result;
          if (current) {
            result = classifyArticleRestore(current, incoming);
            return;
          }

          // Article identity is its stable ID. The source index is only a query hint.
          addIncomingArticle();
        };
        request.onerror = () => {
          restoreError = request.error || new Error("文章读取失败。");
        };
      };
      requireStableWorkspace(tx, proceed);

      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(restoreError || tx.error || new Error("文章恢复失败。"));
      tx.onabort = () => reject(restoreError || tx.error || new Error("文章恢复事务已中止。"));
    });
  }

  function normalizedArticleCollection(values) {
    if (!Array.isArray(values)) throw new Error("文章快照无效。");
    const articles = values.map(value => {
      const validation = validateRestoreArticle(value);
      if (validation.result) throw new Error("文章快照包含无效记录。");
      return validation.article;
    }).sort((left, right) => left.id.localeCompare(right.id));
    if (new Set(articles.map(article => article.id)).size !== articles.length) {
      throw new Error("文章快照包含重复记录。");
    }
    return articles;
  }

  async function getWorkspaceTransition() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PROGRESS_CONTROL_STORE, "readonly");
      const request = tx.objectStore(PROGRESS_CONTROL_STORE).get(WORKSPACE_TRANSITION_KEY);
      tx.oncomplete = () => resolve(request.result || null);
      tx.onerror = () => reject(tx.error || new Error("Workspace transition 读取失败。"));
    });
  }

  async function beginWorkspaceTransition({ from, to, storageSnapshot }) {
    if (!from?.ownerId || !from?.bindingId || !to?.ownerId || !to?.bindingId ||
        !Array.isArray(storageSnapshot)) throw new Error("Workspace transition 参数无效。");
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(PROGRESS_CONTROL_STORE, "readwrite");
      const control = tx.objectStore(PROGRESS_CONTROL_STORE);
      let result;
      const transitionRequest = control.get(WORKSPACE_TRANSITION_KEY);
      transitionRequest.onsuccess = () => {
        if (transitionRequest.result) {
          result = { status: "blocked", reason: "workspace-transition" };
          return;
        }
        const scopeRequest = control.get("workspace");
        scopeRequest.onsuccess = () => {
          const scope = scopeRequest.result || null;
          if (scope && (scope.ownerId !== from.ownerId || scope.bindingId !== from.bindingId)) {
            result = { status: "blocked", reason: "scope-mismatch" };
            return;
          }
          const transition = { key: WORKSPACE_TRANSITION_KEY,
            transitionId: newFenceToken(), from, to, fromScope: scope,
            storageSnapshot };
          control.put(transition);
          result = { status: "switching", transition };
        };
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error("Workspace transition 开始失败。"));
      tx.onabort = () => reject(tx.error || new Error("Workspace transition 事务中止。"));
    });
  }

  async function finishWorkspaceTransition(transitionId, outcome) {
    if (!transitionId || !["finalize", "rollback"].includes(outcome)) {
      throw new Error("Workspace transition 结束参数无效。");
    }
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([ARTICLE_STORE, PROGRESS_FENCE_STORE, PROGRESS_CONTROL_STORE], "readwrite");
      const control = tx.objectStore(PROGRESS_CONTROL_STORE);
      let result;
      const request = control.get(WORKSPACE_TRANSITION_KEY);
      request.onsuccess = () => {
        const transition = request.result;
        if (!transition || transition.transitionId !== transitionId) {
          result = { status: "blocked", reason: "transition-mismatch" };
          return;
        }
        const scopeRequest = control.get("workspace");
        scopeRequest.onsuccess = () => {
          const scope = scopeRequest.result || null;
          if (!sameProgressScope(scope, transition.fromScope)) {
            result = { status: "blocked", reason: "scope-mismatch" };
            return;
          }
          if (outcome === "finalize") {
            tx.objectStore(ARTICLE_STORE).clear();
            tx.objectStore(PROGRESS_FENCE_STORE).clear();
            control.put({ key: "workspace", ownerId: transition.to.ownerId,
              bindingId: transition.to.bindingId, scopeToken: newFenceToken() });
          }
          control.delete(WORKSPACE_TRANSITION_KEY);
          result = { status: outcome === "finalize" ? "finalized" : "rolled-back" };
        };
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error("Workspace transition 结束失败。"));
      tx.onabort = () => reject(tx.error || new Error("Workspace transition 结束事务中止。"));
    });
  }

  async function snapshotProgressState() {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([PROGRESS_FENCE_STORE, PROGRESS_CONTROL_STORE], "readonly");
      const fencesRequest = tx.objectStore(PROGRESS_FENCE_STORE).getAll();
      const scopeRequest = tx.objectStore(PROGRESS_CONTROL_STORE).get("workspace");
      tx.oncomplete = () => resolve({ fences: fencesRequest.result || [],
        scope: scopeRequest.result || null });
      tx.onerror = () => reject(tx.error || new Error("Progress fence 快照读取失败。"));
    });
  }

  async function replaceAllArticles(expectedValues, replacementValues, options = {}) {
    const expected = normalizedArticleCollection(expectedValues);
    const replacements = normalizedArticleCollection(replacementValues);
    const db = await openDatabase();

    return await new Promise((resolve, reject) => {
      const tx = db.transaction([ARTICLE_STORE, PROGRESS_FENCE_STORE, PROGRESS_CONTROL_STORE], "readwrite");
      const store = tx.objectStore(ARTICLE_STORE);
      const fences = tx.objectStore(PROGRESS_FENCE_STORE);
      const controls = tx.objectStore(PROGRESS_CONTROL_STORE);
      const request = store.getAll();
      let result = null;
      let replacementError = null;

      request.onsuccess = () => {
        try {
          const transitionRequest = controls.get(WORKSPACE_TRANSITION_KEY);
          transitionRequest.onsuccess = () => {
            try {
              if (transitionRequest.result) {
                result = { status: "blocked", reason: "workspace-transition" };
                return;
              }
              const current = normalizedArticleCollection(request.result || []);
              if (!valuesEqual(current, expected)) {
                result = { status: "blocked", reason: "article-snapshot-changed" };
                return;
              }
              store.clear();
              fences.clear();
              for (const article of replacements) store.add(article);
              if (options.restoreProgressState) {
                for (const fence of options.restoreProgressState.fences || []) fences.put(fence);
                if (options.restoreProgressState.scope) controls.put(options.restoreProgressState.scope);
                else controls.delete("workspace");
              } else {
                for (const article of replacements) fences.put(initialProgressFence(article.id));
              }
              if (options.nextProgressScope) {
                const { ownerId, bindingId } = options.nextProgressScope;
                if (!ownerId || !bindingId) throw new Error("Progress scope 无效。");
                controls.put({ key: "workspace", ownerId, bindingId, scopeToken: newFenceToken() });
              }
              result = { status: "replaced", count: replacements.length };
            } catch (error) {
              replacementError = error;
              tx.abort();
            }
          };
        } catch (error) {
          replacementError = error;
          tx.abort();
        }
      };
      request.onerror = () => {
        replacementError = request.error || new Error("文章快照读取失败。");
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(
        replacementError || tx.error || new Error("文章快照替换失败。")
      );
      tx.onabort = () => reject(
        replacementError || tx.error || new Error("文章快照替换事务已中止。")
      );
    });
  }

  function setAccountSwitchWriteBlocked(value) {
    accountSwitchWriteBlocked = Boolean(value);
  }

  window.LingoFlowArticleLibrary = Object.freeze({
    DB_NAME,
    DB_VERSION,
    openDatabase,
    createArticle,
    planCreateArticle: buildArticleRecord,
    planUpdatedArticle,
    getArticle,
    updateArticle,
    updateArticleReading,
    getProgressContext,
    commitReadingResumeIfCurrent,
    commitArticleSyncProjection,
    listArticles,
    findArticleBySource,
    findArticlesBySource,
    assessArticleRestore,
    restoreArticle,
    snapshotProgressState,
    getWorkspaceTransition,
    beginWorkspaceTransition,
    finishWorkspaceTransition,
    replaceAllArticles,
    setAccountSwitchWriteBlocked
  });
})();
