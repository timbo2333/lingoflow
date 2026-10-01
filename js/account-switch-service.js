(function() {
  "use strict";

  const USER_STORAGE_KEYS = Object.freeze([
    "LingoFlowFavoriteEntities",
    "EnglishReaderV051Favorites",
    "EnglishReaderV05Vocab",
    "EnglishReaderV052QueryEvents",
    "EnglishReaderV052HistoryBaselines",
    "EnglishReaderV052HistoryMigrationState",
    "EnglishReaderV052ReadingPrefs"
  ]);
  const LEARNING_STORAGE_PREFIX = "LingoFlowFavoriteLearningState:";
  const ACTIVATION_PROMPT_PREFIX = "lingoflowFavoriteActivationPromptSeen:";
  const WORKSPACE_SWITCH_LOCK = "lingoflow:workspace-account-switch";

  function isOpaqueString(value) {
    return typeof value === "string" && Boolean(value.trim()) && value === value.trim();
  }

  function getDependencies() {
    const dependencies = {
      auth: window.LingoFlowSupabaseAuth,
      sync: window.LingoFlowFavoriteAppSync,
      articleSync: window.LingoFlowArticleSyncApp,
      syncState: window.LingoFlowSyncStateRepository,
      articles: window.LingoFlowArticleLibrary,
      backup: window.LingoFlowBackupV2Export
    };
    if (typeof dependencies.auth?.getSessionContext !== "function" ||
        typeof dependencies.sync?.prepareAccountSwitch !== "function" ||
        typeof dependencies.sync?.bootstrap !== "function" ||
        typeof dependencies.articleSync?.prepareAccountSwitch !== "function" ||
        typeof dependencies.syncState?.getWorkspaceBinding !== "function" ||
        typeof dependencies.syncState?.replaceWorkspaceBinding !== "function" ||
        typeof dependencies.articles?.getWorkspaceTransition !== "function" ||
        typeof dependencies.articles?.beginWorkspaceTransition !== "function" ||
        typeof dependencies.articles?.finishWorkspaceTransition !== "function" ||
        typeof dependencies.articles?.setAccountSwitchWriteBlocked !== "function") {
      throw new Error("账号切换依赖不可用。");
    }
    return dependencies;
  }

  function createBindingId() {
    if (!window.crypto?.randomUUID) throw new Error("无法生成 Workspace binding ID。");
    return `binding:${window.crypto.randomUUID()}`;
  }

  function storageKeysForOwner(ownerId) {
    const keys = new Set(USER_STORAGE_KEYS);
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(LEARNING_STORAGE_PREFIX)) keys.add(key);
    }
    if (isOpaqueString(ownerId)) keys.add(`${ACTIVATION_PROMPT_PREFIX}${ownerId}`);
    return Array.from(keys).sort();
  }

  function captureStorage(keys) {
    return keys.map(key => ({ key, value: localStorage.getItem(key) }));
  }

  function clearCapturedStorage(snapshot) {
    for (const item of snapshot) {
      if (localStorage.getItem(item.key) !== item.value) {
        throw new Error("本地用户数据在账号切换期间发生变化。");
      }
    }
    for (const item of snapshot) localStorage.removeItem(item.key);
  }

  function restoreCapturedStorage(snapshot) {
    for (const item of snapshot) {
      const current = localStorage.getItem(item.key);
      if (current !== null && current !== item.value) {
        throw new Error("账号切换期间本地用户数据发生变化，需要人工恢复。");
      }
    }
    const snapshotKeys = new Set(snapshot.map(item => item.key));
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(LEARNING_STORAGE_PREFIX) && !snapshotKeys.has(key)) {
        localStorage.removeItem(key);
      }
    }
    for (const item of snapshot) {
      if (item.value === null) localStorage.removeItem(item.key);
      else localStorage.setItem(item.key, item.value);
    }
  }

  function ensureCapturedStorageCleared(snapshot) {
    for (const item of snapshot) {
      const current = localStorage.getItem(item.key);
      if (current !== null && current !== item.value) {
        throw new Error("账号切换期间本地用户数据发生变化，需要人工恢复。");
      }
    }
    for (const item of snapshot) localStorage.removeItem(item.key);
  }

  async function exportBackupDownload(backup) {
    if (typeof backup?.exportBackup !== "function") {
      return { status: "failed", reason: "backup-unavailable" };
    }
    const result = await backup.exportBackup();
    if (result.status !== "ready" || !result.payload) {
      return { status: "failed", reason: result.reason || "backup-export-failed" };
    }
    const blob = new Blob([JSON.stringify(result.payload, null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `lingoflow-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return { status: "ready" };
  }

  let recoveryPromise = null;
  async function recoverTransitionUnderLock() {
    const articles = window.LingoFlowArticleLibrary;
    const syncState = window.LingoFlowSyncStateRepository;
    if (typeof articles?.getWorkspaceTransition !== "function" ||
        typeof articles?.finishWorkspaceTransition !== "function" ||
        typeof syncState?.getWorkspaceBinding !== "function") {
      return { status: "blocked", reason: "transition-dependencies-unavailable" };
    }
    const transition = await articles.getWorkspaceTransition();
    if (!transition) return { status: "ready" };
    const binding = await syncState.getWorkspaceBinding();
    if (binding.status !== "ready") return { status: "blocked", reason: "binding-unavailable" };
    const current = binding.binding;
    if (current.ownerId === transition.from.ownerId &&
        current.bindingId === transition.from.bindingId) {
      restoreCapturedStorage(transition.storageSnapshot);
      return await articles.finishWorkspaceTransition(transition.transitionId, "rollback");
    }
    if (current.ownerId === transition.to.ownerId &&
        current.bindingId === transition.to.bindingId) {
      ensureCapturedStorageCleared(transition.storageSnapshot);
      return await articles.finishWorkspaceTransition(transition.transitionId, "finalize");
    }
    return { status: "blocked", reason: "binding-transition-mismatch" };
  }

  async function recoverInterruptedSwitch() {
    if (recoveryPromise) return recoveryPromise;
    if (!window.navigator.locks?.request) {
      try {
        const transition = await window.LingoFlowArticleLibrary?.getWorkspaceTransition();
        return transition ? { status: "blocked", reason: "switch-lock-unavailable" }
          : { status: "ready" };
      } catch {
        return { status: "blocked", reason: "transition-recovery-failed" };
      }
    }
    recoveryPromise = window.navigator.locks.request(WORKSPACE_SWITCH_LOCK,
      recoverTransitionUnderLock).catch(() =>
      ({ status: "blocked", reason: "transition-recovery-failed" }));
    try { return await recoveryPromise; }
    finally { recoveryPromise = null; }
  }

  async function switchToCurrentAccount(options = {}) {
    let dependencies;
    try {
      dependencies = getDependencies();
    } catch (error) {
      return { status: "failed", reason: "switch-unavailable", message: error.message };
    }

    const recoveredBefore = await recoverInterruptedSwitch();
    if (!["ready", "rolled-back", "finalized"].includes(recoveredBefore.status)) {
      return { status: "failed", reason: "switch-recovery-required" };
    }
    if (!window.navigator.locks?.request) {
      return { status: "failed", reason: "switch-lock-unavailable" };
    }
    let session;
    let bindingResult;
    try {
      session = await dependencies.auth.getSessionContext();
      bindingResult = await dependencies.syncState.getWorkspaceBinding();
    } catch (error) {
      return { status: "failed", reason: "switch-preflight-failed", message: error.message };
    }
    if (session.status !== "ready" || !isOpaqueString(session.user?.id)) {
      return { status: "failed", reason: "auth-required" };
    }
    if (bindingResult.status !== "ready") {
      return { status: "failed", reason: "workspace-unavailable" };
    }
    const previousBinding = {
      ownerId: bindingResult.binding.ownerId,
      bindingId: bindingResult.binding.bindingId
    };
    if (previousBinding.ownerId === session.user.id) {
      return { status: "failed", reason: "workspace-already-current" };
    }

    try {
      if (typeof window.flushReadingProgress === "function") {
        await window.flushReadingProgress();
      }
      await window.LingoFlowProgressLocalDesired?.prepareAccountSwitch();
      if (options.backupFirst) {
        const backup = await exportBackupDownload(dependencies.backup);
        if (backup.status !== "ready") return backup;
      }
      await dependencies.articleSync.prepareAccountSwitch();
      await dependencies.sync.prepareAccountSwitch({
        ownerId: session.user.id,
        boundOwnerId: previousBinding.ownerId
      });
      dependencies.articles.setAccountSwitchWriteBlocked(true);
    } catch (error) {
      dependencies.articles.setAccountSwitchWriteBlocked(false);
      return { status: "failed", reason: "switch-preparation-failed", message: error.message };
    }

    let switchResult;
    try {
      switchResult = await window.navigator.locks.request(WORKSPACE_SWITCH_LOCK, async () => {
        let transitionStarted = false;
        try {
          const latestBinding = await dependencies.syncState.getWorkspaceBinding();
          if (latestBinding.status !== "ready" ||
              latestBinding.binding.ownerId !== previousBinding.ownerId ||
              latestBinding.binding.bindingId !== previousBinding.bindingId) {
            throw new Error("Workspace 关联在账号切换前已变化。");
          }
          const storageSnapshot = captureStorage(storageKeysForOwner(previousBinding.ownerId));
          const nextBinding = {
            ownerId: session.user.id,
            bindingId: createBindingId()
          };
          const transition = await dependencies.articles.beginWorkspaceTransition({
            from: previousBinding, to: nextBinding, storageSnapshot
          });
          if (transition.status !== "switching") {
            throw new Error("文章 Workspace 正在切换或归属已变化。");
          }
          transitionStarted = true;
          clearCapturedStorage(storageSnapshot);

          const replacement = await dependencies.syncState.replaceWorkspaceBinding({
            from: previousBinding,
            to: nextBinding,
            accountLabel: isOpaqueString(session.user.email) ? session.user.email : "当前账号"
          });
          if (replacement.status !== "replaced") {
            throw new Error("Workspace 关联未能安全切换。");
          }
          ensureCapturedStorageCleared(storageSnapshot);
          const finalized = await dependencies.articles.finishWorkspaceTransition(
            transition.transition.transitionId, "finalize");
          if (finalized.status !== "finalized") throw new Error("文章 Workspace finalize 未完成。");
          dependencies.articles.setAccountSwitchWriteBlocked(false);
          return { status: "switched", binding: replacement.binding };
        } catch (error) {
          const recovery = transitionStarted
            ? await recoverTransitionUnderLock().catch(() =>
              ({ status: "blocked", reason: "transition-recovery-failed" }))
            : { status: "ready" };
          if (recovery.status === "finalized") {
            dependencies.articles.setAccountSwitchWriteBlocked(false);
            return { status: "switched",
              binding: (await dependencies.syncState.getWorkspaceBinding()).binding };
          }
          const safe = ["ready", "rolled-back"].includes(recovery.status);
          if (safe) dependencies.articles.setAccountSwitchWriteBlocked(false);
          return {
            status: "failed",
            reason: safe ? "switch-failed" : "switch-recovery-required",
            message: error.message,
            restartOldSync: safe
          };
        }
      });
    } catch (error) {
      const recovery = await recoverInterruptedSwitch();
      const safe = ["ready", "rolled-back", "finalized"].includes(recovery.status);
      if (safe) dependencies.articles.setAccountSwitchWriteBlocked(false);
      return { status: "failed", reason: safe ? "switch-failed" : "switch-recovery-required",
        message: error.message };
    }
    if (switchResult.restartOldSync) {
      await dependencies.sync.bootstrap().catch(() => {});
      await dependencies.articleSync.start().catch(() => {});
      const { restartOldSync, ...result } = switchResult;
      return result;
    }
    return switchResult;
  }

  window.LingoFlowAccountSwitchService = Object.freeze({
    switchToCurrentAccount, recoverInterruptedSwitch
  });
  void recoverInterruptedSwitch();
})();
