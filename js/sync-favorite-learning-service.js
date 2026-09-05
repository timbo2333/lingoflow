(function() {
  "use strict";

  const ENTITY_TYPE = "favoriteLearningStates";

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

  function getStateRepository() {
    const repository = window.LingoFlowSyncStateRepository;
    if (!repository ||
        typeof repository.withFavoriteWriterLock !== "function" ||
        typeof repository.prepareOutbox !== "function" ||
        typeof repository.markOutboxReady !== "function") {
      throw new Error("Sync State Repository 不可用。");
    }
    return repository;
  }

  function getLearningRepository() {
    const repository = window.LingoFlowFavoriteLearningRepository;
    if (!repository ||
        typeof repository.planSetMastered !== "function" ||
        typeof repository.commitPlannedMutation !== "function") {
      throw new Error("Favorite Learning Repository planned mutation boundary 不可用。");
    }
    return repository;
  }

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function isOpaqueString(value) {
    return typeof value === "string" && Boolean(value.trim()) && value === value.trim();
  }

  function snapshotOwner(value) {
    const owner = getCanonical().snapshot(value, "owner");
    if (!isPlainObject(owner) ||
        Object.keys(owner).sort().join("\u0000") !== "bindingId\u0000ownerId" ||
        !isOpaqueString(owner.ownerId) ||
        !isOpaqueString(owner.bindingId)) {
      throw new Error("Sync Favorite Learning owner context 无效。");
    }
    return owner;
  }

  function createMutationId() {
    if (!window.crypto?.randomUUID) throw new Error("无法生成 Sync mutation ID。");
    return `mutation:${window.crypto.randomUUID()}`;
  }

  function isTombstone(state) {
    return Boolean(state?.deletedAt);
  }

  function createOutboxItem(
    owner,
    plan,
    sidecar,
    operation,
    localOperation,
    dependsOnMutationId = null
  ) {
    const canonical = getCanonical();
    const mutationId = createMutationId();
    const payload = canonical.snapshot(plan.candidate, "candidate");
    const before = plan.before === null
      ? null
      : canonical.snapshot(plan.before, "localBefore");
    return {
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      mutationId,
      status: "prepared",
      entityType: ENTITY_TYPE,
      entityId: plan.entityId,
      scope: "record",
      createdAt: new Date().toISOString(),
      localOperation,
      localBeforeSnapshot: before,
      localBeforeFingerprint: before === null ? null : canonical.fingerprint(before),
      candidateFingerprint: canonical.fingerprint(payload),
      request: {
        mutationId,
        entityType: ENTITY_TYPE,
        entityId: plan.entityId,
        scope: "record",
        schemaVersion: "1",
        operation,
        baseRevision: sidecar?.serverRevision ?? null,
        observedCursor: null,
        payload
      },
      attemptedAt: null,
      attemptCount: 0,
      leaseToken: null,
      leaseExpiresAt: null,
      dependsOnMutationId
    };
  }

  function chooseWireOperation(plan, sidecar, pending, attemptedHead = null) {
    if (isTombstone(plan.candidate)) return { status: "ready", operation: "put" };
    if (sidecar?.lastSyncedSnapshot && isTombstone(sidecar.lastSyncedSnapshot)) {
      return sidecar.serverRevision
        ? { status: "ready", operation: "restore" }
        : { status: "blocked", reason: "restore-base-revision-missing" };
    }
    if (plan.operation === "restore") {
      const unsentDelete = pending.some(item => (
        item.status === "ready" &&
        item.attemptedAt === null &&
        isTombstone(item.request.payload)
      ));
      if (unsentDelete || attemptedHead) return { status: "ready", operation: "put" };
      return { status: "blocked", reason: "restore-tombstone-revision-unavailable" };
    }
    return { status: "ready", operation: "put" };
  }

  function planFromOutbox(item) {
    return {
      operation: item.localOperation,
      entityId: item.entityId,
      before: item.localBeforeSnapshot,
      candidate: item.request.payload,
      changed: !getCanonical().valuesEqual(
        item.localBeforeSnapshot,
        item.request.payload
      )
    };
  }

  async function verifyCurrentBinding(owner) {
    const result = await getStateRepository().getWorkspaceBinding();
    if (result.status === "missing") {
      return { status: "blocked", reason: "workspace-unbound" };
    }
    if (result.status !== "ready") return result;
    if (result.binding.ownerId !== owner.ownerId) {
      return { status: "blocked", reason: "workspace-owner-mismatch" };
    }
    if (result.binding.bindingId !== owner.bindingId) {
      return { status: "blocked", reason: "workspace-binding-mismatch" };
    }
    return { status: "ready" };
  }

  async function readSyncState(owner, entityId) {
    const state = getStateRepository();
    const sidecarResult = await state.getSidecar(owner.ownerId, entityId, ENTITY_TYPE);
    if (!["ready", "missing"].includes(sidecarResult.status)) return sidecarResult;
    const sidecar = sidecarResult.sidecar;
    if (sidecar && (sidecar.ownerId !== owner.ownerId ||
        sidecar.bindingId !== owner.bindingId ||
        sidecar.entityType !== ENTITY_TYPE ||
        sidecar.entityId !== entityId)) {
      return { status: "blocked", reason: "learning-sync-state-identity-mismatch" };
    }
    const pendingResult = await state.listOutbox({
      ownerId: owner.ownerId,
      entityType: ENTITY_TYPE,
      entityId
    });
    if (pendingResult.status !== "ready") return pendingResult;
    if (pendingResult.items.some(item => item.bindingId !== owner.bindingId)) {
      return { status: "blocked", reason: "workspace-binding-mismatch" };
    }
    return { status: "ready", sidecar, pending: pendingResult.items };
  }

  async function recoverPreparedUnlocked(owner, lease) {
    const state = getStateRepository();
    const learning = getLearningRepository();
    const listed = await state.listOutbox({
      ownerId: owner.ownerId,
      entityType: ENTITY_TYPE,
      status: "prepared"
    });
    if (listed.status !== "ready") return listed;

    const recovered = [];
    const blockedItems = [];
    for (const item of listed.items) {
      if (item.bindingId !== owner.bindingId) {
        blockedItems.push({ entityId: item.entityId, reason: "workspace-binding-mismatch" });
        continue;
      }
      let current;
      try {
        current = learning.get(item.entityId, { includeDeleted: true });
      } catch (error) {
        return { status: "failed", reason: "learning-storage-read-failed", message: error.message };
      }
      if (!getCanonical().valuesEqual(current, item.request.payload)) {
        if (!getCanonical().valuesEqual(current, item.localBeforeSnapshot) ||
            item.localOperation === "drift") {
          blockedItems.push({ entityId: item.entityId, reason: "reconciliation-blocked" });
          continue;
        }
        const binding = await verifyCurrentBinding(owner);
        if (binding.status !== "ready") return binding;
        const committed = learning.commitPlannedMutation(planFromOutbox(item));
        if (!["committed", "unchanged"].includes(committed.status)) {
          blockedItems.push({ entityId: item.entityId, reason: "reconciliation-blocked" });
          continue;
        }
      }
      const ready = await state.markOutboxReady({
        ownerId: owner.ownerId,
        bindingId: owner.bindingId,
        mutationId: item.mutationId,
        leaseToken: lease.leaseToken
      });
      if (ready.status !== "ready") return ready;
      recovered.push({ entityId: item.entityId, mutationId: item.mutationId });
    }
    return blockedItems.length
      ? { status: "blocked", reason: "reconciliation-blocked", recovered, blocked: blockedItems }
      : { status: "ready", recovered, blocked: [] };
  }

  async function capturePlanUnlocked(owner, lease, plan) {
    if (plan === null) {
      return { status: "unchanged", favoriteLearningState: null, mutationId: null };
    }
    if (!plan.changed) {
      return {
        status: "unchanged",
        favoriteLearningState: getCanonical().snapshot(plan.candidate),
        mutationId: null
      };
    }

    const syncState = await readSyncState(owner, plan.entityId);
    if (syncState.status !== "ready") return syncState;
    const attempted = syncState.pending.filter(item => (
      item.status === "ready" && item.attemptedAt !== null
    ));
    if (attempted.length > 1) {
      return { status: "blocked", reason: "multiple-attempted-mutations" };
    }
    const attemptedHead = attempted[0] || null;
    const comparison = attemptedHead
      ? attemptedHead.request.payload
      : syncState.sidecar?.lastSyncedSnapshot ?? null;

    if (comparison && getCanonical().valuesEqual(plan.candidate, comparison)) {
      const cancelled = await getStateRepository().cancelUnattemptedOutbox({
        ownerId: owner.ownerId,
        bindingId: owner.bindingId,
        entityType: ENTITY_TYPE,
        entityId: plan.entityId,
        leaseToken: lease.leaseToken
      });
      if (cancelled.status !== "cancelled") return cancelled;
      const binding = await verifyCurrentBinding(owner);
      if (binding.status !== "ready") return binding;
      const committed = getLearningRepository().commitPlannedMutation(plan);
      if (!["committed", "unchanged"].includes(committed.status)) {
        return { status: "blocked", reason: "stale-local-state" };
      }
      return {
        status: "ready",
        mutationId: attemptedHead?.mutationId || null,
        favoriteLearningState: committed.favoriteLearningState,
        awaitingAttemptedHead: Boolean(attemptedHead)
      };
    }

    const wire = chooseWireOperation(
      plan,
      syncState.sidecar,
      syncState.pending,
      attemptedHead
    );
    if (wire.status !== "ready") return wire;
    const item = createOutboxItem(
      owner,
      plan,
      syncState.sidecar,
      wire.operation,
      plan.operation,
      attemptedHead?.mutationId || null
    );
    const prepared = await getStateRepository().prepareOutbox(item, {
      leaseToken: lease.leaseToken,
      replaceUnattemptedReady: syncState.pending.some(current => (
        current.status === "ready" && current.attemptedAt === null
      ))
    });
    if (prepared.status !== "prepared") return prepared;

    const binding = await verifyCurrentBinding(owner);
    if (binding.status !== "ready") return { ...binding, prepared: true };
    const committed = getLearningRepository().commitPlannedMutation(plan);
    if (!["committed", "unchanged"].includes(committed.status)) {
      return { status: "blocked", reason: "stale-local-state", mutationId: item.mutationId };
    }
    const ready = await getStateRepository().markOutboxReady({
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      mutationId: item.mutationId,
      leaseToken: lease.leaseToken
    });
    if (ready.status !== "ready") {
      return {
        status: "local-committed-pending-reconciliation",
        reason: ready.reason || "outbox-ready-failed",
        mutationId: item.mutationId,
        favoriteLearningState: committed.favoriteLearningState
      };
    }
    return {
      status: "ready",
      mutationId: item.mutationId,
      favoriteLearningState: committed.favoriteLearningState,
      outbox: ready.item
    };
  }

  async function runMutation(ownerValue, planner) {
    let owner;
    try {
      owner = snapshotOwner(ownerValue);
    } catch (error) {
      return { status: "failed", reason: "invalid-owner-context", message: error.message };
    }
    return await getStateRepository().withFavoriteWriterLock(owner, async lease => {
      const recovered = await recoverPreparedUnlocked(owner, lease);
      if (recovered.status !== "ready") return recovered;
      let plan;
      try {
        plan = planner(getLearningRepository());
      } catch (error) {
        return { status: "failed", reason: "learning-plan-failed", message: error.message };
      }
      return await capturePlanUnlocked(owner, lease, plan);
    });
  }

  async function setMastered(owner, favoriteId, value) {
    return await runMutation(
      owner,
      repository => repository.planSetMastered(favoriteId, value)
    );
  }

  async function reconcile(ownerValue) {
    let owner;
    try {
      owner = snapshotOwner(ownerValue);
    } catch (error) {
      return { status: "failed", reason: "invalid-owner-context", message: error.message };
    }

    return await getStateRepository().withFavoriteWriterLock(owner, async lease => {
      const prepared = await recoverPreparedUnlocked(owner, lease);
      if (prepared.status !== "ready") return prepared;
      let localStates;
      try {
        localStates = getLearningRepository().list({ includeDeleted: true });
      } catch (error) {
        return { status: "failed", reason: "learning-storage-read-failed", message: error.message };
      }
      const sidecars = await getStateRepository().listSidecars(owner.ownerId, ENTITY_TYPE);
      if (sidecars.status !== "ready") return sidecars;
      const outbox = await getStateRepository().listOutbox({
        ownerId: owner.ownerId,
        entityType: ENTITY_TYPE
      });
      if (outbox.status !== "ready") return outbox;

      const localById = new Map(localStates.map(item => [item.favoriteId, item]));
      const sidecarById = new Map(sidecars.sidecars.map(item => [item.entityId, item]));
      const pendingIds = new Set(outbox.items.map(item => item.entityId));
      const blocked = sidecars.sidecars
        .filter(item => item.bindingId !== owner.bindingId || !localById.has(item.entityId))
        .map(item => ({
          entityId: item.entityId,
          reason: item.bindingId !== owner.bindingId
            ? "workspace-binding-mismatch"
            : "local-learning-state-missing"
        }));
      if (blocked.length) {
        return { status: "blocked", reason: "reconciliation-blocked", blocked };
      }

      const captured = [];
      for (const local of localStates) {
        if (pendingIds.has(local.favoriteId)) continue;
        const sidecar = sidecarById.get(local.favoriteId) || null;
        if (sidecar && getCanonical().valuesEqual(local, sidecar.lastSyncedSnapshot)) continue;
        const operation = sidecar?.lastSyncedSnapshot &&
          isTombstone(sidecar.lastSyncedSnapshot) && !isTombstone(local)
          ? "restore"
          : "put";
        const plan = {
          operation: "drift",
          entityId: local.favoriteId,
          before: local,
          candidate: local,
          changed: false
        };
        const item = createOutboxItem(owner, plan, sidecar, operation, "drift");
        const stored = await getStateRepository().prepareOutbox(item, {
          leaseToken: lease.leaseToken,
          replaceReady: false
        });
        if (stored.status !== "prepared") return stored;
        const ready = await getStateRepository().markOutboxReady({
          ownerId: owner.ownerId,
          bindingId: owner.bindingId,
          mutationId: item.mutationId,
          leaseToken: lease.leaseToken
        });
        if (ready.status !== "ready") return ready;
        captured.push({ entityId: item.entityId, mutationId: item.mutationId });
      }
      return { status: "ready", recovered: prepared.recovered, captured, blocked: [] };
    });
  }

  window.LingoFlowSyncFavoriteLearningService = Object.freeze({
    setMastered,
    reconcile
  });
})();
