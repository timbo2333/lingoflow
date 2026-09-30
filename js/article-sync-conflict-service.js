(function() {
  "use strict";

  function revisionNumber(value) {
    if (typeof value !== "string" || !/^revision:[1-9][0-9]*$/.test(value)) return 0n;
    return BigInt(value.slice(9));
  }

  function create(options = {}) {
    function deps() {
      return {
        app: options.app || window.LingoFlowArticleSyncApp,
        state: options.state || window.LingoFlowSyncStateRepository,
        repository: options.repository || window.LingoFlowArticleSyncRepository,
        engine: options.engine || window.LingoFlowArticleSyncLocalEngine,
        cloud: options.cloud || window.LingoFlowArticleSyncCloudService?.create()
      };
    }

    function context() {
      const current = deps().app?.getResolutionContext?.();
      return current?.status === "ready" ? current : null;
    }

    function contextCurrent(value) {
      return Boolean(deps().app?.isResolutionContextCurrent?.(value));
    }

    function emit() {
      window.dispatchEvent(new CustomEvent("lingoflow:article-sync-issues-changed"));
    }

    async function listIssues() {
      const current = context();
      if (!current) return { status: "inactive", issues: [] };
      const { state, repository } = deps();
      const [runtime, bootstrap] = await Promise.all([
        state.listArticleRuntimeIssues(current.owner.ownerId, current.owner.bindingId),
        state.listArticleBootstrapIssues(current.owner.ownerId, current.owner.bindingId)
      ]);
      if (!contextCurrent(current)) return { status: "discarded", issues: [] };
      if (runtime.status !== "ready" || bootstrap.status !== "ready") {
        return { status: "unavailable", issues: [] };
      }
      const grouped = new Map();
      for (const issue of [...bootstrap.issues, ...runtime.issues]) {
        const existing = grouped.get(issue.articleId);
        const preferred = !existing ||
          revisionNumber(issue.remoteRevision) >= revisionNumber(existing.remoteRevision)
          ? issue
          : existing;
        const oversized = issue.reason === "article-too-large" ||
          existing?.reason === "article-too-large";
        grouped.set(issue.articleId, {
          ...preferred,
          ...(oversized ? { reason: "article-too-large" } : {}),
          issueKinds: Array.from(new Set([
            ...(existing?.issueKinds || (existing ? [existing.kind] : [])),
            issue.kind
          ])).sort()
        });
      }
      const issues = [];
      for (const issue of grouped.values()) {
        issues.push({
          ...issue,
          localProjection: await repository.getProjection(issue.articleId) || issue.localProjection
        });
      }
      return {
        status: "ready",
        owner: { ...current.owner },
        issues: issues.sort((left, right) => left.articleId.localeCompare(right.articleId))
      };
    }

    async function getIssue(articleId) {
      const listed = await listIssues();
      if (listed.status !== "ready") return { ...listed, issue: null };
      const issue = listed.issues.find(item => item.articleId === articleId) || null;
      return { ...listed, status: issue ? "ready" : "missing", issue };
    }

    async function refreshIfRemoteChanged(current, issue) {
      const { cloud, state } = deps();
      const snapshot = await cloud.snapshot(current.owner, issue.articleId);
      if (!contextCurrent(current)) return { status: "discarded" };
      if (snapshot.status === "unavailable") return snapshot;
      const nextRevision = snapshot.status === "found" ? snapshot.revision : null;
      if (nextRevision === issue.remoteRevision) {
        return { status: "current", snapshot };
      }
      const refreshed = await state.refreshArticleConflictIssue({
        ...current.owner,
        articleId: issue.articleId,
        remoteProjection: snapshot.status === "found" ? snapshot.projection : null,
        remoteRevision: nextRevision,
        remoteCursor: snapshot.status === "found" ? snapshot.cursor : null
      });
      emit();
      return refreshed.status === "refreshed"
        ? { status: "stale", reason: "remote-changed-during-resolution" }
        : refreshed;
    }

    async function resumeAfterResolution() {
      const { app } = deps();
      const started = await app.start();
      if (["active", "paused"].includes(started?.status)) return await app.syncNow();
      return started;
    }

    async function keepLocal(articleId) {
      const current = context();
      if (!current) return { status: "inactive", reason: "article-sync-disabled" };
      const selected = await getIssue(articleId);
      if (selected.status !== "ready" || !contextCurrent(current)) return selected;
      const issue = selected.issue;
      let remoteProjection = issue.remoteProjection;
      let remoteRevision = issue.remoteRevision;
      if (navigator.onLine !== false) {
        const checked = await refreshIfRemoteChanged(current, issue);
        if (checked.status !== "current") return checked;
        remoteProjection = checked.snapshot.status === "found"
          ? checked.snapshot.projection
          : null;
        remoteRevision = checked.snapshot.status === "found"
          ? checked.snapshot.revision
          : null;
      }
      const localProjection = await deps().repository.getProjection(articleId);
      if (!localProjection || !contextCurrent(current)) {
        return { status: "failed", reason: "local-article-missing" };
      }
      if (window.LingoFlowArticleSyncSize
        .validateArticleCloudSyncSize(localProjection).status !== "valid") {
        await deps().state.quarantineOversizedArticle(
          current.owner.ownerId, current.owner.bindingId, articleId
        );
        emit();
        return { status: "blocked", reason: "article-too-large" };
      }
      const localDeleted = localProjection.deletedAt !== null;
      const remoteDeleted = remoteProjection?.deletedAt !== null && Boolean(remoteProjection);
      const operation = localDeleted ? "delete" : remoteDeleted ? "restore" : "put";
      const mutationId = `article-resolution:${crypto.randomUUID()}`;
      const prepared = await deps().state.prepareArticleKeepLocalResolution({
        ...current.owner,
        articleId,
        mutationId,
        operation,
        expectedRevision: remoteRevision,
        candidate: localProjection,
        candidateFingerprint: await deps().engine.fingerprint(localProjection),
        remoteProjection,
        remoteFingerprint: await deps().engine.fingerprint(remoteProjection)
      });
      if (!contextCurrent(current)) return { status: "discarded" };
      emit();
      if (prepared.status !== "ready") return prepared;
      if (navigator.onLine === false) {
        void resumeAfterResolution();
        return { status: "waiting", reason: "offline", mutationId };
      }
      const resumed = await resumeAfterResolution();
      emit();
      const after = await getIssue(articleId);
      if (after.status === "missing") return { status: "resolved", action: "keep-local" };
      return ["unavailable", "paused"].includes(resumed?.status)
        ? { status: "waiting", reason: resumed.reason || "network-unavailable" }
        : { status: "pending", reason: after.issue?.reason || "resolution-pending" };
    }

    async function useRemote(articleId) {
      const current = context();
      if (!current) return { status: "inactive", reason: "article-sync-disabled" };
      if (navigator.onLine === false) {
        return { status: "unavailable", reason: "online-verification-required" };
      }
      const selected = await getIssue(articleId);
      if (selected.status !== "ready" || !contextCurrent(current)) return selected;
      const issue = selected.issue;
      const checked = await refreshIfRemoteChanged(current, issue);
      if (checked.status !== "current") return checked;
      if (checked.snapshot.status !== "found") {
        return { status: "unavailable", reason: "remote-version-unavailable" };
      }
      const remoteProjection = checked.snapshot.projection;
      const localProjection = await deps().repository.getProjection(articleId);
      const begun = await deps().state.beginArticleUseRemoteResolution({
        ...current.owner,
        articleId,
        expectedRevision: checked.snapshot.revision
      });
      if (begun.status !== "ready" || !contextCurrent(current)) return begun;
      emit();
      const applied = await deps().repository.applyResolvedRemoteProjection({
        ...current.owner,
        remoteProjection,
        expectedProjection: localProjection
      });
      if (!contextCurrent(current)) return { status: "discarded" };
      if (applied.status !== "committed") {
        await deps().state.resetArticleConflictResolution(
          current.owner.ownerId,
          current.owner.bindingId,
          articleId
        );
        emit();
        return applied;
      }
      const finalized = await deps().state.finalizeArticleUseRemoteResolution({
        ...current.owner,
        articleId,
        remoteProjection,
        remoteRevision: checked.snapshot.revision,
        remoteFingerprint: await deps().engine.fingerprint(remoteProjection)
      });
      if (!contextCurrent(current)) return { status: "discarded" };
      emit();
      if (finalized.status !== "resolved") return finalized;
      void resumeAfterResolution();
      return { status: "resolved", action: "use-remote", article: applied.article };
    }

    return Object.freeze({ listIssues, getIssue, keepLocal, useRemote });
  }

  window.LingoFlowArticleSyncConflictService = Object.freeze({ ...create(), create });
})();
