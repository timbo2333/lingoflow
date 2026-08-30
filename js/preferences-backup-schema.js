(function() {
  "use strict";

  const ITEM_FIELDS = new Set(["key", "value"]);
  const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/;
  const KNOWN_VALUE_ENUMS = Object.freeze({
    fontSize: new Set(["18", "20", "21", "23", "25"]),
    lineHeight: new Set(["1.65", "1.85", "2", "2.2", "2.4"]),
    appearance: new Set(["system", "light", "dark"]),
    speechRate: new Set(["0.7", "0.85", "1", "1.15"])
  });
  const SPEECH_VOICE_FIELDS = new Set(["name", "lang", "voiceURI"]);
  const RESERVED_KEYS = new Set([
    "deviceId",
    "historyMigrationState",
    "migrationState",
    "migrationCompleted",
    "migrationVersion",
    "lastBackup",
    "backupDismiss",
    "backupReminder",
    "syncStatus",
    "remoteId",
    "serverRevision",
    "dirty",
    "lastSyncedAt",
    "vectorClock",
    "voices",
    "currentVoice",
    "localService",
    "voiceAvailable",
    "darkMode",
    "resolvedAppearance",
    "permissionState",
    "permissions",
    "hardwareCapabilities",
    "dictionaryReady",
    "dictionaryVersion",
    "completedChunks",
    "importedRecords",
    "downloadCheckpoint",
    "dictionaryGuideDeferred",
    "dictionaryWasReady",
    "dictionaryTaskState",
    "dictionaryIntegritySnapshot",
    "speed",
    "reading",
    "preferences.speed",
    "preferences.reading",
    "__proto__",
    "prototype",
    "constructor"
  ]);

  function createError(code, path, details = {}) {
    return {
      code,
      path,
      ...(Number.isInteger(details.index) ? { index: details.index } : {}),
      ...(details.preferenceKey ? { preferenceKey: details.preferenceKey } : {}),
      ...(details.conflictingPreferenceKey
        ? { conflictingPreferenceKey: details.conflictingPreferenceKey }
        : {})
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

  function appendPropertyPath(path, key) {
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
      return path === "$" ? key : path + "." + key;
    }
    return path + "[" + JSON.stringify(key) + "]";
  }

  function inspectJsonProperties(value, path) {
    const properties = [];
    let arrayIndexCount = 0;

    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === "length") continue;
      if (typeof key === "symbol") {
        return { properties: [], error: createError("invalid-json-value", path) };
      }
      if (Array.isArray(value) && !isArrayIndexKey(key)) {
        return { properties: [], error: createError("invalid-json-value", path) };
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor ||
          !descriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        const propertyPath = Array.isArray(value)
          ? path + "[" + key + "]"
          : appendPropertyPath(path, key);
        return {
          properties: [],
          error: createError("invalid-json-value", propertyPath)
        };
      }

      properties.push({ key, value: descriptor.value });
      if (Array.isArray(value)) arrayIndexCount += 1;
    }

    if (Array.isArray(value) && arrayIndexCount !== value.length) {
      return { properties: [], error: createError("invalid-json-value", path) };
    }
    return { properties, error: null };
  }

  function findJsonError(value, path = "$", ancestors = new WeakSet()) {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return null;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? null : createError("invalid-json-value", path);
    }
    if (!value || typeof value !== "object") {
      return createError("invalid-json-value", path);
    }
    if (!Array.isArray(value) && !isPlainObject(value)) {
      return createError("invalid-json-value", path);
    }
    if (ancestors.has(value)) {
      return createError("invalid-json-value", path);
    }

    ancestors.add(value);
    const inspection = inspectJsonProperties(value, path);
    if (inspection.error) {
      ancestors.delete(value);
      return inspection.error;
    }

    for (const property of inspection.properties) {
      const childPath = Array.isArray(value)
        ? path + "[" + property.key + "]"
        : appendPropertyPath(path, property.key);
      const error = findJsonError(property.value, childPath, ancestors);
      if (error) {
        ancestors.delete(value);
        return error;
      }
    }

    ancestors.delete(value);
    return null;
  }

  function cloneJsonValue(value) {
    if (value === null || typeof value !== "object") return value;

    const inspection = inspectJsonProperties(value, "$clone");
    if (inspection.error) {
      throw new Error("Cannot clone a value that is not JSON-safe.");
    }

    if (Array.isArray(value)) {
      const clone = new Array(value.length);
      for (const property of inspection.properties) {
        Object.defineProperty(clone, property.key, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: cloneJsonValue(property.value)
        });
      }
      return clone;
    }

    if (!isPlainObject(value)) {
      throw new Error("Cannot clone a non-plain JSON object.");
    }
    const clone = Object.create(
      Object.getPrototypeOf(value) === null ? null : Object.prototype
    );
    for (const property of inspection.properties) {
      Object.defineProperty(clone, property.key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cloneJsonValue(property.value)
      });
    }
    return clone;
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

  function isValidPreferenceKey(value) {
    return typeof value === "string" && KEY_PATTERN.test(value);
  }

  function getPreferenceKey(preference) {
    try {
      if (!isPlainObject(preference) || !hasOwnDataProperty(preference, "key")) {
        return null;
      }
      const key = getOwnDataValue(preference, "key");
      return isValidPreferenceKey(key) ? key : null;
    } catch (error) {
      return null;
    }
  }

  function addItemShapeErrors(preference, errors) {
    for (const field of ITEM_FIELDS) {
      if (!hasOwnDataProperty(preference, field)) {
        errors.push(createError("missing-field", field));
      }
    }

    const properties = inspectJsonProperties(preference, "$");
    if (properties.error) return;
    for (const property of properties.properties) {
      if (!ITEM_FIELDS.has(property.key)) {
        errors.push(createError(
          "unexpected-field",
          appendPropertyPath("$", property.key)
        ));
      }
    }
  }

  function addKeyErrors(preference, errors) {
    if (!hasOwnDataProperty(preference, "key")) return;
    const key = getOwnDataValue(preference, "key");
    if (!isValidPreferenceKey(key)) {
      errors.push(createError("invalid-key", "key"));
    }
    if (typeof key === "string" && RESERVED_KEYS.has(key)) {
      errors.push(createError("reserved-key", "key", {
        preferenceKey: key
      }));
    }
  }

  function isRequiredUnpaddedString(value) {
    return typeof value === "string" && Boolean(value.trim()) && value === value.trim();
  }

  function isOptionalEmptyUnpaddedString(value) {
    return typeof value === "string" &&
      (value === "" || (Boolean(value.trim()) && value === value.trim()));
  }

  function validateSpeechVoice(value, errors) {
    if (value === null) return;
    if (!isPlainObject(value)) {
      errors.push(createError("invalid-speech-voice", "value"));
      return;
    }

    for (const field of SPEECH_VOICE_FIELDS) {
      if (!hasOwnDataProperty(value, field)) {
        errors.push(createError(
          "missing-speech-voice-field",
          "value." + field
        ));
      }
    }

    const properties = inspectJsonProperties(value, "value");
    if (!properties.error) {
      for (const property of properties.properties) {
        if (!SPEECH_VOICE_FIELDS.has(property.key)) {
          errors.push(createError(
            "unexpected-speech-voice-field",
            appendPropertyPath("value", property.key)
          ));
        }
      }
    }

    if (hasOwnDataProperty(value, "name") &&
        !isRequiredUnpaddedString(getOwnDataValue(value, "name"))) {
      errors.push(createError("invalid-speech-voice-field", "value.name"));
    }
    if (hasOwnDataProperty(value, "lang") &&
        !isRequiredUnpaddedString(getOwnDataValue(value, "lang"))) {
      errors.push(createError("invalid-speech-voice-field", "value.lang"));
    }
    if (hasOwnDataProperty(value, "voiceURI") &&
        !isOptionalEmptyUnpaddedString(getOwnDataValue(value, "voiceURI"))) {
      errors.push(createError("invalid-speech-voice-field", "value.voiceURI"));
    }
  }

  function addValueErrors(preference, errors) {
    if (!hasOwnDataProperty(preference, "value") ||
        !hasOwnDataProperty(preference, "key")) {
      return;
    }

    const key = getOwnDataValue(preference, "key");
    const value = getOwnDataValue(preference, "value");
    if (typeof key !== "string") return;

    if (Object.prototype.hasOwnProperty.call(KNOWN_VALUE_ENUMS, key)) {
      if (!KNOWN_VALUE_ENUMS[key].has(value)) {
        errors.push(createError("invalid-preference-value", "value", {
          preferenceKey: typeof key === "string" ? key : null
        }));
      }
      return;
    }
    if (key === "speechVoice") validateSpeechVoice(value, errors);
  }

  function rejectedPreference(preference, errors) {
    return {
      status: "rejected",
      preferenceKey: getPreferenceKey(preference),
      preference: null,
      errors
    };
  }

  function validatePreference(preference) {
    try {
      if (!isPlainObject(preference)) {
        return rejectedPreference(preference, [
          createError("invalid-preference", "$")
        ]);
      }

      const jsonError = findJsonError(preference);
      if (jsonError) return rejectedPreference(preference, [jsonError]);

      const errors = [];
      addItemShapeErrors(preference, errors);
      addKeyErrors(preference, errors);
      addValueErrors(preference, errors);
      if (errors.length) return rejectedPreference(preference, errors);

      const snapshot = cloneJsonValue(preference);
      return {
        status: "valid",
        preferenceKey: snapshot.key,
        preference: snapshot,
        errors: []
      };
    } catch (error) {
      return rejectedPreference(preference, [
        createError("invalid-preference", "$")
      ]);
    }
  }

  function withBatchContext(error, index, preferenceKey) {
    return {
      ...error,
      index,
      ...(preferenceKey ? { preferenceKey } : {})
    };
  }

  function rejectedCollection(error) {
    return {
      status: "rejected",
      summary: { total: 0, valid: 0, rejected: 0 },
      preferences: [],
      items: [],
      errors: [error]
    };
  }

  function validatePreferences(preferences) {
    if (!Array.isArray(preferences)) {
      return rejectedCollection(createError("invalid-preferences", "$"));
    }

    const collection = inspectJsonProperties(preferences, "$");
    if (collection.error) return rejectedCollection(collection.error);

    const values = new Array(preferences.length);
    for (const property of collection.properties) {
      values[Number(property.key)] = property.value;
    }

    const snapshots = new Array(values.length);
    const items = values.map((preference, index) => {
      const result = validatePreference(preference);
      snapshots[index] = result.preference;
      return {
        index,
        status: result.status,
        preferenceKey: result.preferenceKey,
        errors: result.errors.slice()
      };
    });
    const keys = new Map();

    for (const item of items) {
      if (!item.preferenceKey) continue;
      if (keys.has(item.preferenceKey)) {
        item.errors.push(createError("duplicate-preference-key", "key", {
          preferenceKey: item.preferenceKey,
          conflictingPreferenceKey: item.preferenceKey
        }));
      } else {
        keys.set(item.preferenceKey, item.index);
      }
    }

    const errors = [];
    for (const item of items) {
      if (item.errors.length) item.status = "rejected";
      for (const error of item.errors) {
        errors.push(withBatchContext(error, item.index, item.preferenceKey));
      }
    }

    const rejected = items.filter(item => item.status === "rejected").length;
    const status = rejected ? "rejected" : "valid";
    return {
      status,
      summary: {
        total: values.length,
        valid: values.length - rejected,
        rejected
      },
      preferences: status === "valid" ? snapshots : [],
      items,
      errors
    };
  }

  window.LingoFlowPreferencesBackupSchema = Object.freeze({
    validatePreference,
    validatePreferences
  });
})();
