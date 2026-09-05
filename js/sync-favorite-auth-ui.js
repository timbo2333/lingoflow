(function() {
  "use strict";

  const PROMPT_SEEN_PREFIX = "lingoflowFavoriteActivationPromptSeen:";
  const auth = window.LingoFlowSupabaseAuth;
  const sync = window.LingoFlowFavoriteAppSync;
  let mode = "sign-in";
  let busy = false;

  function element(id) {
    return document.getElementById(id);
  }

  function setHidden(id, hidden) {
    const target = element(id);
    if (target) target.hidden = hidden;
  }

  function setFeedback(message, kind = "") {
    const target = element("authFeedback");
    if (!target) return;
    target.textContent = message || "";
    target.dataset.kind = kind;
  }

  function openModal() {
    element("authModal")?.classList.add("show");
    render();
  }

  function closeModal() {
    element("authModal")?.classList.remove("show");
  }

  function setMode(nextMode) {
    mode = nextMode === "sign-up" ? "sign-up" : "sign-in";
    element("authSignInMode")?.classList.toggle("active", mode === "sign-in");
    element("authSignUpMode")?.classList.toggle("active", mode === "sign-up");
    const password = element("authPassword");
    if (password) password.autocomplete = mode === "sign-in" ? "current-password" : "new-password";
    const submit = element("authSubmitButton");
    if (submit) submit.textContent = mode === "sign-in" ? "登录" : "注册";
    setFeedback("");
  }

  function authMessage(authState) {
    if (authState.status === "confirmation-required") {
      return "注册成功，请检查邮箱并点击确认链接，然后返回此页面登录。";
    }
    if (authState.status === "authenticating") return "正在确认账号状态…";
    if (authState.status === "paused") return "账号服务暂时不可用，本地收藏仍可正常使用。";
    if (authState.status === "failed") return authState.message || "账号操作失败，请重试。";
    if (authState.status === "unavailable") return "账号配置暂时不可用，本地功能不受影响。";
    return "";
  }

  function syncPresentation(syncState, authState) {
    const authenticated = authState.status === "authenticated";
    if (!authenticated) {
      if (["paused", "failed"].includes(authState.status)) {
        return { state: "unavailable", message: "同步暂时不可用" };
      }
      return { state: "local", message: "收藏仅保存在当前设备" };
    }
    if (syncState.status === "activation-required") {
      return { state: "pending", message: "等待确认本地收藏" };
    }
    if (syncState.reason === "activation-deferred") {
      return { state: "local", message: "收藏仅保存在当前设备" };
    }
    if (syncState.reason === "workspace-owner-mismatch" ||
        syncState.syncStatus === "attention") {
      return { state: "attention", message: "有收藏需要处理" };
    }
    if (syncState.status === "starting" || syncState.syncStatus === "syncing") {
      return { state: "syncing", message: "正在同步收藏…" };
    }
    if (syncState.syncStatus === "synced") {
      return { state: "synced", message: "收藏已同步" };
    }
    if (syncState.syncStatus === "pending") {
      return { state: "pending", message: "有待同步收藏" };
    }
    if (syncState.syncStatus === "unavailable" || syncState.status === "paused") {
      return { state: "unavailable", message: "同步暂时不可用" };
    }
    return { state: "unavailable", message: "收藏同步尚未启动" };
  }

  function maybePromptForActivation(syncState) {
    if (syncState.status !== "activation-required" || !syncState.ownerId) return;
    const key = `${PROMPT_SEEN_PREFIX}${syncState.ownerId}`;
    if (localStorage.getItem(key) === "1") return;
    localStorage.setItem(key, "1");
    openModal();
  }

  function render() {
    if (!auth || !sync) return;
    const authState = auth.getState();
    const syncState = sync.getState();
    const authenticated = authState.status === "authenticated";
    const presentation = syncPresentation(syncState, authState);
    setHidden("authSignedOutPanel", authenticated);
    setHidden("authSignedInPanel", !authenticated);

    const accountButton = element("accountButton");
    if (accountButton) {
      accountButton.textContent = authenticated ? "👤 已登录" : "👤 登录 / 注册";
    }
    const email = element("authUserEmail");
    if (email) email.textContent = authState.user?.email || "已登录";
    const syncSummary = element("authSyncSummary");
    if (syncSummary) syncSummary.textContent = presentation.message;
    const syncBadge = element("favoriteSyncStatusBadge");
    if (syncBadge) {
      syncBadge.textContent = presentation.message;
      syncBadge.dataset.state = presentation.state;
    }

    const canActivate = authenticated && (
      syncState.status === "activation-required" ||
      syncState.reason === "activation-deferred"
    );
    setHidden("workspaceActivationPanel", !canActivate);
    setHidden(
      "workspaceBlockedPanel",
      !(authenticated && syncState.reason === "workspace-owner-mismatch")
    );
    const activationMessage = element("workspaceActivationMessage");
    if (activationMessage && canActivate) {
      const count = Number(syncState.localFavoriteCount || 0);
      activationMessage.textContent = count > 0
        ? `检测到当前浏览器已有 ${count} 条本地收藏。只有你明确同意后，它们才会关联到此账号并上传。`
        : "确认后会为当前账号建立收藏同步工作区。";
    }

    const syncButton = element("authSyncNowButton");
    if (syncButton) {
      syncButton.textContent = ["pending", "unavailable"].includes(presentation.state)
        ? "重试同步"
        : "立即同步收藏";
      syncButton.disabled = busy || syncState.status !== "ready" ||
        ["syncing", "attention"].includes(presentation.state);
    }
    const signOutButton = element("authSignOutButton");
    if (signOutButton) signOutButton.disabled = busy;
    const submit = element("authSubmitButton");
    if (submit) submit.disabled = busy || authState.status === "authenticating";

    const message = authMessage(authState);
    if (message) setFeedback(message, authState.status === "failed" ? "error" : "info");
    maybePromptForActivation(syncState);
  }

  async function submitAuth(event) {
    event.preventDefault();
    if (busy || !auth) return;
    const email = element("authEmail")?.value || "";
    const passwordBox = element("authPassword");
    const password = passwordBox?.value || "";
    busy = true;
    setFeedback(mode === "sign-in" ? "正在登录…" : "正在注册…", "info");
    render();
    const result = mode === "sign-in"
      ? await auth.signIn({ email, password })
      : await auth.signUp({ email, password });
    if (passwordBox) passwordBox.value = "";
    if (result.status === "authenticated") {
      await sync.bootstrap();
      setFeedback("登录成功。", "success");
    }
    busy = false;
    render();
  }

  async function activateWorkspace() {
    if (busy) return;
    busy = true;
    setFeedback("正在关联本地收藏并启动同步…", "info");
    render();
    const result = await sync.activateWorkspace();
    busy = false;
    setFeedback(
      result.status === "ready" ? "本地收藏已关联，云同步已启动。" : "工作区关联失败，请稍后重试。",
      result.status === "ready" ? "success" : "error"
    );
    render();
  }

  function deferWorkspace() {
    sync.deferWorkspaceActivation();
    setFeedback("已暂不关联；本地收藏保持不变，也不会上传。", "info");
    render();
  }

  async function signOut() {
    if (busy) return;
    busy = true;
    setFeedback("正在退出登录…", "info");
    render();
    const result = await auth.signOut();
    busy = false;
    if (result.status === "signed-out") {
      sync.deactivate("auth-required");
      setFeedback("已退出登录；本地收藏和同步队列均已保留。", "success");
    }
    render();
  }

  async function syncNow() {
    if (busy || sync.getState().status !== "ready") return;
    busy = true;
    setFeedback("正在同步收藏…", "info");
    render();
    const result = await sync.syncNow();
    busy = false;
    setFeedback(
      result.status === "completed" ? "收藏同步完成。" : "同步暂未完成，稍后会继续重试。",
      result.status === "completed" ? "success" : "info"
    );
    render();
  }

  element("accountButton")?.addEventListener("click", openModal);
  element("authModalClose")?.addEventListener("click", closeModal);
  element("authModal")?.addEventListener("click", event => {
    if (event.target === element("authModal")) closeModal();
  });
  element("authSignInMode")?.addEventListener("click", () => setMode("sign-in"));
  element("authSignUpMode")?.addEventListener("click", () => setMode("sign-up"));
  element("authForm")?.addEventListener("submit", submitAuth);
  element("workspaceActivateButton")?.addEventListener("click", activateWorkspace);
  element("workspaceDeferButton")?.addEventListener("click", deferWorkspace);
  element("authSignOutButton")?.addEventListener("click", signOut);
  element("authSyncNowButton")?.addEventListener("click", syncNow);
  window.addEventListener("lingoflow:auth-state", render);
  window.addEventListener("lingoflow:favorite-sync-status", render);

  setMode("sign-in");
  render();
  void auth?.initialize().then(render);

  window.LingoFlowFavoriteAuthUI = Object.freeze({ open: openModal, render });
})();
