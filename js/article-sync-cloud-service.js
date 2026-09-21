(function() {
  "use strict";

  const RPC = Object.freeze({
    push: "lingoflow_article_sync_push",
    pull: "lingoflow_article_sync_pull",
    snapshot: "lingoflow_article_sync_snapshot"
  });

  function create(options = {}) {
    const protocol = options.protocol || window.LingoFlowArticleSyncCloudProtocol;
    const auth = options.auth || window.LingoFlowSupabaseAuth;
    const config = window.LingoFlowSupabaseConfig || {};
    const projectUrl = options.projectUrl || config.projectUrl;
    const publishableKey = options.publishableKey || config.publishableKey;
    const fetchImpl = options.fetchImpl || window.fetch?.bind(window);
    if (!protocol || !auth || typeof fetchImpl !== "function" ||
        typeof projectUrl !== "string" || !/^https:\/\/[^/]+\/?$/.test(projectUrl) ||
        typeof publishableKey !== "string" || !publishableKey.trim()) {
      throw new Error("Article Cloud transport 配置无效。");
    }
    const baseUrl = projectUrl.replace(/\/$/, "");

    async function postRpc(name, owner, body) {
      let session;
      try {
        session = await auth.getSessionContext();
      } catch {
        return { status: "unavailable", reason: "unauthenticated" };
      }
      if (session?.status !== "ready") {
        return { status: "unavailable", reason: session?.status === "signed-out"
          ? "unauthenticated" : "auth-expired" };
      }
      if (session.user?.id !== owner.ownerId) {
        return { status: "rejected", reason: "owner-context-mismatch" };
      }
      let token;
      try { token = await auth.getAccessToken(); } catch { /* handled below */ }
      if (typeof token !== "string" || !token.trim()) {
        return { status: "unavailable", reason: "auth-expired" };
      }
      let response;
      try {
        response = await fetchImpl(`${baseUrl}/rest/v1/rpc/${name}`, {
          method: "POST",
          headers: {
            apikey: publishableKey,
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        });
      } catch {
        return { status: "unavailable", reason: "network-unavailable" };
      }
      if (response?.status === 401 || response?.status === 403) {
        return { status: "unavailable", reason: "auth-expired" };
      }
      if (response?.status === 404 || response?.status === 503) {
        return { status: "unavailable", reason: "rpc-unavailable" };
      }
      if (!response?.ok || typeof response.json !== "function") {
        return { status: "unavailable", reason: "server-error" };
      }
      try { return { status: "received", value: await response.json() }; }
      catch { return { status: "unavailable", reason: "server-error" }; }
    }

    async function snapshot(owner, articleId) {
      if (!protocol.validateOwner(owner) || typeof articleId !== "string" ||
          !articleId.trim() || articleId !== articleId.trim()) {
        return { status: "rejected", reason: "invalid-payload" };
      }
      const response = await postRpc(RPC.snapshot, owner, {
        p_expected_owner_id: owner.ownerId,
        p_article_id: articleId
      });
      if (response.status !== "received") return response;
      const result = protocol.validateSnapshotResult(response.value, articleId);
      return result || { status: "unavailable", reason: "server-error" };
    }

    async function pushArticleMutation(owner, readyMutation) {
      const checked = protocol.validateReadyMutation(owner, readyMutation);
      if (checked.status !== "valid") return { status: "rejected", reason: "invalid-payload" };
      const response = await postRpc(RPC.push, owner, {
        p_expected_owner_id: owner.ownerId,
        p_mutation: checked.mutation
      });
      if (response.status !== "received") return response;
      const result = protocol.validatePushResult(response.value, checked.mutation);
      if (!result) return { status: "unavailable", reason: "server-error" };
      if (result.status !== "conflict") return result;
      const current = await snapshot(owner, checked.mutation.articleId);
      return {
        ...result,
        ...(current.status === "found" ? { remoteProjection: current.projection }
          : { snapshotStatus: current.status })
      };
    }

    async function pullArticleChanges(owner, afterCursor = null, limit = protocol.DEFAULT_PAGE_SIZE) {
      if (!protocol.validateOwner(owner) ||
          (afterCursor !== null && protocol.cursorNumber(afterCursor) === null) ||
          !Number.isInteger(limit) || limit < 1 || limit > protocol.MAX_PAGE_SIZE) {
        return { status: "rejected", reason: "invalid-payload" };
      }
      const response = await postRpc(RPC.pull, owner, {
        p_expected_owner_id: owner.ownerId,
        p_after_cursor: afterCursor,
        p_limit: limit
      });
      if (response.status !== "received") return response;
      return protocol.validatePullResult(response.value, afterCursor, limit) ||
        { status: "unavailable", reason: "server-error" };
    }

    return Object.freeze({ pushArticleMutation, pullArticleChanges, snapshot });
  }

  // Loaded for explicit development/test use only. No runtime instance or worker is started.
  window.LingoFlowArticleSyncCloudService = Object.freeze({ create });
})();
