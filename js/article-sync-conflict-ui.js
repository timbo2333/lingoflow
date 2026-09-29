(function() {
  "use strict";

  let busyArticleId = null;
  let lastIssues = [];

  function element(id) {
    return document.getElementById(id);
  }

  function setFeedback(message, state = "info") {
    const target = element("articleSyncConflictFeedback");
    if (!target) return;
    target.textContent = message || "";
    target.dataset.state = state;
  }

  function issueMessage(issue) {
    if (issue.remoteProjection?.deletedAt) {
      return "另一台设备已删除这篇文章。本机内容仍然保留。";
    }
    if (issue.localProjection?.deletedAt) {
      return "本机已删除，但云端仍有更新版本。";
    }
    if (issue.reason === "remote-changed-during-resolution") {
      return "云端版本刚刚发生变化，请重新确认要保留的版本。";
    }
    return "这篇文章在另一台设备上也发生了修改。";
  }

  function projectionPreview(label, projection) {
    const wrapper = document.createElement("div");
    wrapper.className = "articleConflictVersion";
    const heading = document.createElement("strong");
    heading.textContent = label;
    const title = document.createElement("span");
    title.textContent = projection?.deletedAt
      ? "已删除"
      : (projection?.title || "暂无版本内容");
    const content = document.createElement("p");
    content.textContent = projection?.deletedAt
      ? "此版本已被移入最近删除。"
      : String(projection?.content || "").trim().slice(0, 180) || "暂无正文预览";
    wrapper.append(heading, title, content);
    return wrapper;
  }

  function renderIssues(issues) {
    lastIssues = issues;
    const list = element("articleSyncConflictList");
    if (!list) return;
    list.replaceChildren();
    if (!issues.length) {
      const empty = document.createElement("p");
      empty.className = "articleSyncConflictEmpty";
      empty.textContent = "目前没有需要处理的文章。";
      list.append(empty);
      return;
    }
    for (const issue of issues) {
      const item = document.createElement("article");
      item.className = "articleSyncConflictItem";
      const title = document.createElement("h3");
      title.textContent = issue.localProjection?.title ||
        issue.remoteProjection?.title || "未命名文章";
      const message = document.createElement("p");
      message.className = "articleSyncConflictReason";
      message.textContent = issueMessage(issue);
      const versions = document.createElement("div");
      versions.className = "articleConflictVersions";
      versions.append(
        projectionPreview("本机版本", issue.localProjection),
        projectionPreview("云端版本", issue.remoteProjection)
      );
      const actions = document.createElement("div");
      actions.className = "articleSyncConflictActions";
      const keepLocal = document.createElement("button");
      keepLocal.type = "button";
      keepLocal.textContent = busyArticleId === issue.articleId
        ? "正在处理…"
        : "保留本机版本";
      keepLocal.disabled = busyArticleId !== null;
      keepLocal.addEventListener("click", () => resolve(issue.articleId, "keep-local"));
      const useRemote = document.createElement("button");
      useRemote.type = "button";
      useRemote.className = "secondary";
      useRemote.textContent = "使用云端版本";
      useRemote.disabled = busyArticleId !== null;
      useRemote.addEventListener("click", () => resolve(issue.articleId, "use-remote"));
      actions.append(keepLocal, useRemote);
      item.append(title, message, versions, actions);
      list.append(item);
    }
  }

  function statusPresentation(appState, issueCount) {
    if (issueCount > 0) {
      return { state: "attention", text: `需要处理（${issueCount}）` };
    }
    if (!appState.enablement?.enabled || appState.reason === "feature-disabled") {
      return { state: "disabled", text: "未启用" };
    }
    if (appState.status === "inactive") {
      return appState.reason === "workspace-required"
        ? { state: "waiting", text: "待关联" }
        : { state: "waiting", text: "登录后同步" };
    }
    if (appState.status === "blocked") {
      return { state: "attention", text: appState.reason === "workspace-owner-mismatch"
        ? "账号待处理" : "同步受阻" };
    }
    if (["starting", "bootstrapping"].includes(appState.status)) {
      return { state: "preparing", text: "正在准备" };
    }
    if (appState.syncStatus === "syncing") {
      return { state: "syncing", text: "正在同步" };
    }
    if (appState.status === "paused" || appState.reason === "offline") {
      return { state: "waiting", text: "离线，等待同步" };
    }
    if (appState.status === "active" && appState.syncStatus === "synced") {
      return { state: "synced", text: "已同步" };
    }
    if (appState.status === "active") {
      return { state: "syncing", text: "正在同步" };
    }
    return { state: "preparing", text: "正在准备" };
  }

  async function refreshPresentation() {
    const app = window.LingoFlowArticleSyncApp;
    const service = window.LingoFlowArticleSyncConflictService;
    if (!app || !service) return;
    const listed = await service.listIssues();
    const issues = listed.status === "ready" ? listed.issues : [];
    const presentation = statusPresentation(app.getState(), issues.length);
    for (const status of [
      element("settingsArticleSyncStatus"),
      element("authArticleSyncStatus")
    ].filter(Boolean)) {
      status.textContent = presentation.text;
      status.dataset.state = presentation.state;
    }
    for (const button of [
      element("settingsArticleSyncIssuesButton"),
      element("authArticleSyncIssuesButton")
    ].filter(Boolean)) {
      button.hidden = issues.length === 0;
      button.textContent = issues.length === 1
        ? "处理 1 篇文章"
        : `处理 ${issues.length} 篇文章`;
    }
    if (element("articleSyncConflictModal")?.classList.contains("show")) {
      renderIssues(issues);
      if (!issues.length) setFeedback("文章同步问题已处理完成。", "success");
    }
  }

  async function openConflictPanel(event) {
    const listed = await window.LingoFlowArticleSyncConflictService?.listIssues?.();
    if (listed?.status !== "ready") return;
    renderIssues(listed.issues);
    setFeedback("");
    closeModal("settingsModal", { restoreFocus: false });
    closeModal("authModal", { restoreFocus: false });
    openModal("articleSyncConflictModal", {
      trigger: event?.currentTarget || element("settingsArticleSyncIssuesButton"),
      initialFocus: "#articleSyncConflictModalClose"
    });
  }

  function closeConflictPanel() {
    closeModal("articleSyncConflictModal");
    busyArticleId = null;
    setFeedback("");
  }

  async function resolve(articleId, action) {
    if (busyArticleId) return;
    busyArticleId = articleId;
    renderIssues(lastIssues);
    setFeedback(action === "keep-local"
      ? "正在保留本机版本…"
      : "正在确认并使用云端版本…");
    const service = window.LingoFlowArticleSyncConflictService;
    const result = action === "keep-local"
      ? await service.keepLocal(articleId)
      : await service.useRemote(articleId);
    busyArticleId = null;
    if (result.status === "resolved") {
      setFeedback("这篇文章已处理，文章同步将继续。", "success");
    } else if (result.status === "waiting") {
      setFeedback("已保存你的选择，联网后会继续同步。", "info");
    } else if (result.status === "stale") {
      setFeedback("云端版本刚刚发生变化，请查看更新后的内容并重新确认。", "info");
    } else if (result.reason === "online-verification-required") {
      setFeedback("需要联网确认最新云端版本，请联网后重试。", "info");
    } else if (result.status === "discarded") {
      closeConflictPanel();
      return;
    } else {
      setFeedback("暂时无法完成处理。本机内容和待处理状态均已保留。", "error");
    }
    await refreshPresentation();
  }

  element("settingsArticleSyncIssuesButton")?.addEventListener("click", openConflictPanel);
  element("authArticleSyncIssuesButton")?.addEventListener("click", openConflictPanel);
  element("articleSyncConflictModalClose")?.addEventListener("click", closeConflictPanel);
  window.addEventListener("lingoflow:article-sync-status", event => {
    if (["account-switching", "auth-required"].includes(event.detail?.reason)) {
      if (element("articleSyncConflictModal")?.classList.contains("show")) {
        closeConflictPanel();
      }
    }
    void refreshPresentation();
  });
  window.addEventListener("lingoflow:article-sync-issues-changed", () => {
    void refreshPresentation();
  });
  window.addEventListener("lingoflow:auth-state", event => {
    if (event.detail?.status !== "authenticated" &&
        element("articleSyncConflictModal")?.classList.contains("show")) {
      closeConflictPanel();
    }
    void refreshPresentation();
  });
  setTimeout(() => { void refreshPresentation(); }, 0);

  window.LingoFlowArticleSyncConflictUI = Object.freeze({
    open: openConflictPanel,
    close: closeConflictPanel,
    refresh: refreshPresentation
  });
})();
