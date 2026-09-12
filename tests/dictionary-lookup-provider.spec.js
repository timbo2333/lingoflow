const { test, expect } = require("@playwright/test");

const projectErrors = new WeakMap();

async function waitForAppReady(page) {
  await expect(page.locator("#inputText")).toBeVisible();
  await expect(page.locator("#dictionarySetupStatus")).not.toHaveAttribute(
    "data-state",
    "checking"
  );
}

async function seedLegacyDictionary(page, entries, lemmas = []) {
  await page.evaluate(async ({ dictionaryEntries, lemmaEntries }) => {
    const db = await openECDICTDatabase();

    await new Promise((resolve, reject) => {
      const tx = db.transaction(["entries", "lemmas", "meta"], "readwrite");
      const entryStore = tx.objectStore("entries");
      const lemmaStore = tx.objectStore("lemmas");
      const metaStore = tx.objectStore("meta");

      entryStore.clear();
      lemmaStore.clear();
      metaStore.clear();

      for (const entry of dictionaryEntries) entryStore.put(entry);
      for (const lemma of lemmaEntries) lemmaStore.put(lemma);

      metaStore.put({ key: "ready", value: true });
      metaStore.put({ key: "count", value: dictionaryEntries.length });
      metaStore.put({ key: "source", value: "test" });
      metaStore.put({ key: "lemma_ready", value: lemmaEntries.length > 0 });
      metaStore.put({ key: "lemma_count", value: lemmaEntries.length });
      metaStore.put({ key: "lemma_source", value: "test" });

      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Dictionary seed aborted"));
    });
  }, { dictionaryEntries: entries, lemmaEntries: lemmas });
}

async function useLegacyProviderOnly(page) {
  await page.evaluate(() => {
    window.LingoFlowDictionaryLookupService.setProviders([
      window.LingoFlowLegacyECDICTProvider.create({
        isReady: isECDICTReadyForLookup,
        lookupLegacy: lookupWord,
        getUnavailableReason: () => "legacy_dictionary_not_ready"
      })
    ]);
  });
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

test("生产默认注册 Cloud Lemma → Legacy Provider chain", async ({ page }) => {
  const result = await page.evaluate(() => {
    const scripts = Array.from(document.scripts, script => (
      new URL(script.src, location.href).pathname
    ));

    return {
      serviceIndex: scripts.indexOf("/js/dictionary-lookup-service.js"),
      cloudIndex: scripts.indexOf("/js/supabase-dictionary-provider.js"),
      providerIndex: scripts.indexOf("/js/legacy-ecdict-provider.js"),
      mainIndex: scripts.indexOf("/js/main.js"),
      providers: window.LingoFlowDictionaryLookupService.getProviderNames()
    };
  });

  expect(result.serviceIndex).toBeGreaterThanOrEqual(0);
  expect(result.cloudIndex).toBeGreaterThan(result.serviceIndex);
  expect(result.providerIndex).toBeGreaterThan(result.cloudIndex);
  expect(result.mainIndex).toBeGreaterThan(result.providerIndex);
  expect(result.providers).toEqual(["cloud_lemma_resolver", "legacy_ecdict"]);
});

test("Legacy Provider 保留 exact-first 与 Lemma 词形还原结果", async ({ page }) => {
  await useLegacyProviderOnly(page);
  await seedLegacyDictionary(page, [
    {
      word: "develop",
      phonetic: "/dɪˈveləp/",
      translation: "发展；培养",
      pos: "verb",
      tag: "cet4 ielts",
      exchange: "i:developing/p:developed"
    },
    {
      word: "study",
      phonetic: "/ˈstʌdi/",
      translation: "学习；研究",
      pos: "verb / noun",
      tag: "cet4",
      exchange: "3:studies/p:studied/i:studying"
    },
    {
      word: "studies",
      phonetic: "/ˈstʌdiz/",
      translation: "研究；学习（第三人称单数）",
      pos: "verb",
      tag: "",
      exchange: ""
    }
  ], [
    { form: "studies", lemma: "study" }
  ]);

  const result = await page.evaluate(async () => ({
    exact: await window.LingoFlowDictionaryLookupService.lookup({ word: "Develop" }),
    lemma: await window.LingoFlowDictionaryLookupService.lookup({ word: "studies" })
  }));

  expect(result.exact).toMatchObject({
    status: "found",
    query: "Develop",
    headword: "develop",
    phonetic: "/dɪˈveləp/",
    translation: "发展；培养",
    pos: "verb",
    relation: "",
    source: "legacy_ecdict",
    attribution: "ECDICT 离线词库"
  });
  expect(result.lemma).toMatchObject({
    status: "found",
    query: "studies",
    headword: "study",
    phonetic: "/ˈstʌdiz/",
    translation: "学习；研究",
    pos: "verb",
    relation: "studies → study",
    source: "legacy_ecdict",
    attribution: "ECDICT + Lemma 词形还原",
    surfaceTranslation: "研究；学习（第三人称单数）"
  });
});

test("Lookup Contract 区分 not_found 与本地词典 unavailable", async ({ page }) => {
  await useLegacyProviderOnly(page);
  const unavailable = await page.evaluate(() => (
    window.LingoFlowDictionaryLookupService.lookup({ word: "unlistedlexeme" })
  ));

  expect(unavailable).toEqual({
    status: "unavailable",
    query: "unlistedlexeme",
    reason: "legacy_dictionary_not_ready"
  });

  await seedLegacyDictionary(page, [{
    word: "dictionaryanchor",
    phonetic: "",
    translation: "词典测试锚点",
    pos: "",
    tag: "",
    exchange: ""
  }]);

  const notFound = await page.evaluate(() => (
    window.LingoFlowDictionaryLookupService.lookup({ word: "unlistedlexeme" })
  ));

  expect(notFound).toEqual({ status: "not_found", query: "unlistedlexeme" });
});

test("FOUND contract 允许 phonetic 与 pos 为 null", async ({ page }) => {
  await useLegacyProviderOnly(page);
  await seedLegacyDictionary(page, [{
    word: "barelexeme",
    phonetic: "",
    translation: "无音标词条",
    pos: "",
    tag: "",
    exchange: ""
  }]);

  const result = await page.evaluate(() => (
    window.LingoFlowDictionaryLookupService.lookup({ word: "barelexeme" })
  ));

  expect(result).toMatchObject({
    status: "found",
    query: "barelexeme",
    headword: "barelexeme",
    phonetic: null,
    translation: "无音标词条",
    pos: null
  });
});

test("Provider chain 可注入后续 provider，并在 unavailable 后继续 fallback", async ({ page }) => {
  const result = await page.evaluate(async () => {
    window.LingoFlowDictionaryLookupService.setProviders([
      {
        name: "cloud_dictionary",
        async lookup({ word }) {
          return { status: "unavailable", query: word, reason: "offline" };
        }
      },
      {
        name: "fallback_dictionary",
        async lookup() {
          return {
            status: "found",
            headword: "fallback",
            phonetic: null,
            translation: "后备词典命中",
            pos: null,
            relation: "",
            source: "fallback_dictionary"
          };
        }
      }
    ]);

    return window.LingoFlowDictionaryLookupService.lookup({ word: "Fallback" });
  });

  expect(result).toMatchObject({
    status: "found",
    query: "Fallback",
    headword: "fallback",
    translation: "后备词典命中",
    source: "fallback_dictionary"
  });
});

test("showWordCard 通过 service 查询，并保持 Query History 与 Favorite 行为", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const requests = [];
    window.LingoFlowDictionaryLookupService.setProviders([{
      name: "reader_test",
      async lookup(request) {
        requests.push(request);
        return {
          status: "found",
          headword: "develop",
          phonetic: "/dɪˈveləp/",
          translation: "发展；培养",
          pos: "verb",
          relation: "",
          source: "reader_test",
          attribution: "测试词典"
        };
      }
    }]);

    await showWordCard(
      "Develop",
      "People develop skills through practice.",
      "article"
    );
    const favorite = await saveCurrentFavorite();

    return {
      requests,
      word: document.getElementById("currentWord").textContent,
      meaning: document.getElementById("meaning").textContent,
      source: document.getElementById("dictionaryStatus").textContent,
      history: window.LingoFlowQueryEventRepository.list(),
      favorite,
      currentLookupState
    };
  });

  expect(result.requests).toEqual([{
    word: "Develop",
    context: "People develop skills through practice."
  }]);
  expect(result.word).toBe("Develop");
  expect(result.meaning).toBe("发展；培养");
  expect(result.source).toContain("测试词典");
  expect(result.history).toHaveLength(1);
  expect(result.history[0]).toMatchObject({
    word: "develop",
    meaning: "发展；培养",
    dictionaryFound: true,
    source: "article"
  });
  expect(result.favorite).toMatchObject({
    type: "word",
    text: "develop",
    meaning: "发展；培养"
  });
  expect(result.currentLookupState.result).toMatchObject({
    baseWord: "develop",
    meaning: "发展；培养"
  });
});

test("directSearch 通过 service 查询并保留搜索结果与 Query History", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const requests = [];
    window.LingoFlowDictionaryLookupService.setProviders([{
      name: "search_test",
      async lookup(request) {
        requests.push(request);
        return {
          status: "found",
          headword: "develop",
          phonetic: "/dɪˈveləp/",
          translation: "发展；培养",
          pos: "verb",
          relation: "",
          source: "search_test",
          attribution: "测试词典"
        };
      }
    }]);

    await directSearch("Develop");

    return {
      requests,
      rendered: document.getElementById("directSearchResult").textContent,
      history: window.LingoFlowQueryEventRepository.list()
    };
  });

  expect(result.requests).toEqual([{ word: "Develop", context: "" }]);
  expect(result.rendered).toContain("发展；培养");
  expect(result.rendered).toContain("测试词典");
  expect(result.history).toHaveLength(1);
  expect(result.history[0]).toMatchObject({
    word: "develop",
    dictionaryFound: true,
    source: "search"
  });
});

test("较旧的异步 Word Card lookup 不会覆盖较新的结果", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const resolvers = {};
    window.LingoFlowDictionaryLookupService.setProviders([{
      name: "delayed_test",
      lookup({ word }) {
        return new Promise(resolve => {
          resolvers[word] = resolve;
        });
      }
    }]);

    const older = showWordCard("older", "Older context", "article");
    while (!resolvers.older) await Promise.resolve();

    const newer = showWordCard("newer", "Newer context", "article");
    while (!resolvers.newer) await Promise.resolve();

    resolvers.newer({
      status: "found",
      headword: "newer",
      phonetic: null,
      translation: "较新的结果",
      pos: null,
      relation: "",
      source: "delayed_test"
    });
    await newer;

    resolvers.older({
      status: "found",
      headword: "older",
      phonetic: null,
      translation: "不应覆盖的新旧结果",
      pos: null,
      relation: "",
      source: "delayed_test"
    });
    await older;

    return {
      word: document.getElementById("currentWord").textContent,
      meaning: document.getElementById("meaning").textContent,
      history: window.LingoFlowQueryEventRepository.list()
    };
  });

  expect(result.word).toBe("newer");
  expect(result.meaning).toBe("较新的结果");
  expect(result.history).toHaveLength(1);
  expect(result.history[0].word).toBe("newer");
});
