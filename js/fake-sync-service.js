(function() {
  "use strict";

  function getProtocol() {
    const protocol = window.LingoFlowCloudSyncProtocol;
    if (!protocol ||
        typeof protocol.validateOwnerContext !== "function" ||
        typeof protocol.validateMutation !== "function" ||
        typeof protocol.validateResult !== "function" ||
        typeof protocol.validatePullChange !== "function") {
      throw new Error("Cloud Sync Protocol 不可用。");
    }
    return protocol;
  }

  function clone(value) {
    return structuredClone(value);
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

    if (typeof left !== "object" || typeof right !== "object") return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => (
        key === rightKeys[index] && valuesEqual(left[key], right[key])
      ));
  }

  function recordKey(mutation) {
    return `${mutation.entityType}\u0000${mutation.entityId}\u0000${mutation.scope}`;
  }

  function isTombstone(payload) {
    return payload.deletedAt !== null;
  }

  function revisionToken(value) {
    return `revision:${value}`;
  }

  function cursorToken(value) {
    return `cursor:${value}`;
  }

  function parseCursor(value, head) {
    if (value === null) return { status: "valid", position: 0 };
    if (typeof value !== "string" || !/^cursor:(0|[1-9]\d*)$/.test(value)) {
      return { status: "rejected", reason: "invalid-cursor" };
    }
    const position = Number(value.slice("cursor:".length));
    if (!Number.isSafeInteger(position) || position > head) {
      return { status: "rejected", reason: "cursor-out-of-range" };
    }
    return { status: "valid", position };
  }

  function createRejectedResult(validation, reason) {
    return {
      status: "rejected",
      mutationId: validation?.mutationId || null,
      entityType: validation?.entityType || null,
      entityId: validation?.entityId || null,
      scope: validation?.scope || null,
      reason
    };
  }

  function validateBuiltResult(result) {
    const validation = getProtocol().validateResult(result);
    if (validation.status !== "valid") {
      throw new Error("Fake Sync Service 生成了非法 result。", {
        cause: validation.errors
      });
    }
    return validation.result;
  }

  function create() {
    const owners = new Map();

    function getOwnerState(ownerId) {
      if (!owners.has(ownerId)) {
        owners.set(ownerId, {
          cursor: 0,
          records: new Map(),
          changes: [],
          receipts: new Map()
        });
      }
      return owners.get(ownerId);
    }

    function push(ownerValue, mutationValue) {
      const protocol = getProtocol();
      const ownerValidation = protocol.validateOwnerContext(ownerValue);
      if (ownerValidation.status !== "valid") {
        return createRejectedResult(null, "invalid-owner-context");
      }

      const validation = protocol.validateMutation(mutationValue);
      if (validation.status !== "valid") {
        return createRejectedResult(
          validation,
          validation.errors[0]?.code || "invalid-mutation"
        );
      }

      const ownerState = getOwnerState(ownerValidation.ownerContext.ownerId);
      const mutation = validation.mutation;
      const receipt = ownerState.receipts.get(mutation.mutationId);
      if (receipt) {
        if (valuesEqual(receipt.mutation, mutation)) return clone(receipt.result);
        return validateBuiltResult(createRejectedResult(
          validation,
          "idempotency-key-reused"
        ));
      }

      const key = recordKey(mutation);
      const current = ownerState.records.get(key) || null;
      let result;

      if (!current) {
        if (mutation.operation === "restore") {
          result = validateBuiltResult(createRejectedResult(
            validation,
            "restore-target-not-tombstone"
          ));
        } else if (mutation.baseRevision !== null) {
          result = validateBuiltResult(createRejectedResult(
            validation,
            "base-revision-without-record"
          ));
        } else {
          const revisionNumber = 1;
          const revision = revisionToken(revisionNumber);
          const cursorNumber = ownerState.cursor + 1;
          const cursor = cursorToken(cursorNumber);
          const payload = clone(mutation.payload);
          const change = {
            cursor,
            entityType: mutation.entityType,
            entityId: mutation.entityId,
            scope: mutation.scope,
            schemaVersion: mutation.schemaVersion,
            revision,
            operation: mutation.operation,
            payload: clone(payload)
          };
          const changeValidation = protocol.validatePullChange(change);
          if (changeValidation.status !== "valid") {
            throw new Error("Fake Sync Service 生成了非法 change。", {
              cause: changeValidation.errors
            });
          }

          ownerState.cursor = cursorNumber;
          ownerState.records.set(key, {
            revisionNumber,
            revision,
            cursor,
            payload
          });
          ownerState.changes.push({
            position: cursorNumber,
            change: changeValidation.change
          });
          result = validateBuiltResult({
            status: "applied",
            mutationId: mutation.mutationId,
            entityType: mutation.entityType,
            entityId: mutation.entityId,
            scope: mutation.scope,
            schemaVersion: mutation.schemaVersion,
            revision,
            cursor
          });
        }
      } else if (mutation.operation === "restore" && !isTombstone(current.payload)) {
        result = validateBuiltResult(createRejectedResult(
          validation,
          "restore-target-not-tombstone"
        ));
      } else if (mutation.operation === "restore" && isTombstone(mutation.payload)) {
        result = validateBuiltResult(createRejectedResult(
          validation,
          "restore-payload-must-be-active"
        ));
      } else if (valuesEqual(current.payload, mutation.payload)) {
        result = validateBuiltResult({
          status: "unchanged",
          mutationId: mutation.mutationId,
          entityType: mutation.entityType,
          entityId: mutation.entityId,
          scope: mutation.scope,
          schemaVersion: mutation.schemaVersion,
          revision: current.revision,
          cursor: current.cursor
        });
      } else if (mutation.baseRevision !== current.revision) {
        result = validateBuiltResult({
          status: "conflict",
          mutationId: mutation.mutationId,
          entityType: mutation.entityType,
          entityId: mutation.entityId,
          scope: mutation.scope,
          schemaVersion: mutation.schemaVersion,
          reason: "revision-mismatch",
          currentRevision: current.revision,
          currentCursor: current.cursor,
          currentPayload: clone(current.payload)
        });
      } else if (mutation.operation === "put" &&
          isTombstone(current.payload) &&
          !isTombstone(mutation.payload)) {
        result = validateBuiltResult(createRejectedResult(
          validation,
          "explicit-restore-required"
        ));
      } else {
        const revisionNumber = current.revisionNumber + 1;
        const revision = revisionToken(revisionNumber);
        const cursorNumber = ownerState.cursor + 1;
        const cursor = cursorToken(cursorNumber);
        const payload = clone(mutation.payload);
        const change = {
          cursor,
          entityType: mutation.entityType,
          entityId: mutation.entityId,
          scope: mutation.scope,
          schemaVersion: mutation.schemaVersion,
          revision,
          operation: mutation.operation,
          payload: clone(payload)
        };
        const changeValidation = protocol.validatePullChange(change);
        if (changeValidation.status !== "valid") {
          throw new Error("Fake Sync Service 生成了非法 change。", {
            cause: changeValidation.errors
          });
        }

        ownerState.cursor = cursorNumber;
        ownerState.records.set(key, {
          revisionNumber,
          revision,
          cursor,
          payload
        });
        ownerState.changes.push({
          position: cursorNumber,
          change: changeValidation.change
        });
        result = validateBuiltResult({
          status: "applied",
          mutationId: mutation.mutationId,
          entityType: mutation.entityType,
          entityId: mutation.entityId,
          scope: mutation.scope,
          schemaVersion: mutation.schemaVersion,
          revision,
          cursor
        });
      }

      ownerState.receipts.set(mutation.mutationId, {
        mutation: clone(mutation),
        result: clone(result)
      });
      return clone(result);
    }

    function pull(ownerValue, afterCursor = null) {
      const protocol = getProtocol();
      const ownerValidation = protocol.validateOwnerContext(ownerValue);
      if (ownerValidation.status !== "valid") {
        return {
          status: "rejected",
          changes: [],
          nextCursor: null,
          reason: "invalid-owner-context"
        };
      }

      const ownerState = getOwnerState(ownerValidation.ownerContext.ownerId);
      const cursor = parseCursor(afterCursor, ownerState.cursor);
      if (cursor.status !== "valid") {
        return {
          status: "rejected",
          changes: [],
          nextCursor: null,
          reason: cursor.reason
        };
      }

      return {
        status: "ready",
        changes: ownerState.changes
          .filter(entry => entry.position > cursor.position)
          .map(entry => clone(entry.change)),
        nextCursor: cursorToken(ownerState.cursor)
      };
    }

    return Object.freeze({ push, pull });
  }

  window.LingoFlowFakeSyncService = Object.freeze({ create });
})();
