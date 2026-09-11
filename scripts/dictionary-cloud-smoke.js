(function initDictionaryCloudSmoke(global) {
  "use strict";

  function percentile(values, percentage) {
    if (!values.length) return 0;
    const index = Math.ceil((percentage / 100) * values.length) - 1;
    return values[Math.max(0, Math.min(values.length - 1, index))];
  }

  function roundMilliseconds(value) {
    return Math.round(value * 10) / 10;
  }

  async function run(words, options = {}) {
    if (!Array.isArray(words) || words.length < 1) {
      throw new TypeError("Provide at least one lookup word.");
    }

    const auth = global.LingoFlowSupabaseAuth;
    const cloudFactory = global.LingoFlowSupabaseDictionaryProvider;
    const legacyFactory = global.LingoFlowLegacyECDICTProvider;
    if (typeof auth?.getPublicClient !== "function" ||
        typeof cloudFactory?.create !== "function" ||
        typeof legacyFactory?.create !== "function") {
      throw new Error("Open LingoFlow before running the Dictionary Cloud smoke harness.");
    }

    const cloud = cloudFactory.create({
      getClient: () => auth.getPublicClient(),
      timeoutMs: options.timeoutMs || 2500
    });
    const legacy = legacyFactory.create({
      isReady: () => global.isECDICTReadyForLookup(),
      lookupLegacy: word => global.lookupWord(word)
    });
    const rows = [];

    for (const value of words) {
      const word = String(value ?? "").trim();
      const started = performance.now();
      const cloudStarted = performance.now();
      const cloudResult = await cloud.lookup({ word });
      const cloudMs = performance.now() - cloudStarted;
      let legacyResult = null;
      let finalResult = cloudResult;

      if (cloudResult.status !== "found") {
        legacyResult = await legacy.lookup({ word });
        if (legacyResult.status === "found" || legacyResult.status === "unavailable") {
          finalResult = legacyResult;
        }
      }

      rows.push({
        word,
        cloud: cloudResult.status,
        cloudReason: cloudResult.reason || "",
        cloudMs: roundMilliseconds(cloudMs),
        fallback: Boolean(legacyResult),
        final: finalResult.status,
        source: finalResult.source || "",
        totalMs: roundMilliseconds(performance.now() - started)
      });
    }

    const totalTimes = rows.map(row => row.totalMs).sort((left, right) => left - right);
    const summary = {
      count: rows.length,
      p50Ms: percentile(totalTimes, 50),
      p95Ms: percentile(totalTimes, 95),
      maxMs: totalTimes[totalTimes.length - 1] || 0,
      timeoutCount: rows.filter(row => row.cloudReason === "cloud_timeout").length,
      fallbackCount: rows.filter(row => row.fallback).length
    };

    console.table(rows);
    console.info("Dictionary Cloud smoke summary", summary);
    return { rows, summary };
  }

  global.LingoFlowDictionaryCloudSmoke = Object.freeze({ run });
})(window);
