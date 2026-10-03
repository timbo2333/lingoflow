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
    writeRealMovement, reconcile, evaluateConfirmed, evaluateCloudCandidate, prepareAccountSwitch
  });
  const scheduleReconcile = () => {
    void reconcile().catch(error => console.warn("Progress local recovery deferred:", error));
  };
  window.addEventListener("lingoflow:auth-state", scheduleReconcile);
  window.addEventListener("lingoflow:favorite-sync-status", scheduleReconcile);
  window.addEventListener("load", scheduleReconcile, { once: true });
})();
