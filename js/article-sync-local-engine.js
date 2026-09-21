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
    const hooks = deps.hooks || {};

    async function mutate(operation, articleId, candidateRecord, owner) {
      const candidate = projection.projectArticleForSync(candidateRecord);
      const before = await repository.getProjection(articleId);
      if (operation === "put" && before &&
          projection.compareArticleSyncProjection(before, candidate)) {
        return { status: "unchanged", articleId };
      }
      const binding = await state.getWorkspaceBinding();
      if (binding.status !== "ready" || binding.binding.ownerId !== owner?.ownerId ||
          binding.binding.bindingId !== owner?.bindingId) {
        return { status: "blocked", reason: "workspace-unbound-or-mismatch" };
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
      return { ...ready, article: written.article, mutationId };
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
      return { ...ready, articleId, mutationId };
    }

    async function recoverPrepared(owner) {
      const list = await state.listArticleMutations(owner?.ownerId, owner?.bindingId, "prepared");
      if (list.status !== "ready") return list;
      const outcomes = [];
      for (const mutation of list.items) {
        const current = await repository.getProjection(mutation.articleId);
        const currentFingerprint = await fingerprint(current);
        if (currentFingerprint === mutation.candidateFingerprint) {
          outcomes.push(await state.updateArticleMutationStatus(
            owner.ownerId, owner.bindingId, mutation.mutationId, "ready"
          ));
        } else if (currentFingerprint === mutation.beforeFingerprint) {
          const written = await library.commitArticleSyncProjection(
            mutation.articleId, current, mutation.candidate
          );
          outcomes.push(written.status === "committed"
            ? await state.updateArticleMutationStatus(
              owner.ownerId, owner.bindingId, mutation.mutationId, "ready"
            )
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
      captureBootstrapArticle,
      updateReading: (id, changes) => library.updateArticleReading(id, changes),
      recoverPrepared
    });
  }

  // Not wired to main.js: A2 cannot enqueue production Articles before cloud schema exists.
  window.LingoFlowArticleSyncLocalEngine = Object.freeze({ create, fingerprint });
})();
