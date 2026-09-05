(function() {
  "use strict";

  const MAX_PUSHES_PER_RUN = 100;
  const MAX_INBOX_APPLIES_PER_RUN = 500;
  let runtime = null;
  let runtimeEpoch = 0;
  let bootstrapPromise = null;
  let configLoadPromise = null;
  let syncPromise = null;
  let syncRequested = false;
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

  function getDependencies() {
    const dependencies = {
      favorites: window.LingoFlowFavoriteRepository,
      capture: window.LingoFlowSyncFavoriteService,
      syncState: window.LingoFlowSyncStateRepository,
      pushFactory: window.LingoFlowSyncFavoritePushWorker,
      pullFactory: window.LingoFlowSyncFavoritePullWorker,
      supabase: window.LingoFlowSupabaseSyncService
    };
    if (!dependencies.favorites ||
        !dependencies.capture ||
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
      favorites: dependencies.favorites,
      push: dependencies.pushFactory.create({ push: adapter.push }),
      pull: dependencies.pullFactory.create({ pull: adapter.pull })
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
    return setState({
      status: "ready",
      ownerId: nextRuntime.owner.ownerId,
      bindingId: nextRuntime.owner.bindingId
    });
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
    return Boolean(result?.favorite) && [
      "ready",
      "unchanged",
      "local-committed-pending-reconciliation"
    ].includes(result.status);
  }

  async function runMutation(method, args) {
    const active = runtime;
    if (state.status !== "ready" || !active) return runLocalMutation(method, args);
    const result = await active.capture[method](active.owner, ...args);
    if (runtime === active && mutationWasLocallyCommitted(result)) void syncNow();
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

  async function performSync() {
    const started = state.status === "ready" && runtime ? getState() : await bootstrap();
    const active = runtime;
    if (started.status !== "ready" || !active) return started;
    const pushed = await drainPush(active);
    if (runtime !== active) return getState();
    if (pushed.status !== "ready") {
      setState({ status: "ready", ownerId: active.owner.ownerId,
        bindingId: active.owner.bindingId, lastSync: pushed });
      return { status: "pending", pushed, pulled: null };
    }
    const pulled = await receiveAndApply(active);
    if (runtime !== active) return getState();
    setState({ status: "ready", ownerId: active.owner.ownerId,
      bindingId: active.owner.bindingId, lastSync: pulled });
    return pulled.status === "ready"
      ? { status: "completed", pushed, pulled }
      : { status: "pending", pushed, pulled };
  }

  async function syncNow() {
    syncRequested = true;
    if (syncPromise) return await syncPromise;
    syncPromise = (async () => {
      let result;
      do {
        syncRequested = false;
        result = await performSync();
      } while (syncRequested);
      return result;
    })();
    try {
      return await syncPromise;
    } finally {
      syncPromise = null;
    }
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
    void bootstrap().then(result => {
      if (result.status === "ready") void syncNow();
    });
  });

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
    restore
  });
})();
