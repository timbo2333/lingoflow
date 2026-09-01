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
    if (!protocol || typeof protocol.validateResult !== "function") {
      throw new Error("Cloud Sync Protocol 不可用。");
    }
    return protocol;
  }

  function getStateRepository(value) {
    const state = value || window.LingoFlowSyncStateRepository;
    const required = [
      "acquireNextReadyMutationLease",
      "releaseMutationLease",
      "settleSuccessfulMutation",
      "settleMutationIssue",
      "withFavoriteWriterLock",
      "listOutbox"
    ];
    if (!state || required.some(name => typeof state[name] !== "function")) {
      throw new Error("Sync State Repository push boundary 不可用。");
    }
    return state;
  }

  function getFavoriteRepository(value) {
    const repository = value || window.LingoFlowFavoriteRepository;
    if (!repository || typeof repository.getById !== "function") {
      throw new Error("Favorite Repository read boundary 不可用。");
    }
    return repository;
  }

  function getFavoriteService(value) {
    const service = value || window.LingoFlowSyncFavoriteService;
    if (!service || typeof service.reconcile !== "function") {
      throw new Error("Sync Favorite reconciliation boundary 不可用。");
    }
    return service;
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
      throw new Error("Favorite Push Worker owner context 无效。");
    }
    return owner;
  }

  function createMutationId() {
    if (!window.crypto?.randomUUID) throw new Error("无法生成 successor mutation ID。");
    return `mutation:${window.crypto.randomUUID()}`;
  }

  function isTombstone(value) {
    return Boolean(value?.deletedAt);
  }

  function validateResultIdentity(validation, request) {
    if (!validation || validation.status !== "valid") {
      return { status: "failed", reason: "invalid-push-result" };
    }
    const result = validation.result;
    if (result.mutationId !== request.mutationId ||
        result.entityType !== request.entityType ||
        result.entityId !== request.entityId ||
        result.scope !== request.scope ||
        (result.status !== "rejected" && result.schemaVersion !== request.schemaVersion)) {
      return { status: "failed", reason: "push-result-identity-mismatch" };
    }
    return { status: "ready", result };
  }

  function createSuccessorItem(canonical, owner, current, head, revision, localOperation) {
    const mutationId = createMutationId();
    const payload = canonical.snapshot(current, "successor.payload");
    const before = canonical.snapshot(current, "successor.localBefore");
    const operation = isTombstone(head.request.payload) && !isTombstone(payload)
      ? "restore"
      : "put";
    return {
      ownerId: owner.ownerId,
      bindingId: owner.bindingId,
      mutationId,
      status: "ready",
      entityType: "favorites",
      entityId: head.entityId,
      scope: "record",
      createdAt: new Date().toISOString(),
      localOperation,
      localBeforeSnapshot: before,
      localBeforeFingerprint: canonical.fingerprint(before),
      candidateFingerprint: canonical.fingerprint(payload),
      request: {
        mutationId,
        entityType: "favorites",
        entityId: head.entityId,
        scope: "record",
        schemaVersion: "1",
        operation,
        baseRevision: revision,
        observedCursor: null,
        payload
      },
      attemptedAt: null,
      attemptCount: 0,
      leaseToken: null,
      leaseExpiresAt: null,
      dependsOnMutationId: null
    };
  }

  function create(options = {}) {
    if (!isPlainObject(options) || typeof options.push !== "function") {
      throw new Error("Favorite Push Worker 缺少 push adapter。");
    }
    const canonical = getCanonical(options.canonical);
    const protocol = getProtocol(options.protocol);
    const state = getStateRepository(options.syncStateRepository);
    const favorites = getFavoriteRepository(options.favoriteRepository);
    const favoriteService = getFavoriteService(options.favoriteService);
    const push = options.push;

    async function release(owner, item) {
      return await state.releaseMutationLease({
        ownerId: owner.ownerId,
        bindingId: owner.bindingId,
        mutationId: item.mutationId,
        leaseToken: item.leaseToken
      });
    }

    async function retryableFailure(owner, item, reason, details = {}) {
      const released = await release(owner, item);
      return {
        status: "failed",
        reason,
        retryable: true,
        mutationId: item.mutationId,
        released: released.status === "released",
        ...details
      };
    }

    async function settleSuccess(owner, item, result) {
      const settlement = await state.withFavoriteWriterLock(owner, async () => {
        let current;
        try {
          current = favorites.getById(item.entityId, { includeDeleted: true });
        } catch (error) {
          return {
            status: "failed",
            reason: "favorite-storage-read-failed",
            message: error.message
          };
        }
        if (!current) return { status: "blocked", reason: "local-favorite-missing" };

        const listed = await state.listOutbox({
          ownerId: owner.ownerId,
          entityId: item.entityId
        });
        if (listed.status !== "ready") return listed;
        if (listed.items.some(value => value.bindingId !== owner.bindingId)) {
          return { status: "blocked", reason: "workspace-binding-mismatch" };
        }
        const head = listed.items.find(value => value.mutationId === item.mutationId);
        if (!head || !canonical.valuesEqual(head.request, item.request)) {
          return { status: "blocked", reason: "outbox-request-changed" };
        }
        const followers = listed.items.filter(value => value.mutationId !== item.mutationId);
        if (followers.length > 1 || followers.some(value => (
          value.status !== "ready" ||
          value.attemptedAt !== null ||
          value.dependsOnMutationId !== item.mutationId
        ))) {
          return { status: "blocked", reason: "successor-state-invalid" };
        }

        const successor = canonical.valuesEqual(current, item.request.payload)
          ? null
          : createSuccessorItem(
              canonical,
              owner,
              current,
              item,
              result.revision,
              followers[0]?.localOperation || "drift"
            );
        return await state.settleSuccessfulMutation({
          ownerId: owner.ownerId,
          bindingId: owner.bindingId,
          mutationId: item.mutationId,
          leaseToken: item.leaseToken,
          request: item.request,
          result,
          successor
        });
      });

      if (settlement.status !== "settled") {
        const released = await release(owner, item);
        return {
          ...settlement,
          retryable: true,
          mutationId: item.mutationId,
          released: released.status === "released"
        };
      }
      return {
        status: result.status,
        mutationId: item.mutationId,
        revision: result.revision,
        successor: settlement.successor
      };
    }

    async function settleIssue(owner, item, request, result) {
      const settlement = await state.withFavoriteWriterLock(owner, async () => (
        await state.settleMutationIssue({
          ownerId: owner.ownerId,
          bindingId: owner.bindingId,
          mutationId: item.mutationId,
          leaseToken: item.leaseToken,
          request,
          result
        })
      ));
      if (settlement.status !== "settled") {
        const released = await release(owner, item);
        return {
          ...settlement,
          retryable: true,
          mutationId: item.mutationId,
          released: released.status === "released"
        };
      }
      return {
        status: result.status,
        mutationId: item.mutationId,
        issue: settlement.issue
      };
    }

    async function runOnce(ownerValue, runOptions = {}) {
      let owner;
      try {
        owner = snapshotOwner(canonical, ownerValue);
      } catch (error) {
        return { status: "failed", reason: "invalid-owner-context", message: error.message };
      }

      const reconciled = await favoriteService.reconcile(owner);
      if (reconciled.status !== "ready") return reconciled;

      const leased = await state.acquireNextReadyMutationLease(owner, runOptions);
      if (leased.status !== "leased") return leased;
      const item = canonical.snapshot(leased.item, "leasedOutbox");
      const request = canonical.snapshot(item.request, "request");

      let rawResult;
      try {
        rawResult = await push(
          { ownerId: owner.ownerId },
          canonical.snapshot(request, "wireRequest")
        );
      } catch (error) {
        return await retryableFailure(owner, item, "push-transport-failed", {
          ...(error?.message ? { message: error.message } : {})
        });
      }

      let validation;
      try {
        validation = protocol.validateResult(rawResult);
      } catch (error) {
        return await retryableFailure(owner, item, "push-result-validation-failed", {
          ...(error?.message ? { message: error.message } : {})
        });
      }
      const identity = validateResultIdentity(validation, request);
      if (identity.status !== "ready") {
        return await retryableFailure(owner, item, identity.reason, {
          errors: Array.isArray(validation?.errors)
            ? canonical.snapshot(validation.errors)
            : []
        });
      }
      const result = canonical.snapshot(identity.result, "result");

      if (result.status === "applied" || result.status === "unchanged") {
        return await settleSuccess(owner, item, result);
      }

      return await settleIssue(owner, item, request, result);
    }

    return Object.freeze({ runOnce });
  }

  window.LingoFlowSyncFavoritePushWorker = Object.freeze({ create });
})();
