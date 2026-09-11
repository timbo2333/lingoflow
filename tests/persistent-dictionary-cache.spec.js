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

test("Cloud found 写入独立、版本化 Persistent Cache", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const factory = window.LingoFlowCachedCloudDictionaryProvider;
    const persistentCache = factory.createPersistentCache();
    const cloudCalls = [];
    const provider = factory.create({
      persistentCache,
      cloudProvider: {
        name: "cloud_test",
        async lookup({ word }) {
          cloudCalls.push(word);
          return {
            status: "found",
            headword: "canonical-word",
            phonetic: null,
            translation: "规范词条",
            pos: null,
            source: "supabase_core"
          };
        }
      }
    });

    const outcome = await provider.lookup({ word: "  Canonical—Word  " });
    const cacheKey = factory.createCacheKey(
      factory.DICTIONARY_DATA_VERSION,
      "canonical-word"
    );
    return {
      outcome,
      cloudCalls,
      record: await persistentCache.get(cacheKey),
      constants: {
        database: factory.CACHE_DB_NAME,
        store: factory.CACHE_STORE_NAME,
        version: factory.CACHE_DB_VERSION,
        dataVersion: factory.DICTIONARY_DATA_VERSION,
        cacheKey
      }
    };
  });

  expect(result.cloudCalls).toEqual(["canonical-word"]);
  expect(result.outcome).toMatchObject({
    status: "found",
    query: "Canonical—Word",
    headword: "canonical-word",
    phonetic: null,
    translation: "规范词条",
    pos: null
  });
  expect(result.constants).toEqual({
    database: "LingoFlowDictionaryCacheDB",
    store: "lookups",
    version: 1,
    dataVersion: "core-2026-08-16-e15991ce6e92",
    cacheKey: "core-2026-08-16-e15991ce6e92:canonical-word"
  });
  expect(result.record).toMatchObject({
    cacheKey: result.constants.cacheKey,
    dataVersion: result.constants.dataVersion,
    canonicalWord: "canonical-word",
    status: "found",
    word: "canonical-word",
    phonetic: null,
    translation: "规范词条",
    pos: null
  });
  expect(result.record.cachedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

test("新 Provider instance 从 Persistent Cache 返回 found，Cloud RPC 为 0", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const factory = window.LingoFlowCachedCloudDictionaryProvider;
    const first = factory.create({
      cloudProvider: {
        name: "cloud_first",
        async lookup() {
          return {
            status: "found",
            headword: "reader",
            phonetic: "/ˈriːdə/",
            translation: "读者",
            pos: "noun",
            source: "supabase_core"
          };
        }
      }
    });
    await first.lookup({ word: "reader" });

    let secondCloudCalls = 0;
    const second = factory.create({
      cloudProvider: {
        name: "cloud_second",
        async lookup() {
          secondCloudCalls += 1;
          return { status: "unavailable", reason: "should_not_run" };
        }
      }
    });
    return {
      outcome: await second.lookup({ word: "reader" }),
      secondCloudCalls
    };
  });

  expect(result.secondCloudCalls).toBe(0);
  expect(result.outcome).toMatchObject({
    status: "found",
    headword: "reader",
    phonetic: "/ˈriːdə/",
    translation: "读者",
    pos: "noun",
    source: "dictionary_cache"
  });
});

test("Cloud not_found 写入 negative cache，新实例命中时 Cloud RPC 为 0", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const factory = window.LingoFlowCachedCloudDictionaryProvider;
    const firstCache = factory.createPersistentCache();
    const first = factory.create({
      persistentCache: firstCache,
      cloudProvider: {
        name: "cloud_first",
        lookup: async ({ word }) => ({ status: "not_found", query: word })
      }
    });
    await first.lookup({ word: "missingword" });

    const cacheKey = factory.createCacheKey(
      factory.DICTIONARY_DATA_VERSION,
      "missingword"
    );
    const record = await firstCache.get(cacheKey);
    let secondCloudCalls = 0;
    const second = factory.create({
      cloudProvider: {
        name: "cloud_second",
        async lookup() {
          secondCloudCalls += 1;
          return { status: "found", headword: "unexpected", translation: "不应调用" };
        }
      }
    });
    return {
      record,
      outcome: await second.lookup({ word: "missingword" }),
      secondCloudCalls
    };
  });

  expect(result.record).toMatchObject({
    canonicalWord: "missingword",
    status: "not_found"
  });
  expect(result.secondCloudCalls).toBe(0);
  expect(result.outcome).toEqual({ status: "not_found", query: "missingword" });
});

test("无效 canonical key 的本地 not_found 不写入 negative cache", async ({ page }) => {
  const result = await page.evaluate(async () => {
    let cloudRpcCalls = 0;
    const writes = [];
    const rawCloud = window.LingoFlowSupabaseDictionaryProvider.create({
      getClient: async () => ({
        rpc() {
          cloudRpcCalls += 1;
          return Promise.resolve({ data: [], error: null });
        }
      })
    });
    const cachedCloud = window.LingoFlowCachedCloudDictionaryProvider.create({
      persistentCache: {
        get: async () => undefined,
        async put(record) {
          writes.push(record);
        }
      },
      cloudProvider: rawCloud
    });

    return {
      outcome: await cachedCloud.lookup({ word: "not a word" }),
      cloudRpcCalls,
      writes
    };
  });

  expect(result.outcome).toEqual({ status: "not_found", query: "not a word" });
  expect(result.cloudRpcCalls).toBe(0);
  expect(result.writes).toEqual([]);
});

test("Cloud unavailable 与 timeout 都不写入 found/negative cache", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const outcomes = {};
    const writes = [];
    for (const reason of ["cloud_unavailable", "cloud_timeout"]) {
      const provider = window.LingoFlowCachedCloudDictionaryProvider.create({
        persistentCache: {
          get: async () => undefined,
          async put(record) {
            writes.push(record);
          }
        },
        cloudProvider: {
          name: "cloud_test",
          lookup: async ({ word }) => ({ status: "unavailable", query: word, reason })
        }
      });
      outcomes[reason] = await provider.lookup({ word: reason });
    }
    return { outcomes, writes };
  });

  expect(result.writes).toEqual([]);
  expect(result.outcomes.cloud_unavailable).toMatchObject({
    status: "unavailable",
    reason: "cloud_unavailable"
  });
  expect(result.outcomes.cloud_timeout).toMatchObject({
    status: "unavailable",
    reason: "cloud_timeout"
  });
});

test("Cache read failure 降级到 Cloud，Cache write failure 不影响 Cloud result", async ({ page }) => {
  const result = await page.evaluate(async () => {
    let readFallbackCloudCalls = 0;
    const readFailure = window.LingoFlowCachedCloudDictionaryProvider.create({
      persistentCache: {
        get: async () => { throw new Error("read failed"); },
        put: async () => {}
      },
      cloudProvider: {
        name: "cloud_read_fallback",
        async lookup() {
          readFallbackCloudCalls += 1;
          return {
            status: "found",
            headword: "readable",
            translation: "可读取的",
            source: "supabase_core"
          };
        }
      }
    });
    const readOutcome = await readFailure.lookup({ word: "readable" });

    const writeFailure = window.LingoFlowCachedCloudDictionaryProvider.create({
      persistentCache: {
        get: async () => undefined,
        put: async () => { throw new Error("quota exceeded"); }
      },
      cloudProvider: {
        name: "cloud_write_fallback",
        async lookup() {
          return {
            status: "found",
            headword: "writable",
            translation: "可写的",
            source: "supabase_core"
          };
        }
      }
    });
    const writeOutcome = await writeFailure.lookup({ word: "writable" });
    return { readFallbackCloudCalls, readOutcome, writeOutcome };
  });

  expect(result.readFallbackCloudCalls).toBe(1);
  expect(result.readOutcome).toMatchObject({
    status: "found",
    translation: "可读取的"
  });
  expect(result.writeOutcome).toMatchObject({
    status: "found",
    translation: "可写的"
  });
});

test("Dictionary data version 改变后旧 cache 不命中", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const factory = window.LingoFlowCachedCloudDictionaryProvider;
    const first = factory.create({
      cloudProvider: {
        name: "cloud_v1",
        lookup: async () => ({
          status: "found",
          headword: "versioned",
          translation: "旧版本释义",
          source: "supabase_core"
        })
      }
    });
    await first.lookup({ word: "versioned" });

    let nextVersionCloudCalls = 0;
    const second = factory.create({
      dataVersion: `${factory.DICTIONARY_DATA_VERSION}-next`,
      cloudProvider: {
        name: "cloud_v2",
        async lookup() {
          nextVersionCloudCalls += 1;
          return {
            status: "found",
            headword: "versioned",
            translation: "新版本释义",
            source: "supabase_core"
          };
        }
      }
    });
    return {
      outcome: await second.lookup({ word: "versioned" }),
      nextVersionCloudCalls
    };
  });

  expect(result.nextVersionCloudCalls).toBe(1);
  expect(result.outcome.translation).toBe("新版本释义");
});

test("sanctions 与 went 刷新后由 negative/found cache 完成 Lemma lookup，Cloud RPC 为 0", async ({ page }) => {
  const first = await page.evaluate(async () => {
    const db = await openECDICTDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("lemmas", "readwrite");
      const store = tx.objectStore("lemmas");
      store.put({ form: "sanctions", lemma: "sanction" });
      store.put({ form: "went", lemma: "go" });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });

    const cloudCalls = [];
    const rawCloud = {
      name: "cloud_first",
      async lookup({ word }) {
        cloudCalls.push(word);
        if (word === "sanction" || word === "go") {
          return {
            status: "found",
            headword: word,
            phonetic: null,
            translation: `${word} 的释义`,
            pos: null,
            source: "supabase_core"
          };
        }
        return { status: "not_found", query: word };
      }
    };
    const cachedCloud = window.LingoFlowCachedCloudDictionaryProvider.create({
      cloudProvider: rawCloud
    });
    const resolver = window.LingoFlowCloudLemmaResolver.create({
      cloudProvider: cachedCloud,
      getLemmaCandidates
    });
    return {
      sanctions: await resolver.lookup({ word: "sanctions" }),
      went: await resolver.lookup({ word: "went" }),
      cloudCalls
    };
  });

  expect(first.cloudCalls).toEqual(["sanctions", "sanction", "went", "go"]);
  expect(first.sanctions.relation).toBe("sanctions → sanction");
  expect(first.went.relation).toBe("went → go");

  await page.reload();
  await waitForAppReady(page);

  const second = await page.evaluate(async () => {
    const cloudCalls = [];
    const cachedCloud = window.LingoFlowCachedCloudDictionaryProvider.create({
      cloudProvider: {
        name: "cloud_after_reload",
        async lookup({ word }) {
          cloudCalls.push(word);
          return { status: "unavailable", query: word, reason: "should_not_run" };
        }
      }
    });
    const resolver = window.LingoFlowCloudLemmaResolver.create({
      cloudProvider: cachedCloud,
      getLemmaCandidates
    });
    return {
      sanctions: await resolver.lookup({ word: "sanctions" }),
      went: await resolver.lookup({ word: "went" }),
      cloudCalls
    };
  });

  expect(second.cloudCalls).toEqual([]);
  expect(second.sanctions).toMatchObject({
    status: "found",
    headword: "sanction",
    relation: "sanctions → sanction",
    source: "dictionary_cache"
  });
  expect(second.went).toMatchObject({
    status: "found",
    headword: "go",
    relation: "went → go",
    source: "dictionary_cache"
  });
});

test("Dictionary Cache 不进入 Account Switch cleanup 或 Backup v2", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const [accountSwitchSource, backupSource] = await Promise.all([
      fetch("/js/account-switch-service.js").then(response => response.text()),
      fetch("/js/backup-v2-export.js").then(response => response.text())
    ]);
    const databaseName = window.LingoFlowCachedCloudDictionaryProvider.CACHE_DB_NAME;
    return {
      databaseName,
      accountReferencesCache: accountSwitchSource.includes(databaseName) ||
        /indexedDB\s*\.\s*deleteDatabase/.test(accountSwitchSource),
      backupReferencesCache: backupSource.includes(databaseName) ||
        backupSource.includes("LingoFlowCachedCloudDictionaryProvider")
    };
  });

  expect(result.databaseName).toBe("LingoFlowDictionaryCacheDB");
  expect(result.accountReferencesCache).toBe(false);
  expect(result.backupReferencesCache).toBe(false);
});

test("latency smoke harness 保持 network-only，绕过 Persistent Cache", async ({ page }) => {
  await page.addScriptTag({ url: "/scripts/dictionary-cloud-smoke.js" });
  const source = await page.evaluate(() => window.LingoFlowDictionaryCloudSmoke.run.toString());

  expect(source).toContain("LingoFlowSupabaseDictionaryProvider");
  expect(source).not.toContain("LingoFlowCachedCloudDictionaryProvider");
});

test("Reader/directSearch 不依赖 Cache，Production 默认仍 Legacy-only", async ({ page }) => {
  const result = await page.evaluate(() => ({
    reader: showWordCard.toString(),
    search: directSearch.toString(),
    providers: window.LingoFlowDictionaryLookupService.getProviderNames()
  }));

  for (const source of [result.reader, result.search]) {
    expect(source).toContain("LingoFlowDictionaryLookupService.lookup");
    expect(source).not.toMatch(/DictionaryCache|CachedCloud|indexedDB/);
  }
  expect(result.providers).toEqual(["legacy_ecdict"]);
});
