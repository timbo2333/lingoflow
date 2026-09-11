(function initDictionaryLookupService(global) {
  "use strict";

  let providers = [];

  function textOrNull(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text || null;
  }

  function normalizeFound(result, query, providerName) {
    const headword = textOrNull(result?.headword) || query;
    const translation = textOrNull(result?.translation);

    if (!headword || !translation) {
      return {
        status: "unavailable",
        query,
        reason: "invalid_provider_result"
      };
    }

    return {
      status: "found",
      query,
      headword,
      phonetic: textOrNull(result.phonetic),
      translation,
      pos: textOrNull(result.pos),
      relation: textOrNull(result.relation) || "",
      source: textOrNull(result.source) || providerName,
      attribution: textOrNull(result.attribution) || "",
      surfaceTranslation: textOrNull(result.surfaceTranslation) || "",
      exchange: textOrNull(result.exchange) || "",
      ielts: textOrNull(result.ielts) || ""
    };
  }

  function normalizeUnavailable(result, query) {
    return {
      status: "unavailable",
      query,
      reason: textOrNull(result?.reason) || "provider_unavailable"
    };
  }

  async function lookup(request = {}) {
    const query = String(request?.word ?? "").trim();
    let lastUnavailable = null;

    if (!providers.length) {
      return { status: "unavailable", query, reason: "no_provider" };
    }

    for (const provider of providers) {
      let result;

      try {
        result = await provider.lookup({
          word: query,
          context: request?.context ?? ""
        });
      } catch {
        lastUnavailable = {
          status: "unavailable",
          query,
          reason: "provider_error"
        };
        continue;
      }

      if (result?.status === "found") {
        const normalized = normalizeFound(result, query, provider.name);
        if (normalized.status === "found") return normalized;
        lastUnavailable = normalized;
        continue;
      }

      if (result?.status === "unavailable") {
        lastUnavailable = normalizeUnavailable(result, query);
      }
    }

    return lastUnavailable || { status: "not_found", query };
  }

  function setProviders(nextProviders) {
    if (!Array.isArray(nextProviders) || nextProviders.some(
      provider => !provider || typeof provider.lookup !== "function"
    )) {
      throw new TypeError("Dictionary providers must expose lookup(request).");
    }

    providers = nextProviders.slice();
  }

  function getProviderNames() {
    return providers.map(provider => String(provider.name || "anonymous"));
  }

  global.LingoFlowDictionaryLookupService = Object.freeze({
    lookup,
    setProviders,
    getProviderNames
  });
})(window);
