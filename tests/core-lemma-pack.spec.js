const { test, expect } = require("@playwright/test");

const PAGE_ERRORS = new WeakMap();
const DATABASES = [
  "EnglishReaderECDICT",
  "LingoFlowDictionaryCacheDB",
  "LingoFlowCoreLemmaDB"
];
const CORE_ENTRIES = {
  academic: { word: "academic", translation: "学术的" },
  accounting: { word: "accounting", translation: "会计；核算" },
  sanction: { word: "sanction", translation: "制裁；批准" },
  go: { word: "go", translation: "去；进行" },
  look: { word: "look", translation: "看" },
  have: { word: "have", translation: "有" },
  leaf: { word: "leaf", translation: "叶子" }
};

async function deleteDatabasesOnce(page) {
  // A same-origin 404 HTML page runs no application scripts, so no database
  // connection can race this one-time cleanup.
  await page.goto("/__lingoflow_test_cleanup__.html");
  await page.evaluate(async names => {
    for (const name of names) {
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = resolve;
        request.onerror = () => reject(request.error || new Error(`Failed to delete ${name}`));
        request.onblocked = () => reject(new Error(`Delete blocked for ${name}`));
      });
    }
  }, DATABASES);
}

async function clearRetiredSmokeFlag(page) {
  await page.evaluate(() => {
    localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
    localStorage.removeItem("lingoflow_dictionary_cloud_first_smoke");
  });
}

async function waitForApp(page) {
  await expect(page.locator("#inputText")).toBeVisible();
  await expect(page.locator("#dictionarySetupStatus")).not.toHaveAttribute(
    "data-state",
    "checking"
  );
}

async function openFreshApp(page, options = {}) {
  await deleteDatabasesOnce(page);
  await clearRetiredSmokeFlag(page);
  await page.goto("/");
  await waitForApp(page);
}

function installResourceCounter(page) {
  const counts = { manifest: 0, pack: 0 };
  page.on("request", request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.endsWith("/core-lemma-manifest.json")) counts.manifest += 1;
    if (pathname.endsWith("/core-lemma-candidates.json")) counts.pack += 1;
  });
  return counts;
}

async function installRpcStub(page, entries = CORE_ENTRIES) {
  const calls = [];
  await page.route("**/rest/v1/rpc/lookup_dictionary", async route => {
    let body = {};
    try { body = route.request().postDataJSON() || {}; } catch { /* invalid body => miss */ }
    const word = body.p_word;
    calls.push(word);
    const entry = entries[word];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(entry ? [{
        word: entry.word,
        phonetic: null,
        translation: entry.translation,
        pos: null
      }] : [])
    });
  });
  return calls;
}

async function lookup(page, word) {
  return await page.evaluate(async query => (
    await window.LingoFlowDictionaryLookupService.lookup({ word: query })
  ), word);
}

async function ensurePack(page, options) {
  return await page.evaluate(async loadOptions => {
    const result = await window.LingoFlowCoreLemmaPack.ensureLoaded(loadOptions || {});
    return {
      status: result.status,
      reason: result.reason || "",
      ready: window.LingoFlowCoreLemmaPack.isReady()
    };
  }, options || null);
}

async function legacyDatabaseState(page) {
  return await page.evaluate(async () => {
    const db = await openECDICTDatabase();
    async function count(storeName) {
      if (!db.objectStoreNames.contains(storeName)) return 0;
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, "readonly");
        const request = tx.objectStore(storeName).count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    const result = {
      entries: await count("entries"),
      lemmas: await count("lemmas"),
      ready: await isECDICTReadyForLookup()
    };
    db.close();
    return result;
  });
}

async function runResolverFailure(page, loadOptions) {
  return await page.evaluate(async options => {
    const pack = window.LingoFlowCoreLemmaPack;
    pack.resetForTest();
    await pack.clearCachedMeta();
    let resolverOutcome = null;
    let legacyCalls = 0;
    const resolver = window.LingoFlowCloudLemmaResolver.create({
      cloudProvider: {
        name: "cloud_not_found",
        async lookup({ word }) { return { status: "not_found", query: word }; }
      },
      async getLemmaCandidates(form) {
        const status = await pack.ensureLoaded(options);
        if (status.status !== "ready") return status;
        return {
          status: "ready",
          candidates: pack.getCandidates(form) || []
        };
      }
    });
    const observedResolver = {
      name: resolver.name,
      async lookup(request) {
        resolverOutcome = await resolver.lookup(request);
        return resolverOutcome;
      }
    };
    window.LingoFlowDictionaryLookupService.setProviders([
      observedResolver,
      {
        name: "legacy_not_ready",
        async lookup({ word }) {
          legacyCalls += 1;
          return {
            status: "unavailable",
            query: word,
            reason: "legacy_dictionary_not_ready"
          };
        }
      }
    ]);
    const finalOutcome = await window.LingoFlowDictionaryLookupService.lookup({
      word: "sanctions"
    });
    return { resolverOutcome, finalOutcome, legacyCalls };
  }, loadOptions);
}

test.beforeEach(async ({ page }) => {
  const errors = [];
  PAGE_ERRORS.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
});

test.afterEach(async ({ page }) => {
  expect(PAGE_ERRORS.get(page), "page should not raise JavaScript errors").toEqual([]);
});

test("Cloud exact hit stays exact-first and does not load the Pack", async ({ page }) => {
  const resources = installResourceCounter(page);
  const calls = await installRpcStub(page);
  await openFreshApp(page);

  const result = await lookup(page, "academic");

  expect(result).toMatchObject({
    status: "found",
    headword: "academic",
    source: "supabase_core"
  });
  expect(calls).toEqual(["academic"]);
  expect(resources).toEqual({ manifest: 0, pack: 0 });
  expect(await page.evaluate(() => window.LingoFlowCoreLemmaPack.getStatus().status))
    .toBe("idle");
});

test("fresh browser resolves sanctions without Legacy entries or lemmas", async ({ page }) => {
  const calls = await installRpcStub(page);
  await openFreshApp(page);

  expect(await legacyDatabaseState(page)).toEqual({ entries: 0, lemmas: 0, ready: false });
  const result = await lookup(page, "sanctions");

  expect(calls).toEqual(["sanctions", "sanction"]);
  expect(result).toMatchObject({
    status: "found",
    headword: "sanction",
    relation: "sanctions → sanction",
    source: "supabase_core"
  });
});

test("fresh browser resolves went, looked, and having through Core lemmas", async ({ page }) => {
  const calls = await installRpcStub(page);
  await openFreshApp(page);

  const went = await lookup(page, "went");
  const looked = await lookup(page, "looked");
  const having = await lookup(page, "having");

  expect(went).toMatchObject({ headword: "go", relation: "went → go" });
  expect(looked).toMatchObject({ headword: "look", relation: "looked → look" });
  expect(having).toMatchObject({ headword: "have", relation: "having → have" });
  expect(calls).toEqual(["went", "go", "looked", "look", "having", "have"]);
});

test("ambiguous leaves candidates are tried by frequency then deterministic order", async ({ page }) => {
  const calls = await installRpcStub(page);
  await openFreshApp(page);

  const result = await lookup(page, "leaves");
  const candidates = await page.evaluate(() => (
    window.LingoFlowCoreLemmaPack.getCandidates("leaves")
  ));

  expect(candidates.slice(0, 2)).toEqual([
    { lemma: "leave", frequency: 63376 },
    { lemma: "leaf", frequency: 5117 }
  ]);
  expect(calls).toEqual(["leaves", "leave", "leaf"]);
  expect(result).toMatchObject({
    status: "found",
    headword: "leaf",
    relation: "leaves → leaf"
  });
});

test("accounting exact hit does not consult the Pack", async ({ page }) => {
  const resources = installResourceCounter(page);
  const calls = await installRpcStub(page);
  await openFreshApp(page);

  const result = await lookup(page, "accounting");

  expect(result).toMatchObject({ status: "found", headword: "accounting", relation: "" });
  expect(calls).toEqual(["accounting"]);
  expect(resources).toEqual({ manifest: 0, pack: 0 });
});

test("Dictionary and Core Lemma caches persist across lookup and reload", async ({ page }) => {
  const resources = installResourceCounter(page);
  const calls = await installRpcStub(page);
  await openFreshApp(page);

  const first = await lookup(page, "sanctions");
  expect(first).toMatchObject({
    status: "found",
    source: "supabase_core",
    relation: "sanctions → sanction"
  });
  expect(calls).toEqual(["sanctions", "sanction"]);
  expect(resources).toEqual({ manifest: 1, pack: 1 });

  const second = await lookup(page, "sanctions");
  expect(second).toMatchObject({
    status: "found",
    source: "dictionary_cache",
    relation: "sanctions → sanction"
  });
  expect(calls).toHaveLength(2);
  expect(resources).toEqual({ manifest: 1, pack: 1 });

  await page.reload();
  await waitForApp(page);
  const third = await lookup(page, "sanctions");
  expect(third).toMatchObject({
    status: "found",
    source: "dictionary_cache",
    relation: "sanctions → sanction"
  });
  expect(calls).toHaveLength(2);
  expect(resources).toEqual({ manifest: 1, pack: 1 });
});

test("concurrent Pack loads share one manifest and one payload request", async ({ page }) => {
  const resources = installResourceCounter(page);
  await openFreshApp(page);

  const statuses = await page.evaluate(async () => {
    const pack = window.LingoFlowCoreLemmaPack;
    return await Promise.all([
      pack.ensureLoaded(),
      pack.ensureLoaded(),
      pack.ensureLoaded()
    ]);
  });

  expect(statuses.map(item => item.status)).toEqual(["ready", "ready", "ready"]);
  expect(resources).toEqual({ manifest: 1, pack: 1 });
});

test("Pack network failure stays unavailable and Lookup Service enters Legacy", async ({ page }) => {
  await page.route("**/missing-core-lemma-manifest.json", route => route.abort("failed"));
  await openFreshApp(page);

  const result = await runResolverFailure(page, {
    manifestUrl: "/missing-core-lemma-manifest.json",
    timeoutMs: 1000
  });

  expect(result.resolverOutcome).toMatchObject({
    status: "unavailable",
    reason: "lemma_pack_manifest_unavailable"
  });
  expect(result.finalOutcome).toMatchObject({ status: "unavailable" });
  expect(result.legacyCalls).toBe(1);
});

test("malformed Pack stays unavailable and cannot recover through the real resource", async ({ page }) => {
  const manifest = require("../data/dictionary/core-lemma-manifest.json");
  await page.route("**/malformed-manifest.json", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(manifest)
  }));
  await page.route("**/core-lemma-candidates.json", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: "{malformed"
  }));
  await openFreshApp(page);

  const result = await runResolverFailure(page, {
    manifestUrl: "/malformed-manifest.json"
  });

  expect(result.resolverOutcome).toMatchObject({
    status: "unavailable",
    reason: "lemma_pack_integrity_mismatch"
  });
  expect(result.finalOutcome).toMatchObject({ status: "unavailable" });
  expect(result.legacyCalls).toBe(1);
});

test("manifest version mismatch stays unavailable and enters Legacy", async ({ page }) => {
  const manifest = {
    ...require("../data/dictionary/core-lemma-manifest.json"),
    lemmaPackVersion: "future-version"
  };
  await page.route("**/version-mismatch-manifest.json", route => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(manifest)
  }));
  await openFreshApp(page);

  const result = await runResolverFailure(page, {
    manifestUrl: "/version-mismatch-manifest.json"
  });

  expect(result.resolverOutcome).toMatchObject({
    status: "unavailable",
    reason: "lemma_pack_version_mismatch"
  });
  expect(result.finalOutcome).toMatchObject({ status: "unavailable" });
  expect(result.legacyCalls).toBe(1);
});

test("ready candidates with authoritative Cloud misses return not_found", async ({ page }) => {
  await openFreshApp(page);
  const result = await page.evaluate(async () => {
    const pack = window.LingoFlowCoreLemmaPack;
    const status = await pack.ensureLoaded();
    const calls = [];
    const resolver = window.LingoFlowCloudLemmaResolver.create({
      cloudProvider: {
        name: "authoritative_miss",
        async lookup({ word }) {
          calls.push(word);
          return { status: "not_found", query: word };
        }
      },
      async getLemmaCandidates(form) {
        return { status: "ready", candidates: pack.getCandidates(form) || [] };
      }
    });
    return { status, calls, outcome: await resolver.lookup({ word: "leaves" }) };
  });

  expect(result.status.status).toBe("ready");
  expect(result.calls).toEqual(["leaves", "leave", "leaf"]);
  expect(result.outcome).toEqual({ status: "not_found", query: "leaves" });
});

test("corrupt cached text fails SHA validation and only its Pack cache is removed", async ({ page }) => {
  await openFreshApp(page);
  expect((await ensurePack(page)).status).toBe("ready");

  const result = await page.evaluate(async () => {
    const pack = window.LingoFlowCoreLemmaPack;
    const manifest = pack.getCachedManifest();
    await new Promise((resolve, reject) => {
      const request = indexedDB.open(pack.DB_NAME, pack.DB_VERSION);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("meta", "readwrite");
        tx.objectStore("meta").put({ key: "pack", manifest, text: "{}" });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
      request.onerror = () => reject(request.error);
    });
    pack.resetMemoryOnly();
    const status = await pack.ensureLoaded({ manifestUrl: "/missing-after-corrupt.json" });
    const cached = await new Promise(resolve => {
      const request = indexedDB.open(pack.DB_NAME, pack.DB_VERSION);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("meta", "readonly");
        const get = tx.objectStore("meta").get("pack");
        get.onsuccess = () => { db.close(); resolve(Boolean(get.result)); };
        get.onerror = () => { db.close(); resolve(true); };
      };
      request.onerror = () => resolve(true);
    });
    return { status, cached };
  });

  expect(result.status).toMatchObject({
    status: "unavailable",
    reason: "lemma_pack_manifest_unavailable"
  });
  expect(result.cached).toBe(false);
});

test("Core Lemma Pack 不进入 Account Switch cleanup 或 Backup v2", async ({ page }) => {
  await openFreshApp(page);

  const result = await page.evaluate(async () => {
    const [accountSwitchSource, backupSource] = await Promise.all([
      fetch("/js/account-switch-service.js").then(response => response.text()),
      fetch("/js/backup-v2-export.js").then(response => response.text())
    ]);
    const databaseName = window.LingoFlowCoreLemmaPack.DB_NAME;
    return {
      databaseName,
      accountReferencesPack: accountSwitchSource.includes(databaseName),
      backupReferencesPack: backupSource.includes(databaseName) ||
        backupSource.includes("LingoFlowCoreLemmaPack")
    };
  });

  expect(result.databaseName).toBe("LingoFlowCoreLemmaDB");
  expect(result.accountReferencesPack).toBe(false);
  expect(result.backupReferencesPack).toBe(false);
});

test("production default is Cloud-first but remains lazy before the first lookup", async ({ page }) => {
  const resources = installResourceCounter(page);
  const legacyRequests = [];
  page.on("request", request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.includes("/data/dictionary/ecdict-part-") ||
        pathname.endsWith("/data/dictionary/manifest.json") ||
        pathname.endsWith("/data/dictionary/lemma.en.txt")) {
      legacyRequests.push(pathname);
    }
  });
  let rpcCalls = 0;
  await page.route("**/rest/v1/rpc/lookup_dictionary", route => {
    rpcCalls += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await openFreshApp(page);

  expect(await page.evaluate(() => (
    window.LingoFlowDictionaryLookupService.getProviderNames()
  ))).toEqual(["cloud_lemma_resolver", "legacy_ecdict"]);
  const databases = await page.evaluate(async () => (
    typeof indexedDB.databases === "function"
      ? (await indexedDB.databases()).map(item => item.name)
      : []
  ));

  expect(rpcCalls).toBe(0);
  expect(resources).toEqual({ manifest: 0, pack: 0 });
  expect(legacyRequests).toEqual([]);
  expect(databases).not.toContain("LingoFlowCoreLemmaDB");
  expect(databases).not.toContain("LingoFlowDictionaryCacheDB");
  expect(databases).not.toContain("EnglishReaderECDICT");
  await expect(page.locator("#dictionaryGuideModal")).not.toHaveClass(/show/);
  await expect(page.locator("#dictionarySetupStatus")).toHaveAttribute("data-state", "optional");
  await expect(page.locator("#dictionarySetupTitle")).toHaveText("在线词典已可使用");
});
