const { test, expect } = require("@playwright/test");

const STORAGE_KEYS = Object.freeze({
  preferences: "EnglishReaderV052ReadingPrefs",
  queryEvents: "EnglishReaderV052QueryEvents",
  historyBaselines: "EnglishReaderV052HistoryBaselines",
  migrationState: "EnglishReaderV052HistoryMigrationState",
  vocab: "EnglishReaderV05Vocab"
});

const COMPLETED_MIGRATION_STATE = { version: 1, status: "completed" };

function makeArticle(id) {
  return {
    id,
    title: `Preferences article ${id}`,
    content: `Preferences Backup v2 content for ${id}.`,
    sourceType: "paste",
    createdAt: "2026-08-31T00:00:00.000Z",
    updatedAt: "2026-08-31T01:00:00.000Z",
    lastReadAt: "2026-08-31T02:00:00.000Z",
    deletedAt: null,
    reading: {
      progress: 0.25,
      paragraphIndex: 0,
      updatedAt: "2026-08-31T02:00:00.000Z"
    }
  };
}

function makeFavorite(id) {
  return {
    id,
    type: "word",
    text: "apple",
    createdAt: "2026-08-31T03:00:00.000Z",
    updatedAt: "2026-08-31T04:00:00.000Z",
    deletedAt: null
  };
}

function makeLearningState(favoriteId) {
  return {
    favoriteId,
    mastered: false,
    createdAt: "2026-08-31T05:00:00.000Z",
    updatedAt: "2026-08-31T06:00:00.000Z",
    deletedAt: null
  };
}

function makeQueryEvent(id, overrides = {}) {
  return {
    id,
    deviceId: "device:preferences-backup",
    word: "apple",
    displayWord: "Apple",
    phonetic: "/ˈæpəl/",
    pos: "noun",
    meaning: "苹果",
    dictionaryFound: true,
    source: "article",
    timestamp: "2026-08-31T07:00:00.000Z",
    ...overrides
  };
}

function makeBaseline(id, overrides = {}) {
  return {
    id,
    createdAt: "2026-08-20T00:00:00.000Z",
    deviceId: "device:legacy-preferences-backup",
    records: {
      "opaque/apple": {
        word: "apple",
        count: 2,
        articleCount: 1,
        firstSeen: "2020-01-01T00:00:00.000Z",
        lastSeen: "2020-01-02T00:00:00.000Z"
      }
    },
    ...overrides
  };
}

function makeEnvelope(data) {
  return {
    format: { name: "LingoFlow Backup", version: 2 },
    metadata: {},
    schema: Object.fromEntries(Object.keys(data).map(entity => [entity, "1"])),
    data
  };
}

function makeSixEntityData(prefix, preferences) {
  const favorite = makeFavorite(`favorite:${prefix}`);
  return {
    articles: [makeArticle(`article:${prefix}`)],
    favorites: [favorite],
    favoriteLearningStates: [makeLearningState(favorite.id)],
    preferences,
    queryEvents: [makeQueryEvent(`query:${prefix}`)],
    historyBaselines: [makeBaseline(`baseline:${prefix}`)]
  };
}

async function loadBackupEnvironment(page) {
  await page.addInitScript(() => {
    localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
  });
  await page.goto("/");
  await expect(page.locator("#inputText")).toBeVisible();
  await page.waitForFunction(() => Boolean(
    window.LingoFlowBackupV2 &&
    window.LingoFlowBackupV2Export &&
    window.LingoFlowPreferencesBackupSchema &&
    window.LingoFlowPreferencesRepository &&
    window.LingoFlowPreferencesBackupExport
  ));
}

function findItem(result, entity, identity) {
  return result.items.find(item => (
    item.entity === entity && Object.entries(identity).every(([key, value]) => (
      item[key] === value
    ))
  ));
}

test("six-entity roundtrip preserves Preferences, Query History, and derived Vocab", async ({ browser }) => {
  const preferences = [
    { key: "fontSize", value: "21" },
    { key: "lineHeight", value: "2" },
    { key: "speechRate", value: "1" },
    {
      key: "speechVoice",
      value: { name: "Portable Voice", lang: "en-US", voiceURI: "voice:portable" }
    },
    {
      key: "future.preference",
      value: { nested: [true, null, { version: 1 }] }
    }
  ];
  const data = makeSixEntityData("roundtrip", preferences);
  const exportContext = await browser.newContext();
  let payload;
  try {
    const page = await exportContext.newPage();
    await loadBackupEnvironment(page);
    const result = await page.evaluate(async input => {
      await window.LingoFlowArticleLibrary.restoreArticle(input.articles[0]);
      window.LingoFlowFavoriteRepository.restoreBackupRecords(input.favorites);
      window.LingoFlowFavoriteLearningRepository.restoreBackupRecords(
        input.favoriteLearningStates
      );
      window.LingoFlowPreferencesRepository.restoreBackupItems(input.preferences);
      window.LingoFlowQueryEventRepository.restoreBackupRecords(input.queryEvents);
      window.LingoFlowHistoryBaselineRepository.restoreBackupRecords(
        input.historyBaselines
      );
      return window.LingoFlowBackupV2Export.exportBackup();
    }, data);

    expect(result.status).toBe("ready");
    expect(result.payload.schema).toEqual({
      articles: "1",
      favorites: "1",
      favoriteLearningStates: "1",
      queryEvents: "1",
      historyBaselines: "1",
      preferences: "1"
    });
    expect(result.payload.data.preferences).toEqual(expect.arrayContaining(preferences));
    expect(result.payload.data).not.toHaveProperty("vocab");
    expect(result.payload.data).not.toHaveProperty("migrationState");
    expect(result.payload.data).not.toHaveProperty("deviceId");
    payload = result.payload;
  } finally {
    await exportContext.close();
  }

  const restoreContext = await browser.newContext();
  try {
    const page = await restoreContext.newPage();
    await loadBackupEnvironment(page);
    const outcome = await page.evaluate(async incoming => {
      const result = await window.LingoFlowBackupV2.restoreBackup(incoming);
      return {
        result,
        preferences: window.LingoFlowPreferencesRepository.list(),
        queryEvents: window.LingoFlowQueryEventRepository.list(),
        historyBaselines: window.LingoFlowHistoryBaselineRepository.list(),
        vocab: JSON.parse(localStorage.getItem("EnglishReaderV05Vocab"))
      };
    }, payload);

    expect(outcome.result).toMatchObject({
      status: "completed",
      summary: { total: 10, restored: 10, conflicts: 0, failed: 0 },
      migration: { status: "completed", backupWritesStarted: true },
      vocabRebuild: { status: "rebuilt" }
    });
    expect(outcome.preferences).toMatchObject({
      status: "ready",
      preferences: expect.arrayContaining(preferences)
    });
    expect(outcome.queryEvents).toEqual(data.queryEvents);
    expect(outcome.historyBaselines).toEqual(data.historyBaselines);
    expect(outcome.vocab.apple).toMatchObject({ word: "apple", count: 3 });
  } finally {
    await restoreContext.close();
  }
});

test("empty Preferences adds no defaults while speechVoice null remains an explicit value", async ({ page }) => {
  await loadBackupEnvironment(page);
  const result = await page.evaluate(async () => {
    const emptyEnvelope = {
      format: { name: "LingoFlow Backup", version: 2 },
      metadata: {},
      schema: { articles: "1", preferences: "1" },
      data: { articles: [], preferences: [] }
    };
    const before = window.LingoFlowPreferencesRepository.get("speechVoice");
    const empty = await window.LingoFlowBackupV2.restoreBackup(emptyEnvelope);
    const afterEmpty = window.LingoFlowPreferencesRepository.list();
    const withNull = await window.LingoFlowBackupV2.restoreBackup({
      ...emptyEnvelope,
      data: {
        articles: [],
        preferences: [{ key: "speechVoice", value: null }]
      }
    });
    return {
      before,
      empty,
      afterEmpty,
      withNull,
      voice: window.LingoFlowPreferencesRepository.get("speechVoice")
    };
  });

  expect(result.before.status).toBe("missing");
  expect(result.empty).toMatchObject({ status: "completed", summary: { total: 0 } });
  expect(result.afterEmpty).toMatchObject({ status: "ready", preferences: [] });
  expect(result.withNull).toMatchObject({
    status: "completed",
    summary: { total: 1, restored: 1 }
  });
  expect(result.voice).toMatchObject({
    status: "found",
    preferenceKey: "speechVoice",
    value: null
  });
});

test("Preferences restore merges per key and reports restored, unchanged, and conflict", async ({ page }) => {
  await loadBackupEnvironment(page);
  const result = await page.evaluate(async envelope => {
    window.LingoFlowPreferencesRepository.restoreBackupItems([
      { key: "appearance", value: "light" },
      { key: "speechRate", value: "1" },
      { key: "lineHeight", value: "2.2" }
    ]);
    const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
    return {
      restored,
      preferences: window.LingoFlowPreferencesRepository.list()
    };
  }, makeEnvelope({
    articles: [],
    preferences: [
      { key: "fontSize", value: "21" },
      { key: "speechRate", value: "1" },
      { key: "appearance", value: "dark" }
    ]
  }));

  expect(result.restored).toMatchObject({
    status: "completed-with-conflicts",
    summary: { total: 3, restored: 1, unchanged: 1, conflicts: 1 }
  });
  expect(findItem(result.restored, "preferences", { preferenceKey: "fontSize" }))
    .toMatchObject({ status: "restored", written: true });
  expect(findItem(result.restored, "preferences", { preferenceKey: "speechRate" }))
    .toMatchObject({ status: "unchanged", written: false });
  expect(findItem(result.restored, "preferences", { preferenceKey: "appearance" }))
    .toMatchObject({ status: "conflict", written: false });
  expect(result.preferences.preferences).toEqual(expect.arrayContaining([
    { key: "fontSize", value: "21" },
    { key: "speechRate", value: "1" },
    { key: "appearance", value: "light" },
    { key: "lineHeight", value: "2.2" }
  ]));
});

test("invalid Preferences Schema rejects globally before any Backup fact write", async ({ page }) => {
  await loadBackupEnvironment(page);
  const article = makeArticle("article:invalid-preferences");
  const result = await page.evaluate(async ({ envelope, keys }) => {
    const migrationBefore = localStorage.getItem(keys.migrationState);
    const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
    return {
      restored,
      articles: await window.LingoFlowArticleLibrary.listArticles({ includeDeleted: true }),
      preferencesRaw: localStorage.getItem(keys.preferences),
      migrationBefore,
      migrationRaw: localStorage.getItem(keys.migrationState)
    };
  }, {
    envelope: makeEnvelope({
      articles: [article],
      preferences: [{ key: "speed", value: "1" }]
    }),
    keys: STORAGE_KEYS
  });

  expect(result.restored.status).toBe("rejected");
  expect(result.articles).toEqual([]);
  expect(result.preferencesRaw).toBeNull();
  expect(result.migrationRaw).toBe(result.migrationBefore);
  expect(findItem(result.restored, "articles", { articleId: article.id }))
    .toMatchObject({ status: "not-attempted", written: false });
});

test("Preferences storage read failure blocks every Backup fact write and preserves identity", async ({ page }) => {
  await loadBackupEnvironment(page);
  const article = makeArticle("article:preferences-read-failure");
  const result = await page.evaluate(async ({ envelope, keys }) => {
    const originalGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key) {
      if (key === keys.preferences) {
        throw new DOMException("preferences read blocked", "SecurityError");
      }
      return originalGetItem.call(this, key);
    };
    try {
      const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
      return {
        restored,
        articles: await window.LingoFlowArticleLibrary.listArticles({
          includeDeleted: true
        }),
        preferencesRaw: originalGetItem.call(localStorage, keys.preferences)
      };
    } finally {
      Storage.prototype.getItem = originalGetItem;
    }
  }, {
    envelope: makeEnvelope({
      articles: [article],
      preferences: [{ key: "appearance", value: "dark" }]
    }),
    keys: STORAGE_KEYS
  });

  expect(result.restored.status).toBe("interrupted");
  expect(result.articles).toEqual([]);
  expect(result.preferencesRaw).toBeNull();
  expect(findItem(result.restored, "articles", { articleId: article.id }))
    .toMatchObject({ status: "not-attempted", written: false });
  expect(findItem(result.restored, "preferences", {
    preferenceKey: "appearance"
  })).toMatchObject({
    status: "failed",
    written: false,
    reason: "preferences-storage-read-failed"
  });
});

test("six-entity Preferences assessment failure reports migration-only Baseline separately", async ({ page }) => {
  await loadBackupEnvironment(page);
  const data = makeSixEntityData("assessment-migration", [
    { key: "appearance", value: "dark" }
  ]);
  const legacyVocab = {
    "opaque/legacy": { word: "legacy", count: 4, displayWord: "Legacy" }
  };
  const result = await page.evaluate(async ({ envelope, keys, vocab }) => {
    localStorage.removeItem(keys.preferences);
    localStorage.removeItem(keys.queryEvents);
    localStorage.removeItem(keys.historyBaselines);
    localStorage.removeItem(keys.migrationState);
    localStorage.setItem(keys.vocab, JSON.stringify(vocab));
    const originalGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key) {
      if (key === keys.preferences) {
        throw new DOMException("preferences assessment blocked", "SecurityError");
      }
      return originalGetItem.call(this, key);
    };
    try {
      const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
      return {
        restored,
        articles: await window.LingoFlowArticleLibrary.listArticles({
          includeDeleted: true
        }),
        baselines: window.LingoFlowHistoryBaselineRepository.list(),
        preferencesRaw: originalGetItem.call(localStorage, keys.preferences),
        queryRaw: originalGetItem.call(localStorage, keys.queryEvents),
        migrationRaw: originalGetItem.call(localStorage, keys.migrationState),
        vocabRaw: originalGetItem.call(localStorage, keys.vocab)
      };
    } finally {
      Storage.prototype.getItem = originalGetItem;
    }
  }, {
    envelope: makeEnvelope(data),
    keys: STORAGE_KEYS,
    vocab: legacyVocab
  });

  expect(result.restored).toMatchObject({
    status: "interrupted",
    migration: {
      status: "prepared",
      baselineWritten: true,
      backupWritesStarted: false
    },
    vocabRebuild: { status: "not-attempted" }
  });
  expect(result.articles).toEqual([]);
  expect(result.preferencesRaw).toBeNull();
  expect(result.queryRaw).toBeNull();
  expect(result.migrationRaw).toBeNull();
  expect(JSON.parse(result.vocabRaw)).toEqual(legacyVocab);
  expect(result.baselines).toHaveLength(1);
  expect(result.baselines[0].id).toMatch(/^legacy-local:v1:/);
  expect(result.baselines).not.toEqual(expect.arrayContaining(data.historyBaselines));
  expect(findItem(result.restored, "preferences", {
    preferenceKey: "appearance"
  })).toMatchObject({ status: "failed", written: false });
  expect(findItem(result.restored, "queryEvents", {
    queryEventId: data.queryEvents[0].id
  })).toMatchObject({ status: "not-attempted", written: false });
  expect(findItem(result.restored, "historyBaselines", {
    historyBaselineId: data.historyBaselines[0].id
  })).toMatchObject({ status: "not-attempted", written: false });
});

test("storage change after global assessment is safely reclassified without overwrite", async ({ page }) => {
  await loadBackupEnvironment(page);
  const article = makeArticle("article:preferences-reclassification");
  const result = await page.evaluate(async ({ envelope, key }) => {
    const originalLibrary = window.LingoFlowArticleLibrary;
    window.LingoFlowArticleLibrary = Object.freeze({
      ...originalLibrary,
      restoreArticle(record) {
        localStorage.setItem(key, JSON.stringify({ appearance: "light" }));
        return originalLibrary.restoreArticle(record);
      }
    });
    try {
      const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
      return {
        restored,
        raw: localStorage.getItem(key)
      };
    } finally {
      window.LingoFlowArticleLibrary = originalLibrary;
    }
  }, {
    envelope: makeEnvelope({
      articles: [article],
      preferences: [{ key: "appearance", value: "dark" }]
    }),
    key: STORAGE_KEYS.preferences
  });

  expect(result.restored.status).toBe("completed-with-conflicts");
  expect(findItem(result.restored, "articles", { articleId: article.id }))
    .toMatchObject({ status: "restored", written: true });
  expect(findItem(result.restored, "preferences", {
    preferenceKey: "appearance"
  })).toMatchObject({ status: "conflict", written: false });
  expect(JSON.parse(result.raw)).toEqual({ appearance: "light" });
});

test("Preferences internal CAS failure preserves earlier writes and leaves Query History not attempted", async ({ page }) => {
  await loadBackupEnvironment(page);
  const data = makeSixEntityData("cas-failure", [
    { key: "appearance", value: "dark" }
  ]);
  const result = await page.evaluate(async ({ envelope, keys, state }) => {
    localStorage.setItem(keys.migrationState, JSON.stringify(state));
    const originalGetItem = Storage.prototype.getItem;
    const originalSetItem = Storage.prototype.setItem;
    let preferenceReads = 0;
    Storage.prototype.getItem = function(key) {
      if (key === keys.preferences) {
        preferenceReads += 1;
        if (preferenceReads === 3) {
          originalSetItem.call(
            localStorage,
            keys.preferences,
            JSON.stringify({ appearance: "light" })
          );
        }
      }
      return originalGetItem.call(this, key);
    };
    try {
      const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
      return {
        restored,
        preferenceReads,
        raw: originalGetItem.call(localStorage, keys.preferences),
        articles: await window.LingoFlowArticleLibrary.listArticles({
          includeDeleted: true
        })
      };
    } finally {
      Storage.prototype.getItem = originalGetItem;
    }
  }, {
    envelope: makeEnvelope(data),
    keys: STORAGE_KEYS,
    state: COMPLETED_MIGRATION_STATE
  });

  expect(result.restored.status).toBe("interrupted");
  expect(result.preferenceReads).toBe(3);
  expect(result.articles).toEqual(data.articles);
  expect(JSON.parse(result.raw)).toEqual({ appearance: "light" });
  expect(findItem(result.restored, "preferences", {
    preferenceKey: "appearance"
  })).toMatchObject({
    status: "failed",
    written: false,
    reason: "preferences-storage-changed"
  });
  expect(findItem(result.restored, "queryEvents", {
    queryEventId: data.queryEvents[0].id
  })).toMatchObject({ status: "not-attempted", written: false });
  expect(findItem(result.restored, "historyBaselines", {
    historyBaselineId: data.historyBaselines[0].id
  })).toMatchObject({ status: "not-attempted", written: false });
});

test("Preferences setItem failure is atomic and accurately reports partial entity completion", async ({ page }) => {
  await loadBackupEnvironment(page);
  const article = makeArticle("article:preferences-write-failure");
  const result = await page.evaluate(async ({ envelope, key }) => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(storageKey, value) {
      if (storageKey === key) {
        throw new DOMException("preferences write blocked", "QuotaExceededError");
      }
      return originalSetItem.call(this, storageKey, value);
    };
    try {
      const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
      return {
        restored,
        articles: await window.LingoFlowArticleLibrary.listArticles({
          includeDeleted: true
        })
      };
    } finally {
      Storage.prototype.setItem = originalSetItem;
    }
  }, {
    envelope: makeEnvelope({
      articles: [article],
      preferences: [
        { key: "appearance", value: "dark" },
        { key: "fontSize", value: "21" }
      ]
    }),
    key: STORAGE_KEYS.preferences
  });

  expect(result.restored).toMatchObject({
    status: "interrupted",
    summary: { total: 3, restored: 1, failed: 2 }
  });
  expect(result.articles).toEqual([article]);
  for (const preferenceKey of ["appearance", "fontSize"]) {
    expect(findItem(result.restored, "preferences", { preferenceKey }))
      .toMatchObject({
        status: "failed",
        written: false,
        reason: "preferences-storage-write-failed"
      });
  }
});

test("direct Article plus Preferences restore has zero Query History side effects", async ({ page }) => {
  await loadBackupEnvironment(page);
  const result = await page.evaluate(async ({ envelope, keys }) => {
    localStorage.setItem(keys.migrationState, "migration-sentinel");
    localStorage.setItem(keys.vocab, JSON.stringify({
      sentinel: { word: "sentinel", count: 9 }
    }));
    const calls = [];
    const originals = {
      coordinator: window.LingoFlowQueryHistoryMigrationCoordinator,
      queryEvents: window.LingoFlowQueryEventRepository,
      historyBaselines: window.LingoFlowHistoryBaselineRepository,
      projector: window.LingoFlowQueryHistoryProjector,
      getItem: Storage.prototype.getItem,
      setItem: Storage.prototype.setItem,
      removeItem: Storage.prototype.removeItem
    };
    const migrationCalls = { get: 0, set: 0, remove: 0 };
    Storage.prototype.getItem = function(key) {
      if (key === keys.migrationState) migrationCalls.get += 1;
      return originals.getItem.call(this, key);
    };
    Storage.prototype.setItem = function(key, value) {
      if (key === keys.migrationState) migrationCalls.set += 1;
      return originals.setItem.call(this, key, value);
    };
    Storage.prototype.removeItem = function(key) {
      if (key === keys.migrationState) migrationCalls.remove += 1;
      return originals.removeItem.call(this, key);
    };
    const forbidden = label => () => {
      calls.push(label);
      throw new Error(`${label} must not run`);
    };
    window.LingoFlowQueryHistoryMigrationCoordinator = Object.freeze({
      prepare: forbidden("migration:prepare"),
      finalize: forbidden("migration:finalize")
    });
    window.LingoFlowQueryEventRepository = Object.freeze({
      ...originals.queryEvents,
      list: forbidden("queryEvents:list"),
      assessBackupRestore: forbidden("queryEvents:assess"),
      restoreBackupRecords: forbidden("queryEvents:restore")
    });
    window.LingoFlowHistoryBaselineRepository = Object.freeze({
      ...originals.historyBaselines,
      list: forbidden("historyBaselines:list"),
      assessBackupRestore: forbidden("historyBaselines:assess"),
      restoreBackupRecords: forbidden("historyBaselines:restore")
    });
    window.LingoFlowQueryHistoryProjector = Object.freeze({
      ...originals.projector,
      project: forbidden("project:vocab")
    });
    try {
      const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
      return {
        restored,
        calls,
        migrationCalls,
        migrationRaw: originals.getItem.call(localStorage, keys.migrationState),
        vocabRaw: originals.getItem.call(localStorage, keys.vocab)
      };
    } finally {
      Storage.prototype.getItem = originals.getItem;
      Storage.prototype.setItem = originals.setItem;
      Storage.prototype.removeItem = originals.removeItem;
      window.LingoFlowQueryHistoryMigrationCoordinator = originals.coordinator;
      window.LingoFlowQueryEventRepository = originals.queryEvents;
      window.LingoFlowHistoryBaselineRepository = originals.historyBaselines;
      window.LingoFlowQueryHistoryProjector = originals.projector;
    }
  }, {
    envelope: makeEnvelope({
      articles: [],
      preferences: [{ key: "appearance", value: "dark" }]
    }),
    keys: STORAGE_KEYS
  });

  expect(result.restored).toMatchObject({
    status: "completed",
    summary: { total: 1, restored: 1 }
  });
  expect(result.restored).not.toHaveProperty("migration");
  expect(result.restored).not.toHaveProperty("vocabRebuild");
  expect(result.calls).toEqual([]);
  expect(result.migrationCalls).toEqual({ get: 0, set: 0, remove: 0 });
  expect(result.migrationRaw).toBe("migration-sentinel");
  expect(JSON.parse(result.vocabRaw)).toEqual({
    sentinel: { word: "sentinel", count: 9 }
  });
});

test("existing five-entity Envelope never accesses Preferences dependencies", async ({ page }) => {
  await loadBackupEnvironment(page);
  const result = await page.evaluate(async ({ envelope, key, state }) => {
    localStorage.setItem(key, JSON.stringify(state));
    const originals = {
      repository: window.LingoFlowPreferencesRepository,
      schema: window.LingoFlowPreferencesBackupSchema
    };
    let accesses = 0;
    Object.defineProperty(window, "LingoFlowPreferencesRepository", {
      configurable: true,
      get() {
        accesses += 1;
        throw new Error("Preferences Repository must not be accessed");
      }
    });
    Object.defineProperty(window, "LingoFlowPreferencesBackupSchema", {
      configurable: true,
      get() {
        accesses += 1;
        throw new Error("Preferences Schema must not be accessed");
      }
    });
    try {
      const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
      return { restored, accesses };
    } finally {
      Object.defineProperty(window, "LingoFlowPreferencesRepository", {
        configurable: true,
        writable: true,
        value: originals.repository
      });
      Object.defineProperty(window, "LingoFlowPreferencesBackupSchema", {
        configurable: true,
        writable: true,
        value: originals.schema
      });
    }
  }, {
    envelope: makeEnvelope({
      articles: [],
      favorites: [],
      favoriteLearningStates: [],
      queryEvents: [],
      historyBaselines: []
    }),
    key: STORAGE_KEYS.migrationState,
    state: COMPLETED_MIGRATION_STATE
  });

  expect(result.restored.status).toBe("completed");
  expect(result.accesses).toBe(0);
});

test("Preferences conflict does not block declared Query History restore or Vocab rebuild", async ({ page }) => {
  await loadBackupEnvironment(page);
  const event = makeQueryEvent("query:preferences-conflict");
  const result = await page.evaluate(async ({ envelope, keys, state }) => {
    localStorage.setItem(keys.migrationState, JSON.stringify(state));
    localStorage.setItem(keys.vocab, JSON.stringify({
      stale: { word: "stale", count: 99 }
    }));
    window.LingoFlowPreferencesRepository.restoreBackupItems([
      { key: "appearance", value: "light" }
    ]);
    const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
    return {
      restored,
      appearance: window.LingoFlowPreferencesRepository.get("appearance"),
      events: window.LingoFlowQueryEventRepository.list(),
      vocab: JSON.parse(localStorage.getItem(keys.vocab))
    };
  }, {
    envelope: makeEnvelope({
      articles: [],
      favorites: [],
      favoriteLearningStates: [],
      preferences: [{ key: "appearance", value: "dark" }],
      queryEvents: [event],
      historyBaselines: []
    }),
    keys: STORAGE_KEYS,
    state: COMPLETED_MIGRATION_STATE
  });

  expect(result.restored).toMatchObject({
    status: "completed-with-conflicts",
    migration: { status: "completed" },
    vocabRebuild: { status: "rebuilt" }
  });
  expect(findItem(result.restored, "preferences", {
    preferenceKey: "appearance"
  })).toMatchObject({ status: "conflict", written: false });
  expect(findItem(result.restored, "queryEvents", {
    queryEventId: event.id
  })).toMatchObject({ status: "restored", written: true });
  expect(result.appearance).toMatchObject({ status: "found", value: "light" });
  expect(result.events).toEqual([event]);
  expect(result.vocab).toEqual(expect.objectContaining({
    apple: expect.objectContaining({ word: "apple", count: 1 })
  }));
  expect(result.vocab).not.toHaveProperty("stale");
});
