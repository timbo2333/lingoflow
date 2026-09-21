(function() {
  "use strict";

  const PAGE_SIZE = 10;

  function create(options = {}) {
    const state = options.state || window.LingoFlowSyncStateRepository;
    const repository = options.repository || window.LingoFlowArticleSyncRepository;
    const library = options.library || window.LingoFlowArticleLibrary;
    const projection = options.projection || window.LingoFlowArticleSyncProjection;
    const auth = options.auth || window.LingoFlowSupabaseAuth;
    const cloud = options.cloud || window.LingoFlowArticleSyncCloudService?.create();
    const localEngine = options.localEngine || window.LingoFlowArticleSyncLocalEngine?.create();
    const fingerprint = options.fingerprint || window.LingoFlowArticleSyncLocalEngine?.fingerprint;
    const hooks = options.hooks || {};
    let activeRun = null;
    if (!state || !repository || !library || !projection || !auth || !cloud ||
        !localEngine || typeof fingerprint !== "function") {
      throw new Error("Article Bootstrap dependencies 不完整。");
    }

    const metrics = {
      inventoryPages: 0,
      catchupPages: 0,
      uploaded: 0,
      hydrated: 0,
      exactMatches: 0,
      conflicts: 0,
      remoteBytes: 0
    };

    async function requireContext(owner) {
      const session = await auth.getSessionContext();
      if (session?.status !== "ready" || session.user?.id !== owner.ownerId) {
        return { status: "paused", reason: session?.status === "ready"
          ? "article-bootstrap-owner-mismatch" : "article-bootstrap-auth-unavailable" };
      }
      const binding = await state.getWorkspaceBinding();
      if (binding.status !== "ready" || binding.binding.ownerId !== owner.ownerId ||
          binding.binding.bindingId !== owner.bindingId) {
        return { status: "blocked", reason: "article-bootstrap-workspace-mismatch" };
      }
      return { status: "ready" };
    }

    function lifecycle(value) {
      if (!value) return "missing";
      return value.deletedAt === null ? "active" : "deleted";
    }

    async function captureIssue(owner, articleId, reason, localValue, remoteValue) {
      metrics.conflicts += 1;
      return await state.captureArticleBootstrapIssue({
        ownerId: owner.ownerId,
        bindingId: owner.bindingId,
        articleId,
        reason,
        localProjection: localValue,
        remoteProjection: remoteValue?.projection || null,
        remoteRevision: remoteValue?.revision || null,
        remoteLifecycle: remoteValue ? lifecycle(remoteValue.projection) : "missing"
      });
    }

    async function bindRemote(owner, remoteValue, localValue) {
      const result = await state.bindArticleRemoteRevision(
        owner.ownerId,
        owner.bindingId,
        remoteValue.articleId,
        remoteValue.revision,
        await fingerprint(remoteValue.projection)
      );
      if (result.status === "blocked" &&
          result.reason === "article-stale-remote-revision") {
        await captureIssue(
          owner,
          remoteValue.articleId,
          "ambiguous-local-state",
          localValue,
          remoteValue
        );
      }
      return result;
    }

    async function reconcileRemote(owner, remoteValue, pendingByArticle) {
      const articleId = remoteValue.articleId;
      const localValue = await repository.getProjection(articleId);
      if (pendingByArticle.has(articleId)) {
        await captureIssue(
          owner,
          articleId,
          "ambiguous-local-state",
          localValue || pendingByArticle.get(articleId).candidate,
          remoteValue
        );
        return { status: "blocked" };
      }
      if (!localValue) {
        const applied = await repository.applyRemoteProjection({
          ...owner,
          remoteProjection: remoteValue.projection,
          expectedProjection: null
        });
        if (applied.status !== "committed") {
          await captureIssue(
            owner,
            articleId,
            "ambiguous-local-state",
            await repository.getProjection(articleId),
            remoteValue
          );
          return { status: "blocked" };
        }
        await hooks.afterRemoteApply?.({ articleId, remote: remoteValue });
        const bound = await bindRemote(owner, remoteValue, remoteValue.projection);
        if (bound.status !== "bound") return bound;
        metrics.hydrated += 1;
        return { status: "reconciled", kind: "hydrated" };
      }
      if (projection.compareArticleSyncProjection(localValue, remoteValue.projection)) {
        const bound = await bindRemote(owner, remoteValue, localValue);
        if (bound.status !== "bound") return bound;
        metrics.exactMatches += 1;
        return { status: "reconciled", kind: "exact" };
      }
      const reason = lifecycle(localValue) === lifecycle(remoteValue.projection)
        ? "bootstrap-content-conflict"
        : "bootstrap-lifecycle-conflict";
      await captureIssue(owner, articleId, reason, localValue, remoteValue);
      return { status: "blocked" };
    }

    async function scanRemoteInventory(owner, current) {
      let stateValue = current;
      while (stateValue.phase === "remote-inventory") {
        const context = await requireContext(owner);
        if (context.status !== "ready") return context;
        const page = await cloud.pullArticleChanges(
          owner,
          stateValue.inventoryCursor,
          PAGE_SIZE
        );
        if (page.status === "unavailable") {
          await state.pauseArticleBootstrap(owner.ownerId, owner.bindingId, page.reason);
          return { status: "paused", reason: page.reason };
        }
        if (page.status !== "ready") {
          await state.pauseArticleBootstrap(owner.ownerId, owner.bindingId, "remote-inventory-rejected");
          return { status: "blocked", reason: "remote-inventory-rejected" };
        }
        await hooks.afterRemotePageFetch?.({ phase: "inventory", page });
        const persisted = await state.persistArticleBootstrapInventoryPage(
          owner.ownerId,
          owner.bindingId,
          stateValue.inventoryCursor,
          page
        );
        if (persisted.status !== "persisted") return persisted;
        metrics.inventoryPages += 1;
        metrics.remoteBytes += page.changes.reduce((total, change) => (
          total + new TextEncoder().encode(change.projection.content).length
        ), 0);
        await hooks.afterInventoryPersist?.({ page, state: persisted.state });
        stateValue = persisted.state;
      }
      return { status: "ready", state: stateValue };
    }

    async function reconcileInventory(owner) {
      const inventoryResult = await state.listArticleBootstrapInventory(
        owner.ownerId,
        owner.bindingId
      );
      if (inventoryResult.status !== "ready") return inventoryResult;
      const remoteById = new Map(inventoryResult.items.map(item => [item.articleId, item]));
      const localItems = await repository.listArticleProjections({ includeDeleted: true });
      const localById = new Map(localItems.map(item => [item.id, item]));
      const outbox = await state.listArticleMutations(owner.ownerId, owner.bindingId);
      if (outbox.status !== "ready") return outbox;
      const ambiguous = outbox.items.find(item => item.status === "issue");
      if (ambiguous) {
        await captureIssue(
          owner,
          ambiguous.articleId,
          "ambiguous-local-state",
          ambiguous.candidate,
          remoteById.get(ambiguous.articleId) || null
        );
        return { status: "blocked", reason: "ambiguous-local-state" };
      }
      const pendingByArticle = new Map(outbox.items
        .filter(item => ["prepared", "ready"].includes(item.status))
        .map(item => [item.articleId, item]));
      const ids = Array.from(new Set([...localById.keys(), ...remoteById.keys()])).sort();
      for (const articleId of ids) {
        const context = await requireContext(owner);
        if (context.status !== "ready") return context;
        const localValue = localById.get(articleId) || null;
        const remoteValue = remoteById.get(articleId) || null;
        let result;
        if (remoteValue) {
          result = await reconcileRemote(owner, remoteValue, pendingByArticle);
        } else if (localValue && !pendingByArticle.has(articleId)) {
          result = await localEngine.captureBootstrapArticle(articleId, owner);
          if (!["ready", "existing"].includes(result.status)) {
            await captureIssue(
              owner,
              articleId,
              "ambiguous-local-state",
              localValue,
              null
            );
            return { status: "blocked", reason: "ambiguous-local-state" };
          }
          if (result.status === "ready") metrics.uploaded += 1;
        } else {
          result = { status: "existing" };
        }
        if (result.status === "blocked") return result;
        await hooks.afterReconcileItem?.({ articleId, result });
      }
      const issues = await state.listArticleBootstrapIssues(owner.ownerId, owner.bindingId);
      if (issues.status !== "ready") return issues;
      if (issues.issues.length > 0) return { status: "blocked", reason: "bootstrap-issues" };
      return await state.transitionArticleBootstrap(
        owner.ownerId,
        owner.bindingId,
        "settling-outgoing"
      );
    }

    async function settleOutgoing(owner) {
      while (true) {
        const context = await requireContext(owner);
        if (context.status !== "ready") return context;
        const outbox = await state.listArticleMutations(owner.ownerId, owner.bindingId);
        if (outbox.status !== "ready") return outbox;
        const ambiguous = outbox.items.find(item => item.status === "issue");
        if (ambiguous) {
          await captureIssue(
            owner,
            ambiguous.articleId,
            "ambiguous-local-state",
            ambiguous.candidate,
            null
          );
          return { status: "blocked", reason: "ambiguous-local-state" };
        }
        const mutation = outbox.items.find(item => item.status === "ready");
        if (!mutation) break;
        const result = await cloud.pushArticleMutation(owner, mutation);
        if (result.status === "unavailable") {
          await state.pauseArticleBootstrap(owner.ownerId, owner.bindingId, result.reason);
          return { status: "paused", reason: result.reason };
        }
        if (!["applied", "unchanged"].includes(result.status)) {
          await captureIssue(
            owner,
            mutation.articleId,
            result.status === "conflict" ? "bootstrap-content-conflict" : "bootstrap-push-rejected",
            mutation.candidate,
            result.remoteProjection ? {
              articleId: mutation.articleId,
              projection: result.remoteProjection,
              revision: result.currentRevision
            } : null
          );
          return { status: "blocked", reason: result.reason || "bootstrap-push-rejected" };
        }
        await hooks.afterOutgoingAck?.({ mutation, result });
        const settled = await state.settleArticleMutationSuccess(
          owner.ownerId,
          owner.bindingId,
          mutation.mutationId,
          result
        );
        if (settled.status !== "settled") return settled;
      }
      return await state.transitionArticleBootstrap(
        owner.ownerId,
        owner.bindingId,
        "catching-up"
      );
    }

    async function reconcilePendingPage(owner) {
      const pending = await state.listArticleBootstrapPendingChanges(
        owner.ownerId,
        owner.bindingId
      );
      if (pending.status !== "ready") return pending;
      const outbox = await state.listArticleMutations(owner.ownerId, owner.bindingId);
      if (outbox.status !== "ready") return outbox;
      const pendingByArticle = new Map(outbox.items
        .filter(item => ["prepared", "ready"].includes(item.status))
        .map(item => [item.articleId, item]));
      const latestById = new Map();
      for (const change of pending.changes) latestById.set(change.articleId, change);
      for (const change of latestById.values()) {
        const context = await requireContext(owner);
        if (context.status !== "ready") return context;
        const result = await reconcileRemote(owner, change, pendingByArticle);
        if (result.status === "blocked") return result;
      }
      const committed = await state.commitArticleBootstrapCatchupPage(
        owner.ownerId,
        owner.bindingId
      );
      if (committed.status === "committed") {
        await hooks.afterCursorPersist?.({ state: committed.state });
      }
      return committed;
    }

    async function catchUp(owner, current) {
      let stateValue = current;
      while (stateValue.phase === "catching-up") {
        if (stateValue.pendingCursor === null) {
          const context = await requireContext(owner);
          if (context.status !== "ready") return context;
          const page = await cloud.pullArticleChanges(owner, stateValue.finalCursor, PAGE_SIZE);
          if (page.status === "unavailable") {
            await state.pauseArticleBootstrap(owner.ownerId, owner.bindingId, page.reason);
            return { status: "paused", reason: page.reason };
          }
          if (page.status !== "ready") {
            await state.pauseArticleBootstrap(owner.ownerId, owner.bindingId, "catchup-rejected");
            return { status: "blocked", reason: "catchup-rejected" };
          }
          await hooks.afterRemotePageFetch?.({ phase: "catchup", page });
          const persisted = await state.persistArticleBootstrapCatchupPage(
            owner.ownerId,
            owner.bindingId,
            stateValue.finalCursor,
            page
          );
          if (persisted.status !== "persisted") return persisted;
          metrics.catchupPages += 1;
          metrics.remoteBytes += page.changes.reduce((total, change) => (
            total + new TextEncoder().encode(change.projection.content).length
          ), 0);
          stateValue = persisted.state;
        }
        const committed = await reconcilePendingPage(owner);
        if (committed.status !== "committed") return committed;
        stateValue = committed.state;
      }
      return { status: "ready", state: stateValue };
    }

    async function perform(owner) {
      if (!owner || typeof owner.ownerId !== "string" ||
          typeof owner.bindingId !== "string") {
        return { status: "blocked", reason: "invalid-owner-context" };
      }
      const context = await requireContext(owner);
      if (context.status !== "ready") return context;
      const started = await state.beginArticleBootstrap(owner.ownerId, owner.bindingId);
      if (started.status !== "ready") return started;
      if (started.state.status === "complete") {
        return { status: "complete", state: started.state, metrics: { ...metrics } };
      }
      if (started.state.status === "blocked") {
        return { status: "blocked", reason: started.state.lastError, state: started.state };
      }
      const recovered = await localEngine.recoverPrepared(owner);
      if (recovered.status !== "ready") return recovered;
      let current = (await state.getArticleBootstrapState(owner.ownerId, owner.bindingId)).state;
      if (current.phase === "remote-inventory") {
        const scanned = await scanRemoteInventory(owner, current);
        if (scanned.status !== "ready") return scanned;
        current = scanned.state;
      }
      if (current.phase === "reconciling") {
        const reconciled = await reconcileInventory(owner);
        if (reconciled.status !== "ready") return reconciled;
        current = reconciled.state;
      }
      if (current.phase === "settling-outgoing") {
        const settled = await settleOutgoing(owner);
        if (settled.status !== "ready") return settled;
        current = settled.state;
      }
      if (current.phase === "catching-up") {
        const caughtUp = await catchUp(owner, current);
        if (caughtUp.status !== "ready") return caughtUp;
        current = caughtUp.state;
      }
      if (current.phase !== "finalizing") {
        return { status: "blocked", reason: "article-bootstrap-unexpected-phase", state: current };
      }
      const completed = await state.completeArticleBootstrap(owner.ownerId, owner.bindingId);
      return completed.status === "complete"
        ? { ...completed, metrics: { ...metrics } }
        : completed;
    }

    async function run(owner) {
      if (activeRun) return await activeRun;
      activeRun = perform(owner);
      try {
        return await activeRun;
      } finally {
        activeRun = null;
      }
    }

    return Object.freeze({ run });
  }

  // A4.1 is manual/dev only. No coordinator instance is created by normal startup.
  window.LingoFlowArticleSyncBootstrapCoordinator = Object.freeze({ create, PAGE_SIZE });
})();
