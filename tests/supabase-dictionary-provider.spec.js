const { test, expect } = require("@playwright/test");
const projectErrors = new WeakMap();

async function waitForAppReady(page) {
  await expect(page.locator("#inputText")).toBeVisible();
  await expect(page.locator("#dictionarySetupStatus")).not.toHaveAttribute(
    "data-state",
    "checking"
  );
}

test.beforeEach(async ({ page }) => {
  const errors = [];
  projectErrors.set(page, errors);
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (message.type() !== "error") return;
    const sourceUrl = message.location().url || "";
    if (!sourceUrl || sourceUrl.startsWith("http://127.0.0.1:4173")) {
      errors.push(`console.error: ${message.text()}`);
    }
  });
  await page.addInitScript(() => {
    localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
  });
  await page.goto("/");
  await waitForAppReady(page);
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

test("Cloud found 使用窄 RPC，并允许 phonetic / pos 为 null", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const calls = [];
    const provider = window.LingoFlowSupabaseDictionaryProvider.create({
      async getClient() {
        return {
          async rpc(name, args) {
            calls.push({ name, args });
            return {
              data: [{
                word: "canonical-word",
                phonetic: null,
                translation: "规范词条",
                pos: null
              }],
              error: null
            };
          }
        };
      }
    });
    return {
      calls,
      outcome: await provider.lookup({ word: "  Canonical—Word  " })
    };
  });

  expect(result.calls).toEqual([{
    name: "lookup_dictionary",
    args: { p_word: "canonical-word" }
  }]);
  expect(result.outcome).toEqual({
    status: "found",
    query: "Canonical—Word",
    headword: "canonical-word",
    phonetic: null,
    translation: "规范词条",
    pos: null,
    relation: "",
    source: "supabase_core",
    attribution: "LingoFlow Core Dictionary"
  });
});

test("Cloud not_found 后继续由 Legacy 返回 found", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const cloud = window.LingoFlowSupabaseDictionaryProvider.create({
      getClient: async () => ({
        rpc: async () => ({ data: [], error: null })
      })
    });
    window.LingoFlowDictionaryLookupService.setProviders([
      cloud,
      {
        name: "legacy_test",
        lookup: async () => ({
          status: "found",
          headword: "legacy",
          phonetic: null,
          translation: "Legacy 命中",
          pos: null,
          relation: "",
          source: "legacy_test"
        })
      }
    ]);
    return window.LingoFlowDictionaryLookupService.lookup({ word: "legacy" });
  });

  expect(result).toMatchObject({
    status: "found",
    headword: "legacy",
    translation: "Legacy 命中",
    source: "legacy_test"
  });
});

test("Cloud unavailable 后继续由 Legacy 返回 found", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const cloud = window.LingoFlowSupabaseDictionaryProvider.create({
      getClient: async () => ({
        rpc: async () => {
          throw new Error("network unavailable");
        }
      })
    });
    window.LingoFlowDictionaryLookupService.setProviders([
      cloud,
      {
        name: "legacy_test",
        lookup: async () => ({
          status: "found",
          headword: "offline",
          phonetic: null,
          translation: "本地后备命中",
          pos: null,
          relation: "",
          source: "legacy_test"
        })
      }
    ]);
    return window.LingoFlowDictionaryLookupService.lookup({ word: "offline" });
  });

  expect(result).toMatchObject({
    status: "found",
    headword: "offline",
    translation: "本地后备命中",
    source: "legacy_test"
  });
});

test("Cloud timeout 在上限内转为 unavailable 并执行 Legacy fallback", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const cloud = window.LingoFlowSupabaseDictionaryProvider.create({
      getClient: async () => ({
        rpc: () => new Promise(() => {})
      }),
      timeoutMs: 25
    });
    window.LingoFlowDictionaryLookupService.setProviders([
      cloud,
      {
        name: "legacy_test",
        lookup: async () => ({
          status: "found",
          headword: "timeout",
          phonetic: null,
          translation: "超时后本地命中",
          pos: null,
          relation: "",
          source: "legacy_test"
        })
      }
    ]);
    const started = performance.now();
    const outcome = await window.LingoFlowDictionaryLookupService.lookup({ word: "timeout" });
    return { outcome, elapsed: performance.now() - started };
  });

  expect(result.outcome).toMatchObject({
    status: "found",
    translation: "超时后本地命中",
    source: "legacy_test"
  });
  expect(result.elapsed).toBeLessThan(500);
});

test("Cloud 与 Legacy 都 not_found 时返回最终 not_found", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const cloud = window.LingoFlowSupabaseDictionaryProvider.create({
      getClient: async () => ({ rpc: async () => ({ data: [], error: null }) })
    });
    window.LingoFlowDictionaryLookupService.setProviders([
      cloud,
      { name: "legacy_test", lookup: async ({ word }) => ({ status: "not_found", query: word }) }
    ]);
    return window.LingoFlowDictionaryLookupService.lookup({ word: "missing" });
  });

  expect(result).toEqual({ status: "not_found", query: "missing" });
});

test("Cloud 与 Legacy 都 unavailable 时返回最终 unavailable", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const cloud = window.LingoFlowSupabaseDictionaryProvider.create({
      getClient: async () => ({
        rpc: async () => {
          throw new Error("network unavailable");
        }
      })
    });
    window.LingoFlowDictionaryLookupService.setProviders([
      cloud,
      {
        name: "legacy_test",
        lookup: async ({ word }) => ({
          status: "unavailable",
          query: word,
          reason: "legacy_not_installed"
        })
      }
    ]);
    return window.LingoFlowDictionaryLookupService.lookup({ word: "missing" });
  });

  expect(result).toEqual({
    status: "unavailable",
    query: "missing",
    reason: "cloud_unavailable"
  });
});

test("stale Cloud response 不覆盖后续 Word Card lookup", async ({ page }) => {
  const result = await page.evaluate(async () => {
    let resolveOlder;
    const cloud = window.LingoFlowSupabaseDictionaryProvider.create({
      getClient: async () => ({
        rpc(_name, args) {
          if (args.p_word === "older") {
            return new Promise(resolve => {
              resolveOlder = resolve;
            });
          }
          return Promise.resolve({
            data: [{ word: "newer", phonetic: null, translation: "较新的云结果", pos: null }],
            error: null
          });
        }
      }),
      timeoutMs: 1000
    });
    window.LingoFlowDictionaryLookupService.setProviders([cloud]);

    const older = showWordCard("older", "Older context", "article");
    while (!resolveOlder) await Promise.resolve();
    const newer = showWordCard("newer", "Newer context", "article");
    await newer;
    resolveOlder({
      data: [{ word: "older", phonetic: null, translation: "过期的云结果", pos: null }],
      error: null
    });
    await older;

    return {
      word: document.getElementById("currentWord").textContent,
      meaning: document.getElementById("meaning").textContent,
      history: window.LingoFlowQueryEventRepository.list()
    };
  });

  expect(result.word).toBe("newer");
  expect(result.meaning).toBe("较新的云结果");
  expect(result.history).toHaveLength(1);
  expect(result.history[0].word).toBe("newer");
});

test("Reader 与 directSearch 只依赖 Lookup Service，不含 Supabase/RPC 细节", async ({ page }) => {
  const result = await page.evaluate(() => ({
    reader: showWordCard.toString(),
    search: directSearch.toString()
  }));

  for (const source of [result.reader, result.search]) {
    expect(source).toContain("LingoFlowDictionaryLookupService.lookup");
    expect(source).not.toMatch(/Supabase|lookup_dictionary|\.rpc\s*\(/);
    expect(source).not.toContain("isECDICTReadyForLookup");
    expect(source).not.toContain("getECDICTEntry");
  }
});

test("人工 Cloud smoke harness 汇总延迟、timeout 与 Legacy fallback", async ({ page }) => {
  await page.addScriptTag({ url: "/scripts/dictionary-cloud-smoke.js" });
  const result = await page.evaluate(async () => {
    const originalCloudFactory = window.LingoFlowSupabaseDictionaryProvider;
    const originalLegacyFactory = window.LingoFlowLegacyECDICTProvider;
    window.LingoFlowSupabaseDictionaryProvider = {
      create: () => ({
        lookup: async ({ word }) => word === "cloud"
          ? { status: "found", query: word, source: "supabase_core" }
          : { status: "not_found", query: word }
      })
    };
    window.LingoFlowLegacyECDICTProvider = {
      create: () => ({
        lookup: async ({ word }) => ({
          status: "found",
          query: word,
          source: "legacy_ecdict"
        })
      })
    };

    try {
      return await window.LingoFlowDictionaryCloudSmoke.run(["cloud", "legacy"]);
    } finally {
      window.LingoFlowSupabaseDictionaryProvider = originalCloudFactory;
      window.LingoFlowLegacyECDICTProvider = originalLegacyFactory;
    }
  });

  expect(result.rows).toHaveLength(2);
  expect(result.rows[0]).toMatchObject({
    word: "cloud",
    cloud: "found",
    fallback: false,
    final: "found",
    source: "supabase_core"
  });
  expect(result.rows[1]).toMatchObject({
    word: "legacy",
    cloud: "not_found",
    fallback: true,
    final: "found",
    source: "legacy_ecdict"
  });
  expect(result.summary).toMatchObject({
    count: 2,
    timeoutCount: 0,
    fallbackCount: 1
  });
});
