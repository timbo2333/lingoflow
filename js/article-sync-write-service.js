(function() {
  "use strict";

  const SYNC_FIELDS = new Set([
    "title",
    "content",
    "deletedAt",
    "sourceType",
    "sourceId",
    "sourceTitle",
    "sourceAttribution"
  ]);

  function getDependencies() {
    const library = window.LingoFlowArticleLibrary;
    const localEngine = window.LingoFlowArticleSyncLocalEngine?.create();
    if (!library || !localEngine) throw new Error("Article 写入边界不可用。");
    return { library, localEngine };
  }

  function getRuntimeContext() {
    const coordinator = window.LingoFlowArticleSyncApp;
    const context = coordinator?.getWriteContext?.();
    return context?.status === "ready" ? { coordinator, owner: context.owner } : null;
  }

  function committedArticle(result) {
    if (["desired", "ready", "unchanged", "oversized"].includes(result?.status) && result.article) {
      return result.article;
    }
    const error = new Error(result?.reason || "Article durable capture failed.");
    error.code = result?.status || "article-capture-failed";
    throw error;
  }

  async function afterMutation(runtime, result) {
    if (["desired", "ready"].includes(result?.status)) {
      runtime.coordinator.requestSync("local-mutation");
    } else if (result?.status === "oversized") {
      window.dispatchEvent(new CustomEvent("lingoflow:article-sync-issues-changed"));
    }
    return committedArticle(result);
  }

  async function createArticle(input) {
    const { library, localEngine } = getDependencies();
    const runtime = getRuntimeContext();
    if (!runtime) return await library.createArticle(input);
    return await afterMutation(
      runtime,
      await localEngine.createDesiredArticle(input, runtime.owner)
    );
  }

  async function updateArticle(articleId, changes = {}) {
    const { library, localEngine } = getDependencies();
    const runtime = getRuntimeContext();
    const affectsProjection = Object.keys(changes).some(key => SYNC_FIELDS.has(key));
    if (!runtime || !affectsProjection) return await library.updateArticle(articleId, changes);
    return await afterMutation(
      runtime,
      await localEngine.editDesiredArticle(articleId, changes, runtime.owner)
    );
  }

  async function deleteArticle(articleId) {
    return await updateArticle(articleId, { deletedAt: new Date().toISOString() });
  }

  async function restoreArticle(articleId) {
    return await updateArticle(articleId, { deletedAt: null });
  }

  async function captureRestoredArticle(articleId) {
    const runtime = getRuntimeContext();
    if (!runtime) return { status: "local-only", articleId };
    const { localEngine } = getDependencies();
    const result = await localEngine.captureExistingDesired(articleId, runtime.owner);
    if (["desired", "ready"].includes(result.status)) {
      runtime.coordinator.requestSync("backup-restore");
    } else if (result.status === "quarantined") {
      window.dispatchEvent(new CustomEvent("lingoflow:article-sync-issues-changed"));
    }
    return result;
  }

  window.LingoFlowArticleSyncWriteService = Object.freeze({
    createArticle,
    updateArticle,
    deleteArticle,
    restoreArticle,
    captureRestoredArticle
  });
})();
