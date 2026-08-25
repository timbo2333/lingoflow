(function() {
  "use strict";

  function getFavoriteRepository() {
    const repository = window.LingoFlowFavoriteRepository;
    return repository && typeof repository.list === "function"
      ? repository
      : null;
  }

  function getFavoriteBackupSchema() {
    const schema = window.LingoFlowFavoriteBackupSchema;
    return schema && typeof schema.validateFavorites === "function"
      ? schema
      : null;
  }

  async function exportFavorites() {
    const repository = getFavoriteRepository();
    const schema = getFavoriteBackupSchema();
    if (!repository || !schema) {
      return { status: "failed", payload: null };
    }

    try {
      const favorites = await repository.list({ includeDeleted: true });
      const validation = schema.validateFavorites(favorites);
      if (!validation || validation.status !== "valid") {
        return { status: "rejected", payload: null };
      }

      return {
        status: "ready",
        payload: { favorites: validation.favorites }
      };
    } catch (error) {
      return { status: "failed", payload: null };
    }
  }

  window.LingoFlowFavoriteBackupExport = Object.freeze({
    exportFavorites
  });
})();
