(function initCloudLemmaResolver(global) {
  "use strict";

  const DEFAULT_MAX_CANDIDATES = 2;
  const MAX_CANDIDATE_LIMIT = 2;

  function positiveFrequency(value) {
    const frequency = Number(value);
    return Number.isFinite(frequency) && frequency > 0
      ? Math.trunc(frequency)
      : 0;
  }

  function normalizeCandidates(rawCandidates, surface, canonicalizeWord) {
    const candidates = Array.isArray(rawCandidates) ? rawCandidates : [];
    const byLemma = new Map();

    for (const candidate of candidates) {
      const value = typeof candidate === "string" ? candidate : candidate?.lemma;
      const lemma = canonicalizeWord(value);
      if (!lemma || lemma === surface) continue;

      const frequency = positiveFrequency(
        typeof candidate === "string" ? 0 : candidate?.frequency
      );
      const existing = byLemma.get(lemma);
      if (!existing || frequency > existing.frequency) {
        byLemma.set(lemma, { lemma, frequency });
      }
    }

    return Array.from(byLemma.values()).sort((left, right) => (
      right.frequency - left.frequency || left.lemma.localeCompare(right.lemma)
    ));
  }

  function create(options = {}) {
    const cloudProvider = options.cloudProvider;
    if (!cloudProvider || typeof cloudProvider.lookup !== "function" ||
        typeof options.getLemmaCandidates !== "function") {
      throw new TypeError("Cloud lemma resolver dependencies are unavailable.");
    }

    const canonicalizeWord = typeof options.canonicalizeWord === "function"
      ? options.canonicalizeWord
      : global.LingoFlowSupabaseDictionaryProvider?.canonicalizeWord;
    if (typeof canonicalizeWord !== "function") {
      throw new TypeError("Cloud lemma resolver canonicalizer is unavailable.");
    }

    const requestedLimit = Number.isInteger(options.maxCandidates)
      ? options.maxCandidates
      : DEFAULT_MAX_CANDIDATES;
    const maxCandidates = Math.min(
      MAX_CANDIDATE_LIMIT,
      Math.max(1, requestedLimit)
    );

    return Object.freeze({
      name: "cloud_lemma_resolver",

      async lookup(request = {}) {
        const query = String(request?.word ?? "").trim();
        const surface = canonicalizeWord(query);
        const cloudRequest = {
          word: surface || query,
          context: request?.context ?? ""
        };
        const exact = await cloudProvider.lookup(cloudRequest);

        if (exact?.status === "found" || exact?.status === "unavailable") {
          return { ...exact, query };
        }

        let rawCandidates;
        try {
          rawCandidates = await options.getLemmaCandidates(surface);
        } catch {
          return {
            status: "unavailable",
            query,
            reason: "lemma_candidates_unavailable"
          };
        }

        const candidates = normalizeCandidates(
          rawCandidates,
          surface,
          canonicalizeWord
        ).slice(0, maxCandidates);

        for (const candidate of candidates) {
          const result = await cloudProvider.lookup({
            word: candidate.lemma,
            context: request?.context ?? ""
          });

          if (result?.status === "unavailable") {
            return {
              status: "unavailable",
              query,
              reason: result.reason || "cloud_unavailable"
            };
          }

          if (result?.status === "found") {
            return {
              ...result,
              query,
              relation: `${surface} → ${result.headword || candidate.lemma}`
            };
          }
        }

        return { status: "not_found", query };
      }
    });
  }

  global.LingoFlowCloudLemmaResolver = Object.freeze({
    create,
    normalizeCandidates,
    DEFAULT_MAX_CANDIDATES,
    MAX_CANDIDATE_LIMIT
  });
})(window);
