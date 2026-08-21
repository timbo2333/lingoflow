(function() {
  "use strict";

  function getArticleLibrary() {
    const library = window.LingoFlowArticleLibrary;
    return library && typeof library.listArticles === "function"
      ? library
      : null;
  }

  function getBackupSchema() {
    const schema = window.LingoFlowBackupV2Schema;
    return schema && typeof schema.validateArticles === "function"
      ? schema
      : null;
  }

  async function exportArticles() {
    const library = getArticleLibrary();
    const schema = getBackupSchema();
    if (!library || !schema) {
      return { status: "failed", payload: null };
    }

    try {
      const articles = await library.listArticles({ includeDeleted: true });
      const validation = schema.validateArticles(articles);
      if (!validation || validation.status !== "valid") {
        return { status: "rejected", payload: null };
      }

      return {
        status: "ready",
        payload: { articles: validation.articles }
      };
    } catch (error) {
      return { status: "failed", payload: null };
    }
  }

  window.LingoFlowBackupV2Export = Object.freeze({
    exportArticles
  });
})();
