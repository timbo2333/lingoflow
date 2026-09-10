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

  function isOpaqueString(value) {
    return typeof value === "string" && Boolean(value.trim()) && value === value.trim();
  }

  function getDependencies() {
    const dependencies = {
      auth: window.LingoFlowSupabaseAuth,
      sync: window.LingoFlowFavoriteAppSync,
      syncState: window.LingoFlowSyncStateRepository,
      articles: window.LingoFlowArticleLibrary,
      backup: window.LingoFlowBackupV2Export
    };
    if (typeof dependencies.auth?.getSessionContext !== "function" ||
        typeof dependencies.sync?.prepareAccountSwitch !== "function" ||
        typeof dependencies.sync?.bootstrap !== "function" ||
        typeof dependencies.syncState?.getWorkspaceBinding !== "function" ||
        typeof dependencies.syncState?.replaceWorkspaceBinding !== "function" ||
        typeof dependencies.articles?.listArticles !== "function" ||
        typeof dependencies.articles?.replaceAllArticles !== "function" ||
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

  async function rollbackUserAssets(dependencies, articleSnapshot, storageSnapshot) {
    let rollbackFailed = false;
    try {
      const articles = await dependencies.articles.replaceAllArticles([], articleSnapshot);
      if (articles.status !== "replaced") rollbackFailed = true;
    } catch {
      rollbackFailed = true;
    }
    try {
      restoreCapturedStorage(storageSnapshot);
    } catch {
      rollbackFailed = true;
    }
    return rollbackFailed ? "rollback-failed" : "rolled-back";
  }

  async function switchToCurrentAccount(options = {}) {
    let dependencies;
    try {
      dependencies = getDependencies();
    } catch (error) {
      return { status: "failed", reason: "switch-unavailable", message: error.message };
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
      if (options.backupFirst) {
        const backup = await exportBackupDownload(dependencies.backup);
        if (backup.status !== "ready") return backup;
      }
      await dependencies.sync.prepareAccountSwitch({
        ownerId: session.user.id,
        boundOwnerId: previousBinding.ownerId
      });
      dependencies.articles.setAccountSwitchWriteBlocked(true);
    } catch (error) {
      dependencies.articles.setAccountSwitchWriteBlocked(false);
      return { status: "failed", reason: "switch-preparation-failed", message: error.message };
    }

    let articleSnapshot = null;
    let storageSnapshot = null;
    let localAssetsCleared = false;
    try {
      articleSnapshot = await dependencies.articles.listArticles({ includeDeleted: true });
      storageSnapshot = captureStorage(storageKeysForOwner(previousBinding.ownerId));
      clearCapturedStorage(storageSnapshot);
      const articleResult = await dependencies.articles.replaceAllArticles(articleSnapshot, []);
      if (articleResult.status !== "replaced") {
        throw new Error("文章数据在账号切换期间发生变化。");
      }
      localAssetsCleared = true;

      const nextBinding = {
        ownerId: session.user.id,
        bindingId: createBindingId()
      };
      const replacement = await dependencies.syncState.replaceWorkspaceBinding({
        from: previousBinding,
        to: nextBinding,
        accountLabel: isOpaqueString(session.user.email) ? session.user.email : "当前账号"
      });
      if (replacement.status !== "replaced") {
        throw new Error("Workspace 关联未能安全切换。");
      }
      return { status: "switched", binding: replacement.binding };
    } catch (error) {
      let rollbackStatus = "not-needed";
      if (storageSnapshot) {
        rollbackStatus = localAssetsCleared
          ? await rollbackUserAssets(dependencies, articleSnapshot || [], storageSnapshot)
          : (() => {
              try {
                restoreCapturedStorage(storageSnapshot);
                return "rolled-back";
              } catch {
                return "rollback-failed";
              }
            })();
      }
      dependencies.articles.setAccountSwitchWriteBlocked(false);
      await dependencies.sync.bootstrap().catch(() => {});
      return {
        status: "failed",
        reason: rollbackStatus === "rollback-failed"
          ? "switch-rollback-failed"
          : "switch-failed",
        message: error.message
      };
    }
  }

  window.LingoFlowAccountSwitchService = Object.freeze({
    switchToCurrentAccount
  });
})();
