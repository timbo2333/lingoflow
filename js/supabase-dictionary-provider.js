(function initSupabaseDictionaryProvider(global) {
  "use strict";

  const DEFAULT_TIMEOUT_MS = 2500;
  const APOSTROPHES = /[‘’‛ʼ＇′]/g;
  const DASHES = /[‐‑‒–—―−﹘﹣－]/g;
  const CANONICAL_WORD = /^[a-z]+(?:['-][a-z]+)*$/;

  function canonicalizeWord(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .replace(APOSTROPHES, "'")
      .replace(DASHES, "-")
      .trim()
      .toLowerCase()
      .replace(/^[^a-z]+|[^a-z]+$/g, "");
  }

  function nullableText(value) {
    if (value === null || value === undefined || value === "") return null;
    return String(value);
  }

  function create(options = {}) {
    if (typeof options.getClient !== "function") {
      throw new TypeError("Supabase Dictionary client provider is unavailable.");
    }

    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS;

    async function lookup(request = {}) {
      const query = String(request?.word ?? "").trim();
      const canonicalWord = canonicalizeWord(query);

      if (!CANONICAL_WORD.test(canonicalWord)) {
        return { status: "not_found", query };
      }

      const controller = typeof AbortController === "function"
        ? new AbortController()
        : null;
      let timer = null;

      const requestResult = (async () => {
        const client = await options.getClient();
        if (!client || typeof client.rpc !== "function") {
          throw new Error("Supabase Dictionary client is invalid.");
        }

        let rpcRequest = client.rpc("lookup_dictionary", {
          p_word: canonicalWord
        });
        if (controller && typeof rpcRequest?.abortSignal === "function") {
          rpcRequest = rpcRequest.abortSignal(controller.signal);
        }
        return await rpcRequest;
      })();

      const timeoutResult = new Promise(resolve => {
        timer = setTimeout(() => {
          controller?.abort();
          resolve({ type: "timeout" });
        }, timeoutMs);
      });

      const settled = await Promise.race([
        requestResult.then(
          response => ({ type: "response", response }),
          () => ({ type: "error" })
        ),
        timeoutResult
      ]);
      clearTimeout(timer);

      if (settled.type === "timeout") {
        return { status: "unavailable", query, reason: "cloud_timeout" };
      }
      if (settled.type === "error" || settled.response?.error) {
        return { status: "unavailable", query, reason: "cloud_unavailable" };
      }

      const rows = settled.response?.data;
      if (!Array.isArray(rows) || rows.length > 1) {
        return { status: "unavailable", query, reason: "cloud_invalid_response" };
      }
      if (!rows.length) return { status: "not_found", query };

      const row = rows[0];
      if (typeof row?.word !== "string" || !row.word ||
          typeof row.translation !== "string" || !row.translation.trim()) {
        return { status: "unavailable", query, reason: "cloud_invalid_response" };
      }

      return {
        status: "found",
        query,
        headword: row.word,
        phonetic: nullableText(row.phonetic),
        translation: row.translation,
        pos: nullableText(row.pos),
        relation: "",
        source: "supabase_core",
        attribution: "LingoFlow Core Dictionary"
      };
    }

    return Object.freeze({ name: "supabase_core", lookup });
  }

  global.LingoFlowSupabaseDictionaryProvider = Object.freeze({
    create,
    canonicalizeWord
  });
})(window);
