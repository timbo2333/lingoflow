(function() {
  "use strict";

  function createError(code, path) {
    const error = new Error(`${code}: ${path}`);
    error.code = code;
    error.path = path;
    return error;
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

  function snapshotValue(value, path = "$", ancestors = new WeakSet()) {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw createError("invalid-json-value", path);
      return value;
    }
    if (typeof value !== "object" || (!Array.isArray(value) && !isPlainObject(value))) {
      throw createError("invalid-json-value", path);
    }
    if (ancestors.has(value)) throw createError("invalid-json-value", path);

    ancestors.add(value);
    const keys = Reflect.ownKeys(value);
    const output = Array.isArray(value) ? new Array(value.length) : {};
    let arrayIndexCount = 0;

    for (const key of keys) {
      if (Array.isArray(value) && key === "length") continue;
      const childPath = Array.isArray(value)
        ? `${path}[${String(key)}]`
        : path === "$" ? String(key) : `${path}.${String(key)}`;
      if (typeof key === "symbol" || (Array.isArray(value) && !isArrayIndexKey(key))) {
        ancestors.delete(value);
        throw createError("invalid-json-value", childPath);
      }

      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor ||
          !descriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        ancestors.delete(value);
        throw createError("invalid-json-value", childPath);
      }

      const child = snapshotValue(descriptor.value, childPath, ancestors);
      Object.defineProperty(output, key, {
        value: child,
        enumerable: true,
        configurable: true,
        writable: true
      });
      if (Array.isArray(value)) arrayIndexCount += 1;
    }

    ancestors.delete(value);
    if (Array.isArray(value) && arrayIndexCount !== value.length) {
      throw createError("invalid-json-value", path);
    }
    return output;
  }

  function canonicalizeSnapshot(value) {
    if (Array.isArray(value)) return value.map(canonicalizeSnapshot);
    if (!isPlainObject(value)) return value;

    const output = {};
    for (const key of Object.keys(value).sort()) {
      Object.defineProperty(output, key, {
        value: canonicalizeSnapshot(value[key]),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return output;
  }

  function snapshot(value, path = "$") {
    return snapshotValue(value, path);
  }

  function serialize(value) {
    return JSON.stringify(canonicalizeSnapshot(snapshot(value)));
  }

  function fingerprint(value) {
    return serialize(value);
  }

  function valuesEqual(left, right) {
    if (Object.is(left, right)) return true;
    if (typeof left !== typeof right || left === null || right === null) return false;

    if (Array.isArray(left) || Array.isArray(right)) {
      return Array.isArray(left) &&
        Array.isArray(right) &&
        left.length === right.length &&
        left.every((value, index) => valuesEqual(value, right[index]));
    }

    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => (
        key === rightKeys[index] && valuesEqual(left[key], right[key])
      ));
  }

  window.LingoFlowSyncCanonical = Object.freeze({
    snapshot,
    serialize,
    fingerprint,
    valuesEqual
  });
})();
