(function() {
  "use strict";

  const encoder = new TextEncoder();

  async function fingerprint(projection) {
    if (projection === null) return null;
    const normalized = window.LingoFlowArticleSyncProjection
      .sanitizeArticleSyncProjection(projection);
    const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify(normalized)));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function create(deps = {}) {
    const library = deps.library || window.LingoFlowArticleLibrary;
    const repository = deps.repository || window.LingoFlowArticleSyncRepository;
    const state = deps.state || window.LingoFlowSyncStateRepository;
    const projection = window.LingoFlowArticleSyncProjection;
    const size = window.LingoFlowArticleSyncSize;
    const hooks = deps.hooks || {};

    async function mutate(operation, articleId, candidateRecord, owner) {
      const candidate = projection.projectArticleForSync(candidateRecord);
      const before = await repository.getProjection(articleId);
      const oversized = size.validateArticleCloudSyncSize(candidate).status !== "valid";
      if (!oversized && operation === "put" && before &&
          projection.compareArticleSyncProjection(before, candidate)) {
        return { status: "unchanged", articleId };
      }
      const binding = await state.getWorkspaceBinding();
      if (binding.status !== "ready" || binding.binding.ownerId !== owner?.ownerId ||
          binding.binding.bindingId !== owner?.bindingId) {
        return { status: "blocked", reason: "workspace-unbound-or-mismatch" };
      }
      if (oversized) {
        const written = await library.commitArticleSyncProjection(articleId, before, candidate);
        if (written.status !== "committed") return written;
        const quarantined = await state.quarantineOversizedArticle(
          owner.ownerId, owner.bindingId, articleId
        );
        return { status: "oversized", article: written.article, quarantine: quarantined };
      }
      const mutationId = `article:${crypto.randomUUID()}`;
      const sidecar = await state.getArticleSidecar(owner.ownerId, owner.bindingId, articleId);
      if (!["ready", "missing"].includes(sidecar.status)) return sidecar;
      const prepared = await state.prepareArticleMutation({
        ownerId: owner.ownerId,
        bindingId: owner.bindingId,
        mutationId,
        articleId,
        operation,
        beforeFingerprint: await fingerprint(before),
        candidateFingerprint: await fingerprint(candidate),
        baseRevision: sidecar.sidecar?.knownRevision ?? null,
        candidate
      });
      if (prepared.status !== "prepared") return prepared;
      // The two databases cannot share a transaction. Recovery handles every gap.
      const written = await library.commitArticleSyncProjection(articleId, before, candidate);
      if (written.status !== "committed") return written;
      const ready = await state.updateArticleMutationStatus(
        owner.ownerId, owner.bindingId, mutationId, "ready"
      );
      if (ready.status === "ready") {
        await state.clearOversizedArticleIssue(owner.ownerId, owner.bindingId, articleId);
      }
      return { ...ready, article: written.article, mutationId };
    }

    async function mutateDesired(operation, articleId, candidateRecord, owner) {
      const candidate = projection.projectArticleForSync(candidateRecord);
      const before = await repository.getProjection(articleId);
      const oversized = size.validateArticleCloudSyncSize(candidate).status !== "valid";
      if (!oversized && before && projection.compareArticleSyncProjection(before, candidate)) {
        return { status: "unchanged", article: await library.getArticle(articleId), articleId };
      }
      const binding = await state.getWorkspaceBinding();
      if (binding.status !== "ready" || binding.binding.ownerId !== owner?.ownerId ||
          binding.binding.bindingId !== owner?.bindingId) {
        return { status: "blocked", reason: "workspace-unbound-or-mismatch" };
      }
      if (oversized) {
        const written = await library.commitArticleSyncProjection(articleId, before, candidate);
        if (written.status !== "committed") return written;
        const quarantined = await state.quarantineOversizedArticle(
          owner.ownerId, owner.bindingId, articleId
        );
        return { status: "oversized", article: written.article, quarantine: quarantined };
      }
      const mutationId = `article:${crypto.randomUUID()}`;
      const sidecar = await state.getArticleSidecar(owner.ownerId, owner.bindingId, articleId);
      if (!["ready", "missing"].includes(sidecar.status)) return sidecar;
      const prepared = await state.prepareArticleMutation({
        ownerId: owner.ownerId,
        bindingId: owner.bindingId,
        mutationId,
        articleId,
        operation,
        beforeFingerprint: await fingerprint(before),
        candidateFingerprint: await fingerprint(candidate),
        baseRevision: sidecar.sidecar?.knownRevision ?? null,
        candidate,
        captureMode: "desired"
      });
      if (prepared.status !== "prepared") return prepared;
      await hooks.afterRuntimePrepared?.(prepared.mutation);
      const written = await library.commitArticleSyncProjection(articleId, before, candidate);
      if (written.status !== "committed") return written;
      await hooks.afterRuntimeLocalWrite?.({ mutation: prepared.mutation, article: written.article });
      const desired = await state.commitArticleDesired(
        owner.ownerId,
        owner.bindingId,
        mutationId
      );
      if (["desired", "unchanged"].includes(desired.status)) {
        await state.clearOversizedArticleIssue(owner.ownerId, owner.bindingId, articleId);
      }
      await hooks.afterRuntimeDesired?.(desired.mutation || null);
      return { ...desired, article: written.article, mutationId };
    }

    async function createDesiredArticle(input, owner) {
      const article = library.planCreateArticle(input);
      return await mutateDesired("put", article.id, article, owner);
    }

    async function editDesiredArticle(articleId, changes, owner) {
      const current = await library.getArticle(articleId);
      if (!current) return { status: "missing" };
      const next = library.planUpdatedArticle(current, changes);
      const operation = !current.deletedAt && next.deletedAt ? "delete"
        : current.deletedAt && !next.deletedAt ? "restore" : "put";
      return await mutateDesired(operation, articleId, next, owner);
    }

    async function captureExistingDesired(articleId, owner) {
      const candidate = await repository.getProjection(articleId);
      if (!candidate) return { status: "missing" };
      if (size.validateArticleCloudSyncSize(candidate).status !== "valid") {
        return await state.quarantineOversizedArticle(
          owner.ownerId, owner.bindingId, articleId
        );
      }
      const pending = await state.listArticleMutations(owner.ownerId, owner.bindingId);
      if (pending.status !== "ready") return pending;
      if (pending.items.some(item => item.articleId === articleId &&
          ["prepared", "desired", "ready", "issue"].includes(item.status))) {
        return { status: "existing" };
      }
      const sidecar = await state.getArticleSidecar(owner.ownerId, owner.bindingId, articleId);
      if (!["ready", "missing"].includes(sidecar.status)) return sidecar;
      const candidateFingerprint = await fingerprint(candidate);
      if (sidecar.sidecar?.lastSyncedFingerprint === candidateFingerprint) {
        await state.clearOversizedArticleIssue(owner.ownerId, owner.bindingId, articleId);
        return { status: "unchanged", articleId };
      }
      const mutationId = `article:${crypto.randomUUID()}`;
      const prepared = await state.prepareArticleMutation({
        ownerId: owner.ownerId,
        bindingId: owner.bindingId,
        mutationId,
        articleId,
        operation: candidate.deletedAt === null ? "put" : "delete",
        beforeFingerprint: candidateFingerprint,
        candidateFingerprint,
        baseRevision: sidecar.sidecar?.knownRevision ?? null,
        candidate,
        captureMode: "desired"
      });
      if (prepared.status !== "prepared") return prepared;
      const desired = await state.commitArticleDesired(owner.ownerId, owner.bindingId, mutationId);
      if (desired.status === "desired") {
        await state.clearOversizedArticleIssue(owner.ownerId, owner.bindingId, articleId);
      }
      return desired;
    }

    async function reconcileRuntimeDesired(owner) {
      const recovered = await recoverPrepared(owner);
      if (recovered.status !== "ready") return recovered;
      const [articles, mutations, issues] = await Promise.all([
        repository.listArticleProjections({ includeDeleted: true }),
        state.listArticleMutations(owner.ownerId, owner.bindingId),
        state.listArticleRuntimeIssues(owner.ownerId, owner.bindingId)
      ]);
      if (mutations.status !== "ready" || issues.status !== "ready") {
        return mutations.status !== "ready" ? mutations : issues;
      }
      const pendingIds = new Set(mutations.items.map(item => item.articleId));
      const oversizedIds = new Set(issues.issues
        .filter(issue => issue.reason === "article-too-large")
        .map(issue => issue.articleId));
      const outcomes = [];
      for (const article of articles) {
        if (size.validateArticleCloudSyncSize(article).status !== "valid") {
          if (!oversizedIds.has(article.id) || pendingIds.has(article.id)) {
            const quarantined = await state.quarantineOversizedArticle(
              owner.ownerId, owner.bindingId, article.id
            );
            if (quarantined.status !== "quarantined") return quarantined;
            outcomes.push(quarantined);
          }
          continue;
        }
        if (pendingIds.has(article.id)) {
          if (oversizedIds.has(article.id)) {
            const cleared = await state.clearOversizedArticleIssue(
              owner.ownerId, owner.bindingId, article.id
            );
            if (cleared.status !== "ready") return cleared;
            outcomes.push(cleared);
          }
          continue;
        }
        const sidecar = await state.getArticleSidecar(owner.ownerId, owner.bindingId, article.id);
        if (!["ready", "missing"].includes(sidecar.status)) return sidecar;
        if (sidecar.sidecar?.lastSyncedFingerprint === await fingerprint(article)) {
          if (oversizedIds.has(article.id)) {
            const cleared = await state.clearOversizedArticleIssue(
              owner.ownerId, owner.bindingId, article.id
            );
            if (cleared.status !== "ready") return cleared;
            outcomes.push(cleared);
          }
          continue;
        }
        const captured = await captureExistingDesired(article.id, owner);
        if (!["desired", "unchanged", "existing", "quarantined"].includes(captured.status)) {
          return captured;
        }
        outcomes.push(captured);
      }
      return { status: "ready", outcomes };
    }

    async function createArticle(input, owner) {
      const binding = await state.getWorkspaceBinding();
      if (binding.status === "missing") {
        return { status: "local-only", article: await library.createArticle(input) };
      }
      const article = library.planCreateArticle(input);
      return await mutate("put", article.id, article, owner);
    }

    async function editArticle(articleId, changes, owner) {
      const current = await library.getArticle(articleId);
      if (!current) return { status: "missing" };
      const binding = await state.getWorkspaceBinding();
      if (binding.status === "missing") {
        return { status: "local-only", article: await library.updateArticle(articleId, changes) };
      }
      const next = library.planUpdatedArticle(current, changes);
      const operation = !current.deletedAt && next.deletedAt ? "delete"
        : current.deletedAt && !next.deletedAt ? "restore" : "put";
      return await mutate(operation, articleId, next, owner);
    }

    async function deleteArticle(articleId, owner) {
      const current = await library.getArticle(articleId);
      if (!current) return { status: "missing" };
      if (current.deletedAt) return { status: "unchanged" };
      return await editArticle(articleId, { deletedAt: new Date().toISOString() }, owner);
    }

    async function restoreArticle(articleId, owner) {
      const current = await library.getArticle(articleId);
      if (!current) return { status: "missing" };
      if (!current.deletedAt) return { status: "unchanged" };
      return await editArticle(articleId, { deletedAt: null }, owner);
    }

    async function captureBootstrapArticle(articleId, owner) {
      const candidate = await repository.getProjection(articleId);
      if (!candidate) return { status: "missing" };
      const binding = await state.getWorkspaceBinding();
      if (binding.status !== "ready" || binding.binding.ownerId !== owner?.ownerId ||
          binding.binding.bindingId !== owner?.bindingId) {
        return { status: "blocked", reason: "workspace-unbound-or-mismatch" };
      }
      if (size.validateArticleCloudSyncSize(candidate).status !== "valid") {
        return await state.quarantineOversizedArticle(
          owner.ownerId, owner.bindingId, articleId
        );
      }
      const pending = await state.listArticleMutations(owner.ownerId, owner.bindingId);
      if (pending.status !== "ready") return pending;
      const existing = pending.items.find(item => item.articleId === articleId &&
        ["prepared", "ready"].includes(item.status));
      if (existing) return { status: "existing", mutation: existing };
      const sidecar = await state.getArticleSidecar(owner.ownerId, owner.bindingId, articleId);
      if (!["ready", "missing"].includes(sidecar.status)) return sidecar;
      if (sidecar.sidecar?.knownRevision) {
        return { status: "blocked", reason: "article-remote-state-ambiguous" };
      }
      const candidateFingerprint = await fingerprint(candidate);
      const mutationId = `article:${crypto.randomUUID()}`;
      const prepared = await state.prepareArticleMutation({
        ownerId: owner.ownerId,
        bindingId: owner.bindingId,
        mutationId,
        articleId,
        operation: candidate.deletedAt === null ? "put" : "delete",
        beforeFingerprint: candidateFingerprint,
        candidateFingerprint,
        baseRevision: null,
        candidate
      });
      if (prepared.status !== "prepared") return prepared;
      await hooks.afterBootstrapPrepared?.(prepared.mutation);
      const ready = await state.updateArticleMutationStatus(
        owner.ownerId, owner.bindingId, mutationId, "ready"
      );
      await hooks.afterBootstrapReady?.(ready.mutation);
      if (ready.status === "ready") {
        await state.clearOversizedArticleIssue(owner.ownerId, owner.bindingId, articleId);
      }
      return { ...ready, articleId, mutationId };
    }

    async function recoverPrepared(owner) {
      const list = await state.listArticleMutations(owner?.ownerId, owner?.bindingId, "prepared");
      if (list.status !== "ready") return list;
      const outcomes = [];
      async function finishPrepared(mutation) {
        const settled = mutation.captureMode === "desired"
          ? await state.commitArticleDesired(owner.ownerId, owner.bindingId, mutation.mutationId)
          : await state.updateArticleMutationStatus(
            owner.ownerId, owner.bindingId, mutation.mutationId, "ready"
          );
        if (["desired", "ready"].includes(settled.status)) {
          await state.clearOversizedArticleIssue(
            owner.ownerId, owner.bindingId, mutation.articleId
          );
        }
        return settled;
      }
      for (const mutation of list.items) {
        const current = await repository.getProjection(mutation.articleId);
        const currentFingerprint = await fingerprint(current);
        if (size.validateArticleCloudSyncSize(mutation.candidate).status !== "valid") {
          if (currentFingerprint === mutation.beforeFingerprint) {
            const written = await library.commitArticleSyncProjection(
              mutation.articleId, current, mutation.candidate
            );
            if (written.status !== "committed") return written;
          }
          outcomes.push(await state.quarantineOversizedArticle(
            owner.ownerId, owner.bindingId, mutation.articleId
          ));
          continue;
        }
        if (currentFingerprint === mutation.candidateFingerprint) {
          outcomes.push(await finishPrepared(mutation));
        } else if (currentFingerprint === mutation.beforeFingerprint) {
          const written = await library.commitArticleSyncProjection(
            mutation.articleId, current, mutation.candidate
          );
          outcomes.push(written.status === "committed"
            ? await finishPrepared(mutation)
            : written);
        } else {
          outcomes.push(await state.updateArticleMutationStatus(
            owner.ownerId, owner.bindingId, mutation.mutationId, "issue",
            "prepared-local-projection-diverged"
          ));
        }
      }
      return { status: "ready", outcomes };
    }

    return Object.freeze({
      createArticle,
      editArticle,
      deleteArticle,
      restoreArticle,
      createDesiredArticle,
      editDesiredArticle,
      captureExistingDesired,
      reconcileRuntimeDesired,
      captureBootstrapArticle,
      updateReading: (id, changes) => library.updateArticleReading(id, changes),
      recoverPrepared
    });
  }

  // Main uses this only through the bootstrap/runtime gates; the default production gate is off.
  window.LingoFlowArticleSyncLocalEngine = Object.freeze({ create, fingerprint });
})();
