(function() {
  "use strict";

  function dependencies() {
    return {
      library: window.LingoFlowArticleLibrary,
      projection: window.LingoFlowArticleSyncProjection,
      state: window.LingoFlowSyncStateRepository
    };
  }

  async function getArticle(id) {
    return await dependencies().library.getArticle(id);
  }

  async function getProjection(id) {
    const article = await getArticle(id);
    return article ? dependencies().projection.projectArticleForSync(article) : null;
  }

  async function listArticleProjections(options = {}) {
    const { library, projection } = dependencies();
    const articles = await library.listArticles({ ...options, includeDeleted: true });
    return articles.map(article => projection.projectArticleForSync(article));
  }

  async function inspectLocalProjection(id) {
    return { status: "ready", projection: await getProjection(id) };
  }

  // This is deliberately not a local-user write: it never captures an outbox item.
  async function applyRemoteProjection({ ownerId, bindingId, remoteProjection, expectedProjection }) {
    const { library, projection, state } = dependencies();
    const remote = projection.sanitizeArticleSyncProjection(remoteProjection);
    const binding = await state.getWorkspaceBinding();
    if (binding.status !== "ready" || binding.binding.ownerId !== ownerId ||
        binding.binding.bindingId !== bindingId) {
      return { status: "blocked", reason: "workspace-binding-mismatch" };
    }
    const pending = await state.listArticleMutations(ownerId, bindingId);
    if (pending.status !== "ready") return pending;
    if (pending.items.some(item => item.articleId === remote.id && item.status !== "issue")) {
      return { status: "blocked", reason: "unsynced-local-article" };
    }
    const expected = expectedProjection === undefined
      ? await getProjection(remote.id)
      : expectedProjection;
    return await library.commitArticleSyncProjection(remote.id, expected, remote);
  }

  window.LingoFlowArticleSyncRepository = Object.freeze({
    getArticle,
    getProjection,
    listArticleProjections,
    inspectLocalProjection,
    applyRemoteProjection
  });
})();
