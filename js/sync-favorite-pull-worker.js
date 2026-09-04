(function() {
  "use strict";

  function getCanonical(value) {
    const canonical = value || window.LingoFlowSyncCanonical;
    if (!canonical ||
        typeof canonical.snapshot !== "function" ||
        typeof canonical.fingerprint !== "function" ||
        typeof canonical.valuesEqual !== "function") {
      throw new Error("Sync canonical boundary 不可用。");
    }
    return canonical;
  }

  function getProtocol(value) {
    const protocol = value || window.LingoFlowCloudSyncProtocol;
    if (!protocol || typeof protocol.validatePullResult !== "function") {
      throw new Error("Cloud Sync pull protocol 不可用。");
    }
    return protocol;
  }

  function getStateRepository(value) {
    const state = value || window.LingoFlowSyncStateRepository;
    const required = [
      "getWorkspaceBinding",
      "withFavoriteWriterLock",
      "acquirePullLease",
      "releasePullLease",
      "receivePullResult",
      "getPullProgress",
      "getNextInbox",
      "listInbox",
      "getPullAnchor",
      "getSidecar",
      "listOutbox",
      "listIssues",
      "settleInboxNoop",
      "prepareInboxApply",
      "finalizeInboxApply",
      "settleInboxIssue"
    ];
    if (!state || required.some(name => typeof state[name] !== "function")) {
      throw new Error("Sync State Repository pull boundary 不可用。");
    }
    return state;
  }

  function getFavoriteRepository(value) {
    const repository = value || window.LingoFlowFavoriteRepository;
    if (!repository ||
        typeof repository.getById !== "function" ||
        typeof repository.commitExactSnapshot !== "function") {
      throw new Error("Favorite Repository exact apply boundary 不可用。");
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

  function snapshotOwner(canonical, value) {
    const owner = canonical.snapshot(value, "owner");
    if (!isPlainObject(owner) ||
        Object.keys(owner).sort().join("\u0000") !== "bindingId\u0000ownerId" ||
        !isOpaqueString(owner.ownerId) ||
        !isOpaqueString(owner.bindingId)) {
      throw new Error("Favorite Pull Worker owner context 无效。");
    }
    return owner;
  }

  function create(options = {}) {
    if (!isPlainObject(options) || typeof options.pull !== "function") {
      throw new Error("Favorite Pull Worker 缺少 pull adapter。");
    }
    const canonical = getCanonical(options.canonical);
    const protocol = getProtocol(options.protocol);
    const state = getStateRepository(options.syncStateRepository);
    const favorites = getFavoriteRepository(options.favoriteRepository);
    const pull = options.pull;

    async function verifyBinding(owner) {
      const result = await state.getWorkspaceBinding();
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

    async function releasePull(owner, lease) {
      return await state.releasePullLease({
        ownerId: owner.ownerId,
        bindingId: owner.bindingId,
        leaseToken: lease.leaseToken
      });
    }

    async function receiveOnce(ownerValue, receiveOptions = {}) {
      let owner;
      try {
        owner = snapshotOwner(canonical, ownerValue);
      } catch (error) {
        return { status: "failed", reason: "invalid-owner-context", message: error.message };
      }

      const leased = await state.acquirePullLease(owner, receiveOptions);
      if (leased.status !== "leased") return leased;
      const lease = canonical.snapshot(leased.lease, "pullLease");
      let rawResult;
      try {
        rawResult = await pull(
          { ownerId: owner.ownerId },
          lease.startReceivedCursor
        );
      } catch (error) {
        const released = await releasePull(owner, lease);
        return {
          status: "failed",
          reason: "pull-transport-failed",
          retryable: true,
          released: released.status === "released",
          ...(error?.message ? { message: error.message } : {})
        };
      }

      let validation;
      try {
        validation = protocol.validatePullResult(rawResult);
      } catch (error) {
        const released = await releasePull(owner, lease);
        return {
          status: "failed",
          reason: "pull-result-validation-failed",
          retryable: true,
          released: released.status === "released",
          ...(error?.message ? { message: error.message } : {})
        };
      }
      if (!validation || validation.status !== "valid") {
        const released = await releasePull(owner, lease);
        return {
          status: "failed",
          reason: "invalid-pull-result",
          retryable: true,
          released: released.status === "released",
          errors: Array.isArray(validation?.errors)
            ? canonical.snapshot(validation.errors)
            : []
        };
      }
      const pullResult = canonical.snapshot(validation.pullResult, "pullResult");
      if (pullResult.status === "rejected") {
        const released = await releasePull(owner, lease);
        return {
          status: "rejected",
          reason: pullResult.reason,
          released: released.status === "released"
        };
      }

      const binding = await verifyBinding(owner);
      if (binding.status !== "ready") {
        const released = await releasePull(owner, lease);
        return { ...binding, released: released.status === "released" };
      }

      const received = await state.receivePullResult({
        ownerId: owner.ownerId,
        bindingId: owner.bindingId,
        leaseToken: lease.leaseToken,
        startReceivedCursor: lease.startReceivedCursor,
        pullResult
      });
      if (received.status !== "received") {
        const released = await releasePull(owner, lease);
        return { ...received, released: released.status === "released" };
      }
      return received;
    }

    async function readCurrentFavorite(entityId) {
      try {
        return {
          status: "ready",
          favorite: favorites.getById(entityId, { includeDeleted: true })
        };
      } catch (error) {
        return {
          status: "failed",
          reason: "favorite-storage-read-failed",
          message: error.message
        };
      }
    }

    async function readRecordState(owner, item) {
      const sidecarResult = await state.getSidecar(owner.ownerId, item.entityId);
      if (sidecarResult.status !== "ready" && sidecarResult.status !== "missing") {
        return sidecarResult;
      }
      const sidecar = sidecarResult.sidecar;
      if (sidecar && sidecar.bindingId !== owner.bindingId) {
        return { status: "blocked", reason: "workspace-binding-mismatch" };
      }
      const pendingResult = await state.listOutbox({
        ownerId: owner.ownerId,
        entityId: item.entityId
      });
      if (pendingResult.status !== "ready") return pendingResult;
      if (pendingResult.items.some(value => value.bindingId !== owner.bindingId)) {
        return { status: "blocked", reason: "workspace-binding-mismatch" };
      }
      const issueResult = await state.listIssues({
        ownerId: owner.ownerId,
        bindingId: owner.bindingId,
        entityId: item.entityId
      });
      if (issueResult.status !== "ready") return issueResult;
      const anchorResult = await state.getPullAnchor({
        ownerId: owner.ownerId,
        bindingId: owner.bindingId,
        entityId: item.entityId
      });
      if (anchorResult.status !== "ready" && anchorResult.status !== "missing") {
        return anchorResult;
      }
      return {
        status: "ready",
        sidecar,
        pending: pendingResult.items,
        issues: issueResult.issues,
        anchor: anchorResult.anchor
      };
    }

    function pullAnchorMatches(canonicalValue, anchor, sidecar) {
      return Boolean(anchor && sidecar &&
        anchor.revision === sidecar.serverRevision &&
        anchor.payloadFingerprint === sidecar.lastSyncedFingerprint &&
        anchor.entityId === sidecar.entityId &&
        anchor.scope === sidecar.scope);
    }

    async function settleIssue(owner, lease, item, localSnapshot, reason) {
      const settled = await state.settleInboxIssue({
        ownerId: owner.ownerId,
        bindingId: owner.bindingId,
        inboxSeq: item.inboxSeq,
        leaseToken: lease.leaseToken,
        reason,
        localSnapshot
      });
      return settled.status === "settled"
        ? {
            status: "conflict",
            reason,
            entityId: item.entityId,
            cursor: item.cursor,
            issue: settled.issue,
            progress: settled.progress
          }
        : settled;
    }

    async function recoverApplying(owner, lease, item, current) {
      const intent = item.applyIntent;
      if (canonical.valuesEqual(current, intent.candidateSnapshot)) {
        const finalized = await state.finalizeInboxApply({
          ownerId: owner.ownerId,
          bindingId: owner.bindingId,
          inboxSeq: item.inboxSeq,
          leaseToken: lease.leaseToken
        });
        return finalized.status === "settled"
          ? {
              status: "applied",
              recovered: true,
              written: false,
              entityId: item.entityId,
              cursor: item.cursor,
              progress: finalized.progress
            }
          : finalized;
      }

      if (!canonical.valuesEqual(current, intent.localBeforeSnapshot)) {
        return await settleIssue(
          owner,
          lease,
          item,
          current,
          "apply-recovery-local-diverged"
        );
      }

      const binding = await verifyBinding(owner);
      if (binding.status !== "ready") return binding;
      let committed;
      try {
        committed = favorites.commitExactSnapshot({
          entityId: item.entityId,
          expectedCurrent: intent.localBeforeSnapshot,
          candidate: intent.candidateSnapshot
        });
      } catch (error) {
        return {
          status: "failed",
          reason: "favorite-remote-commit-failed",
          message: error.message
        };
      }
      if (committed.status !== "committed" && committed.status !== "unchanged") {
        return {
          status: "blocked",
          reason: "stale-local-state",
          entityId: item.entityId,
          favorite: committed.favorite
        };
      }
      const finalized = await state.finalizeInboxApply({
        ownerId: owner.ownerId,
        bindingId: owner.bindingId,
        inboxSeq: item.inboxSeq,
        leaseToken: lease.leaseToken
      });
      return finalized.status === "settled"
        ? {
            status: "applied",
            recovered: true,
            written: committed.status === "committed",
            entityId: item.entityId,
            cursor: item.cursor,
            progress: finalized.progress
          }
        : { ...finalized, localCommitted: true };
    }

    async function applyReceived(owner, lease, item, current) {
      const recordState = await readRecordState(owner, item);
      if (recordState.status !== "ready") return recordState;
      const sidecar = recordState.sidecar;

      if (sidecar &&
          item.revision === sidecar.serverRevision &&
          canonical.valuesEqual(item.change.payload, sidecar.lastSyncedSnapshot)) {
        const settled = await state.settleInboxNoop({
          ownerId: owner.ownerId,
          bindingId: owner.bindingId,
          inboxSeq: item.inboxSeq,
          leaseToken: lease.leaseToken,
          mode: "own-echo",
          anchorInboxSeq: null
        });
        return settled.status === "settled"
          ? {
              status: "unchanged",
              reason: "own-echo",
              entityId: item.entityId,
              cursor: item.cursor,
              progress: settled.progress
            }
          : settled;
      }

      if (sidecar && current === null) {
        return {
          status: "blocked",
          reason: "corrupted-local-state",
          entityId: item.entityId
        };
      }

      if (sidecar && item.revision === sidecar.serverRevision) {
        return await settleIssue(
          owner,
          lease,
          item,
          current,
          "same-revision-different-payload"
        );
      }

      if (sidecar && !pullAnchorMatches(canonical, recordState.anchor, sidecar)) {
        const recordInbox = await state.listInbox({
          ownerId: owner.ownerId,
          bindingId: owner.bindingId,
          entityId: item.entityId
        });
        if (recordInbox.status !== "ready") return recordInbox;
        const anchor = recordInbox.items.find(candidate => (
          candidate.inboxSeq > item.inboxSeq &&
          candidate.revision === sidecar.serverRevision &&
          canonical.valuesEqual(candidate.change.payload, sidecar.lastSyncedSnapshot)
        ));
        if (anchor) {
          const settled = await state.settleInboxNoop({
            ownerId: owner.ownerId,
            bindingId: owner.bindingId,
            inboxSeq: item.inboxSeq,
            leaseToken: lease.leaseToken,
            mode: "historical",
            anchorInboxSeq: anchor.inboxSeq
          });
          return settled.status === "settled"
            ? {
                status: "unchanged",
                reason: "historical",
                entityId: item.entityId,
                cursor: item.cursor,
                progress: settled.progress
              }
            : settled;
        }
        return {
          status: "blocked",
          reason: "awaiting-historical-anchor",
          entityId: item.entityId
        };
      }

      if (recordState.pending.length || recordState.issues.length) {
        return await settleIssue(
          owner,
          lease,
          item,
          current,
          recordState.issues.length ? "sync-issue-exists" : "local-mutation-pending"
        );
      }
      if (!sidecar && current !== null) {
        return await settleIssue(owner, lease, item, current, "unsynced-local");
      }
      if (sidecar && !canonical.valuesEqual(current, sidecar.lastSyncedSnapshot)) {
        return await settleIssue(owner, lease, item, current, "local-dirty");
      }

      const prepared = await state.prepareInboxApply({
        ownerId: owner.ownerId,
        bindingId: owner.bindingId,
        inboxSeq: item.inboxSeq,
        leaseToken: lease.leaseToken,
        localBeforeSnapshot: current,
        candidateSnapshot: item.change.payload,
        expectedSidecarSnapshot: sidecar
      });
      if (prepared.status !== "applying") return prepared;

      const binding = await verifyBinding(owner);
      if (binding.status !== "ready") return { ...binding, applying: true };
      let committed;
      try {
        committed = favorites.commitExactSnapshot({
          entityId: item.entityId,
          expectedCurrent: current,
          candidate: prepared.item.applyIntent.candidateSnapshot
        });
      } catch (error) {
        return {
          status: "failed",
          reason: "favorite-remote-commit-failed",
          message: error.message,
          applying: true
        };
      }
      if (committed.status !== "committed" && committed.status !== "unchanged") {
        return {
          status: "blocked",
          reason: "stale-local-state",
          entityId: item.entityId,
          applying: true,
          favorite: committed.favorite
        };
      }
      const finalized = await state.finalizeInboxApply({
        ownerId: owner.ownerId,
        bindingId: owner.bindingId,
        inboxSeq: item.inboxSeq,
        leaseToken: lease.leaseToken
      });
      return finalized.status === "settled"
        ? {
            status: "applied",
            recovered: false,
            written: committed.status === "committed",
            entityId: item.entityId,
            cursor: item.cursor,
            favorite: committed.favorite,
            sidecar: finalized.sidecar,
            progress: finalized.progress
          }
        : { ...finalized, localCommitted: true };
    }

    async function applyNext(ownerValue) {
      let owner;
      try {
        owner = snapshotOwner(canonical, ownerValue);
      } catch (error) {
        return { status: "failed", reason: "invalid-owner-context", message: error.message };
      }

      return await state.withFavoriteWriterLock(owner, async lease => {
        const binding = await verifyBinding(owner);
        if (binding.status !== "ready") return binding;
        const next = await state.getNextInbox(owner);
        if (next.status !== "ready") return next;
        const item = canonical.snapshot(next.item, "inbox");
        const local = await readCurrentFavorite(item.entityId);
        if (local.status !== "ready") return local;
        return item.status === "applying"
          ? await recoverApplying(owner, lease, item, local.favorite)
          : await applyReceived(owner, lease, item, local.favorite);
      });
    }

    return Object.freeze({ receiveOnce, applyNext });
  }

  window.LingoFlowSyncFavoritePullWorker = Object.freeze({ create });
})();
