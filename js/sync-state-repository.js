(function() {
  "use strict";

  const DB_NAME = "LingoFlowSyncDB";
  const DB_VERSION = 3;
  const CONTROL_STORE = "control";
  const SIDECAR_STORE = "entitySidecars";
  const OUTBOX_STORE = "outbox";
  const ISSUES_STORE = "syncIssues";
  const INBOX_STORE = "inbox";
  const BINDING_KEY = "workspace-binding";
  const FAVORITE_WRITER_KEY = "favorite-writer-lock";
  const FAVORITE_LOCK_NAME = "lingoflow:favorite-global-writer";
  const PULL_PROGRESS_PREFIX = "pull-progress";
  const PULL_LEASE_PREFIX = "pull-lease";
  const PULL_ANCHOR_PREFIX = "pull-anchor";
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
    "request",
    "attemptedAt",
    "attemptCount",
    "leaseToken",
    "leaseExpiresAt",
    "dependsOnMutationId"
  ]);
  const OUTBOX_RUNTIME_FIELDS = Object.freeze([
    "attemptedAt",
    "attemptCount",
    "leaseToken",
    "leaseExpiresAt",
    "dependsOnMutationId"
  ]);
  const PUSH_ISSUE_FIELDS = new Set([
    "ownerId",
    "bindingId",
    "mutationId",
    "entityType",
    "entityId",
    "scope",
    "schemaVersion",
    "kind",
    "reason",
    "request",
    "result",
    "createdAt"
  ]);
  const PULL_ISSUE_FIELDS = new Set([
    "ownerId",
    "bindingId",
    "mutationId",
    "issueId",
    "direction",
    "entityType",
    "entityId",
    "scope",
    "schemaVersion",
    "kind",
    "reason",
    "localSnapshot",
    "sidecarSnapshot",
    "pendingMutationIds",
    "remoteChange",
    "remoteRevision",
    "remoteCursor",
    "createdAt"
  ]);
  const ISSUE_KINDS = new Set(["conflict", "rejected"]);
  const PULL_PROGRESS_FIELDS = new Set([
    "key",
    "ownerId",
    "bindingId",
    "receivedCursor",
    "appliedCursor",
    "lastInboxSeq"
  ]);
  const PULL_LEASE_FIELDS = new Set([
    "key",
    "ownerId",
    "bindingId",
    "leaseToken",
    "leaseExpiresAt",
    "startReceivedCursor"
  ]);
  const PULL_ANCHOR_FIELDS = new Set([
    "key",
    "ownerId",
    "bindingId",
    "entityType",
    "entityId",
    "scope",
    "schemaVersion",
    "revision",
    "payloadFingerprint",
    "cursor"
  ]);
  const INBOX_FIELDS = new Set([
    "ownerId",
    "bindingId",
    "inboxSeq",
    "status",
    "cursor",
    "entityType",
    "entityId",
    "scope",
    "schemaVersion",
    "revision",
    "operation",
    "change",
    "applyIntent"
  ]);
  const APPLY_INTENT_FIELDS = new Set([
    "localBeforeSnapshot",
    "candidateSnapshot",
    "expectedSidecarSnapshot",
    "remoteChangeSnapshot",
    "candidateFingerprint"
  ]);
  const INBOX_STATUSES = new Set(["received", "applying"]);
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
    if (!protocol ||
        typeof protocol.validateMutation !== "function" ||
        typeof protocol.validateResult !== "function" ||
        typeof protocol.validatePullChange !== "function" ||
        typeof protocol.validatePullResult !== "function") {
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

  function controlKey(prefix, ownerId, bindingId, suffix = "") {
    const identity = getCanonical().serialize([ownerId, bindingId, suffix]);
    return `${prefix}:${identity}`;
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
    if (!validation || validation.status !== "valid" ||
        (entityId !== null && validation.favoriteId !== entityId)) {
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
    if ((item.attemptedAt !== null && !isCanonicalTimestamp(item.attemptedAt)) ||
        !Number.isSafeInteger(item.attemptCount) || item.attemptCount < 0 ||
        (item.leaseToken !== null && !isOpaqueString(item.leaseToken)) ||
        (item.leaseExpiresAt !== null && !isCanonicalTimestamp(item.leaseExpiresAt)) ||
        (item.dependsOnMutationId !== null && !isOpaqueString(item.dependsOnMutationId)) ||
        item.dependsOnMutationId === item.mutationId) {
      throw new Error("Outbox runtime metadata 无效。");
    }
    if ((item.attemptCount === 0) !== (item.attemptedAt === null) ||
        (item.leaseToken === null) !== (item.leaseExpiresAt === null) ||
        (item.leaseToken !== null && item.attemptedAt === null) ||
        (item.status === "prepared" &&
          (item.attemptedAt !== null || item.leaseToken !== null))) {
      throw new Error("Outbox attempt/lease 状态无效。");
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

  function validateStoredOutbox(value) {
    return validateOutbox(value);
  }

  function validatePushIssue(issue) {
    if (!isPlainObject(issue) || !hasExactFields(issue, PUSH_ISSUE_FIELDS)) {
      throw new Error("Sync issue 结构无效。");
    }
    if (!isOpaqueString(issue.ownerId) ||
        !isOpaqueString(issue.bindingId) ||
        !isOpaqueString(issue.mutationId) ||
        issue.entityType !== "favorites" ||
        !isOpaqueString(issue.entityId) ||
        issue.scope !== "record" ||
        issue.schemaVersion !== "1" ||
        !ISSUE_KINDS.has(issue.kind) ||
        !isOpaqueString(issue.reason) ||
        !isCanonicalTimestamp(issue.createdAt)) {
      throw new Error("Sync issue metadata 无效。");
    }

    const request = getProtocol().validateMutation(issue.request);
    const result = getProtocol().validateResult(issue.result);
    if (!request || request.status !== "valid" ||
        !result || result.status !== "valid" ||
        result.result.status !== issue.kind ||
        result.result.reason !== issue.reason) {
      throw new Error("Sync issue request/result 无效。");
    }
    issue.request = request.mutation;
    issue.result = result.result;
    if (issue.mutationId !== issue.request.mutationId ||
        issue.entityType !== issue.request.entityType ||
        issue.entityId !== issue.request.entityId ||
        issue.scope !== issue.request.scope ||
        issue.schemaVersion !== issue.request.schemaVersion ||
        issue.result.mutationId !== issue.mutationId ||
        issue.result.entityType !== issue.entityType ||
        issue.result.entityId !== issue.entityId ||
        issue.result.scope !== issue.scope ||
        (issue.kind === "conflict" && issue.result.schemaVersion !== issue.schemaVersion)) {
      throw new Error("Sync issue identity 无效。");
    }
    return issue;
  }

  function createPullIssueId(ownerId, bindingId, cursor) {
    return `pull:${getCanonical().serialize([ownerId, bindingId, cursor])}`;
  }

  function validatePullIssue(issue) {
    if (!isPlainObject(issue) || !hasExactFields(issue, PULL_ISSUE_FIELDS)) {
      throw new Error("Pull sync issue 结构无效。");
    }
    if (!isOpaqueString(issue.ownerId) ||
        !isOpaqueString(issue.bindingId) ||
        !isOpaqueString(issue.issueId) ||
        issue.mutationId !== issue.issueId ||
        issue.direction !== "pull" ||
        issue.kind !== "conflict" ||
        issue.entityType !== "favorites" ||
        !isOpaqueString(issue.entityId) ||
        issue.scope !== "record" ||
        issue.schemaVersion !== "1" ||
        !isOpaqueString(issue.reason) ||
        !isOpaqueString(issue.remoteRevision) ||
        !isOpaqueString(issue.remoteCursor) ||
        !isCanonicalTimestamp(issue.createdAt)) {
      throw new Error("Pull sync issue metadata 无效。");
    }
    if (issue.issueId !== createPullIssueId(
      issue.ownerId,
      issue.bindingId,
      issue.remoteCursor
    )) {
      throw new Error("Pull sync issue identity 无效。");
    }

    issue.localSnapshot = validateFavoriteSnapshot(
      issue.localSnapshot,
      issue.entityId,
      true
    );
    if (issue.sidecarSnapshot !== null) {
      issue.sidecarSnapshot = validateSidecar(issue.sidecarSnapshot);
      if (issue.sidecarSnapshot.ownerId !== issue.ownerId ||
          issue.sidecarSnapshot.bindingId !== issue.bindingId ||
          !isSameFavoriteRecord(issue.sidecarSnapshot, issue)) {
        throw new Error("Pull sync issue sidecar identity 无效。");
      }
    }
    if (!Array.isArray(issue.pendingMutationIds) ||
        issue.pendingMutationIds.some(value => !isOpaqueString(value)) ||
        new Set(issue.pendingMutationIds).size !== issue.pendingMutationIds.length) {
      throw new Error("Pull sync issue pending mutations 无效。");
    }

    const remote = getProtocol().validatePullChange(issue.remoteChange);
    if (!remote || remote.status !== "valid") {
      throw new Error("Pull sync issue remote change 无效。");
    }
    issue.remoteChange = remote.change;
    if (issue.remoteChange.entityType !== issue.entityType ||
        issue.remoteChange.entityId !== issue.entityId ||
        issue.remoteChange.scope !== issue.scope ||
        issue.remoteChange.schemaVersion !== issue.schemaVersion ||
        issue.remoteChange.revision !== issue.remoteRevision ||
        issue.remoteChange.cursor !== issue.remoteCursor) {
      throw new Error("Pull sync issue remote identity 无效。");
    }
    return issue;
  }

  function validateIssue(value) {
    const issue = getCanonical().snapshot(value, "syncIssue");
    return issue?.direction === "pull"
      ? validatePullIssue(issue)
      : validatePushIssue(issue);
  }

  function validatePullProgress(value) {
    const progress = getCanonical().snapshot(value, "pullProgress");
    if (!isPlainObject(progress) || !hasExactFields(progress, PULL_PROGRESS_FIELDS) ||
        !isOpaqueString(progress.ownerId) ||
        !isOpaqueString(progress.bindingId) ||
        progress.key !== controlKey(
          PULL_PROGRESS_PREFIX,
          progress.ownerId,
          progress.bindingId
        ) ||
        (progress.receivedCursor !== null && !isOpaqueString(progress.receivedCursor)) ||
        (progress.appliedCursor !== null && !isOpaqueString(progress.appliedCursor)) ||
        !Number.isSafeInteger(progress.lastInboxSeq) ||
        progress.lastInboxSeq < 0) {
      throw new Error("Pull progress 无效。");
    }
    return progress;
  }

  function validatePullLease(value) {
    const lease = getCanonical().snapshot(value, "pullLease");
    if (!isPlainObject(lease) || !hasExactFields(lease, PULL_LEASE_FIELDS) ||
        !isOpaqueString(lease.ownerId) ||
        !isOpaqueString(lease.bindingId) ||
        lease.key !== controlKey(PULL_LEASE_PREFIX, lease.ownerId, lease.bindingId) ||
        !isOpaqueString(lease.leaseToken) ||
        !isCanonicalTimestamp(lease.leaseExpiresAt) ||
        (lease.startReceivedCursor !== null && !isOpaqueString(lease.startReceivedCursor))) {
      throw new Error("Pull lease 无效。");
    }
    return lease;
  }

  function validatePullAnchor(value) {
    const anchor = getCanonical().snapshot(value, "pullAnchor");
    if (!isPlainObject(anchor) || !hasExactFields(anchor, PULL_ANCHOR_FIELDS) ||
        !isOpaqueString(anchor.ownerId) ||
        !isOpaqueString(anchor.bindingId) ||
        anchor.entityType !== "favorites" ||
        !isOpaqueString(anchor.entityId) ||
        anchor.scope !== "record" ||
        anchor.schemaVersion !== "1" ||
        !isOpaqueString(anchor.revision) ||
        !isOpaqueString(anchor.cursor) ||
        typeof anchor.payloadFingerprint !== "string" ||
        anchor.key !== controlKey(
          PULL_ANCHOR_PREFIX,
          anchor.ownerId,
          anchor.bindingId,
          anchor.entityId
        )) {
      throw new Error("Pull anchor 无效。");
    }
    return anchor;
  }

  function validateApplyIntent(value, item) {
    const intent = getCanonical().snapshot(value, "applyIntent");
    if (!isPlainObject(intent) || !hasExactFields(intent, APPLY_INTENT_FIELDS)) {
      throw new Error("Inbox apply intent 结构无效。");
    }
    intent.localBeforeSnapshot = validateFavoriteSnapshot(
      intent.localBeforeSnapshot,
      item.entityId,
      true
    );
    intent.candidateSnapshot = validateFavoriteSnapshot(
      intent.candidateSnapshot,
      item.entityId
    );
    if (intent.expectedSidecarSnapshot !== null) {
      intent.expectedSidecarSnapshot = validateSidecar(intent.expectedSidecarSnapshot);
      if (intent.expectedSidecarSnapshot.ownerId !== item.ownerId ||
          intent.expectedSidecarSnapshot.bindingId !== item.bindingId ||
          !isSameFavoriteRecord(intent.expectedSidecarSnapshot, item)) {
        throw new Error("Inbox apply intent sidecar identity 无效。");
      }
    }
    const remote = getProtocol().validatePullChange(intent.remoteChangeSnapshot);
    if (!remote || remote.status !== "valid") {
      throw new Error("Inbox apply intent remote change 无效。");
    }
    intent.remoteChangeSnapshot = remote.change;
    if (!getCanonical().valuesEqual(intent.remoteChangeSnapshot, item.change) ||
        !getCanonical().valuesEqual(intent.candidateSnapshot, item.change.payload) ||
        intent.candidateFingerprint !== getCanonical().fingerprint(intent.candidateSnapshot)) {
      throw new Error("Inbox apply intent snapshot 不一致。");
    }
    return intent;
  }

  function validateInbox(value) {
    const item = getCanonical().snapshot(value, "inbox");
    if (!isPlainObject(item) || !hasExactFields(item, INBOX_FIELDS) ||
        !isOpaqueString(item.ownerId) ||
        !isOpaqueString(item.bindingId) ||
        !Number.isSafeInteger(item.inboxSeq) ||
        item.inboxSeq <= 0 ||
        !INBOX_STATUSES.has(item.status)) {
      throw new Error("Inbox item metadata 无效。");
    }
    const validation = getProtocol().validatePullChange(item.change);
    if (!validation || validation.status !== "valid") {
      throw new Error("Inbox change 无效。");
    }
    item.change = validation.change;
    for (const field of [
      "cursor",
      "entityType",
      "entityId",
      "scope",
      "schemaVersion",
      "revision",
      "operation"
    ]) {
      if (item[field] !== item.change[field]) {
        throw new Error("Inbox outer/change identity 不一致。");
      }
    }
    if (item.status === "received") {
      if (item.applyIntent !== null) throw new Error("Received Inbox 不能携带 apply intent。");
    } else {
      item.applyIntent = validateApplyIntent(item.applyIntent, item);
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

      request.onupgradeneeded = event => {
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

        if (event.oldVersion < 2) {
          const cursorRequest = outbox.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const item = cursor.value;
            const runtimeFieldCount = OUTBOX_RUNTIME_FIELDS.filter(field => (
              Object.prototype.hasOwnProperty.call(item, field)
            )).length;
            if (runtimeFieldCount === 0) {
              cursor.update({
                ...item,
                attemptedAt: null,
                attemptCount: 0,
                leaseToken: null,
                leaseExpiresAt: null,
                dependsOnMutationId: null
              });
            }
            cursor.continue();
          };
        }

        const issues = db.objectStoreNames.contains(ISSUES_STORE)
          ? request.transaction.objectStore(ISSUES_STORE)
          : db.createObjectStore(ISSUES_STORE, {
              keyPath: ["ownerId", "mutationId"]
            });
        if (!issues.indexNames.contains("byOwnerRecord")) {
          issues.createIndex(
            "byOwnerRecord",
            ["ownerId", "entityType", "entityId", "scope"],
            { unique: false }
          );
        }
        if (!issues.indexNames.contains("byOwnerKindCreatedAt")) {
          issues.createIndex(
            "byOwnerKindCreatedAt",
            ["ownerId", "kind", "createdAt"],
            { unique: false }
          );
        }

        const inbox = db.objectStoreNames.contains(INBOX_STORE)
          ? request.transaction.objectStore(INBOX_STORE)
          : db.createObjectStore(INBOX_STORE, {
              keyPath: ["ownerId", "bindingId", "inboxSeq"]
            });
        if (!inbox.indexNames.contains("byOwnerBindingCursor")) {
          inbox.createIndex(
            "byOwnerBindingCursor",
            ["ownerId", "bindingId", "cursor"],
            { unique: true }
          );
        }
        if (!inbox.indexNames.contains("byOwnerRecordSequence")) {
          inbox.createIndex(
            "byOwnerRecordSequence",
            ["ownerId", "bindingId", "entityType", "entityId", "scope", "inboxSeq"],
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

  function createInitialPullProgress(owner) {
    return {
      key: controlKey(PULL_PROGRESS_PREFIX, owner.ownerId, owner.bindingId),
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      receivedCursor: null,
      appliedCursor: null,
      lastInboxSeq: 0
    };
  }

  async function readPullProgress(store, owner) {
    const value = await requestResult(store.get(
      controlKey(PULL_PROGRESS_PREFIX, owner.ownerId, owner.bindingId)
    ));
    return value === undefined ? null : validatePullProgress(value);
  }

  async function getPullProgress(context) {
    try {
      const owner = validateBindingInput(context);
      return await runTransaction([CONTROL_STORE], "readonly", async tx => {
        const store = tx.objectStore(CONTROL_STORE);
        const binding = await requireBinding(store, owner.ownerId, owner.bindingId);
        if (binding.status !== "ready") return binding;
        const progress = await readPullProgress(store, owner);
        return progress === null
          ? { status: "missing", progress: null }
          : { status: "ready", progress };
      });
    } catch (error) {
      return failed("pull-progress-read-failed", error);
    }
  }

  function createPullLeaseToken() {
    const token = window.crypto?.randomUUID
      ? `favorite-pull:${window.crypto.randomUUID()}`
      : null;
    if (!token) throw new Error("无法生成 Favorite pull lease token。");
    return token;
  }

  async function acquirePullLease(context, options = {}) {
    try {
      const owner = validateBindingInput(context);
      if (!isPlainObject(options)) throw new Error("Pull lease options 无效。");
      const leaseMs = Number.isInteger(options.leaseMs) && options.leaseMs > 0
        ? options.leaseMs
        : 30000;
      const now = Date.now();
      return await runTransaction([CONTROL_STORE], "readwrite", async tx => {
        const store = tx.objectStore(CONTROL_STORE);
        const binding = await requireBinding(store, owner.ownerId, owner.bindingId);
        if (binding.status !== "ready") return binding;
        const key = controlKey(PULL_LEASE_PREFIX, owner.ownerId, owner.bindingId);
        const stored = await requestResult(store.get(key));
        if (stored !== undefined) {
          const current = validatePullLease(stored);
          if (Date.parse(current.leaseExpiresAt) > now) {
            return {
              status: "busy",
              reason: "pull-lease-active",
              leaseExpiresAt: current.leaseExpiresAt
            };
          }
        }
        const progress = await readPullProgress(store, owner);
        const lease = validatePullLease({
          key,
          ownerId: owner.ownerId,
          bindingId: owner.bindingId,
          leaseToken: createPullLeaseToken(),
          leaseExpiresAt: new Date(now + leaseMs).toISOString(),
          startReceivedCursor: progress?.receivedCursor ?? null
        });
        await requestResult(store.put(lease));
        return { status: "leased", lease, progress };
      });
    } catch (error) {
      return failed("pull-lease-acquire-failed", error);
    }
  }

  async function releasePullLease(context) {
    try {
      const value = getCanonical().snapshot(context, "context");
      if (!isPlainObject(value) ||
          !isOpaqueString(value.ownerId) ||
          !isOpaqueString(value.bindingId) ||
          !isOpaqueString(value.leaseToken)) {
        throw new Error("Pull lease release context 无效。");
      }
      return await runTransaction([CONTROL_STORE], "readwrite", async tx => {
        const store = tx.objectStore(CONTROL_STORE);
        const key = controlKey(PULL_LEASE_PREFIX, value.ownerId, value.bindingId);
        const stored = await requestResult(store.get(key));
        if (stored === undefined) return { status: "missing" };
        const lease = validatePullLease(stored);
        if (lease.leaseToken !== value.leaseToken) {
          return blocked("stale-pull-lease");
        }
        await requestResult(store.delete(key));
        return { status: "released" };
      });
    } catch (error) {
      return failed("pull-lease-release-failed", error);
    }
  }

  function createInboxItem(owner, inboxSeq, change) {
    return validateInbox({
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      inboxSeq,
      status: "received",
      cursor: change.cursor,
      entityType: change.entityType,
      entityId: change.entityId,
      scope: change.scope,
      schemaVersion: change.schemaVersion,
      revision: change.revision,
      operation: change.operation,
      change,
      applyIntent: null
    });
  }

  async function receivePullResult(context) {
    try {
      const value = getCanonical().snapshot(context, "context");
      if (!isPlainObject(value) ||
          !hasExactFields(value, new Set([
            "ownerId",
            "bindingId",
            "leaseToken",
            "startReceivedCursor",
            "pullResult"
          ])) ||
          !isOpaqueString(value.ownerId) ||
          !isOpaqueString(value.bindingId) ||
          !isOpaqueString(value.leaseToken) ||
          (value.startReceivedCursor !== null && !isOpaqueString(value.startReceivedCursor))) {
        throw new Error("Pull receive context 无效。");
      }
      const validation = getProtocol().validatePullResult(value.pullResult);
      if (!validation || validation.status !== "valid" ||
          validation.pullResult.status !== "ready") {
        throw new Error("Pull receive result 无效。");
      }
      const pullResult = validation.pullResult;
      const owner = { ownerId: value.ownerId, bindingId: value.bindingId };
      return await runTransaction([CONTROL_STORE, INBOX_STORE], "readwrite", async tx => {
        const control = tx.objectStore(CONTROL_STORE);
        const binding = await requireBinding(control, owner.ownerId, owner.bindingId);
        if (binding.status !== "ready") return binding;

        const leaseKey = controlKey(PULL_LEASE_PREFIX, owner.ownerId, owner.bindingId);
        const storedLease = await requestResult(control.get(leaseKey));
        if (storedLease === undefined) return blocked("stale-pull-lease");
        const lease = validatePullLease(storedLease);
        if (lease.leaseToken !== value.leaseToken ||
            lease.startReceivedCursor !== value.startReceivedCursor ||
            Date.parse(lease.leaseExpiresAt) <= Date.now()) {
          return blocked("stale-pull-lease");
        }

        const storedProgress = await readPullProgress(control, owner);
        const progress = storedProgress || createInitialPullProgress(owner);
        if (progress.receivedCursor !== value.startReceivedCursor) {
          return blocked("pull-received-cursor-changed");
        }

        const inbox = tx.objectStore(INBOX_STORE);
        const pendingWrites = [];
        const duplicates = [];
        let nextSeq = progress.lastInboxSeq;
        for (const change of pullResult.changes) {
          const stored = await requestResult(inbox.index("byOwnerBindingCursor").get([
            owner.ownerId,
            owner.bindingId,
            change.cursor
          ]));
          if (stored !== undefined) {
            const existing = validateInbox(stored);
            if (!getCanonical().valuesEqual(existing.change, change)) {
              return failed("pull-change-cursor-conflict");
            }
            duplicates.push(change.cursor);
            continue;
          }
          nextSeq += 1;
          pendingWrites.push(createInboxItem(owner, nextSeq, change));
        }

        for (const item of pendingWrites) await requestResult(inbox.add(item));
        const nextProgress = validatePullProgress({
          ...progress,
          receivedCursor: pullResult.nextCursor,
          lastInboxSeq: nextSeq
        });
        await requestResult(control.put(nextProgress));
        await requestResult(control.delete(leaseKey));
        return {
          status: "received",
          received: pendingWrites.length,
          duplicates,
          progress: nextProgress,
          items: pendingWrites
        };
      });
    } catch (error) {
      return failed("pull-receive-failed", error);
    }
  }

  function validateInboxQuery(query) {
    const value = getCanonical().snapshot(query, "query");
    if (!isPlainObject(value) ||
        !isOpaqueString(value.ownerId) ||
        !isOpaqueString(value.bindingId)) {
      throw new Error("Inbox query identity 无效。");
    }
    if (Object.prototype.hasOwnProperty.call(value, "status") &&
        !INBOX_STATUSES.has(value.status)) {
      throw new Error("Inbox query status 无效。");
    }
    if (Object.prototype.hasOwnProperty.call(value, "entityId") &&
        !isOpaqueString(value.entityId)) {
      throw new Error("Inbox query entityId 无效。");
    }
    return value;
  }

  async function listInbox(query = {}) {
    try {
      const value = validateInboxQuery(query);
      return await runTransaction([CONTROL_STORE, INBOX_STORE], "readonly", async tx => {
        const binding = await requireBinding(
          tx.objectStore(CONTROL_STORE),
          value.ownerId,
          value.bindingId
        );
        if (binding.status !== "ready") return binding;
        const values = await requestResult(tx.objectStore(INBOX_STORE).getAll());
        const items = values.map(validateInbox)
          .filter(item => item.ownerId === value.ownerId && item.bindingId === value.bindingId)
          .filter(item => !value.status || item.status === value.status)
          .filter(item => !value.entityId || item.entityId === value.entityId)
          .sort((left, right) => left.inboxSeq - right.inboxSeq);
        const applying = items.filter(item => item.status === "applying");
        if (applying.length > 1 ||
            (applying.length === 1 && items[0]?.inboxSeq !== applying[0].inboxSeq)) {
          throw new Error("Inbox applying sequence 无效。");
        }
        return { status: "ready", items };
      });
    } catch (error) {
      return failed("inbox-list-failed", error);
    }
  }

  async function getNextInbox(context) {
    const listed = await listInbox(context);
    if (listed.status !== "ready") return listed;
    return listed.items.length
      ? { status: "ready", item: listed.items[0] }
      : { status: "idle", item: null };
  }

  async function getPullAnchor(context) {
    try {
      const value = getCanonical().snapshot(context, "context");
      if (!isPlainObject(value) ||
          !isOpaqueString(value.ownerId) ||
          !isOpaqueString(value.bindingId) ||
          !isOpaqueString(value.entityId)) {
        throw new Error("Pull anchor identity 无效。");
      }
      return await runTransaction([CONTROL_STORE], "readonly", async tx => {
        const store = tx.objectStore(CONTROL_STORE);
        const binding = await requireBinding(store, value.ownerId, value.bindingId);
        if (binding.status !== "ready") return binding;
        const stored = await requestResult(store.get(controlKey(
          PULL_ANCHOR_PREFIX,
          value.ownerId,
          value.bindingId,
          value.entityId
        )));
        return stored === undefined
          ? { status: "missing", anchor: null }
          : { status: "ready", anchor: validatePullAnchor(stored) };
      });
    } catch (error) {
      return failed("pull-anchor-read-failed", error);
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

  async function readRecordSidecar(store, owner, entityId) {
    const stored = await requestResult(store.get([
      owner.ownerId,
      "favorites",
      entityId,
      "record"
    ]));
    if (stored === undefined) return null;
    const sidecar = validateSidecar(stored);
    const mismatch = getWorkspaceMismatch(
      sidecar,
      owner.ownerId,
      owner.bindingId
    );
    if (mismatch) return mismatch;
    return sidecar;
  }

  async function readRecordOutbox(store, owner, entityId) {
    const values = await requestResult(store.index("byOwnerRecord").getAll([
      owner.ownerId,
      "favorites",
      entityId,
      "record"
    ]));
    const items = values.map(validateStoredOutbox);
    if (items.some(item => item.bindingId !== owner.bindingId)) {
      return blocked("workspace-binding-mismatch");
    }
    return items.sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt) ||
      left.mutationId.localeCompare(right.mutationId)
    ));
  }

  async function readRecordIssues(store, owner, entityId) {
    const values = await requestResult(store.index("byOwnerRecord").getAll([
      owner.ownerId,
      "favorites",
      entityId,
      "record"
    ]));
    const issues = values.map(validateIssue);
    if (issues.some(issue => issue.bindingId !== owner.bindingId)) {
      return blocked("workspace-binding-mismatch");
    }
    return issues;
  }

  async function requireInboxHead(store, owner, inboxSeq) {
    const values = (await requestResult(store.getAll()))
      .map(validateInbox)
      .filter(item => item.ownerId === owner.ownerId && item.bindingId === owner.bindingId)
      .sort((left, right) => left.inboxSeq - right.inboxSeq);
    if (!values.length) return { status: "missing", item: null };
    if (values[0].inboxSeq !== inboxSeq) {
      return blocked("inbox-sequence-not-next", { nextInboxSeq: values[0].inboxSeq });
    }
    return { status: "ready", item: values[0] };
  }

  async function advanceAppliedCursor(control, inbox, owner, item) {
    const progress = await readPullProgress(control, owner);
    if (!progress || progress.receivedCursor === null || item.inboxSeq > progress.lastInboxSeq) {
      throw new Error("Pull progress 与 Inbox 不一致。");
    }
    const remaining = (await requestResult(inbox.getAll()))
      .map(validateInbox)
      .filter(current => (
        current.ownerId === owner.ownerId && current.bindingId === owner.bindingId
      ))
      .sort((left, right) => left.inboxSeq - right.inboxSeq);
    const nextProgress = validatePullProgress({
      ...progress,
      appliedCursor: remaining.length ? item.cursor : progress.receivedCursor
    });
    await requestResult(control.put(nextProgress));
    return nextProgress;
  }

  function createPullAnchor(owner, change) {
    return validatePullAnchor({
      key: controlKey(
        PULL_ANCHOR_PREFIX,
        owner.ownerId,
        owner.bindingId,
        change.entityId
      ),
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      entityType: change.entityType,
      entityId: change.entityId,
      scope: change.scope,
      schemaVersion: change.schemaVersion,
      revision: change.revision,
      payloadFingerprint: getCanonical().fingerprint(change.payload),
      cursor: change.cursor
    });
  }

  function validateApplyContext(context, fields) {
    const value = getCanonical().snapshot(context, "context");
    if (!isPlainObject(value) || !hasExactFields(value, fields) ||
        !isOpaqueString(value.ownerId) ||
        !isOpaqueString(value.bindingId) ||
        !Number.isSafeInteger(value.inboxSeq) || value.inboxSeq <= 0 ||
        !isOpaqueString(value.leaseToken)) {
      throw new Error("Inbox apply context 无效。");
    }
    return value;
  }

  async function settleInboxNoop(context) {
    try {
      const value = validateApplyContext(context, new Set([
        "ownerId",
        "bindingId",
        "inboxSeq",
        "leaseToken",
        "mode",
        "anchorInboxSeq"
      ]));
      if (!new Set(["own-echo", "historical"]).has(value.mode) ||
          (value.mode === "own-echo" && value.anchorInboxSeq !== null) ||
          (value.mode === "historical" &&
            (!Number.isSafeInteger(value.anchorInboxSeq) ||
              value.anchorInboxSeq <= value.inboxSeq))) {
        throw new Error("Inbox no-op mode 无效。");
      }
      const owner = { ownerId: value.ownerId, bindingId: value.bindingId };
      return await runTransaction(
        [CONTROL_STORE, SIDECAR_STORE, INBOX_STORE],
        "readwrite",
        async tx => {
          const control = tx.objectStore(CONTROL_STORE);
          const binding = await requireBinding(control, owner.ownerId, owner.bindingId);
          if (binding.status !== "ready") return binding;
          const writer = await requireWriterLease(
            control,
            owner.ownerId,
            owner.bindingId,
            value.leaseToken
          );
          if (writer.status !== "ready") return writer;
          const inbox = tx.objectStore(INBOX_STORE);
          const head = await requireInboxHead(inbox, owner, value.inboxSeq);
          if (head.status !== "ready") return head;
          const item = head.item;
          if (item.status !== "received") return blocked("inbox-item-not-received");
          const sidecar = await readRecordSidecar(
            tx.objectStore(SIDECAR_STORE),
            owner,
            item.entityId
          );
          if (sidecar?.status === "blocked") return sidecar;
          if (!sidecar) return blocked("pull-anchor-sidecar-missing");

          if (value.mode === "own-echo") {
            if (sidecar.serverRevision !== item.revision ||
                !getCanonical().valuesEqual(
                  sidecar.lastSyncedSnapshot,
                  item.change.payload
                )) {
              return blocked("own-echo-state-changed");
            }
            await requestResult(control.put(createPullAnchor(owner, item.change)));
          } else {
            const storedAnchor = await requestResult(inbox.get([
              owner.ownerId,
              owner.bindingId,
              value.anchorInboxSeq
            ]));
            if (storedAnchor === undefined) return blocked("historical-anchor-missing");
            const anchor = validateInbox(storedAnchor);
            if (!isSameFavoriteRecord(anchor, item) ||
                anchor.revision !== sidecar.serverRevision ||
                !getCanonical().valuesEqual(
                  anchor.change.payload,
                  sidecar.lastSyncedSnapshot
                )) {
              return blocked("historical-anchor-changed");
            }
          }

          await requestResult(inbox.delete([owner.ownerId, owner.bindingId, item.inboxSeq]));
          const progress = await advanceAppliedCursor(control, inbox, owner, item);
          return {
            status: "settled",
            resultStatus: value.mode,
            item,
            progress
          };
        }
      );
    } catch (error) {
      return failed("inbox-noop-settlement-failed", error);
    }
  }

  async function prepareInboxApply(context) {
    try {
      const value = validateApplyContext(context, new Set([
        "ownerId",
        "bindingId",
        "inboxSeq",
        "leaseToken",
        "localBeforeSnapshot",
        "candidateSnapshot",
        "expectedSidecarSnapshot"
      ]));
      const owner = { ownerId: value.ownerId, bindingId: value.bindingId };
      value.localBeforeSnapshot = validateFavoriteSnapshot(
        value.localBeforeSnapshot,
        null,
        true
      );
      value.candidateSnapshot = validateFavoriteSnapshot(
        value.candidateSnapshot,
        null
      );
      if (value.expectedSidecarSnapshot !== null) {
        value.expectedSidecarSnapshot = validateSidecar(value.expectedSidecarSnapshot);
      }
      return await runTransaction(
        [CONTROL_STORE, SIDECAR_STORE, OUTBOX_STORE, ISSUES_STORE, INBOX_STORE],
        "readwrite",
        async tx => {
          const control = tx.objectStore(CONTROL_STORE);
          const binding = await requireBinding(control, owner.ownerId, owner.bindingId);
          if (binding.status !== "ready") return binding;
          const writer = await requireWriterLease(
            control,
            owner.ownerId,
            owner.bindingId,
            value.leaseToken
          );
          if (writer.status !== "ready") return writer;
          const inbox = tx.objectStore(INBOX_STORE);
          const head = await requireInboxHead(inbox, owner, value.inboxSeq);
          if (head.status !== "ready") return head;
          const item = head.item;
          if (item.status !== "received") return blocked("inbox-item-not-received");
          if (value.candidateSnapshot.id !== item.entityId ||
              (value.localBeforeSnapshot !== null &&
                value.localBeforeSnapshot.id !== item.entityId) ||
              !getCanonical().valuesEqual(value.candidateSnapshot, item.change.payload)) {
            return blocked("inbox-apply-candidate-changed");
          }

          const sidecar = await readRecordSidecar(
            tx.objectStore(SIDECAR_STORE),
            owner,
            item.entityId
          );
          if (sidecar?.status === "blocked") return sidecar;
          if (!getCanonical().valuesEqual(sidecar, value.expectedSidecarSnapshot)) {
            return blocked("sidecar-state-changed");
          }
          const pending = await readRecordOutbox(
            tx.objectStore(OUTBOX_STORE),
            owner,
            item.entityId
          );
          if (pending?.status === "blocked") return pending;
          if (pending.length) return blocked("outbox-state-changed");
          const issues = await readRecordIssues(
            tx.objectStore(ISSUES_STORE),
            owner,
            item.entityId
          );
          if (issues?.status === "blocked") return issues;
          if (issues.length) return blocked("sync-issue-state-changed");

          item.status = "applying";
          item.applyIntent = validateApplyIntent({
            localBeforeSnapshot: value.localBeforeSnapshot,
            candidateSnapshot: value.candidateSnapshot,
            expectedSidecarSnapshot: value.expectedSidecarSnapshot,
            remoteChangeSnapshot: item.change,
            candidateFingerprint: getCanonical().fingerprint(value.candidateSnapshot)
          }, item);
          const applying = validateInbox(item);
          await requestResult(inbox.put(applying));
          return { status: "applying", item: applying };
        }
      );
    } catch (error) {
      return failed("inbox-apply-prepare-failed", error);
    }
  }

  async function finalizeInboxApply(context) {
    try {
      const value = validateApplyContext(context, new Set([
        "ownerId",
        "bindingId",
        "inboxSeq",
        "leaseToken"
      ]));
      const owner = { ownerId: value.ownerId, bindingId: value.bindingId };
      return await runTransaction(
        [CONTROL_STORE, SIDECAR_STORE, OUTBOX_STORE, ISSUES_STORE, INBOX_STORE],
        "readwrite",
        async tx => {
          const control = tx.objectStore(CONTROL_STORE);
          const binding = await requireBinding(control, owner.ownerId, owner.bindingId);
          if (binding.status !== "ready") return binding;
          const writer = await requireWriterLease(
            control,
            owner.ownerId,
            owner.bindingId,
            value.leaseToken
          );
          if (writer.status !== "ready") return writer;
          const inbox = tx.objectStore(INBOX_STORE);
          const head = await requireInboxHead(inbox, owner, value.inboxSeq);
          if (head.status !== "ready") return head;
          const item = head.item;
          if (item.status !== "applying") return blocked("inbox-item-not-applying");
          const sidecars = tx.objectStore(SIDECAR_STORE);
          const currentSidecar = await readRecordSidecar(sidecars, owner, item.entityId);
          if (currentSidecar?.status === "blocked") return currentSidecar;
          if (!getCanonical().valuesEqual(
            currentSidecar,
            item.applyIntent.expectedSidecarSnapshot
          )) {
            return blocked("sidecar-state-changed");
          }
          const pending = await readRecordOutbox(
            tx.objectStore(OUTBOX_STORE),
            owner,
            item.entityId
          );
          if (pending?.status === "blocked") return pending;
          if (pending.length) return blocked("outbox-state-changed");
          const issues = await readRecordIssues(
            tx.objectStore(ISSUES_STORE),
            owner,
            item.entityId
          );
          if (issues?.status === "blocked") return issues;
          if (issues.length) return blocked("sync-issue-state-changed");

          const sidecar = validateSidecar({
            ownerId: owner.ownerId,
            bindingId: owner.bindingId,
            entityType: item.entityType,
            entityId: item.entityId,
            scope: item.scope,
            schemaVersion: item.schemaVersion,
            serverRevision: item.revision,
            lastSyncedSnapshot: item.applyIntent.candidateSnapshot,
            lastSyncedFingerprint: getCanonical().fingerprint(
              item.applyIntent.candidateSnapshot
            )
          });
          await requestResult(sidecars.put(sidecar));
          await requestResult(control.put(createPullAnchor(owner, item.change)));
          await requestResult(inbox.delete([owner.ownerId, owner.bindingId, item.inboxSeq]));
          const progress = await advanceAppliedCursor(control, inbox, owner, item);
          return { status: "settled", resultStatus: "applied", sidecar, item, progress };
        }
      );
    } catch (error) {
      return failed("inbox-apply-finalize-failed", error);
    }
  }

  async function settleInboxIssue(context) {
    try {
      const value = validateApplyContext(context, new Set([
        "ownerId",
        "bindingId",
        "inboxSeq",
        "leaseToken",
        "reason",
        "localSnapshot"
      ]));
      if (!isOpaqueString(value.reason)) throw new Error("Pull issue reason 无效。");
      const owner = { ownerId: value.ownerId, bindingId: value.bindingId };
      return await runTransaction(
        [CONTROL_STORE, SIDECAR_STORE, OUTBOX_STORE, ISSUES_STORE, INBOX_STORE],
        "readwrite",
        async tx => {
          const control = tx.objectStore(CONTROL_STORE);
          const binding = await requireBinding(control, owner.ownerId, owner.bindingId);
          if (binding.status !== "ready") return binding;
          const writer = await requireWriterLease(
            control,
            owner.ownerId,
            owner.bindingId,
            value.leaseToken
          );
          if (writer.status !== "ready") return writer;
          const inbox = tx.objectStore(INBOX_STORE);
          const head = await requireInboxHead(inbox, owner, value.inboxSeq);
          if (head.status !== "ready") return head;
          const item = head.item;
          value.localSnapshot = validateFavoriteSnapshot(
            value.localSnapshot,
            item.entityId,
            true
          );
          const sidecar = await readRecordSidecar(
            tx.objectStore(SIDECAR_STORE),
            owner,
            item.entityId
          );
          if (sidecar?.status === "blocked") return sidecar;
          const pending = await readRecordOutbox(
            tx.objectStore(OUTBOX_STORE),
            owner,
            item.entityId
          );
          if (pending?.status === "blocked") return pending;
          const issueId = createPullIssueId(owner.ownerId, owner.bindingId, item.cursor);
          const issue = validateIssue({
            ownerId: owner.ownerId,
            bindingId: owner.bindingId,
            mutationId: issueId,
            issueId,
            direction: "pull",
            entityType: item.entityType,
            entityId: item.entityId,
            scope: item.scope,
            schemaVersion: item.schemaVersion,
            kind: "conflict",
            reason: value.reason,
            localSnapshot: value.localSnapshot,
            sidecarSnapshot: sidecar,
            pendingMutationIds: pending.map(current => current.mutationId),
            remoteChange: item.change,
            remoteRevision: item.revision,
            remoteCursor: item.cursor,
            createdAt: new Date().toISOString()
          });
          await requestResult(tx.objectStore(ISSUES_STORE).add(issue));
          await requestResult(inbox.delete([owner.ownerId, owner.bindingId, item.inboxSeq]));
          const progress = await advanceAppliedCursor(control, inbox, owner, item);
          return { status: "settled", resultStatus: "conflict", issue, item, progress };
        }
      );
    } catch (error) {
      return failed("inbox-issue-settlement-failed", error);
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
      const replaceUnattemptedReady = Boolean(
        options.replaceUnattemptedReady || options.replaceReady
      );

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
          const pending = pendingValues.map(validateStoredOutbox)
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
          const attemptedHeads = pending.filter(current => (
            current.status === "ready" && current.attemptedAt !== null
          ));
          if (attemptedHeads.length > 1) {
            return blocked("multiple-attempted-mutations");
          }
          const attemptedHead = attemptedHeads[0] || null;
          if (attemptedHead && item.dependsOnMutationId !== attemptedHead.mutationId) {
            return blocked("successor-dependency-mismatch");
          }
          if (!attemptedHead && item.dependsOnMutationId !== null) {
            return blocked("successor-dependency-missing");
          }

          const unattemptedReady = pending.filter(current => (
            current.status === "ready" && current.attemptedAt === null
          ));
          if (unattemptedReady.length && !replaceUnattemptedReady) {
            return blocked("ready-mutation-exists");
          }

          const replacedMutationIds = [];
          if (replaceUnattemptedReady) {
            for (const current of unattemptedReady) {
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

  async function cancelUnattemptedOutbox(context) {
    try {
      const value = getCanonical().snapshot(context, "context");
      if (!isPlainObject(value) ||
          !isOpaqueString(value.ownerId) ||
          !isOpaqueString(value.bindingId) ||
          !isOpaqueString(value.entityId) ||
          !isOpaqueString(value.leaseToken)) {
        throw new Error("cancelUnattemptedOutbox context 无效。");
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
        const records = (await requestResult(store.getAll()))
          .map(validateStoredOutbox)
          .filter(item => isSameFavoriteRecord(item, {
            entityType: "favorites",
            entityId: value.entityId,
            scope: "record"
          }));
        if (records.some(item => item.ownerId !== value.ownerId)) {
          return blocked("workspace-owner-mismatch");
        }
        if (records.some(item => item.bindingId !== value.bindingId)) {
          return blocked("workspace-binding-mismatch");
        }
        if (records.some(item => item.status === "prepared")) {
          return blocked("prepared-mutation-exists");
        }

        const removedMutationIds = [];
        for (const item of records) {
          if (item.attemptedAt !== null) continue;
          await requestResult(store.delete([item.ownerId, item.mutationId]));
          removedMutationIds.push(item.mutationId);
        }
        return { status: "cancelled", removedMutationIds };
      });
    } catch (error) {
      return failed("outbox-cancel-failed", error);
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
        const item = validateStoredOutbox(storedValue);
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

  function createPushLeaseToken() {
    const token = window.crypto?.randomUUID
      ? `favorite-push:${window.crypto.randomUUID()}`
      : null;
    if (!token) throw new Error("无法生成 Favorite push lease token。");
    return token;
  }

  async function listRecordIssues(store, item) {
    const values = await requestResult(store.index("byOwnerRecord").getAll([
      item.ownerId,
      item.entityType,
      item.entityId,
      item.scope
    ]));
    return values.map(validateIssue).filter(issue => issue.bindingId === item.bindingId);
  }

  async function acquireNextReadyMutationLease(context, options = {}) {
    try {
      const owner = validateBindingInput(context);
      if (!isPlainObject(options)) throw new Error("Push lease options 无效。");
      const leaseMs = Number.isInteger(options.leaseMs) && options.leaseMs > 0
        ? options.leaseMs
        : 30000;
      const now = Date.now();
      const attemptedAt = new Date(now).toISOString();
      const leaseToken = createPushLeaseToken();
      const leaseExpiresAt = new Date(now + leaseMs).toISOString();

      return await runTransaction(
        [CONTROL_STORE, OUTBOX_STORE, ISSUES_STORE],
        "readwrite",
        async tx => {
          const binding = await requireBinding(
            tx.objectStore(CONTROL_STORE),
            owner.ownerId,
            owner.bindingId
          );
          if (binding.status !== "ready") return binding;

          const store = tx.objectStore(OUTBOX_STORE);
          const range = IDBKeyRange.bound(
            [owner.ownerId, "ready", ""],
            [owner.ownerId, "ready", "\uffff"]
          );
          const values = await requestResult(
            store.index("byOwnerStatusCreatedAt").getAll(range)
          );
          if (!values.length) return { status: "idle", item: null };

          const all = values.map(validateStoredOutbox)
            .sort((left, right) => (
              left.createdAt.localeCompare(right.createdAt) ||
              left.mutationId.localeCompare(right.mutationId)
            ));
          const current = all.filter(item => item.bindingId === owner.bindingId);
          if (!current.length) {
            return blocked("workspace-binding-mismatch", {
              blockedMutationIds: all.map(item => item.mutationId)
            });
          }

          const recordHeads = new Map();
          for (const item of current) {
            if (item.dependsOnMutationId !== null) continue;
            const key = `${item.entityType}\u0000${item.entityId}\u0000${item.scope}`;
            if (recordHeads.has(key)) {
              return blocked("multiple-sendable-heads", {
                entityId: item.entityId
              });
            }
            recordHeads.set(key, item);
          }

          const heads = Array.from(recordHeads.values()).sort((left, right) => (
            left.createdAt.localeCompare(right.createdAt) ||
            left.mutationId.localeCompare(right.mutationId)
          ));
          const blockedItems = [];
          for (const item of heads) {
            const issues = await listRecordIssues(tx.objectStore(ISSUES_STORE), item);
            if (issues.length) {
              blockedItems.push({ mutationId: item.mutationId, reason: "sync-issue-exists" });
              continue;
            }
            if (item.leaseToken !== null && Date.parse(item.leaseExpiresAt) > now) {
              return {
                status: "busy",
                reason: "push-lease-active",
                mutationId: item.mutationId,
                leaseExpiresAt: item.leaseExpiresAt
              };
            }

            item.attemptedAt = item.attemptedAt || attemptedAt;
            item.attemptCount += 1;
            item.leaseToken = leaseToken;
            item.leaseExpiresAt = leaseExpiresAt;
            const validated = validateOutbox(item);
            await requestResult(store.put(validated));
            return { status: "leased", item: validated };
          }

          if (blockedItems.length) {
            return blocked("no-sendable-ready-mutation", { blocked: blockedItems });
          }
          return blocked("successor-dependency-unresolved", {
            blockedMutationIds: current.map(item => item.mutationId)
          });
        }
      );
    } catch (error) {
      return failed("push-lease-acquire-failed", error);
    }
  }

  async function releaseMutationLease(context) {
    try {
      const value = getCanonical().snapshot(context, "context");
      if (!isPlainObject(value) ||
          !isOpaqueString(value.ownerId) ||
          !isOpaqueString(value.bindingId) ||
          !isOpaqueString(value.mutationId) ||
          !isOpaqueString(value.leaseToken)) {
        throw new Error("releaseMutationLease context 无效。");
      }
      return await runTransaction([CONTROL_STORE, OUTBOX_STORE], "readwrite", async tx => {
        const binding = await requireBinding(
          tx.objectStore(CONTROL_STORE),
          value.ownerId,
          value.bindingId
        );
        if (binding.status !== "ready") return binding;
        const store = tx.objectStore(OUTBOX_STORE);
        const stored = await requestResult(store.get([value.ownerId, value.mutationId]));
        if (stored === undefined) return { status: "missing" };
        const item = validateStoredOutbox(stored);
        if (item.bindingId !== value.bindingId) return blocked("workspace-binding-mismatch");
        if (item.leaseToken !== value.leaseToken) return blocked("stale-push-lease");
        item.leaseToken = null;
        item.leaseExpiresAt = null;
        const validated = validateOutbox(item);
        await requestResult(store.put(validated));
        return { status: "released", item: validated };
      });
    } catch (error) {
      return failed("push-lease-release-failed", error);
    }
  }

  function validateSettlementContext(context, allowedStatuses) {
    const value = getCanonical().snapshot(context, "context");
    if (!isPlainObject(value) ||
        !isOpaqueString(value.ownerId) ||
        !isOpaqueString(value.bindingId) ||
        !isOpaqueString(value.mutationId) ||
        !isOpaqueString(value.leaseToken)) {
      throw new Error("Push settlement context 无效。");
    }
    const request = getProtocol().validateMutation(value.request);
    const result = getProtocol().validateResult(value.result);
    if (request.status !== "valid" || result.status !== "valid" ||
        !allowedStatuses.has(result.result.status)) {
      throw new Error("Push settlement request/result 无效。");
    }
    value.request = request.mutation;
    value.result = result.result;
    if (value.mutationId !== value.request.mutationId ||
        value.result.mutationId !== value.request.mutationId ||
        value.result.entityType !== value.request.entityType ||
        value.result.entityId !== value.request.entityId ||
        value.result.scope !== value.request.scope ||
        (value.result.status !== "rejected" &&
          value.result.schemaVersion !== value.request.schemaVersion)) {
      throw new Error("Push settlement identity 无效。");
    }
    return value;
  }

  async function requireLeasedOutbox(store, value) {
    const stored = await requestResult(store.get([value.ownerId, value.mutationId]));
    if (stored === undefined) return { status: "missing", item: null };
    const item = validateStoredOutbox(stored);
    const mismatch = getWorkspaceMismatch(item, value.ownerId, value.bindingId);
    if (mismatch) return mismatch;
    if (item.status !== "ready" || item.leaseToken !== value.leaseToken) {
      return blocked("stale-push-lease");
    }
    if (!getCanonical().valuesEqual(item.request, value.request)) {
      return blocked("outbox-request-changed");
    }
    return { status: "ready", item };
  }

  async function readExpectedSidecar(store, item) {
    const stored = await requestResult(store.get([
      item.ownerId,
      item.entityType,
      item.entityId,
      item.scope
    ]));
    if (stored === undefined) {
      return item.request.baseRevision === null
        ? { status: "ready", sidecar: null }
        : blocked("sidecar-revision-changed");
    }
    const sidecar = validateSidecar(stored);
    const mismatch = getWorkspaceMismatch(sidecar, item.ownerId, item.bindingId);
    if (mismatch) return mismatch;
    return sidecar.serverRevision === item.request.baseRevision
      ? { status: "ready", sidecar }
      : blocked("sidecar-revision-changed");
  }

  async function settleSuccessfulMutation(context) {
    try {
      const value = validateSettlementContext(
        context,
        new Set(["applied", "unchanged"])
      );
      const successor = value.successor === null
        ? null
        : validateOutbox(value.successor);
      return await runTransaction(
        [CONTROL_STORE, SIDECAR_STORE, OUTBOX_STORE, ISSUES_STORE],
        "readwrite",
        async tx => {
          const binding = await requireBinding(
            tx.objectStore(CONTROL_STORE),
            value.ownerId,
            value.bindingId
          );
          if (binding.status !== "ready") return binding;
          const outbox = tx.objectStore(OUTBOX_STORE);
          const leased = await requireLeasedOutbox(outbox, value);
          if (leased.status !== "ready") return leased;
          const item = leased.item;
          const sidecars = tx.objectStore(SIDECAR_STORE);
          const currentSidecar = await readExpectedSidecar(sidecars, item);
          if (currentSidecar.status !== "ready") return currentSidecar;
          const existingIssues = await listRecordIssues(tx.objectStore(ISSUES_STORE), item);
          if (existingIssues.length) return blocked("sync-issue-exists");

          const recordItems = (await requestResult(outbox.getAll()))
            .map(validateStoredOutbox)
            .filter(current => isSameFavoriteRecord(current, item));
          for (const current of recordItems) {
            const mismatch = getWorkspaceMismatch(
              current,
              item.ownerId,
              item.bindingId
            );
            if (mismatch) return mismatch;
          }
          const followers = recordItems.filter(current => current.mutationId !== item.mutationId);
          if (followers.some(current => (
            current.status !== "ready" ||
            current.attemptedAt !== null ||
            current.dependsOnMutationId !== item.mutationId
          ))) {
            return blocked("successor-state-invalid");
          }
          if (followers.length > 1) return blocked("multiple-successor-mutations");

          if (successor) {
            if (successor.status !== "ready" ||
                successor.ownerId !== item.ownerId ||
                successor.bindingId !== item.bindingId ||
                !isSameFavoriteRecord(successor, item) ||
                successor.mutationId === item.mutationId ||
                successor.attemptedAt !== null ||
                successor.attemptCount !== 0 ||
                successor.leaseToken !== null ||
                successor.dependsOnMutationId !== null ||
                successor.request.baseRevision !== value.result.revision) {
              return blocked("successor-materialization-invalid");
            }
          }

          const sidecar = validateSidecar({
            ownerId: item.ownerId,
            bindingId: item.bindingId,
            entityType: item.entityType,
            entityId: item.entityId,
            scope: item.scope,
            schemaVersion: item.request.schemaVersion,
            serverRevision: value.result.revision,
            lastSyncedSnapshot: item.request.payload,
            lastSyncedFingerprint: getCanonical().fingerprint(item.request.payload)
          });
          await requestResult(sidecars.put(sidecar));
          await requestResult(outbox.delete([item.ownerId, item.mutationId]));
          for (const follower of followers) {
            await requestResult(outbox.delete([follower.ownerId, follower.mutationId]));
          }
          if (successor) await requestResult(outbox.add(successor));
          return {
            status: "settled",
            resultStatus: value.result.status,
            sidecar,
            successor
          };
        }
      );
    } catch (error) {
      return failed("push-success-settlement-failed", error);
    }
  }

  async function settleMutationIssue(context) {
    try {
      const value = validateSettlementContext(
        context,
        new Set(["conflict", "rejected"])
      );
      const issue = validateIssue({
        ownerId: value.ownerId,
        bindingId: value.bindingId,
        mutationId: value.mutationId,
        entityType: value.request.entityType,
        entityId: value.request.entityId,
        scope: value.request.scope,
        schemaVersion: value.request.schemaVersion,
        kind: value.result.status,
        reason: value.result.reason,
        request: value.request,
        result: value.result,
        createdAt: new Date().toISOString()
      });
      return await runTransaction(
        [CONTROL_STORE, OUTBOX_STORE, ISSUES_STORE],
        "readwrite",
        async tx => {
          const binding = await requireBinding(
            tx.objectStore(CONTROL_STORE),
            value.ownerId,
            value.bindingId
          );
          if (binding.status !== "ready") return binding;
          const outbox = tx.objectStore(OUTBOX_STORE);
          const leased = await requireLeasedOutbox(outbox, value);
          if (leased.status !== "ready") return leased;
          await requestResult(tx.objectStore(ISSUES_STORE).add(issue));
          await requestResult(outbox.delete([value.ownerId, value.mutationId]));
          return { status: "settled", resultStatus: issue.kind, issue };
        }
      );
    } catch (error) {
      return failed("push-issue-settlement-failed", error);
    }
  }

  async function getIssue(ownerId, mutationId) {
    try {
      if (!isOpaqueString(ownerId) || !isOpaqueString(mutationId)) {
        throw new Error("Sync issue identity 无效。");
      }
      const value = await runTransaction([ISSUES_STORE], "readonly", tx => (
        requestResult(tx.objectStore(ISSUES_STORE).get([ownerId, mutationId]))
      ));
      if (value === undefined) return { status: "missing", issue: null };
      return { status: "ready", issue: validateIssue(value) };
    } catch (error) {
      return failed("sync-issue-read-failed", error);
    }
  }

  async function listIssues(query = {}) {
    try {
      const value = getCanonical().snapshot(query, "query");
      if (!isPlainObject(value) || !isOpaqueString(value.ownerId)) {
        throw new Error("Sync issue query 缺少 ownerId。");
      }
      if (Object.prototype.hasOwnProperty.call(value, "bindingId") &&
          !isOpaqueString(value.bindingId)) {
        throw new Error("Sync issue query bindingId 无效。");
      }
      if (Object.prototype.hasOwnProperty.call(value, "entityId") &&
          !isOpaqueString(value.entityId)) {
        throw new Error("Sync issue query entityId 无效。");
      }
      const values = await runTransaction([ISSUES_STORE], "readonly", tx => (
        requestResult(tx.objectStore(ISSUES_STORE).getAll())
      ));
      const issues = values.map(validateIssue)
        .filter(issue => issue.ownerId === value.ownerId)
        .filter(issue => !value.bindingId || issue.bindingId === value.bindingId)
        .filter(issue => !value.entityId || issue.entityId === value.entityId)
        .sort((left, right) => (
          left.createdAt.localeCompare(right.createdAt) ||
          left.mutationId.localeCompare(right.mutationId)
        ));
      return { status: "ready", issues };
    } catch (error) {
      return failed("sync-issue-list-failed", error);
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
      return { status: "ready", item: validateStoredOutbox(value) };
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
      const items = values.map(validateStoredOutbox)
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
    getPullProgress,
    acquirePullLease,
    releasePullLease,
    receivePullResult,
    listInbox,
    getNextInbox,
    getPullAnchor,
    settleInboxNoop,
    prepareInboxApply,
    finalizeInboxApply,
    settleInboxIssue,
    getSidecar,
    listSidecars,
    putSidecar,
    prepareOutbox,
    cancelUnattemptedOutbox,
    markOutboxReady,
    removeOutbox,
    acquireNextReadyMutationLease,
    releaseMutationLease,
    settleSuccessfulMutation,
    settleMutationIssue,
    getIssue,
    listIssues,
    getOutbox,
    listOutbox
  });
})();
