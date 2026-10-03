(function() {
  "use strict";

  const DB_NAME = "LingoFlowSyncDB";
  const DB_VERSION = 7;
  const CONTROL_STORE = "control";
  const SIDECAR_STORE = "entitySidecars";
  const OUTBOX_STORE = "outbox";
  const ISSUES_STORE = "syncIssues";
  const INBOX_STORE = "inbox";
  // Article payloads live in a separate lane so runtime work cannot block Favorite sync.
  const ARTICLE_OUTBOX_STORE = "articleOutbox";
  const ARTICLE_SIDECAR_STORE = "articleSidecars";
  const PROGRESS_DESIRED_STORE = "progressDesired";
  const PROGRESS_OBSERVATIONS_STORE = "progressRemoteObservations";
  const PROGRESS_ATTEMPTS_STORE = "progressCloudAttempts";
  const ARTICLE_BOOTSTRAP_STATE_PREFIX = "article-bootstrap-state:";
  const ARTICLE_BOOTSTRAP_INVENTORY_PREFIX = "article-bootstrap-inventory:";
  const ARTICLE_BOOTSTRAP_PENDING_PREFIX = "article-bootstrap-pending:";
  const ARTICLE_BOOTSTRAP_ISSUE_PREFIX = "article-bootstrap-issue:";
  const ARTICLE_RUNTIME_STATE_PREFIX = "article-runtime-state:";
  const ARTICLE_RUNTIME_PENDING_PREFIX = "article-runtime-pending:";
  const ARTICLE_RUNTIME_ISSUE_PREFIX = "article-runtime-issue:";
  const ARTICLE_BOOTSTRAP_PHASES = new Set([
    "remote-inventory",
    "reconciling",
    "settling-outgoing",
    "catching-up",
    "finalizing",
    "blocked",
    "complete"
  ]);
  const BINDING_KEY = "workspace-binding";
  const ACCOUNT_LABEL_KEY = "workspace-account-label";
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
    "set-mastered",
    "drift"
  ]);
  const SYNC_ENTITY_TYPES = new Set(["favorites", "favoriteLearningStates"]);
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

  function getFavoriteLearningSchema() {
    const schema = window.LingoFlowFavoriteLearningBackupSchema;
    if (!schema || typeof schema.validateFavoriteLearningState !== "function") {
      throw new Error("Favorite Learning Schema 不可用。");
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

  function pullAnchorSuffix(entityType, entityId) {
    return entityType === "favorites"
      ? entityId
      : `${entityType}\u0000${entityId}`;
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

  function validateAccountLabelInput(value) {
    const metadata = getCanonical().snapshot(value, "workspace account label");
    if (!isPlainObject(metadata) ||
        !hasExactFields(metadata, new Set(["bindingId", "label", "ownerId"])) ||
        !isOpaqueString(metadata.bindingId) ||
        !isOpaqueString(metadata.ownerId) ||
        !isOpaqueString(metadata.label)) {
      throw new Error("Workspace account label 无效。");
    }
    return metadata;
  }

  function validateStoredAccountLabel(value) {
    const metadata = getCanonical().snapshot(value, "workspace account label");
    if (!isPlainObject(metadata) ||
        !hasExactFields(metadata, new Set(["bindingId", "key", "label", "ownerId"])) ||
        metadata.key !== ACCOUNT_LABEL_KEY ||
        !isOpaqueString(metadata.bindingId) ||
        !isOpaqueString(metadata.ownerId) ||
        !isOpaqueString(metadata.label)) {
      throw new Error("Workspace account label 存储记录无效。");
    }
    return metadata;
  }

  function validateRecordSnapshot(value, entityType, entityId, nullable = false) {
    if (nullable && value === null) return null;
    const snapshot = getCanonical().snapshot(value, "record");
    const validation = entityType === "favorites"
      ? getFavoriteSchema().validateFavorite(snapshot)
      : entityType === "favoriteLearningStates"
        ? getFavoriteLearningSchema().validateFavoriteLearningState(snapshot)
        : null;
    const snapshotId = entityType === "favorites"
      ? validation?.favoriteId
      : validation?.favoriteId;
    if (!validation || validation.status !== "valid" ||
        (entityId !== null && snapshotId !== entityId)) {
      throw new Error("Sync record snapshot 无效。");
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
        !SYNC_ENTITY_TYPES.has(sidecar.entityType) ||
        !isOpaqueString(sidecar.entityId) ||
        sidecar.scope !== "record" ||
        sidecar.schemaVersion !== "1") {
      throw new Error("Favorite sidecar identity 无效。");
    }
    if (sidecar.serverRevision !== null && !isOpaqueString(sidecar.serverRevision)) {
      throw new Error("Favorite sidecar revision 无效。");
    }

    const snapshot = validateRecordSnapshot(
      sidecar.lastSyncedSnapshot,
      sidecar.entityType,
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
        !SYNC_ENTITY_TYPES.has(item.entityType) ||
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

    item.localBeforeSnapshot = validateRecordSnapshot(
      item.localBeforeSnapshot,
      item.entityType,
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
        !SYNC_ENTITY_TYPES.has(issue.entityType) ||
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
        !SYNC_ENTITY_TYPES.has(issue.entityType) ||
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

    issue.localSnapshot = validateRecordSnapshot(
      issue.localSnapshot,
      issue.entityType,
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
        !SYNC_ENTITY_TYPES.has(anchor.entityType) ||
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
          pullAnchorSuffix(anchor.entityType, anchor.entityId)
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
    intent.localBeforeSnapshot = validateRecordSnapshot(
      intent.localBeforeSnapshot,
      item.entityType,
      item.entityId,
      true
    );
    intent.candidateSnapshot = validateRecordSnapshot(
      intent.candidateSnapshot,
      item.entityType,
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

  function runTransaction(storeNames, mode, work, scopeGuard) {
    return openDatabase().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, mode);
      let result;
      let workError = null;

      const checkScope = () => {
        if (!scopeGuard) return;
        let valid = false;
        try { valid = scopeGuard() === true; } catch { /* fail closed */ }
        if (!valid) {
          workError = new Error("Progress settlement scope changed.");
          workError.code = "progress-scope-changed";
          try { tx.abort(); } catch { /* work promise also rejects below */ }
          throw workError;
        }
      };
      // Capture every queued IDB request completion, including writes made by
      // nested helpers. Abort rolls ALL writes back if the runtime trust scope
      // changed while a request was queued. No network/crypto await in this tx.
      if (scopeGuard) tx.addEventListener("success", () => {
        try { checkScope(); } catch { /* abort/error is handled by tx below */ }
      }, true);
      const unsubscribe = scopeGuard?.subscribe?.(() => {
        try { checkScope(); } catch { /* tx.abort rolls back every queued write */ }
      });

      Promise.resolve()
        .then(() => { checkScope(); return work(tx); })
        .then(value => {
          checkScope();
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

      tx.oncomplete = () => { unsubscribe?.(); resolve(result); };
      tx.onerror = () => { unsubscribe?.(); reject(workError || tx.error || new Error("Sync DB transaction failed.")); };
      tx.onabort = () => { unsubscribe?.(); reject(workError || tx.error || new Error("Sync DB transaction aborted.")); };
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
        if (!db.objectStoreNames.contains(ARTICLE_OUTBOX_STORE)) {
          const articleOutbox = db.createObjectStore(ARTICLE_OUTBOX_STORE, {
            keyPath: ["ownerId", "mutationId"]
          });
          articleOutbox.createIndex("byOwnerBinding", ["ownerId", "bindingId"]);
        }
        if (!db.objectStoreNames.contains(ARTICLE_SIDECAR_STORE)) {
          db.createObjectStore(ARTICLE_SIDECAR_STORE, { keyPath: ["ownerId", "articleId"] });
        }
        if (!db.objectStoreNames.contains(PROGRESS_DESIRED_STORE)) {
          db.createObjectStore(PROGRESS_DESIRED_STORE, {
            keyPath: ["ownerId", "bindingId", "articleId"]
          });
        }
        if (!db.objectStoreNames.contains(PROGRESS_OBSERVATIONS_STORE)) {
          db.createObjectStore(PROGRESS_OBSERVATIONS_STORE, {
            keyPath: ["ownerId", "bindingId", "articleId"]
          });
        }
        if (!db.objectStoreNames.contains(PROGRESS_ATTEMPTS_STORE)) {
          const attempts = db.createObjectStore(PROGRESS_ATTEMPTS_STORE, {
            keyPath: ["ownerId", "bindingId", "articleId", "attemptId"]
          });
          attempts.createIndex("byScope", ["ownerId", "bindingId", "articleId"]);
          attempts.createIndex("byOwnerBinding", ["ownerId", "bindingId"]);
          attempts.createIndex("byMutation", ["ownerId", "cloudMutationId"], { unique: true });
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

  async function prepareArticleMutation(value) {
    try {
      const projection = window.LingoFlowArticleSyncProjection
        .sanitizeArticleSyncProjection(value.candidate);
      if (window.LingoFlowArticleSyncSize.validateArticleCloudSyncSize(projection)
          .status !== "valid") return blocked("article-too-large");
      if (!value.ownerId || !value.bindingId || !value.mutationId ||
          !["put", "delete", "restore"].includes(value.operation) ||
          value.articleId !== projection.id ||
          !/^[a-f0-9]{64}$/.test(value.candidateFingerprint) ||
          (value.beforeFingerprint !== null &&
            !/^[a-f0-9]{64}$/.test(value.beforeFingerprint))) {
        throw new Error("Article mutation 无效。");
      }
      return await runTransaction(
        [CONTROL_STORE, ARTICLE_OUTBOX_STORE, ARTICLE_SIDECAR_STORE],
        "readwrite",
        async tx => {
          const binding = await requireBinding(
            tx.objectStore(CONTROL_STORE), value.ownerId, value.bindingId
          );
          if (binding.status !== "ready") return binding;
          const outbox = tx.objectStore(ARTICLE_OUTBOX_STORE);
          const existing = await requestResult(outbox.get([value.ownerId, value.mutationId]));
          if (existing) return { status: "unchanged", mutation: existing };
          const mutation = {
            ownerId: value.ownerId,
            bindingId: value.bindingId,
            mutationId: value.mutationId,
            articleId: value.articleId,
            operation: value.operation,
            status: "prepared",
            createdAt: new Date().toISOString(),
            beforeFingerprint: value.beforeFingerprint,
            candidateFingerprint: value.candidateFingerprint,
            baseRevision: value.baseRevision ?? null,
            candidate: projection,
            captureMode: value.captureMode === "desired" ? "desired" : "head",
            attemptedAt: null,
            attemptCount: 0
          };
          const sidecars = tx.objectStore(ARTICLE_SIDECAR_STORE);
          const sidecar = await requestResult(sidecars.get([value.ownerId, value.articleId]));
          if (!sidecar) {
            await requestResult(sidecars.add({
              ownerId: value.ownerId,
              bindingId: value.bindingId,
              articleId: value.articleId,
              knownRevision: null,
              lastSyncedFingerprint: null,
              lastSyncedLifecycle: null
            }));
          } else if (sidecar.bindingId !== value.bindingId) {
            return blocked("workspace-binding-mismatch");
          }
          await requestResult(outbox.add(mutation));
          return { status: "prepared", mutation };
        }
      );
    } catch (error) {
      return failed("article-prepare-failed", error);
    }
  }

  async function updateArticleMutationStatus(ownerId, bindingId, mutationId, status, reason = null) {
    try {
      if (!["desired", "ready", "issue"].includes(status)) throw new Error("Article status 无效。");
      return await runTransaction([CONTROL_STORE, ARTICLE_OUTBOX_STORE], "readwrite", async tx => {
        const binding = await requireBinding(tx.objectStore(CONTROL_STORE), ownerId, bindingId);
        if (binding.status !== "ready") return binding;
        const store = tx.objectStore(ARTICLE_OUTBOX_STORE);
        const mutation = await requestResult(store.get([ownerId, mutationId]));
        if (!mutation) return { status: "missing" };
        if (mutation.bindingId !== bindingId) return blocked("workspace-binding-mismatch");
        if (mutation.status === status) return { status: "unchanged", mutation };
        if (mutation.status !== "prepared") return blocked("article-status-mismatch");
        const next = { ...mutation, status, ...(status === "issue" ? { issueReason: reason } : {}) };
        await requestResult(store.put(next));
        return { status, mutation: next };
      });
    } catch (error) {
      return failed("article-status-update-failed", error);
    }
  }

  async function listArticleMutations(ownerId, bindingId, status = null) {
    try {
      return await runTransaction([CONTROL_STORE, ARTICLE_OUTBOX_STORE], "readonly", async tx => {
        const binding = await requireBinding(tx.objectStore(CONTROL_STORE), ownerId, bindingId);
        if (binding.status !== "ready") return binding;
        const values = await requestResult(
          tx.objectStore(ARTICLE_OUTBOX_STORE).index("byOwnerBinding")
            .getAll([ownerId, bindingId])
        );
        return {
          status: "ready",
          items: values.filter(item => item.ownerId === ownerId &&
            item.bindingId === bindingId && (!status || item.status === status))
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt) ||
              a.mutationId.localeCompare(b.mutationId))
        };
      });
    } catch (error) {
      return failed("article-outbox-list-failed", error);
    }
  }

  async function getArticleSidecar(ownerId, bindingId, articleId) {
    try {
      return await runTransaction([CONTROL_STORE, ARTICLE_SIDECAR_STORE], "readonly", async tx => {
        const binding = await requireBinding(tx.objectStore(CONTROL_STORE), ownerId, bindingId);
        if (binding.status !== "ready") return binding;
        const sidecar = await requestResult(
          tx.objectStore(ARTICLE_SIDECAR_STORE).get([ownerId, articleId])
        );
        return { status: sidecar ? "ready" : "missing", sidecar: sidecar || null };
      });
    } catch (error) {
      return failed("article-sidecar-read-failed", error);
    }
  }

  async function commitArticleDesired(ownerId, bindingId, mutationId) {
    try {
      return await runTransaction(
        [CONTROL_STORE, ARTICLE_OUTBOX_STORE, ARTICLE_SIDECAR_STORE],
        "readwrite",
        async tx => {
          const binding = await requireBinding(
            tx.objectStore(CONTROL_STORE), ownerId, bindingId
          );
          if (binding.status !== "ready") return binding;
          const outbox = tx.objectStore(ARTICLE_OUTBOX_STORE);
          const mutation = await requestResult(outbox.get([ownerId, mutationId]));
          if (!mutation || mutation.bindingId !== bindingId || mutation.status !== "prepared" ||
              mutation.captureMode !== "desired") {
            return blocked("article-desired-mutation-missing");
          }
          const values = await requestResult(
            outbox.index("byOwnerBinding").getAll([ownerId, bindingId])
          );
          for (const item of values) {
            if (item.articleId === mutation.articleId && item.status === "desired" &&
                item.mutationId !== mutationId) {
              await requestResult(outbox.delete([ownerId, item.mutationId]));
            }
          }
          const sidecar = await requestResult(
            tx.objectStore(ARTICLE_SIDECAR_STORE).get([ownerId, mutation.articleId])
          );
          if (sidecar?.lastSyncedFingerprint === mutation.candidateFingerprint &&
              !values.some(item => item.articleId === mutation.articleId &&
                item.status === "ready")) {
            await requestResult(outbox.delete([ownerId, mutationId]));
            return { status: "unchanged", articleId: mutation.articleId };
          }
          const desired = {
            ...mutation,
            status: "desired",
            desiredAt: new Date().toISOString()
          };
          await requestResult(outbox.put(desired));
          return { status: "desired", mutation: desired };
        }
      );
    } catch (error) {
      return failed("article-desired-commit-failed", error);
    }
  }

  async function promoteNextArticleDesired(ownerId, bindingId) {
    try {
      return await runTransaction(
        [CONTROL_STORE, ARTICLE_OUTBOX_STORE, ARTICLE_SIDECAR_STORE],
        "readwrite",
        async tx => {
          const control = tx.objectStore(CONTROL_STORE);
          const binding = await requireBinding(control, ownerId, bindingId);
          if (binding.status !== "ready") return binding;
          const outbox = tx.objectStore(ARTICLE_OUTBOX_STORE);
          const values = await requestResult(
            outbox.index("byOwnerBinding").getAll([ownerId, bindingId])
          );
          const issueArticleIds = new Set((await requestResult(control.getAll()))
            .filter(item => item?.kind === "article-runtime-issue" &&
              item.ownerId === ownerId && item.bindingId === bindingId)
            .map(item => item.articleId));
          const desired = values.filter(item => item.status === "desired" &&
            !issueArticleIds.has(item.articleId) &&
            !values.some(other => other.articleId === item.articleId &&
              ["prepared", "ready"].includes(other.status)))
            .sort((left, right) => String(left.desiredAt || left.createdAt)
              .localeCompare(String(right.desiredAt || right.createdAt)) ||
              left.mutationId.localeCompare(right.mutationId))[0];
          if (!desired) return { status: "idle" };
          const sidecar = await requestResult(
            tx.objectStore(ARTICLE_SIDECAR_STORE).get([ownerId, desired.articleId])
          );
          if (!sidecar || sidecar.bindingId !== bindingId) {
            return blocked("article-sidecar-missing");
          }
          if (sidecar.lastSyncedFingerprint === desired.candidateFingerprint) {
            await requestResult(outbox.delete([ownerId, desired.mutationId]));
            return { status: "discarded", articleId: desired.articleId };
          }
          const remoteLifecycle = sidecar.knownRevision === null
            ? "missing"
            : sidecar.lastSyncedLifecycle;
          if (!["missing", "active", "deleted"].includes(remoteLifecycle)) {
            return blocked("article-remote-lifecycle-unknown", {
              articleId: desired.articleId,
              sidecar
            });
          }
          const localLifecycle = desired.candidate.deletedAt === null ? "active" : "deleted";
          const operation = localLifecycle === "deleted"
            ? "delete"
            : remoteLifecycle === "deleted" ? "restore" : "put";
          const ready = {
            ...desired,
            status: "ready",
            captureMode: "runtime-head",
            operation,
            baseRevision: sidecar.knownRevision,
            promotedAt: new Date().toISOString()
          };
          await requestResult(outbox.put(ready));
          return { status: "ready", mutation: ready };
        }
      );
    } catch (error) {
      return failed("article-desired-promotion-failed", error);
    }
  }

  async function markArticleMutationAttempt(ownerId, bindingId, mutationId) {
    try {
      return await runTransaction([CONTROL_STORE, ARTICLE_OUTBOX_STORE], "readwrite", async tx => {
        const binding = await requireBinding(tx.objectStore(CONTROL_STORE), ownerId, bindingId);
        if (binding.status !== "ready") return binding;
        const store = tx.objectStore(ARTICLE_OUTBOX_STORE);
        const mutation = await requestResult(store.get([ownerId, mutationId]));
        if (!mutation || mutation.bindingId !== bindingId || mutation.status !== "ready") {
          return blocked("article-ready-mutation-missing");
        }
        const next = {
          ...mutation,
          attemptedAt: new Date().toISOString(),
          attemptCount: Number.isSafeInteger(mutation.attemptCount)
            ? mutation.attemptCount + 1
            : 1
        };
        await requestResult(store.put(next));
        return { status: "ready", mutation: next };
      });
    } catch (error) {
      return failed("article-attempt-mark-failed", error);
    }
  }

  function mergeArticleServerReadingContext(sidecar, incoming) {
    if (incoming === undefined || incoming === null) return sidecar;
    const causal = progressCausal();
    const next = causal.normalizeParent(incoming);
    if (!next || next.articleRevision !== sidecar.knownRevision) {
      return { ...sidecar, serverReadingContextDiagnostic: { reason: "invalid-parent-context" } };
    }
    const previous = causal.normalizeParent(sidecar.serverReadingContext);
    if (sidecar.serverReadingContext != null && !previous) {
      return { ...sidecar, serverReadingContextDiagnostic: { reason: "malformed-parent-context" } };
    }
    if (previous && causal.ordinal(previous.articleRevision) > causal.ordinal(next.articleRevision)) {
      return sidecar;
    }
    if (previous?.articleRevision === next.articleRevision) {
      return causal.same(previous, next) &&
        (!sidecar.lastSyncedLifecycle || next.lifecycle === sidecar.lastSyncedLifecycle) ? sidecar :
        { ...sidecar, serverReadingContextDiagnostic: { reason: "inconsistent-parent-context" } };
    }
    if (sidecar.lastSyncedLifecycle && next.lifecycle !== sidecar.lastSyncedLifecycle) {
      return { ...sidecar, serverReadingContextDiagnostic: { reason: "invalid-parent-context" } };
    }
    if (previous?.readingEpoch === next.readingEpoch &&
        (previous.contentFingerprint !== next.contentFingerprint || previous.lifecycle !== next.lifecycle)) {
      return { ...sidecar, serverReadingContextDiagnostic: { reason: "inconsistent-parent-context" } };
    }
    return { ...sidecar, serverReadingContext: next, serverReadingContextDiagnostic: null };
  }

  // Bootstrap and gated runtime both settle through this idempotent boundary.
  async function settleArticleMutationSuccess(ownerId, bindingId, mutationId, result) {
    try {
      if (!["applied", "unchanged"].includes(result?.status) ||
          result.mutationId !== mutationId ||
          !/^revision:[1-9][0-9]*$/.test(result.revision) ||
          !/^cursor:[1-9][0-9]*$/.test(result.cursor)) {
        throw new Error("Article acknowledgement 无效。");
      }
      return await runTransaction(
        [CONTROL_STORE, ARTICLE_OUTBOX_STORE, ARTICLE_SIDECAR_STORE],
        "readwrite",
        async tx => {
          const control = tx.objectStore(CONTROL_STORE);
          const binding = await requireBinding(
            control, ownerId, bindingId
          );
          if (binding.status !== "ready") return binding;
          const outbox = tx.objectStore(ARTICLE_OUTBOX_STORE);
          const mutation = await requestResult(outbox.get([ownerId, mutationId]));
          if (!mutation || mutation.status !== "ready") {
            return blocked("article-ready-mutation-missing");
          }
          if (mutation.bindingId !== bindingId || mutation.articleId !== result.articleId ||
              mutation.operation !== result.operation) {
            return blocked("article-ack-identity-mismatch");
          }
          const sidecars = tx.objectStore(ARTICLE_SIDECAR_STORE);
          const sidecar = await requestResult(sidecars.get([ownerId, mutation.articleId]));
          if (!sidecar || sidecar.bindingId !== bindingId) {
            return blocked("article-sidecar-missing");
          }
          if (sidecar.knownRevision &&
              BigInt(sidecar.knownRevision.slice(9)) > BigInt(result.revision.slice(9))) {
            return blocked("article-stale-acknowledgement");
          }
          const nextSidecar = {
            ...sidecar,
            knownRevision: result.revision,
            lastSyncedFingerprint: mutation.candidateFingerprint,
            lastSyncedLifecycle: mutation.candidate.deletedAt === null ? "active" : "deleted"
          };
          await requestResult(sidecars.put(mergeArticleServerReadingContext(
            nextSidecar, result.serverReadingContext)));
          await requestResult(outbox.delete([ownerId, mutationId]));
          if (mutation.resolutionKind === "keep-local") {
            for (const key of articleConflictKeys(
              ownerId, bindingId, mutation.articleId
            )) {
              await requestResult(control.delete(key));
            }
            const stateValue = await requestResult(
              control.get(articleBootstrapStateKey(ownerId, bindingId))
            );
            if (stateValue) {
              const bootstrap = validateArticleBootstrapState(stateValue);
              const all = await requestResult(control.getAll());
              const remaining = all.filter(item =>
                item?.kind === "article-bootstrap-issue" &&
                item.ownerId === ownerId && item.bindingId === bindingId);
              if (bootstrap.status === "blocked" && remaining.length === 0) {
                await requestResult(control.put({
                  ...bootstrap,
                  status: "in_progress",
                  phase: bootstrap.blockedFromPhase || "reconciling",
                  issueCount: 0,
                  lastError: null,
                  updatedAt: new Date().toISOString()
                }));
              } else if (bootstrap.status === "blocked") {
                await requestResult(control.put({
                  ...bootstrap,
                  issueCount: remaining.length,
                  updatedAt: new Date().toISOString()
                }));
              }
            }
          }
          return { status: "settled", articleId: mutation.articleId, revision: result.revision };
        }
      );
    } catch (error) {
      return failed("article-settlement-failed", error);
    }
  }

  function articleBootstrapKey(prefix, ownerId, bindingId, suffix = "") {
    return `${prefix}${getCanonical().serialize([ownerId, bindingId, suffix])}`;
  }

  function articleBootstrapStateKey(ownerId, bindingId) {
    return articleBootstrapKey(ARTICLE_BOOTSTRAP_STATE_PREFIX, ownerId, bindingId);
  }

  function isArticleCursor(value, nullable = false) {
    return (nullable && value === null) ||
      (typeof value === "string" && /^cursor:(0|[1-9][0-9]*)$/.test(value));
  }

  function articleCursorNumber(value) {
    return BigInt(value.slice(7));
  }

  function validateArticleBootstrapIdentity(ownerId, bindingId) {
    if (!isOpaqueString(ownerId) || !isOpaqueString(bindingId)) {
      throw new Error("Article bootstrap identity 无效。");
    }
  }

  function validateArticleBootstrapState(value) {
    if (!isPlainObject(value) || value.kind !== "article-bootstrap-state" ||
        !isOpaqueString(value.ownerId) || !isOpaqueString(value.bindingId) ||
        !["in_progress", "blocked", "complete"].includes(value.status) ||
        !ARTICLE_BOOTSTRAP_PHASES.has(value.phase) ||
        !isArticleCursor(value.inventoryCursor, true) ||
        !isArticleCursor(value.remoteTailCursor, true) ||
        !isArticleCursor(value.finalCursor, true) ||
        !isArticleCursor(value.pendingCursor, true) ||
        typeof value.pendingHasMore !== "boolean" ||
        !Number.isInteger(value.issueCount) || value.issueCount < 0) {
      throw new Error("Article bootstrap state 无效。");
    }
    return value;
  }

  async function beginArticleBootstrap(ownerId, bindingId) {
    try {
      validateArticleBootstrapIdentity(ownerId, bindingId);
      return await runTransaction([CONTROL_STORE], "readwrite", async tx => {
        const store = tx.objectStore(CONTROL_STORE);
        const binding = await requireBinding(store, ownerId, bindingId);
        if (binding.status !== "ready") return binding;
        const key = articleBootstrapStateKey(ownerId, bindingId);
        const current = await requestResult(store.get(key));
        if (current) {
          return { status: "ready", state: validateArticleBootstrapState(current) };
        }
        const now = new Date().toISOString();
        const state = {
          key,
          kind: "article-bootstrap-state",
          ownerId,
          bindingId,
          status: "in_progress",
          phase: "remote-inventory",
          inventoryCursor: null,
          remoteTailCursor: null,
          finalCursor: null,
          pendingCursor: null,
          pendingHasMore: false,
          issueCount: 0,
          lastError: null,
          startedAt: now,
          updatedAt: now,
          completedAt: null
        };
        await requestResult(store.add(state));
        return { status: "ready", state };
      });
    } catch (error) {
      return failed("article-bootstrap-start-failed", error);
    }
  }

  async function getArticleBootstrapState(ownerId, bindingId) {
    try {
      validateArticleBootstrapIdentity(ownerId, bindingId);
      const value = await runTransaction([CONTROL_STORE], "readonly", tx => (
        requestResult(tx.objectStore(CONTROL_STORE)
          .get(articleBootstrapStateKey(ownerId, bindingId)))
      ));
      return value
        ? { status: "ready", state: validateArticleBootstrapState(value) }
        : { status: "not_started", state: null };
    } catch (error) {
      return failed("article-bootstrap-state-read-failed", error);
    }
  }

  function validateArticleBootstrapPage(page) {
    if (!isPlainObject(page) || page.status !== "ready" || !Array.isArray(page.changes) ||
        !isArticleCursor(page.nextCursor) || typeof page.hasMore !== "boolean") {
      throw new Error("Article bootstrap page 无效。");
    }
    return page.changes.map(change => {
      if (!isPlainObject(change) || !isOpaqueString(change.articleId) ||
          !["put", "delete", "restore"].includes(change.operation) ||
          !isArticleCursor(change.cursor) ||
          typeof change.revision !== "string" ||
          !/^revision:[1-9][0-9]*$/.test(change.revision)) {
        throw new Error("Article bootstrap change 无效。");
      }
      const projection = window.LingoFlowArticleSyncProjection
        .sanitizeArticleSyncProjection(change.projection);
      if (projection.id !== change.articleId) {
        throw new Error("Article bootstrap change identity 无效。");
      }
      return { ...change, projection };
    });
  }

  async function persistArticleBootstrapInventoryPage(
    ownerId,
    bindingId,
    afterCursor,
    page
  ) {
    try {
      validateArticleBootstrapIdentity(ownerId, bindingId);
      if (!isArticleCursor(afterCursor, true)) throw new Error("Inventory cursor 无效。");
      const changes = validateArticleBootstrapPage(page);
      return await runTransaction([CONTROL_STORE], "readwrite", async tx => {
        const store = tx.objectStore(CONTROL_STORE);
        const binding = await requireBinding(store, ownerId, bindingId);
        if (binding.status !== "ready") return binding;
        const key = articleBootstrapStateKey(ownerId, bindingId);
        const state = validateArticleBootstrapState(await requestResult(store.get(key)));
        if (state.status !== "in_progress" || state.phase !== "remote-inventory" ||
            state.inventoryCursor !== afterCursor) {
          return blocked("article-bootstrap-inventory-cursor-mismatch", { state });
        }
        for (const change of changes) {
          const itemKey = articleBootstrapKey(
            ARTICLE_BOOTSTRAP_INVENTORY_PREFIX,
            ownerId,
            bindingId,
            change.articleId
          );
          const current = await requestResult(store.get(itemKey));
          if (!current || articleCursorNumber(change.cursor) > articleCursorNumber(current.cursor)) {
            await requestResult(store.put({
              key: itemKey,
              kind: "article-bootstrap-inventory",
              ownerId,
              bindingId,
              ...change
            }));
          }
        }
        const now = new Date().toISOString();
        const next = {
          ...state,
          inventoryCursor: page.nextCursor,
          remoteTailCursor: page.hasMore ? state.remoteTailCursor : page.nextCursor,
          phase: page.hasMore ? "remote-inventory" : "reconciling",
          updatedAt: now,
          lastError: null
        };
        await requestResult(store.put(next));
        return { status: "persisted", state: next, count: changes.length };
      });
    } catch (error) {
      return failed("article-bootstrap-inventory-write-failed", error);
    }
  }

  async function listArticleBootstrapInventory(ownerId, bindingId) {
    try {
      validateArticleBootstrapIdentity(ownerId, bindingId);
      const values = await runTransaction([CONTROL_STORE], "readonly", tx => (
        requestResult(tx.objectStore(CONTROL_STORE).getAll())
      ));
      return {
        status: "ready",
        items: values.filter(item => item?.kind === "article-bootstrap-inventory" &&
          item.ownerId === ownerId && item.bindingId === bindingId)
          .sort((left, right) => left.articleId.localeCompare(right.articleId))
      };
    } catch (error) {
      return failed("article-bootstrap-inventory-read-failed", error);
    }
  }

  async function transitionArticleBootstrap(ownerId, bindingId, phase, lastError = null) {
    try {
      validateArticleBootstrapIdentity(ownerId, bindingId);
      if (!ARTICLE_BOOTSTRAP_PHASES.has(phase) || ["blocked", "complete"].includes(phase)) {
        throw new Error("Article bootstrap phase 无效。");
      }
      return await runTransaction([CONTROL_STORE], "readwrite", async tx => {
        const store = tx.objectStore(CONTROL_STORE);
        const binding = await requireBinding(store, ownerId, bindingId);
        if (binding.status !== "ready") return binding;
        const key = articleBootstrapStateKey(ownerId, bindingId);
        const state = validateArticleBootstrapState(await requestResult(store.get(key)));
        if (state.status !== "in_progress") return blocked("article-bootstrap-not-in-progress");
        const next = {
          ...state,
          phase,
          lastError: isOpaqueString(lastError) ? lastError : null,
          updatedAt: new Date().toISOString(),
          ...(phase === "catching-up" && state.finalCursor === null
            ? { finalCursor: state.remoteTailCursor }
            : {})
        };
        await requestResult(store.put(next));
        return { status: "ready", state: next };
      });
    } catch (error) {
      return failed("article-bootstrap-transition-failed", error);
    }
  }

  async function pauseArticleBootstrap(ownerId, bindingId, reason) {
    try {
      validateArticleBootstrapIdentity(ownerId, bindingId);
      if (!isOpaqueString(reason)) throw new Error("Article bootstrap pause reason 无效。");
      return await runTransaction([CONTROL_STORE], "readwrite", async tx => {
        const store = tx.objectStore(CONTROL_STORE);
        const binding = await requireBinding(store, ownerId, bindingId);
        if (binding.status !== "ready") return binding;
        const key = articleBootstrapStateKey(ownerId, bindingId);
        const state = validateArticleBootstrapState(await requestResult(store.get(key)));
        const next = {
          ...state,
          status: "in_progress",
          lastError: reason,
          updatedAt: new Date().toISOString()
        };
        await requestResult(store.put(next));
        return { status: "paused", state: next };
      });
    } catch (error) {
      return failed("article-bootstrap-pause-failed", error);
    }
  }

  async function captureArticleBootstrapIssue(value) {
    try {
      const issue = getCanonical().snapshot(value, "articleBootstrapIssue");
      validateArticleBootstrapIdentity(issue.ownerId, issue.bindingId);
      if (!isOpaqueString(issue.articleId) || !isOpaqueString(issue.reason) ||
          (issue.remoteRevision !== null &&
            (typeof issue.remoteRevision !== "string" ||
              !/^revision:[1-9][0-9]*$/.test(issue.remoteRevision))) ||
          !["active", "deleted", "missing"].includes(issue.remoteLifecycle)) {
        throw new Error("Article bootstrap issue 无效。");
      }
      const localProjection = issue.localProjection === null ? null
        : window.LingoFlowArticleSyncProjection
          .sanitizeArticleSyncProjection(issue.localProjection);
      const remoteProjection = issue.remoteProjection === null ? null
        : window.LingoFlowArticleSyncProjection
          .sanitizeArticleSyncProjection(issue.remoteProjection);
      const now = new Date().toISOString();
      return await runTransaction([CONTROL_STORE], "readwrite", async tx => {
        const store = tx.objectStore(CONTROL_STORE);
        const binding = await requireBinding(store, issue.ownerId, issue.bindingId);
        if (binding.status !== "ready") return binding;
        const stateKey = articleBootstrapStateKey(issue.ownerId, issue.bindingId);
        const state = validateArticleBootstrapState(await requestResult(store.get(stateKey)));
        const key = articleBootstrapKey(
          ARTICLE_BOOTSTRAP_ISSUE_PREFIX,
          issue.ownerId,
          issue.bindingId,
          issue.articleId
        );
        const existing = await requestResult(store.get(key));
        await requestResult(store.put({
          key,
          kind: "article-bootstrap-issue",
          ownerId: issue.ownerId,
          bindingId: issue.bindingId,
          articleId: issue.articleId,
          reason: issue.reason,
          localProjection,
          remoteProjection,
          remoteRevision: issue.remoteRevision,
          remoteLifecycle: issue.remoteLifecycle,
          resolutionStatus: "pending",
          resolutionAction: null,
          resolutionMutationId: null,
          createdAt: existing?.createdAt || now,
          updatedAt: now
        }));
        const all = await requestResult(store.getAll());
        const issueCount = all.filter(item => item?.kind === "article-bootstrap-issue" &&
          item.ownerId === issue.ownerId && item.bindingId === issue.bindingId).length;
        const next = {
          ...state,
          status: "blocked",
          phase: "blocked",
          blockedFromPhase: state.phase === "blocked"
            ? (state.blockedFromPhase || "reconciling")
            : state.phase,
          issueCount,
          lastError: issue.reason,
          updatedAt: now
        };
        await requestResult(store.put(next));
        return { status: "captured", issueCount, state: next };
      });
    } catch (error) {
      return failed("article-bootstrap-issue-capture-failed", error);
    }
  }

  async function listArticleBootstrapIssues(ownerId, bindingId) {
    try {
      validateArticleBootstrapIdentity(ownerId, bindingId);
      const values = await runTransaction([CONTROL_STORE], "readonly", tx => (
        requestResult(tx.objectStore(CONTROL_STORE).getAll())
      ));
      return {
        status: "ready",
        issues: values.filter(item => item?.kind === "article-bootstrap-issue" &&
          item.ownerId === ownerId && item.bindingId === bindingId)
          .sort((left, right) => left.articleId.localeCompare(right.articleId))
      };
    } catch (error) {
      return failed("article-bootstrap-issue-read-failed", error);
    }
  }

  async function bindArticleRemoteRevision(
    ownerId,
    bindingId,
    articleId,
    revision,
    fingerprint,
    lifecycle = null,
    serverReadingContext = null
  ) {
    try {
      validateArticleBootstrapIdentity(ownerId, bindingId);
      if (!isOpaqueString(articleId) || !/^revision:[1-9][0-9]*$/.test(revision) ||
          !/^[a-f0-9]{64}$/.test(fingerprint) ||
          (lifecycle !== null && !["active", "deleted"].includes(lifecycle))) {
        throw new Error("Article remote binding 无效。");
      }
      return await runTransaction(
        [CONTROL_STORE, ARTICLE_OUTBOX_STORE, ARTICLE_SIDECAR_STORE],
        "readwrite",
        async tx => {
          const binding = await requireBinding(
            tx.objectStore(CONTROL_STORE), ownerId, bindingId
          );
          if (binding.status !== "ready") return binding;
          const pending = await requestResult(
            tx.objectStore(ARTICLE_OUTBOX_STORE).index("byOwnerBinding")
              .getAll([ownerId, bindingId])
          );
          if (pending.some(item => item.articleId === articleId &&
              ["prepared", "desired", "ready"].includes(item.status))) {
            return blocked("article-pending-mutation");
          }
          const store = tx.objectStore(ARTICLE_SIDECAR_STORE);
          const current = await requestResult(store.get([ownerId, articleId]));
          if (current && current.bindingId !== bindingId) {
            return blocked("workspace-binding-mismatch");
          }
          if (current?.knownRevision &&
              BigInt(current.knownRevision.slice(9)) > BigInt(revision.slice(9))) {
            return blocked("article-stale-remote-revision");
          }
          const sidecar = {
            ...current,
            ownerId,
            bindingId,
            articleId,
            knownRevision: revision,
            lastSyncedFingerprint: fingerprint,
            ...(lifecycle ? { lastSyncedLifecycle: lifecycle } :
              current?.lastSyncedLifecycle ? {
                lastSyncedLifecycle: current.lastSyncedLifecycle
              } : {})
          };
          const updated = mergeArticleServerReadingContext(sidecar, serverReadingContext);
          await requestResult(store.put(updated));
          return { status: "bound", sidecar: updated };
        }
      );
    } catch (error) {
      return failed("article-remote-binding-failed", error);
    }
  }

  async function persistArticleBootstrapCatchupPage(
    ownerId,
    bindingId,
    afterCursor,
    page
  ) {
    try {
      validateArticleBootstrapIdentity(ownerId, bindingId);
      if (!isArticleCursor(afterCursor, true)) throw new Error("Catch-up cursor 无效。");
      const changes = validateArticleBootstrapPage(page);
      return await runTransaction([CONTROL_STORE], "readwrite", async tx => {
        const store = tx.objectStore(CONTROL_STORE);
        const binding = await requireBinding(store, ownerId, bindingId);
        if (binding.status !== "ready") return binding;
        const stateKey = articleBootstrapStateKey(ownerId, bindingId);
        const state = validateArticleBootstrapState(await requestResult(store.get(stateKey)));
        if (state.status !== "in_progress" || state.phase !== "catching-up" ||
            state.finalCursor !== afterCursor || state.pendingCursor !== null) {
          return blocked("article-bootstrap-catchup-cursor-mismatch", { state });
        }
        for (const change of changes) {
          const key = articleBootstrapKey(
            ARTICLE_BOOTSTRAP_PENDING_PREFIX,
            ownerId,
            bindingId,
            change.cursor
          );
          await requestResult(store.put({
            key,
            kind: "article-bootstrap-pending-change",
            ownerId,
            bindingId,
            ...change
          }));
        }
        const next = {
          ...state,
          pendingCursor: page.nextCursor,
          pendingHasMore: page.hasMore,
          updatedAt: new Date().toISOString()
        };
        await requestResult(store.put(next));
        return { status: "persisted", state: next, count: changes.length };
      });
    } catch (error) {
      return failed("article-bootstrap-catchup-write-failed", error);
    }
  }

  async function listArticleBootstrapPendingChanges(ownerId, bindingId) {
    try {
      validateArticleBootstrapIdentity(ownerId, bindingId);
      const values = await runTransaction([CONTROL_STORE], "readonly", tx => (
        requestResult(tx.objectStore(CONTROL_STORE).getAll())
      ));
      return {
        status: "ready",
        changes: values.filter(item => item?.kind === "article-bootstrap-pending-change" &&
          item.ownerId === ownerId && item.bindingId === bindingId)
          .sort((left, right) => articleCursorNumber(left.cursor) < articleCursorNumber(right.cursor)
            ? -1 : 1)
      };
    } catch (error) {
      return failed("article-bootstrap-pending-read-failed", error);
    }
  }

  async function commitArticleBootstrapCatchupPage(ownerId, bindingId) {
    try {
      validateArticleBootstrapIdentity(ownerId, bindingId);
      return await runTransaction([CONTROL_STORE], "readwrite", async tx => {
        const store = tx.objectStore(CONTROL_STORE);
        const binding = await requireBinding(store, ownerId, bindingId);
        if (binding.status !== "ready") return binding;
        const stateKey = articleBootstrapStateKey(ownerId, bindingId);
        const state = validateArticleBootstrapState(await requestResult(store.get(stateKey)));
        if (state.status !== "in_progress" || state.phase !== "catching-up" ||
            state.pendingCursor === null) {
          return blocked("article-bootstrap-catchup-page-missing");
        }
        const values = await requestResult(store.getAll());
        for (const item of values) {
          if (item?.kind === "article-bootstrap-pending-change" &&
              item.ownerId === ownerId && item.bindingId === bindingId) {
            await requestResult(store.delete(item.key));
          }
        }
        const next = {
          ...state,
          finalCursor: state.pendingCursor,
          pendingCursor: null,
          phase: state.pendingHasMore ? "catching-up" : "finalizing",
          pendingHasMore: false,
          updatedAt: new Date().toISOString()
        };
        await requestResult(store.put(next));
        return { status: "committed", state: next };
      });
    } catch (error) {
      return failed("article-bootstrap-catchup-commit-failed", error);
    }
  }

  async function completeArticleBootstrap(ownerId, bindingId) {
    try {
      validateArticleBootstrapIdentity(ownerId, bindingId);
      return await runTransaction(
        [CONTROL_STORE, ARTICLE_OUTBOX_STORE],
        "readwrite",
        async tx => {
          const control = tx.objectStore(CONTROL_STORE);
          const binding = await requireBinding(control, ownerId, bindingId);
          if (binding.status !== "ready") return binding;
          const stateKey = articleBootstrapStateKey(ownerId, bindingId);
          const state = validateArticleBootstrapState(await requestResult(control.get(stateKey)));
          const pendingOutbox = await requestResult(
            tx.objectStore(ARTICLE_OUTBOX_STORE).index("byOwnerBinding")
              .getAll([ownerId, bindingId])
          );
          const values = await requestResult(control.getAll());
          const issues = values.filter(item => item?.kind === "article-bootstrap-issue" &&
            item.ownerId === ownerId && item.bindingId === bindingId);
          const pendingChanges = values.filter(item =>
            item?.kind === "article-bootstrap-pending-change" &&
            item.ownerId === ownerId && item.bindingId === bindingId);
          if (state.phase !== "finalizing" || pendingOutbox.some(item =>
              ["prepared", "ready"].includes(item.status)) ||
              issues.length > 0 || pendingChanges.length > 0) {
            return blocked("article-bootstrap-not-clean");
          }
          for (const item of values) {
            if (item?.kind === "article-bootstrap-inventory" &&
                item.ownerId === ownerId && item.bindingId === bindingId) {
              await requestResult(control.delete(item.key));
            }
          }
          const now = new Date().toISOString();
          const next = {
            ...state,
            status: "complete",
            phase: "complete",
            issueCount: 0,
            lastError: null,
            updatedAt: now,
            completedAt: now
          };
          await requestResult(control.put(next));
          return { status: "complete", state: next };
        }
      );
    } catch (error) {
      return failed("article-bootstrap-complete-failed", error);
    }
  }

  function articleRuntimeStateKey(ownerId, bindingId) {
    return articleBootstrapKey(ARTICLE_RUNTIME_STATE_PREFIX, ownerId, bindingId);
  }

  function validateArticleRuntimeState(value) {
    if (!isPlainObject(value) || value.kind !== "article-runtime-state" ||
        !isOpaqueString(value.ownerId) || !isOpaqueString(value.bindingId) ||
        !["active", "paused"].includes(value.status) ||
        !isArticleCursor(value.cursor) || !isArticleCursor(value.pendingCursor, true) ||
        typeof value.pendingHasMore !== "boolean") {
      throw new Error("Article runtime state 无效。");
    }
    return value;
  }

  async function beginArticleRuntime(ownerId, bindingId) {
    try {
      validateArticleBootstrapIdentity(ownerId, bindingId);
      return await runTransaction([CONTROL_STORE], "readwrite", async tx => {
        const store = tx.objectStore(CONTROL_STORE);
        const binding = await requireBinding(store, ownerId, bindingId);
        if (binding.status !== "ready") return binding;
        const bootstrapValue = await requestResult(
          store.get(articleBootstrapStateKey(ownerId, bindingId))
        );
        if (!bootstrapValue) return blocked("article-bootstrap-required");
        const bootstrap = validateArticleBootstrapState(bootstrapValue);
        if (bootstrap.status !== "complete" || bootstrap.phase !== "complete") {
          return blocked(bootstrap.status === "blocked"
            ? "article-bootstrap-blocked"
            : "article-bootstrap-incomplete");
        }
        const key = articleRuntimeStateKey(ownerId, bindingId);
        const current = await requestResult(store.get(key));
        if (current) {
          const runtimeState = validateArticleRuntimeState(current);
          const resumed = {
            ...runtimeState,
            status: "active",
            lastError: null,
            updatedAt: new Date().toISOString()
          };
          await requestResult(store.put(resumed));
          return { status: "ready", state: resumed };
        }
        const now = new Date().toISOString();
        const runtimeState = {
          key,
          kind: "article-runtime-state",
          ownerId,
          bindingId,
          status: "active",
          cursor: bootstrap.finalCursor || "cursor:0",
          pendingCursor: null,
          pendingHasMore: false,
          lastError: null,
          startedAt: now,
          updatedAt: now
        };
        await requestResult(store.add(runtimeState));
        return { status: "ready", state: runtimeState };
      });
    } catch (error) {
      return failed("article-runtime-start-failed", error);
    }
  }

  async function getArticleRuntimeState(ownerId, bindingId) {
    try {
      validateArticleBootstrapIdentity(ownerId, bindingId);
      const value = await runTransaction([CONTROL_STORE], "readonly", tx => (
        requestResult(tx.objectStore(CONTROL_STORE).get(articleRuntimeStateKey(ownerId, bindingId)))
      ));
      return value
        ? { status: "ready", state: validateArticleRuntimeState(value) }
        : { status: "not_started", state: null };
    } catch (error) {
      return failed("article-runtime-state-read-failed", error);
    }
  }

  async function pauseArticleRuntime(ownerId, bindingId, reason) {
    try {
      if (!isOpaqueString(reason)) throw new Error("Article runtime pause reason 无效。");
      return await runTransaction([CONTROL_STORE], "readwrite", async tx => {
        const store = tx.objectStore(CONTROL_STORE);
        const binding = await requireBinding(store, ownerId, bindingId);
        if (binding.status !== "ready") return binding;
        const key = articleRuntimeStateKey(ownerId, bindingId);
        const current = validateArticleRuntimeState(await requestResult(store.get(key)));
        const next = {
          ...current,
          status: "paused",
          lastError: reason,
          updatedAt: new Date().toISOString()
        };
        await requestResult(store.put(next));
        return { status: "paused", state: next };
      });
    } catch (error) {
      return failed("article-runtime-pause-failed", error);
    }
  }

  async function persistArticleRuntimePullPage(ownerId, bindingId, afterCursor, page) {
    try {
      validateArticleBootstrapIdentity(ownerId, bindingId);
      if (!isArticleCursor(afterCursor)) throw new Error("Article runtime cursor 无效。");
      const changes = validateArticleBootstrapPage(page);
      return await runTransaction([CONTROL_STORE], "readwrite", async tx => {
        const store = tx.objectStore(CONTROL_STORE);
        const binding = await requireBinding(store, ownerId, bindingId);
        if (binding.status !== "ready") return binding;
        const key = articleRuntimeStateKey(ownerId, bindingId);
        const current = validateArticleRuntimeState(await requestResult(store.get(key)));
        if (current.cursor !== afterCursor || current.pendingCursor !== null) {
          return blocked("article-runtime-cursor-mismatch", { state: current });
        }
        for (const change of changes) {
          const pendingKey = articleBootstrapKey(
            ARTICLE_RUNTIME_PENDING_PREFIX,
            ownerId,
            bindingId,
            change.cursor
          );
          await requestResult(store.put({
            key: pendingKey,
            kind: "article-runtime-pending-change",
            ownerId,
            bindingId,
            ...change
          }));
        }
        const next = {
          ...current,
          status: "active",
          pendingCursor: page.nextCursor,
          pendingHasMore: page.hasMore,
          lastError: null,
          updatedAt: new Date().toISOString()
        };
        await requestResult(store.put(next));
        return { status: "persisted", state: next, count: changes.length };
      });
    } catch (error) {
      return failed("article-runtime-page-write-failed", error);
    }
  }

  async function listArticleRuntimePendingChanges(ownerId, bindingId) {
    try {
      validateArticleBootstrapIdentity(ownerId, bindingId);
      const values = await runTransaction([CONTROL_STORE], "readonly", tx => (
        requestResult(tx.objectStore(CONTROL_STORE).getAll())
      ));
      return {
        status: "ready",
        changes: values.filter(item => item?.kind === "article-runtime-pending-change" &&
          item.ownerId === ownerId && item.bindingId === bindingId)
          .sort((left, right) => articleCursorNumber(left.cursor) < articleCursorNumber(right.cursor)
            ? -1 : 1)
      };
    } catch (error) {
      return failed("article-runtime-pending-read-failed", error);
    }
  }

  async function commitArticleRuntimePullPage(ownerId, bindingId) {
    try {
      validateArticleBootstrapIdentity(ownerId, bindingId);
      return await runTransaction([CONTROL_STORE], "readwrite", async tx => {
        const store = tx.objectStore(CONTROL_STORE);
        const binding = await requireBinding(store, ownerId, bindingId);
        if (binding.status !== "ready") return binding;
        const key = articleRuntimeStateKey(ownerId, bindingId);
        const current = validateArticleRuntimeState(await requestResult(store.get(key)));
        if (current.pendingCursor === null) {
          return blocked("article-runtime-page-missing");
        }
        const values = await requestResult(store.getAll());
        for (const item of values) {
          if (item?.kind === "article-runtime-pending-change" &&
              item.ownerId === ownerId && item.bindingId === bindingId) {
            await requestResult(store.delete(item.key));
          }
        }
        const next = {
          ...current,
          cursor: current.pendingCursor,
          pendingCursor: null,
          pendingHasMore: false,
          updatedAt: new Date().toISOString()
        };
        await requestResult(store.put(next));
        return { status: "committed", state: next, hadMore: current.pendingHasMore };
      });
    } catch (error) {
      return failed("article-runtime-page-commit-failed", error);
    }
  }

  async function captureArticleRuntimeIssue(value) {
    try {
      const issue = getCanonical().snapshot(value, "articleRuntimeIssue");
      validateArticleBootstrapIdentity(issue.ownerId, issue.bindingId);
      if (!isOpaqueString(issue.articleId) || !isOpaqueString(issue.reason) ||
          !isArticleCursor(issue.remoteCursor, true) ||
          (issue.remoteRevision !== null &&
            !/^revision:[1-9][0-9]*$/.test(issue.remoteRevision))) {
        throw new Error("Article runtime issue 无效。");
      }
      const localProjection = issue.localProjection === null ? null
        : window.LingoFlowArticleSyncProjection
          .sanitizeArticleSyncProjection(issue.localProjection);
      const remoteProjection = issue.remoteProjection === null ? null
        : window.LingoFlowArticleSyncProjection
          .sanitizeArticleSyncProjection(issue.remoteProjection);
      return await runTransaction([CONTROL_STORE], "readwrite", async tx => {
        const store = tx.objectStore(CONTROL_STORE);
        const binding = await requireBinding(store, issue.ownerId, issue.bindingId);
        if (binding.status !== "ready") return binding;
        const key = articleBootstrapKey(
          ARTICLE_RUNTIME_ISSUE_PREFIX,
          issue.ownerId,
          issue.bindingId,
          issue.articleId
        );
        const current = await requestResult(store.get(key));
        const now = new Date().toISOString();
        const stored = {
          key,
          kind: "article-runtime-issue",
          ownerId: issue.ownerId,
          bindingId: issue.bindingId,
          articleId: issue.articleId,
          reason: issue.reason,
          localProjection,
          remoteProjection,
          remoteRevision: issue.remoteRevision,
          remoteCursor: issue.remoteCursor,
          mutationId: isOpaqueString(issue.mutationId) ? issue.mutationId : null,
          resolutionStatus: "pending",
          resolutionAction: null,
          resolutionMutationId: null,
          createdAt: current?.createdAt || now,
          updatedAt: now
        };
        await requestResult(store.put(stored));
        return { status: "captured", issue: stored };
      });
    } catch (error) {
      return failed("article-runtime-issue-capture-failed", error);
    }
  }

  // Keep the complete Article in the library, but atomically remove every
  // sendable copy (including an older ready head) and record why it is local-only.
  async function quarantineOversizedArticle(ownerId, bindingId, articleId, remote = null) {
    try {
      validateArticleBootstrapIdentity(ownerId, bindingId);
      if (!isOpaqueString(articleId)) throw new Error("Article ID 无效。");
      return await runTransaction(
        [CONTROL_STORE, ARTICLE_OUTBOX_STORE, ARTICLE_SIDECAR_STORE],
        "readwrite",
        async tx => {
          const control = tx.objectStore(CONTROL_STORE);
          const binding = await requireBinding(control, ownerId, bindingId);
          if (binding.status !== "ready") return binding;
          const outbox = tx.objectStore(ARTICLE_OUTBOX_STORE);
          const mutations = await requestResult(
            outbox.index("byOwnerBinding").getAll([ownerId, bindingId])
          );
          for (const mutation of mutations) {
            if (mutation.articleId === articleId) {
              await requestResult(outbox.delete([ownerId, mutation.mutationId]));
            }
          }
          const key = articleBootstrapKey(
            ARTICLE_RUNTIME_ISSUE_PREFIX, ownerId, bindingId, articleId
          );
          const existing = await requestResult(control.get(key));
          const bootstrapIssueKey = articleBootstrapKey(
            ARTICLE_BOOTSTRAP_ISSUE_PREFIX, ownerId, bindingId, articleId
          );
          const bootstrapIssue = await requestResult(control.get(bootstrapIssueKey));
          const sidecar = await requestResult(
            tx.objectStore(ARTICLE_SIDECAR_STORE).get([ownerId, articleId])
          );
          const now = new Date().toISOString();
          const issue = {
            key, kind: "article-runtime-issue", ownerId, bindingId, articleId,
            reason: "article-too-large", localProjection: null,
            remoteProjection: remote?.projection || existing?.remoteProjection ||
              bootstrapIssue?.remoteProjection || null,
            remoteRevision: remote?.revision || existing?.remoteRevision ||
              bootstrapIssue?.remoteRevision ||
              sidecar?.knownRevision || null,
            remoteCursor: remote?.cursor || existing?.remoteCursor || null,
            mutationId: null, resolutionStatus: "pending",
            resolutionAction: null, resolutionMutationId: null,
            createdAt: existing?.createdAt || now, updatedAt: now
          };
          await requestResult(control.put(issue));
          if (bootstrapIssue) {
            await requestResult(control.delete(bootstrapIssueKey));
            const bootstrapStateKey = articleBootstrapStateKey(ownerId, bindingId);
            const bootstrapStateValue = await requestResult(control.get(bootstrapStateKey));
            if (bootstrapStateValue) {
              const bootstrapState = validateArticleBootstrapState(bootstrapStateValue);
              const all = await requestResult(control.getAll());
              const remaining = all.filter(item => item?.kind === "article-bootstrap-issue" &&
                item.ownerId === ownerId && item.bindingId === bindingId);
              await requestResult(control.put({
                ...bootstrapState,
                ...(bootstrapState.status === "blocked" && remaining.length === 0
                  ? { status: "in_progress",
                    phase: bootstrapState.blockedFromPhase || "reconciling",
                    lastError: null }
                  : {}),
                issueCount: remaining.length,
                updatedAt: now
              }));
            }
          }
          return { status: "quarantined", issue };
        }
      );
    } catch (error) {
      return failed("article-size-quarantine-failed", error);
    }
  }

  async function clearOversizedArticleIssue(ownerId, bindingId, articleId) {
    try {
      return await runTransaction([CONTROL_STORE], "readwrite", async tx => {
        const store = tx.objectStore(CONTROL_STORE);
        const binding = await requireBinding(store, ownerId, bindingId);
        if (binding.status !== "ready") return binding;
        const key = articleBootstrapKey(
          ARTICLE_RUNTIME_ISSUE_PREFIX, ownerId, bindingId, articleId
        );
        const current = await requestResult(store.get(key));
        if (current?.reason === "article-too-large") {
          await requestResult(store.delete(key));
        }
        return { status: "ready" };
      });
    } catch (error) {
      return failed("article-size-issue-clear-failed", error);
    }
  }

  async function listArticleRuntimeIssues(ownerId, bindingId) {
    try {
      validateArticleBootstrapIdentity(ownerId, bindingId);
      const values = await runTransaction([CONTROL_STORE], "readonly", tx => (
        requestResult(tx.objectStore(CONTROL_STORE).getAll())
      ));
      return {
        status: "ready",
        issues: values.filter(item => item?.kind === "article-runtime-issue" &&
          item.ownerId === ownerId && item.bindingId === bindingId)
          .sort((left, right) => left.articleId.localeCompare(right.articleId))
      };
    } catch (error) {
      return failed("article-runtime-issue-read-failed", error);
    }
  }

  function articleConflictKeys(ownerId, bindingId, articleId) {
    return [
      articleBootstrapKey(ARTICLE_BOOTSTRAP_ISSUE_PREFIX, ownerId, bindingId, articleId),
      articleBootstrapKey(ARTICLE_RUNTIME_ISSUE_PREFIX, ownerId, bindingId, articleId)
    ];
  }

  async function readArticleConflictEntries(store, ownerId, bindingId, articleId) {
    const entries = [];
    for (const key of articleConflictKeys(ownerId, bindingId, articleId)) {
      const value = await requestResult(store.get(key));
      if (value) entries.push(value);
    }
    return entries;
  }

  function conflictRevisionMatches(entries, expectedRevision) {
    return entries.length > 0 && entries.every(issue => issue.remoteRevision === expectedRevision);
  }

  async function prepareArticleKeepLocalResolution(value) {
    try {
      const input = getCanonical().snapshot(value, "articleKeepLocalResolution");
      validateArticleBootstrapIdentity(input.ownerId, input.bindingId);
      const candidate = window.LingoFlowArticleSyncProjection
        .sanitizeArticleSyncProjection(input.candidate);
      const remoteProjection = input.remoteProjection === null ? null
        : window.LingoFlowArticleSyncProjection
          .sanitizeArticleSyncProjection(input.remoteProjection);
      if (!isOpaqueString(input.articleId) || candidate.id !== input.articleId ||
          !isOpaqueString(input.mutationId) ||
          !["put", "delete", "restore"].includes(input.operation) ||
          (input.expectedRevision !== null &&
            !/^revision:[1-9][0-9]*$/.test(input.expectedRevision)) ||
          !/^[a-f0-9]{64}$/.test(input.candidateFingerprint) ||
          (input.remoteFingerprint !== null &&
            !/^[a-f0-9]{64}$/.test(input.remoteFingerprint))) {
        throw new Error("Article keep-local resolution 无效。");
      }
      return await runTransaction(
        [CONTROL_STORE, ARTICLE_OUTBOX_STORE, ARTICLE_SIDECAR_STORE],
        "readwrite",
        async tx => {
          const control = tx.objectStore(CONTROL_STORE);
          const binding = await requireBinding(control, input.ownerId, input.bindingId);
          if (binding.status !== "ready") return binding;
          const issues = await readArticleConflictEntries(
            control, input.ownerId, input.bindingId, input.articleId
          );
          if (!conflictRevisionMatches(issues, input.expectedRevision)) {
            return blocked("article-conflict-revision-changed");
          }
          const sidecars = tx.objectStore(ARTICLE_SIDECAR_STORE);
          const existingSidecar = await requestResult(sidecars.get([input.ownerId, input.articleId]));
          if (existingSidecar && existingSidecar.bindingId !== input.bindingId) {
            return blocked("workspace-binding-mismatch");
          }
          const outbox = tx.objectStore(ARTICLE_OUTBOX_STORE);
          const mutations = await requestResult(
            outbox.index("byOwnerBinding").getAll([input.ownerId, input.bindingId])
          );
          for (const mutation of mutations) {
            if (mutation.articleId === input.articleId) {
              await requestResult(outbox.delete([input.ownerId, mutation.mutationId]));
            }
          }
          const now = new Date().toISOString();
          const resolutionMutation = {
            ownerId: input.ownerId,
            bindingId: input.bindingId,
            mutationId: input.mutationId,
            articleId: input.articleId,
            operation: input.operation,
            status: "ready",
            createdAt: now,
            beforeFingerprint: input.candidateFingerprint,
            candidateFingerprint: input.candidateFingerprint,
            baseRevision: input.expectedRevision,
            candidate,
            captureMode: "conflict-resolution",
            resolutionKind: "keep-local",
            attemptedAt: null,
            attemptCount: 0,
            promotedAt: now
          };
          await requestResult(outbox.add(resolutionMutation));
          await requestResult(sidecars.put({
            ...existingSidecar,
            ownerId: input.ownerId,
            bindingId: input.bindingId,
            articleId: input.articleId,
            knownRevision: input.expectedRevision,
            lastSyncedFingerprint: input.remoteFingerprint,
            lastSyncedLifecycle: remoteProjection
              ? (remoteProjection.deletedAt === null ? "active" : "deleted")
              : null
          }));
          for (const issue of issues) {
            await requestResult(control.put({
              ...issue,
              resolutionStatus: "resolving",
              resolutionAction: "keep-local",
              resolutionMutationId: input.mutationId,
              updatedAt: now
            }));
          }
          const bootstrapIssue = issues.find(issue => issue.kind === "article-bootstrap-issue");
          if (bootstrapIssue) {
            const stateKey = articleBootstrapStateKey(input.ownerId, input.bindingId);
            const stateValue = await requestResult(control.get(stateKey));
            if (stateValue) {
              const state = validateArticleBootstrapState(stateValue);
              await requestResult(control.put({
                ...state,
                status: "in_progress",
                phase: "settling-outgoing",
                lastError: null,
                updatedAt: now
              }));
            }
          }
          return { status: "ready", mutation: resolutionMutation };
        }
      );
    } catch (error) {
      return failed("article-keep-local-resolution-failed", error);
    }
  }

  async function beginArticleUseRemoteResolution(value) {
    try {
      const input = getCanonical().snapshot(value, "articleUseRemoteResolution");
      validateArticleBootstrapIdentity(input.ownerId, input.bindingId);
      if (!isOpaqueString(input.articleId) ||
          (input.expectedRevision !== null &&
            !/^revision:[1-9][0-9]*$/.test(input.expectedRevision))) {
        throw new Error("Article use-remote resolution 无效。");
      }
      return await runTransaction([CONTROL_STORE], "readwrite", async tx => {
        const store = tx.objectStore(CONTROL_STORE);
        const binding = await requireBinding(store, input.ownerId, input.bindingId);
        if (binding.status !== "ready") return binding;
        const issues = await readArticleConflictEntries(
          store, input.ownerId, input.bindingId, input.articleId
        );
        if (!conflictRevisionMatches(issues, input.expectedRevision)) {
          return blocked("article-conflict-revision-changed");
        }
        const now = new Date().toISOString();
        for (const issue of issues) {
          await requestResult(store.put({
            ...issue,
            resolutionStatus: "resolving",
            resolutionAction: "use-remote",
            resolutionMutationId: null,
            updatedAt: now
          }));
        }
        return { status: "ready" };
      });
    } catch (error) {
      return failed("article-use-remote-resolution-start-failed", error);
    }
  }

  async function resetArticleConflictResolution(ownerId, bindingId, articleId) {
    try {
      validateArticleBootstrapIdentity(ownerId, bindingId);
      if (!isOpaqueString(articleId)) throw new Error("Article conflict identity 无效。");
      return await runTransaction([CONTROL_STORE], "readwrite", async tx => {
        const store = tx.objectStore(CONTROL_STORE);
        const binding = await requireBinding(store, ownerId, bindingId);
        if (binding.status !== "ready") return binding;
        const issues = await readArticleConflictEntries(store, ownerId, bindingId, articleId);
        const now = new Date().toISOString();
        for (const issue of issues) {
          await requestResult(store.put({
            ...issue,
            resolutionStatus: "pending",
            resolutionAction: null,
            resolutionMutationId: null,
            updatedAt: now
          }));
        }
        return { status: issues.length ? "ready" : "missing" };
      });
    } catch (error) {
      return failed("article-conflict-resolution-reset-failed", error);
    }
  }

  async function refreshArticleConflictIssue(value) {
    try {
      const input = getCanonical().snapshot(value, "articleConflictRefresh");
      validateArticleBootstrapIdentity(input.ownerId, input.bindingId);
      const remoteProjection = input.remoteProjection === null ? null
        : window.LingoFlowArticleSyncProjection
          .sanitizeArticleSyncProjection(input.remoteProjection);
      if (!isOpaqueString(input.articleId) ||
          (input.remoteRevision !== null &&
            !/^revision:[1-9][0-9]*$/.test(input.remoteRevision)) ||
          !isArticleCursor(input.remoteCursor, true)) {
        throw new Error("Article conflict refresh 无效。");
      }
      return await runTransaction(
        [CONTROL_STORE, ARTICLE_OUTBOX_STORE],
        "readwrite",
        async tx => {
          const store = tx.objectStore(CONTROL_STORE);
          const binding = await requireBinding(store, input.ownerId, input.bindingId);
          if (binding.status !== "ready") return binding;
          const issues = await readArticleConflictEntries(
            store, input.ownerId, input.bindingId, input.articleId
          );
          if (!issues.length) return { status: "missing" };
          const outbox = tx.objectStore(ARTICLE_OUTBOX_STORE);
          const mutations = await requestResult(
            outbox.index("byOwnerBinding").getAll([input.ownerId, input.bindingId])
          );
          for (const mutation of mutations) {
            if (mutation.articleId === input.articleId &&
                mutation.resolutionKind === "keep-local") {
              await requestResult(outbox.delete([input.ownerId, mutation.mutationId]));
            }
          }
          const now = new Date().toISOString();
          for (const issue of issues) {
            await requestResult(store.put({
              ...issue,
              reason: "remote-changed-during-resolution",
              remoteProjection,
              remoteRevision: input.remoteRevision,
              remoteCursor: input.remoteCursor,
              remoteLifecycle: remoteProjection
                ? (remoteProjection.deletedAt === null ? "active" : "deleted")
                : "missing",
              resolutionStatus: "pending",
              resolutionAction: null,
              resolutionMutationId: null,
              updatedAt: now
            }));
          }
          return { status: "refreshed" };
        }
      );
    } catch (error) {
      return failed("article-conflict-refresh-failed", error);
    }
  }

  async function finalizeArticleUseRemoteResolution(value) {
    try {
      const input = getCanonical().snapshot(value, "articleUseRemoteFinalization");
      validateArticleBootstrapIdentity(input.ownerId, input.bindingId);
      const remoteProjection = window.LingoFlowArticleSyncProjection
        .sanitizeArticleSyncProjection(input.remoteProjection);
      if (!isOpaqueString(input.articleId) || remoteProjection.id !== input.articleId ||
          !/^revision:[1-9][0-9]*$/.test(input.remoteRevision) ||
          !/^[a-f0-9]{64}$/.test(input.remoteFingerprint)) {
        throw new Error("Article use-remote finalization 无效。");
      }
      return await runTransaction(
        [CONTROL_STORE, ARTICLE_OUTBOX_STORE, ARTICLE_SIDECAR_STORE],
        "readwrite",
        async tx => {
          const control = tx.objectStore(CONTROL_STORE);
          const binding = await requireBinding(control, input.ownerId, input.bindingId);
          if (binding.status !== "ready") return binding;
          const issues = await readArticleConflictEntries(
            control, input.ownerId, input.bindingId, input.articleId
          );
          if (!issues.length || issues.some(issue =>
            issue.remoteRevision !== input.remoteRevision ||
            issue.resolutionStatus !== "resolving" ||
            issue.resolutionAction !== "use-remote")) {
            return blocked("article-conflict-resolution-mismatch");
          }
          const sidecars = tx.objectStore(ARTICLE_SIDECAR_STORE);
          const existingSidecar = await requestResult(sidecars.get([input.ownerId, input.articleId]));
          if (existingSidecar && existingSidecar.bindingId !== input.bindingId) {
            return blocked("workspace-binding-mismatch");
          }
          if (existingSidecar?.knownRevision && progressCausal().ordinal(existingSidecar.knownRevision) >
              progressCausal().ordinal(input.remoteRevision)) {
            return blocked("article-stale-remote-revision");
          }
          const outbox = tx.objectStore(ARTICLE_OUTBOX_STORE);
          const mutations = await requestResult(
            outbox.index("byOwnerBinding").getAll([input.ownerId, input.bindingId])
          );
          for (const mutation of mutations) {
            if (mutation.articleId === input.articleId) {
              await requestResult(outbox.delete([input.ownerId, mutation.mutationId]));
            }
          }
          const nextSidecar = {
            ...existingSidecar,
            ownerId: input.ownerId,
            bindingId: input.bindingId,
            articleId: input.articleId,
            knownRevision: input.remoteRevision,
            lastSyncedFingerprint: input.remoteFingerprint,
            lastSyncedLifecycle: remoteProjection.deletedAt === null ? "active" : "deleted"
          };
          await requestResult(sidecars.put(mergeArticleServerReadingContext(
            nextSidecar, input.serverReadingContext)));
          for (const issue of issues) await requestResult(control.delete(issue.key));
          const all = await requestResult(control.getAll());
          const remainingBootstrap = all.filter(item =>
            item?.kind === "article-bootstrap-issue" &&
            item.ownerId === input.ownerId && item.bindingId === input.bindingId);
          const stateKey = articleBootstrapStateKey(input.ownerId, input.bindingId);
          const stateValue = await requestResult(control.get(stateKey));
          if (stateValue) {
            const state = validateArticleBootstrapState(stateValue);
            if (remainingBootstrap.length === 0 && state.status === "blocked") {
              await requestResult(control.put({
                ...state,
                status: "in_progress",
                phase: state.blockedFromPhase || "reconciling",
                issueCount: 0,
                lastError: null,
                updatedAt: new Date().toISOString()
              }));
            } else if (state.status === "blocked") {
              await requestResult(control.put({
                ...state,
                issueCount: remainingBootstrap.length,
                updatedAt: new Date().toISOString()
              }));
            }
          }
          return { status: "resolved", articleId: input.articleId };
        }
      );
    } catch (error) {
      return failed("article-use-remote-finalization-failed", error);
    }
  }

  async function setArticleSidecarLifecycle(ownerId, bindingId, articleId, revision, lifecycle,
    serverReadingContext = null) {
    try {
      if (!isOpaqueString(articleId) || !/^revision:[1-9][0-9]*$/.test(revision) ||
          !["active", "deleted"].includes(lifecycle)) {
        throw new Error("Article sidecar lifecycle 无效。");
      }
      return await runTransaction(
        [CONTROL_STORE, ARTICLE_SIDECAR_STORE],
        "readwrite",
        async tx => {
          const binding = await requireBinding(
            tx.objectStore(CONTROL_STORE), ownerId, bindingId
          );
          if (binding.status !== "ready") return binding;
          const store = tx.objectStore(ARTICLE_SIDECAR_STORE);
          const sidecar = await requestResult(store.get([ownerId, articleId]));
          if (!sidecar || sidecar.bindingId !== bindingId || sidecar.knownRevision !== revision) {
            return blocked("article-sidecar-revision-mismatch");
          }
          const next = mergeArticleServerReadingContext(
            { ...sidecar, lastSyncedLifecycle: lifecycle }, serverReadingContext);
          await requestResult(store.put(next));
          return { status: "ready", sidecar: next };
        }
      );
    } catch (error) {
      return failed("article-sidecar-lifecycle-write-failed", error);
    }
  }

  async function setWorkspaceAccountLabel(value) {
    try {
      const metadata = validateAccountLabelInput(value);
      return await runTransaction([CONTROL_STORE], "readwrite", async tx => {
        const store = tx.objectStore(CONTROL_STORE);
        const bindingValue = await requestResult(store.get(BINDING_KEY));
        if (bindingValue === undefined) return blocked("workspace-unbound");
        const binding = validateStoredBinding(bindingValue);
        const mismatch = getWorkspaceMismatch(
          binding,
          metadata.ownerId,
          metadata.bindingId
        );
        if (mismatch) return mismatch;
        const stored = { key: ACCOUNT_LABEL_KEY, ...metadata };
        await requestResult(store.put(stored));
        return { status: "ready", metadata: stored };
      });
    } catch (error) {
      return failed("workspace-account-label-write-failed", error);
    }
  }

  async function getWorkspaceAccountLabel() {
    try {
      const value = await runTransaction([CONTROL_STORE], "readonly", tx => (
        requestResult(tx.objectStore(CONTROL_STORE).get(ACCOUNT_LABEL_KEY))
      ));
      if (value === undefined) return { status: "missing", metadata: null };
      return { status: "ready", metadata: validateStoredAccountLabel(value) };
    } catch (error) {
      return failed("workspace-account-label-read-failed", error);
    }
  }

  async function replaceWorkspaceBinding(value) {
    try {
      if (!isPlainObject(value) ||
          !hasExactFields(value, new Set(["accountLabel", "from", "to"]))) {
        throw new Error("Workspace replacement 无效。");
      }
      const from = validateBindingInput(value.from);
      const to = validateBindingInput(value.to);
      const accountLabel = validateAccountLabelInput({
        ...to,
        label: value.accountLabel
      });
      if (from.ownerId === to.ownerId || from.bindingId === to.bindingId) {
        throw new Error("Workspace replacement identity 无效。");
      }

      const storeNames = [
        CONTROL_STORE,
        SIDECAR_STORE,
        OUTBOX_STORE,
        ISSUES_STORE,
        INBOX_STORE,
        ARTICLE_OUTBOX_STORE,
        ARTICLE_SIDECAR_STORE,
        PROGRESS_ATTEMPTS_STORE
      ];
      return await runTransaction(storeNames, "readwrite", async tx => {
        const control = tx.objectStore(CONTROL_STORE);
        const currentValue = await requestResult(control.get(BINDING_KEY));
        if (currentValue === undefined) return blocked("workspace-unbound");
        const current = validateStoredBinding(currentValue);
        const mismatch = getWorkspaceMismatch(current, from.ownerId, from.bindingId);
        if (mismatch) return mismatch;

        // A's attempts remain durable, but a never-sent attempt cannot survive
        // replacement as an ordinary prepared candidate.
        const attempts = tx.objectStore(PROGRESS_ATTEMPTS_STORE);
        const oldAttempts = await requestResult(attempts.index("byOwnerBinding")
          .getAll(IDBKeyRange.only([from.ownerId, from.bindingId])));
        for (const attempt of oldAttempts) {
          if (["awaiting_postflight", "prepared"].includes(attempt.status)) {
            await requestResult(attempts.put({ ...attempt,
              status: "blocked_before_dispatch", reason: "workspace-replaced" }));
          }
        }
        await Promise.all(storeNames.filter(name => name !== PROGRESS_ATTEMPTS_STORE).map(name => (
          requestResult(tx.objectStore(name).clear())
        )));
        const binding = { key: BINDING_KEY, ...to };
        const metadata = { key: ACCOUNT_LABEL_KEY, ...accountLabel };
        await requestResult(control.add(binding));
        await requestResult(control.add(metadata));
        return { status: "replaced", binding, metadata };
      });
    } catch (error) {
      return failed("workspace-replacement-failed", error);
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
    if (Object.prototype.hasOwnProperty.call(value, "entityType") &&
        !SYNC_ENTITY_TYPES.has(value.entityType)) {
      throw new Error("Inbox query entityType 无效。");
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
          .filter(item => !value.entityType || item.entityType === value.entityType)
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
          !isOpaqueString(value.entityId) ||
          (value.entityType !== undefined && !SYNC_ENTITY_TYPES.has(value.entityType))) {
        throw new Error("Pull anchor identity 无效。");
      }
      const entityType = value.entityType || "favorites";
      return await runTransaction([CONTROL_STORE], "readonly", async tx => {
        const store = tx.objectStore(CONTROL_STORE);
        const binding = await requireBinding(store, value.ownerId, value.bindingId);
        if (binding.status !== "ready") return binding;
        const stored = await requestResult(store.get(controlKey(
          PULL_ANCHOR_PREFIX,
          value.ownerId,
          value.bindingId,
          pullAnchorSuffix(entityType, value.entityId)
        )));
        return stored === undefined
          ? { status: "missing", anchor: null }
          : { status: "ready", anchor: validatePullAnchor(stored) };
      });
    } catch (error) {
      return failed("pull-anchor-read-failed", error);
    }
  }

  async function getSidecar(ownerId, entityId, entityType = "favorites") {
    try {
      if (!isOpaqueString(ownerId) || !isOpaqueString(entityId) ||
          !SYNC_ENTITY_TYPES.has(entityType)) {
        throw new Error("Favorite sidecar identity 无效。");
      }
      const values = await runTransaction([SIDECAR_STORE], "readonly", tx => (
        requestResult(tx.objectStore(SIDECAR_STORE).getAll())
      ));
      const sidecars = values.map(validateSidecar).filter(sidecar => (
        isSameFavoriteRecord(sidecar, {
          entityType,
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

  async function listSidecars(ownerId, entityType = "favorites") {
    try {
      if (!isOpaqueString(ownerId) || !SYNC_ENTITY_TYPES.has(entityType)) {
        throw new Error("ownerId / entityType 无效。");
      }
      const values = await runTransaction([SIDECAR_STORE], "readonly", tx => (
        requestResult(tx.objectStore(SIDECAR_STORE).getAll())
      ));
      const allSidecars = values.map(validateSidecar);
      if (allSidecars.some(sidecar => (
        sidecar.entityType === entityType && sidecar.ownerId !== ownerId
      ))) {
        return blocked("workspace-owner-mismatch");
      }
      const sidecars = allSidecars
        .filter(sidecar => sidecar.ownerId === ownerId && sidecar.entityType === entityType)
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

  async function readRecordSidecar(store, owner, entityType, entityId) {
    const stored = await requestResult(store.get([
      owner.ownerId,
      entityType,
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

  async function readRecordOutbox(store, owner, entityType, entityId) {
    const values = await requestResult(store.index("byOwnerRecord").getAll([
      owner.ownerId,
      entityType,
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

  async function readRecordIssues(store, owner, entityType, entityId) {
    const values = await requestResult(store.index("byOwnerRecord").getAll([
      owner.ownerId,
      entityType,
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
        pullAnchorSuffix(change.entityType, change.entityId)
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
            item.entityType,
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
      const next = await getNextInbox(owner);
      if (next.status !== "ready") return next;
      const expectedEntityType = next.item.entityType;
      value.localBeforeSnapshot = validateRecordSnapshot(
        value.localBeforeSnapshot,
        expectedEntityType,
        null,
        true
      );
      value.candidateSnapshot = validateRecordSnapshot(
        value.candidateSnapshot,
        expectedEntityType,
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
          const candidateId = item.entityType === "favorites"
            ? value.candidateSnapshot.id
            : value.candidateSnapshot.favoriteId;
          const beforeId = value.localBeforeSnapshot === null
            ? null
            : item.entityType === "favorites"
              ? value.localBeforeSnapshot.id
              : value.localBeforeSnapshot.favoriteId;
          if (candidateId !== item.entityId ||
              (value.localBeforeSnapshot !== null &&
                beforeId !== item.entityId) ||
              !getCanonical().valuesEqual(value.candidateSnapshot, item.change.payload)) {
            return blocked("inbox-apply-candidate-changed");
          }

          const sidecar = await readRecordSidecar(
            tx.objectStore(SIDECAR_STORE),
            owner,
            item.entityType,
            item.entityId
          );
          if (sidecar?.status === "blocked") return sidecar;
          if (!getCanonical().valuesEqual(sidecar, value.expectedSidecarSnapshot)) {
            return blocked("sidecar-state-changed");
          }
          const pending = await readRecordOutbox(
            tx.objectStore(OUTBOX_STORE),
            owner,
            item.entityType,
            item.entityId
          );
          if (pending?.status === "blocked") return pending;
          if (pending.length) return blocked("outbox-state-changed");
          const issues = await readRecordIssues(
            tx.objectStore(ISSUES_STORE),
            owner,
            item.entityType,
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
          const currentSidecar = await readRecordSidecar(
            sidecars,
            owner,
            item.entityType,
            item.entityId
          );
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
            item.entityType,
            item.entityId
          );
          if (pending?.status === "blocked") return pending;
          if (pending.length) return blocked("outbox-state-changed");
          const issues = await readRecordIssues(
            tx.objectStore(ISSUES_STORE),
            owner,
            item.entityType,
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
          value.localSnapshot = validateRecordSnapshot(
            value.localSnapshot,
            item.entityType,
            item.entityId,
            true
          );
          const sidecar = await readRecordSidecar(
            tx.objectStore(SIDECAR_STORE),
            owner,
            item.entityType,
            item.entityId
          );
          if (sidecar?.status === "blocked") return sidecar;
          const pending = await readRecordOutbox(
            tx.objectStore(OUTBOX_STORE),
            owner,
            item.entityType,
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
          !isOpaqueString(value.leaseToken) ||
          (value.entityType !== undefined && !SYNC_ENTITY_TYPES.has(value.entityType))) {
        throw new Error("cancelUnattemptedOutbox context 无效。");
      }
      const entityType = value.entityType || "favorites";
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
            entityType,
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
      if (Object.prototype.hasOwnProperty.call(value, "entityType") &&
          !SYNC_ENTITY_TYPES.has(value.entityType)) {
        throw new Error("Sync issue query entityType 无效。");
      }
      const values = await runTransaction([ISSUES_STORE], "readonly", tx => (
        requestResult(tx.objectStore(ISSUES_STORE).getAll())
      ));
      const issues = values.map(validateIssue)
        .filter(issue => issue.ownerId === value.ownerId)
        .filter(issue => !value.bindingId || issue.bindingId === value.bindingId)
        .filter(issue => !value.entityType || issue.entityType === value.entityType)
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
      if (Object.prototype.hasOwnProperty.call(value, "entityType") &&
          !SYNC_ENTITY_TYPES.has(value.entityType)) {
        throw new Error("Outbox query entityType 无效。");
      }

      const values = await runTransaction([OUTBOX_STORE], "readonly", tx => (
        requestResult(tx.objectStore(OUTBOX_STORE).getAll())
      ));
      const items = values.map(validateStoredOutbox)
        .filter(item => item.ownerId === value.ownerId)
        .filter(item => !value.status || item.status === value.status)
        .filter(item => !value.entityType || item.entityType === value.entityType)
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

  const progressCausal = () => window.LingoFlowProgressCausalState;
  const progressScopeRange = (ownerId, bindingId) =>
    IDBKeyRange.bound([ownerId, bindingId, ""], [ownerId, bindingId, "\uffff"]);

  // Local provenance only: neither counter orders server revisions, epochs,
  // devices or reading positions. No clock/timestamp participates in this proof.
  const evidenceKey = (ownerId, bindingId, articleId) =>
    `article-context-evidence:${JSON.stringify([ownerId, bindingId, articleId])}`;
  const safeOrdinal = value => Number.isSafeInteger(value) && value >= 0;
  const evidenceFields = new Set(["key", "kind", "ownerId", "bindingId", "articleId",
    "eventOrdinal", "confirmationSeq", "lastConfirmedRequestOrdinal", "requests"]);
  const ticketFields = new Set(["ownerId", "bindingId", "articleId", "observationId", "requestEventOrdinal"]);
  const confirmationFields = new Set(["ownerId", "bindingId", "articleId", "confirmationSeq",
    "observationId", "source", "requestEventOrdinal", "context", "snapshotCursor"]);
  const parentRejectionReasons = new Set(["parent-not-ready", "article-deleted",
    "parent-epoch-mismatch", "fingerprint-mismatch"]);

  function validEvidenceClock(value, ownerId, bindingId, articleId) {
    return isPlainObject(value) && hasExactFields(value, evidenceFields) &&
      value.key === evidenceKey(ownerId, bindingId, articleId) && value.kind === "article-context-evidence" &&
      value.ownerId === ownerId && value.bindingId === bindingId && value.articleId === articleId &&
      safeOrdinal(value.eventOrdinal) && safeOrdinal(value.confirmationSeq) &&
      safeOrdinal(value.lastConfirmedRequestOrdinal) && value.confirmationSeq <= value.eventOrdinal &&
      value.lastConfirmedRequestOrdinal <= value.eventOrdinal &&
      (value.confirmationSeq === 0) === (value.lastConfirmedRequestOrdinal === 0) &&
      Array.isArray(value.requests) && value.requests.length <= 32 &&
      value.requests.every(ticket => isPlainObject(ticket) && hasExactFields(ticket, ticketFields) &&
        ticket.ownerId === ownerId && ticket.bindingId === bindingId && ticket.articleId === articleId &&
        uuid(ticket.observationId) && safeOrdinal(ticket.requestEventOrdinal) &&
        ticket.requestEventOrdinal > 0 && ticket.requestEventOrdinal <= value.eventOrdinal) &&
      new Set(value.requests.map(ticket => ticket.observationId)).size === value.requests.length &&
      new Set(value.requests.map(ticket => ticket.requestEventOrdinal)).size === value.requests.length;
  }

  function validConfirmation(value, ownerId, bindingId, articleId) {
    return isPlainObject(value) && hasExactFields(value, confirmationFields) &&
      value.ownerId === ownerId && value.bindingId === bindingId && value.articleId === articleId &&
      safeOrdinal(value.confirmationSeq) && value.confirmationSeq > 0 &&
      safeOrdinal(value.requestEventOrdinal) && value.requestEventOrdinal > 0 &&
      uuid(value.observationId) && value.source === "current-snapshot" &&
      Boolean(progressCausal().normalizeParent(value.context)) &&
      window.LingoFlowArticleSyncCloudProtocol?.cursorNumber(value.snapshotCursor, false) != null &&
      typeof value.snapshotCursor === "string";
  }

  async function readEvidenceClock(tx, ownerId, bindingId, articleId, sidecar) {
    const raw = await requestResult(tx.objectStore(CONTROL_STORE)
      .get(evidenceKey(ownerId, bindingId, articleId)));
    const confirmation = sidecar?.serverContextConfirmation;
    if ((raw && !validEvidenceClock(raw, ownerId, bindingId, articleId)) ||
        (confirmation != null && (!validConfirmation(confirmation, ownerId, bindingId, articleId) ||
          !raw || confirmation.confirmationSeq !== raw.confirmationSeq ||
          confirmation.requestEventOrdinal !== raw.lastConfirmedRequestOrdinal))) {
      return { status: "malformed-confirmation-evidence" };
    }
    return { status: "ready", exists: Boolean(raw), clock: raw || { key: evidenceKey(ownerId, bindingId, articleId),
      kind: "article-context-evidence", ownerId, bindingId, articleId,
      eventOrdinal: 0, confirmationSeq: 0, lastConfirmedRequestOrdinal: 0, requests: [] } };
  }

  const evidenceScopeCurrent = (ownerId, guard) => authenticatedProgressOwner(ownerId) &&
    (guard == null || (typeof guard === "function" && guard() === true));

  async function evidenceWorkspaceStable() {
    const library = window.LingoFlowArticleLibrary;
    if (typeof library?.getWorkspaceTransition !== "function") return false;
    try { return !await library.getWorkspaceTransition(); } catch { return false; }
  }

  async function beginArticleServerContextObservation(ownerId, bindingId, articleId, guard) {
    if (![ownerId, bindingId, articleId].every(isOpaqueString) || !evidenceScopeCurrent(ownerId, guard) ||
        !await evidenceWorkspaceStable()) {
      return { status: "blocked", reason: "scope-mismatch" };
    }
    return runTransaction([CONTROL_STORE, ARTICLE_SIDECAR_STORE], "readwrite", async tx => {
      const control = tx.objectStore(CONTROL_STORE);
      const binding = await requireBinding(control, ownerId, bindingId);
      if (binding.status !== "ready") return binding;
      const sidecar = await requestResult(tx.objectStore(ARTICLE_SIDECAR_STORE).get([ownerId, articleId]));
      if (sidecar?.bindingId !== bindingId || !progressCausal().revision(sidecar.knownRevision)) {
        return { status: "parent-cloud-identity-missing" };
      }
      const read = await readEvidenceClock(tx, ownerId, bindingId, articleId, sidecar);
      if (read.status !== "ready") return read;
      if (read.clock.eventOrdinal === Number.MAX_SAFE_INTEGER) return { status: "evidence-counter-exhausted" };
      if (!evidenceScopeCurrent(ownerId, guard)) return { status: "blocked", reason: "scope-mismatch" };
      const ticket = { ownerId, bindingId, articleId, observationId: crypto.randomUUID(),
        requestEventOrdinal: read.clock.eventOrdinal + 1 };
      // Bound abandoned requests after crash. Evicted old responses fail closed;
      // neither durable counter is reset and no discarded request can confirm.
      await requestResult(control.put({ ...read.clock, eventOrdinal: ticket.requestEventOrdinal,
        requests: [...read.clock.requests, ticket].slice(-32) }));
      if (!evidenceScopeCurrent(ownerId, guard)) { tx.abort(); return { status: "blocked", reason: "scope-mismatch" }; }
      return { status: "ready", ticket };
    });
  }

  async function discardArticleServerContextObservation(ticket) {
    if (!ticket || !hasExactFields(ticket, ticketFields)) return { status: "invalid-observation-ticket" };
    return runTransaction([CONTROL_STORE], "readwrite", async tx => {
      const { ownerId, bindingId, articleId } = ticket;
      const store = tx.objectStore(CONTROL_STORE);
      const binding = await requireBinding(store, ownerId, bindingId);
      if (binding.status !== "ready") return binding;
      const raw = await requestResult(store.get(evidenceKey(ownerId, bindingId, articleId)));
      if (!validEvidenceClock(raw, ownerId, bindingId, articleId)) return { status: "malformed-confirmation-evidence" };
      await requestResult(store.put({ ...raw, requests: raw.requests.filter(item =>
        !sameProgressFact(item, ticket)) }));
      return { status: "discarded" };
    });
  }

  async function recordArticleServerContextConfirmation(ticket, snapshot, guard) {
    if (!ticket || !hasExactFields(ticket, ticketFields) || !evidenceScopeCurrent(ticket.ownerId, guard) ||
        !await evidenceWorkspaceStable()) {
      return { status: "blocked", reason: "scope-mismatch" };
    }
    const { ownerId, bindingId, articleId } = ticket;
    // Validate the actual normalized current-snapshot result, not a detached
    // context copied from a receipt/pull. The producer owns the request ticket.
    const protocol = window.LingoFlowArticleSyncCloudProtocol;
    const checked = protocol?.validateSnapshotResult({ ...snapshot,
      readingEpoch: snapshot?.serverReadingContext?.readingEpoch,
      contentFingerprint: snapshot?.serverReadingContext?.contentFingerprint }, articleId);
    const next = progressCausal().normalizeParent(snapshot?.serverReadingContext);
    if (!checked || checked.status !== "found" || !next ||
        !progressCausal().same(next, checked.serverReadingContext)) return { status: "invalid-current-snapshot" };
    if (await window.LingoFlowReadingResume.fingerprintContent(checked.projection.content) !== next.contentFingerprint) {
      return { status: "invalid-current-snapshot" };
    }
    return runTransaction([CONTROL_STORE, ARTICLE_SIDECAR_STORE], "readwrite", async tx => {
      const control = tx.objectStore(CONTROL_STORE);
      const binding = await requireBinding(control, ownerId, bindingId);
      if (binding.status !== "ready") return binding;
      const store = tx.objectStore(ARTICLE_SIDECAR_STORE);
      const sidecar = await requestResult(store.get([ownerId, articleId]));
      if (sidecar?.bindingId !== bindingId || !progressCausal().revision(sidecar.knownRevision)) {
        return { status: "parent-cloud-identity-missing" };
      }
      const read = await readEvidenceClock(tx, ownerId, bindingId, articleId, sidecar);
      if (read.status !== "ready") return read;
      // Validation/hashing and queued transactions can outlive the captured
      // generation. Diagnostics are durable writes too, not an exception to it.
      if (!evidenceScopeCurrent(ownerId, guard)) return { status: "blocked", reason: "scope-mismatch" };
      if (!read.clock.requests.some(item => sameProgressFact(item, ticket))) {
        const prior = sidecar.serverContextConfirmation;
        if (prior?.observationId !== ticket.observationId ||
            prior.requestEventOrdinal !== ticket.requestEventOrdinal) return { status: "unknown-observation-ticket" };
        if (progressCausal().same(prior.context, next) && prior.snapshotCursor === checked.cursor) {
          return { status: "unchanged" };
        }
        // A replay of one observation cannot introduce different canonical facts.
        // Keep the original proof/counter and stop using its parent as trusted.
        if (!evidenceScopeCurrent(ownerId, guard)) return { status: "blocked", reason: "scope-mismatch" };
        await requestResult(store.put({ ...sidecar,
          serverReadingContextDiagnostic: { reason: "inconsistent-current-observation" } }));
        if (!evidenceScopeCurrent(ownerId, guard)) { tx.abort(); return { status: "blocked", reason: "scope-mismatch" }; }
        return { status: "contradictory-current-snapshot" };
      }
      const previous = progressCausal().normalizeParent(sidecar.serverReadingContext);
      if (sidecar.serverReadingContext != null && !previous) return { status: "malformed-parent-context" };
      if (progressCausal().ordinal(next.articleRevision) < progressCausal().ordinal(sidecar.knownRevision) ||
          (previous && progressCausal().ordinal(next.articleRevision) < progressCausal().ordinal(previous.articleRevision))) {
        return { status: "stale-parent-context" };
      }
      if ((previous?.articleRevision === next.articleRevision && !progressCausal().same(previous, next)) ||
          (next.articleRevision === sidecar.knownRevision && sidecar.lastSyncedLifecycle &&
            sidecar.lastSyncedLifecycle !== next.lifecycle) ||
          (previous?.readingEpoch === next.readingEpoch &&
            (previous.contentFingerprint !== next.contentFingerprint || previous.lifecycle !== next.lifecycle))) {
        await requestResult(store.put({ ...sidecar,
          serverReadingContextDiagnostic: { reason: "inconsistent-parent-context" } }));
        if (!evidenceScopeCurrent(ownerId, guard)) { tx.abort(); return { status: "blocked", reason: "scope-mismatch" }; }
        return { status: "inconsistent-parent-context" };
      }
      if (sidecar.serverReadingContextDiagnostic && previous?.articleRevision === next.articleRevision) {
        return { status: "parent-context-diagnostic" };
      }
      // Request order only disqualifies freshness, not the returned server fact:
      // the caller can still ingest it through the ordinary Article boundary.
      if (ticket.requestEventOrdinal <= read.clock.lastConfirmedRequestOrdinal) {
        return { status: "stale-observation-ticket" };
      }
      if (read.clock.confirmationSeq === Number.MAX_SAFE_INTEGER) return { status: "evidence-counter-exhausted" };
      if (!evidenceScopeCurrent(ownerId, guard)) return { status: "blocked", reason: "scope-mismatch" };
      const confirmation = { ownerId, bindingId, articleId,
        confirmationSeq: read.clock.confirmationSeq + 1, observationId: ticket.observationId,
        source: "current-snapshot", requestEventOrdinal: ticket.requestEventOrdinal,
        context: next, snapshotCursor: checked.cursor };
      await requestResult(store.put({ ...sidecar, serverReadingContext: next,
        serverReadingContextDiagnostic: null, serverContextConfirmation: confirmation }));
      await requestResult(control.put({ ...read.clock, confirmationSeq: confirmation.confirmationSeq,
        lastConfirmedRequestOrdinal: ticket.requestEventOrdinal,
        requests: read.clock.requests.filter(item => item.observationId !== ticket.observationId) }));
      if (!evidenceScopeCurrent(ownerId, guard)) { tx.abort(); return { status: "blocked", reason: "scope-mismatch" }; }
      return { status: "confirmed", confirmation };
    });
  }

  function progressObservationResult(record, ownerId, bindingId, articleId) {
    const observation = progressCausal().observationFromRecord(record, ownerId, bindingId, articleId);
    return observation ? { status: "ready", observation, diagnostic: record?.diagnostic || null }
      : { status: "malformed-observation" };
  }

  async function getProgressRemoteObservation(ownerId, bindingId, articleId) {
    return runTransaction([CONTROL_STORE, PROGRESS_OBSERVATIONS_STORE], "readonly", async tx => {
      const binding = await requireBinding(tx.objectStore(CONTROL_STORE), ownerId, bindingId);
      if (binding.status !== "ready") return binding;
      const record = await requestResult(tx.objectStore(PROGRESS_OBSERVATIONS_STORE).get([ownerId, bindingId, articleId]));
      return progressObservationResult(record, ownerId, bindingId, articleId);
    });
  }

  async function listProgressRemoteObservations(ownerId, bindingId) {
    return runTransaction([CONTROL_STORE, PROGRESS_OBSERVATIONS_STORE], "readonly", async tx => {
      const binding = await requireBinding(tx.objectStore(CONTROL_STORE), ownerId, bindingId);
      if (binding.status !== "ready") return binding;
      const records = await requestResult(tx.objectStore(PROGRESS_OBSERVATIONS_STORE)
        .getAll(progressScopeRange(ownerId, bindingId)));
      if (records.some(record => !progressCausal().observationFromRecord(record, ownerId, bindingId, record.articleId))) {
        return { status: "malformed-observation" };
      }
      return { status: "ready", records };
    });
  }

  // No production caller supplies completion evidence in B3-2A. A missing row is UNKNOWN.
  // This transaction cannot patch desired/pending: those stores are intentionally absent.
  async function recordProgressRemoteObservation(ownerId, bindingId, articleId, value) {
    const causal = progressCausal();
    const next = causal.normalizeObservation(value);
    if (!isOpaqueString(ownerId) || !isOpaqueString(bindingId) || !isOpaqueString(articleId) ||
        !next || next.kind === "unknown") return { status: "invalid-observation" };
    return runTransaction([CONTROL_STORE, PROGRESS_OBSERVATIONS_STORE], "readwrite", async tx => {
      const binding = await requireBinding(tx.objectStore(CONTROL_STORE), ownerId, bindingId);
      if (binding.status !== "ready") return binding;
      return writeProgressObservation(tx, ownerId, bindingId, articleId, next);
    });
  }

  // Shared transaction-local monotonic writer. Settlement must never call the
  // public observation API in a second transaction.
  async function writeProgressObservation(tx, ownerId, bindingId, articleId, next) {
    const causal = progressCausal();
    const store = tx.objectStore(PROGRESS_OBSERVATIONS_STORE);
    const record = await requestResult(store.get([ownerId, bindingId, articleId]));
    const previous = causal.observationFromRecord(record, ownerId, bindingId, articleId);
    if (!previous) return { status: "malformed-observation" };
    const decision = causal.observationDecision(previous, next);
    if (decision === "write") {
      await requestResult(store.put({ ownerId, bindingId, articleId, ...next }));
      return { status: "recorded", observation: next };
    }
    if (["inconsistent-observation", "absence-after-revision"].includes(decision)) {
      await requestResult(store.put({ ...record, diagnostic: { reason: decision } }));
    }
    return { status: decision, observation: previous, diagnostic: record?.diagnostic || null };
  }

  async function recordArticleServerReadingContext(ownerId, bindingId, articleId, value) {
    const causal = progressCausal();
    const next = causal.normalizeParent(value);
    if (!next) return { status: "invalid-parent-context" };
    return runTransaction([CONTROL_STORE, ARTICLE_SIDECAR_STORE], "readwrite", async tx => {
      const binding = await requireBinding(tx.objectStore(CONTROL_STORE), ownerId, bindingId);
      if (binding.status !== "ready") return binding;
      const store = tx.objectStore(ARTICLE_SIDECAR_STORE);
      const sidecar = await requestResult(store.get([ownerId, articleId]));
      if (!sidecar || sidecar.bindingId !== bindingId || !causal.revision(sidecar.knownRevision)) {
        return { status: "parent-cloud-identity-missing" };
      }
      const previous = causal.normalizeParent(sidecar.serverReadingContext);
      if (sidecar.serverReadingContext != null && !previous) return { status: "malformed-parent-context" };
      if (causal.ordinal(next.articleRevision) < causal.ordinal(sidecar.knownRevision) ||
          (previous && causal.ordinal(next.articleRevision) < causal.ordinal(previous.articleRevision))) {
        return { status: "stale-parent-context" };
      }
      const sameRevision = previous?.articleRevision === next.articleRevision;
      const knownLifecycleMismatch = next.articleRevision === sidecar.knownRevision &&
        sidecar.lastSyncedLifecycle && next.lifecycle !== sidecar.lastSyncedLifecycle;
      if ((sameRevision && !causal.same(previous, next)) || knownLifecycleMismatch ||
          (previous && previous.readingEpoch === next.readingEpoch &&
           (previous.contentFingerprint !== next.contentFingerprint || previous.lifecycle !== next.lifecycle))) {
        await requestResult(store.put({ ...sidecar,
          serverReadingContextDiagnostic: { reason: "inconsistent-parent-context" } }));
        return { status: "inconsistent-parent-context" };
      }
      if (sameRevision) return { status: "unchanged" };
      // Observing context must not acknowledge Article WAL/projection settlement.
      await requestResult(store.put({ ...sidecar, serverReadingContext: next, serverReadingContextDiagnostic: null }));
      return { status: "recorded", context: next };
    });
  }

  async function getArticleServerReadingContext(ownerId, bindingId, articleId) {
    return runTransaction([CONTROL_STORE, ARTICLE_SIDECAR_STORE], "readonly", async tx => {
      const binding = await requireBinding(tx.objectStore(CONTROL_STORE), ownerId, bindingId);
      if (binding.status !== "ready") return binding;
      const sidecar = await requestResult(tx.objectStore(ARTICLE_SIDECAR_STORE).get([ownerId, articleId]));
      if (sidecar && sidecar.bindingId !== bindingId) return blocked("workspace-binding-mismatch");
      return { status: "ready", context: progressCausal().trustedParent(sidecar),
        diagnostic: sidecar?.serverReadingContextDiagnostic || null };
    });
  }

  // Reused by advisory evaluation and atomic attempt preparation. This is a
  // coherent SyncDB snapshot, never a cross-DB send lease.
  async function readProgressCausalSnapshot(tx, ownerId, bindingId, articleId) {
      const control = tx.objectStore(CONTROL_STORE);
      const binding = await requireBinding(control, ownerId, bindingId);
      if (binding.status !== "ready") return binding;
      const record = await requestResult(tx.objectStore(PROGRESS_DESIRED_STORE).get([ownerId, bindingId, articleId]));
      if (record && !validProgressDesiredRecord(record, ownerId, bindingId, articleId)) return { status: "malformed-progress-record" };
      const rawObservation = await requestResult(tx.objectStore(PROGRESS_OBSERVATIONS_STORE).get([ownerId, bindingId, articleId]));
      const observed = progressObservationResult(rawObservation, ownerId, bindingId, articleId);
      if (observed.status !== "ready") return observed;
      const sidecar = await requestResult(tx.objectStore(ARTICLE_SIDECAR_STORE).get([ownerId, articleId]));
      if (sidecar && sidecar.bindingId !== bindingId) return blocked("workspace-binding-mismatch");
      const evidence = await readEvidenceClock(tx, ownerId, bindingId, articleId, sidecar);
      if (evidence.status !== "ready") return evidence;
      const bootstrap = await requestResult(control.get(articleBootstrapStateKey(ownerId, bindingId)));
      let bootstrapSafe = false;
      try {
        validateArticleBootstrapState(bootstrap);
        bootstrapSafe = bootstrap.status === "complete" && bootstrap.phase === "complete" &&
          bootstrap.ownerId === ownerId && bootstrap.bindingId === bindingId && isArticleCursor(bootstrap.finalCursor) &&
          bootstrap.issueCount === 0 && bootstrap.pendingCursor === null && !bootstrap.pendingHasMore;
      } catch { /* Missing/malformed bootstrap is never ready. */ }
      const conflicts = await readArticleConflictEntries(control, ownerId, bindingId, articleId);
      const mutations = await requestResult(tx.objectStore(ARTICLE_OUTBOX_STORE).index("byOwnerBinding")
        .getAll(IDBKeyRange.only([ownerId, bindingId])));
      const controls = await requestResult(control.getAll());
      const parentApplyPending = controls.some(item => item.ownerId === ownerId && item.bindingId === bindingId &&
        item.articleId === articleId && ["article-runtime-pending-change", "article-bootstrap-pending-change"].includes(item.kind));
      return { status: "ready", record: compatibleProgressRecord(record), sidecar,
        observation: observed.observation, observationDiagnostic: observed.diagnostic,
        bootstrapSafe, hasConflict: conflicts.length > 0,
        hasMutation: parentApplyPending || mutations.some(item => item.articleId === articleId) };
  }

  async function getProgressCausalSnapshot(ownerId, bindingId, articleId) {
    return runTransaction([CONTROL_STORE, PROGRESS_DESIRED_STORE, PROGRESS_OBSERVATIONS_STORE,
      ARTICLE_SIDECAR_STORE, ARTICLE_OUTBOX_STORE], "readonly", tx => {
      return readProgressCausalSnapshot(tx, ownerId, bindingId, articleId);
    });
  }

  function compatibleProgressRecord(record) {
    if (!record) return null;
    const next = { ...record };
    for (const field of ["pending", "confirmed"]) {
      if (record[field]) next[field] = { ...record[field], causalBase: progressCausal().normalizeBase(record[field].causalBase) };
    }
    return next;
  }

  // Progress is an owner-scoped latest-intent register, not an Article mutation lane.
  // The sequence is allocated in this transaction, so tabs share one ordering source.
  function validProgressDesiredRecord(record, ownerId, bindingId, articleId = null) {
    if (!record || record.ownerId !== ownerId || record.bindingId !== bindingId ||
        typeof record.articleId !== "string" || !record.articleId ||
        (articleId !== null && record.articleId !== articleId) ||
        !Number.isSafeInteger(record.localSeq) || record.localSeq < 1) return false;
    const normalize = window.LingoFlowReadingResume?.normalizeCheckpoint;
    const pending = record.pending;
    if (pending !== null && pending !== undefined &&
        (typeof pending !== "object" || !pending.actionId ||
         pending.localSeq !== record.localSeq || pending.articleId !== record.articleId ||
         pending.ownerId !== ownerId || pending.bindingId !== bindingId ||
         !normalize?.(pending.target) || !pending.scope?.scopeToken ||
         !pending.articleFence?.lifecycleToken)) return false;
    const confirmed = record.confirmed;
    if (confirmed !== null && confirmed !== undefined &&
        (!normalize?.(confirmed.checkpoint) || !confirmed.fence?.lifecycleToken ||
         !confirmed.fence.action?.actionId)) return false;
    if ((pending && !progressCausal().normalizeBase(pending.causalBase)) ||
        (confirmed && !progressCausal().normalizeBase(confirmed.causalBase))) return false;
    return true;
  }

  async function prepareProgressMovement(value) {
    const { ownerId, bindingId, articleId, target, beforeResume, articleFence, scope } = value || {};
    const normalize = window.LingoFlowReadingResume?.normalizeCheckpoint;
    const checkpoint = normalize?.(target);
    const before = beforeResume === null ? null : normalize?.(beforeResume);
    if (!ownerId || !bindingId || !articleId || !checkpoint ||
        scope?.ownerId !== ownerId || scope?.bindingId !== bindingId ||
        !scope?.scopeToken || !articleFence?.lifecycleToken ||
        !Number.isInteger(articleFence.resumeRevision) ||
        (beforeResume !== null && !before)) throw new Error("Progress movement 无效。");
    return runTransaction([CONTROL_STORE, PROGRESS_DESIRED_STORE, PROGRESS_OBSERVATIONS_STORE,
      ARTICLE_SIDECAR_STORE], "readwrite", async tx => {
      const binding = await requireBinding(tx.objectStore(CONTROL_STORE), ownerId, bindingId);
      if (binding.status !== "ready") return binding;
      const store = tx.objectStore(PROGRESS_DESIRED_STORE);
      const key = [ownerId, bindingId, articleId];
      const previous = await requestResult(store.get(key));
      if (previous && !validProgressDesiredRecord(previous, ownerId, bindingId, articleId)) {
        return { status: "malformed-progress-record" };
      }
      const rawObservation = await requestResult(tx.objectStore(PROGRESS_OBSERVATIONS_STORE).get(key));
      const observed = progressObservationResult(rawObservation, ownerId, bindingId, articleId);
      const sidecar = await requestResult(tx.objectStore(ARTICLE_SIDECAR_STORE).get([ownerId, articleId]));
      const causalBase = progressCausal().captureBase(
        observed.status === "ready" && !observed.diagnostic ? observed.observation : null,
        sidecar?.bindingId === bindingId ? sidecar : null);
      const localSeq = (previous?.localSeq || 0) + 1;
      const pending = {
        actionId: window.crypto.randomUUID(), localSeq, articleId, ownerId, bindingId,
        target: checkpoint, beforeResume: before,
        contentFingerprint: checkpoint.contentFingerprint,
        scope, articleFence, causalBase
      };
      const record = {
        ownerId, bindingId, articleId, localSeq,
        confirmed: compatibleProgressRecord(previous)?.confirmed || null,
        pending,
        quarantined: previous?.quarantined || null
      };
      await requestResult(store.put(record));
      return { status: "prepared", pending, record };
    });
  }

  async function getProgressDesired(ownerId, bindingId, articleId) {
    return runTransaction([CONTROL_STORE, PROGRESS_DESIRED_STORE], "readonly", async tx => {
      const binding = await requireBinding(tx.objectStore(CONTROL_STORE), ownerId, bindingId);
      if (binding.status !== "ready") return binding;
      const record = await requestResult(tx.objectStore(PROGRESS_DESIRED_STORE)
        .get([ownerId, bindingId, articleId]));
      if (record && !validProgressDesiredRecord(record, ownerId, bindingId, articleId)) {
        return { status: "malformed-progress-record" };
      }
      return { status: "ready", record: compatibleProgressRecord(record) };
    });
  }

  async function listProgressDesired(ownerId, bindingId) {
    return runTransaction([CONTROL_STORE, PROGRESS_DESIRED_STORE], "readonly", async tx => {
      const binding = await requireBinding(tx.objectStore(CONTROL_STORE), ownerId, bindingId);
      if (binding.status !== "ready") return binding;
      const range = IDBKeyRange.bound([ownerId, bindingId, ""], [ownerId, bindingId, "\uffff"]);
      const records = await requestResult(tx.objectStore(PROGRESS_DESIRED_STORE).getAll(range));
      return { status: "ready", records: records.filter(record =>
        validProgressDesiredRecord(record, ownerId, bindingId)).map(compatibleProgressRecord),
      malformedCount: records.filter(record =>
        !validProgressDesiredRecord(record, ownerId, bindingId)).length };
    });
  }

  async function settleProgressMovement(ownerId, bindingId, articleId, actionId, outcome,
    reason = null, articleFence = null) {
    if (!["promote", "quarantine"].includes(outcome)) throw new Error("Progress settlement 无效。");
    return runTransaction([CONTROL_STORE, PROGRESS_DESIRED_STORE], "readwrite", async tx => {
      const binding = await requireBinding(tx.objectStore(CONTROL_STORE), ownerId, bindingId);
      if (binding.status !== "ready") return binding;
      const store = tx.objectStore(PROGRESS_DESIRED_STORE);
      const record = await requestResult(store.get([ownerId, bindingId, articleId]));
      if (record && !validProgressDesiredRecord(record, ownerId, bindingId, articleId)) {
        return { status: "malformed-progress-record" };
      }
      if (!record?.pending || record.pending.actionId !== actionId) {
        return { status: "superseded", record: record || null };
      }
      if (outcome === "promote") {
        if (!articleFence || articleFence.action?.actionId !== actionId ||
            articleFence.action?.localSeq !== record.pending.localSeq) {
          return { status: "unverified-fence" };
        }
        record.confirmed = { checkpoint: record.pending.target, fence: articleFence,
          causalBase: progressCausal().normalizeBase(record.pending.causalBase) };
      }
      else record.quarantined = { pending: record.pending, reason: String(reason || "unsafe-replay") };
      record.pending = null;
      await requestResult(store.put(record));
      return { status: outcome === "promote" ? "confirmed" : "quarantined", record };
    });
  }

  const PROGRESS_ATTEMPT_STATUSES = new Set([
    "awaiting_postflight", "prepared", "may_have_sent", "blocked_before_dispatch", "superseded",
    "succeeded", "terminal", "settlement_attention"
  ]);
  const PROGRESS_REQUEST_FIELDS = new Set([
    "mutationId", "articleId", "expectedState", "expectedProgressRevision",
    "parentReadingEpoch", "contentFingerprint", "progress", "paragraphIndex"
  ]);
  const PROGRESS_ATTEMPT_FIELDS = new Set([
    "ownerId", "bindingId", "articleId", "attemptId", "cloudMutationId",
    "status", "reason", "sourceLocalSeq", "sourceActionId", "sourceCheckpoint",
    "sourceCausalBase", "sourceFence", "sourceScope", "request"
  ]);
  const PROGRESS_SETTLED_ATTEMPT_FIELDS = new Set([...PROGRESS_ATTEMPT_FIELDS, "settlement"]);
  const PROGRESS_TERMINAL_REASONS = new Set([
    "revision-mismatch", "parent-not-ready", "article-deleted", "parent-epoch-mismatch",
    "fingerprint-mismatch", "invalid-mutation", "invalid-checkpoint"
  ]);
  const PROGRESS_SETTLEMENT_ATTENTION_REASONS = new Set([
    "mutation-id-reuse", "owner-context-mismatch", "success-identity-mismatch",
    "conflict-identity-mismatch", "rejection-identity-mismatch",
    "conflicting-duplicate-result", "inconsistent-observation",
    "absence-after-revision", "malformed-observation", "invalid-observation"
  ]);
  const PROGRESS_CHECKPOINT_FIELDS = new Set([
    "progress", "paragraphIndex", "contentFingerprint", "updatedAt"
  ]);
  const PROGRESS_FENCE_FIELDS = new Set([
    "articleId", "lifecycleToken", "resumeRevision", "action"
  ]);
  const PROGRESS_FENCE_ACTION_FIELDS = new Set([
    "actionId", "localSeq", "ownerId", "bindingId", "scopeToken",
    "lifecycleToken", "contentFingerprint", "target"
  ]);
  const PROGRESS_SCOPE_FIELDS = new Set(["key", "ownerId", "bindingId", "scopeToken"]);
  const progressAttemptScope = (ownerId, bindingId, articleId) =>
    IDBKeyRange.only([ownerId, bindingId, articleId]);
  const sameProgressFact = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const uuid = value => typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

  function malformedProgressAttempt() {
    // Do not log request, ID, owner, or credentials. A possibly-sent corrupt
    // row is a high-severity stop, not permission to create another attempt.
    console.error("High-severity Progress cloud attempt corruption; dispatch is blocked.");
    return { status: "malformed-attempt", severity: "high" };
  }
  const authenticatedProgressOwner = ownerId => {
    const auth = window.LingoFlowSupabaseAuth?.getState();
    return auth?.status === "authenticated" && auth.user?.id === ownerId;
  };

  function validProgressCloudAttempt(value, ownerId, bindingId, articleId) {
    const normalize = window.LingoFlowReadingResume?.normalizeCheckpoint;
    const request = value?.request;
    const final = ["succeeded", "terminal", "settlement_attention"].includes(value?.status);
    const result = window.LingoFlowProgressCloudResult;
    const settled = !final ? true : value.status === "succeeded"
      ? isPlainObject(value.settlement) &&
        hasExactFields(value.settlement, new Set(["result", "localCoverageAtSettlement"])) &&
        ["covered", "advanced", "unknown"].includes(value.settlement.localCoverageAtSettlement) &&
        result?.parse(value.settlement.result, request).status === "success"
      : value.status === "terminal"
        ? isPlainObject(value.settlement) &&
          hasExactFields(value.settlement, new Set(["reason", "currentRevisionHint", "currentCursorHint",
            ...(Object.hasOwn(value.settlement, "parentRejection") ? ["parentRejection"] : [])])) &&
          (!Object.hasOwn(value.settlement, "parentRejection") ||
            validParentRejection(value.settlement.parentRejection, value)) &&
          PROGRESS_TERMINAL_REASONS.has(value.reason) &&
          value.settlement.reason === value.reason &&
          (value.settlement.currentRevisionHint === null ||
            progressCausal().revision(value.settlement.currentRevisionHint)) &&
          (value.settlement.currentCursorHint === null ||
            /^cursor:[1-9][0-9]*$/.test(value.settlement.currentCursorHint)) &&
          (value.reason === "revision-mismatch"
            ? (value.settlement.currentRevisionHint === null) ===
              (value.settlement.currentCursorHint === null)
            : value.settlement.currentRevisionHint === null &&
              value.settlement.currentCursorHint === null)
        : isPlainObject(value.settlement) &&
          hasExactFields(value.settlement, new Set(["reason", "priorResult",
            ...(Object.hasOwn(value.settlement, "facts") ? ["facts"] : [])])) &&
          (!Object.hasOwn(value.settlement, "facts") ||
            result?.validAttentionFacts(value.settlement.facts, value.reason)) &&
          PROGRESS_SETTLEMENT_ATTENTION_REASONS.has(value.reason) &&
          value.settlement.reason === value.reason &&
          (value.reason === "conflicting-duplicate-result"
            ? result?.parse(value.settlement.priorResult, request).status === "success"
            : value.settlement.priorResult === null);
    return isPlainObject(value) && hasExactFields(value, final
      ? PROGRESS_SETTLED_ATTEMPT_FIELDS : PROGRESS_ATTEMPT_FIELDS) && settled &&
      value.ownerId === ownerId && value.bindingId === bindingId && value.articleId === articleId &&
      uuid(value.attemptId) && uuid(value.cloudMutationId) &&
      value.attemptId !== value.cloudMutationId &&
      PROGRESS_ATTEMPT_STATUSES.has(value.status) &&
      (["awaiting_postflight", "prepared", "may_have_sent", "succeeded"].includes(value.status)
        ? value.reason === null : isOpaqueString(value.reason)) &&
      Number.isSafeInteger(value.sourceLocalSeq) && value.sourceLocalSeq > 0 &&
      isOpaqueString(value.sourceActionId) &&
      value.sourceActionId !== value.cloudMutationId &&
      isPlainObject(value.sourceCheckpoint) &&
      hasExactFields(value.sourceCheckpoint, PROGRESS_CHECKPOINT_FIELDS) &&
      Boolean(normalize?.(value.sourceCheckpoint)) &&
      Boolean(progressCausal().normalizeBase(value.sourceCausalBase)) &&
      isPlainObject(value.sourceFence) &&
      hasExactFields(value.sourceFence, PROGRESS_FENCE_FIELDS) &&
      value.sourceFence.articleId === articleId &&
      isPlainObject(value.sourceFence.action) &&
      hasExactFields(value.sourceFence.action, PROGRESS_FENCE_ACTION_FIELDS) &&
      isPlainObject(value.sourceFence.action.target) &&
      hasExactFields(value.sourceFence.action.target, PROGRESS_CHECKPOINT_FIELDS) &&
      sameProgressFact(value.sourceFence.action.target, value.sourceCheckpoint) &&
      value.sourceFence.action.actionId === value.sourceActionId &&
      value.sourceFence.action?.localSeq === value.sourceLocalSeq &&
      value.sourceFence.action?.ownerId === ownerId &&
      value.sourceFence.action?.bindingId === bindingId &&
      isOpaqueString(value.sourceFence.lifecycleToken) &&
      value.sourceFence.action.lifecycleToken === value.sourceFence.lifecycleToken &&
      value.sourceFence.action.contentFingerprint === value.sourceCheckpoint.contentFingerprint &&
      Number.isSafeInteger(value.sourceFence.resumeRevision) &&
      value.sourceFence.resumeRevision >= 0 &&
      isPlainObject(value.sourceScope) &&
      hasExactFields(value.sourceScope, PROGRESS_SCOPE_FIELDS) &&
      value.sourceScope.key === "workspace" && value.sourceScope.ownerId === ownerId &&
      value.sourceScope.bindingId === bindingId && isOpaqueString(value.sourceScope.scopeToken) &&
      value.sourceFence.action?.scopeToken === value.sourceScope.scopeToken &&
      isPlainObject(request) && hasExactFields(request, PROGRESS_REQUEST_FIELDS) &&
      request.mutationId === value.cloudMutationId && request.articleId === articleId &&
      request.expectedState === "revision" &&
      progressCausal().revision(request.expectedProgressRevision) &&
      uuid(request.parentReadingEpoch) &&
      /^sha256:[a-f0-9]{64}$/.test(request.contentFingerprint) &&
      typeof request.progress === "number" && Number.isFinite(request.progress) &&
      request.progress >= 0 && request.progress <= 1 &&
      Number.isInteger(request.paragraphIndex) && request.paragraphIndex >= 0 &&
      request.paragraphIndex <= 2147483647 &&
      request.progress === value.sourceCheckpoint.progress &&
      request.paragraphIndex === value.sourceCheckpoint.paragraphIndex &&
      request.contentFingerprint === value.sourceCheckpoint.contentFingerprint &&
      value.sourceCausalBase.kind === "revision" &&
      value.sourceCausalBase.revision === request.expectedProgressRevision &&
      value.sourceCausalBase.parent?.lifecycle === "active" &&
      value.sourceCausalBase.parent?.readingEpoch === request.parentReadingEpoch &&
      value.sourceCausalBase.parent?.contentFingerprint === request.contentFingerprint;
  }

  function validParentRejection(value, attempt) {
    return parentRejectionReasons.has(attempt.reason) && isPlainObject(value) &&
      hasExactFields(value, new Set(["confirmationSeqAtRejection", "rejectionEventOrdinal", "rejectedParent"])) &&
      (value.confirmationSeqAtRejection === null || safeOrdinal(value.confirmationSeqAtRejection)) &&
      safeOrdinal(value.rejectionEventOrdinal) && value.rejectionEventOrdinal > 0 &&
      sameProgressFact(value.rejectedParent, attempt.sourceCausalBase.parent);
  }

  function hasPostRejectionConfirmation(attempt, sidecar, parent) {
    const baseline = attempt.settlement.parentRejection;
    const evidence = sidecar?.serverContextConfirmation;
    return validParentRejection(baseline, attempt) &&
      validConfirmation(evidence, attempt.ownerId, attempt.bindingId, attempt.articleId) &&
      progressCausal().same(evidence.context, parent) &&
      evidence.confirmationSeq > (baseline.confirmationSeqAtRejection ?? 0) &&
      evidence.requestEventOrdinal > baseline.rejectionEventOrdinal;
  }

  function progressAttemptRefreshGate(attempts, observation, sidecar) {
    const causal = progressCausal();
    const parent = causal.trustedParent(sidecar);
    for (const attempt of attempts) {
      if (attempt.status === "settlement_attention") {
        return { status: "not-ready", reason: "progress-settlement-attention" };
      }
      if (attempt.status !== "terminal") continue;
      const reason = attempt.reason;
      if (reason === "revision-mismatch") {
        const hint = attempt.settlement.currentRevisionHint;
        if (observation.kind !== "revision" ||
            causal.ordinal(observation.revision) <= causal.ordinal(attempt.request.expectedProgressRevision) ||
            (hint && causal.ordinal(observation.revision) < causal.ordinal(hint))) {
          return { status: "not-ready", reason: "progress-refresh-required" };
        }
      }
      if (["parent-not-ready", "article-deleted", "parent-epoch-mismatch",
        "fingerprint-mismatch"].includes(reason)) {
        const frozen = attempt.sourceCausalBase.parent;
        // A title-only revision is not proof that the rejected parent context
        // changed. The old request can never be patched into a new attempt.
        const newEpoch = parent && frozen &&
          causal.ordinal(parent.articleRevision) > causal.ordinal(frozen.articleRevision) &&
          parent.readingEpoch !== frozen.readingEpoch;
        const refreshed = parent?.lifecycle === "active" &&
          (reason === "parent-not-ready" ? hasPostRejectionConfirmation(attempt, sidecar, parent)
            : reason === "article-deleted" ? newEpoch && hasPostRejectionConfirmation(attempt, sidecar, parent)
              : newEpoch);
        if (!refreshed) return { status: "not-ready", reason: "parent-refresh-required" };
      }
      if (reason === "invalid-mutation" || reason === "invalid-checkpoint") {
        return { status: "not-ready", reason: "progress-protocol-invariant" };
      }
    }
    return null;
  }

  // The transaction first records a non-dispatchable proposal. A separate
  // postflight and confirmation must complete before it becomes prepared.
  // The LibraryDB facts were checked before this transaction and must be
  // checked again afterwards; a future dispatcher must revalidate once more.
  async function prepareProgressCloudAttempt(ownerId, bindingId, articleId, local) {
    if (!authenticatedProgressOwner(ownerId)) return { status: "not-ready", reason: "scope-mismatch" };
    if (![ownerId, bindingId, articleId].every(isOpaqueString) ||
        !isPlainObject(local) || !isPlainObject(local.scope) || !isPlainObject(local.fence)) {
      return { status: "not-ready", reason: "invalid-local-preflight" };
    }
    return runTransaction([CONTROL_STORE, PROGRESS_DESIRED_STORE, PROGRESS_OBSERVATIONS_STORE,
      ARTICLE_SIDECAR_STORE, ARTICLE_OUTBOX_STORE, PROGRESS_ATTEMPTS_STORE], "readwrite", async tx => {
      const snapshot = await readProgressCausalSnapshot(tx, ownerId, bindingId, articleId);
      if (snapshot.status !== "ready") return { status: "not-ready", reason: snapshot.reason || snapshot.status };
      const confirmed = snapshot.record?.confirmed;
      const store = tx.objectStore(PROGRESS_ATTEMPTS_STORE);
      const previous = await requestResult(store.index("byScope")
        .getAll(progressAttemptScope(ownerId, bindingId, articleId)));
      if (previous.some(item => !validProgressCloudAttempt(item, ownerId, bindingId, articleId))) {
        return malformedProgressAttempt();
      }
      const unresolved = previous.find(item =>
        ["awaiting_postflight", "prepared", "may_have_sent", "settlement_attention"].includes(item.status));
      if (unresolved) return { status: "existing-attempt", attempt: unresolved };
      const refresh = progressAttemptRefreshGate(previous, snapshot.observation, snapshot.sidecar);
      if (refresh) return refresh;
      const fenceValid = Boolean(confirmed &&
        sameProgressFact(confirmed.fence, local.fence) &&
        sameProgressFact(confirmed.checkpoint, local.checkpoint) &&
        local.fence.action?.ownerId === ownerId &&
        local.fence.action?.bindingId === bindingId &&
        local.fence.action?.scopeToken === local.scope.scopeToken &&
        local.fence.action?.localSeq === snapshot.record.localSeq);
      const decision = progressCausal().evaluate({ ...snapshot,
        scopeValid: local.scope.ownerId === ownerId && local.scope.bindingId === bindingId &&
          isOpaqueString(local.scope.scopeToken),
        transitionInactive: local.transitionInactive === true,
        fenceValid,
        articleActive: local.articleActive === true,
        cloudEligible: local.cloudEligible === true,
        localFingerprint: local.fingerprint
      });
      if (decision.status !== "ready") return decision;
      // B3-3A has no production inventory/catch-up producer for trusted absent.
      if (decision.mode !== "update" || snapshot.observation.kind !== "revision") {
        return { status: "not-ready", reason: "create-path-disabled" };
      }
      const checkpoint = confirmed.checkpoint;
      if (!Number.isInteger(checkpoint.paragraphIndex) || checkpoint.paragraphIndex > 2147483647 ||
          !Number.isFinite(checkpoint.progress) || checkpoint.progress < 0 || checkpoint.progress > 1) {
        return { status: "not-ready", reason: "invalid-checkpoint" };
      }
      if (!window.crypto?.randomUUID) return { status: "not-ready", reason: "random-id-unavailable" };
      const attemptId = window.crypto.randomUUID();
      const cloudMutationId = window.crypto.randomUUID();
      const attempt = {
        ownerId, bindingId, articleId, attemptId, cloudMutationId,
        status: "awaiting_postflight", reason: null,
        sourceLocalSeq: snapshot.record.localSeq,
        sourceActionId: local.fence.action.actionId,
        sourceCheckpoint: { ...checkpoint },
        sourceCausalBase: confirmed.causalBase,
        sourceFence: local.fence,
        sourceScope: local.scope,
        request: {
          mutationId: cloudMutationId, articleId,
          expectedState: "revision",
          expectedProgressRevision: snapshot.observation.revision,
          parentReadingEpoch: confirmed.causalBase.parent.readingEpoch,
          contentFingerprint: checkpoint.contentFingerprint,
          progress: checkpoint.progress === 0 ? 0 : checkpoint.progress,
          paragraphIndex: checkpoint.paragraphIndex
        }
      };
      if (!validProgressCloudAttempt(attempt, ownerId, bindingId, articleId)) {
        return { status: "not-ready", reason: "invalid-attempt" };
      }
      await requestResult(store.add(attempt));
      return { status: "awaiting-postflight", attempt };
    });
  }

  async function confirmProgressCloudAttempt(ownerId, bindingId, articleId, attemptId, local) {
    if (!authenticatedProgressOwner(ownerId)) return { status: "not-ready", reason: "scope-mismatch" };
    return runTransaction([CONTROL_STORE, PROGRESS_DESIRED_STORE, PROGRESS_OBSERVATIONS_STORE,
      ARTICLE_SIDECAR_STORE, ARTICLE_OUTBOX_STORE, PROGRESS_ATTEMPTS_STORE], "readwrite", async tx => {
      const snapshot = await readProgressCausalSnapshot(tx, ownerId, bindingId, articleId);
      if (snapshot.status !== "ready") return { status: "not-ready", reason: snapshot.reason || snapshot.status };
      const store = tx.objectStore(PROGRESS_ATTEMPTS_STORE);
      const attempt = await requestResult(store.get([ownerId, bindingId, articleId, attemptId]));
      if (!authenticatedProgressOwner(ownerId)) return { status: "not-ready", reason: "scope-mismatch" };
      if (!attempt) return { status: "missing" };
      if (!validProgressCloudAttempt(attempt, ownerId, bindingId, articleId)) {
        return malformedProgressAttempt();
      }
      if (attempt.status === "prepared") return { status: "prepared", attempt };
      if (attempt.status !== "awaiting_postflight") return { status: "not-awaiting-postflight" };
      const confirmed = snapshot.record?.confirmed;
      const unchanged = confirmed && !snapshot.record.pending &&
        snapshot.record.localSeq === attempt.sourceLocalSeq &&
        confirmed.fence?.action?.actionId === attempt.sourceActionId &&
        sameProgressFact(confirmed.fence, attempt.sourceFence) &&
        sameProgressFact(confirmed.checkpoint, attempt.sourceCheckpoint) &&
        sameProgressFact(confirmed.causalBase, attempt.sourceCausalBase) &&
        snapshot.observation.kind === "revision" &&
        snapshot.observation.revision === attempt.request.expectedProgressRevision &&
        sameProgressFact(local?.fence, attempt.sourceFence) &&
        sameProgressFact(local?.scope, attempt.sourceScope) &&
        sameProgressFact(local?.checkpoint, attempt.sourceCheckpoint);
      const decision = unchanged ? progressCausal().evaluate({ ...snapshot,
        scopeValid: local.scope?.ownerId === ownerId && local.scope?.bindingId === bindingId,
        transitionInactive: local.transitionInactive === true,
        fenceValid: true, articleActive: local.articleActive === true,
        cloudEligible: local.cloudEligible === true, localFingerprint: local.fingerprint
      }) : { status: "not-ready", reason: "local-or-causal-state-changed" };
      if (decision.status !== "ready" || decision.mode !== "update") {
        const blocked = { ...attempt, status: "blocked_before_dispatch",
          reason: decision.reason || "create-path-disabled" };
        await requestResult(store.put(blocked));
        return { status: "not-ready", reason: blocked.reason, attempt: blocked };
      }
      const prepared = { ...attempt, status: "prepared" };
      await requestResult(store.put(prepared));
      return { status: "prepared", attempt: prepared };
    });
  }

  // Only an unconfirmed proposal may be rejected by a recovery postflight.
  // A concurrent tab may already have promoted it; never undo that result.
  async function rejectAwaitingProgressCloudAttempt(ownerId, bindingId, articleId, attemptId, reason) {
    if (!authenticatedProgressOwner(ownerId)) return { status: "not-ready", reason: "scope-mismatch" };
    if (!isOpaqueString(reason)) return { status: "invalid-reason" };
    return runTransaction([CONTROL_STORE, PROGRESS_ATTEMPTS_STORE], "readwrite", async tx => {
      const binding = await requireBinding(tx.objectStore(CONTROL_STORE), ownerId, bindingId);
      if (binding.status !== "ready") return binding;
      const store = tx.objectStore(PROGRESS_ATTEMPTS_STORE);
      const attempt = await requestResult(store.get([ownerId, bindingId, articleId, attemptId]));
      if (!authenticatedProgressOwner(ownerId)) return { status: "not-ready", reason: "scope-mismatch" };
      if (!attempt) return { status: "missing" };
      if (!validProgressCloudAttempt(attempt, ownerId, bindingId, articleId)) {
        return malformedProgressAttempt();
      }
      if (attempt.status !== "awaiting_postflight") return { status: attempt.status, attempt };
      const blocked = { ...attempt, status: "blocked_before_dispatch", reason };
      await requestResult(store.put(blocked));
      return { status: "blocked_before_dispatch", attempt: blocked };
    });
  }

  // The sole local send-authorization boundary. A LibraryDB snapshot is
  // rechecked by the caller immediately beforehand; this transaction then
  // serializes the attempt and all SyncDB causal gates before returning a
  // frozen request. There is intentionally no transport callback here.
  async function reserveProgressCloudAttemptForDispatch(ownerId, bindingId, articleId, attemptId) {
    if (!authenticatedProgressOwner(ownerId)) return { status: "not-ready", reason: "scope-mismatch" };
    // Do not accept a caller-supplied readiness flag or a previously captured
    // candidate. Even direct repository callers must perform LibraryDB phase 1.
    const library = window.LingoFlowArticleLibrary;
    const resume = window.LingoFlowReadingResume;
    const owner = { ownerId, bindingId };
    const context = await library.getProgressContext(articleId, owner, { initialize: false });
    if (context.status !== "ready") return { status: "not-ready", reason: context.status };
    const checkpoint = resume.normalizeCheckpoint(context.article.reading?.resume);
    if (!checkpoint) return { status: "not-ready", reason: "resume-missing" };
    const fingerprint = await resume.fingerprintContent(context.article.content);
    const verified = await library.getProgressContext(articleId, owner, { initialize: false });
    if (verified.status !== "ready" || !sameProgressFact(context, verified)) {
      return { status: "not-ready", reason: "local-revalidation-changed" };
    }
    const local = { scope: context.scope, fence: context.fence, checkpoint, fingerprint,
      articleActive: !context.article.deletedAt,
      cloudEligible: window.LingoFlowArticleSyncSize.validateArticleCloudSyncSize(context.article).status === "valid",
      transitionInactive: true };
    return runTransaction([CONTROL_STORE, PROGRESS_DESIRED_STORE, PROGRESS_OBSERVATIONS_STORE,
      ARTICLE_SIDECAR_STORE, ARTICLE_OUTBOX_STORE, PROGRESS_ATTEMPTS_STORE], "readwrite", async tx => {
      const snapshot = await readProgressCausalSnapshot(tx, ownerId, bindingId, articleId);
      if (snapshot.status !== "ready") return { status: "not-ready", reason: snapshot.reason || snapshot.status };
      const store = tx.objectStore(PROGRESS_ATTEMPTS_STORE);
      const attempt = await requestResult(store.get([ownerId, bindingId, articleId, attemptId]));
      if (!authenticatedProgressOwner(ownerId)) return { status: "not-ready", reason: "scope-mismatch" };
      if (!attempt) return { status: "missing" };
      if (!validProgressCloudAttempt(attempt, ownerId, bindingId, articleId)) {
        return malformedProgressAttempt();
      }
      if (attempt.status !== "prepared") return { status: "not-prepared", attemptStatus: attempt.status };
      const confirmed = snapshot.record?.confirmed;
      if (snapshot.record?.pending) return { status: "deferred-newer-pending" };
      if (confirmed && snapshot.record.localSeq > attempt.sourceLocalSeq &&
          confirmed.fence?.action?.localSeq === snapshot.record.localSeq) {
        const superseded = { ...attempt, status: "superseded", reason: "newer-confirmed" };
        await requestResult(store.put(superseded));
        return { status: "not-ready", reason: "newer-confirmed", attempt: superseded };
      }
      const unchanged = confirmed && snapshot.record.localSeq === attempt.sourceLocalSeq &&
        confirmed.fence?.action?.actionId === attempt.sourceActionId &&
        sameProgressFact(confirmed.fence, attempt.sourceFence) &&
        sameProgressFact(confirmed.checkpoint, attempt.sourceCheckpoint) &&
        sameProgressFact(confirmed.causalBase, attempt.sourceCausalBase) &&
        snapshot.observation.kind === "revision" &&
        snapshot.observation.revision === attempt.request.expectedProgressRevision &&
        sameProgressFact(local?.fence, attempt.sourceFence) &&
        sameProgressFact(local?.scope, attempt.sourceScope) &&
        sameProgressFact(local?.checkpoint, attempt.sourceCheckpoint) &&
        local?.fingerprint === attempt.request.contentFingerprint;
      const decision = unchanged ? progressCausal().evaluate({ ...snapshot,
        scopeValid: local.scope?.ownerId === ownerId && local.scope?.bindingId === bindingId,
        transitionInactive: local.transitionInactive === true,
        fenceValid: true, articleActive: local.articleActive === true,
        cloudEligible: local.cloudEligible === true, localFingerprint: local.fingerprint
      }) : { status: "not-ready", reason: "local-or-causal-state-changed" };
      if (decision.status !== "ready" || decision.mode !== "update") {
        const blocked = { ...attempt, status: "blocked_before_dispatch",
          reason: decision.reason || "create-path-disabled" };
        await requestResult(store.put(blocked));
        return { status: "not-ready", reason: blocked.reason, attempt: blocked };
      }
      const reserved = { ...attempt, status: "may_have_sent" };
      await requestResult(store.put(reserved));
      return { status: "may_have_sent", attemptId: reserved.attemptId,
        cloudMutationId: reserved.cloudMutationId,
        immutableRequest: Object.freeze({ ...reserved.request }) };
    });
  }

  async function readProgressLocalCoverage(ownerId, bindingId, articleId) {
    try {
      const library = window.LingoFlowArticleLibrary;
      const resume = window.LingoFlowReadingResume;
      const owner = { ownerId, bindingId };
      const first = await library.getProgressContext(articleId, owner, { initialize: false });
      if (first.status !== "ready") return { status: "unknown" };
      const checkpoint = resume.normalizeCheckpoint(first.article.reading?.resume);
      const fingerprint = await resume.fingerprintContent(first.article.content);
      const second = await library.getProgressContext(articleId, owner, { initialize: false });
      if (second.status !== "ready" || !sameProgressFact(first, second) || !checkpoint) {
        return { status: "unknown" };
      }
      return { status: "ready", articleId, scope: first.scope, fence: first.fence,
        checkpoint, fingerprint, active: !first.article.deletedAt };
    } catch { return { status: "unknown" }; }
  }

  function exactProgressAttemptSource(record, attempt) {
    const confirmed = record?.confirmed;
    return Boolean(confirmed && record.localSeq === attempt.sourceLocalSeq &&
      confirmed.fence?.action?.actionId === attempt.sourceActionId &&
      sameProgressFact(confirmed.checkpoint, attempt.sourceCheckpoint) &&
      sameProgressFact(confirmed.fence, attempt.sourceFence) &&
      sameProgressFact(confirmed.causalBase, attempt.sourceCausalBase));
  }

  function canonicalProgressObservation(result) {
    return { kind: "revision", revision: result.revision, cursor: result.cursor,
      parentReadingEpoch: result.parentReadingEpoch,
      contentFingerprint: result.contentFingerprint,
      checkpoint: { progress: result.progress, paragraphIndex: result.paragraphIndex } };
  }

  // Explicit local settlement only: the caller supplies a received/mock value,
  // never a request. No transport is created or invoked in this module.
  async function settleProgressCloudResult(ownerId, bindingId, articleId, attemptId, rawResult, guard, expectedCloudMutationId) {
    const current = () => evidenceScopeCurrent(ownerId, guard);
    current.subscribe = guard?.subscribe;
    if (!current()) return { status: "not-ready", reason: "scope-mismatch" };
    if (!await evidenceWorkspaceStable()) return { status: "not-ready", reason: "workspace-transition" };
    const read = await getProgressCloudAttempt(ownerId, bindingId, articleId, attemptId);
    if (read.status !== "ready") return read;
    if (!current() || (expectedCloudMutationId !== undefined && read.attempt.cloudMutationId !== expectedCloudMutationId)) {
      return { status: "not-ready", reason: "scope-mismatch" };
    }
    const parser = window.LingoFlowProgressCloudResult;
    const parsed = parser.parse(rawResult, read.attempt.request);
    if (parsed.status === "unparseable" || parsed.status === "auth-paused") {
      return { status: parsed.status, attemptStatus: read.attempt.status };
    }
    const local = parsed.status === "success"
      ? await readProgressLocalCoverage(ownerId, bindingId, articleId) : null;
    if (!current()) return { status: "not-ready", reason: "scope-mismatch" };
    try { return await runTransaction([CONTROL_STORE, PROGRESS_ATTEMPTS_STORE, PROGRESS_DESIRED_STORE,
      PROGRESS_OBSERVATIONS_STORE, ARTICLE_SIDECAR_STORE], "readwrite", async tx => {
      const binding = await requireBinding(tx.objectStore(CONTROL_STORE), ownerId, bindingId);
      if (binding.status !== "ready" || !current()) {
        return { status: "not-ready", reason: "scope-mismatch" };
      }
      const store = tx.objectStore(PROGRESS_ATTEMPTS_STORE);
      const attempt = await requestResult(store.get([ownerId, bindingId, articleId, attemptId]));
      if (!attempt) return { status: "missing" };
      if (!validProgressCloudAttempt(attempt, ownerId, bindingId, articleId)) {
        return malformedProgressAttempt();
      }
      if (expectedCloudMutationId !== undefined && attempt.cloudMutationId !== expectedCloudMutationId) {
        return { status: "not-ready", reason: "attempt-identity-changed" };
      }
      const reparsed = parser.parse(rawResult, attempt.request);
      if (reparsed.status !== parsed.status ||
          !sameProgressFact(reparsed.result || reparsed, parsed.result || parsed)) {
        return { status: "unparseable" };
      }
      if (attempt.status === "succeeded") {
        if (parsed.status === "success" && sameProgressFact(attempt.settlement.result, parsed.result)) {
          return { status: "succeeded", idempotent: true, attempt };
        }
        const attention = { ...attempt, status: "settlement_attention",
          reason: "conflicting-duplicate-result", settlement: {
            reason: "conflicting-duplicate-result", priorResult: attempt.settlement.result } };
        await requestResult(store.put(attention));
        return { status: "settlement_attention", reason: attention.reason };
      }
      if (attempt.status === "settlement_attention") {
        const eligibility = await evaluateProgressReceiptRecoveryInTransaction(tx,
          ownerId, bindingId, articleId, attempt);
        if (eligibility.status !== "recoverable") return eligibility;
        // Reuse the ordinary settlement branch without rewriting/erasing the
        // attention record. No special recovered-result protocol exists.
      } else if (attempt.status !== "may_have_sent") {
        return { status: "not-settleable", attemptStatus: attempt.status };
      }
      if (parsed.status === "attention") {
        const attention = { ...attempt, status: "settlement_attention", reason: parsed.reason,
          settlement: { reason: parsed.reason, priorResult: null,
            ...(parsed.facts ? { facts: parsed.facts } : {}) } };
        await requestResult(store.put(attention));
        return { status: "settlement_attention", reason: parsed.reason };
      }
      if (parsed.status === "terminal") {
        let parentRejection;
        if (parentRejectionReasons.has(parsed.reason)) {
          const sidecar = await requestResult(tx.objectStore(ARTICLE_SIDECAR_STORE).get([ownerId, articleId]));
          const evidence = await readEvidenceClock(tx, ownerId, bindingId, articleId, sidecar);
          if (evidence.status !== "ready") return evidence;
          if (evidence.clock.eventOrdinal === Number.MAX_SAFE_INTEGER) return { status: "evidence-counter-exhausted" };
          parentRejection = {
            // null is a missing clock; zero is an initialized clock with no
            // confirmation. Malformed clocks cannot reach this transaction.
            confirmationSeqAtRejection: evidence.exists ? evidence.clock.confirmationSeq : null,
            rejectionEventOrdinal: evidence.clock.eventOrdinal + 1,
            rejectedParent: attempt.sourceCausalBase.parent
          };
          await requestResult(tx.objectStore(CONTROL_STORE).put({ ...evidence.clock,
            eventOrdinal: parentRejection.rejectionEventOrdinal }));
        }
        const terminal = { ...attempt, status: "terminal", reason: parsed.reason,
          settlement: { reason: parsed.reason,
            currentRevisionHint: parsed.currentRevisionHint || null,
            currentCursorHint: parsed.currentCursorHint || null,
            ...(parentRejection ? { parentRejection } : {}) } };
        await requestResult(store.put(terminal));
        return { status: "terminal", reason: parsed.reason };
      }
      const desiredStore = tx.objectStore(PROGRESS_DESIRED_STORE);
      const desired = await requestResult(desiredStore.get([ownerId, bindingId, articleId]));
      const validDesired = !desired || validProgressDesiredRecord(desired, ownerId, bindingId, articleId);
      const observed = await writeProgressObservation(tx, ownerId, bindingId, articleId,
        canonicalProgressObservation(parsed.result));
      if (["inconsistent-observation", "absence-after-revision", "malformed-observation",
        "invalid-observation"].includes(observed.status)) {
        const attention = { ...attempt, status: "settlement_attention",
          reason: observed.status, settlement: { reason: observed.status, priorResult: null } };
        await requestResult(store.put(attention));
        return { status: "settlement_attention", reason: observed.status };
      }
      const effectiveObservation = observed.status === "recorded"
        ? canonicalProgressObservation(parsed.result) : observed.observation;
      const sidecar = await requestResult(tx.objectStore(ARTICLE_SIDECAR_STORE)
        .get([ownerId, articleId]));
      const parent = sidecar?.bindingId === bindingId
        ? progressCausal().trustedParent(sidecar) : null;
      const sourceMatches = validDesired && exactProgressAttemptSource(desired, attempt);
      const candidate = { ...attempt, status: "succeeded", result: parsed.result };
      const evaluation = parser.evaluateCoverage({ attempt: candidate,
        desired: validDesired ? desired : null, observation: effectiveObservation, parent, local });
      const coverage = !validDesired || observed.diagnostic ||
        !["recorded", "unchanged"].includes(observed.status)
        ? "unknown" : ["local-advanced", "pending-local"].includes(evaluation)
          ? "advanced" : sourceMatches && evaluation === "covered" ? "covered" : "unknown";
      if (coverage === "covered" && !desired.pending && sourceMatches) {
        await requestResult(desiredStore.put({ ...desired, confirmed: null }));
      }
      const succeeded = { ...attempt, status: "succeeded", reason: null,
        settlement: { result: parsed.result, localCoverageAtSettlement: coverage } };
      await requestResult(store.put(succeeded));
      return { status: "succeeded", resultStatus: parsed.result.status,
        localCoverageAtSettlement: coverage, observationStatus: observed.status };
    }, current); } catch (error) {
      if (error?.code === "progress-scope-changed" || !current()) {
        return { status: "not-ready", reason: "scope-mismatch" };
      }
      throw error;
    }
  }

  async function evaluateProgressReceiptRecoveryInTransaction(tx, ownerId, bindingId, articleId, attempt) {
    if (!authenticatedProgressOwner(ownerId)) return { status: "blocked", reason: "scope-mismatch" };
    const eligibility = window.LingoFlowProgressCloudResult.evaluateReceiptRecovery(attempt);
    if (eligibility.status !== "recoverable") return eligibility;
    const attempts = await requestResult(tx.objectStore(PROGRESS_ATTEMPTS_STORE).index("byScope")
      .getAll(progressAttemptScope(ownerId, bindingId, articleId)));
    if (attempts.some(item => !validProgressCloudAttempt(item, ownerId, bindingId, articleId))) {
      return malformedProgressAttempt();
    }
    if (attempts.some(item => item.attemptId !== attempt.attemptId &&
        ["awaiting_postflight", "prepared", "may_have_sent", "settlement_attention"].includes(item.status))) {
      return { status: "blocked", reason: "scope-occupied" };
    }
    const record = await requestResult(tx.objectStore(PROGRESS_OBSERVATIONS_STORE).get([ownerId, bindingId, articleId]));
    const observation = progressObservationResult(record, ownerId, bindingId, articleId);
    if (observation.status !== "ready" || observation.diagnostic) {
      return { status: "blocked", reason: "local-authority-contradiction" };
    }
    return authenticatedProgressOwner(ownerId) ? { status: "recoverable" }
      : { status: "blocked", reason: "scope-mismatch" };
  }

  function frozenProgressCopy(value) {
    const copy = structuredClone(value);
    const freeze = item => {
      if (item && typeof item === "object") { Object.values(item).forEach(freeze); Object.freeze(item); }
    };
    freeze(copy);
    return copy;
  }

  // Eligibility/read only. It never dispatches, mints an ID, rebases or replaces
  // the original frozen payload with today's desired. A future sender still
  // needs the existing captured-generation guard and final dispatch validation.
  async function prepareProgressReceiptRecovery(ownerId, bindingId, articleId, attemptId) {
    if (!authenticatedProgressOwner(ownerId) || !await evidenceWorkspaceStable()) {
      return { status: "blocked", reason: "scope-mismatch" };
    }
    return runTransaction([CONTROL_STORE, PROGRESS_ATTEMPTS_STORE, PROGRESS_OBSERVATIONS_STORE],
      "readonly", async tx => {
        const binding = await requireBinding(tx.objectStore(CONTROL_STORE), ownerId, bindingId);
        if (binding.status !== "ready") return binding;
        const attempt = await requestResult(tx.objectStore(PROGRESS_ATTEMPTS_STORE)
          .get([ownerId, bindingId, articleId, attemptId]));
        if (!attempt) return { status: "blocked", reason: "missing-attempt" };
        if (!validProgressCloudAttempt(attempt, ownerId, bindingId, articleId)) return malformedProgressAttempt();
        const eligibility = await evaluateProgressReceiptRecoveryInTransaction(tx, ownerId, bindingId, articleId, attempt);
        return eligibility.status === "recoverable" ? frozenProgressCopy({ status: "recoverable",
          attemptId: attempt.attemptId, cloudMutationId: attempt.cloudMutationId,
          immutableRequest: attempt.request }) : eligibility;
      });
  }

  // Read-only dispatch permission, never reserve/rebase or derive from today's
  // Resume. may_have_sent and eligible attention keep their original identity.
  async function prepareProgressCloudDispatch(ownerId, bindingId, articleId, attemptId, guard) {
    const current = () => evidenceScopeCurrent(ownerId, guard);
    if (!current() || !await evidenceWorkspaceStable()) return { status: "blocked", reason: "scope-mismatch" };
    const initial = await getProgressCloudAttempt(ownerId, bindingId, articleId, attemptId);
    if (initial.status !== "ready") return initial;
    if (initial.attempt.status === "settlement_attention") {
      const recovery = await prepareProgressReceiptRecovery(ownerId, bindingId, articleId, attemptId);
      if (recovery.status !== "recoverable") return recovery;
    }
    if (!current()) return { status: "blocked", reason: "scope-mismatch" };
    return runTransaction([CONTROL_STORE, PROGRESS_ATTEMPTS_STORE, PROGRESS_OBSERVATIONS_STORE],
      "readonly", async tx => {
        const binding = await requireBinding(tx.objectStore(CONTROL_STORE), ownerId, bindingId);
        if (binding.status !== "ready") return binding;
        const store = tx.objectStore(PROGRESS_ATTEMPTS_STORE);
        const attempt = await requestResult(store.get([ownerId, bindingId, articleId, attemptId]));
        if (!attempt) return { status: "missing" };
        if (!validProgressCloudAttempt(attempt, ownerId, bindingId, articleId)) return malformedProgressAttempt();
        if (attempt.cloudMutationId !== initial.attempt.cloudMutationId ||
            !sameProgressFact(attempt.request, initial.attempt.request)) {
          return { status: "blocked", reason: "attempt-identity-changed" };
        }
        if (attempt.status === "settlement_attention") {
          const eligible = await evaluateProgressReceiptRecoveryInTransaction(tx, ownerId, bindingId, articleId, attempt);
          if (eligible.status !== "recoverable") return eligible;
        } else if (attempt.status === "may_have_sent") {
          const attempts = await requestResult(store.index("byScope").getAll(progressAttemptScope(ownerId, bindingId, articleId)));
          if (attempts.some(item => !validProgressCloudAttempt(item, ownerId, bindingId, articleId))) return malformedProgressAttempt();
          if (attempts.some(item => item.attemptId !== attemptId &&
              ["awaiting_postflight", "prepared", "may_have_sent", "settlement_attention"].includes(item.status))) {
            return { status: "blocked", reason: "scope-occupied" };
          }
        } else return { status: "not-sendable", attemptStatus: attempt.status };
        return current() ? frozenProgressCopy({ status: "sendable", attemptId: attempt.attemptId,
          cloudMutationId: attempt.cloudMutationId, immutableRequest: attempt.request })
          : { status: "blocked", reason: "scope-mismatch" };
      });
  }

  async function getProgressCloudAttempt(ownerId, bindingId, articleId, attemptId) {
    return runTransaction([CONTROL_STORE, PROGRESS_ATTEMPTS_STORE], "readonly", async tx => {
      const binding = await requireBinding(tx.objectStore(CONTROL_STORE), ownerId, bindingId);
      if (binding.status !== "ready") return binding;
      const attempt = await requestResult(tx.objectStore(PROGRESS_ATTEMPTS_STORE)
        .get([ownerId, bindingId, articleId, attemptId]));
      if (!attempt) return { status: "missing" };
      return validProgressCloudAttempt(attempt, ownerId, bindingId, articleId)
        ? { status: "ready", attempt } : malformedProgressAttempt();
    });
  }

  async function listProgressCloudAttempts(ownerId, bindingId, articleId) {
    return runTransaction([CONTROL_STORE, PROGRESS_ATTEMPTS_STORE], "readonly", async tx => {
      const binding = await requireBinding(tx.objectStore(CONTROL_STORE), ownerId, bindingId);
      if (binding.status !== "ready") return binding;
      const records = await requestResult(tx.objectStore(PROGRESS_ATTEMPTS_STORE).index("byScope")
        .getAll(progressAttemptScope(ownerId, bindingId, articleId)));
      if (records.some(item => !validProgressCloudAttempt(item, ownerId, bindingId, articleId))) {
        return malformedProgressAttempt();
      }
      return { status: "ready", attempts: records };
    });
  }

  async function blockPreparedProgressCloudAttempt(ownerId, bindingId, articleId, attemptId, reason) {
    return transitionPreparedProgressAttempt(ownerId, bindingId, articleId, attemptId,
      "blocked_before_dispatch", reason);
  }

  async function supersedePreparedProgressCloudAttempt(ownerId, bindingId, articleId, attemptId) {
    return transitionPreparedProgressAttempt(ownerId, bindingId, articleId, attemptId,
      "superseded", "newer-confirmed");
  }

  async function transitionPreparedProgressAttempt(ownerId, bindingId, articleId, attemptId, status, reason) {
    if (!isOpaqueString(reason)) return { status: "invalid-reason" };
    return runTransaction([CONTROL_STORE, PROGRESS_DESIRED_STORE, PROGRESS_ATTEMPTS_STORE],
      "readwrite", async tx => {
        const binding = await requireBinding(tx.objectStore(CONTROL_STORE), ownerId, bindingId);
        if (binding.status !== "ready") return binding;
        const store = tx.objectStore(PROGRESS_ATTEMPTS_STORE);
        const attempt = await requestResult(store.get([ownerId, bindingId, articleId, attemptId]));
        if (!attempt) return { status: "missing" };
        if (!validProgressCloudAttempt(attempt, ownerId, bindingId, articleId)) {
          return malformedProgressAttempt();
        }
        if (status === "superseded" ? attempt.status !== "prepared" :
            !["awaiting_postflight", "prepared"].includes(attempt.status)) {
          return { status: "not-prepared" };
        }
        if (status === "superseded") {
          const desired = await requestResult(tx.objectStore(PROGRESS_DESIRED_STORE)
            .get([ownerId, bindingId, articleId]));
          if (!desired || !validProgressDesiredRecord(desired, ownerId, bindingId, articleId) ||
              !desired.confirmed?.fence?.action ||
              desired.confirmed.fence.action.localSeq <= attempt.sourceLocalSeq) {
            return { status: "not-newer-confirmed" };
          }
        }
        const next = { ...attempt, status, reason };
        await requestResult(store.put(next));
        return { status, attempt: next };
      });
  }

  window.LingoFlowSyncStateRepository = Object.freeze({
    DB_NAME,
    DB_VERSION,
    openDatabase,
    getProgressRemoteObservation,
    listProgressRemoteObservations,
    recordProgressRemoteObservation,
    getArticleServerReadingContext,
    recordArticleServerReadingContext,
    beginArticleServerContextObservation,
    recordArticleServerContextConfirmation,
    discardArticleServerContextObservation,
    getProgressCausalSnapshot,
    prepareProgressMovement,
    getProgressDesired,
    listProgressDesired,
    settleProgressMovement,
    prepareProgressCloudAttempt,
    confirmProgressCloudAttempt,
    rejectAwaitingProgressCloudAttempt,
    reserveProgressCloudAttemptForDispatch,
    prepareProgressCloudDispatch,
    settleProgressCloudResult,
    prepareProgressReceiptRecovery,
    getProgressCloudAttempt,
    listProgressCloudAttempts,
    blockPreparedProgressCloudAttempt,
    supersedePreparedProgressCloudAttempt,
    closeDatabase,
    bindWorkspace,
    getWorkspaceBinding,
    prepareArticleMutation,
    updateArticleMutationStatus,
    listArticleMutations,
    getArticleSidecar,
    commitArticleDesired,
    promoteNextArticleDesired,
    markArticleMutationAttempt,
    settleArticleMutationSuccess,
    beginArticleBootstrap,
    getArticleBootstrapState,
    persistArticleBootstrapInventoryPage,
    listArticleBootstrapInventory,
    transitionArticleBootstrap,
    pauseArticleBootstrap,
    captureArticleBootstrapIssue,
    listArticleBootstrapIssues,
    bindArticleRemoteRevision,
    persistArticleBootstrapCatchupPage,
    listArticleBootstrapPendingChanges,
    commitArticleBootstrapCatchupPage,
    completeArticleBootstrap,
    beginArticleRuntime,
    getArticleRuntimeState,
    pauseArticleRuntime,
    persistArticleRuntimePullPage,
    listArticleRuntimePendingChanges,
    commitArticleRuntimePullPage,
    captureArticleRuntimeIssue,
    quarantineOversizedArticle,
    clearOversizedArticleIssue,
    listArticleRuntimeIssues,
    prepareArticleKeepLocalResolution,
    beginArticleUseRemoteResolution,
    resetArticleConflictResolution,
    refreshArticleConflictIssue,
    finalizeArticleUseRemoteResolution,
    setArticleSidecarLifecycle,
    setWorkspaceAccountLabel,
    getWorkspaceAccountLabel,
    replaceWorkspaceBinding,
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
