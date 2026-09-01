(function() {
  "use strict";

  const DB_NAME = "LingoFlowSyncDB";
  const DB_VERSION = 1;
  const CONTROL_STORE = "control";
  const SIDECAR_STORE = "entitySidecars";
  const OUTBOX_STORE = "outbox";
  const BINDING_KEY = "workspace-binding";
  const FAVORITE_WRITER_KEY = "favorite-writer-lock";
  const FAVORITE_LOCK_NAME = "lingoflow:favorite-global-writer";
  const OUTBOX_STATUSES = new Set(["prepared", "ready"]);
  const LOCAL_OPERATIONS = new Set([
    "create",
    "update",
    "soft-delete",
    "restore",
    "drift"
  ]);
  const SIDECAR_FIELDS = new Set([
    "ownerId",
    "bindingId",
    "entityType",
    "entityId",
    "scope",
    "schemaVersion",
    "serverRevision",
    "lastSyncedSnapshot",
    "lastSyncedFingerprint"
  ]);
  const OUTBOX_FIELDS = new Set([
    "ownerId",
    "bindingId",
    "mutationId",
    "status",
    "entityType",
    "entityId",
    "scope",
    "createdAt",
    "localOperation",
    "localBeforeSnapshot",
    "localBeforeFingerprint",
    "candidateFingerprint",
    "request"
  ]);
  let databasePromise = null;

  function getCanonical() {
    const canonical = window.LingoFlowSyncCanonical;
    if (!canonical ||
        typeof canonical.snapshot !== "function" ||
        typeof canonical.fingerprint !== "function" ||
        typeof canonical.valuesEqual !== "function") {
      throw new Error("Sync canonical boundary 不可用。");
    }
    return canonical;
  }

  function getFavoriteSchema() {
    const schema = window.LingoFlowFavoriteBackupSchema;
    if (!schema || typeof schema.validateFavorite !== "function") {
      throw new Error("Favorite Schema 不可用。");
    }
    return schema;
  }

  function getProtocol() {
    const protocol = window.LingoFlowCloudSyncProtocol;
    if (!protocol || typeof protocol.validateMutation !== "function") {
      throw new Error("Cloud Sync Protocol 不可用。");
    }
    return protocol;
  }

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function isOpaqueString(value) {
    return typeof value === "string" && Boolean(value.trim()) && value === value.trim();
  }

  function isCanonicalTimestamp(value) {
    if (typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
      return false;
    }
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  }

  function hasExactFields(value, fields) {
    const keys = Object.keys(value).sort();
    const expected = Array.from(fields).sort();
    return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
  }

  function failed(reason, error = null) {
    return {
      status: "failed",
      reason,
      ...(error?.message ? { message: error.message } : {})
    };
  }

  function blocked(reason, details = {}) {
    return { status: "blocked", reason, ...details };
  }

  function getWorkspaceMismatch(value, ownerId, bindingId) {
    if (value.ownerId !== ownerId) return blocked("workspace-owner-mismatch");
    if (value.bindingId !== bindingId) return blocked("workspace-binding-mismatch");
    return null;
  }

  function isSameFavoriteRecord(value, identity) {
    return value.entityType === identity.entityType &&
      value.entityId === identity.entityId &&
      value.scope === identity.scope;
  }

  function validateBindingInput(value) {
    const binding = getCanonical().snapshot(value, "binding");
    if (!isPlainObject(binding) ||
        !hasExactFields(binding, new Set(["bindingId", "ownerId"])) ||
        !isOpaqueString(binding.bindingId) ||
        !isOpaqueString(binding.ownerId)) {
      throw new Error("Workspace binding 无效。");
    }
    return binding;
  }

  function validateStoredBinding(value) {
    const binding = getCanonical().snapshot(value, "binding");
    if (!isPlainObject(binding) ||
        !hasExactFields(binding, new Set(["key", "bindingId", "ownerId"])) ||
        binding.key !== BINDING_KEY ||
        !isOpaqueString(binding.bindingId) ||
        !isOpaqueString(binding.ownerId)) {
      throw new Error("Workspace binding 存储记录无效。");
    }
    return binding;
  }

  function validateFavoriteSnapshot(value, entityId, nullable = false) {
    if (nullable && value === null) return null;
    const snapshot = getCanonical().snapshot(value, "favorite");
    const validation = getFavoriteSchema().validateFavorite(snapshot);
    if (!validation || validation.status !== "valid" || validation.favoriteId !== entityId) {
      throw new Error("Favorite snapshot 无效。");
    }
    return snapshot;
  }

  function validateSidecar(value) {
    const sidecar = getCanonical().snapshot(value, "sidecar");
    if (!isPlainObject(sidecar) || !hasExactFields(sidecar, SIDECAR_FIELDS)) {
      throw new Error("Favorite sidecar 结构无效。");
    }
    if (!isOpaqueString(sidecar.ownerId) ||
        !isOpaqueString(sidecar.bindingId) ||
        sidecar.entityType !== "favorites" ||
        !isOpaqueString(sidecar.entityId) ||
        sidecar.scope !== "record" ||
        sidecar.schemaVersion !== "1") {
      throw new Error("Favorite sidecar identity 无效。");
    }
    if (sidecar.serverRevision !== null && !isOpaqueString(sidecar.serverRevision)) {
      throw new Error("Favorite sidecar revision 无效。");
    }

    const snapshot = validateFavoriteSnapshot(
      sidecar.lastSyncedSnapshot,
      sidecar.entityId,
      true
    );
    if (snapshot === null) {
      if (sidecar.serverRevision !== null || sidecar.lastSyncedFingerprint !== null) {
        throw new Error("空 sidecar snapshot 不能携带 revision 或 fingerprint。");
      }
    } else {
      if (sidecar.serverRevision === null || typeof sidecar.lastSyncedFingerprint !== "string") {
        throw new Error("已同步 sidecar 缺少 revision 或 fingerprint。");
      }
      if (sidecar.lastSyncedFingerprint !== getCanonical().fingerprint(snapshot)) {
        throw new Error("Favorite sidecar fingerprint 不匹配。");
      }
    }
    sidecar.lastSyncedSnapshot = snapshot;
    return sidecar;
  }

  function validateOutbox(value) {
    const item = getCanonical().snapshot(value, "outbox");
    if (!isPlainObject(item) || !hasExactFields(item, OUTBOX_FIELDS)) {
      throw new Error("Outbox item 结构无效。");
    }
    if (!isOpaqueString(item.ownerId) ||
        !isOpaqueString(item.bindingId) ||
        !isOpaqueString(item.mutationId) ||
        !OUTBOX_STATUSES.has(item.status) ||
        item.entityType !== "favorites" ||
        !isOpaqueString(item.entityId) ||
        item.scope !== "record" ||
        !isCanonicalTimestamp(item.createdAt) ||
        !LOCAL_OPERATIONS.has(item.localOperation)) {
      throw new Error("Outbox item metadata 无效。");
    }

    const protocolResult = getProtocol().validateMutation(item.request);
    if (!protocolResult || protocolResult.status !== "valid") {
      throw new Error("Outbox wire request 无效。");
    }
    item.request = protocolResult.mutation;
    if (item.request.mutationId !== item.mutationId ||
        item.request.entityType !== item.entityType ||
        item.request.entityId !== item.entityId ||
        item.request.scope !== item.scope) {
      throw new Error("Outbox metadata 与 wire request 不一致。");
    }

    item.localBeforeSnapshot = validateFavoriteSnapshot(
      item.localBeforeSnapshot,
      item.entityId,
      true
    );
    if (item.localBeforeSnapshot === null) {
      if (item.localBeforeFingerprint !== null) {
        throw new Error("Missing local-before 不能携带 fingerprint。");
      }
    } else if (item.localBeforeFingerprint !==
        getCanonical().fingerprint(item.localBeforeSnapshot)) {
      throw new Error("Outbox local-before fingerprint 不匹配。");
    }
    if (item.candidateFingerprint !== getCanonical().fingerprint(item.request.payload)) {
      throw new Error("Outbox candidate fingerprint 不匹配。");
    }
    return item;
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
    });
  }

  function runTransaction(storeNames, mode, work) {
    return openDatabase().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, mode);
      let result;
      let workError = null;

      Promise.resolve()
        .then(() => work(tx))
        .then(value => {
          result = value;
        })
        .catch(error => {
          workError = error;
          try {
            tx.abort();
          } catch {
            reject(error);
          }
        });

      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(workError || tx.error || new Error("Sync DB transaction failed."));
      tx.onabort = () => reject(workError || tx.error || new Error("Sync DB transaction aborted."));
    }));
  }

  function openDatabase() {
    if (!("indexedDB" in window)) return Promise.reject(new Error("IndexedDB 不可用。"));
    if (databasePromise) return databasePromise;

    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      let blockedOpen = false;

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(CONTROL_STORE)) {
          db.createObjectStore(CONTROL_STORE, { keyPath: "key" });
        }

        const sidecars = db.objectStoreNames.contains(SIDECAR_STORE)
          ? request.transaction.objectStore(SIDECAR_STORE)
          : db.createObjectStore(SIDECAR_STORE, {
              keyPath: ["ownerId", "entityType", "entityId", "scope"]
            });
        if (!sidecars.indexNames.contains("byOwnerEntityType")) {
          sidecars.createIndex(
            "byOwnerEntityType",
            ["ownerId", "entityType"],
            { unique: false }
          );
        }

        const outbox = db.objectStoreNames.contains(OUTBOX_STORE)
          ? request.transaction.objectStore(OUTBOX_STORE)
          : db.createObjectStore(OUTBOX_STORE, {
              keyPath: ["ownerId", "mutationId"]
            });
        if (!outbox.indexNames.contains("byOwnerRecord")) {
          outbox.createIndex(
            "byOwnerRecord",
            ["ownerId", "entityType", "entityId", "scope"],
            { unique: false }
          );
        }
        if (!outbox.indexNames.contains("byOwnerStatusCreatedAt")) {
          outbox.createIndex(
            "byOwnerStatusCreatedAt",
            ["ownerId", "status", "createdAt"],
            { unique: false }
          );
        }
      };

      request.onsuccess = () => {
        if (blockedOpen) {
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
        reject(request.error || new Error("无法打开 Sync DB。"));
      };
      request.onblocked = () => {
        blockedOpen = true;
        databasePromise = null;
        reject(new Error("Sync DB 升级被其他页面阻塞。"));
      };
    });
    return databasePromise;
  }

  function closeDatabase() {
    if (!databasePromise) return;
    databasePromise.then(db => db.close()).catch(() => {});
    databasePromise = null;
  }

  async function bindWorkspace(value) {
    let binding;
    try {
      binding = validateBindingInput(value);
      return await runTransaction([CONTROL_STORE], "readwrite", async tx => {
        const store = tx.objectStore(CONTROL_STORE);
        const currentValue = await requestResult(store.get(BINDING_KEY));
        if (currentValue !== undefined) {
          const current = validateStoredBinding(currentValue);
          if (current.ownerId !== binding.ownerId) {
            return blocked("workspace-owner-mismatch", { binding: current });
          }
          if (current.bindingId !== binding.bindingId) {
            return blocked("workspace-binding-mismatch", { binding: current });
          }
          return { status: "unchanged", binding: current };
        }

        const stored = { key: BINDING_KEY, ...binding };
        await requestResult(store.add(stored));
        return { status: "bound", binding: stored };
      });
    } catch (error) {
      return failed("workspace-binding-failed", error);
    }
  }

  async function getWorkspaceBinding() {
    try {
      const value = await runTransaction([CONTROL_STORE], "readonly", tx => (
        requestResult(tx.objectStore(CONTROL_STORE).get(BINDING_KEY))
      ));
      if (value === undefined) return { status: "missing", binding: null };
      return { status: "ready", binding: validateStoredBinding(value) };
    } catch (error) {
      return failed("workspace-binding-read-failed", error);
    }
  }

  async function requireBinding(store, ownerId, bindingId) {
    const value = await requestResult(store.get(BINDING_KEY));
    if (value === undefined) return blocked("workspace-unbound");
    const current = validateStoredBinding(value);
    if (current.ownerId !== ownerId) return blocked("workspace-owner-mismatch");
    if (current.bindingId !== bindingId) return blocked("workspace-binding-mismatch");
    return { status: "ready", binding: current };
  }

  function createLease(ownerId, bindingId, leaseMs) {
    const now = Date.now();
    const leaseToken = window.crypto?.randomUUID
      ? `favorite-writer:${window.crypto.randomUUID()}`
      : null;
    if (!leaseToken) throw new Error("无法生成 Favorite writer token。");
    return {
      key: FAVORITE_WRITER_KEY,
      ownerId,
      bindingId,
      leaseToken,
      acquiredAt: new Date(now).toISOString(),
      expiresAt: new Date(now + leaseMs).toISOString()
    };
  }

  async function writeFavoriteWriterLease(ownerId, bindingId, leaseMs) {
    return await runTransaction([CONTROL_STORE], "readwrite", async tx => {
      const store = tx.objectStore(CONTROL_STORE);
      const binding = await requireBinding(store, ownerId, bindingId);
      if (binding.status !== "ready") return binding;
      const lease = createLease(ownerId, bindingId, leaseMs);
      await requestResult(store.put(lease));
      return { status: "acquired", lease };
    });
  }

  async function releaseFavoriteWriterLease(lease) {
    try {
      return await runTransaction([CONTROL_STORE], "readwrite", async tx => {
        const store = tx.objectStore(CONTROL_STORE);
        const current = await requestResult(store.get(FAVORITE_WRITER_KEY));
        if (current === undefined) return { status: "missing" };
        if (current.leaseToken !== lease.leaseToken) {
          return blocked("favorite-writer-token-mismatch");
        }
        await requestResult(store.delete(FAVORITE_WRITER_KEY));
        return { status: "released" };
      });
    } catch (error) {
      return failed("favorite-writer-release-failed", error);
    }
  }

  async function getFavoriteWriterLease() {
    try {
      const value = await runTransaction([CONTROL_STORE], "readonly", tx => (
        requestResult(tx.objectStore(CONTROL_STORE).get(FAVORITE_WRITER_KEY))
      ));
      return value === undefined
        ? { status: "missing", lease: null }
        : { status: "ready", lease: getCanonical().snapshot(value) };
    } catch (error) {
      return failed("favorite-writer-read-failed", error);
    }
  }

  async function withFavoriteWriterLock(context, callback, options = {}) {
    let ownerId;
    let bindingId;
    try {
      const owner = validateBindingInput(context);
      ownerId = owner.ownerId;
      bindingId = owner.bindingId;
      if (typeof callback !== "function") throw new Error("缺少 Favorite writer callback。");
      if (!navigator.locks || typeof navigator.locks.request !== "function") {
        return blocked("favorite-writer-lock-unavailable");
      }
    } catch (error) {
      return failed("favorite-writer-invalid-input", error);
    }

    const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : 2000;
    const leaseMs = Number.isInteger(options.leaseMs) && options.leaseMs > 0
      ? options.leaseMs
      : 30000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await navigator.locks.request(
        FAVORITE_LOCK_NAME,
        { mode: "exclusive", signal: controller.signal },
        async () => {
          clearTimeout(timeout);
          let acquired;
          try {
            acquired = await writeFavoriteWriterLease(ownerId, bindingId, leaseMs);
          } catch (error) {
            return failed("favorite-writer-acquire-failed", error);
          }
          if (acquired.status !== "acquired") return acquired;

          try {
            return await callback(getCanonical().snapshot(acquired.lease));
          } catch (error) {
            return failed("favorite-writer-callback-failed", error);
          } finally {
            await releaseFavoriteWriterLease(acquired.lease);
          }
        }
      );
    } catch (error) {
      clearTimeout(timeout);
      if (error?.name === "AbortError") return blocked("favorite-writer-busy");
      return failed("favorite-writer-acquire-failed", error);
    }
  }

  async function getSidecar(ownerId, entityId) {
    try {
      if (!isOpaqueString(ownerId) || !isOpaqueString(entityId)) {
        throw new Error("Favorite sidecar identity 无效。");
      }
      const values = await runTransaction([SIDECAR_STORE], "readonly", tx => (
        requestResult(tx.objectStore(SIDECAR_STORE).getAll())
      ));
      const sidecars = values.map(validateSidecar).filter(sidecar => (
        isSameFavoriteRecord(sidecar, {
          entityType: "favorites",
          entityId,
          scope: "record"
        })
      ));
      const ownerMismatch = sidecars.find(sidecar => sidecar.ownerId !== ownerId);
      if (ownerMismatch) return blocked("workspace-owner-mismatch");
      if (!sidecars.length) return { status: "missing", sidecar: null };
      return { status: "ready", sidecar: sidecars[0] };
    } catch (error) {
      return failed("favorite-sidecar-read-failed", error);
    }
  }

  async function listSidecars(ownerId) {
    try {
      if (!isOpaqueString(ownerId)) throw new Error("ownerId 无效。");
      const values = await runTransaction([SIDECAR_STORE], "readonly", tx => (
        requestResult(tx.objectStore(SIDECAR_STORE).getAll())
      ));
      const allSidecars = values.map(validateSidecar);
      if (allSidecars.some(sidecar => (
        sidecar.entityType === "favorites" && sidecar.ownerId !== ownerId
      ))) {
        return blocked("workspace-owner-mismatch");
      }
      const sidecars = allSidecars
        .filter(sidecar => sidecar.ownerId === ownerId && sidecar.entityType === "favorites")
        .sort((left, right) => left.entityId.localeCompare(right.entityId));
      return { status: "ready", sidecars };
    } catch (error) {
      return failed("favorite-sidecar-list-failed", error);
    }
  }

  async function putSidecar(value) {
    try {
      const sidecar = validateSidecar(value);
      return await runTransaction([CONTROL_STORE, SIDECAR_STORE], "readwrite", async tx => {
        const binding = await requireBinding(
          tx.objectStore(CONTROL_STORE),
          sidecar.ownerId,
          sidecar.bindingId
        );
        if (binding.status !== "ready") return binding;
        const store = tx.objectStore(SIDECAR_STORE);
        const storedValues = await requestResult(store.getAll());
        const relevant = storedValues.map(validateSidecar)
          .filter(current => isSameFavoriteRecord(current, sidecar));
        for (const current of relevant) {
          const mismatch = getWorkspaceMismatch(
            current,
            sidecar.ownerId,
            sidecar.bindingId
          );
          if (mismatch) return mismatch;
        }
        await requestResult(store.put(sidecar));
        return { status: "ready", sidecar };
      });
    } catch (error) {
      return failed("favorite-sidecar-write-failed", error);
    }
  }

  async function requireWriterLease(store, ownerId, bindingId, leaseToken) {
    const lease = await requestResult(store.get(FAVORITE_WRITER_KEY));
    if (lease === undefined || lease.leaseToken !== leaseToken) {
      return blocked("favorite-writer-lease-missing");
    }
    if (lease.ownerId !== ownerId || lease.bindingId !== bindingId) {
      return blocked("favorite-writer-lease-mismatch");
    }
    return { status: "ready" };
  }

  async function prepareOutbox(value, options = {}) {
    try {
      const item = validateOutbox(value);
      if (!isPlainObject(options) || !isOpaqueString(options.leaseToken)) {
        throw new Error("prepareOutbox options 无效。");
      }
      const replaceReady = Boolean(options.replaceReady);

      return await runTransaction(
        [CONTROL_STORE, SIDECAR_STORE, OUTBOX_STORE],
        "readwrite",
        async tx => {
          const control = tx.objectStore(CONTROL_STORE);
          const binding = await requireBinding(control, item.ownerId, item.bindingId);
          if (binding.status !== "ready") return binding;
          const lease = await requireWriterLease(
            control,
            item.ownerId,
            item.bindingId,
            options.leaseToken
          );
          if (lease.status !== "ready") return lease;

          const sidecarValues = await requestResult(
            tx.objectStore(SIDECAR_STORE).getAll()
          );
          const relevantSidecars = sidecarValues.map(validateSidecar)
            .filter(current => isSameFavoriteRecord(current, item));
          for (const current of relevantSidecars) {
            const mismatch = getWorkspaceMismatch(
              current,
              item.ownerId,
              item.bindingId
            );
            if (mismatch) return mismatch;
          }
          const sidecar = relevantSidecars[0] || null;
          const expectedRevision = sidecar?.serverRevision ?? null;
          if (item.request.baseRevision !== expectedRevision) {
            return blocked("sidecar-revision-changed");
          }

          const store = tx.objectStore(OUTBOX_STORE);
          const pendingValues = await requestResult(store.getAll());
          const pending = pendingValues.map(validateOutbox)
            .filter(current => isSameFavoriteRecord(current, item));
          for (const current of pending) {
            const mismatch = getWorkspaceMismatch(
              current,
              item.ownerId,
              item.bindingId
            );
            if (mismatch) return mismatch;
          }
          if (pending.some(current => current.status === "prepared")) {
            return blocked("prepared-mutation-exists");
          }
          if (pending.some(current => current.status === "ready") && !replaceReady) {
            return blocked("ready-mutation-exists");
          }

          const replacedMutationIds = [];
          if (replaceReady) {
            for (const current of pending) {
              if (current.status !== "ready") continue;
              await requestResult(store.delete([current.ownerId, current.mutationId]));
              replacedMutationIds.push(current.mutationId);
            }
          }
          await requestResult(store.add(item));
          return { status: "prepared", item, replacedMutationIds };
        }
      );
    } catch (error) {
      return failed("outbox-prepare-failed", error);
    }
  }

  async function markOutboxReady(context) {
    try {
      const value = getCanonical().snapshot(context, "context");
      if (!isPlainObject(value) ||
          !isOpaqueString(value.ownerId) ||
          !isOpaqueString(value.bindingId) ||
          !isOpaqueString(value.mutationId) ||
          !isOpaqueString(value.leaseToken)) {
        throw new Error("markOutboxReady context 无效。");
      }
      return await runTransaction([CONTROL_STORE, OUTBOX_STORE], "readwrite", async tx => {
        const control = tx.objectStore(CONTROL_STORE);
        const binding = await requireBinding(control, value.ownerId, value.bindingId);
        if (binding.status !== "ready") return binding;
        const lease = await requireWriterLease(
          control,
          value.ownerId,
          value.bindingId,
          value.leaseToken
        );
        if (lease.status !== "ready") return lease;

        const store = tx.objectStore(OUTBOX_STORE);
        const storedValue = await requestResult(store.get([value.ownerId, value.mutationId]));
        if (storedValue === undefined) return { status: "missing", item: null };
        const item = validateOutbox(storedValue);
        if (item.bindingId !== value.bindingId) return blocked("workspace-binding-mismatch");
        if (item.status === "ready") return { status: "ready", item };
        item.status = "ready";
        await requestResult(store.put(item));
        return { status: "ready", item };
      });
    } catch (error) {
      return failed("outbox-ready-failed", error);
    }
  }

  async function removeOutbox(context) {
    try {
      const value = getCanonical().snapshot(context, "context");
      if (!isPlainObject(value) ||
          !isOpaqueString(value.ownerId) ||
          !isOpaqueString(value.bindingId) ||
          !isOpaqueString(value.mutationId) ||
          !isOpaqueString(value.leaseToken)) {
        throw new Error("removeOutbox context 无效。");
      }
      return await runTransaction([CONTROL_STORE, OUTBOX_STORE], "readwrite", async tx => {
        const control = tx.objectStore(CONTROL_STORE);
        const binding = await requireBinding(control, value.ownerId, value.bindingId);
        if (binding.status !== "ready") return binding;
        const lease = await requireWriterLease(
          control,
          value.ownerId,
          value.bindingId,
          value.leaseToken
        );
        if (lease.status !== "ready") return lease;
        const store = tx.objectStore(OUTBOX_STORE);
        const stored = await requestResult(store.get([value.ownerId, value.mutationId]));
        if (stored === undefined) return { status: "missing" };
        await requestResult(store.delete([value.ownerId, value.mutationId]));
        return { status: "removed" };
      });
    } catch (error) {
      return failed("outbox-remove-failed", error);
    }
  }

  async function getOutbox(ownerId, mutationId) {
    try {
      if (!isOpaqueString(ownerId) || !isOpaqueString(mutationId)) {
        throw new Error("Outbox identity 无效。");
      }
      const value = await runTransaction([OUTBOX_STORE], "readonly", tx => (
        requestResult(tx.objectStore(OUTBOX_STORE).get([ownerId, mutationId]))
      ));
      if (value === undefined) return { status: "missing", item: null };
      return { status: "ready", item: validateOutbox(value) };
    } catch (error) {
      return failed("outbox-read-failed", error);
    }
  }

  async function listOutbox(query = {}) {
    try {
      const value = getCanonical().snapshot(query, "query");
      if (!isPlainObject(value) || !isOpaqueString(value.ownerId)) {
        throw new Error("Outbox query 缺少 ownerId。");
      }
      if (Object.prototype.hasOwnProperty.call(value, "status") &&
          !OUTBOX_STATUSES.has(value.status)) {
        throw new Error("Outbox query status 无效。");
      }
      if (Object.prototype.hasOwnProperty.call(value, "entityId") &&
          !isOpaqueString(value.entityId)) {
        throw new Error("Outbox query entityId 无效。");
      }

      const values = await runTransaction([OUTBOX_STORE], "readonly", tx => (
        requestResult(tx.objectStore(OUTBOX_STORE).getAll())
      ));
      const items = values.map(validateOutbox)
        .filter(item => item.ownerId === value.ownerId)
        .filter(item => !value.status || item.status === value.status)
        .filter(item => !value.entityId || item.entityId === value.entityId)
        .sort((left, right) => (
          left.createdAt.localeCompare(right.createdAt) ||
          left.mutationId.localeCompare(right.mutationId)
        ));
      return { status: "ready", items };
    } catch (error) {
      return failed("outbox-list-failed", error);
    }
  }

  window.LingoFlowSyncStateRepository = Object.freeze({
    DB_NAME,
    DB_VERSION,
    openDatabase,
    closeDatabase,
    bindWorkspace,
    getWorkspaceBinding,
    withFavoriteWriterLock,
    getFavoriteWriterLease,
    getSidecar,
    listSidecars,
    putSidecar,
    prepareOutbox,
    markOutboxReady,
    removeOutbox,
    getOutbox,
    listOutbox
  });
})();
