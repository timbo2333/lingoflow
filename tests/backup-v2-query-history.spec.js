const { test, expect } = require("@playwright/test");

const STORAGE_KEYS = Object.freeze({
  queryEvents: "EnglishReaderV052QueryEvents",
  historyBaselines: "EnglishReaderV052HistoryBaselines",
  migrationState: "EnglishReaderV052HistoryMigrationState",
  vocab: "EnglishReaderV05Vocab",
  favorites: "LingoFlowFavoriteEntities"
});
const LEARNING_PREFIX = "LingoFlowFavoriteLearningState:";
const COMPLETED_MIGRATION_STATE = { version: 1, status: "completed" };

function makeArticle(id, overrides = {}) {
  return {
    id,
    title: `Query History article ${id}`,
    content: `Restorable Query History article content for ${id}.`,
    sourceType: "paste",
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T01:00:00.000Z",
    lastReadAt: "2026-08-29T02:00:00.000Z",
    deletedAt: null,
    reading: {
      progress: 0.5,
      paragraphIndex: 1,
      updatedAt: "2026-08-29T02:00:00.000Z"
    },
    ...overrides
  };
}

function makeFavorite(id, overrides = {}) {
  return {
    id,
    type: "word",
    text: `favorite ${id}`,
    createdAt: "2026-08-29T03:00:00.000Z",
    updatedAt: "2026-08-29T04:00:00.000Z",
    deletedAt: null,
    ...overrides
  };
}

function makeLearningState(favoriteId, mastered, overrides = {}) {
  return {
    favoriteId,
    mastered,
    createdAt: "2026-08-29T05:00:00.000Z",
    updatedAt: "2026-08-29T06:00:00.000Z",
    deletedAt: null,
    ...overrides
  };
}

function makeQueryEvent(id, overrides = {}) {
  return {
    id,
    deviceId: "device:backup-source",
    word: "apple",
    displayWord: "Apple",
    phonetic: "/ˈæpəl/",
    pos: "noun",
    meaning: "苹果",
    dictionaryFound: true,
    source: "article",
    timestamp: "2026-08-29T07:00:00.000Z",
    ...overrides
  };
}

function makeHistoryBaseline(id, overrides = {}) {
  return {
    id,
    createdAt: "2026-08-20T00:00:00.000Z",
    deviceId: "device:legacy-source",
    records: {
      lemma: {
        word: "apple",
        count: 2,
        articleCount: 1,
        firstSeen: "2020-01-01T00:00:00.000Z",
        lastSeen: "2020-01-02T00:00:00.000Z",
        displayWord: "Legacy Apple",
        futureCompatibilityFact: { version: 1 }
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

function makeFiveEntityData(prefix) {
  const favorite = makeFavorite(`favorite:${prefix}`, { text: "apple" });
  return {
    articles: [makeArticle(`article:${prefix}`)],
    favorites: [favorite],
    favoriteLearningStates: [makeLearningState(favorite.id, false)],
    queryEvents: [makeQueryEvent(`query:${prefix}`)],
    historyBaselines: [makeHistoryBaseline(`baseline:${prefix}`, {
      records: {
        [`opaque/${prefix}`]: { word: "apple", count: 2 }
      }
    })]
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
    window.LingoFlowQueryEventRepository &&
    window.LingoFlowHistoryBaselineRepository &&
    window.LingoFlowQueryHistoryMigrationCoordinator &&
    window.LingoFlowQueryHistoryProjector
  ));
  await resetPersonalData(page);
}

async function resetPersonalData(page) {
  await page.evaluate(({ keys, learningPrefix }) => {
    for (const key of Object.values(keys)) localStorage.removeItem(key);
    localStorage.removeItem("EnglishReaderV051Favorites");
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key && key.startsWith(learningPrefix)) localStorage.removeItem(key);
    }
  }, { keys: STORAGE_KEYS, learningPrefix: LEARNING_PREFIX });
}

function findItem(result, entity, identity) {
  return result.items.find(item => (
    item.entity === entity && Object.entries(identity).every(([key, value]) => (
      item[key] === value
    ))
  ));
}

test("five-entity roundtrip preserves Query History facts and rebuilds Vocab", async ({ browser }) => {
  const article = makeArticle("article:five-entity");
  const activeFavorite = makeFavorite("favorite:active", { text: "apple" });
  const deletedFavorite = makeFavorite("favorite:deleted", {
    type: "phrase",
    text: "an apple a day",
    updatedAt: "2026-08-29T04:30:00.000Z",
    deletedAt: "2026-08-29T04:30:00.000Z"
  });
  const learningStates = [
    makeLearningState(activeFavorite.id, false),
    makeLearningState(deletedFavorite.id, true)
  ];
  const events = [
    makeQueryEvent("query:apple", {
      futureEventFact: { provider: "future-dictionary", confidence: 0.9 }
    }),
    makeQueryEvent("query:no-vocab-key", {
      word: "",
      displayWord: "中文",
      phonetic: "",
      pos: "",
      meaning: "",
      dictionaryFound: false,
      source: "search",
      timestamp: "2026-08-29T08:00:00.000Z"
    })
  ];
  const baseline = makeHistoryBaseline("baseline:opaque-locator");

  const exportContext = await browser.newContext();
  let payload;
  try {
    const page = await exportContext.newPage();
    await loadBackupEnvironment(page);
    const exported = await page.evaluate(async input => {
      await window.LingoFlowArticleLibrary.restoreArticle(input.article);
      window.LingoFlowFavoriteRepository.restoreBackupRecords(input.favorites);
      window.LingoFlowFavoriteLearningRepository.restoreBackupRecords(input.learning);
      window.LingoFlowQueryEventRepository.restoreBackupRecords(input.events);
      window.LingoFlowHistoryBaselineRepository.restoreBackupRecords([input.baseline]);
      return window.LingoFlowBackupV2Export.exportBackup();
    }, {
      article,
      favorites: [activeFavorite, deletedFavorite],
      learning: learningStates,
      events,
      baseline
    });

    expect(exported.status).toBe("ready");
    expect(exported.payload.schema).toEqual({
      articles: "1",
      favorites: "1",
      favoriteLearningStates: "1",
      queryEvents: "1",
      historyBaselines: "1",
      preferences: "1"
    });
    expect(Object.keys(exported.payload.data)).toEqual([
      "articles",
      "favorites",
      "favoriteLearningStates",
      "queryEvents",
      "historyBaselines",
      "preferences"
    ]);
    expect(exported.payload.data.preferences).toEqual([]);
    expect(exported.payload.data).not.toHaveProperty("vocab");
    expect(exported.payload.data).not.toHaveProperty("migrationState");
    payload = exported.payload;
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
        articles: await window.LingoFlowArticleLibrary.listArticles({ includeDeleted: true }),
        favorites: window.LingoFlowFavoriteRepository.list({ includeDeleted: true }),
        learning: window.LingoFlowFavoriteLearningRepository.list({ includeDeleted: true }),
        events: window.LingoFlowQueryEventRepository.list(),
        baselines: window.LingoFlowHistoryBaselineRepository.list(),
        migrationState: JSON.parse(localStorage.getItem(
          "EnglishReaderV052HistoryMigrationState"
        )),
        vocab: JSON.parse(localStorage.getItem("EnglishReaderV05Vocab"))
      };
    }, payload);

    expect(outcome.result).toMatchObject({
      status: "completed",
      summary: { total: 8, restored: 8, conflicts: 0, failed: 0 },
      migration: { status: "completed", backupWritesStarted: true },
      vocabRebuild: { status: "rebuilt" }
    });
    expect(outcome.articles).toEqual([article]);
    expect(outcome.favorites).toEqual(expect.arrayContaining([activeFavorite, deletedFavorite]));
    expect(outcome.learning).toEqual(expect.arrayContaining(learningStates));
    expect(outcome.events).toEqual(expect.arrayContaining(events));
    expect(outcome.baselines).toEqual([baseline]);
    expect(outcome.baselines[0].records.lemma.word).toBe("apple");
    expect(outcome.events.find(item => item.id === "query:apple").futureEventFact)
      .toEqual(events[0].futureEventFact);
    expect(outcome.migrationState).toEqual(COMPLETED_MIGRATION_STATE);
    expect(outcome.vocab.apple).toMatchObject({
      word: "apple",
      count: 3,
      articleCount: 2,
      firstSeen: "2020-01-01T00:00:00.000Z",
      lastSeen: events[0].timestamp
    });
    expect(outcome.vocab).not.toHaveProperty("");
    expect(outcome.vocab.apple).not.toHaveProperty("futureEventFact");
    expect(outcome.vocab.apple).not.toHaveProperty("futureCompatibilityFact");
  } finally {
    await restoreContext.close();
  }
});

test("Article-only restore does not touch Query History migration or rebuild", async ({ page }) => {
  await loadBackupEnvironment(page);
  const article = makeArticle("article:only");
  const result = await page.evaluate(async ({ envelope, keys }) => {
    const original = window.LingoFlowQueryHistoryMigrationCoordinator;
    let calls = 0;
    window.LingoFlowQueryHistoryMigrationCoordinator = Object.freeze({
      prepare() {
        calls += 1;
        throw new Error("must not run");
      },
      finalize() {
        calls += 1;
        throw new Error("must not run");
      }
    });
    try {
      const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
      return {
        restored,
        calls,
        migrationRaw: localStorage.getItem(keys.migrationState),
        vocabRaw: localStorage.getItem(keys.vocab)
      };
    } finally {
      window.LingoFlowQueryHistoryMigrationCoordinator = original;
    }
  }, { envelope: makeEnvelope({ articles: [article] }), keys: STORAGE_KEYS });

  expect(result.restored.status).toBe("completed");
  expect(result.restored).not.toHaveProperty("migration");
  expect(result.restored).not.toHaveProperty("vocabRebuild");
  expect(result.calls).toBe(0);
  expect(result.migrationRaw).toBeNull();
  expect(result.vocabRaw).toBeNull();
});

for (const entity of ["queryEvents", "historyBaselines"]) {
  test(`declared empty ${entity} still closes migration boundary and rebuilds`, async ({ page }) => {
    await loadBackupEnvironment(page);
    const data = { articles: [], [entity]: [] };
    const result = await page.evaluate(async ({ envelope, keys }) => {
      const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
      return {
        restored,
        migrationState: JSON.parse(localStorage.getItem(keys.migrationState)),
        vocab: JSON.parse(localStorage.getItem(keys.vocab))
      };
    }, { envelope: makeEnvelope(data), keys: STORAGE_KEYS });

    expect(result.restored).toMatchObject({
      status: "completed",
      migration: {
        status: "completed",
        migrationStateWritten: true,
        backupWritesStarted: false
      },
      vocabRebuild: { status: "rebuilt", vocabCount: 0 }
    });
    expect(result.migrationState).toEqual(COMPLETED_MIGRATION_STATE);
    expect(result.vocab).toEqual({});
  });
}

test("invalid QueryEvent and Baseline schemas reject before migration with zero writes", async ({ page }) => {
  await loadBackupEnvironment(page);
  const invalidCases = [
    {
      entity: "queryEvents",
      record: makeQueryEvent("query:invalid", { dictionaryFound: "yes" })
    },
    {
      entity: "historyBaselines",
      record: makeHistoryBaseline("baseline:invalid", {
        records: { locator: { word: "apple", count: 0 } }
      })
    }
  ];
  const outcomes = await page.evaluate(async ({ cases, keys }) => {
    const results = [];
    for (const candidate of cases) {
      for (const key of Object.values(keys)) localStorage.removeItem(key);
      const data = { articles: [], [candidate.entity]: [candidate.record] };
      const envelope = {
        format: { name: "LingoFlow Backup", version: 2 },
        metadata: {},
        schema: Object.fromEntries(Object.keys(data).map(entity => [entity, "1"])),
        data
      };
      const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
      results.push({
        entity: candidate.entity,
        restored,
        migrationRaw: localStorage.getItem(keys.migrationState),
        queryRaw: localStorage.getItem(keys.queryEvents),
        baselineRaw: localStorage.getItem(keys.historyBaselines)
      });
    }
    return results;
  }, { cases: invalidCases, keys: STORAGE_KEYS });

  for (const outcome of outcomes) {
    expect(outcome.restored.status).toBe("rejected");
    expect(outcome.restored.migration.status).toBe("not-attempted");
    expect(outcome.restored.vocabRebuild.status).toBe("not-attempted");
    expect(outcome.migrationRaw).toBeNull();
    expect(outcome.queryRaw).toBeNull();
    expect(outcome.baselineRaw).toBeNull();
  }
});

test("unresolved Favorite Learning relation rejects before Query History migration", async ({ page }) => {
  await loadBackupEnvironment(page);
  const state = makeLearningState("favorite:missing", false);
  const result = await page.evaluate(async ({ envelope, keys }) => {
    const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
    return {
      restored,
      migrationRaw: localStorage.getItem(keys.migrationState),
      queryRaw: localStorage.getItem(keys.queryEvents)
    };
  }, {
    envelope: makeEnvelope({
      articles: [],
      favoriteLearningStates: [state],
      queryEvents: []
    }),
    keys: STORAGE_KEYS
  });

  expect(result.restored.status).toBe("rejected");
  expect(result.restored.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "unresolved-favorite-reference" })
  ]));
  expect(result.restored.migration.status).toBe("not-attempted");
  expect(result.migrationRaw).toBeNull();
  expect(result.queryRaw).toBeNull();
});

test("malformed migration state interrupts restore and preserves QueryEvent identity", async ({ page }) => {
  await loadBackupEnvironment(page);
  const event = makeQueryEvent("query:migration-blocked");
  const result = await page.evaluate(async ({ envelope, keys }) => {
    localStorage.setItem(keys.migrationState, "{malformed");
    const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
    return {
      restored,
      migrationRaw: localStorage.getItem(keys.migrationState),
      queryRaw: localStorage.getItem(keys.queryEvents)
    };
  }, {
    envelope: makeEnvelope({ articles: [], queryEvents: [event] }),
    keys: STORAGE_KEYS
  });

  expect(result.restored).toMatchObject({
    status: "interrupted",
    migration: {
      status: "failed",
      reason: "history-migration-state-malformed",
      backupWritesStarted: false
    },
    vocabRebuild: { status: "not-attempted" }
  });
  expect(findItem(result.restored, "queryEvents", { queryEventId: event.id }))
    .toMatchObject({ status: "not-attempted", written: false });
  expect(result.migrationRaw).toBe("{malformed");
  expect(result.queryRaw).toBeNull();
});

test("migration state write failure reports local Baseline side effect but blocks backup facts", async ({ page }) => {
  await loadBackupEnvironment(page);
  const event = makeQueryEvent("query:blocked-by-state-write");
  const legacyVocab = {
    "opaque/legacy": { word: "legacy", count: 2 }
  };
  const result = await page.evaluate(async ({ envelope, keys, vocab }) => {
    localStorage.setItem(keys.vocab, JSON.stringify(vocab));
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === keys.migrationState) {
        throw new DOMException("state write blocked", "QuotaExceededError");
      }
      return originalSetItem.call(this, key, value);
    };
    try {
      const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
      return {
        restored,
        queryRaw: localStorage.getItem(keys.queryEvents),
        baselines: window.LingoFlowHistoryBaselineRepository.list(),
        migrationRaw: localStorage.getItem(keys.migrationState)
      };
    } finally {
      Storage.prototype.setItem = originalSetItem;
    }
  }, {
    envelope: makeEnvelope({ articles: [], queryEvents: [event] }),
    keys: STORAGE_KEYS,
    vocab: legacyVocab
  });

  expect(result.restored.status).toBe("interrupted");
  expect(result.restored.migration).toMatchObject({
    status: "failed",
    reason: "history-migration-state-storage-write-failed",
    baselineWritten: true,
    backupWritesStarted: false
  });
  expect(findItem(result.restored, "queryEvents", { queryEventId: event.id }))
    .toMatchObject({ status: "not-attempted", written: false });
  expect(result.queryRaw).toBeNull();
  expect(result.baselines).toHaveLength(1);
  expect(result.baselines[0].records["opaque/legacy"]).toEqual({
    word: "legacy",
    count: 2
  });
  expect(result.migrationRaw).toBeNull();
});

test("QueryEvent restore distinguishes restorable, unchanged, and conflict with stable identities", async ({ page }) => {
  await loadBackupEnvironment(page);
  const restorable = makeQueryEvent("query:restorable");
  const unchanged = makeQueryEvent("query:unchanged", {
    source: "search",
    timestamp: "2026-08-29T07:01:00.000Z"
  });
  const localConflict = makeQueryEvent("query:conflict", {
    word: "pear",
    displayWord: "Pear",
    meaning: "梨",
    timestamp: "2026-08-29T07:02:00.000Z"
  });
  const incomingConflict = { ...localConflict, meaning: "different snapshot" };
  const result = await page.evaluate(async ({ envelope, local, keys, state }) => {
    localStorage.setItem(keys.migrationState, JSON.stringify(state));
    window.LingoFlowQueryEventRepository.restoreBackupRecords(local);
    const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
    return {
      restored,
      events: window.LingoFlowQueryEventRepository.list(),
      vocab: JSON.parse(localStorage.getItem(keys.vocab))
    };
  }, {
    envelope: makeEnvelope({
      articles: [],
      queryEvents: [restorable, unchanged, incomingConflict]
    }),
    local: [unchanged, localConflict],
    keys: STORAGE_KEYS,
    state: COMPLETED_MIGRATION_STATE
  });

  expect(result.restored.status).toBe("completed-with-conflicts");
  expect(findItem(result.restored, "queryEvents", { queryEventId: restorable.id }))
    .toMatchObject({ status: "restored", written: true });
  expect(findItem(result.restored, "queryEvents", { queryEventId: unchanged.id }))
    .toMatchObject({ status: "unchanged", written: false });
  expect(findItem(result.restored, "queryEvents", { queryEventId: localConflict.id }))
    .toMatchObject({ status: "conflict", written: false });
  expect(result.events.find(item => item.id === localConflict.id)).toEqual(localConflict);
  expect(result.restored.vocabRebuild.status).toBe("rebuilt");
  expect(result.vocab.apple.count).toBe(2);
  expect(result.vocab.pear.count).toBe(1);
});

test("History Baseline restore preserves opaque locator and reports all three domain outcomes", async ({ page }) => {
  await loadBackupEnvironment(page);
  const restorable = makeHistoryBaseline("baseline:restorable", {
    records: { syncStatus: { word: "banana", count: 2 } }
  });
  const unchanged = makeHistoryBaseline("baseline:unchanged", {
    records: { count: { word: "cherry", count: 3 } }
  });
  const localConflict = makeHistoryBaseline("baseline:conflict", {
    records: { vocab: { word: "date", count: 4 } }
  });
  const incomingConflict = {
    ...localConflict,
    records: { vocab: { word: "date", count: 5 } }
  };
  const result = await page.evaluate(async ({ envelope, local, keys, state }) => {
    localStorage.setItem(keys.migrationState, JSON.stringify(state));
    window.LingoFlowHistoryBaselineRepository.restoreBackupRecords(local);
    const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
    return {
      restored,
      baselines: window.LingoFlowHistoryBaselineRepository.list(),
      vocab: JSON.parse(localStorage.getItem(keys.vocab))
    };
  }, {
    envelope: makeEnvelope({
      articles: [],
      historyBaselines: [restorable, unchanged, incomingConflict]
    }),
    local: [unchanged, localConflict],
    keys: STORAGE_KEYS,
    state: COMPLETED_MIGRATION_STATE
  });

  expect(result.restored.status).toBe("completed-with-conflicts");
  expect(findItem(result.restored, "historyBaselines", {
    historyBaselineId: restorable.id
  })).toMatchObject({ status: "restored", written: true });
  expect(findItem(result.restored, "historyBaselines", {
    historyBaselineId: unchanged.id
  })).toMatchObject({ status: "unchanged", written: false });
  expect(findItem(result.restored, "historyBaselines", {
    historyBaselineId: localConflict.id
  })).toMatchObject({ status: "conflict", written: false });
  expect(result.baselines.find(item => item.id === restorable.id).records.syncStatus)
    .toEqual({ word: "banana", count: 2 });
  expect(result.baselines.find(item => item.id === localConflict.id)).toEqual(localConflict);
  expect(result.restored.vocabRebuild.status).toBe("rebuilt");
  expect(result.vocab).toMatchObject({
    banana: { count: 2 },
    cherry: { count: 3 },
    date: { count: 4 }
  });
});

test("QueryEvent write remains restored when History Baseline restore interrupts", async ({ page }) => {
  await loadBackupEnvironment(page);
  const event = makeQueryEvent("query:before-baseline-failure");
  const baseline = makeHistoryBaseline("baseline:failure");
  const result = await page.evaluate(async ({ envelope, keys, state }) => {
    localStorage.setItem(keys.migrationState, JSON.stringify(state));
    const original = window.LingoFlowHistoryBaselineRepository;
    window.LingoFlowHistoryBaselineRepository = Object.freeze({
      ...original,
      restoreBackupRecords() {
        throw new Error("baseline write failed");
      }
    });
    try {
      const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
      return {
        restored,
        event: window.LingoFlowQueryEventRepository.get("query:before-baseline-failure"),
        baseline: original.get("baseline:failure"),
        vocab: JSON.parse(localStorage.getItem(keys.vocab))
      };
    } finally {
      window.LingoFlowHistoryBaselineRepository = original;
    }
  }, {
    envelope: makeEnvelope({
      articles: [],
      queryEvents: [event],
      historyBaselines: [baseline]
    }),
    keys: STORAGE_KEYS,
    state: COMPLETED_MIGRATION_STATE
  });

  expect(result.restored.status).toBe("interrupted");
  expect(findItem(result.restored, "queryEvents", { queryEventId: event.id }))
    .toMatchObject({ status: "restored", written: true });
  expect(findItem(result.restored, "historyBaselines", {
    historyBaselineId: baseline.id
  })).toMatchObject({ status: "failed", written: false });
  expect(result.event).toEqual(event);
  expect(result.baseline).toBeNull();
  expect(result.restored.vocabRebuild.status).toBe("rebuilt");
  expect(result.vocab.apple.count).toBe(1);
});

test("strict Query History read failure preserves old Vocab without rolling back facts", async ({ page }) => {
  await loadBackupEnvironment(page);
  const event = makeQueryEvent("query:derived-read-failure");
  const oldVocab = { old: { word: "old", count: 9 } };
  const result = await page.evaluate(async ({ envelope, keys, state, old }) => {
    localStorage.setItem(keys.migrationState, JSON.stringify(state));
    localStorage.setItem(keys.vocab, JSON.stringify(old));
    const original = window.LingoFlowQueryEventRepository;
    let listCalls = 0;
    window.LingoFlowQueryEventRepository = Object.freeze({
      ...original,
      list() {
        listCalls += 1;
        if (listCalls === 2) {
          const error = new Error("strict read failed");
          error.code = "query-event-storage-read-failed";
          throw error;
        }
        return original.list();
      }
    });
    try {
      const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
      return {
        restored,
        event: original.get("query:derived-read-failure"),
        vocab: JSON.parse(localStorage.getItem(keys.vocab)),
        listCalls
      };
    } finally {
      window.LingoFlowQueryEventRepository = original;
    }
  }, {
    envelope: makeEnvelope({ articles: [], queryEvents: [event] }),
    keys: STORAGE_KEYS,
    state: COMPLETED_MIGRATION_STATE,
    old: oldVocab
  });

  expect(result.restored.status).toBe("completed-with-derived-view-failure");
  expect(result.restored.vocabRebuild).toMatchObject({
    status: "failed",
    reason: "query-event-storage-read-failed"
  });
  expect(result.event).toEqual(event);
  expect(result.vocab).toEqual(oldVocab);
  expect(result.listCalls).toBe(2);
});

test("Projector failure preserves old Vocab and reports a derived-view failure", async ({ page }) => {
  await loadBackupEnvironment(page);
  const event = makeQueryEvent("query:projector-failure");
  const oldVocab = { old: { word: "old", count: 7 } };
  const result = await page.evaluate(async ({ envelope, keys, state, old }) => {
    localStorage.setItem(keys.migrationState, JSON.stringify(state));
    localStorage.setItem(keys.vocab, JSON.stringify(old));
    const original = window.LingoFlowQueryHistoryProjector;
    window.LingoFlowQueryHistoryProjector = Object.freeze({
      project() {
        const error = new Error("projector failed");
        error.code = "query-history-projector-failed";
        throw error;
      }
    });
    try {
      const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
      return {
        restored,
        event: window.LingoFlowQueryEventRepository.get("query:projector-failure"),
        vocab: JSON.parse(localStorage.getItem(keys.vocab))
      };
    } finally {
      window.LingoFlowQueryHistoryProjector = original;
    }
  }, {
    envelope: makeEnvelope({ articles: [], queryEvents: [event] }),
    keys: STORAGE_KEYS,
    state: COMPLETED_MIGRATION_STATE,
    old: oldVocab
  });

  expect(result.restored.status).toBe("completed-with-derived-view-failure");
  expect(result.restored.vocabRebuild).toMatchObject({
    status: "failed",
    reason: "query-history-projector-failed"
  });
  expect(result.event).toEqual(event);
  expect(result.vocab).toEqual(oldVocab);
});

test("Vocab persistence failure does not roll back restored Query History facts", async ({ page }) => {
  await loadBackupEnvironment(page);
  const event = makeQueryEvent("query:vocab-write-failure");
  const oldVocab = { old: { word: "old", count: 5 } };
  const result = await page.evaluate(async ({ envelope, keys, state, old }) => {
    localStorage.setItem(keys.migrationState, JSON.stringify(state));
    localStorage.setItem(keys.vocab, JSON.stringify(old));
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === keys.vocab) {
        throw new DOMException("vocab write blocked", "QuotaExceededError");
      }
      return originalSetItem.call(this, key, value);
    };
    try {
      const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
      return {
        restored,
        event: window.LingoFlowQueryEventRepository.get("query:vocab-write-failure"),
        vocab: JSON.parse(localStorage.getItem(keys.vocab))
      };
    } finally {
      Storage.prototype.setItem = originalSetItem;
    }
  }, {
    envelope: makeEnvelope({ articles: [], queryEvents: [event] }),
    keys: STORAGE_KEYS,
    state: COMPLETED_MIGRATION_STATE,
    old: oldVocab
  });

  expect(result.restored.status).toBe("completed-with-derived-view-failure");
  expect(result.restored.vocabRebuild.status).toBe("failed");
  expect(result.event).toEqual(event);
  expect(result.vocab).toEqual(oldVocab);
});

test("retry is idempotent and rebuilds the same derived Vocab", async ({ page }) => {
  await loadBackupEnvironment(page);
  const event = makeQueryEvent("query:retry");
  const baseline = makeHistoryBaseline("baseline:retry", {
    records: { "opaque/retry": { word: "apple", count: 4 } }
  });
  const result = await page.evaluate(async ({ envelope, keys }) => {
    const first = await window.LingoFlowBackupV2.restoreBackup(envelope);
    const firstVocab = JSON.parse(localStorage.getItem(keys.vocab));
    const second = await window.LingoFlowBackupV2.restoreBackup(envelope);
    return {
      first,
      second,
      firstVocab,
      secondVocab: JSON.parse(localStorage.getItem(keys.vocab)),
      events: window.LingoFlowQueryEventRepository.list(),
      baselines: window.LingoFlowHistoryBaselineRepository.list()
    };
  }, {
    envelope: makeEnvelope({
      articles: [],
      queryEvents: [event],
      historyBaselines: [baseline]
    }),
    keys: STORAGE_KEYS
  });

  expect(result.first).toMatchObject({
    status: "completed",
    summary: { restored: 2, unchanged: 0 },
    migration: { status: "completed" },
    vocabRebuild: { status: "rebuilt" }
  });
  expect(result.second).toMatchObject({
    status: "completed",
    summary: { restored: 0, unchanged: 2 },
    migration: { status: "completed", outcome: "already-completed" },
    vocabRebuild: { status: "rebuilt" }
  });
  expect(result.events).toEqual([event]);
  expect(result.baselines).toEqual([baseline]);
  expect(result.firstVocab).toEqual(result.secondVocab);
  expect(result.secondVocab.apple.count).toBe(5);
});

test("restore uses its initial Envelope snapshot even when caller mutates input asynchronously", async ({ page }) => {
  await loadBackupEnvironment(page);
  const event = makeQueryEvent("query:stable-input-snapshot", {
    futureEventFact: { label: "original" }
  });
  const result = await page.evaluate(async ({ incoming, keys, state }) => {
    localStorage.setItem(keys.migrationState, JSON.stringify(state));
    const promise = window.LingoFlowBackupV2.restoreBackup(incoming);
    incoming.data.queryEvents[0].word = "mutated";
    incoming.data.queryEvents[0].displayWord = "Mutated";
    incoming.data.queryEvents[0].futureEventFact.label = "mutated";
    incoming.data.queryEvents.push({ ...incoming.data.queryEvents[0], id: "query:late" });
    const restored = await promise;
    return {
      restored,
      events: window.LingoFlowQueryEventRepository.list()
    };
  }, {
    incoming: makeEnvelope({ articles: [], queryEvents: [event] }),
    keys: STORAGE_KEYS,
    state: COMPLETED_MIGRATION_STATE
  });

  expect(result.restored).toMatchObject({
    status: "completed",
    summary: { total: 1, restored: 1 }
  });
  expect(result.events).toEqual([event]);
});

test("restore rejects top-level and nested accessors without executing getters", async ({ page }) => {
  await loadBackupEnvironment(page);
  const result = await page.evaluate(async keys => {
    let topLevelGetterCalls = 0;
    const topLevel = {
      format: { name: "LingoFlow Backup", version: 2 },
      metadata: {},
      schema: { articles: "1", queryEvents: "1" }
    };
    Object.defineProperty(topLevel, "data", {
      enumerable: true,
      get() {
        topLevelGetterCalls += 1;
        return { articles: [], queryEvents: [] };
      }
    });

    let nestedGetterCalls = 0;
    const event = {
      id: "query:getter",
      deviceId: "device:getter",
      word: "apple",
      displayWord: "Apple",
      phonetic: "",
      pos: "",
      meaning: "",
      dictionaryFound: false,
      source: "search",
      timestamp: "2026-08-29T07:00:00.000Z"
    };
    Object.defineProperty(event, "futureEventFact", {
      enumerable: true,
      get() {
        nestedGetterCalls += 1;
        return { unsafe: true };
      }
    });
    const nested = {
      format: { name: "LingoFlow Backup", version: 2 },
      metadata: {},
      schema: { articles: "1", queryEvents: "1" },
      data: { articles: [], queryEvents: [event] }
    };

    const topLevelResult = await window.LingoFlowBackupV2.restoreBackup(topLevel);
    const nestedResult = await window.LingoFlowBackupV2.restoreBackup(nested);
    return {
      topLevelResult,
      nestedResult,
      topLevelGetterCalls,
      nestedGetterCalls,
      migrationRaw: localStorage.getItem(keys.migrationState),
      queryRaw: localStorage.getItem(keys.queryEvents)
    };
  }, STORAGE_KEYS);

  expect(result.topLevelResult.status).toBe("rejected");
  expect(result.nestedResult.status).toBe("rejected");
  expect(result.topLevelResult.errors[0].code).toBe("backup-envelope-snapshot-failed");
  expect(result.nestedResult.errors[0].code).toBe("backup-envelope-snapshot-failed");
  expect(result.topLevelGetterCalls).toBe(0);
  expect(result.nestedGetterCalls).toBe(0);
  expect(result.migrationRaw).toBeNull();
  expect(result.queryRaw).toBeNull();
});

test("retry after legacy migration keeps one local Baseline and never reports it as a backup item", async ({ page }) => {
  await loadBackupEnvironment(page);
  const event = makeQueryEvent("query:legacy-migration-retry", {
    word: "modern",
    displayWord: "Modern"
  });
  const legacyVocab = {
    "opaque/legacy-only": {
      word: "legacy",
      count: 4,
      displayWord: "Legacy"
    }
  };
  const result = await page.evaluate(async ({ envelope, keys, vocab }) => {
    localStorage.setItem(keys.vocab, JSON.stringify(vocab));
    const first = await window.LingoFlowBackupV2.restoreBackup(envelope);
    const firstBaselines = window.LingoFlowHistoryBaselineRepository.list();
    const second = await window.LingoFlowBackupV2.restoreBackup(envelope);
    return {
      first,
      second,
      firstBaselines,
      secondBaselines: window.LingoFlowHistoryBaselineRepository.list(),
      events: window.LingoFlowQueryEventRepository.list(),
      vocab: JSON.parse(localStorage.getItem(keys.vocab))
    };
  }, {
    envelope: makeEnvelope({ articles: [], queryEvents: [event] }),
    keys: STORAGE_KEYS,
    vocab: legacyVocab
  });

  expect(result.first).toMatchObject({
    status: "completed",
    migration: { status: "completed", baselineWritten: true },
    vocabRebuild: { status: "rebuilt" }
  });
  expect(result.first.items.filter(item => item.entity === "historyBaselines"))
    .toEqual([]);
  expect(result.second).toMatchObject({
    status: "completed",
    migration: {
      status: "completed",
      outcome: "already-completed",
      baselineWritten: false
    },
    vocabRebuild: { status: "rebuilt" }
  });
  expect(result.second.items.filter(item => item.entity === "historyBaselines"))
    .toEqual([]);
  expect(result.firstBaselines).toHaveLength(1);
  expect(result.secondBaselines).toEqual(result.firstBaselines);
  expect(result.firstBaselines[0].records["opaque/legacy-only"]).toEqual(
    legacyVocab["opaque/legacy-only"]
  );
  expect(result.events).toEqual([event]);
  expect(result.vocab.legacy.count).toBe(4);
  expect(result.vocab.modern.count).toBe(1);
});

test("post-QueryEvent Baseline interruption plus strict rebuild read failure preserves facts and old Vocab", async ({ page }) => {
  await loadBackupEnvironment(page);
  const event = makeQueryEvent("query:partial-with-rebuild-read-failure");
  const baseline = makeHistoryBaseline("baseline:partial-with-rebuild-read-failure");
  const oldVocab = { old: { word: "old", count: 11 } };
  const result = await page.evaluate(async ({ envelope, keys, state, old }) => {
    localStorage.setItem(keys.migrationState, JSON.stringify(state));
    localStorage.setItem(keys.vocab, JSON.stringify(old));
    const originalEvents = window.LingoFlowQueryEventRepository;
    const originalBaselines = window.LingoFlowHistoryBaselineRepository;
    let eventListCalls = 0;
    window.LingoFlowQueryEventRepository = Object.freeze({
      ...originalEvents,
      list() {
        eventListCalls += 1;
        if (eventListCalls === 2) {
          const error = new Error("rebuild fact read failed");
          error.code = "query-event-storage-read-failed";
          throw error;
        }
        return originalEvents.list();
      }
    });
    window.LingoFlowHistoryBaselineRepository = Object.freeze({
      ...originalBaselines,
      restoreBackupRecords() {
        throw new Error("baseline restore interrupted");
      }
    });
    try {
      const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
      return {
        restored,
        event: originalEvents.get("query:partial-with-rebuild-read-failure"),
        baseline: originalBaselines.get("baseline:partial-with-rebuild-read-failure"),
        vocab: JSON.parse(localStorage.getItem(keys.vocab)),
        eventListCalls
      };
    } finally {
      window.LingoFlowQueryEventRepository = originalEvents;
      window.LingoFlowHistoryBaselineRepository = originalBaselines;
    }
  }, {
    envelope: makeEnvelope({
      articles: [],
      queryEvents: [event],
      historyBaselines: [baseline]
    }),
    keys: STORAGE_KEYS,
    state: COMPLETED_MIGRATION_STATE,
    old: oldVocab
  });

  expect(result.restored.status).toBe("interrupted");
  expect(findItem(result.restored, "queryEvents", { queryEventId: event.id }))
    .toMatchObject({ status: "restored", written: true });
  expect(findItem(result.restored, "historyBaselines", {
    historyBaselineId: baseline.id
  })).toMatchObject({ status: "failed", written: false });
  expect(result.restored.vocabRebuild).toMatchObject({
    status: "failed",
    reason: "query-event-storage-read-failed"
  });
  expect(result.event).toEqual(event);
  expect(result.baseline).toBeNull();
  expect(result.vocab).toEqual(oldVocab);
  expect(result.eventListCalls).toBe(2);
});

test("retry after partial restore marks existing QueryEvent unchanged and restores remaining Baseline", async ({ page }) => {
  await loadBackupEnvironment(page);
  const event = makeQueryEvent("query:partial-retry");
  const baseline = makeHistoryBaseline("baseline:partial-retry", {
    records: { "opaque/partial-retry": { word: "apple", count: 2 } }
  });
  const result = await page.evaluate(async ({ envelope, keys, state }) => {
    localStorage.setItem(keys.migrationState, JSON.stringify(state));
    const originalBaselines = window.LingoFlowHistoryBaselineRepository;
    window.LingoFlowHistoryBaselineRepository = Object.freeze({
      ...originalBaselines,
      restoreBackupRecords() {
        throw new Error("first baseline write failed");
      }
    });
    let first;
    try {
      first = await window.LingoFlowBackupV2.restoreBackup(envelope);
    } finally {
      window.LingoFlowHistoryBaselineRepository = originalBaselines;
    }
    const second = await window.LingoFlowBackupV2.restoreBackup(envelope);
    return {
      first,
      second,
      events: window.LingoFlowQueryEventRepository.list(),
      baselines: originalBaselines.list(),
      vocab: JSON.parse(localStorage.getItem(keys.vocab))
    };
  }, {
    envelope: makeEnvelope({
      articles: [],
      queryEvents: [event],
      historyBaselines: [baseline]
    }),
    keys: STORAGE_KEYS,
    state: COMPLETED_MIGRATION_STATE
  });

  expect(result.first.status).toBe("interrupted");
  expect(findItem(result.first, "queryEvents", { queryEventId: event.id }))
    .toMatchObject({ status: "restored", written: true });
  expect(findItem(result.first, "historyBaselines", {
    historyBaselineId: baseline.id
  })).toMatchObject({ status: "failed", written: false });
  expect(result.second.status).toBe("completed");
  expect(findItem(result.second, "queryEvents", { queryEventId: event.id }))
    .toMatchObject({ status: "unchanged", written: false });
  expect(findItem(result.second, "historyBaselines", {
    historyBaselineId: baseline.id
  })).toMatchObject({ status: "restored", written: true });
  expect(result.events).toEqual([event]);
  expect(result.baselines).toEqual([baseline]);
  expect(result.vocab.apple.count).toBe(3);
});

test("malformed completed Coordinator result is blocked before backup writes", async ({ page }) => {
  await loadBackupEnvironment(page);
  const event = makeQueryEvent("query:malformed-coordinator");
  const result = await page.evaluate(async ({ envelope, keys }) => {
    const original = window.LingoFlowQueryHistoryMigrationCoordinator;
    let prepareCalls = 0;
    let finalizeCalls = 0;
    window.LingoFlowQueryHistoryMigrationCoordinator = Object.freeze({
      prepare() {
        prepareCalls += 1;
        return { status: "completed" };
      },
      finalize() {
        finalizeCalls += 1;
        return { status: "completed" };
      }
    });
    try {
      const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
      return {
        restored,
        prepareCalls,
        finalizeCalls,
        queryRaw: localStorage.getItem(keys.queryEvents),
        migrationRaw: localStorage.getItem(keys.migrationState)
      };
    } finally {
      window.LingoFlowQueryHistoryMigrationCoordinator = original;
    }
  }, {
    envelope: makeEnvelope({ articles: [], queryEvents: [event] }),
    keys: STORAGE_KEYS
  });

  expect(result.restored).toMatchObject({
    status: "interrupted",
    migration: {
      status: "failed",
      reason: "query-history-migration-prepare-result-invalid",
      backupWritesStarted: false
    },
    vocabRebuild: { status: "not-attempted" }
  });
  expect(result.prepareCalls).toBe(1);
  expect(result.finalizeCalls).toBe(0);
  expect(findItem(result.restored, "queryEvents", { queryEventId: event.id }))
    .toMatchObject({ status: "not-attempted", written: false });
  expect(result.queryRaw).toBeNull();
  expect(result.migrationRaw).toBeNull();
});

test("initial QueryEvent assessment storage failure preserves identity and leaves later records unattempted", async ({ page }) => {
  await loadBackupEnvironment(page);
  const first = makeQueryEvent("query:assessment-read-failure:first");
  const second = makeQueryEvent("query:assessment-read-failure:second", {
    timestamp: "2026-08-29T07:01:00.000Z"
  });
  const result = await page.evaluate(async ({ envelope, keys, state }) => {
    localStorage.setItem(keys.migrationState, JSON.stringify(state));
    const originalGetItem = Storage.prototype.getItem;
    let queryReads = 0;
    Storage.prototype.getItem = function(key) {
      if (key === keys.queryEvents) {
        queryReads += 1;
        if (queryReads === 2) {
          throw new DOMException("assessment read blocked", "SecurityError");
        }
      }
      return originalGetItem.call(this, key);
    };
    try {
      const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
      return {
        restored,
        queryReads,
        queryRaw: originalGetItem.call(localStorage, keys.queryEvents)
      };
    } finally {
      Storage.prototype.getItem = originalGetItem;
    }
  }, {
    envelope: makeEnvelope({ articles: [], queryEvents: [first, second] }),
    keys: STORAGE_KEYS,
    state: COMPLETED_MIGRATION_STATE
  });

  expect(result.restored.status).toBe("interrupted");
  expect(findItem(result.restored, "queryEvents", { queryEventId: first.id }))
    .toMatchObject({
      status: "failed",
      written: false,
      reason: "query-event-storage-read-failed"
    });
  expect(findItem(result.restored, "queryEvents", { queryEventId: second.id }))
    .toMatchObject({ status: "not-attempted", written: false });
  expect(result.restored.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({
      code: "query-event-storage-read-failed",
      entity: "queryEvents",
      queryEventId: first.id
    })
  ]));
  expect(result.queryRaw).toBeNull();
  expect(result.queryReads).toBeGreaterThanOrEqual(3);
});

for (const missingCase of [
  {
    declaredEntity: "queryEvents",
    missingGlobal: "LingoFlowHistoryBaselineRepository",
    expectedReason: "history-baseline-repository-unavailable"
  },
  {
    declaredEntity: "historyBaselines",
    missingGlobal: "LingoFlowQueryEventRepository",
    expectedReason: "query-event-repository-unavailable"
  }
]) {
  test(`declaring only ${missingCase.declaredEntity} still requires the other fact Repository before migration`, async ({ page }) => {
    await loadBackupEnvironment(page);
    const data = { articles: [], [missingCase.declaredEntity]: [] };
    const result = await page.evaluate(async ({ envelope, keys, candidate }) => {
      const originalRepository = window[candidate.missingGlobal];
      const originalCoordinator = window.LingoFlowQueryHistoryMigrationCoordinator;
      let prepareCalls = 0;
      window[candidate.missingGlobal] = null;
      window.LingoFlowQueryHistoryMigrationCoordinator = Object.freeze({
        ...originalCoordinator,
        prepare() {
          prepareCalls += 1;
          return originalCoordinator.prepare();
        }
      });
      try {
        const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
        return {
          restored,
          prepareCalls,
          migrationRaw: localStorage.getItem(keys.migrationState),
          queryRaw: localStorage.getItem(keys.queryEvents),
          baselineRaw: localStorage.getItem(keys.historyBaselines)
        };
      } finally {
        window[candidate.missingGlobal] = originalRepository;
        window.LingoFlowQueryHistoryMigrationCoordinator = originalCoordinator;
      }
    }, {
      envelope: makeEnvelope(data),
      keys: STORAGE_KEYS,
      candidate: missingCase
    });

    expect(result.restored).toMatchObject({
      status: "interrupted",
      migration: {
        status: "failed",
        reason: missingCase.expectedReason,
        backupWritesStarted: false
      },
      vocabRebuild: { status: "not-attempted" }
    });
    expect(result.prepareCalls).toBe(0);
    expect(result.migrationRaw).toBeNull();
    expect(result.queryRaw).toBeNull();
    expect(result.baselineRaw).toBeNull();
  });
}

test("six-entity restore completes every assessment and migration finalize before ordered writes", async ({ page }) => {
  await loadBackupEnvironment(page);
  const data = makeFiveEntityData("full-phase-order");
  data.preferences = [{ key: "appearance", value: "dark" }];
  const localRelationFavorite = makeFavorite("favorite:local-relation", {
    text: "local relation target"
  });
  data.favoriteLearningStates = [makeLearningState(localRelationFavorite.id, false)];
  const result = await page.evaluate(async ({ envelope, localFavorite }) => {
    const calls = [];
    const originals = {
      envelope: window.LingoFlowBackupV2Envelope,
      articleSchema: window.LingoFlowBackupV2Schema,
      favoriteSchema: window.LingoFlowFavoriteBackupSchema,
      learningSchema: window.LingoFlowFavoriteLearningBackupSchema,
      preferencesSchema: window.LingoFlowPreferencesBackupSchema,
      querySchema: window.LingoFlowQueryEventBackupSchema,
      baselineSchema: window.LingoFlowHistoryBaselineBackupSchema,
      articles: window.LingoFlowArticleLibrary,
      favorites: window.LingoFlowFavoriteRepository,
      learning: window.LingoFlowFavoriteLearningRepository,
      preferences: window.LingoFlowPreferencesRepository,
      queryEvents: window.LingoFlowQueryEventRepository,
      historyBaselines: window.LingoFlowHistoryBaselineRepository,
      coordinator: window.LingoFlowQueryHistoryMigrationCoordinator,
      projector: window.LingoFlowQueryHistoryProjector
    };
    originals.favorites.restoreBackupRecords([localFavorite]);
    window.LingoFlowBackupV2Envelope = Object.freeze({
      ...originals.envelope,
      validateEnvelope(value) {
        calls.push("envelope:validate");
        return originals.envelope.validateEnvelope(value);
      },
      unwrapEnvelope(value) {
        calls.push("envelope:unwrap");
        return originals.envelope.unwrapEnvelope(value);
      }
    });
    window.LingoFlowBackupV2Schema = Object.freeze({
      ...originals.articleSchema,
      validateArticles(records) {
        calls.push("schema:articles");
        return originals.articleSchema.validateArticles(records);
      }
    });
    window.LingoFlowFavoriteBackupSchema = Object.freeze({
      ...originals.favoriteSchema,
      validateFavorites(records) {
        calls.push("schema:favorites");
        return originals.favoriteSchema.validateFavorites(records);
      }
    });
    window.LingoFlowFavoriteLearningBackupSchema = Object.freeze({
      ...originals.learningSchema,
      validateFavoriteLearningStates(records) {
        calls.push("schema:favoriteLearningStates");
        return originals.learningSchema.validateFavoriteLearningStates(records);
      }
    });
    window.LingoFlowPreferencesBackupSchema = Object.freeze({
      ...originals.preferencesSchema,
      validatePreferences(records) {
        calls.push("schema:preferences");
        return originals.preferencesSchema.validatePreferences(records);
      }
    });
    window.LingoFlowQueryEventBackupSchema = Object.freeze({
      ...originals.querySchema,
      validateQueryEvents(records) {
        calls.push("schema:queryEvents");
        return originals.querySchema.validateQueryEvents(records);
      }
    });
    window.LingoFlowHistoryBaselineBackupSchema = Object.freeze({
      ...originals.baselineSchema,
      validateHistoryBaselines(records) {
        calls.push("schema:historyBaselines");
        return originals.baselineSchema.validateHistoryBaselines(records);
      }
    });
    window.LingoFlowArticleLibrary = Object.freeze({
      ...originals.articles,
      assessArticleRestore(record) {
        calls.push("assess:articles");
        return originals.articles.assessArticleRestore(record);
      },
      restoreArticle(record) {
        calls.push("restore:articles");
        return originals.articles.restoreArticle(record);
      }
    });
    window.LingoFlowFavoriteRepository = Object.freeze({
      ...originals.favorites,
      list(options) {
        calls.push("relation:favorites");
        return originals.favorites.list(options);
      },
      assessBackupRestore(record) {
        calls.push("assess:favorites");
        return originals.favorites.assessBackupRestore(record);
      },
      restoreBackupRecords(records) {
        calls.push("restore:favorites");
        return originals.favorites.restoreBackupRecords(records);
      }
    });
    window.LingoFlowFavoriteLearningRepository = Object.freeze({
      ...originals.learning,
      assessBackupRestore(record) {
        calls.push("assess:favoriteLearningStates");
        return originals.learning.assessBackupRestore(record);
      },
      restoreBackupRecords(records) {
        calls.push("restore:favoriteLearningStates");
        return originals.learning.restoreBackupRecords(records);
      }
    });
    window.LingoFlowPreferencesRepository = Object.freeze({
      ...originals.preferences,
      assessBackupRestore(record) {
        calls.push("assess:preferences");
        return originals.preferences.assessBackupRestore(record);
      },
      restoreBackupItems(records) {
        calls.push("restore:preferences");
        return originals.preferences.restoreBackupItems(records);
      }
    });
    window.LingoFlowQueryEventRepository = Object.freeze({
      ...originals.queryEvents,
      list() {
        calls.push("list:queryEvents");
        return originals.queryEvents.list();
      },
      assessBackupRestore(record) {
        calls.push("assess:queryEvents");
        return originals.queryEvents.assessBackupRestore(record);
      },
      restoreBackupRecords(records) {
        calls.push("restore:queryEvents");
        return originals.queryEvents.restoreBackupRecords(records);
      }
    });
    window.LingoFlowHistoryBaselineRepository = Object.freeze({
      ...originals.historyBaselines,
      list() {
        calls.push("list:historyBaselines");
        return originals.historyBaselines.list();
      },
      assessBackupRestore(record) {
        calls.push("assess:historyBaselines");
        return originals.historyBaselines.assessBackupRestore(record);
      },
      restoreBackupRecords(records) {
        calls.push("restore:historyBaselines");
        return originals.historyBaselines.restoreBackupRecords(records);
      }
    });
    window.LingoFlowQueryHistoryMigrationCoordinator = Object.freeze({
      prepare() {
        calls.push("migration:prepare:start");
        const prepared = originals.coordinator.prepare();
        calls.push("migration:prepare:end");
        return prepared;
      },
      finalize(token) {
        calls.push("migration:finalize:start");
        const finalized = originals.coordinator.finalize(token);
        calls.push("migration:finalize:end");
        return finalized;
      }
    });
    window.LingoFlowQueryHistoryProjector = Object.freeze({
      ...originals.projector,
      project(queryEvents, historyBaselines) {
        calls.push("project:vocab");
        return originals.projector.project(queryEvents, historyBaselines);
      }
    });

    try {
      const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
      return { restored, calls };
    } finally {
      window.LingoFlowBackupV2Envelope = originals.envelope;
      window.LingoFlowBackupV2Schema = originals.articleSchema;
      window.LingoFlowFavoriteBackupSchema = originals.favoriteSchema;
      window.LingoFlowFavoriteLearningBackupSchema = originals.learningSchema;
      window.LingoFlowPreferencesBackupSchema = originals.preferencesSchema;
      window.LingoFlowQueryEventBackupSchema = originals.querySchema;
      window.LingoFlowHistoryBaselineBackupSchema = originals.baselineSchema;
      window.LingoFlowArticleLibrary = originals.articles;
      window.LingoFlowFavoriteRepository = originals.favorites;
      window.LingoFlowFavoriteLearningRepository = originals.learning;
      window.LingoFlowPreferencesRepository = originals.preferences;
      window.LingoFlowQueryEventRepository = originals.queryEvents;
      window.LingoFlowHistoryBaselineRepository = originals.historyBaselines;
      window.LingoFlowQueryHistoryMigrationCoordinator = originals.coordinator;
      window.LingoFlowQueryHistoryProjector = originals.projector;
    }
  }, { envelope: makeEnvelope(data), localFavorite: localRelationFavorite });

  expect(result.restored).toMatchObject({
    status: "completed",
    summary: { total: 6, restored: 6 },
    migration: { status: "completed", backupWritesStarted: true },
    vocabRebuild: { status: "rebuilt" }
  });
  expect(result.calls).toEqual([
    "envelope:validate",
    "envelope:unwrap",
    "schema:articles",
    "schema:favorites",
    "schema:favoriteLearningStates",
    "schema:preferences",
    "schema:queryEvents",
    "schema:historyBaselines",
    "relation:favorites",
    "migration:prepare:start",
    "list:queryEvents",
    "list:historyBaselines",
    "list:queryEvents",
    "list:historyBaselines",
    "migration:prepare:end",
    "list:queryEvents",
    "list:historyBaselines",
    "assess:articles",
    "assess:favorites",
    "assess:favoriteLearningStates",
    "assess:preferences",
    "assess:queryEvents",
    "assess:historyBaselines",
    "migration:finalize:start",
    "list:queryEvents",
    "list:historyBaselines",
    "migration:finalize:end",
    "restore:articles",
    "restore:favorites",
    "restore:favoriteLearningStates",
    "restore:preferences",
    "schema:preferences",
    "restore:queryEvents",
    "schema:queryEvents",
    "restore:historyBaselines",
    "schema:historyBaselines",
    "list:queryEvents",
    "list:historyBaselines",
    "project:vocab"
  ]);
});

test("five-entity finalize failure occurs after all assessments and before every write", async ({ page }) => {
  await loadBackupEnvironment(page);
  const data = makeFiveEntityData("finalize-failure");
  const result = await page.evaluate(async ({ envelope, keys }) => {
    const calls = [];
    let finalizeReceivedToken = false;
    const originals = {
      articles: window.LingoFlowArticleLibrary,
      favorites: window.LingoFlowFavoriteRepository,
      learning: window.LingoFlowFavoriteLearningRepository,
      queryEvents: window.LingoFlowQueryEventRepository,
      historyBaselines: window.LingoFlowHistoryBaselineRepository,
      coordinator: window.LingoFlowQueryHistoryMigrationCoordinator
    };
    const wrapRepository = (name, repository) => Object.freeze({
      ...repository,
      assessBackupRestore(record) {
        calls.push(`assess:${name}`);
        return repository.assessBackupRestore(record);
      },
      restoreBackupRecords(records) {
        calls.push(`restore:${name}`);
        return repository.restoreBackupRecords(records);
      }
    });
    window.LingoFlowArticleLibrary = Object.freeze({
      ...originals.articles,
      assessArticleRestore(record) {
        calls.push("assess:articles");
        return originals.articles.assessArticleRestore(record);
      },
      restoreArticle(record) {
        calls.push("restore:articles");
        return originals.articles.restoreArticle(record);
      }
    });
    window.LingoFlowFavoriteRepository = wrapRepository("favorites", originals.favorites);
    window.LingoFlowFavoriteLearningRepository = wrapRepository(
      "favoriteLearningStates",
      originals.learning
    );
    window.LingoFlowQueryEventRepository = wrapRepository(
      "queryEvents",
      originals.queryEvents
    );
    window.LingoFlowHistoryBaselineRepository = wrapRepository(
      "historyBaselines",
      originals.historyBaselines
    );
    window.LingoFlowQueryHistoryMigrationCoordinator = Object.freeze({
      prepare() {
        calls.push("migration:prepare");
        return originals.coordinator.prepare();
      },
      finalize(token) {
        calls.push("migration:finalize");
        finalizeReceivedToken = Boolean(token && typeof token === "object");
        return {
          status: "failed",
          outcome: "failed",
          baselineWritten: false,
          migrationStateWritten: false,
          historyBaselineId: null,
          legacyVocabStatus: "missing",
          reason: "test-finalize-failed",
          errors: [{ code: "test-finalize-failed" }]
        };
      }
    });

    try {
      const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
      return {
        restored,
        calls,
        finalizeReceivedToken,
        migrationRaw: localStorage.getItem(keys.migrationState),
        queryRaw: localStorage.getItem(keys.queryEvents),
        baselineRaw: localStorage.getItem(keys.historyBaselines),
        favorites: originals.favorites.list({ includeDeleted: true }),
        learning: originals.learning.list({ includeDeleted: true }),
        articles: await originals.articles.listArticles({ includeDeleted: true })
      };
    } finally {
      window.LingoFlowArticleLibrary = originals.articles;
      window.LingoFlowFavoriteRepository = originals.favorites;
      window.LingoFlowFavoriteLearningRepository = originals.learning;
      window.LingoFlowQueryEventRepository = originals.queryEvents;
      window.LingoFlowHistoryBaselineRepository = originals.historyBaselines;
      window.LingoFlowQueryHistoryMigrationCoordinator = originals.coordinator;
    }
  }, { envelope: makeEnvelope(data), keys: STORAGE_KEYS });

  expect(result.restored).toMatchObject({
    status: "interrupted",
    summary: { total: 5, restored: 0, failed: 0, notAttempted: 5 },
    migration: {
      status: "failed",
      reason: "test-finalize-failed",
      backupWritesStarted: false
    },
    vocabRebuild: { status: "not-attempted" }
  });
  expect(result.calls).toEqual([
    "migration:prepare",
    "assess:articles",
    "assess:favorites",
    "assess:favoriteLearningStates",
    "assess:queryEvents",
    "assess:historyBaselines",
    "migration:finalize"
  ]);
  expect(result.calls.some(call => call.startsWith("restore:"))).toBe(false);
  expect(result.finalizeReceivedToken).toBe(true);
  expect(result.migrationRaw).toBeNull();
  expect(result.queryRaw).toBeNull();
  expect(result.baselineRaw).toBeNull();
  expect(result.articles).toEqual([]);
  expect(result.favorites).toEqual([]);
  expect(result.learning).toEqual([]);
});

test("a genuine legacy three-entity Envelope has zero Query History side effects", async ({ page }) => {
  await loadBackupEnvironment(page);
  const favorite = makeFavorite("favorite:legacy-three", { text: "legacy three" });
  const data = {
    articles: [makeArticle("article:legacy-three")],
    favorites: [favorite],
    favoriteLearningStates: [makeLearningState(favorite.id, true)]
  };
  const result = await page.evaluate(async ({ envelope, keys }) => {
    localStorage.setItem(keys.migrationState, "legacy-state-sentinel");
    localStorage.setItem(keys.vocab, JSON.stringify({
      sentinel: { word: "sentinel", count: 9 }
    }));
    const calls = [];
    const originals = {
      articles: window.LingoFlowArticleLibrary,
      favorites: window.LingoFlowFavoriteRepository,
      learning: window.LingoFlowFavoriteLearningRepository,
      coordinator: window.LingoFlowQueryHistoryMigrationCoordinator,
      queryEvents: window.LingoFlowQueryEventRepository,
      historyBaselines: window.LingoFlowHistoryBaselineRepository,
      projector: window.LingoFlowQueryHistoryProjector
    };
    const storageOriginals = {
      getItem: Storage.prototype.getItem,
      setItem: Storage.prototype.setItem,
      removeItem: Storage.prototype.removeItem
    };
    const migrationStorageCalls = { get: 0, set: 0, remove: 0 };
    Storage.prototype.getItem = function(key) {
      if (key === keys.migrationState) migrationStorageCalls.get += 1;
      return storageOriginals.getItem.call(this, key);
    };
    Storage.prototype.setItem = function(key, value) {
      if (key === keys.migrationState) migrationStorageCalls.set += 1;
      return storageOriginals.setItem.call(this, key, value);
    };
    Storage.prototype.removeItem = function(key) {
      if (key === keys.migrationState) migrationStorageCalls.remove += 1;
      return storageOriginals.removeItem.call(this, key);
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
        migrationStorageCalls,
        migrationRaw: storageOriginals.getItem.call(localStorage, keys.migrationState),
        vocabRaw: storageOriginals.getItem.call(localStorage, keys.vocab),
        articles: await originals.articles.listArticles({ includeDeleted: true }),
        favorites: originals.favorites.list({ includeDeleted: true }),
        learning: originals.learning.list({ includeDeleted: true })
      };
    } finally {
      Storage.prototype.getItem = storageOriginals.getItem;
      Storage.prototype.setItem = storageOriginals.setItem;
      Storage.prototype.removeItem = storageOriginals.removeItem;
      window.LingoFlowQueryHistoryMigrationCoordinator = originals.coordinator;
      window.LingoFlowQueryEventRepository = originals.queryEvents;
      window.LingoFlowHistoryBaselineRepository = originals.historyBaselines;
      window.LingoFlowQueryHistoryProjector = originals.projector;
    }
  }, {
    envelope: {
      format: { name: "LingoFlow Backup", version: 2 },
      metadata: {},
      schema: {
        articles: "1",
        favorites: "1",
        favoriteLearningStates: "1"
      },
      data
    },
    keys: STORAGE_KEYS
  });

  expect(result.restored).toMatchObject({
    status: "completed",
    summary: { total: 3, restored: 3 }
  });
  expect(result.restored).not.toHaveProperty("migration");
  expect(result.restored).not.toHaveProperty("vocabRebuild");
  expect(result.calls).toEqual([]);
  expect(result.migrationStorageCalls).toEqual({ get: 0, set: 0, remove: 0 });
  expect(result.migrationRaw).toBe("legacy-state-sentinel");
  expect(JSON.parse(result.vocabRaw)).toEqual({
    sentinel: { word: "sentinel", count: 9 }
  });
  expect(result.articles).toEqual(data.articles);
  expect(result.favorites).toEqual(data.favorites);
  expect(result.learning).toEqual(data.favoriteLearningStates);
});

test("a conflict-only Query History restore still rebuilds Vocab", async ({ page }) => {
  await loadBackupEnvironment(page);
  const localEvent = makeQueryEvent("query:conflict-only", {
    word: "pear",
    displayWord: "Pear",
    meaning: "梨",
    source: "search"
  });
  const incomingEvent = { ...localEvent, meaning: "different incoming snapshot" };
  const localBaseline = makeHistoryBaseline("baseline:conflict-only", {
    records: {
      "opaque/local-pear": {
        word: "pear",
        count: 4,
        displayWord: "Local Pear Baseline"
      }
    }
  });
  const incomingBaseline = {
    ...localBaseline,
    records: {
      "opaque/incoming-pear": {
        word: "pear",
        count: 99,
        displayWord: "Incoming Pear Baseline"
      }
    }
  };
  const result = await page.evaluate(async ({ envelope, localFacts, keys, state }) => {
    localStorage.setItem(keys.migrationState, JSON.stringify(state));
    window.LingoFlowQueryEventRepository.restoreBackupRecords([localFacts.event]);
    window.LingoFlowHistoryBaselineRepository.restoreBackupRecords([
      localFacts.baseline
    ]);
    localStorage.setItem(keys.vocab, JSON.stringify({
      stale: { word: "stale", count: 99 }
    }));
    const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
    return {
      restored,
      event: window.LingoFlowQueryEventRepository.get(localFacts.event.id),
      baseline: window.LingoFlowHistoryBaselineRepository.get(localFacts.baseline.id),
      vocab: JSON.parse(localStorage.getItem(keys.vocab))
    };
  }, {
    envelope: makeEnvelope({
      articles: [],
      queryEvents: [incomingEvent],
      historyBaselines: [incomingBaseline]
    }),
    localFacts: { event: localEvent, baseline: localBaseline },
    keys: STORAGE_KEYS,
    state: COMPLETED_MIGRATION_STATE
  });

  expect(result.restored).toMatchObject({
    status: "completed-with-conflicts",
    summary: { total: 2, restored: 0, unchanged: 0, conflicts: 2 },
    migration: { status: "completed", backupWritesStarted: false },
    vocabRebuild: { status: "rebuilt" }
  });
  expect(findItem(result.restored, "queryEvents", { queryEventId: localEvent.id }))
    .toMatchObject({ status: "conflict", written: false });
  expect(findItem(result.restored, "historyBaselines", {
    historyBaselineId: localBaseline.id
  })).toMatchObject({ status: "conflict", written: false });
  expect(result.event).toEqual(localEvent);
  expect(result.baseline).toEqual(localBaseline);
  expect(result.vocab).toEqual({
    pear: expect.objectContaining({
      word: "pear",
      count: 5,
      meaning: "梨",
      displayWord: "Pear"
    })
  });
});

for (const malformedCase of [
  {
    entity: "queryEvents",
    globalName: "LingoFlowQueryEventRepository",
    identityField: "queryEventId",
    records: [
      makeQueryEvent("query:malformed-domain:first"),
      makeQueryEvent("query:malformed-domain:second", {
        timestamp: "2026-08-29T07:01:00.000Z"
      }),
      makeQueryEvent("query:malformed-domain:third", {
        timestamp: "2026-08-29T07:02:00.000Z"
      })
    ]
  },
  {
    entity: "historyBaselines",
    globalName: "LingoFlowHistoryBaselineRepository",
    identityField: "historyBaselineId",
    records: [
      makeHistoryBaseline("baseline:malformed-domain:first"),
      makeHistoryBaseline("baseline:malformed-domain:second"),
      makeHistoryBaseline("baseline:malformed-domain:third")
    ]
  }
]) {
  test(`malformed ${malformedCase.entity} result preserves the first real write and stops the chain`, async ({ page }) => {
    await loadBackupEnvironment(page);
    const result = await page.evaluate(async ({ candidate, envelope, keys, state }) => {
      localStorage.setItem(keys.migrationState, JSON.stringify(state));
      const original = window[candidate.globalName];
      window[candidate.globalName] = Object.freeze({
        ...original,
        restoreBackupRecords(records) {
          const firstResult = original.restoreBackupRecords([records[0]]);
          return {
            status: "interrupted",
            items: [
              { ...firstResult.items[0], index: 0 },
              {
                index: 1,
                [candidate.identityField]: "malformed:wrong-identity",
                status: "restored",
                written: true
              },
              {
                index: 2,
                [candidate.identityField]: records[2].id,
                status: "restored",
                written: true
              }
            ],
            errors: []
          };
        }
      });
      try {
        const restored = await window.LingoFlowBackupV2.restoreBackup(envelope);
        return { restored, stored: original.list() };
      } finally {
        window[candidate.globalName] = original;
      }
    }, {
      candidate: malformedCase,
      envelope: makeEnvelope({
        articles: [],
        [malformedCase.entity]: malformedCase.records
      }),
      keys: STORAGE_KEYS,
      state: COMPLETED_MIGRATION_STATE
    });

    expect(result.restored).toMatchObject({
      status: "interrupted",
      summary: { total: 3, restored: 1, failed: 1, notAttempted: 1 },
      vocabRebuild: { status: "rebuilt" }
    });
    expect(findItem(result.restored, malformedCase.entity, {
      [malformedCase.identityField]: malformedCase.records[0].id
    })).toMatchObject({
      status: "restored",
      written: true
    });
    expect(findItem(result.restored, malformedCase.entity, {
      [malformedCase.identityField]: malformedCase.records[1].id
    })).toMatchObject({
      status: "failed",
      written: false,
      reason: `${malformedCase.entity}-restore-result-invalid`
    });
    expect(findItem(result.restored, malformedCase.entity, {
      [malformedCase.identityField]: malformedCase.records[2].id
    })).toMatchObject({ status: "not-attempted", written: false });
    expect(result.restored.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: `${malformedCase.entity}-restore-failed`,
        entity: malformedCase.entity,
        [malformedCase.identityField]: malformedCase.records[1].id
      })
    ]));
    expect(result.restored.items
      .filter(item => item.entity === malformedCase.entity)
      .every(item => !Object.prototype.hasOwnProperty.call(item, "favoriteId")))
      .toBe(true);
    expect(result.stored).toEqual([malformedCase.records[0]]);
  });
}

test("retry after same-run migration finalize preserves partial QueryEvent and restores Baseline", async ({ page }) => {
  await loadBackupEnvironment(page);
  const event = makeQueryEvent("query:finalize-partial-retry");
  const baseline = makeHistoryBaseline("baseline:finalize-partial-retry", {
    records: { "opaque/finalize-retry": { word: "apple", count: 2 } }
  });
  const result = await page.evaluate(async ({ envelope, keys }) => {
    const originalBaselines = window.LingoFlowHistoryBaselineRepository;
    let restoreCalls = 0;
    window.LingoFlowHistoryBaselineRepository = Object.freeze({
      ...originalBaselines,
      restoreBackupRecords(records) {
        restoreCalls += 1;
        if (restoreCalls === 1) throw new Error("first Baseline write failed");
        return originalBaselines.restoreBackupRecords(records);
      }
    });
    try {
      const first = await window.LingoFlowBackupV2.restoreBackup(envelope);
      const stateAfterFirst = JSON.parse(localStorage.getItem(keys.migrationState));
      const firstEvents = window.LingoFlowQueryEventRepository.list();
      const firstBaselines = originalBaselines.list();
      const second = await window.LingoFlowBackupV2.restoreBackup(envelope);
      return {
        first,
        second,
        stateAfterFirst,
        firstEvents,
        firstBaselines,
        events: window.LingoFlowQueryEventRepository.list(),
        baselines: originalBaselines.list(),
        vocab: JSON.parse(localStorage.getItem(keys.vocab)),
        restoreCalls
      };
    } finally {
      window.LingoFlowHistoryBaselineRepository = originalBaselines;
    }
  }, {
    envelope: makeEnvelope({
      articles: [],
      queryEvents: [event],
      historyBaselines: [baseline]
    }),
    keys: STORAGE_KEYS
  });

  expect(result.first).toMatchObject({
    status: "interrupted",
    migration: {
      status: "completed",
      migrationStateWritten: true,
      backupWritesStarted: true
    }
  });
  expect(findItem(result.first, "queryEvents", { queryEventId: event.id }))
    .toMatchObject({ status: "restored", written: true });
  expect(findItem(result.first, "historyBaselines", {
    historyBaselineId: baseline.id
  })).toMatchObject({ status: "failed", written: false });
  expect(result.stateAfterFirst).toEqual(COMPLETED_MIGRATION_STATE);
  expect(result.firstEvents).toEqual([event]);
  expect(result.firstBaselines).toEqual([]);

  expect(result.second).toMatchObject({
    status: "completed",
    migration: {
      status: "completed",
      outcome: "already-completed",
      migrationStateWritten: false,
      backupWritesStarted: true
    }
  });
  expect(findItem(result.second, "queryEvents", { queryEventId: event.id }))
    .toMatchObject({ status: "unchanged", written: false });
  expect(findItem(result.second, "historyBaselines", {
    historyBaselineId: baseline.id
  })).toMatchObject({ status: "restored", written: true });
  expect(result.events).toEqual([event]);
  expect(result.baselines).toEqual([baseline]);
  expect(result.vocab.apple.count).toBe(3);
  expect(result.restoreCalls).toBe(2);
});

test("finalize state write failure after five-entity assessment is retryable without duplicating migration Baseline", async ({ page }) => {
  await loadBackupEnvironment(page);
  const data = makeFiveEntityData("finalize-state-write-retry");
  const legacyVocab = {
    "opaque/legacy-finalize": {
      word: "legacy",
      count: 4,
      displayWord: "Legacy"
    }
  };
  const result = await page.evaluate(async ({ envelope, keys, vocab }) => {
    const legacyVocabRaw = JSON.stringify(vocab);
    localStorage.setItem(keys.vocab, legacyVocabRaw);
    const calls = [];
    const originals = {
      articles: window.LingoFlowArticleLibrary,
      favorites: window.LingoFlowFavoriteRepository,
      learning: window.LingoFlowFavoriteLearningRepository,
      queryEvents: window.LingoFlowQueryEventRepository,
      historyBaselines: window.LingoFlowHistoryBaselineRepository
    };
    const wrapRepository = (name, repository) => Object.freeze({
      ...repository,
      assessBackupRestore(record) {
        calls.push(`assess:${name}`);
        return repository.assessBackupRestore(record);
      },
      restoreBackupRecords(records) {
        calls.push(`restore:${name}`);
        return repository.restoreBackupRecords(records);
      }
    });
    window.LingoFlowArticleLibrary = Object.freeze({
      ...originals.articles,
      assessArticleRestore(record) {
        calls.push("assess:articles");
        return originals.articles.assessArticleRestore(record);
      },
      restoreArticle(record) {
        calls.push("restore:articles");
        return originals.articles.restoreArticle(record);
      }
    });
    window.LingoFlowFavoriteRepository = wrapRepository("favorites", originals.favorites);
    window.LingoFlowFavoriteLearningRepository = wrapRepository(
      "favoriteLearningStates",
      originals.learning
    );
    window.LingoFlowQueryEventRepository = wrapRepository(
      "queryEvents",
      originals.queryEvents
    );
    window.LingoFlowHistoryBaselineRepository = wrapRepository(
      "historyBaselines",
      originals.historyBaselines
    );

    const originalSetItem = Storage.prototype.setItem;
    let vocabWriteCalls = 0;
    Storage.prototype.setItem = function(key, value) {
      if (key === keys.migrationState) {
        throw new DOMException("migration state write blocked", "QuotaExceededError");
      }
      if (key === keys.vocab) vocabWriteCalls += 1;
      return originalSetItem.call(this, key, value);
    };

    try {
      let first;
      try {
        first = await window.LingoFlowBackupV2.restoreBackup(envelope);
      } finally {
        Storage.prototype.setItem = originalSetItem;
      }
      const firstCalls = calls.slice();
      const firstVocabWriteCalls = vocabWriteCalls;
      const firstVocabRaw = localStorage.getItem(keys.vocab);
      const firstMigrationRaw = localStorage.getItem(keys.migrationState);
      const firstBaselines = originals.historyBaselines.list();
      const second = await window.LingoFlowBackupV2.restoreBackup(envelope);
      return {
        first,
        second,
        firstCalls,
        firstVocabWriteCalls,
        secondCalls: calls.slice(firstCalls.length),
        firstVocabRaw,
        firstMigrationRaw,
        firstBaselines,
        migrationState: JSON.parse(localStorage.getItem(keys.migrationState)),
        articles: await originals.articles.listArticles({ includeDeleted: true }),
        favorites: originals.favorites.list({ includeDeleted: true }),
        learning: originals.learning.list({ includeDeleted: true }),
        events: originals.queryEvents.list(),
        baselines: originals.historyBaselines.list(),
        vocab: JSON.parse(localStorage.getItem(keys.vocab))
      };
    } finally {
      Storage.prototype.setItem = originalSetItem;
      window.LingoFlowArticleLibrary = originals.articles;
      window.LingoFlowFavoriteRepository = originals.favorites;
      window.LingoFlowFavoriteLearningRepository = originals.learning;
      window.LingoFlowQueryEventRepository = originals.queryEvents;
      window.LingoFlowHistoryBaselineRepository = originals.historyBaselines;
    }
  }, {
    envelope: makeEnvelope(data),
    keys: STORAGE_KEYS,
    vocab: legacyVocab
  });

  expect(result.first).toMatchObject({
    status: "interrupted",
    summary: { total: 5, restored: 0, failed: 0, notAttempted: 5 },
    migration: {
      status: "failed",
      reason: "history-migration-state-storage-write-failed",
      baselineWritten: true,
      backupWritesStarted: false
    },
    vocabRebuild: { status: "not-attempted" }
  });
  expect(result.firstCalls).toEqual([
    "assess:articles",
    "assess:favorites",
    "assess:favoriteLearningStates",
    "assess:queryEvents",
    "assess:historyBaselines"
  ]);
  expect(result.first.items.every(item => (
    item.status === "not-attempted" && item.written === false
  ))).toBe(true);
  expect(result.firstVocabWriteCalls).toBe(0);
  expect(result.firstVocabRaw).toBe(JSON.stringify(legacyVocab));
  expect(result.firstMigrationRaw).toBeNull();
  expect(result.firstBaselines).toHaveLength(1);
  expect(result.firstBaselines[0].id).toMatch(/^legacy-local:v1:/);

  expect(result.second).toMatchObject({
    status: "completed",
    summary: { total: 5, restored: 5, failed: 0, notAttempted: 0 },
    migration: {
      status: "completed",
      outcome: "completed-from-existing-baseline",
      baselineWritten: false,
      migrationStateWritten: true,
      backupWritesStarted: true
    },
    vocabRebuild: { status: "rebuilt" }
  });
  expect(result.secondCalls).toEqual([
    "assess:articles",
    "assess:favorites",
    "assess:favoriteLearningStates",
    "assess:queryEvents",
    "assess:historyBaselines",
    "restore:articles",
    "restore:favorites",
    "restore:favoriteLearningStates",
    "restore:queryEvents",
    "restore:historyBaselines"
  ]);
  expect(result.migrationState).toEqual(COMPLETED_MIGRATION_STATE);
  expect(result.articles).toEqual(data.articles);
  expect(result.favorites).toEqual(expect.arrayContaining(data.favorites));
  expect(result.learning).toEqual(expect.arrayContaining(data.favoriteLearningStates));
  expect(result.events).toEqual(data.queryEvents);
  expect(result.baselines).toHaveLength(2);
  expect(result.baselines.filter(item => item.id.startsWith("legacy-local:v1:")))
    .toHaveLength(1);
  expect(result.baselines).toEqual(expect.arrayContaining([
    result.firstBaselines[0],
    data.historyBaselines[0]
  ]));
  expect(result.vocab.legacy.count).toBe(4);
  expect(result.vocab.apple.count).toBe(3);
});

test("migration-only Baseline survives prerequisite interruption and retry without becoming a backup item", async ({ page }) => {
  await loadBackupEnvironment(page);
  const event = makeQueryEvent("query:migration-only-prerequisite-retry", {
    word: "modern",
    displayWord: "Modern"
  });
  const backupBaseline = makeHistoryBaseline("baseline:backup-after-migration-only", {
    records: { "opaque/backup": { word: "modern", count: 2 } }
  });
  const legacyVocab = {
    "opaque/legacy": { word: "legacy", count: 4, displayWord: "Legacy" }
  };
  const result = await page.evaluate(async ({ envelope, keys, vocab }) => {
    localStorage.setItem(keys.vocab, JSON.stringify(vocab));
    const originalEvents = window.LingoFlowQueryEventRepository;
    const originalCoordinator = window.LingoFlowQueryHistoryMigrationCoordinator;
    let failNextPrerequisiteRead = false;
    window.LingoFlowQueryEventRepository = Object.freeze({
      ...originalEvents,
      list() {
        if (failNextPrerequisiteRead) {
          failNextPrerequisiteRead = false;
          const error = new Error("post-prepare facts read blocked");
          error.code = "query-event-storage-read-failed";
          throw error;
        }
        return originalEvents.list();
      }
    });
    window.LingoFlowQueryHistoryMigrationCoordinator = Object.freeze({
      ...originalCoordinator,
      prepare() {
        const prepared = originalCoordinator.prepare();
        if (prepared.status === "ready" && prepared.baselineWritten === true) {
          failNextPrerequisiteRead = true;
        }
        return prepared;
      }
    });
    try {
      const first = await window.LingoFlowBackupV2.restoreBackup(envelope);
      const firstBaselines = window.LingoFlowHistoryBaselineRepository.list();
      const firstMigrationRaw = localStorage.getItem(keys.migrationState);
      const firstVocabRaw = localStorage.getItem(keys.vocab);
      const second = await window.LingoFlowBackupV2.restoreBackup(envelope);
      return {
        first,
        second,
        firstBaselines,
        firstMigrationRaw,
        firstVocabRaw,
        events: originalEvents.list(),
        baselines: window.LingoFlowHistoryBaselineRepository.list(),
        migrationState: JSON.parse(localStorage.getItem(keys.migrationState)),
        vocab: JSON.parse(localStorage.getItem(keys.vocab))
      };
    } finally {
      window.LingoFlowQueryEventRepository = originalEvents;
      window.LingoFlowQueryHistoryMigrationCoordinator = originalCoordinator;
    }
  }, {
    envelope: makeEnvelope({
      articles: [],
      queryEvents: [event],
      historyBaselines: [backupBaseline]
    }),
    keys: STORAGE_KEYS,
    vocab: legacyVocab
  });

  expect(result.first).toMatchObject({
    status: "interrupted",
    summary: { total: 2, restored: 0, failed: 0, notAttempted: 2 },
    migration: {
      status: "prepared",
      baselineWritten: true,
      backupWritesStarted: false
    },
    vocabRebuild: { status: "not-attempted" }
  });
  expect(findItem(result.first, "queryEvents", { queryEventId: event.id }))
    .toMatchObject({ status: "not-attempted", written: false });
  expect(findItem(result.first, "historyBaselines", {
    historyBaselineId: backupBaseline.id
  })).toMatchObject({ status: "not-attempted", written: false });
  expect(result.first.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "query-event-storage-read-failed", phase: "assessment" })
  ]));
  expect(result.firstMigrationRaw).toBeNull();
  expect(result.firstVocabRaw).toBe(JSON.stringify(legacyVocab));
  expect(result.firstBaselines).toHaveLength(1);
  expect(result.firstBaselines[0].id).toMatch(/^legacy-local:v1:/);
  expect(result.first.items.filter(item => item.entity === "historyBaselines"))
    .toHaveLength(1);
  expect(result.first.items.some(item => (
    item.historyBaselineId === result.firstBaselines[0].id
  ))).toBe(false);

  expect(result.second).toMatchObject({
    status: "completed",
    summary: { total: 2, restored: 2 },
    migration: {
      status: "completed",
      outcome: "completed-from-existing-baseline",
      baselineWritten: false,
      migrationStateWritten: true,
      backupWritesStarted: true
    },
    vocabRebuild: { status: "rebuilt" }
  });
  expect(result.events).toEqual([event]);
  expect(result.baselines).toHaveLength(2);
  expect(result.baselines.filter(item => item.id.startsWith("legacy-local:v1:")))
    .toHaveLength(1);
  expect(result.baselines).toEqual(expect.arrayContaining([
    result.firstBaselines[0],
    backupBaseline
  ]));
  expect(result.second.items.filter(item => item.entity === "historyBaselines"))
    .toEqual([expect.objectContaining({
      historyBaselineId: backupBaseline.id,
      status: "restored",
      written: true
    })]);
  expect(result.migrationState).toEqual(COMPLETED_MIGRATION_STATE);
  expect(result.vocab.legacy.count).toBe(4);
  expect(result.vocab.modern.count).toBe(3);
});
