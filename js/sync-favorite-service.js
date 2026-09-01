(function() {
  "use strict";

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

  function getFavoriteRepository() {
    const repository = window.LingoFlowFavoriteRepository;
    if (!repository ||
        typeof repository.planCreate !== "function" ||
        typeof repository.planUpdate !== "function" ||
        typeof repository.planSoftDelete !== "function" ||
        typeof repository.planRestore !== "function" ||
        typeof repository.commitPlannedMutation !== "function") {
      throw new Error("Favorite Repository planned mutation boundary 不可用。");
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
      throw new Error("Sync Favorite owner context 无效。");
    }
    return owner;
  }

  function createMutationId() {
    if (!window.crypto?.randomUUID) throw new Error("无法生成 Sync mutation ID。");
    return `mutation:${window.crypto.randomUUID()}`;
  }

  function isTombstone(favorite) {
    return Boolean(favorite?.deletedAt);
  }

  function createOutboxItem(owner, plan, sidecar, operation, localOperation) {
    const canonical = getCanonical();
    const mutationId = createMutationId();
    const payload = canonical.snapshot(plan.candidate, "candidate");
    const before = plan.before === null
      ? null
      : canonical.snapshot(plan.before, "localBefore");
    const baseRevision = sidecar?.serverRevision ?? null;
    const request = {
      mutationId,
      entityType: "favorites",
      entityId: plan.entityId,
      scope: "record",
      schemaVersion: "1",
      operation,
      baseRevision,
      observedCursor: null,
      payload
    };
    return {
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      mutationId,
      status: "prepared",
      entityType: "favorites",
      entityId: plan.entityId,
      scope: "record",
      createdAt: new Date().toISOString(),
      localOperation,
      localBeforeSnapshot: before,
      localBeforeFingerprint: before === null ? null : canonical.fingerprint(before),
      candidateFingerprint: canonical.fingerprint(payload),
      request
    };
  }

  function chooseWireOperation(plan, sidecar, pending) {
    if (isTombstone(plan.candidate)) return { status: "ready", operation: "put" };

    if (sidecar?.lastSyncedSnapshot && isTombstone(sidecar.lastSyncedSnapshot)) {
      if (!sidecar.serverRevision) {
        return { status: "blocked", reason: "restore-base-revision-missing" };
      }
      return { status: "ready", operation: "restore" };
    }

    if (plan.operation === "restore") {
      const unsentDelete = pending.some(item => (
        item.status === "ready" &&
        item.request.operation === "put" &&
        isTombstone(item.request.payload)
      ));
      if (unsentDelete) {
        return { status: "ready", operation: "put", coalescedRestore: true };
      }
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

  async function recoverPreparedUnlocked(owner, lease) {
    const state = getStateRepository();
    const favorites = getFavoriteRepository();
    const listed = await state.listOutbox({ ownerId: owner.ownerId, status: "prepared" });
    if (listed.status !== "ready") return listed;

    const recovered = [];
    const blockedItems = [];
    for (const item of listed.items) {
      if (item.bindingId !== owner.bindingId) {
        blockedItems.push({
          entityId: item.entityId,
          mutationId: item.mutationId,
          reason: "workspace-binding-mismatch"
        });
        continue;
      }

      let current;
      try {
        current = favorites.getById(item.entityId, { includeDeleted: true });
      } catch (error) {
        return {
          status: "failed",
          reason: "favorite-storage-read-failed",
          message: error.message,
          recovered,
          blocked: blockedItems
        };
      }

      if (getCanonical().valuesEqual(current, item.request.payload)) {
        const ready = await state.markOutboxReady({
          ownerId: owner.ownerId,
          bindingId: owner.bindingId,
          mutationId: item.mutationId,
          leaseToken: lease.leaseToken
        });
        if (ready.status !== "ready") return { ...ready, recovered, blocked: blockedItems };
        recovered.push({
          entityId: item.entityId,
          mutationId: item.mutationId,
          action: "marked-ready"
        });
        continue;
      }

      if (!getCanonical().valuesEqual(current, item.localBeforeSnapshot)) {
        blockedItems.push({
          entityId: item.entityId,
          mutationId: item.mutationId,
          reason: "reconciliation-blocked"
        });
        continue;
      }

      if (item.localOperation === "drift") {
        blockedItems.push({
          entityId: item.entityId,
          mutationId: item.mutationId,
          reason: "invalid-drift-prepared-state"
        });
        continue;
      }

      const binding = await verifyCurrentBinding(owner);
      if (binding.status !== "ready") {
        return { ...binding, recovered, blocked: blockedItems };
      }

      let committed;
      try {
        committed = favorites.commitPlannedMutation(planFromOutbox(item));
      } catch (error) {
        return {
          status: "failed",
          reason: "favorite-local-commit-failed",
          message: error.message,
          recovered,
          blocked: blockedItems
        };
      }
      if (committed.status !== "committed" && committed.status !== "unchanged") {
        blockedItems.push({
          entityId: item.entityId,
          mutationId: item.mutationId,
          reason: "reconciliation-blocked"
        });
        continue;
      }

      const ready = await state.markOutboxReady({
        ownerId: owner.ownerId,
        bindingId: owner.bindingId,
        mutationId: item.mutationId,
        leaseToken: lease.leaseToken
      });
      if (ready.status !== "ready") return { ...ready, recovered, blocked: blockedItems };
      recovered.push({
        entityId: item.entityId,
        mutationId: item.mutationId,
        action: "committed-and-ready"
      });
    }

    return blockedItems.length
      ? { status: "blocked", reason: "reconciliation-blocked", recovered, blocked: blockedItems }
      : { status: "ready", recovered, blocked: [] };
  }

  async function readSyncState(owner, entityId) {
    const state = getStateRepository();
    const sidecarResult = await state.getSidecar(owner.ownerId, entityId);
    if (sidecarResult.status !== "ready" && sidecarResult.status !== "missing") {
      return sidecarResult;
    }
    const sidecar = sidecarResult.sidecar;
    if (sidecar) {
      if (sidecar.ownerId !== owner.ownerId) {
        return { status: "blocked", reason: "workspace-owner-mismatch" };
      }
      if (sidecar.bindingId !== owner.bindingId) {
        return { status: "blocked", reason: "workspace-binding-mismatch" };
      }
      if (sidecar.entityType !== "favorites" ||
          sidecar.entityId !== entityId ||
          sidecar.scope !== "record" ||
          sidecar.schemaVersion !== "1") {
        return { status: "blocked", reason: "favorite-sync-state-identity-mismatch" };
      }
    }
    const pendingResult = await state.listOutbox({
      ownerId: owner.ownerId,
      entityId
    });
    if (pendingResult.status !== "ready") return pendingResult;
    if (pendingResult.items.some(item => item.bindingId !== owner.bindingId)) {
      return { status: "blocked", reason: "workspace-binding-mismatch" };
    }
    return {
      status: "ready",
      sidecar,
      pending: pendingResult.items
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

  async function capturePlanUnlocked(owner, lease, plan) {
    if (plan === null) return { status: "missing", favorite: null };
    if (!plan.changed) {
      return {
        status: "unchanged",
        favorite: getCanonical().snapshot(plan.candidate),
        mutationId: null
      };
    }

    const syncState = await readSyncState(owner, plan.entityId);
    if (syncState.status !== "ready") return syncState;
    const wire = chooseWireOperation(plan, syncState.sidecar, syncState.pending);
    if (wire.status !== "ready") return wire;

    const item = createOutboxItem(
      owner,
      plan,
      syncState.sidecar,
      wire.operation,
      plan.operation
    );
    const prepared = await getStateRepository().prepareOutbox(item, {
      leaseToken: lease.leaseToken,
      replaceReady: syncState.pending.some(current => current.status === "ready")
    });
    if (prepared.status !== "prepared") return prepared;

    const binding = await verifyCurrentBinding(owner);
    if (binding.status !== "ready") {
      return {
        ...binding,
        mutationId: item.mutationId,
        prepared: true
      };
    }

    let committed;
    try {
      committed = getFavoriteRepository().commitPlannedMutation(plan);
    } catch (error) {
      return {
        status: "failed",
        reason: "favorite-local-commit-failed",
        message: error.message,
        mutationId: item.mutationId
      };
    }
    if (committed.status !== "committed" && committed.status !== "unchanged") {
      return {
        status: "blocked",
        reason: "stale-local-state",
        mutationId: item.mutationId,
        favorite: committed.favorite
      };
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
        favorite: committed.favorite
      };
    }
    return {
      status: "ready",
      mutationId: item.mutationId,
      favorite: committed.favorite,
      outbox: ready.item,
      replacedMutationIds: prepared.replacedMutationIds,
      coalescedRestore: Boolean(wire.coalescedRestore)
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
        plan = planner(getFavoriteRepository());
      } catch (error) {
        return { status: "failed", reason: "favorite-plan-failed", message: error.message };
      }
      return await capturePlanUnlocked(owner, lease, plan);
    });
  }

  async function bindWorkspace(value) {
    try {
      return await getStateRepository().bindWorkspace(snapshotOwner(value));
    } catch (error) {
      return { status: "failed", reason: "workspace-binding-failed", message: error.message };
    }
  }

  async function create(owner, input) {
    return await runMutation(owner, repository => repository.planCreate(input));
  }

  async function update(owner, id, patch) {
    return await runMutation(owner, repository => repository.planUpdate(id, patch));
  }

  async function softDelete(owner, id) {
    return await runMutation(owner, repository => repository.planSoftDelete(id));
  }

  async function restore(owner, id) {
    return await runMutation(owner, repository => repository.planRestore(id));
  }

  async function buildDriftActions(owner, localFavorites, sidecars, pending) {
    const canonical = getCanonical();
    const localById = new Map(localFavorites.map(favorite => [favorite.id, favorite]));
    const sidecarById = new Map(sidecars.map(sidecar => [sidecar.entityId, sidecar]));
    const pendingIds = new Set(pending.map(item => item.entityId));
    const blockedItems = [];
    const actions = [];

    for (const sidecar of sidecars) {
      if (sidecar.bindingId !== owner.bindingId) {
        blockedItems.push({ entityId: sidecar.entityId, reason: "workspace-binding-mismatch" });
        continue;
      }
      if (!localById.has(sidecar.entityId)) {
        blockedItems.push({ entityId: sidecar.entityId, reason: "local-favorite-missing" });
      }
    }

    for (const favorite of localFavorites) {
      if (pendingIds.has(favorite.id)) continue;
      const sidecar = sidecarById.get(favorite.id) || null;
      if (sidecar && canonical.valuesEqual(favorite, sidecar.lastSyncedSnapshot)) continue;

      let operation = "put";
      if (sidecar?.lastSyncedSnapshot &&
          isTombstone(sidecar.lastSyncedSnapshot) &&
          !isTombstone(favorite)) {
        if (!sidecar.serverRevision) {
          blockedItems.push({
            entityId: favorite.id,
            reason: "restore-base-revision-missing"
          });
          continue;
        }
        operation = "restore";
      }
      actions.push({
        sidecar,
        operation,
        plan: {
          operation: "drift",
          entityId: favorite.id,
          before: favorite,
          candidate: favorite,
          changed: false
        }
      });
    }
    return { actions, blockedItems };
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

      let localFavorites;
      try {
        localFavorites = getFavoriteRepository().list({ includeDeleted: true });
      } catch (error) {
        return { status: "failed", reason: "favorite-storage-read-failed", message: error.message };
      }
      const sidecarResult = await getStateRepository().listSidecars(owner.ownerId);
      if (sidecarResult.status !== "ready") return sidecarResult;
      const outboxResult = await getStateRepository().listOutbox({ ownerId: owner.ownerId });
      if (outboxResult.status !== "ready") return outboxResult;

      const drift = await buildDriftActions(
        owner,
        localFavorites,
        sidecarResult.sidecars,
        outboxResult.items
      );
      if (drift.blockedItems.length) {
        return {
          status: "blocked",
          reason: "reconciliation-blocked",
          recovered: prepared.recovered,
          blocked: drift.blockedItems
        };
      }

      const captured = [];
      for (const action of drift.actions) {
        const item = createOutboxItem(
          owner,
          action.plan,
          action.sidecar,
          action.operation,
          "drift"
        );
        const stored = await getStateRepository().prepareOutbox(item, {
          leaseToken: lease.leaseToken,
          replaceReady: false
        });
        if (stored.status !== "prepared") {
          return { ...stored, recovered: prepared.recovered, captured };
        }
        const ready = await getStateRepository().markOutboxReady({
          ownerId: owner.ownerId,
          bindingId: owner.bindingId,
          mutationId: item.mutationId,
          leaseToken: lease.leaseToken
        });
        if (ready.status !== "ready") {
          return { ...ready, recovered: prepared.recovered, captured };
        }
        captured.push({
          entityId: item.entityId,
          mutationId: item.mutationId,
          operation: item.request.operation
        });
      }

      return {
        status: "ready",
        recovered: prepared.recovered,
        captured,
        blocked: []
      };
    });
  }

  window.LingoFlowSyncFavoriteService = Object.freeze({
    bindWorkspace,
    create,
    update,
    softDelete,
    restore,
    reconcile
  });
})();
