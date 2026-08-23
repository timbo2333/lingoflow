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

  function getBackupEnvelope() {
    const envelope = window.LingoFlowBackupV2Envelope;
    return envelope && typeof envelope.buildEnvelope === "function"
      ? envelope
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

  async function exportBackup() {
    const articleExport = await exportArticles();
    if (articleExport.status !== "ready") return articleExport;

    const envelope = getBackupEnvelope();
    if (!envelope) {
      return { status: "failed", payload: null };
    }

    try {
      const result = envelope.buildEnvelope(articleExport.payload);
      if (result?.status === "rejected") {
        return { status: "rejected", payload: null };
      }
      if (!result || result.status !== "ready" || !result.envelope) {
        return { status: "failed", payload: null };
      }
      return { status: "ready", payload: result.envelope };
    } catch (error) {
      return { status: "failed", payload: null };
    }
  }

  window.LingoFlowBackupV2Export = Object.freeze({
    exportArticles,
    exportBackup
  });
})();
