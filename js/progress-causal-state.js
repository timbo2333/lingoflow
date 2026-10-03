(function() {
  "use strict";

  // Local facts only. This module neither observes the server nor authorizes a send.
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const keys = (value, names) => object(value) && Object.keys(value).length === names.length &&
    names.every(name => Object.hasOwn(value, name));
  const revision = value => typeof value === "string" && /^revision:[1-9][0-9]*$/.test(value);
  const cursor = value => typeof value === "string" && /^cursor:(0|[1-9][0-9]*)$/.test(value);
  const fingerprint = value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
  const epoch = value => typeof value === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
  const ordinal = value => BigInt(value.slice(value.indexOf(":") + 1));
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const unanchored = () => ({ kind: "unanchored", parent: null });

  function normalizeParent(value) {
    if (!keys(value, ["articleRevision", "readingEpoch", "contentFingerprint", "lifecycle"]) ||
        !revision(value.articleRevision) || !epoch(value.readingEpoch) ||
        !fingerprint(value.contentFingerprint) || !["active", "deleted"].includes(value.lifecycle)) return null;
    return { articleRevision: value.articleRevision, readingEpoch: value.readingEpoch,
      contentFingerprint: value.contentFingerprint, lifecycle: value.lifecycle };
  }

  function normalizeEvidence(value) {
    if (!keys(value, ["kind", "highWaterCursor", "throughCursor"]) ||
        value.kind !== "completed-inventory-catchup" || !cursor(value.highWaterCursor) ||
        !cursor(value.throughCursor) || ordinal(value.throughCursor) < ordinal(value.highWaterCursor)) return null;
    return { kind: value.kind, highWaterCursor: value.highWaterCursor, throughCursor: value.throughCursor };
  }

  function normalizeObservation(value) {
    if (keys(value, ["kind"]) && value.kind === "unknown") return { kind: "unknown" };
    if (keys(value, ["kind", "evidence"]) && value.kind === "absent") {
      const evidence = normalizeEvidence(value.evidence);
      return evidence ? { kind: "absent", evidence } : null;
    }
    if (!keys(value, ["kind", "revision", "cursor", "parentReadingEpoch", "contentFingerprint", "checkpoint"]) ||
        value.kind !== "revision" || !revision(value.revision) || !cursor(value.cursor) ||
        ordinal(value.cursor) === 0n || !epoch(value.parentReadingEpoch) || !fingerprint(value.contentFingerprint) ||
        !keys(value.checkpoint, ["progress", "paragraphIndex"]) ||
        !Number.isFinite(value.checkpoint.progress) || value.checkpoint.progress < 0 || value.checkpoint.progress > 1 ||
        !Number.isSafeInteger(value.checkpoint.paragraphIndex) || value.checkpoint.paragraphIndex < 0) return null;
    return { kind: "revision", revision: value.revision, cursor: value.cursor,
      parentReadingEpoch: value.parentReadingEpoch, contentFingerprint: value.contentFingerprint,
      checkpoint: { progress: value.checkpoint.progress, paragraphIndex: value.checkpoint.paragraphIndex } };
  }

  function observationFromRecord(record, ownerId, bindingId, articleId) {
    if (record === undefined || record === null) return { kind: "unknown" };
    if (!object(record) || record.ownerId !== ownerId || record.bindingId !== bindingId ||
        record.articleId !== articleId) return null;
    const { ownerId: _owner, bindingId: _binding, articleId: _article, diagnostic: _diagnostic, ...fact } = record;
    return normalizeObservation(fact);
  }

  function normalizeBase(value) {
    if (value === undefined) return unanchored(); // B2 compatibility, never backfill.
    if (!object(value) || !Object.hasOwn(value, "parent")) return null;
    const parent = value.parent === null ? null : normalizeParent(value.parent);
    if (value.parent !== null && !parent) return null;
    const { parent: _parent, ...fact } = value;
    if (keys(fact, ["kind"]) && fact.kind === "unanchored") return parent === null ? unanchored() : null;
    const observation = normalizeObservation(fact);
    return observation ? { ...observation, parent } : null;
  }

  function trustedParent(sidecar) {
    const parent = normalizeParent(sidecar?.serverReadingContext);
    const trusted = parent && revision(sidecar?.knownRevision) &&
      parent.articleRevision === sidecar.knownRevision && !sidecar.serverReadingContextDiagnostic &&
      !(parent.articleRevision === sidecar.knownRevision && sidecar.lastSyncedLifecycle &&
        parent.lifecycle !== sidecar.lastSyncedLifecycle);
    return trusted ? parent : null;
  }

  function captureBase(observation, sidecar) {
    return { ...(observation || { kind: "unknown" }), parent: trustedParent(sidecar) };
  }

  function observationDecision(previous, next) {
    if (!previous || !next || next.kind === "unknown") return "invalid-observation";
    if (previous.kind === "unknown") return "write";
    if (same(previous, next)) return "unchanged";
    if (previous.kind === "revision") {
      // Server Progress has no deletion. Even newer absence evidence cannot erase a row.
      if (next.kind === "absent") return "absence-after-revision";
      if (ordinal(next.revision) < ordinal(previous.revision)) return "stale-observation";
      if (next.revision === previous.revision) return "inconsistent-observation";
      return ordinal(next.cursor) > ordinal(previous.cursor) ? "write" : "inconsistent-observation";
    }
    if (next.kind === "revision") return ordinal(next.cursor) > ordinal(previous.evidence.throughCursor)
      ? "write" : "inconsistent-observation";
    return ordinal(next.evidence.highWaterCursor) >= ordinal(previous.evidence.highWaterCursor) &&
      ordinal(next.evidence.throughCursor) >= ordinal(previous.evidence.throughCursor)
      ? "write" : "stale-observation";
  }

  function evaluate(value) {
    const no = reason => ({ status: "not-ready", reason });
    if (!value || value.scopeValid !== true) return no("scope-mismatch");
    if (value.transitionInactive !== true) return no("workspace-transition");
    const record = value.record;
    if (!record?.confirmed) return no("no-confirmed-desired");
    if (record.pending) return no("pending-movement");
    if (value.fenceValid !== true) return no("stale-fence");
    const base = normalizeBase(record.confirmed.causalBase);
    if (!base) return no("malformed-base");
    if (base.kind === "unanchored") return no("unanchored");
    if (base.kind === "unknown") return no("unknown-base");
    const observation = normalizeObservation(value.observation);
    if (!observation || observation.kind === "unknown") return no("unknown-observation");
    if (value.observationDiagnostic) return no("observation-anomaly");
    const { parent: frozen, ...baseFact } = base;
    // Absence remains the same causal state across stronger completed inventories.
    const matches = base.kind === "absent" ? observation.kind === "absent" &&
      ordinal(observation.evidence.highWaterCursor) >= ordinal(base.evidence.highWaterCursor) &&
      ordinal(observation.evidence.throughCursor) >= ordinal(base.evidence.throughCursor)
      : same(baseFact, observation);
    if (!matches) return no("stale-base");
    const sidecar = value.sidecar;
    const parent = trustedParent(sidecar);
    if (!revision(sidecar?.knownRevision)) return no("parent-cloud-identity-missing");
    if (!parent || !frozen) return no("parent-context-unknown");
    if (value.articleActive !== true || parent.lifecycle !== "active" || frozen.lifecycle !== "active") return no("parent-inactive");
    if (value.cloudEligible !== true) return no("parent-local-only");
    if (value.hasConflict !== false) return no("parent-conflict");
    if (value.bootstrapSafe !== true) return no("parent-bootstrap-unsafe");
    if (value.hasMutation !== false) return no("parent-mutation-pending");
    // Do NOT compare observation.parentReadingEpoch: a new action may replace old-epoch Progress.
    if (frozen.readingEpoch !== parent.readingEpoch) return no("parent-epoch-mismatch");
    if (frozen.contentFingerprint !== parent.contentFingerprint ||
        record.confirmed.checkpoint.contentFingerprint !== parent.contentFingerprint ||
        value.localFingerprint !== parent.contentFingerprint) return no("fingerprint-mismatch");
    return { status: "ready", mode: base.kind === "absent" ? "create" : "update" };
  }

  window.LingoFlowProgressCausalState = Object.freeze({ normalizeParent, normalizeEvidence,
    normalizeObservation, observationFromRecord, normalizeBase, captureBase, observationDecision,
    evaluate, trustedParent, ordinal, same, revision });
})();
