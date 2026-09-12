const { test, expect } = require("@playwright/test");

const projectErrors = new WeakMap();

async function openApp(page) {
  await page.addInitScript(() => {
    localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
    localStorage.removeItem("lingoflow_dictionary_cloud_first_smoke");
  });
  await page.goto("/");
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
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

test("默认无需 smoke flag 即配置 Cloud Lemma → Legacy", async ({ page }) => {
  await openApp(page);

  const result = await page.evaluate(() => ({
    flag: localStorage.getItem("lingoflow_dictionary_cloud_first_smoke"),
    providers: window.LingoFlowDictionaryLookupService.getProviderNames()
  }));

  expect(result.flag).toBeNull();
  expect(result.providers).toEqual(["cloud_lemma_resolver", "legacy_ecdict"]);
});

test("生产 Cloud-first exact 命中不调用 Legacy，且默认不输出 debug 日志", async ({ page }) => {
  await openApp(page);

  const result = await page.evaluate(async () => {
    const logs = [];
    const originalInfo = console.info;
    const originalCloudFactory = window.LingoFlowSupabaseDictionaryProvider;
    const originalCacheFactory = window.LingoFlowCachedCloudDictionaryProvider;
    let cloudCalls = 0;
    let legacyCalls = 0;

    console.info = (...args) => logs.push(args);
    window.LingoFlowSupabaseDictionaryProvider = {
      ...originalCloudFactory,
      create: () => ({
        name: "supabase_core",
        async lookup({ word }) {
          cloudCalls += 1;
          return {
            status: "found",
            query: word,
            headword: word,
            phonetic: null,
            translation: "学术的",
            pos: null,
            source: "supabase_core",
            attribution: "LingoFlow Core Dictionary"
          };
        }
      })
    };
    window.LingoFlowCachedCloudDictionaryProvider = {
      ...originalCacheFactory,
      create: ({ cloudProvider }) => originalCacheFactory.create({
        cloudProvider,
        persistentCache: {
          get: async () => undefined,
          put: async () => {}
        }
      })
    };
    window.LingoFlowLegacyECDICTProvider = {
      create: () => ({
        name: "legacy_ecdict",
        async lookup({ word }) {
          legacyCalls += 1;
          return { status: "unavailable", query: word, reason: "legacy_dictionary_not_ready" };
        }
      })
    };

    try {
      configureDictionaryLookupService();
      const outcome = await window.LingoFlowDictionaryLookupService.lookup({
        word: "academic",
        context: "This context must not be logged."
      });
      return {
        providers: window.LingoFlowDictionaryLookupService.getProviderNames(),
        outcome,
        cloudCalls,
        legacyCalls,
        logs
      };
    } finally {
      console.info = originalInfo;
    }
  });

  expect(result.providers).toEqual(["cloud_lemma_resolver", "legacy_ecdict"]);
  expect(result.cloudCalls).toBe(1);
  expect(result.legacyCalls).toBe(0);
  expect(result.outcome).toMatchObject({
    status: "found",
    headword: "academic",
    source: "supabase_core"
  });
  expect(result.logs).toEqual([]);
});

test("Cloud surface miss 后通过 Lemma 命中，Legacy 不调用", async ({ page }) => {
  await openApp(page, true);

  const result = await page.evaluate(async () => {
    const cloudCalls = [];
    let legacyCalls = 0;
    const cachedCloud = window.LingoFlowCachedCloudDictionaryProvider.create({
      persistentCache: {
        get: async () => undefined,
        put: async () => {}
      },
      cloudProvider: {
        name: "supabase_core",
        async lookup({ word }) {
          cloudCalls.push(word);
          if (word === "sanction") {
            return {
              status: "found",
              headword: "sanction",
              translation: "制裁；批准",
              source: "supabase_core"
            };
          }
          return { status: "not_found", query: word };
        }
      }
    });
    const resolver = window.LingoFlowCloudLemmaResolver.create({
      cloudProvider: cachedCloud,
      getLemmaCandidates: async () => [{ lemma: "sanction", frequency: 2104 }]
    });
    window.LingoFlowDictionaryLookupService.setProviders([
      resolver,
      {
        name: "legacy_ecdict",
        async lookup({ word }) {
          legacyCalls += 1;
          return { status: "not_found", query: word };
        }
      }
    ]);

    return {
      outcome: await window.LingoFlowDictionaryLookupService.lookup({ word: "sanctions" }),
      cloudCalls,
      legacyCalls
    };
  });

  expect(result.cloudCalls).toEqual(["sanctions", "sanction"]);
  expect(result.legacyCalls).toBe(0);
  expect(result.outcome).toMatchObject({
    status: "found",
    headword: "sanction",
    relation: "sanctions → sanction",
    source: "supabase_core"
  });
});

test("新 Cloud chain instance 命中 Persistent Cache，第二次 Cloud RPC 为 0", async ({ page }) => {
  await openApp(page, true);

  const result = await page.evaluate(async () => {
    const cacheFactory = window.LingoFlowCachedCloudDictionaryProvider;
    let firstCloudCalls = 0;
    const firstCache = cacheFactory.create({
      cloudProvider: {
        name: "supabase_core",
        async lookup({ word }) {
          firstCloudCalls += 1;
          return {
            status: "found",
            headword: word,
            phonetic: null,
            translation: "缓存测试",
            pos: null,
            source: "supabase_core"
          };
        }
      }
    });
    const firstResolver = window.LingoFlowCloudLemmaResolver.create({
      cloudProvider: firstCache,
      getLemmaCandidates: async () => []
    });
    await firstResolver.lookup({ word: "cacheable-smoke" });

    let secondCloudCalls = 0;
    const secondCache = cacheFactory.create({
      cloudProvider: {
        name: "supabase_core",
        async lookup({ word }) {
          secondCloudCalls += 1;
          return { status: "unavailable", query: word, reason: "should_not_run" };
        }
      }
    });
    const secondResolver = window.LingoFlowCloudLemmaResolver.create({
      cloudProvider: secondCache,
      getLemmaCandidates: async () => []
    });

    return {
      outcome: await secondResolver.lookup({ word: "cacheable-smoke" }),
      firstCloudCalls,
      secondCloudCalls
    };
  });

  expect(result.firstCloudCalls).toBe(1);
  expect(result.secondCloudCalls).toBe(0);
  expect(result.outcome).toMatchObject({
    status: "found",
    source: "dictionary_cache",
    translation: "缓存测试"
  });
});

test("Cloud miss 后由 Legacy 返回 found", async ({ page }) => {
  await openApp(page, true);

  const result = await page.evaluate(async () => {
    let legacyCalls = 0;
    const resolver = window.LingoFlowCloudLemmaResolver.create({
      cloudProvider: {
        name: "cloud_test",
        lookup: async ({ word }) => ({ status: "not_found", query: word })
      },
      getLemmaCandidates: async () => []
    });
    window.LingoFlowDictionaryLookupService.setProviders([
      resolver,
      {
        name: "legacy_ecdict",
        async lookup({ word }) {
          legacyCalls += 1;
          return {
            status: "found",
            query: word,
            headword: word,
            translation: "Legacy fallback",
            source: "legacy_ecdict"
          };
        }
      }
    ]);
    return {
      outcome: await window.LingoFlowDictionaryLookupService.lookup({ word: "legacyonlyword" }),
      legacyCalls
    };
  });

  expect(result.legacyCalls).toBe(1);
  expect(result.outcome).toMatchObject({
    status: "found",
    translation: "Legacy fallback",
    source: "legacy_ecdict"
  });
});

test("Cloud unavailable 后由 Legacy 返回 found", async ({ page }) => {
  await openApp(page, true);

  const result = await page.evaluate(async () => {
    let legacyCalls = 0;
    const resolver = window.LingoFlowCloudLemmaResolver.create({
      cloudProvider: {
        name: "cloud_test",
        lookup: async ({ word }) => ({
          status: "unavailable",
          query: word,
          reason: "cloud_timeout"
        })
      },
      getLemmaCandidates: async () => {
        throw new Error("Lemma must not run after Cloud unavailable");
      }
    });
    window.LingoFlowDictionaryLookupService.setProviders([
      resolver,
      {
        name: "legacy_ecdict",
        async lookup({ word }) {
          legacyCalls += 1;
          return {
            status: "found",
            query: word,
            headword: word,
            translation: "Offline fallback",
            source: "legacy_ecdict"
          };
        }
      }
    ]);
    return {
      outcome: await window.LingoFlowDictionaryLookupService.lookup({ word: "offline" }),
      legacyCalls
    };
  });

  expect(result.legacyCalls).toBe(1);
  expect(result.outcome).toMatchObject({
    status: "found",
    translation: "Offline fallback",
    source: "legacy_ecdict"
  });
});

test("已安装 Legacy 的用户断网时仍由真实 Legacy Provider 命中", async ({ page }) => {
  await openApp(page);

  const result = await page.evaluate(async () => {
    const db = await openECDICTDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["entries", "meta"], "readwrite");
      tx.objectStore("entries").put({
        word: "offlineanchor",
        phonetic: "",
        translation: "离线兜底词条",
        pos: "",
        tag: "",
        exchange: ""
      });
      const meta = tx.objectStore("meta");
      meta.put({ key: "ready", value: true });
      meta.put({ key: "count", value: 1 });
      meta.put({ key: "source", value: "test" });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    dictionaryIntegritySnapshot = await inspectDictionaryIntegrity();

    const cloud = window.LingoFlowCloudLemmaResolver.create({
      cloudProvider: {
        name: "offline_cloud",
        lookup: async ({ word }) => ({
          status: "unavailable",
          query: word,
          reason: "cloud_unavailable"
        })
      },
      getLemmaCandidates: async () => {
        throw new Error("Lemma source must not run after Cloud unavailable");
      }
    });
    const legacy = window.LingoFlowLegacyECDICTProvider.create({
      isReady: isECDICTReadyForLookup,
      lookupLegacy: lookupWord,
      getUnavailableReason: () => "legacy_dictionary_not_ready"
    });
    window.LingoFlowDictionaryLookupService.setProviders([cloud, legacy]);
    return window.LingoFlowDictionaryLookupService.lookup({ word: "offlineanchor" });
  });

  expect(result).toMatchObject({
    status: "found",
    headword: "offlineanchor",
    translation: "离线兜底词条",
    source: "legacy_ecdict"
  });
});

test("Cloud 与 Legacy 都 unavailable 时返回最终 unavailable", async ({ page }) => {
  await openApp(page, true);

  const result = await page.evaluate(async () => {
    const resolver = window.LingoFlowCloudLemmaResolver.create({
      cloudProvider: {
        name: "cloud_test",
        lookup: async ({ word }) => ({
          status: "unavailable",
          query: word,
          reason: "cloud_unavailable"
        })
      },
      getLemmaCandidates: async () => []
    });
    window.LingoFlowDictionaryLookupService.setProviders([
      resolver,
      {
        name: "legacy_ecdict",
        lookup: async ({ word }) => ({
          status: "unavailable",
          query: word,
          reason: "legacy_dictionary_not_ready"
        })
      }
    ]);
    return await window.LingoFlowDictionaryLookupService.lookup({ word: "unavailable" });
  });

  expect(result).toEqual({
    status: "unavailable",
    query: "unavailable",
    reason: "cloud_unavailable"
  });
});

test("Cloud unavailable 且无 Legacy 时 UI 说明网络故障与可选离线包", async ({ page }) => {
  await openApp(page);

  const result = await page.evaluate(async () => {
    window.LingoFlowDictionaryLookupService.setProviders([
      {
        name: "cloud_test",
        lookup: async ({ word }) => ({
          status: "unavailable",
          query: word,
          reason: "cloud_unavailable"
        })
      },
      {
        name: "legacy_ecdict",
        lookup: async ({ word }) => ({
          status: "unavailable",
          query: word,
          reason: "legacy_dictionary_not_ready"
        })
      }
    ]);
    await directSearch("outageword");
    return document.getElementById("directSearchResult").textContent;
  });

  expect(result).toContain("在线词典暂时不可用，请稍后重试");
  expect(result).toContain("在设置中下载完整离线词典");
  expect(result).not.toContain("暂未找到该词");
});

test("Cloud 与 Legacy 都权威 not_found 时 UI 显示暂未找到", async ({ page }) => {
  await openApp(page);

  const result = await page.evaluate(async () => {
    window.LingoFlowDictionaryLookupService.setProviders([
      {
        name: "cloud_test",
        lookup: async ({ word }) => ({ status: "not_found", query: word })
      },
      {
        name: "legacy_ecdict",
        lookup: async ({ word }) => ({ status: "not_found", query: word })
      }
    ]);
    await directSearch("missingword");
    return document.getElementById("directSearchResult").textContent;
  });

  expect(result).toContain("暂未找到该词");
  expect(result).not.toContain("在线词典暂时不可用");
});

test("Cloud found 时 Legacy not-ready 不阻止结果", async ({ page }) => {
  await openApp(page, true);

  const result = await page.evaluate(async () => {
    let legacyCalls = 0;
    const resolver = window.LingoFlowCloudLemmaResolver.create({
      cloudProvider: {
        name: "cloud_test",
        lookup: async ({ word }) => ({
          status: "found",
          query: word,
          headword: word,
          translation: "Cloud without Legacy",
          source: "supabase_core"
        })
      },
      getLemmaCandidates: async () => []
    });
    window.LingoFlowDictionaryLookupService.setProviders([
      resolver,
      {
        name: "legacy_ecdict",
        async lookup({ word }) {
          legacyCalls += 1;
          return { status: "unavailable", query: word, reason: "legacy_dictionary_not_ready" };
        }
      }
    ]);
    return {
      outcome: await window.LingoFlowDictionaryLookupService.lookup({ word: "cloudonly" }),
      legacyCalls
    };
  });

  expect(result.legacyCalls).toBe(0);
  expect(result.outcome).toMatchObject({
    status: "found",
    translation: "Cloud without Legacy",
    source: "supabase_core"
  });
});

test("Cloud 内部 exact/Lemma 查询仍只产生一次 History 和一次 Favorite 行为", async ({ page }) => {
  await openApp(page, true);

  const result = await page.evaluate(async () => {
    const cloudCalls = [];
    let completions = 0;
    const resolver = window.LingoFlowCloudLemmaResolver.create({
      cloudProvider: {
        name: "cloud_test",
        async lookup({ word }) {
          cloudCalls.push(word);
          return word === "sanction"
            ? {
                status: "found",
                headword: "sanction",
                translation: "制裁；批准",
                source: "supabase_core"
              }
            : { status: "not_found", query: word };
        }
      },
      getLemmaCandidates: async () => [{ lemma: "sanction", frequency: 2104 }]
    });
    window.LingoFlowDictionaryLookupService.setProviders([
      resolver,
      { name: "legacy_ecdict", lookup: async ({ word }) => ({ status: "not_found", query: word }) }
    ], {
      onLookupComplete: () => { completions += 1; }
    });

    await showWordCard("sanctions", "The sanctions remained in place.", "article");
    const favorite = await saveCurrentFavorite();
    return {
      cloudCalls,
      completions,
      history: window.LingoFlowQueryEventRepository.list(),
      favorites: window.LingoFlowFavoriteRepository.list(),
      favorite
    };
  });

  expect(result.cloudCalls).toEqual(["sanctions", "sanction"]);
  expect(result.completions).toBe(1);
  expect(result.history).toHaveLength(1);
  expect(result.favorites).toHaveLength(1);
  expect(result.favorite).toMatchObject({ type: "word", text: "sanction" });
});

test("Cloud-first 慢响应不覆盖更新的 Word Card", async ({ page }) => {
  await openApp(page, true);

  const result = await page.evaluate(async () => {
    let resolveOlder;
    const resolver = window.LingoFlowCloudLemmaResolver.create({
      cloudProvider: {
        name: "cloud_test",
        lookup({ word }) {
          if (word === "older") {
            return new Promise(resolve => { resolveOlder = resolve; });
          }
          return Promise.resolve({
            status: "found",
            headword: "newer",
            translation: "较新的 Cloud 结果",
            source: "supabase_core"
          });
        }
      },
      getLemmaCandidates: async () => []
    });
    window.LingoFlowDictionaryLookupService.setProviders([
      resolver,
      { name: "legacy_ecdict", lookup: async ({ word }) => ({ status: "not_found", query: word }) }
    ]);

    const older = showWordCard("older", "Older context", "article");
    while (!resolveOlder) await Promise.resolve();
    const newer = showWordCard("newer", "Newer context", "article");
    await newer;
    resolveOlder({
      status: "found",
      headword: "older",
      translation: "不应覆盖的新旧结果",
      source: "supabase_core"
    });
    await older;

    return {
      word: document.getElementById("currentWord").textContent,
      meaning: document.getElementById("meaning").textContent,
      history: window.LingoFlowQueryEventRepository.list()
    };
  });

  expect(result.word).toBe("newer");
  expect(result.meaning).toBe("较新的 Cloud 结果");
  expect(result.history).toHaveLength(1);
  expect(result.history[0].word).toBe("newer");
});

test("logout 状态变化不清除 Dictionary Cache，Reader/Search 仍只依赖 Lookup Service", async ({ page }) => {
  await openApp(page, true);

  const result = await page.evaluate(async () => {
    const factory = window.LingoFlowCachedCloudDictionaryProvider;
    const first = factory.create({
      cloudProvider: {
        name: "cloud_first",
        lookup: async () => ({
          status: "found",
          headword: "public-resource",
          translation: "公共资源",
          source: "supabase_core"
        })
      }
    });
    await first.lookup({ word: "public-resource" });

    window.dispatchEvent(new CustomEvent("lingoflow:auth-state", {
      detail: { status: "signed-out", reason: "signed-out" }
    }));

    let cloudCalls = 0;
    const second = factory.create({
      cloudProvider: {
        name: "cloud_second",
        async lookup() {
          cloudCalls += 1;
          return { status: "unavailable", reason: "should_not_run" };
        }
      }
    });
    const accountSwitchSource = await fetch("/js/account-switch-service.js")
      .then(response => response.text());
    return {
      outcome: await second.lookup({ word: "public-resource" }),
      cloudCalls,
      accountSwitchTouchesCache: accountSwitchSource.includes(factory.CACHE_DB_NAME),
      reader: showWordCard.toString(),
      search: directSearch.toString()
    };
  });

  expect(result.cloudCalls).toBe(0);
  expect(result.outcome.source).toBe("dictionary_cache");
  expect(result.accountSwitchTouchesCache).toBe(false);
  for (const source of [result.reader, result.search]) {
    expect(source).toContain("LingoFlowDictionaryLookupService.lookup");
    expect(source).not.toMatch(/Supabase|CachedCloud|CloudLemma|getLemma|indexedDB/);
  }
});
