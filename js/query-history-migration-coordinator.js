(function() {
  "use strict";

  const preparationContexts = new WeakMap();

  function createCoordinatorError(code, message, details = {}) {
    const error = new Error(message);
    error.code = code;
    error.details = details;
    return error;
  }

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function getQueryData() {
    const queryData = window.LingoFlowLocalData?.QueryData;
    if (!queryData ||
        typeof queryData.readHistoryMigrationState !== "function" ||
        typeof queryData.readVocabForHistoryMigration !== "function" ||
        typeof queryData.markHistoryMigrationCompleted !== "function") {
      throw createCoordinatorError(
        "query-history-migration-local-data-unavailable",
        "Query History migration local-data boundary is unavailable."
      );
    }
    return queryData;
  }

  function getQueryEventRepository() {
    const repository = window.LingoFlowQueryEventRepository;
    if (!repository || typeof repository.list !== "function") {
      throw createCoordinatorError(
        "query-history-migration-query-event-repository-unavailable",
        "QueryEvent Repository is unavailable."
      );
    }
    return repository;
  }

  function getHistoryBaselineRepository() {
    const repository = window.LingoFlowHistoryBaselineRepository;
    if (!repository ||
        typeof repository.list !== "function" ||
        typeof repository.storeMigrationBaseline !== "function") {
      throw createCoordinatorError(
        "query-history-migration-history-baseline-repository-unavailable",
        "History Baseline Repository migration boundary is unavailable."
      );
    }
    return repository;
  }

  function getHistoryBaselineSchema() {
    const schema = window.LingoFlowHistoryBaselineBackupSchema;
    if (!schema || typeof schema.validateHistoryBaseline !== "function") {
      throw createCoordinatorError(
        "query-history-migration-history-baseline-schema-unavailable",
        "History Baseline Schema Validator is unavailable."
      );
    }
    return schema;
  }

  function readMigrationState(queryData) {
    const result = queryData.readHistoryMigrationState();
    const completedState = result?.state;
    const completedStateKeys = isPlainObject(completedState)
      ? Object.keys(completedState).sort()
      : [];
    if (!result ||
        !["missing", "completed"].includes(result.status) ||
        (result.status === "missing" && (result.raw !== null || result.state !== null)) ||
        (result.status === "completed" && (
          typeof result.raw !== "string" ||
          completedStateKeys.length !== 2 ||
          completedStateKeys[0] !== "status" ||
          completedStateKeys[1] !== "version" ||
          completedState.version !== 1 ||
          completedState.status !== "completed"
        ))) {
      throw createCoordinatorError(
        "query-history-migration-state-result-invalid",
        "Query History migration state reader returned an invalid result."
      );
    }
    return result;
  }

  function readLegacyVocab(queryData) {
    const result = queryData.readVocabForHistoryMigration();
    if (!result ||
        !["missing", "present"].includes(result.status) ||
        (result.status === "missing" && result.raw !== null) ||
        (result.status === "present" && typeof result.raw !== "string") ||
        !isPlainObject(result.vocab)) {
      throw createCoordinatorError(
        "query-history-migration-vocab-result-invalid",
        "Legacy Vocab reader returned an invalid result."
      );
    }
    return result;
  }

  function assertLegacyVocabUnchanged(queryData, expectedRaw) {
    const current = readLegacyVocab(queryData);
    if (current.raw !== expectedRaw) {
      throw createCoordinatorError(
        "query-history-migration-vocab-changed",
        "Legacy Vocab changed during migration preparation."
      );
    }
    return current;
  }

  function inspectModernFacts() {
    const queryEvents = getQueryEventRepository().list();
    const historyBaselines = getHistoryBaselineRepository().list();
    if (!Array.isArray(queryEvents) || !Array.isArray(historyBaselines)) {
      throw createCoordinatorError(
        "query-history-migration-facts-result-invalid",
        "A Query History Repository returned an invalid fact collection."
      );
    }
    return { queryEvents, historyBaselines };
  }

  function valuesEqual(left, right) {
    if (Object.is(left, right)) return true;
    if (typeof left !== typeof right || left === null || right === null) return false;
    if (Array.isArray(left) || Array.isArray(right)) {
      return Array.isArray(left) &&
        Array.isArray(right) &&
        left.length === right.length &&
        left.every((item, index) => valuesEqual(item, right[index]));
    }
    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => (
        key === rightKeys[index] && valuesEqual(left[key], right[key])
      ));
  }

  function getLegacyVocabStatus(snapshot) {
    if (snapshot.status === "missing") return "missing";
    return Object.keys(snapshot.vocab).length ? "present" : "empty";
  }

  function isCoordinatorMigrationBaseline(baseline) {
    return baseline?.deviceId === "legacy-local" &&
      typeof baseline.id === "string" &&
      baseline.id.startsWith("legacy-local:v1:");
  }

  function simpleStableHash(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function createLegacyBaselineCandidate(vocab) {
    const signatureEntries = Object.entries(vocab)
      .sort(([left], [right]) => left.localeCompare(right));
    return {
      id: `legacy-local:v1:${simpleStableHash(JSON.stringify(signatureEntries))}`,
      createdAt: new Date().toISOString(),
      deviceId: "legacy-local",
      records: vocab
    };
  }

  function createPublicResult(status, outcome, details = {}) {
    return {
      status,
      outcome,
      baselineWritten: Boolean(details.baselineWritten),
      migrationStateWritten: Boolean(details.migrationStateWritten),
      historyBaselineId: details.historyBaselineId || null,
      legacyVocabStatus: details.legacyVocabStatus || null,
      reason: details.reason || null,
      errors: Array.isArray(details.errors)
        ? details.errors.map(error => ({ ...error }))
        : []
    };
  }

  function createFailure(error, details = {}) {
    const code = error?.code || "query-history-migration-failed";
    const nestedErrors = Array.isArray(error?.details?.errors)
      ? error.details.errors.map(item => ({ ...item }))
      : [];
    return createPublicResult("failed", "failed", {
      ...details,
      reason: code,
      errors: [{
        code,
        ...(error?.message ? { message: error.message } : {}),
        ...(nestedErrors.length ? { errors: nestedErrors } : {})
      }]
    });
  }

  function completedResult(outcome, details = {}) {
    return createPublicResult("completed", outcome, details);
  }

  function createPreparation(outcome, details = {}) {
    const token = Object.freeze({});
    const context = {
      outcome,
      baselineWritten: Boolean(details.baselineWritten),
      historyBaselineId: details.historyBaselineId || null,
      legacyVocabStatus: details.legacyVocabStatus || null,
      requireLegacyVocabMatch: details.requireLegacyVocabMatch === true,
      legacyVocabRaw: details.legacyVocabRaw
    };
    preparationContexts.set(token, context);
    return {
      ...createPublicResult("ready", outcome, context),
      token
    };
  }

  function preparationForFacts(facts, details = {}, queryData) {
    if (facts.queryEvents.length) {
      return createPreparation("completed-from-existing-query-events", details);
    }
    if (facts.historyBaselines.length) {
      const ordinaryBaselines = facts.historyBaselines.filter(
        baseline => !isCoordinatorMigrationBaseline(baseline)
      );
      if (!ordinaryBaselines.length) {
        const legacySnapshot = readLegacyVocab(queryData);
        const matchingBaseline = facts.historyBaselines.find(
          baseline => valuesEqual(baseline.records, legacySnapshot.vocab)
        );
        if (!matchingBaseline) {
          throw createCoordinatorError(
            "query-history-migration-vocab-changed",
            "Legacy Vocab no longer matches the unfinished migration Baseline."
          );
        }
        return createPreparation("completed-from-existing-baseline", {
          ...details,
          historyBaselineId: matchingBaseline.id,
          legacyVocabStatus: getLegacyVocabStatus(legacySnapshot),
          requireLegacyVocabMatch: true,
          legacyVocabRaw: legacySnapshot.raw
        });
      }
      return createPreparation("completed-from-existing-baseline", {
        ...details,
        historyBaselineId: ordinaryBaselines[0].id
      });
    }
    return null;
  }

  function validateCandidate(candidate) {
    const validation = getHistoryBaselineSchema().validateHistoryBaseline(candidate);
    if (!validation || validation.status !== "valid" || !validation.historyBaseline) {
      throw createCoordinatorError(
        "query-history-migration-baseline-candidate-rejected",
        "Legacy Vocab cannot be represented by a valid History Baseline.",
        { errors: validation?.errors || [] }
      );
    }
    return validation.historyBaseline;
  }

  function getOwnDataValue(value, key) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { exists: false, value: undefined };
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor ||
        !descriptor.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      return { exists: false, value: undefined };
    }
    return { exists: true, value: descriptor.value };
  }

  function validateMigrationStoreResult(value, candidateId) {
    const status = getOwnDataValue(value, "status");
    const historyBaselineId = getOwnDataValue(value, "historyBaselineId");
    const written = getOwnDataValue(value, "written");
    const conflictFields = getOwnDataValue(value, "conflictFields");
    const allowedStatuses = ["stored", "unchanged", "conflict", "boundary-exists"];
    const expectedWritten = status.value === "stored";
    const fields = conflictFields.value;

    if (!status.exists ||
        !allowedStatuses.includes(status.value) ||
        !historyBaselineId.exists ||
        historyBaselineId.value !== candidateId ||
        !written.exists ||
        written.value !== expectedWritten ||
        !conflictFields.exists ||
        !Array.isArray(fields) ||
        fields.some(field => typeof field !== "string") ||
        (["stored", "unchanged", "boundary-exists"].includes(status.value) && fields.length) ||
        (status.value === "conflict" && !fields.length)) {
      throw createCoordinatorError(
        "query-history-migration-baseline-result-invalid",
        "History Baseline Repository returned an invalid migration result."
      );
    }

    if (status.value === "boundary-exists") {
      const existingIds = getOwnDataValue(value, "existingHistoryBaselineIds");
      if (!existingIds.exists ||
          !Array.isArray(existingIds.value) ||
          !existingIds.value.length ||
          existingIds.value.some(id => (
            typeof id !== "string" || !id.trim() || id !== id.trim()
          ))) {
        throw createCoordinatorError(
          "query-history-migration-baseline-result-invalid",
          "History Baseline Repository returned an invalid boundary result."
        );
      }
    }

    return {
      status: status.value,
      historyBaselineId: historyBaselineId.value,
      written: written.value,
      conflictFields: fields.slice(),
      existingHistoryBaselineIds: status.value === "boundary-exists"
        ? getOwnDataValue(value, "existingHistoryBaselineIds").value.slice()
        : []
    };
  }

  function prepare() {
    let baselineWritten = false;
    let historyBaselineId = null;
    let legacyVocabStatus = null;

    try {
      const queryData = getQueryData();
      const initialState = readMigrationState(queryData);
      if (initialState.status === "completed") {
        return completedResult("already-completed");
      }

      const initialFacts = inspectModernFacts();
      const initialBoundary = preparationForFacts(initialFacts, {}, queryData);
      if (initialBoundary) return initialBoundary;

      const legacySnapshot = readLegacyVocab(queryData);
      legacyVocabStatus = getLegacyVocabStatus(legacySnapshot);

      const stateAfterVocabRead = readMigrationState(queryData);
      if (stateAfterVocabRead.status === "completed") {
        return completedResult("already-completed", { legacyVocabStatus });
      }

      const factsAfterVocabRead = inspectModernFacts();
      const racedBoundary = preparationForFacts(factsAfterVocabRead, {
        legacyVocabStatus
      }, queryData);
      if (racedBoundary) return racedBoundary;

      if (!Object.keys(legacySnapshot.vocab).length) {
        return createPreparation("completed-no-legacy-data", {
          legacyVocabStatus,
          requireLegacyVocabMatch: true,
          legacyVocabRaw: legacySnapshot.raw
        });
      }

      const candidate = validateCandidate(
        createLegacyBaselineCandidate(legacySnapshot.vocab)
      );
      historyBaselineId = candidate.id;

      assertLegacyVocabUnchanged(queryData, legacySnapshot.raw);

      const stateBeforeWrite = readMigrationState(queryData);
      if (stateBeforeWrite.status === "completed") {
        return completedResult("already-completed", {
          historyBaselineId,
          legacyVocabStatus
        });
      }

      const factsBeforeWrite = inspectModernFacts();
      const finalBoundary = preparationForFacts(factsBeforeWrite, {
        historyBaselineId,
        legacyVocabStatus
      }, queryData);
      if (finalBoundary) return finalBoundary;

      const storeResult = validateMigrationStoreResult(
        getHistoryBaselineRepository().storeMigrationBaseline(candidate),
        candidate.id
      );

      if (storeResult.status === "boundary-exists") {
        const racedBoundary = preparationForFacts(inspectModernFacts(), {
          legacyVocabStatus
        }, queryData);
        if (racedBoundary) return racedBoundary;
        throw createCoordinatorError(
          "query-history-migration-baseline-result-invalid",
          "History Baseline Repository reported a boundary that cannot be read."
        );
      }
      if (storeResult.status === "conflict") {
        throw createCoordinatorError(
          "query-history-migration-baseline-conflict",
          "A different History Baseline already uses the migration candidate ID.",
          { historyBaselineId: candidate.id }
        );
      }
      if (!["stored", "unchanged"].includes(storeResult.status)) {
        throw createCoordinatorError(
          "query-history-migration-baseline-result-invalid",
          "History Baseline Repository returned an unsupported migration status."
        );
      }

      baselineWritten = storeResult.status === "stored" && storeResult.written === true;
      return createPreparation("migrated-legacy-vocab", {
        baselineWritten,
        historyBaselineId: candidate.id,
        legacyVocabStatus,
        requireLegacyVocabMatch: true,
        legacyVocabRaw: legacySnapshot.raw
      });
    } catch (error) {
      return createFailure(error, {
        baselineWritten,
        historyBaselineId,
        legacyVocabStatus
      });
    }
  }

  function determineSafeFinalOutcome(context, queryData) {
    const facts = inspectModernFacts();
    if (facts.queryEvents.length) {
      return "completed-from-existing-query-events";
    }
    if (facts.historyBaselines.length) {
      const preparedBaselineStillExists = facts.historyBaselines.some(
        item => item.id === context.historyBaselineId
      );
      if (context.requireLegacyVocabMatch && preparedBaselineStillExists) {
        assertLegacyVocabUnchanged(queryData, context.legacyVocabRaw);
      }
      if (context.outcome === "migrated-legacy-vocab" &&
          preparedBaselineStillExists) {
        return "migrated-legacy-vocab";
      }
      return "completed-from-existing-baseline";
    }

    const legacySnapshot = context.requireLegacyVocabMatch
      ? assertLegacyVocabUnchanged(queryData, context.legacyVocabRaw)
      : readLegacyVocab(queryData);
    if (Object.keys(legacySnapshot.vocab).length) {
      throw createCoordinatorError(
        "query-history-migration-boundary-changed",
        "Legacy Vocab appeared after migration preparation."
      );
    }
    return "completed-no-legacy-data";
  }

  function finalize(token) {
    const context = token && preparationContexts.get(token);
    if (!context) {
      return createFailure(createCoordinatorError(
        "query-history-migration-preparation-invalid",
        "Query History migration preparation token is invalid."
      ));
    }
    try {
      const queryData = getQueryData();
      const initialState = readMigrationState(queryData);
      if (initialState.status === "completed") {
        const result = completedResult(
          context.baselineWritten ? context.outcome : "already-completed",
          context
        );
        return createPublicResult(result.status, result.outcome, result);
      }

      const outcome = determineSafeFinalOutcome(context, queryData);
      const stateBeforeWrite = readMigrationState(queryData);
      if (stateBeforeWrite.status === "completed") {
        const result = completedResult(outcome, context);
        return createPublicResult(result.status, result.outcome, result);
      }

      try {
        queryData.markHistoryMigrationCompleted(stateBeforeWrite.raw);
      } catch (error) {
        if (error?.code !== "history-migration-state-storage-changed") throw error;
        const racedState = readMigrationState(queryData);
        if (racedState.status !== "completed") throw error;
        const result = completedResult("already-completed", context);
        return createPublicResult(result.status, result.outcome, result);
      }
      const result = completedResult(outcome, {
        ...context,
        migrationStateWritten: true
      });
      return createPublicResult(result.status, result.outcome, result);
    } catch (error) {
      return createFailure(error, context);
    }
  }

  function ensureCompleted() {
    const prepared = prepare();
    if (prepared.status !== "ready") return prepared;
    return finalize(prepared.token);
  }

  window.LingoFlowQueryHistoryMigrationCoordinator = Object.freeze({
    prepare,
    finalize,
    ensureCompleted
  });
})();
