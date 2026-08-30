(function() {
  "use strict";

  function getQueryEventRepository() {
    const repository = window.LingoFlowQueryEventRepository;
    return repository && typeof repository.list === "function"
      ? repository
      : null;
  }

  function getQueryEventBackupSchema() {
    const schema = window.LingoFlowQueryEventBackupSchema;
    return schema && typeof schema.validateQueryEvents === "function"
      ? schema
      : null;
  }

  async function exportQueryEvents() {
    const repository = getQueryEventRepository();
    const schema = getQueryEventBackupSchema();
    if (!repository || !schema) {
      return { status: "failed", payload: null };
    }

    try {
      const queryEvents = await repository.list();
      const validation = schema.validateQueryEvents(queryEvents);
      if (!validation || validation.status !== "valid") {
        return { status: "rejected", payload: null };
      }

      return {
        status: "ready",
        payload: { queryEvents: validation.queryEvents }
      };
    } catch (error) {
      return { status: "failed", payload: null };
    }
  }

  window.LingoFlowQueryEventBackupExport = Object.freeze({
    exportQueryEvents
  });
})();
