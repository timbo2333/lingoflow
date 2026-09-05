(function() {
  "use strict";

  const BINDING_KEY_PREFIX = "lingoflowFavoriteSyncBinding:";
  const MAX_PUSHES_PER_RUN = 100;
  const MAX_INBOX_APPLIES_PER_RUN = 500;
  let runtime = null;
  let bootstrapPromise = null;
  let configLoadPromise = null;
  let syncPromise = null;
  let syncRequested = false;
  let state = Object.freeze({ status: "inactive", reason: "not-configured" });

  function isOpaqueString(value) {
    return typeof value === "string" && Boolean(value.trim()) && value === value.trim();
  }

  function setState(next) {
    state = Object.freeze({ ...next });
    window.dispatchEvent(new CustomEvent("lingoflow:favorite-sync-status", {
      detail: state
    }));
    return state;
  }

  function getState() {
    return { ...state };
  }

  function getDependencies() {
    const dependencies = {
      favorites: window.LingoFlowFavoriteRepository,
      capture: window.LingoFlowSyncFavoriteService,
      pushFactory: window.LingoFlowSyncFavoritePushWorker,
      pullFactory: window.LingoFlowSyncFavoritePullWorker,
      supabase: window.LingoFlowSupabaseSyncService
    };
    if (!dependencies.favorites ||
        !dependencies.capture ||
        typeof dependencies.pushFactory?.create !== "function" ||
        typeof dependencies.pullFactory?.create !== "function" ||
        typeof dependencies.supabase?.create !== "function") {
      throw new Error("Favorite App Sync dependencies 不可用。");
    }
    return dependencies;
  }

  function getDevConfig() {
    const config = window.LingoFlowSupabaseDevConfig;
    if (!config) return null;
    if (!isOpaqueString(config.projectUrl) ||
        !isOpaqueString(config.publishableKey) ||
        (config.expectedOwnerId !== undefined &&
          !isOpaqueString(config.expectedOwnerId)) ||
        typeof config.getAccessToken !== "function") {
      throw new Error("Supabase Dev Sync 配置无效。");
    }
    return config;
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

  function getOrCreateBindingId(ownerId) {
    const key = `${BINDING_KEY_PREFIX}${ownerId}`;
    const current = localStorage.getItem(key);
    if (isOpaqueString(current)) return current;
    if (!window.crypto?.randomUUID) throw new Error("无法生成 Sync binding ID。");
    const bindingId = `binding:${window.crypto.randomUUID()}`;
    localStorage.setItem(key, bindingId);
    return bindingId;
  }

  async function verifySession(config) {
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
      return { status: "inactive", reason: "auth-network-unavailable" };
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
    if (config.expectedOwnerId && user.id !== config.expectedOwnerId) {
      return { status: "blocked", reason: "auth-owner-mismatch" };
    }
    return { status: "ready", ownerId: user.id };
  }

  async function startRuntime() {
    let config;
    let dependencies;
    try {
      await loadRequestedDevConfig();
      config = getDevConfig();
      if (!config) return setState({ status: "inactive", reason: "not-configured" });
      dependencies = getDependencies();
    } catch (error) {
      return setState({
        status: "blocked",
        reason: "invalid-configuration",
        message: error.message
      });
    }

    setState({ status: "starting" });
    const session = await verifySession(config);
    if (session.status !== "ready") return setState(session);

    let owner;
    try {
      owner = {
        ownerId: session.ownerId,
        bindingId: getOrCreateBindingId(session.ownerId)
      };
    } catch (error) {
      return setState({
        status: "blocked",
        reason: "binding-unavailable",
        message: error.message
      });
    }

    const binding = await dependencies.capture.bindWorkspace(owner);
    if (binding.status !== "bound" && binding.status !== "unchanged") {
      return setState({
        status: "blocked",
        reason: binding.reason || "workspace-binding-failed"
      });
    }

    let adapter;
    try {
      adapter = dependencies.supabase.create({
        projectUrl: config.projectUrl,
        publishableKey: config.publishableKey,
        getAccessToken: (...args) => config.getAccessToken(...args)
      });
    } catch (error) {
      return setState({
        status: "blocked",
        reason: "adapter-unavailable",
        message: error.message
      });
    }

    runtime = {
      owner,
      capture: dependencies.capture,
      favorites: dependencies.favorites,
      push: dependencies.pushFactory.create({ push: adapter.push }),
      pull: dependencies.pullFactory.create({ pull: adapter.pull })
    };

    const reconciled = await runtime.capture.reconcile(owner);
    if (reconciled.status !== "ready") {
      return setState({
        status: "blocked",
        reason: reconciled.reason || "favorite-reconciliation-failed"
      });
    }
    return setState({ status: "ready", ownerId: owner.ownerId, bindingId: owner.bindingId });
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
    if (state.status !== "ready" || !runtime) {
      return runLocalMutation(method, args);
    }
    const result = await runtime.capture[method](runtime.owner, ...args);
    if (mutationWasLocallyCommitted(result)) void syncNow();
    return { ...result, mode: "sync" };
  }

  async function drainPush() {
    const outcomes = [];
    for (let index = 0; index < MAX_PUSHES_PER_RUN; index += 1) {
      const result = await runtime.push.runOnce(runtime.owner);
      outcomes.push(result);
      if (result.status === "applied" || result.status === "unchanged" ||
          result.status === "conflict" || result.status === "rejected") {
        continue;
      }
      return { status: result.status === "idle" ? "ready" : result.status, outcomes, result };
    }
    return { status: "blocked", reason: "push-drain-limit-reached", outcomes };
  }

  async function receiveAndApply() {
    const received = await runtime.pull.receiveOnce(runtime.owner);
    if (received.status !== "received") return { status: received.status, received, applied: [] };
    const applied = [];
    let favoritesChanged = false;
    for (let index = 0; index < MAX_INBOX_APPLIES_PER_RUN; index += 1) {
      const result = await runtime.pull.applyNext(runtime.owner);
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
    if (started.status !== "ready" || !runtime) return started;
    const pushed = await drainPush();
    if (pushed.status !== "ready") {
      setState({ status: "ready", ownerId: runtime.owner.ownerId,
        bindingId: runtime.owner.bindingId, lastSync: pushed });
      return { status: "pending", pushed, pulled: null };
    }
    const pulled = await receiveAndApply();
    setState({ status: "ready", ownerId: runtime.owner.ownerId,
      bindingId: runtime.owner.bindingId, lastSync: pulled });
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

  window.addEventListener("online", () => {
    void bootstrap().then(result => {
      if (result.status === "ready") void syncNow();
    });
  });

  window.LingoFlowFavoriteAppSync = Object.freeze({
    bootstrap,
    syncNow,
    getState,
    create,
    update,
    softDelete,
    restore
  });
})();
