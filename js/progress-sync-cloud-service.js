(function() {
  "use strict";

  const REQUEST_FIELDS = Object.freeze(["mutationId", "articleId", "expectedState",
    "expectedProgressRevision", "parentReadingEpoch", "contentFingerprint", "progress", "paragraphIndex"]);
  const uuid = value => typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
  const opaque = value => typeof value === "string" && Boolean(value.trim()) && value === value.trim();

  // Representation only, not a second payload authority. Dispatch supplies this
  // function exclusively with the repository's validated, frozen request.
  function serialize(ownerId, request) {
    if (!opaque(ownerId) || !request || Object.getPrototypeOf(request) !== Object.prototype ||
        Object.keys(request).length !== REQUEST_FIELDS.length ||
        !REQUEST_FIELDS.every(key => Object.hasOwn(request, key)) ||
        !uuid(request.mutationId) || !opaque(request.articleId) || request.expectedState !== "revision" ||
        typeof request.expectedProgressRevision !== "string" ||
        !/^revision:[1-9][0-9]*$/.test(request.expectedProgressRevision) ||
        BigInt(request.expectedProgressRevision.slice(9)) > 9223372036854775807n ||
        !uuid(request.parentReadingEpoch) ||
        typeof request.contentFingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/.test(request.contentFingerprint) ||
        !Number.isFinite(request.progress) || request.progress < 0 || request.progress > 1 ||
        !Number.isInteger(request.paragraphIndex) || request.paragraphIndex < 0 || request.paragraphIndex > 2147483647) {
      return null;
    }
    const mutation = {};
    for (const key of REQUEST_FIELDS) mutation[key] = request[key];
    return JSON.stringify({ p_expected_owner_id: ownerId, p_mutation: mutation });
  }

  function create(options = {}) {
    // Deliberately no window.fetch fallback in 2B-1. A future LIVE gate must
    // explicitly wire HTTP; loading/creating this capability does no auth/IO.
    const http = options.fetchImpl;
    const repository = window.LingoFlowSyncStateRepository;
    const config = window.LingoFlowSupabaseConfig || {};
    const endpoint = `${(config.projectUrl || "").replace(/\/$/, "")}/rest/v1/rpc/lingoflow_progress_sync_push`;

    async function dispatch(ownerId, bindingId, articleId, attemptId, guard, signal) {
      const current = () => typeof guard === "function" && guard() === true && signal?.aborted === false;
      const dropped = () => ({ status: "not-ready", reason: "scope-mismatch" });
      if (typeof http !== "function") return { status: "not-ready", reason: "transport-not-configured" };
      if (!current()) return dropped();
      if (!/^https:\/\/[^/]+\/?$/.test(config.projectUrl || "") || !opaque(config.publishableKey)) {
        return { status: "unknown", reason: "transport-config-unavailable" };
      }
      try {
        // Capture the durable mutation identity before asynchronous auth work;
        // never reacquire a new attempt/generation after a session boundary.
        const first = await repository.prepareProgressCloudDispatch(ownerId, bindingId, articleId, attemptId, current);
        if (!current()) return dropped();
        if (first.status !== "sendable") return first;
        const cloudMutationId = first.cloudMutationId;
        const body = serialize(ownerId, first.immutableRequest);
        if (body === null) return { status: "not-ready", reason: "invalid-request" };
        const auth = window.LingoFlowSupabaseAuth;
        const verified = await auth.getSessionContext();
        if (!current()) return dropped();
        if (verified?.status !== "ready" || verified.user?.id !== ownerId) {
          return { status: "auth-paused", reason: "session-unavailable" };
        }
        const client = await auth.getPublicClient();
        if (!current()) return dropped();
        // Token and owner come from the SAME session object. The independent
        // getAccessToken() API cannot prove this pairing and is not used here.
        const paired = await client.auth.getSession();
        if (!current()) return dropped();
        const session = paired?.data?.session;
        if (paired?.error || session?.user?.id !== verified.user.id || !opaque(session?.access_token)) {
          return { status: "auth-paused", reason: "session-unavailable" };
        }
        const final = await repository.prepareProgressCloudDispatch(ownerId, bindingId, articleId, attemptId, current);
        if (!current()) return dropped();
        if (final.status !== "sendable") return final;
        if (final.cloudMutationId !== cloudMutationId || serialize(ownerId, final.immutableRequest) !== body) {
          return { status: "not-ready", reason: "attempt-identity-changed" };
        }
        // No await between the final scope/state/identity check and HTTP.
        const response = await http(endpoint, { method: "POST", signal,
          headers: { apikey: config.publishableKey, Authorization: `Bearer ${session.access_token}`,
            Accept: "application/json", "Content-Type": "application/json" }, body });
        if (!current()) return dropped();
        if ([401, 403].includes(response?.status)) return { status: "auth-paused", reason: "http-auth" };
        if (!Number.isInteger(response?.status) || response.status < 200 || response.status >= 300 ||
            typeof response.json !== "function") return { status: "unknown", reason: "http-error" };
        const rawResult = await response.json();
        if (!current()) return dropped();
        const parsed = window.LingoFlowProgressCloudResult.parse(rawResult, final.immutableRequest);
        if (parsed.status === "unparseable") return { status: "unknown", reason: "unparseable-result" };
        if (parsed.status === "auth-paused") return { status: "auth-paused", reason: "authentication-required" };
        return { status: "received", rawResult, cloudMutationId };
      } catch {
        return current() ? { status: "unknown", reason: "transport-unavailable" } : dropped();
      }
    }
    return Object.freeze({ dispatch });
  }

  window.LingoFlowProgressSyncCloudService = Object.freeze({ create });
})();
