(function() {
  "use strict";

  const DEV_OVERRIDE_KEY = "lingoflow_article_sync_runtime_dev";
  // Keep the production rollout decision easy to reverse without changing sync state.
  const PRODUCTION_ROLLOUT_ENABLED = true;
  const PAGE_SIZE = 10;
  const POLL_INTERVAL_MS = 60_000;
  const MAX_PUSHES_PER_RUN = 200;
  const MAX_PULL_PAGES_PER_RUN = 200;

  function isDevOverrideEnabled() {
    try {
      return localStorage.getItem(DEV_OVERRIDE_KEY) === "1";
    } catch {
      return false;
    }
  }

  function getDefaultEnablement() {
    if (PRODUCTION_ROLLOUT_ENABLED) return { enabled: true, source: "production" };
    if (isDevOverrideEnabled()) return { enabled: true, source: "dev-override" };
    return { enabled: false, source: "production-disabled" };
  }

  function create(options = {}) {
    const getEnablement = typeof options.enablement === "function"
      ? options.enablement
      : typeof options.gateEnabled === "function"
        ? () => ({ enabled: Boolean(options.gateEnabled()), source: "injected" })
        : getDefaultEnablement;
    const gateEnabled = () => Boolean(getEnablement()?.enabled);
    let runtime = null;
    let generation = 0;
    let startPromise = null;
    let syncPromise = null;
    let syncRequested = false;
    let pollTimer = null;
    let lifecycleInstalled = false;
    let state = Object.freeze({ status: "inactive", reason: "feature-disabled" });

    function setState(next) {
      state = Object.freeze({ ...next });
      window.dispatchEvent(new CustomEvent("lingoflow:article-sync-status", {
        detail: { ...state }
      }));
      return { ...state };
    }

    function getState() {
      return { ...state, enablement: { ...getEnablement() } };
    }

    function getResolutionContext() {
      if (!gateEnabled() || !state.ownerId || !state.bindingId) {
        return { status: "inactive", generation, enablement: { ...getEnablement() } };
      }
      return {
        status: "ready",
        owner: { ownerId: state.ownerId, bindingId: state.bindingId },
        generation
      };
    }

    function isResolutionContextCurrent(context) {
      return Boolean(context && context.generation === generation &&
        context.owner?.ownerId === state.ownerId &&
        context.owner?.bindingId === state.bindingId);
    }

    function clearPolling() {
      if (pollTimer !== null) clearInterval(pollTimer);
      pollTimer = null;
    }

    function contextCurrent(active, epoch) {
      return runtime === active && generation === epoch &&
        active.owner.ownerId === state.ownerId && active.owner.bindingId === state.bindingId;
    }

    function stop(reason = "stopped") {
      generation += 1;
      runtime = null;
      syncRequested = false;
      clearPolling();
      return setState({ status: "inactive", reason });
    }

    function pause(reason = "paused") {
      clearPolling();
      if (!runtime) return setState({ status: "inactive", reason });
      void runtime.state.pauseArticleRuntime(
        runtime.owner.ownerId,
        runtime.owner.bindingId,
        reason
      );
      return setState({ ...runtime.owner, status: "paused", reason });
    }

    async function prepareAccountSwitch() {
      stop("account-switching");
      return getState();
    }

    function dependencies() {
      const deps = {
        auth: options.auth || window.LingoFlowSupabaseAuth,
        state: options.state || window.LingoFlowSyncStateRepository,
        repository: options.repository || window.LingoFlowArticleSyncRepository,
        localEngine: options.localEngine || window.LingoFlowArticleSyncLocalEngine?.create(),
        cloud: options.cloud || window.LingoFlowArticleSyncCloudService?.create(),
        bootstrap: options.bootstrap || window.LingoFlowArticleSyncBootstrapCoordinator?.create()
      };
      if (typeof deps.auth?.getSessionContext !== "function" ||
          typeof deps.state?.getWorkspaceBinding !== "function" ||
          typeof deps.repository?.getProjection !== "function" ||
          typeof deps.localEngine?.recoverPrepared !== "function" ||
          typeof deps.cloud?.pushArticleMutation !== "function" ||
          typeof deps.bootstrap?.run !== "function") {
        throw new Error("Article runtime dependencies 不完整。");
      }
      return deps;
    }

    async function resolveOwner(deps) {
      const authState = typeof deps.auth.getState === "function"
        ? deps.auth.getState()
        : null;
      let user;
      if (authState) {
        if (authState.status !== "authenticated" || !authState.user?.id) {
          return { status: "inactive", reason: authState.reason || "auth-required" };
        }
        user = authState.user;
      } else {
        const session = await deps.auth.getSessionContext();
        if (session?.status !== "ready" || !session.user?.id) {
          return { status: "inactive", reason: session?.reason || "auth-required" };
        }
        user = session.user;
      }
      const binding = await deps.state.getWorkspaceBinding();
      if (binding.status !== "ready") {
        return { status: "inactive", reason: binding.reason || "workspace-required" };
      }
      if (binding.binding.ownerId !== user.id) {
        return { status: "blocked", reason: "workspace-owner-mismatch" };
      }
      return {
        status: "ready",
        owner: {
          ownerId: user.id,
          bindingId: binding.binding.bindingId
        }
      };
    }

    function schedulePolling() {
      clearPolling();
      pollTimer = setInterval(() => {
        if (document.visibilityState === "visible" && runtime && state.status === "active") {
          requestSync("poll");
        }
      }, POLL_INTERVAL_MS);
    }

    async function performStart() {
      if (!gateEnabled()) return stop("feature-disabled");
      const epoch = ++generation;
      clearPolling();
      setState({ status: "starting", reason: "resolving-context" });
      let deps;
      try {
        deps = dependencies();
      } catch (error) {
        return setState({ status: "blocked", reason: "invalid-configuration", message: error.message });
      }
      const resolved = await resolveOwner(deps);
      if (generation !== epoch) return getState();
      if (resolved.status !== "ready") return setState(resolved);
      const owner = resolved.owner;
      const recovered = await deps.localEngine.recoverPrepared(owner);
      if (generation !== epoch) return getState();
      if (recovered.status !== "ready") {
        return setState({ status: "blocked", reason: recovered.reason || "article-wal-recovery-failed" });
      }
      let bootstrapState = await deps.state.getArticleBootstrapState(
        owner.ownerId,
        owner.bindingId
      );
      if (generation !== epoch) return getState();
      if (bootstrapState.status === "not_started" ||
          (bootstrapState.status === "ready" && bootstrapState.state.status === "in_progress")) {
        setState({ ...owner, status: "bootstrapping", reason: "article-bootstrap-required" });
        const bootstrapped = await deps.bootstrap.run(owner);
        if (generation !== epoch) return getState();
        if (bootstrapped.status !== "complete") {
          return setState({
            ...owner,
            status: bootstrapped.status === "blocked" ? "blocked" : "paused",
            reason: bootstrapped.reason || "article-bootstrap-incomplete"
          });
        }
        bootstrapState = await deps.state.getArticleBootstrapState(owner.ownerId, owner.bindingId);
      }
      if (bootstrapState.status !== "ready" || bootstrapState.state.status !== "complete") {
        return setState({
          ...owner,
          status: "blocked",
          reason: bootstrapState.state?.status === "blocked"
            ? "article-bootstrap-blocked"
            : "article-bootstrap-incomplete"
        });
      }
      const runtimeState = await deps.state.beginArticleRuntime(owner.ownerId, owner.bindingId);
      if (generation !== epoch) return getState();
      if (runtimeState.status !== "ready") {
        return setState({ ...owner, status: "blocked", reason: runtimeState.reason || "runtime-state-failed" });
      }
      const nextRuntime = { ...deps, owner, epoch };
      runtime = nextRuntime;
      setState({ ...owner, status: "starting", reason: "reconciling-local-state" });
      const reconciled = await deps.localEngine.reconcileRuntimeDesired(owner);
      if (!contextCurrent(nextRuntime, epoch)) return getState();
      if (reconciled.status !== "ready") {
        runtime = null;
        return setState({ ...owner, status: "blocked", reason: reconciled.reason || "local-reconcile-failed" });
      }
      setState({ ...owner, status: "active", reason: "ready", syncStatus: "pending" });
      schedulePolling();
      requestSync("runtime-start");
      return getState();
    }

    async function start() {
      if (!gateEnabled()) return stop("feature-disabled");
      if (runtime && ["active", "paused"].includes(state.status)) {
        if (state.status === "paused") {
          setState({ ...runtime.owner, status: "active", reason: "resuming", syncStatus: "pending" });
          schedulePolling();
          requestSync("resume");
        }
        return getState();
      }
      if (startPromise) return await startPromise;
      startPromise = performStart();
      try {
        return await startPromise;
      } finally {
        startPromise = null;
      }
    }

    async function ensureKnownLifecycle(active, promotion, epoch) {
      if (promotion.reason !== "article-remote-lifecycle-unknown" || !promotion.articleId) {
        return promotion;
      }
      const sidecar = await active.state.getArticleSidecar(
        active.owner.ownerId,
        active.owner.bindingId,
        promotion.articleId
      );
      if (sidecar.status !== "ready") return promotion;
      const snapshot = await active.cloud.snapshot(active.owner, promotion.articleId);
      if (!contextCurrent(active, epoch)) return { status: "discarded", reason: "generation-changed" };
      if (["unavailable"].includes(snapshot.status)) return snapshot;
      if (snapshot.status !== "found" || snapshot.revision !== sidecar.sidecar.knownRevision) {
        const local = await active.repository.getProjection(promotion.articleId);
        const captured = await active.state.captureArticleRuntimeIssue({
          ...active.owner,
          articleId: promotion.articleId,
          reason: "remote-lifecycle-ambiguous",
          localProjection: local,
          remoteProjection: snapshot.status === "found" ? snapshot.projection : null,
          remoteRevision: snapshot.status === "found" ? snapshot.revision : null,
          remoteCursor: snapshot.status === "found" ? snapshot.cursor : null,
          mutationId: null
        });
        return captured.status === "captured"
          ? { status: "blocked", reason: "remote-lifecycle-ambiguous" }
          : captured;
      }
      const written = await active.state.setArticleSidecarLifecycle(
        active.owner.ownerId,
        active.owner.bindingId,
        promotion.articleId,
        snapshot.revision,
        snapshot.lifecycle
      );
      return written.status === "ready"
        ? await active.state.promoteNextArticleDesired(
          active.owner.ownerId,
          active.owner.bindingId
        )
        : written;
    }

    async function capturePushIssue(active, mutation, result) {
      if (mutation.resolutionKind === "keep-local" &&
          typeof active.state.refreshArticleConflictIssue === "function") {
        return await active.state.refreshArticleConflictIssue({
          ...active.owner,
          articleId: mutation.articleId,
          remoteProjection: result.remoteProjection || null,
          remoteRevision: result.currentRevision || null,
          remoteCursor: result.remoteCursor || null
        });
      }
      return await active.state.captureArticleRuntimeIssue({
        ...active.owner,
        articleId: mutation.articleId,
        reason: result.reason || `push-${result.status}`,
        localProjection: await active.repository.getProjection(mutation.articleId),
        remoteProjection: result.remoteProjection || null,
        remoteRevision: result.currentRevision || null,
        remoteCursor: result.remoteCursor || null,
        mutationId: mutation.mutationId
      });
    }

    async function pushDrain(active, epoch) {
      const outcomes = [];
      for (let count = 0; count < MAX_PUSHES_PER_RUN; count += 1) {
        if (!contextCurrent(active, epoch)) return { status: "discarded", outcomes };
        if (navigator.onLine === false) {
          return { status: "unavailable", reason: "offline", outcomes };
        }
        const [items, issues] = await Promise.all([
          active.state.listArticleMutations(active.owner.ownerId, active.owner.bindingId),
          active.state.listArticleRuntimeIssues(active.owner.ownerId, active.owner.bindingId)
        ]);
        if (items.status !== "ready" || issues.status !== "ready") {
          return { status: "failed", reason: "article-runtime-state-unavailable", outcomes };
        }
        const blockedIds = new Set(issues.issues
          .filter(issue => issue.resolutionStatus !== "resolving")
          .map(issue => issue.articleId));
        let mutation = items.items.find(item => item.status === "ready" &&
          !blockedIds.has(item.articleId));
        if (!mutation) {
          let promoted = await active.state.promoteNextArticleDesired(
            active.owner.ownerId,
            active.owner.bindingId
          );
          if (promoted.status === "blocked") {
            promoted = await ensureKnownLifecycle(active, promoted, epoch);
          }
          if (["discarded"].includes(promoted.status)) continue;
          if (promoted.status === "idle" || promoted.status === "blocked") {
            return { status: "ready", outcomes };
          }
          if (promoted.status !== "ready") return { ...promoted, outcomes };
          mutation = promoted.mutation;
        }
        if (window.LingoFlowArticleSyncSize
          .validateArticleCloudSyncSize(mutation.candidate).status !== "valid") {
          const quarantined = await active.state.quarantineOversizedArticle(
            active.owner.ownerId, active.owner.bindingId, mutation.articleId
          );
          if (quarantined.status !== "quarantined") return { ...quarantined, outcomes };
          continue;
        }
        const attempted = await active.state.markArticleMutationAttempt(
          active.owner.ownerId,
          active.owner.bindingId,
          mutation.mutationId
        );
        if (attempted.status !== "ready") return { ...attempted, outcomes };
        if (!contextCurrent(active, epoch)) return { status: "discarded", outcomes };
        const result = await active.cloud.pushArticleMutation(active.owner, attempted.mutation);
        if (!contextCurrent(active, epoch)) return { status: "discarded", outcomes };
        outcomes.push(result);
        if (["applied", "unchanged"].includes(result.status)) {
          const settled = await active.state.settleArticleMutationSuccess(
            active.owner.ownerId,
            active.owner.bindingId,
            mutation.mutationId,
            result
          );
          if (settled.status !== "settled") return { ...settled, outcomes };
          continue;
        }
        if (["conflict", "rejected"].includes(result.status)) {
          const captured = await capturePushIssue(active, attempted.mutation, result);
          if (!["captured", "refreshed"].includes(captured.status)) {
            return { ...captured, outcomes };
          }
          continue;
        }
        return { ...result, outcomes };
      }
      return { status: "paused", reason: "push-drain-limit", outcomes };
    }

    function revisionNumber(value) {
      return window.LingoFlowArticleSyncCloudProtocol.revisionNumber(value);
    }

    async function capturePullIssue(active, change, reason, mutationId = null) {
      return await active.state.captureArticleRuntimeIssue({
        ...active.owner,
        articleId: change.articleId,
        reason,
        localProjection: await active.repository.getProjection(change.articleId),
        remoteProjection: change.projection,
        remoteRevision: change.revision,
        remoteCursor: change.cursor,
        mutationId
      });
    }

    async function applyPendingRuntimePage(active, epoch) {
      const pending = await active.state.listArticleRuntimePendingChanges(
        active.owner.ownerId,
        active.owner.bindingId
      );
      if (pending.status !== "ready") return pending;
      for (const change of pending.changes) {
        if (!contextCurrent(active, epoch)) return { status: "discarded" };
        const issues = await active.state.listArticleRuntimeIssues(
          active.owner.ownerId,
          active.owner.bindingId
        );
        if (issues.status !== "ready") return issues;
        if (issues.issues.some(issue => issue.articleId === change.articleId)) continue;
        const sidecarResult = await active.state.getArticleSidecar(
          active.owner.ownerId,
          active.owner.bindingId,
          change.articleId
        );
        if (!["ready", "missing"].includes(sidecarResult.status)) return sidecarResult;
        const knownRevision = sidecarResult.sidecar?.knownRevision || null;
        const knownNumber = knownRevision ? revisionNumber(knownRevision) : 0n;
        const remoteNumber = revisionNumber(change.revision);
        if (knownNumber !== null && remoteNumber <= knownNumber) continue;
        if (remoteNumber !== knownNumber + 1n) {
          const captured = await capturePullIssue(active, change, "remote-revision-gap");
          if (captured.status !== "captured") return captured;
          continue;
        }
        const mutations = await active.state.listArticleMutations(
          active.owner.ownerId,
          active.owner.bindingId
        );
        if (mutations.status !== "ready") return mutations;
        const pendingMutation = mutations.items.find(item => item.articleId === change.articleId &&
          ["prepared", "desired", "ready"].includes(item.status));
        if (pendingMutation) {
          const captured = await capturePullIssue(
            active,
            change,
            "remote-change-with-local-desired",
            pendingMutation.mutationId
          );
          if (captured.status !== "captured") return captured;
          continue;
        }
        const expected = await active.repository.getProjection(change.articleId);
        if (expected && window.LingoFlowArticleSyncSize
          .validateArticleCloudSyncSize(expected).status !== "valid") {
          const quarantined = await active.state.quarantineOversizedArticle(
            active.owner.ownerId, active.owner.bindingId, change.articleId, change
          );
          if (quarantined.status !== "quarantined") return quarantined;
          continue;
        }
        const applied = await active.repository.applyRemoteProjection({
          ...active.owner,
          remoteProjection: change.projection,
          expectedProjection: expected
        });
        if (applied.status !== "committed") {
          const captured = await capturePullIssue(
            active,
            change,
            applied.reason || "remote-apply-failed"
          );
          if (captured.status !== "captured") return captured;
          continue;
        }
        const remoteFingerprint = await window.LingoFlowArticleSyncLocalEngine
          .fingerprint(change.projection);
        const bound = await active.state.bindArticleRemoteRevision(
          active.owner.ownerId,
          active.owner.bindingId,
          change.articleId,
          change.revision,
          remoteFingerprint,
          change.projection.deletedAt === null ? "active" : "deleted"
        );
        if (bound.status !== "bound") {
          const captured = await capturePullIssue(
            active,
            change,
            bound.reason || "remote-bind-failed"
          );
          if (captured.status !== "captured") return captured;
        }
      }
      return await active.state.commitArticleRuntimePullPage(
        active.owner.ownerId,
        active.owner.bindingId
      );
    }

    async function pullDrain(active, epoch) {
      let pages = 0;
      while (pages < MAX_PULL_PAGES_PER_RUN) {
        if (!contextCurrent(active, epoch)) return { status: "discarded", pages };
        let runtimeState = await active.state.getArticleRuntimeState(
          active.owner.ownerId,
          active.owner.bindingId
        );
        if (runtimeState.status !== "ready") return runtimeState;
        if (runtimeState.state.pendingCursor !== null) {
          const committed = await applyPendingRuntimePage(active, epoch);
          if (committed.status !== "committed") return committed;
          pages += 1;
          if (!committed.hadMore) {
            return { status: "ready", pages, cursor: committed.state.cursor };
          }
          continue;
        }
        if (navigator.onLine === false) return { status: "unavailable", reason: "offline", pages };
        const page = await active.cloud.pullArticleChanges(
          active.owner,
          runtimeState.state.cursor,
          PAGE_SIZE
        );
        if (!contextCurrent(active, epoch)) return { status: "discarded", pages };
        if (page.status !== "ready") return { ...page, pages };
        const persisted = await active.state.persistArticleRuntimePullPage(
          active.owner.ownerId,
          active.owner.bindingId,
          runtimeState.state.cursor,
          page
        );
        if (persisted.status !== "persisted") return persisted;
        const committed = await applyPendingRuntimePage(active, epoch);
        if (committed.status !== "committed") return committed;
        pages += 1;
        if (!page.hasMore) return { status: "ready", pages, cursor: page.nextCursor };
        if (pages % 5 === 0) await new Promise(resolve => setTimeout(resolve, 0));
      }
      return { status: "paused", reason: "pull-page-limit", pages };
    }

    async function performSync(active, epoch) {
      setState({ ...active.owner, status: "active", reason: "syncing", syncStatus: "syncing" });
      const pushed = await pushDrain(active, epoch);
      if (!contextCurrent(active, epoch)) return pushed;
      if (pushed.status !== "ready") {
        if (["unavailable", "paused"].includes(pushed.status)) {
          await active.state.pauseArticleRuntime(
            active.owner.ownerId,
            active.owner.bindingId,
            pushed.reason || "push-unavailable"
          );
          setState({ ...active.owner, status: "paused", reason: pushed.reason || "push-unavailable" });
        }
        return pushed;
      }
      const pulled = await pullDrain(active, epoch);
      if (!contextCurrent(active, epoch)) return pulled;
      if (pulled.status === "ready") {
        setState({ ...active.owner, status: "active", reason: "ready", syncStatus: "synced" });
      } else if (["unavailable", "paused"].includes(pulled.status)) {
        await active.state.pauseArticleRuntime(
          active.owner.ownerId,
          active.owner.bindingId,
          pulled.reason || "pull-unavailable"
        );
        setState({ ...active.owner, status: "paused", reason: pulled.reason || "pull-unavailable" });
      }
      return { status: pulled.status, pushed, pulled };
    }

    async function syncNow() {
      const active = runtime;
      if (!active) return { status: "inactive", reason: state.reason };
      if (syncPromise) {
        syncRequested = true;
        return await syncPromise;
      }
      const epoch = generation;
      syncPromise = (async () => {
        let result;
        do {
          syncRequested = false;
          result = await performSync(active, epoch);
        } while (syncRequested && contextCurrent(active, epoch));
        return result;
      })();
      try {
        return await syncPromise;
      } finally {
        syncPromise = null;
      }
    }

    function requestSync() {
      if (!runtime) return false;
      syncRequested = true;
      queueMicrotask(() => {
        if (!runtime) return;
        if (state.status === "paused" && navigator.onLine !== false) {
          setState({ ...runtime.owner, status: "active", reason: "resuming", syncStatus: "pending" });
          schedulePolling();
        }
        if (state.status === "active") void syncNow();
      });
      return true;
    }

    function getWriteContext() {
      if (!gateEnabled() || !runtime || !["active", "paused"].includes(state.status)) {
        return { status: "inactive" };
      }
      return { status: "ready", owner: { ...runtime.owner }, generation };
    }

    function requestForegroundSync() {
      if (!gateEnabled() || document.visibilityState !== "visible") return;
      if (runtime) requestSync("foreground");
      else void start();
    }

    function installLifecycle() {
      if (lifecycleInstalled) return;
      lifecycleInstalled = true;
      if (options.listenAccountEvents !== false) {
        window.addEventListener("lingoflow:auth-state", event => {
          const authState = event.detail || {};
          if (authState.status === "authenticated") {
            void start();
          } else if (["signed-out", "confirmation-required"].includes(authState.status)) {
            stop("auth-required");
          } else if (authState.status === "paused") {
            pause(authState.reason || "auth-paused");
          } else if (["failed", "unavailable"].includes(authState.status)) {
            stop(authState.reason || "auth-unavailable");
          }
        });
        window.addEventListener("lingoflow:favorite-sync-status", event => {
          if (event.detail?.status === "ready") void start();
          if (event.detail?.reason === "account-switching") stop("account-switching");
        });
      }
      window.addEventListener("online", requestForegroundSync);
      window.addEventListener("focus", requestForegroundSync);
      document.addEventListener("visibilitychange", requestForegroundSync);
    }

    return Object.freeze({
      start,
      stop,
      prepareAccountSwitch,
      syncNow,
      requestSync,
      getWriteContext,
      getResolutionContext,
      isResolutionContextCurrent,
      getState,
      installLifecycle,
      constants: Object.freeze({
        DEV_OVERRIDE_KEY,
        PRODUCTION_ROLLOUT_ENABLED,
        PAGE_SIZE,
        POLL_INTERVAL_MS
      })
    });
  }

  const app = create();
  app.installLifecycle();
  window.LingoFlowArticleSyncApp = Object.freeze({ ...app, create });
})();
