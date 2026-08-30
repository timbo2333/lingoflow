(function() {
  "use strict";

  function getHistoryBaselineRepository() {
    const repository = window.LingoFlowHistoryBaselineRepository;
    return repository && typeof repository.list === "function"
      ? repository
      : null;
  }

  function getHistoryBaselineBackupSchema() {
    const schema = window.LingoFlowHistoryBaselineBackupSchema;
    return schema && typeof schema.validateHistoryBaselines === "function"
      ? schema
      : null;
  }

  async function exportHistoryBaselines() {
    const repository = getHistoryBaselineRepository();
    const schema = getHistoryBaselineBackupSchema();
    if (!repository || !schema) {
      return { status: "failed", payload: null };
    }

    try {
      const historyBaselines = await repository.list();
      const validation = schema.validateHistoryBaselines(historyBaselines);
      if (!validation || validation.status !== "valid") {
        return { status: "rejected", payload: null };
      }

      return {
        status: "ready",
        payload: { historyBaselines: validation.historyBaselines }
      };
    } catch (error) {
      return { status: "failed", payload: null };
    }
  }

  window.LingoFlowHistoryBaselineBackupExport = Object.freeze({
    exportHistoryBaselines
  });
})();
