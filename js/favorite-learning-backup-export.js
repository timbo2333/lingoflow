(function() {
  "use strict";

  function getFavoriteLearningRepository() {
    const repository = window.LingoFlowFavoriteLearningRepository;
    return repository && typeof repository.list === "function"
      ? repository
      : null;
  }

  function getFavoriteLearningBackupSchema() {
    const schema = window.LingoFlowFavoriteLearningBackupSchema;
    return schema && typeof schema.validateFavoriteLearningStates === "function"
      ? schema
      : null;
  }

  async function exportFavoriteLearningStates() {
    const repository = getFavoriteLearningRepository();
    const schema = getFavoriteLearningBackupSchema();
    if (!repository || !schema) {
      return { status: "failed", payload: null };
    }

    try {
      const favoriteLearningStates = await repository.list({ includeDeleted: true });
      const validation = schema.validateFavoriteLearningStates(favoriteLearningStates);
      if (!validation || validation.status !== "valid") {
        return { status: "rejected", payload: null };
      }

      return {
        status: "ready",
        payload: {
          favoriteLearningStates: validation.favoriteLearningStates
        }
      };
    } catch (error) {
      return { status: "failed", payload: null };
    }
  }

  window.LingoFlowFavoriteLearningBackupExport = Object.freeze({
    exportFavoriteLearningStates
  });
})();
