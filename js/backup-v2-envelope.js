(function() {
  "use strict";

  const FORMAT_NAME = "LingoFlow Backup";
  const FORMAT_VERSION = 2;
  const ENTITY_SCHEMA_VERSIONS = Object.freeze({
    articles: "1",
    favorites: "1",
    favoriteLearningStates: "1",
    queryEvents: "1",
    historyBaselines: "1"
  });
  const REQUIRED_ENTITIES = new Set(["articles"]);
  const REQUIRED_FIELDS = ["format", "metadata", "schema", "data"];

  function createError(code, path, details = {}) {
    return {
      code,
      path,
      ...(details.entity ? { entity: details.entity } : {})
    };
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

  function getJsonProperties(value, path) {
    const propertyKeys = [];
    let arrayIndexCount = 0;

    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === "length") continue;
      if (typeof key === "symbol") {
        return { error: createError("invalid-json-value", path) };
      }
      if (Array.isArray(value) && !isArrayIndexKey(key)) {
        return { error: createError("invalid-json-value", path) };
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor ||
          !descriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        const propertyPath = Array.isArray(value)
          ? `${path}[${key}]`
          : path === "$" ? key : `${path}.${key}`;
        return { error: createError("invalid-json-value", propertyPath) };
      }

      propertyKeys.push({ key, value: descriptor.value });
      if (Array.isArray(value)) arrayIndexCount += 1;
    }

    if (Array.isArray(value) && arrayIndexCount !== value.length) {
      return { error: createError("invalid-json-value", path) };
    }
    return { propertyKeys, error: null };
  }

  function findJsonError(value, path = "$", ancestors = new WeakSet()) {
    if (value === null) return null;
    if (["string", "boolean"].includes(typeof value)) return null;
    if (typeof value === "number") {
      return Number.isFinite(value) ? null : createError("invalid-json-value", path);
    }
    if (typeof value !== "object") {
      return createError("invalid-json-value", path);
    }
    if (!Array.isArray(value) && !isPlainObject(value)) {
      return createError("invalid-json-value", path);
    }
    if (ancestors.has(value)) {
      return createError("invalid-json-value", path);
    }

    ancestors.add(value);
    const properties = getJsonProperties(value, path);
    if (properties.error) {
      ancestors.delete(value);
      return properties.error;
    }

    for (const property of properties.propertyKeys) {
      const childPath = Array.isArray(value)
        ? `${path}[${property.key}]`
        : path === "$" ? property.key : `${path}.${property.key}`;
      const error = findJsonError(property.value, childPath, ancestors);
      if (error) {
        ancestors.delete(value);
        return error;
      }
    }
    ancestors.delete(value);
    return null;
  }

  function hasOwnDataProperty(value, key) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor) &&
      descriptor.enumerable &&
      Object.prototype.hasOwnProperty.call(descriptor, "value");
  }

  function getOwnDataValue(value, key) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
      ? descriptor.value
      : undefined;
  }

  function rejectedEnvelope(errors) {
    return {
      status: "rejected",
      envelope: null,
      errors
    };
  }

  function validateFormat(format, errors) {
    if (!isPlainObject(format)) {
      errors.push(createError("invalid-section", "format"));
      return;
    }

    if (!hasOwnDataProperty(format, "name")) {
      errors.push(createError("missing-field", "format.name"));
    } else if (getOwnDataValue(format, "name") !== FORMAT_NAME) {
      errors.push(createError("unsupported-format", "format.name"));
    }

    if (!hasOwnDataProperty(format, "version")) {
      errors.push(createError("missing-field", "format.version"));
    } else if (getOwnDataValue(format, "version") !== FORMAT_VERSION) {
      errors.push(createError("unsupported-format-version", "format.version"));
    }
  }

  function validateEntitySections(schema, data, errors) {
    if (!isPlainObject(schema)) {
      errors.push(createError("invalid-section", "schema"));
    }
    if (!isPlainObject(data)) {
      errors.push(createError("invalid-section", "data"));
    }
    if (!isPlainObject(schema) || !isPlainObject(data)) return;

    const schemaEntities = new Set(Object.keys(schema));
    const dataEntities = new Set(Object.keys(data));
    const entityNames = new Set([...schemaEntities, ...dataEntities]);
    for (const entity of entityNames) {
      if (!Object.prototype.hasOwnProperty.call(ENTITY_SCHEMA_VERSIONS, entity)) {
        const path = hasOwnDataProperty(data, entity)
          ? `data.${entity}`
          : `schema.${entity}`;
        errors.push(createError("unsupported-entity", path, { entity }));
      }
    }

    for (const [entity, schemaVersion] of Object.entries(ENTITY_SCHEMA_VERSIONS)) {
      const hasSchema = schemaEntities.has(entity);
      const hasData = dataEntities.has(entity);

      if (!hasSchema && (hasData || REQUIRED_ENTITIES.has(entity))) {
        errors.push(createError("missing-schema", `schema.${entity}`, { entity }));
      }
      if (!hasData && (hasSchema || REQUIRED_ENTITIES.has(entity))) {
        errors.push(createError("missing-data", `data.${entity}`, { entity }));
      }

      if (hasSchema && getOwnDataValue(schema, entity) !== schemaVersion) {
        errors.push(createError(
          "unsupported-schema-version",
          `schema.${entity}`,
          { entity }
        ));
      }
      if (hasData && !Array.isArray(getOwnDataValue(data, entity))) {
        errors.push(createError(
          "invalid-entity-collection",
          `data.${entity}`,
          { entity }
        ));
      }
    }
  }

  function validateEnvelope(envelope) {
    try {
      if (!isPlainObject(envelope)) {
        return rejectedEnvelope([createError("invalid-envelope", "$")]);
      }

      const jsonError = findJsonError(envelope);
      if (jsonError) return rejectedEnvelope([jsonError]);

      const errors = [];
      for (const field of REQUIRED_FIELDS) {
        if (!hasOwnDataProperty(envelope, field)) {
          errors.push(createError("missing-field", field));
        }
      }
      if (errors.length) return rejectedEnvelope(errors);

      const format = getOwnDataValue(envelope, "format");
      const metadata = getOwnDataValue(envelope, "metadata");
      const schema = getOwnDataValue(envelope, "schema");
      const data = getOwnDataValue(envelope, "data");

      validateFormat(format, errors);
      if (!isPlainObject(metadata)) {
        errors.push(createError("invalid-section", "metadata"));
      }
      validateEntitySections(schema, data, errors);

      if (errors.length) return rejectedEnvelope(errors);
      return {
        status: "valid",
        envelope,
        errors: []
      };
    } catch (error) {
      return rejectedEnvelope([createError("invalid-envelope", "$")]);
    }
  }

  function buildEnvelope(data) {
    let candidate;
    try {
      const schema = {};
      if (isPlainObject(data)) {
        for (const entity of Object.keys(data)) {
          if (Object.prototype.hasOwnProperty.call(ENTITY_SCHEMA_VERSIONS, entity)) {
            schema[entity] = ENTITY_SCHEMA_VERSIONS[entity];
          }
        }
      }
      candidate = {
        format: {
          name: FORMAT_NAME,
          version: FORMAT_VERSION
        },
        metadata: {},
        schema,
        data
      };
    } catch (error) {
      return rejectedEnvelope([createError("invalid-envelope", "data")]);
    }
    const validation = validateEnvelope(candidate);
    if (validation.status !== "valid") {
      return {
        status: "rejected",
        envelope: null,
        errors: validation.errors
      };
    }

    try {
      return {
        status: "ready",
        envelope: structuredClone(candidate),
        errors: []
      };
    } catch (error) {
      return rejectedEnvelope([createError("invalid-envelope", "$")]);
    }
  }

  function unwrapEnvelope(envelope) {
    const validation = validateEnvelope(envelope);
    if (validation.status !== "valid") {
      return {
        status: "rejected",
        data: null,
        errors: validation.errors
      };
    }
    try {
      return {
        status: "valid",
        data: structuredClone(getOwnDataValue(validation.envelope, "data")),
        errors: []
      };
    } catch (error) {
      return {
        status: "rejected",
        data: null,
        errors: [createError("invalid-envelope", "data")]
      };
    }
  }

  window.LingoFlowBackupV2Envelope = Object.freeze({
    buildEnvelope,
    validateEnvelope,
    unwrapEnvelope
  });
})();
