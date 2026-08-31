(function() {
  "use strict";

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function getOwnDataValue(value, key) {
    if (!isPlainObject(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor &&
      descriptor.enumerable &&
      Object.prototype.hasOwnProperty.call(descriptor, "value")
      ? descriptor.value
      : undefined;
  }

  function getPreferencesRepository() {
    const repository = window.LingoFlowPreferencesRepository;
    return repository && typeof repository.list === "function"
      ? repository
      : null;
  }

  function getPreferencesBackupSchema() {
    const schema = window.LingoFlowPreferencesBackupSchema;
    return schema && typeof schema.validatePreferences === "function"
      ? schema
      : null;
  }

  async function exportPreferences() {
    try {
      const repository = getPreferencesRepository();
      const schema = getPreferencesBackupSchema();
      if (!repository || !schema) {
        return { status: "failed", payload: null };
      }

      const repositoryResult = await repository.list();
      const repositoryStatus = getOwnDataValue(repositoryResult, "status");
      if (repositoryStatus !== "ready") {
        return { status: "failed", payload: null };
      }

      const preferences = getOwnDataValue(repositoryResult, "preferences");
      if (!Array.isArray(preferences)) {
        return { status: "failed", payload: null };
      }

      const validation = schema.validatePreferences(preferences);
      const validationStatus = getOwnDataValue(validation, "status");
      if (validationStatus === "rejected") {
        return { status: "rejected", payload: null };
      }
      if (validationStatus !== "valid") {
        return { status: "failed", payload: null };
      }

      const validatedPreferences = getOwnDataValue(validation, "preferences");
      if (!Array.isArray(validatedPreferences)) {
        return { status: "failed", payload: null };
      }

      return {
        status: "ready",
        payload: { preferences: validatedPreferences }
      };
    } catch (error) {
      return { status: "failed", payload: null };
    }
  }

  window.LingoFlowPreferencesBackupExport = Object.freeze({
    exportPreferences
  });
})();
