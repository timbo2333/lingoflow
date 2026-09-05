(function() {
  "use strict";

  const MAX_PUSHES_PER_RUN = 100;
  const MAX_INBOX_APPLIES_PER_RUN = 500;
  const MAX_SYNC_CYCLES_PER_RUN = 20;
  // TODO(V0.8): add snapshot/bootstrap when change-log retention or scale requires it.
  let runtime = null;
  let runtimeEpoch = 0;
  let bootstrapPromise = null;
  let configLoadPromise = null;
  let syncPromise = null;
  let syncRequested = false;
  let foregroundSyncScheduled = false;
  let state = Object.freeze({ status: "inactive", reason: "auth-required" });

  function isOpaqueString(value) {
    return typeof value === "string" && Boolean(value.trim()) && value === value.trim();
  }

  function setState(next) {
    state = Object.freeze({ ...next });
    window.dispatchEvent(new CustomEvent("lingoflow:favorite-sync-status", {
      detail: state
    }));
    return { ...state };
  }

  function getState() {
    return { ...state };
  }

  function resetRuntime() {
    runtimeEpoch += 1;
    runtime = null;
    syncRequested = false;
  }

  function deactivate(reason, details = {}) {
    resetRuntime();
    return setState({ status: "inactive", reason, ...details });
  }

  function readyState(active, syncStatus, durable = {}, details = {}) {
    return setState({
      status: "ready",
      syncStatus,
      ownerId: active.owner.ownerId,
      bindingId: active.owner.bindingId,
      outboxCount: durable.outboxCount || 0,
      inboxCount: durable.inboxCount || 0,
      pendingCount: durable.pendingCount || 0,
      issueCount: durable.issueCount || 0,
      ...details
    });
  }

  async function inspectDurableState(active) {
    const [outbox, inbox, issues] = await Promise.all([
      active.syncState.listOutbox({ ownerId: active.owner.ownerId }),
      active.syncState.listInbox(active.owner),
      active.syncState.listIssues(active.owner)
    ]);
    if (outbox.status !== "ready" || inbox.status !== "ready" || issues.status !== "ready") {
      const failedResult = [outbox, inbox, issues].find(result => result.status !== "ready");
      return {
        status: "failed",
        reason: failedResult?.reason || "sync-state-read-failed"
      };
    }
    const currentOutbox = outbox.items.filter(item => (
      item.bindingId === active.owner.bindingId
    ));
    return {
      status: "ready",
      outboxCount: currentOutbox.length,
      inboxCount: inbox.items.length,
      pendingCount: currentOutbox.length + inbox.items.length,
      issueCount: issues.issues.length
    };
  }

  function getDependencies() {
    const dependencies = {
      favorites: window.LingoFlowFavoriteRepository,
      learning: window.LingoFlowFavoriteLearningRepository,
      capture: window.LingoFlowSyncFavoriteService,
      learningCapture: window.LingoFlowSyncFavoriteLearningService,
      syncState: window.LingoFlowSyncStateRepository,
      pushFactory: window.LingoFlowSyncFavoritePushWorker,
      pullFactory: window.LingoFlowSyncFavoritePullWorker,
      supabase: window.LingoFlowSupabaseSyncService
    };
    if (!dependencies.favorites ||
        !dependencies.learning ||
        !dependencies.capture ||
        !dependencies.learningCapture ||
        typeof dependencies.syncState?.getWorkspaceBinding !== "function" ||
        typeof dependencies.pushFactory?.create !== "function" ||
        typeof dependencies.pullFactory?.create !== "function" ||
        typeof dependencies.supabase?.create !== "function") {
      throw new Error("Favorite App Sync dependencies 不可用。");
    }
    return dependencies;
  }

  function validateCloudConfig(config, options = {}) {
    if (!config || !isOpaqueString(config.projectUrl) ||
        !isOpaqueString(config.publishableKey) ||
        typeof options.getAccessToken !== "function") {
      throw new Error("Supabase Sync 配置无效。");
    }
    return {
      projectUrl: config.projectUrl,
      publishableKey: config.publishableKey,
      getAccessToken: options.getAccessToken
    };
  }

  function getDevConfig() {
    const config = window.LingoFlowSupabaseDevConfig;
    if (!config) return null;
    if ((config.expectedOwnerId !== undefined &&
          !isOpaqueString(config.expectedOwnerId)) ||
        typeof config.getAccessToken !== "function") {
      throw new Error("Supabase Dev Sync 配置无效。");
    }
    return validateCloudConfig(config, { getAccessToken: config.getAccessToken });
  }

  async function loadRequestedDevConfig() {
    if (window.LingoFlowSupabaseDevConfig) return;
    if (new URLSearchParams(window.location.search).get("supabase-sync") !== "dev") return;
    if (configLoadPromise) return await configLoadPromise;

    configLoadPromise = new Promise(resolve => {
      const script = document.createElement("script");
      script.src = "js/supabase-config.local.js";
      script.onload = () => resolve({ status: "loaded" });
      script.onerror = () => resolve({ status: "failed" });
      document.head.appendChild(script);
    });
    return await configLoadPromise;
  }

  async function verifyDevSession(config) {
    const rawConfig = window.LingoFlowSupabaseDevConfig;
    const accessToken = await config.getAccessToken();
    if (!isOpaqueString(accessToken)) {
      return { status: "inactive", reason: "access-token-unavailable" };
    }
    let response;
    try {
      response = await window.fetch(`${config.projectUrl.replace(/\/$/, "")}/auth/v1/user`, {
        headers: {
          apikey: config.publishableKey,
          Authorization: `Bearer ${accessToken}`
        }
      });
    } catch {
      return { status: "paused", reason: "auth-network-unavailable" };
    }
    if (!response?.ok || typeof response.json !== "function") {
      return { status: "inactive", reason: "auth-session-unavailable" };
    }
    let user;
    try {
      user = await response.json();
    } catch {
      return { status: "inactive", reason: "auth-session-invalid" };
    }
    if (!isOpaqueString(user?.id)) {
      return { status: "blocked", reason: "auth-owner-unavailable" };
    }
    if (rawConfig.expectedOwnerId && user.id !== rawConfig.expectedOwnerId) {
      return { status: "blocked", reason: "auth-owner-mismatch" };
    }
    return { status: "ready", ownerId: user.id, config };
  }

  async function resolveAuthenticatedSession() {
    await loadRequestedDevConfig();
    const devConfig = getDevConfig();
    if (devConfig) return await verifyDevSession(devConfig);

    const auth = window.LingoFlowSupabaseAuth;
    const productConfig = window.LingoFlowSupabaseConfig;
    if (!auth || !productConfig) {
      return { status: "inactive", reason: "auth-unavailable" };
    }
    const cloudConfig = validateCloudConfig(productConfig, {
      getAccessToken: (...args) => auth.getAccessToken(...args)
    });
    await auth.initialize();
    const session = await auth.getSessionContext();
    if (session.status !== "ready") {
      const status = session.status === "paused" ? "paused" : "inactive";
      return {
        status,
        reason: session.reason || "auth-required",
        ...(session.message ? { message: session.message } : {})
      };
    }
    if (!isOpaqueString(session.user?.id)) {
      return { status: "blocked", reason: "auth-owner-unavailable" };
    }
    return { status: "ready", ownerId: session.user.id, config: cloudConfig };
  }

  function createBindingId() {
    if (!window.crypto?.randomUUID) throw new Error("无法生成 Sync binding ID。");
    return `binding:${window.crypto.randomUUID()}`;
  }

  async function resolveWorkspace(dependencies, ownerId, allowActivation) {
    const current = await dependencies.syncState.getWorkspaceBinding();
    if (current.status === "ready") {
      if (current.binding.ownerId !== ownerId) {
        return { status: "blocked", reason: "workspace-owner-mismatch" };
      }
      return {
        status: "ready",
        owner: { ownerId, bindingId: current.binding.bindingId }
      };
    }
    if (current.status !== "missing") return current;

    let localFavoriteCount;
    try {
      localFavoriteCount = dependencies.favorites.count({ includeDeleted: true });
    } catch (error) {
      return {
        status: "blocked",
        reason: "favorite-storage-read-failed",
        message: error.message
      };
    }
    if (localFavoriteCount > 0 && !allowActivation) {
      return {
        status: "activation-required",
        reason: "anonymous-favorites-require-consent",
        ownerId,
        localFavoriteCount
      };
    }

    const owner = { ownerId, bindingId: createBindingId() };
    const binding = await dependencies.capture.bindWorkspace(owner);
    if (binding.status !== "bound" && binding.status !== "unchanged") {
      return {
        status: "blocked",
        reason: binding.reason || "workspace-binding-failed"
      };
    }
    return { status: "ready", owner };
  }

  async function startRuntime(options = {}) {
    const epoch = runtimeEpoch;
    let session;
    let dependencies;
    try {
      session = await resolveAuthenticatedSession();
      if (session.status !== "ready") return setState(session);
      dependencies = getDependencies();
    } catch (error) {
      return setState({
        status: "blocked",
        reason: "invalid-configuration",
        message: error.message
      });
    }
    if (epoch !== runtimeEpoch) return getState();

    setState({ status: "starting", ownerId: session.ownerId });
    const workspace = await resolveWorkspace(
      dependencies,
      session.ownerId,
      Boolean(options.allowActivation)
    );
    if (epoch !== runtimeEpoch) return getState();
    if (workspace.status === "activation-required") return setState(workspace);
    if (workspace.status !== "ready") {
      return setState({
        status: workspace.status === "paused" ? "paused" : "blocked",
        reason: workspace.reason || "workspace-unavailable",
        ...(workspace.message ? { message: workspace.message } : {})
      });
    }

    let adapter;
    try {
      adapter = dependencies.supabase.create({
        projectUrl: session.config.projectUrl,
        publishableKey: session.config.publishableKey,
        getAccessToken: (...args) => session.config.getAccessToken(...args)
      });
    } catch (error) {
      return setState({
        status: "blocked",
        reason: "adapter-unavailable",
        message: error.message
      });
    }

    const nextRuntime = {
      owner: workspace.owner,
      capture: dependencies.capture,
      learningCapture: dependencies.learningCapture,
      favorites: dependencies.favorites,
      learning: dependencies.learning,
      syncState: dependencies.syncState,
      push: dependencies.pushFactory.create({
        push: adapter.push,
        recordRepositories: {
          favorites: dependencies.favorites,
          favoriteLearningStates: dependencies.learning
        },
        reconcileServices: [dependencies.capture, dependencies.learningCapture]
      }),
      pull: dependencies.pullFactory.create({
        pull: adapter.pull,
        recordRepositories: {
          favorites: dependencies.favorites,
          favoriteLearningStates: dependencies.learning
        }
      })
    };
    runtime = nextRuntime;

    const reconciled = await nextRuntime.capture.reconcile(nextRuntime.owner);
    if (epoch !== runtimeEpoch || runtime !== nextRuntime) return getState();
    if (reconciled.status !== "ready") {
      runtime = null;
      return setState({
        status: "blocked",
        reason: reconciled.reason || "favorite-reconciliation-failed"
      });
    }
    const learningReconciled = await nextRuntime.learningCapture.reconcile(nextRuntime.owner);
    if (epoch !== runtimeEpoch || runtime !== nextRuntime) return getState();
    if (learningReconciled.status !== "ready") {
      runtime = null;
      return setState({
        status: "blocked",
        reason: learningReconciled.reason || "favorite-learning-reconciliation-failed"
      });
    }
    const durable = await inspectDurableState(nextRuntime);
    if (epoch !== runtimeEpoch || runtime !== nextRuntime) return getState();
    if (durable.status !== "ready") {
      return readyState(nextRuntime, "attention", {}, {
        reason: durable.reason
      });
    }
    const syncStatus = durable.issueCount > 0
      ? "attention"
      : durable.pendingCount > 0 ? "pending" : "synced";
    return readyState(nextRuntime, syncStatus, durable);
  }

  async function bootstrap() {
    if (state.status === "ready" && runtime) return getState();
    if (bootstrapPromise) return await bootstrapPromise;
    bootstrapPromise = startRuntime();
    try {
      return await bootstrapPromise;
    } finally {
      bootstrapPromise = null;
    }
  }

  async function activateWorkspace() {
    if (state.status === "ready" && runtime) return getState();
    if (bootstrapPromise) await bootstrapPromise;
    bootstrapPromise = startRuntime({ allowActivation: true });
    try {
      const result = await bootstrapPromise;
      if (result.status === "ready") void syncNow();
      return result;
    } finally {
      bootstrapPromise = null;
    }
  }

  function deferWorkspaceActivation() {
    if (state.status !== "activation-required") return getState();
    return deactivate("activation-deferred", {
      ownerId: state.ownerId,
      localFavoriteCount: state.localFavoriteCount
    });
  }

  function runLocalMutation(method, args) {
    const favorites = window.LingoFlowFavoriteRepository;
    if (!favorites || typeof favorites[method] !== "function") {
      throw new Error("Favorite Repository 写入边界不可用。");
    }
    const favorite = favorites[method](...args);
    return {
      status: favorite === null ? "missing" : "ready",
      favorite,
      mode: "local-only"
    };
  }

  function mutationWasLocallyCommitted(result) {
    return Boolean(result?.favorite || result?.favoriteLearningState) && [
      "ready",
      "unchanged",
      "local-committed-pending-reconciliation"
    ].includes(result.status);
  }

  async function continueAfterLocalMutation(active) {
    const durable = await inspectDurableState(active);
    if (runtime !== active) return;
    if (durable.status === "ready") {
      const syncStatus = durable.issueCount > 0
        ? "attention"
        : durable.pendingCount > 0 ? "pending" : "synced";
      readyState(active, syncStatus, durable);
    }
    await syncNow();
  }

  async function runMutation(method, args) {
    const active = runtime;
    if (state.status !== "ready" || !active) return runLocalMutation(method, args);
    const result = await active.capture[method](active.owner, ...args);
    if (runtime === active && mutationWasLocallyCommitted(result)) {
      void continueAfterLocalMutation(active);
    }
    return { ...result, mode: "sync" };
  }

  function runLocalLearningMutation(favoriteId, mastered) {
    const learning = window.LingoFlowFavoriteLearningRepository;
    if (!learning ||
        typeof learning.planSetMastered !== "function" ||
        typeof learning.commitPlannedMutation !== "function") {
      throw new Error("Favorite Learning Repository 写入边界不可用。");
    }
    const plan = learning.planSetMastered(favoriteId, mastered);
    if (plan === null) {
      return { status: "unchanged", favoriteLearningState: null, mode: "local-only" };
    }
    const committed = learning.commitPlannedMutation(plan);
    if (!["committed", "unchanged"].includes(committed.status)) {
      throw new Error(`Favorite Learning 本地写入失败：${committed.status}`);
    }
    return {
      status: committed.status === "committed" ? "ready" : "unchanged",
      favoriteLearningState: committed.favoriteLearningState,
      mode: "local-only"
    };
  }

  async function setMastered(favoriteId, mastered) {
    const active = runtime;
    if (state.status !== "ready" || !active) {
      return runLocalLearningMutation(favoriteId, mastered);
    }
    const result = await active.learningCapture.setMastered(
      active.owner,
      favoriteId,
      mastered
    );
    if (runtime === active && mutationWasLocallyCommitted(result)) {
      void continueAfterLocalMutation(active);
    }
    return { ...result, mode: "sync" };
  }

  async function drainPush(active) {
    const outcomes = [];
    for (let index = 0; index < MAX_PUSHES_PER_RUN; index += 1) {
      if (runtime !== active) return { status: "inactive", outcomes };
      const result = await active.push.runOnce(active.owner);
      outcomes.push(result);
      if (result.status === "applied" || result.status === "unchanged" ||
          result.status === "conflict" || result.status === "rejected") {
        continue;
      }
      return { status: result.status === "idle" ? "ready" : result.status, outcomes, result };
    }
    return { status: "blocked", reason: "push-drain-limit-reached", outcomes };
  }

  async function receiveAndApply(active) {
    if (runtime !== active) return { status: "inactive", applied: [] };
    const received = await active.pull.receiveOnce(active.owner);
    if (received.status !== "received") return { status: received.status, received, applied: [] };
    const applied = [];
    let favoritesChanged = false;
    for (let index = 0; index < MAX_INBOX_APPLIES_PER_RUN; index += 1) {
      if (runtime !== active) return { status: "inactive", received, applied };
      const result = await active.pull.applyNext(active.owner);
      if (result.status === "idle") {
        if (favoritesChanged) {
          window.dispatchEvent(new CustomEvent("lingoflow:favorite-sync-applied"));
        }
        return { status: "ready", received, applied };
      }
      applied.push(result);
      if (result.status === "applied" && result.written) favoritesChanged = true;
      if (!["applied", "unchanged", "conflict"].includes(result.status)) {
        return { status: result.status, received, applied, result };
      }
    }
    return { status: "blocked", reason: "inbox-drain-limit-reached", received, applied };
  }

  async function performSyncCycle(active) {
    if (runtime !== active) return { status: "inactive" };
    const pushed = await drainPush(active);
    if (runtime !== active) return { status: "inactive" };
    if (pushed.status !== "ready") {
      return { status: "pending", pushed, pulled: null };
    }
    const pulled = await receiveAndApply(active);
    if (runtime !== active) return { status: "inactive" };
    return pulled.status === "ready"
      ? { status: "completed", pushed, pulled }
      : { status: "pending", pushed, pulled };
  }

  function canContinueAfter(result) {
    return result?.pushed?.reason === "push-drain-limit-reached" ||
      result?.pulled?.reason === "inbox-drain-limit-reached";
  }

  async function prepareSync() {
    const started = state.status === "ready" && runtime ? getState() : await bootstrap();
    const active = runtime;
    if (started.status !== "ready" || !active) return started;
    return { status: "ready", active };
  }

  async function syncNow() {
    syncRequested = true;
    if (syncPromise) return await syncPromise;
    syncPromise = (async () => {
      const prepared = await prepareSync();
      if (prepared.status !== "ready") return prepared;
      const active = prepared.active;
      let result = null;
      let durable = await inspectDurableState(active);
      if (runtime !== active) return getState();
      if (durable.status !== "ready") {
        readyState(active, "attention", {}, { reason: durable.reason });
        return { status: "pending", reason: durable.reason };
      }
      readyState(active, "syncing", durable);

      for (let cycle = 0; cycle < MAX_SYNC_CYCLES_PER_RUN; cycle += 1) {
        syncRequested = false;
        result = await performSyncCycle(active);
        if (runtime !== active) return getState();
        durable = await inspectDurableState(active);
        if (runtime !== active) return getState();
        if (durable.status !== "ready") {
          readyState(active, "attention", {}, {
            reason: durable.reason,
            lastSync: result
          });
          return { status: "pending", reason: durable.reason, lastSync: result };
        }
        if (durable.issueCount > 0) {
          readyState(active, "attention", durable, { lastSync: result });
          return { status: "pending", reason: "sync-issues-present", lastSync: result };
        }
        if (result.status === "completed" && durable.pendingCount === 0 && !syncRequested) {
          readyState(active, "synced", durable, { lastSync: result });
          return result;
        }
        if (result.status === "completed" || canContinueAfter(result) || syncRequested) {
          readyState(active, "syncing", durable, { lastSync: result });
          continue;
        }
        readyState(active, "unavailable", durable, { lastSync: result });
        return result;
      }

      readyState(active, "pending", durable, {
        reason: "sync-cycle-limit-reached",
        lastSync: result
      });
      return { status: "pending", reason: "sync-cycle-limit-reached", lastSync: result };
    })();
    try {
      return await syncPromise;
    } finally {
      syncPromise = null;
    }
  }

  function requestForegroundSync() {
    if (document.visibilityState !== "visible" || foregroundSyncScheduled) return;
    foregroundSyncScheduled = true;
    queueMicrotask(() => {
      foregroundSyncScheduled = false;
      void bootstrap().then(result => {
        if (result.status === "ready") void syncNow();
      });
    });
  }

  async function create(input) {
    return await runMutation("create", [input]);
  }

  async function update(id, patch) {
    return await runMutation("update", [id, patch]);
  }

  async function softDelete(id) {
    return await runMutation("softDelete", [id]);
  }

  async function restore(id) {
    return await runMutation("restore", [id]);
  }

  window.addEventListener("lingoflow:auth-state", event => {
    if (window.LingoFlowSupabaseDevConfig) return;
    const authState = event.detail || {};
    if (authState.status === "authenticated") {
      if (runtime?.owner?.ownerId === authState.user?.id && state.status === "ready") return;
      if (bootstrapPromise) return;
      resetRuntime();
      void bootstrap().then(result => {
        if (result.status === "ready") void syncNow();
      });
      return;
    }
    if (["signed-out", "confirmation-required"].includes(authState.status)) {
      deactivate("auth-required");
    } else if (["paused", "failed", "unavailable"].includes(authState.status)) {
      deactivate(authState.reason || "auth-unavailable");
    }
  });

  window.addEventListener("online", () => {
    requestForegroundSync();
  });
  window.addEventListener("focus", requestForegroundSync);
  document.addEventListener("visibilitychange", requestForegroundSync);

  window.LingoFlowFavoriteAppSync = Object.freeze({
    bootstrap,
    activateWorkspace,
    deferWorkspaceActivation,
    deactivate,
    syncNow,
    getState,
    create,
    update,
    softDelete,
    restore,
    setMastered
  });
})();
