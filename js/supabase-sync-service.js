(function() {
  "use strict";

  const PUSH_RPCS = Object.freeze({
    favorites: "lingoflow_favorite_sync_push",
    favoriteLearningStates: "lingoflow_favorite_learning_sync_push"
  });
  const PULL_RPC = "lingoflow_favorite_sync_pull";

  function getProtocol(value) {
    const protocol = value || window.LingoFlowCloudSyncProtocol;
    if (!protocol ||
        typeof protocol.validateOwnerContext !== "function" ||
        typeof protocol.validateMutation !== "function" ||
        typeof protocol.validateResult !== "function" ||
        typeof protocol.validatePullResult !== "function") {
      throw new Error("Cloud Sync Protocol 不可用。");
    }
    return protocol;
  }

  function isOpaqueString(value) {
    return typeof value === "string" && Boolean(value.trim()) && value === value.trim();
  }

  function normalizeProjectUrl(value) {
    if (!isOpaqueString(value)) throw new Error("Supabase project URL 无效。");
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Supabase project URL 无效。");
    }
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.username || url.password || url.search || url.hash ||
        (url.protocol !== "https:" && !(local && url.protocol === "http:"))) {
      throw new Error("Supabase project URL 无效。");
    }
    return url.href.replace(/\/$/, "");
  }

  function rejectedPush(validation, reason) {
    return {
      status: "rejected",
      mutationId: validation?.mutationId || null,
      entityType: validation?.entityType || null,
      entityId: validation?.entityId || null,
      scope: validation?.scope || null,
      reason
    };
  }

  function rejectedPull(reason) {
    return { status: "rejected", changes: [], nextCursor: null, reason };
  }

  function resultIdentityMatches(result, mutation) {
    return result.mutationId === mutation.mutationId &&
      result.entityType === mutation.entityType &&
      result.entityId === mutation.entityId &&
      result.scope === mutation.scope &&
      (result.status === "rejected" || result.schemaVersion === mutation.schemaVersion);
  }

  function create(options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      throw new Error("Supabase Sync Service 配置无效。");
    }
    const protocol = getProtocol(options.protocol);
    const projectUrl = normalizeProjectUrl(options.projectUrl);
    if (!isOpaqueString(options.publishableKey)) {
      throw new Error("Supabase publishable key 无效。");
    }
    if (typeof options.getAccessToken !== "function") {
      throw new Error("Supabase 用户 access token provider 不可用。");
    }
    const publishableKey = options.publishableKey;
    const fetchImpl = options.fetchImpl || window.fetch?.bind(window);
    if (typeof fetchImpl !== "function") throw new Error("Fetch API 不可用。");

    async function postRpc(name, ownerContext, body) {
      const accessToken = await options.getAccessToken({ ownerId: ownerContext.ownerId });
      if (!isOpaqueString(accessToken)) {
        throw new Error("Supabase 用户 access token 无效。");
      }

      let response;
      try {
        response = await fetchImpl(`${projectUrl}/rest/v1/rpc/${name}`, {
          method: "POST",
          headers: {
            apikey: publishableKey,
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        });
      } catch (error) {
        throw new Error("Supabase Sync RPC transport failed。", { cause: error });
      }
      if (!response || response.ok !== true || typeof response.json !== "function") {
        const status = Number.isInteger(response?.status) ? response.status : 0;
        throw new Error(`Supabase Sync RPC failed (${status})。`);
      }
      try {
        return await response.json();
      } catch (error) {
        throw new Error("Supabase Sync RPC 返回了非法 JSON。", { cause: error });
      }
    }

    async function push(ownerValue, mutationValue) {
      const ownerValidation = protocol.validateOwnerContext(ownerValue);
      if (!ownerValidation || ownerValidation.status !== "valid") {
        return rejectedPush(null, "invalid-owner-context");
      }
      const mutationValidation = protocol.validateMutation(mutationValue);
      if (!mutationValidation || mutationValidation.status !== "valid") {
        return rejectedPush(
          mutationValidation,
          mutationValidation?.errors?.[0]?.code || "invalid-mutation"
        );
      }

      const owner = ownerValidation.ownerContext;
      const mutation = mutationValidation.mutation;
      const pushRpc = PUSH_RPCS[mutation.entityType];
      if (!pushRpc) return rejectedPush(mutationValidation, "unsupported-entity");
      const rawResult = await postRpc(pushRpc, owner, {
        p_expected_owner_id: owner.ownerId,
        p_mutation: mutation
      });
      const resultValidation = protocol.validateResult(rawResult);
      if (!resultValidation || resultValidation.status !== "valid") {
        throw new Error("Supabase Push RPC 返回了非法 protocol result。");
      }
      if (!resultIdentityMatches(resultValidation.result, mutation)) {
        throw new Error("Supabase Push RPC result identity 不一致。");
      }
      return resultValidation.result;
    }

    async function pull(ownerValue, afterCursor = null) {
      const ownerValidation = protocol.validateOwnerContext(ownerValue);
      if (!ownerValidation || ownerValidation.status !== "valid") {
        return rejectedPull("invalid-owner-context");
      }
      if (afterCursor !== null && !isOpaqueString(afterCursor)) {
        return rejectedPull("invalid-cursor");
      }

      const owner = ownerValidation.ownerContext;
      const rawResult = await postRpc(PULL_RPC, owner, {
        p_expected_owner_id: owner.ownerId,
        p_after_cursor: afterCursor
      });
      const resultValidation = protocol.validatePullResult(rawResult);
      if (!resultValidation || resultValidation.status !== "valid") {
        throw new Error("Supabase Pull RPC 返回了非法 protocol result。");
      }
      return resultValidation.pullResult;
    }

    return Object.freeze({ push, pull });
  }

  window.LingoFlowSupabaseSyncService = Object.freeze({ create });
})();
