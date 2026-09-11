(function initLegacyECDICTProvider(global) {
  "use strict";

  function create(options = {}) {
    if (typeof options.isReady !== "function" ||
        typeof options.lookupLegacy !== "function") {
      throw new TypeError("Legacy ECDICT provider dependencies are unavailable.");
    }

    return Object.freeze({
      name: "legacy_ecdict",

      async lookup(request = {}) {
        const query = String(request?.word ?? "").trim();

        if (!await options.isReady()) {
          return {
            status: "unavailable",
            query,
            reason: typeof options.getUnavailableReason === "function"
              ? options.getUnavailableReason()
              : "legacy_dictionary_not_ready"
          };
        }

        const result = await options.lookupLegacy(query);

        if (!result) return { status: "not_found", query };

        return {
          status: "found",
          query,
          headword: result.baseWord || result.queriedWord || query,
          phonetic: result.phonetic || null,
          translation: result.meaning || "暂无中文释义",
          pos: result.pos || null,
          relation: result.relationText || "",
          source: "legacy_ecdict",
          attribution: result.source || "",
          surfaceTranslation: result.surfaceMeaning || "",
          exchange: result.exchange || "",
          ielts: result.ielts || ""
        };
      }
    });
  }

  global.LingoFlowLegacyECDICTProvider = Object.freeze({ create });
})(window);
