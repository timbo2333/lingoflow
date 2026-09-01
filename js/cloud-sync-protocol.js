(function() {
  "use strict";

  const SUPPORTED_ENTITIES = Object.freeze({
    favorites: Object.freeze({
      schemaVersion: "1",
      scope: "record",
      operations: Object.freeze(["put", "restore"])
    })
  });
  const MUTATION_FIELDS = new Set([
    "mutationId",
    "entityType",
    "entityId",
    "scope",
    "schemaVersion",
    "operation",
    "baseRevision",
    "observedCursor",
    "payload"
  ]);
  const REQUIRED_MUTATION_FIELDS = Array.from(MUTATION_FIELDS);
  const PAYLOAD_SYNC_FIELDS = new Set([
    "owner",
    "ownerId",
    "userId",
    "accountId",
    "revision",
    "remoteRevision",
    "serverRevision",
    "cursor",
    "mutationId",
    "entityType",
    "entityId",
    "scope",
    "schemaVersion",
    "operation",
    "syncStatus",
    "remoteId",
    "dirty",
    "lastSyncedAt",
    "pendingMutation",
    "vectorClock"
  ]);
  const RESULT_STATUSES = new Set([
    "applied",
    "unchanged",
    "conflict",
    "rejected"
  ]);
  const RESULT_FIELDS = Object.freeze({
    applied: new Set([
      "status",
      "mutationId",
      "entityType",
      "entityId",
      "scope",
      "schemaVersion",
      "revision",
      "cursor"
    ]),
    unchanged: new Set([
      "status",
      "mutationId",
      "entityType",
      "entityId",
      "scope",
      "schemaVersion",
      "revision",
      "cursor"
    ]),
    conflict: new Set([
      "status",
      "mutationId",
      "entityType",
      "entityId",
      "scope",
      "schemaVersion",
      "reason",
      "currentRevision",
      "currentCursor",
      "currentPayload"
    ]),
    rejected: new Set([
      "status",
      "mutationId",
      "entityType",
      "entityId",
      "scope",
      "reason"
    ])
  });

  function createError(code, path) {
    return { code, path };
  }

  function isPlainObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function isArrayIndexKey(key) {
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)) return false;
    const index = Number(key);
    return Number.isInteger(index) && index >= 0 && index < 4294967295;
  }

  function cloneJsonValue(value, path = "$", ancestors = new WeakSet()) {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return { value, error: null };
    }
    if (typeof value === "number") {
      return Number.isFinite(value)
        ? { value, error: null }
        : { value: null, error: createError("invalid-json-value", path) };
    }
    if (typeof value !== "object" || (!Array.isArray(value) && !isPlainObject(value))) {
      return { value: null, error: createError("invalid-json-value", path) };
    }
    if (ancestors.has(value)) {
      return { value: null, error: createError("invalid-json-value", path) };
    }

    ancestors.add(value);
    const output = Array.isArray(value)
      ? new Array(value.length)
      : Object.getPrototypeOf(value) === null ? Object.create(null) : {};
    const keys = Reflect.ownKeys(value);
    let arrayIndexCount = 0;

    for (const key of keys) {
      if (Array.isArray(value) && key === "length") continue;
      if (typeof key === "symbol" || (Array.isArray(value) && !isArrayIndexKey(key))) {
        ancestors.delete(value);
        return { value: null, error: createError("invalid-json-value", path) };
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      const childPath = Array.isArray(value)
        ? `${path}[${key}]`
        : path === "$" ? key : `${path}.${key}`;
      if (!descriptor ||
          !descriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        ancestors.delete(value);
        return { value: null, error: createError("invalid-json-value", childPath) };
      }

      const child = cloneJsonValue(descriptor.value, childPath, ancestors);
      if (child.error) {
        ancestors.delete(value);
        return child;
      }
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: child.value
      });
      if (Array.isArray(value)) arrayIndexCount += 1;
    }

    ancestors.delete(value);
    if (Array.isArray(value) && arrayIndexCount !== value.length) {
      return { value: null, error: createError("invalid-json-value", path) };
    }
    return { value: output, error: null };
  }

  function getCandidateString(value, key) {
    try {
      if (!isPlainObject(value)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor &&
        descriptor.enumerable &&
        Object.prototype.hasOwnProperty.call(descriptor, "value") &&
        typeof descriptor.value === "string"
        ? descriptor.value
        : null;
    } catch {
      return null;
    }
  }

  function isOpaqueString(value) {
    return typeof value === "string" && Boolean(value.trim()) && value === value.trim();
  }

  function isNullableOpaqueString(value) {
    return value === null || isOpaqueString(value);
  }

  function validateExactFields(value, allowedFields, errors) {
    for (const field of allowedFields) {
      if (!Object.prototype.hasOwnProperty.call(value, field)) {
        errors.push(createError("missing-field", field));
      }
    }
    for (const field of Object.keys(value)) {
      if (!allowedFields.has(field)) {
        errors.push(createError("unexpected-field", field));
      }
    }
  }

  function getFavoriteSchema() {
    const schema = window.LingoFlowFavoriteBackupSchema;
    return schema && typeof schema.validateFavorite === "function" ? schema : null;
  }

  function findPayloadSyncField(value, path = "payload") {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const nested = findPayloadSyncField(value[index], `${path}[${index}]`);
        if (nested) return nested;
      }
      return null;
    }
    if (!isPlainObject(value)) return null;

    for (const key of Object.keys(value)) {
      const childPath = `${path}.${key}`;
      if (PAYLOAD_SYNC_FIELDS.has(key)) return childPath;
      const nested = findPayloadSyncField(value[key], childPath);
      if (nested) return nested;
    }
    return null;
  }

  function validateFavoritePayload(payload, entityId, errors) {
    const schema = getFavoriteSchema();
    if (!schema) {
      errors.push(createError("favorite-schema-unavailable", "payload"));
      return;
    }

    let validation;
    try {
      validation = schema.validateFavorite(payload);
    } catch {
      errors.push(createError("invalid-favorite", "payload"));
      return;
    }
    if (!validation || validation.status !== "valid") {
      const schemaErrors = Array.isArray(validation?.errors) ? validation.errors : [];
      if (!schemaErrors.length) {
        errors.push(createError("invalid-favorite", "payload"));
      } else {
        for (const error of schemaErrors) {
          const suffix = error?.path && error.path !== "$" ? `.${error.path}` : "";
          errors.push(createError(error?.code || "invalid-favorite", `payload${suffix}`));
        }
      }
      return;
    }

    if (validation.favoriteId !== entityId) {
      errors.push(createError("entity-id-mismatch", "entityId"));
    }
    const syncField = findPayloadSyncField(payload);
    if (syncField) errors.push(createError("sync-metadata-in-payload", syncField));
  }

  function rejectedMutation(value, errors) {
    return {
      status: "rejected",
      mutation: null,
      mutationId: getCandidateString(value, "mutationId"),
      entityType: getCandidateString(value, "entityType"),
      entityId: getCandidateString(value, "entityId"),
      scope: getCandidateString(value, "scope"),
      errors
    };
  }

  function validateMutation(value) {
    const cloned = cloneJsonValue(value);
    if (cloned.error) return rejectedMutation(value, [cloned.error]);
    const mutation = cloned.value;
    if (!isPlainObject(mutation)) {
      return rejectedMutation(value, [createError("invalid-mutation", "$")]);
    }

    const errors = [];
    for (const field of REQUIRED_MUTATION_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(mutation, field)) {
        errors.push(createError("missing-field", field));
      }
    }
    for (const field of Object.keys(mutation)) {
      if (!MUTATION_FIELDS.has(field)) {
        errors.push(createError("unexpected-field", field));
      }
    }

    if (Object.prototype.hasOwnProperty.call(mutation, "mutationId") &&
        !isOpaqueString(mutation.mutationId)) {
      errors.push(createError("invalid-mutation-id", "mutationId"));
    }
    if (Object.prototype.hasOwnProperty.call(mutation, "entityId") &&
        !isOpaqueString(mutation.entityId)) {
      errors.push(createError("invalid-entity-id", "entityId"));
    }

    const config = SUPPORTED_ENTITIES[mutation.entityType];
    if (!config) {
      errors.push(createError("unsupported-entity", "entityType"));
    } else {
      if (mutation.scope !== config.scope) {
        errors.push(createError("unsupported-scope", "scope"));
      }
      if (mutation.schemaVersion !== config.schemaVersion) {
        errors.push(createError("unsupported-schema-version", "schemaVersion"));
      }
      if (!config.operations.includes(mutation.operation)) {
        errors.push(createError("unsupported-operation", "operation"));
      }
    }

    if (Object.prototype.hasOwnProperty.call(mutation, "baseRevision") &&
        !isNullableOpaqueString(mutation.baseRevision)) {
      errors.push(createError("invalid-base-revision", "baseRevision"));
    }
    if (Object.prototype.hasOwnProperty.call(mutation, "observedCursor") &&
        !isNullableOpaqueString(mutation.observedCursor)) {
      errors.push(createError("invalid-observed-cursor", "observedCursor"));
    }

    if (config && Object.prototype.hasOwnProperty.call(mutation, "payload")) {
      validateFavoritePayload(mutation.payload, mutation.entityId, errors);
    }

    if (errors.length) return rejectedMutation(value, errors);
    return {
      status: "valid",
      mutation,
      mutationId: mutation.mutationId,
      entityType: mutation.entityType,
      entityId: mutation.entityId,
      scope: mutation.scope,
      errors: []
    };
  }

  function validateOwnerContext(value) {
    const cloned = cloneJsonValue(value);
    if (cloned.error || !isPlainObject(cloned.value)) {
      return {
        status: "rejected",
        ownerContext: null,
        errors: [cloned.error || createError("invalid-owner-context", "$")]
      };
    }
    const ownerContext = cloned.value;
    const keys = Object.keys(ownerContext);
    if (keys.length !== 1 || keys[0] !== "ownerId" || !isOpaqueString(ownerContext.ownerId)) {
      return {
        status: "rejected",
        ownerContext: null,
        errors: [createError("invalid-owner-context", "ownerId")]
      };
    }
    return { status: "valid", ownerContext, errors: [] };
  }

  function validateResult(value) {
    const cloned = cloneJsonValue(value);
    if (cloned.error || !isPlainObject(cloned.value)) {
      return {
        status: "rejected",
        result: null,
        errors: [cloned.error || createError("invalid-result", "$")]
      };
    }
    const result = cloned.value;
    const errors = [];
    if (!RESULT_STATUSES.has(result.status)) {
      errors.push(createError("invalid-result-status", "status"));
      return { status: "rejected", result: null, errors };
    }

    validateExactFields(result, RESULT_FIELDS[result.status], errors);

    if (result.status === "rejected") {
      if (!isNullableOpaqueString(result.mutationId)) {
        errors.push(createError("invalid-mutation-id", "mutationId"));
      }
      for (const field of ["entityType", "entityId", "scope"]) {
        if (!isNullableOpaqueString(result[field])) {
          errors.push(createError("invalid-result-identity", field));
        }
      }
      if (!isOpaqueString(result.reason)) {
        errors.push(createError("invalid-result-reason", "reason"));
      }
    } else {
      for (const field of ["mutationId", "entityType", "entityId", "scope"]) {
        if (!isOpaqueString(result[field])) {
          errors.push(createError("invalid-result-identity", field));
        }
      }
      const config = SUPPORTED_ENTITIES[result.entityType];
      if (!config) {
        errors.push(createError("unsupported-entity", "entityType"));
      } else {
        if (result.scope !== config.scope) {
          errors.push(createError("unsupported-scope", "scope"));
        }
        if (result.schemaVersion !== config.schemaVersion) {
          errors.push(createError("unsupported-schema-version", "schemaVersion"));
        }
      }
    }

    if (result.status === "applied" || result.status === "unchanged") {
      if (!isOpaqueString(result.revision)) {
        errors.push(createError("invalid-revision", "revision"));
      }
      if (!isOpaqueString(result.cursor)) {
        errors.push(createError("invalid-cursor", "cursor"));
      }
    }

    if (result.status === "conflict") {
      if (!isOpaqueString(result.reason)) {
        errors.push(createError("invalid-result-reason", "reason"));
      }
      if (!isOpaqueString(result.currentRevision)) {
        errors.push(createError("invalid-revision", "currentRevision"));
      }
      if (!isOpaqueString(result.currentCursor)) {
        errors.push(createError("invalid-cursor", "currentCursor"));
      }
      if (result.entityType === "favorites") {
        validateFavoritePayload(result.currentPayload, result.entityId, errors);
      }
    }

    return errors.length
      ? { status: "rejected", result: null, errors }
      : { status: "valid", result, errors: [] };
  }

  function validatePullChange(value) {
    const cloned = cloneJsonValue(value);
    if (cloned.error || !isPlainObject(cloned.value)) {
      return {
        status: "rejected",
        change: null,
        errors: [cloned.error || createError("invalid-pull-change", "$")]
      };
    }
    const change = cloned.value;
    const errors = [];
    for (const field of ["cursor", "entityType", "entityId", "scope", "schemaVersion", "revision"]) {
      if (!isOpaqueString(change[field])) {
        errors.push(createError("invalid-pull-change", field));
      }
    }

    const config = SUPPORTED_ENTITIES[change.entityType];
    if (!config) {
      errors.push(createError("unsupported-entity", "entityType"));
    } else {
      if (change.scope !== config.scope) {
        errors.push(createError("unsupported-scope", "scope"));
      }
      if (change.schemaVersion !== config.schemaVersion) {
        errors.push(createError("unsupported-schema-version", "schemaVersion"));
      }
      if (!config.operations.includes(change.operation)) {
        errors.push(createError("unsupported-operation", "operation"));
      }
      validateFavoritePayload(change.payload, change.entityId, errors);
    }

    return errors.length
      ? { status: "rejected", change: null, errors }
      : { status: "valid", change, errors: [] };
  }

  window.LingoFlowCloudSyncProtocol = Object.freeze({
    validateOwnerContext,
    validateMutation,
    validateResult,
    validatePullChange
  });
})();
