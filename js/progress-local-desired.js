(function() {
  "use strict";

  const state = window.LingoFlowSyncStateRepository;
  const library = window.LingoFlowArticleLibrary;
  const resume = window.LingoFlowReadingResume;
  let generation = 0;
  const inFlight = new Set();
  const retryableActions = new Map();
  // This lock is optional; the Article transaction fence is authoritative.
  const withArticleLock = (articleId, work) => window.navigator.locks?.request
    ? window.navigator.locks.request(`lingoflow:progress:${articleId}`, work) : work();
  const same = (left, right) => JSON.stringify(left || null) === JSON.stringify(right || null);
  const samePosition = (left, right) => Boolean(left && right &&
    left.progress === right.progress && left.paragraphIndex === right.paragraphIndex &&
    left.contentFingerprint === right.contentFingerprint);

  const currentOwner = async () => {
    const auth = window.LingoFlowSupabaseAuth?.getState();
    if (auth?.status !== "authenticated" || !auth.user?.id) return null;
    const workspace = await state.getWorkspaceBinding();
    if (workspace.status !== "ready" || workspace.binding.ownerId !== auth.user.id) return null;
    return { ownerId: auth.user.id, bindingId: workspace.binding.bindingId };
  };
  const stillCurrent = async (owner, capturedGeneration) => {
    if (generation !== capturedGeneration) return false;
    const current = await currentOwner();
    return current?.ownerId === owner.ownerId && current?.bindingId === owner.bindingId &&
      generation === capturedGeneration;
  };
  const validContext = async (context, fingerprint) => context.status === "ready" &&
    !context.article.deletedAt &&
    await resume.fingerprintContent(context.article.content) === fingerprint;
  const observedResume = context => {
    const raw = context.article.reading?.resume;
    const normalized = resume.normalizeCheckpoint(raw);
    return { normalized, malformed: raw !== undefined && raw !== null && !normalized };
  };
  const fenceMatchesAction = (context, pending) =>
    context.fence.action?.actionId === pending.actionId &&
    context.fence.action?.localSeq === pending.localSeq &&
    context.fence.action?.scopeToken === pending.scope.scopeToken &&
    context.fence.lifecycleToken === pending.articleFence.lifecycleToken;

  async function quarantine(owner, pending, reason) {
    await state.settleProgressMovement(owner.ownerId, owner.bindingId,
      pending.articleId, pending.actionId, "quarantine", reason);
    return { status: "blocked", reason };
  }

  async function applyPending(owner, pending, furthest, capturedGeneration) {
    if (!await stillCurrent(owner, capturedGeneration)) return { status: "owner-changed" };
    const row = await state.getProgressDesired(owner.ownerId, owner.bindingId, pending.articleId);
    if (row.status !== "ready" || row.record?.pending?.actionId !== pending.actionId) {
      return { status: row.status === "ready" ? "superseded"
        : row.status === "failed" ? "retryable" : row.status };
    }
    const context = await library.getProgressContext(pending.articleId, owner);
    if (context.status === "workspace-transition") {
      return { status: "retryable", reason: "workspace-transition", actionId: pending.actionId };
    }
    if (!await validContext(context, pending.contentFingerprint)) {
      return quarantine(owner, pending, "content-or-lifecycle-changed");
    }
    if (context.scope.scopeToken !== pending.scope?.scopeToken ||
        context.fence.lifecycleToken !== pending.articleFence?.lifecycleToken) {
      return quarantine(owner, pending, "scope-or-lifecycle-changed");
    }
    const actual = observedResume(context);
    if (actual.malformed) return quarantine(owner, pending, "malformed-resume");
    if (fenceMatchesAction(context, pending) && same(actual.normalized, pending.target)) {
      if (!await stillCurrent(owner, capturedGeneration)) return { status: "owner-changed" };
      return state.settleProgressMovement(owner.ownerId, owner.bindingId,
        pending.articleId, pending.actionId, "promote", null, context.fence);
    }
    if (!await stillCurrent(owner, capturedGeneration)) return { status: "owner-changed" };
    const written = await library.commitReadingResumeIfCurrent({
      articleId: pending.articleId, expectedContent: context.article.content,
      contentFingerprint: pending.contentFingerprint,
      beforeResume: pending.beforeResume, target: pending.target, furthest,
      scope: pending.scope, expectedFence: pending.articleFence, action: pending
    });
    if (["committed", "already-applied"].includes(written.status)) {
      if (!await stillCurrent(owner, capturedGeneration)) return { status: "owner-changed" };
      const verified = await library.getProgressContext(pending.articleId, owner);
      if (verified.status === "ready" && fenceMatchesAction(verified, pending) &&
          same(observedResume(verified).normalized, pending.target)) {
        return state.settleProgressMovement(owner.ownerId, owner.bindingId,
          pending.articleId, pending.actionId, "promote", null, verified.fence);
      }
      return quarantine(owner, pending, "article-fence-changed-before-promotion");
    }
    if (written.status === "workspace-transition") {
      return { status: "retryable", reason: "workspace-transition", actionId: pending.actionId };
    }
    return quarantine(owner, pending, written.status);
  }

  async function localOnlyWrite(articleId, checkpoint, furthest, context) {
    if (!await validContext(context, checkpoint.contentFingerprint)) {
      return { status: "content-or-lifecycle-changed" };
    }
    if (observedResume(context).malformed) return { status: "malformed-resume" };
    const result = await library.commitReadingResumeIfCurrent({
      articleId, expectedContent: context.article.content,
      contentFingerprint: checkpoint.contentFingerprint,
      beforeResume: observedResume(context).normalized, target: checkpoint, furthest,
      scope: context.scope, expectedFence: context.fence
    });
    return result.status === "committed"
      ? { status: "local-only", article: result.article }
      : { status: result.status };
  }

  async function writeRealMovement(articleId, target, furthest = null) {
    const checkpoint = resume.normalizeCheckpoint(target);
    if (!checkpoint) throw new Error("真实阅读移动缺少有效 Resume。");
    const capturedGeneration = generation;
    const operation = withArticleLock(articleId, async () => {
      let owner = null;
      let ownerInfrastructureUnavailable = false;
      try { owner = await currentOwner(); }
      catch { ownerInfrastructureUnavailable = true; }
      if (!owner) {
        const auth = window.LingoFlowSupabaseAuth?.getState();
        const context = await library.getProgressContext(articleId);
        if (auth?.status === "authenticated") {
          if (context.scope && context.scope.ownerId !== auth.user?.id) {
            return { status: "scope-mismatch" };
          }
          const binding = await state.getWorkspaceBinding();
          if (binding.status === "ready" && (binding.binding.ownerId !== auth.user?.id ||
              (context.scope && binding.binding.bindingId !== context.scope.bindingId))) {
            return { status: "scope-mismatch" };
          }
          if (!context.scope && (ownerInfrastructureUnavailable ||
              binding.status !== "missing")) {
            return { status: "workspace-unconfirmed" };
          }
        }
        if (context.status !== "ready") return { status: context.status };
        // No trusted binding means local-only, never an owner-scoped desired.
        // A genuine repository outage and an unconfirmed workspace take the
        // same safe local path; a different owner's Article scope is blocked.
        const local = await localOnlyWrite(articleId, checkpoint, furthest, context);
        return { ...local, ...(ownerInfrastructureUnavailable
          ? { reason: "progress-repository-unavailable" } : {}) };
      }
      const context = await library.getProgressContext(articleId, owner);
      let current;
      try { current = await stillCurrent(owner, capturedGeneration); }
      catch { return localOnlyWrite(articleId, checkpoint, furthest, context); }
      if (!current) return { status: "owner-changed" };
      if (!await validContext(context, checkpoint.contentFingerprint)) {
        return { status: context.status === "scope-mismatch"
          ? "scope-mismatch" : "content-or-lifecycle-changed" };
      }
      if (observedResume(context).malformed) return { status: "malformed-resume" };
      const retry = retryableActions.get(articleId);
      if (retry && (retry.ownerId !== owner.ownerId || retry.bindingId !== owner.bindingId)) {
        retryableActions.delete(articleId);
      } else if (retry) {
        try {
          const existing = await state.getProgressDesired(owner.ownerId, owner.bindingId, articleId);
          if (existing.status !== "ready") return { status: "retryable", actionId: retry.actionId };
          const pending = existing.record?.pending;
          if (samePosition(retry.target, checkpoint) && pending?.actionId === retry.actionId) {
            try {
              const result = await applyPending(owner, pending, furthest, capturedGeneration);
              if (result.status !== "retryable") retryableActions.delete(articleId);
              return result;
            } catch {
              return { status: "retryable", actionId: retry.actionId };
            }
          }
          if (samePosition(retry.target, checkpoint)) {
            retryableActions.delete(articleId);
            if (!pending && samePosition(existing.record?.confirmed?.checkpoint, checkpoint)) {
              const confirmed = await evaluateConfirmed(owner.ownerId, owner.bindingId, articleId);
              if (confirmed.status === "ready") return { status: "confirmed", article: context.article };
            }
            return { status: "superseded" };
          }
          retryableActions.delete(articleId);
        } catch {
          return { status: "retryable", actionId: retry.actionId };
        }
      }
      let prepared;
      try {
        prepared = await state.prepareProgressMovement({
          ...owner, articleId, target: checkpoint,
          beforeResume: observedResume(context).normalized,
          scope: context.scope, articleFence: context.fence
        });
      } catch {
        // Infrastructure failure: preserve local Resume via CAS, without desired.
        let stillOwned;
        try { stillOwned = await stillCurrent(owner, capturedGeneration); }
        catch {
          const auth = window.LingoFlowSupabaseAuth?.getState();
          stillOwned = auth?.status === "authenticated" &&
            auth.user?.id === owner.ownerId && generation === capturedGeneration;
        }
        if (!stillOwned) return { status: "owner-changed" };
        return localOnlyWrite(articleId, checkpoint, furthest, context);
      }
      if (prepared.status !== "prepared") return prepared;
      try {
        const result = await applyPending(owner, prepared.pending, furthest, capturedGeneration);
        if (result.status === "retryable") retryableActions.set(articleId,
          { actionId: prepared.pending.actionId, target: prepared.pending.target, ...owner });
        return result;
      } catch {
        // Once durable provenance exists, recovery must reuse this action.
        retryableActions.set(articleId,
          { actionId: prepared.pending.actionId, target: prepared.pending.target, ...owner });
        return { status: "retryable", actionId: prepared.pending.actionId };
      }
    });
    inFlight.add(operation);
    try { return await operation; }
    finally { inFlight.delete(operation); }
  }

  async function evaluateConfirmed(ownerId, bindingId, articleId) {
    const row = await state.getProgressDesired(ownerId, bindingId, articleId);
    if (row.status !== "ready" || !row.record?.confirmed) return { status: "not-ready" };
    const context = await library.getProgressContext(articleId, { ownerId, bindingId });
    if (context.status !== "ready" || context.article.deletedAt) return { status: "blocked" };
    const { checkpoint, fence } = row.record.confirmed;
    if (!checkpoint || !fence || !same(fence, context.fence) ||
        !same(observedResume(context).normalized, checkpoint) ||
        await resume.fingerprintContent(context.article.content) !== checkpoint.contentFingerprint) {
      return { status: "blocked" };
    }
    return { status: "ready", checkpoint };
  }

  // Read-only advisory evaluation. No cross-DB atomic send authority is implied;
  // a future transport must revalidate when it durably prepares a cloud attempt.
  async function evaluateCloudCandidate(ownerId, bindingId, articleId) {
    const owner = { ownerId, bindingId };
    const capturedGeneration = generation;
    const no = reason => ({ status: "not-ready", reason });
    if (!await stillCurrent(owner, capturedGeneration)) return no("scope-mismatch");
    const context = await library.getProgressContext(articleId, owner, { initialize: false });
    if (context.status !== "ready") return no(context.status);
    const snapshot = await state.getProgressCausalSnapshot(ownerId, bindingId, articleId);
    if (snapshot.status !== "ready") return no(snapshot.reason || snapshot.status);
    const localFingerprint = await resume.fingerprintContent(context.article.content);
    const verified = await library.getProgressContext(articleId, owner, { initialize: false });
    const finalSnapshot = await state.getProgressCausalSnapshot(ownerId, bindingId, articleId);
    if (!await stillCurrent(owner, capturedGeneration)) return no("scope-mismatch");
    if (verified.status !== "ready") return no(verified.status);
    if (!same(context, verified) || !same(snapshot, finalSnapshot)) return no("state-changed");
    const confirmed = snapshot.record?.confirmed;
    return window.LingoFlowProgressCausalState.evaluate({ ...snapshot,
      scopeValid: context.scope?.ownerId === ownerId && context.scope?.bindingId === bindingId,
      transitionInactive: true,
      fenceValid: Boolean(confirmed && same(confirmed.fence, context.fence) &&
        same(observedResume(context).normalized, confirmed.checkpoint) &&
        context.fence.action?.ownerId === ownerId && context.fence.action?.bindingId === bindingId &&
        context.fence.action?.scopeToken === context.scope?.scopeToken),
      articleActive: !context.article.deletedAt,
      cloudEligible: window.LingoFlowArticleSyncSize.validateArticleCloudSyncSize(context.article).status === "valid",
      localFingerprint
    });
  }

  // A local snapshot for freezing an attempt, not authorization to dispatch it.
  async function cloudAttemptPreflight(owner, articleId) {
    const context = await library.getProgressContext(articleId, owner, { initialize: false });
    if (context.status !== "ready") return { status: "not-ready", reason: context.status };
    const checkpoint = resume.normalizeCheckpoint(context.article.reading?.resume);
    if (!checkpoint) return { status: "not-ready", reason: "resume-missing" };
    const fingerprint = await resume.fingerprintContent(context.article.content);
    const verified = await library.getProgressContext(articleId, owner, { initialize: false });
    if (verified.status !== "ready" || !same(context, verified)) {
      return { status: "not-ready", reason: "local-preflight-changed" };
    }
    return { status: "ready", local: {
      scope: context.scope, fence: context.fence, checkpoint, fingerprint,
      articleActive: !context.article.deletedAt,
      cloudEligible: window.LingoFlowArticleSyncSize.validateArticleCloudSyncSize(context.article).status === "valid",
      transitionInactive: true
    } };
  }

  async function prepareCloudAttempt(ownerId, bindingId, articleId) {
    const owner = { ownerId, bindingId };
    const capturedGeneration = generation;
    const no = reason => ({ status: "not-ready", reason });
    if (!await stillCurrent(owner, capturedGeneration)) return no("scope-mismatch");
    const before = await cloudAttemptPreflight(owner, articleId);
    if (before.status !== "ready") return before;
    if (!await stillCurrent(owner, capturedGeneration)) return no("scope-mismatch");
    const result = await state.prepareProgressCloudAttempt(ownerId, bindingId, articleId, before.local);
    if (result.status !== "awaiting-postflight") return result;

    let after;
    let current;
    try {
      after = await cloudAttemptPreflight(owner, articleId);
      current = await stillCurrent(owner, capturedGeneration);
    } catch {
      // Infrastructure failure is not proof of a changed Article. Leave the
      // non-dispatchable awaiting record for explicit recovery.
      return { status: "retryable", reason: "local-postflight-unavailable" };
    }
    if (!current || after?.status !== "ready" || !same(before.local, after.local)) {
      const blocked = await state.rejectAwaitingProgressCloudAttempt(ownerId, bindingId,
        articleId, result.attempt.attemptId, "local-postflight-changed");
      // Binding replacement transaction also blocks the old scope's prepared
      // attempts. Never return an attempt as prepared after failed postflight.
      return { status: "not-ready", reason: "local-postflight-changed",
        attemptStatus: blocked.status };
    }
    return state.confirmProgressCloudAttempt(ownerId, bindingId, articleId,
      result.attempt.attemptId, after.local);
  }

  // Explicit crash recovery only. No timer or network path is attached to it.
  async function resumeCloudAttemptPostflight(ownerId, bindingId, articleId, attemptId) {
    const owner = { ownerId, bindingId };
    const capturedGeneration = generation;
    if (!await stillCurrent(owner, capturedGeneration)) {
      return { status: "not-ready", reason: "scope-mismatch" };
    }
    const stored = await state.getProgressCloudAttempt(ownerId, bindingId, articleId, attemptId);
    if (stored.status !== "ready") return stored;
    if (stored.attempt.status === "prepared") return { status: "prepared", attempt: stored.attempt };
    if (stored.attempt.status !== "awaiting_postflight") {
      return { status: "not-awaiting-postflight", attemptStatus: stored.attempt.status };
    }
    let postflight;
    try { postflight = await cloudAttemptPreflight(owner, articleId); }
    catch { return { status: "retryable", reason: "local-postflight-unavailable" }; }
    if (!await stillCurrent(owner, capturedGeneration)) {
      return { status: "not-ready", reason: "scope-mismatch" };
    }
    if (postflight.status !== "ready") {
      const rejected = await state.rejectAwaitingProgressCloudAttempt(ownerId, bindingId,
        articleId, attemptId, "local-postflight-changed");
      return rejected.status === "prepared" ? rejected :
        { status: "not-ready", reason: "local-postflight-changed", attemptStatus: rejected.status };
    }
    return state.confirmProgressCloudAttempt(ownerId, bindingId, articleId,
      attemptId, postflight.local);
  }

  // Re-read LibraryDB now, then atomically recheck SyncDB and persist the
  // conservative may-have-sent state before exposing a request to transport.
  async function reserveCloudAttemptForDispatch(ownerId, bindingId, articleId, attemptId) {
    const owner = { ownerId, bindingId };
    const capturedGeneration = generation;
    if (!await stillCurrent(owner, capturedGeneration)) {
      return { status: "not-ready", reason: "scope-mismatch" };
    }
    const stored = await state.getProgressCloudAttempt(ownerId, bindingId, articleId, attemptId);
    if (stored.status !== "ready") return stored;
    if (stored.attempt.status !== "prepared") {
      return { status: "not-prepared", attemptStatus: stored.attempt.status };
    }
    let preflight;
    try { preflight = await cloudAttemptPreflight(owner, articleId); }
    catch { return { status: "retryable", reason: "local-revalidation-unavailable" }; }
    if (!await stillCurrent(owner, capturedGeneration)) {
      return { status: "not-ready", reason: "scope-mismatch" };
    }
    if (preflight.status !== "ready") {
      const blocked = await state.blockPreparedProgressCloudAttempt(ownerId, bindingId,
        articleId, attemptId, "local-state-advanced");
      return { status: "not-ready", reason: "local-state-advanced", attemptStatus: blocked.status };
    }
    const reserved = await state.reserveProgressCloudAttemptForDispatch(ownerId, bindingId,
      articleId, attemptId);
    // A switch after commit leaves the durable conservative state intact, but
    // an old-owner callback must not hand a request to a future transport.
    if (!await stillCurrent(owner, capturedGeneration)) {
      return { status: "not-ready", reason: "scope-mismatch" };
    }
    return reserved;
  }

  // Capture before a future network call. A late response must present this
  // original runtime generation rather than acquiring a new one after a switch.
  async function captureCloudResponseContext(ownerId, bindingId) {
    const owner = { ownerId, bindingId };
    const capturedGeneration = generation;
    return await stillCurrent(owner, capturedGeneration)
      ? Object.freeze({ ownerId, bindingId, generation: capturedGeneration }) : null;
  }

  async function settleCloudResult(responseContext, articleId, attemptId, rawResult) {
    const owner = { ownerId: responseContext?.ownerId, bindingId: responseContext?.bindingId };
    const capturedGeneration = responseContext?.generation;
    if (!Number.isSafeInteger(capturedGeneration) ||
        !await stillCurrent(owner, capturedGeneration)) {
      return { status: "not-ready", reason: "scope-mismatch" };
    }
    const operation = state.settleProgressCloudResult(owner.ownerId, owner.bindingId,
      articleId, attemptId, rawResult);
    inFlight.add(operation);
    try { return await operation; }
    finally { inFlight.delete(operation); }
  }

  // A two-sided read is advisory only. Its answer must never be persisted as
  // permanent sync authority or used as permission to send another request.
  async function evaluateLatestLocalCloudCoverage(ownerId, bindingId, articleId) {
    try {
      const owner = { ownerId, bindingId };
      const capturedGeneration = generation;
      if (!await stillCurrent(owner, capturedGeneration)) return { status: "scope-mismatch" };
      const readSync = async () => {
        const [desired, observation, attempts] = await Promise.all([
          state.getProgressDesired(ownerId, bindingId, articleId),
          state.getProgressRemoteObservation(ownerId, bindingId, articleId),
          state.listProgressCloudAttempts(ownerId, bindingId, articleId)
        ]);
        const parent = await state.getArticleServerReadingContext(ownerId, bindingId, articleId);
        return { desired, observation, attempts, parent };
      };
      const first = await readSync();
      if ([first.desired.status, first.observation.status, first.attempts.status, first.parent.status]
        .some(status => status !== "ready")) return { status: "unknown" };
      const context = await library.getProgressContext(articleId, owner, { initialize: false });
      if (context.status !== "ready") return { status: "unknown" };
      const local = { status: "ready", articleId, scope: context.scope, fence: context.fence,
        checkpoint: resume.normalizeCheckpoint(context.article.reading?.resume),
        fingerprint: await resume.fingerprintContent(context.article.content),
        active: !context.article.deletedAt };
      const verified = await library.getProgressContext(articleId, owner, { initialize: false });
      const finalSync = await readSync();
      if (!await stillCurrent(owner, capturedGeneration)) return { status: "scope-mismatch" };
      if (verified.status !== "ready" || !same(context, verified) || !same(first, finalSync) ||
          !local.checkpoint) return { status: "unknown" };
      if (first.observation.diagnostic || first.parent.diagnostic) return { status: "unknown" };
      if (first.desired.record?.pending) return { status: "pending-local" };
      const causal = window.LingoFlowProgressCausalState;
      const successes = first.attempts.attempts.filter(item => item.status === "succeeded")
        .sort((a, b) => {
          const order = causal.ordinal(b.settlement.result.revision) -
            causal.ordinal(a.settlement.result.revision);
          return order > 0n ? 1 : order < 0n ? -1 : b.sourceLocalSeq - a.sourceLocalSeq;
        });
      if (!successes.length) return { status: "unknown" };
      const values = successes.map(attempt => window.LingoFlowProgressCloudResult.evaluateCoverage({
        attempt: { ...attempt, result: attempt.settlement.result },
        desired: first.desired.record, observation: first.observation.observation,
        parent: first.parent.context, local
      }));
      return { status: values.includes("covered") ? "covered" : values[0] };
    } catch {
      // This is an advisory cross-DB snapshot; an unavailable read cannot
      // establish that the latest local position is covered.
      return { status: "unknown" };
    }
  }

  async function reconcileInternal() {
    const capturedGeneration = generation;
    const owner = await currentOwner();
    if (!owner || !await stillCurrent(owner, capturedGeneration)) return { status: "unbound" };
    const listed = await state.listProgressDesired(owner.ownerId, owner.bindingId);
    if (listed.status !== "ready") return listed;
    const results = [];
    for (const record of listed.records) {
      if (!record.pending || !await stillCurrent(owner, capturedGeneration)) continue;
      results.push(await withArticleLock(record.articleId,
        () => applyPending(owner, record.pending, null, capturedGeneration)));
    }
    return { status: "ready", results, malformedCount: listed.malformedCount };
  }

  async function reconcile() {
    const operation = reconcileInternal();
    inFlight.add(operation);
    try { return await operation; }
    finally { inFlight.delete(operation); }
  }

  async function prepareAccountSwitch() {
    generation++;
    retryableActions.clear();
    await Promise.allSettled([...inFlight]);
  }

  window.LingoFlowProgressLocalDesired = Object.freeze({
    writeRealMovement, reconcile, evaluateConfirmed, evaluateCloudCandidate,
    prepareCloudAttempt, resumeCloudAttemptPostflight,
    reserveCloudAttemptForDispatch, captureCloudResponseContext,
    settleCloudResult, evaluateLatestLocalCloudCoverage, prepareAccountSwitch
  });
  const scheduleReconcile = () => {
    void reconcile().catch(error => console.warn("Progress local recovery deferred:", error));
  };
  window.addEventListener("lingoflow:auth-state", scheduleReconcile);
  window.addEventListener("lingoflow:favorite-sync-status", scheduleReconcile);
  window.addEventListener("load", scheduleReconcile, { once: true });
})();
