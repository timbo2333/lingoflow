const { test, expect } = require("@playwright/test");

const VOCAB_KEY = "EnglishReaderV05Vocab";
const QUERY_EVENTS_KEY = "EnglishReaderV052QueryEvents";
const HISTORY_BASELINES_KEY = "EnglishReaderV052HistoryBaselines";
const MIGRATION_STATE_KEY = "EnglishReaderV052HistoryMigrationState";
const MIGRATION_COMPLETED = { version: 1, status: "completed" };
const projectErrors = new WeakMap();

function makeEvent(id, overrides = {}) {
  return {
    id,
    deviceId: "device:integration",
    word: "apple",
    displayWord: "Apple",
    phonetic: "/ˈæpəl/",
    pos: "noun",
    meaning: "苹果",
    dictionaryFound: true,
    source: "article",
    timestamp: "2026-08-28T10:00:00.000Z",
    ...overrides
  };
}

function makeBaseline(id, records, overrides = {}) {
  return {
    id,
    createdAt: "2026-08-20T10:00:00.000Z",
    deviceId: "legacy:integration",
    records,
    ...overrides
  };
}

async function waitForAppReady(page) {
  await expect(page.locator("#inputText")).toBeVisible();
  await expect(page.locator("#dictionarySetupStatus")).not.toHaveAttribute(
    "data-state",
    "checking"
  );
}

async function replaceHistoryAndReload(page, seed = {}) {
  await page.evaluate(({ keys, seedValues }) => {
    for (const key of Object.values(keys)) localStorage.removeItem(key);
    for (const [name, value] of Object.entries(seedValues)) {
      localStorage.setItem(
        keys[name],
        typeof value === "string" ? value : JSON.stringify(value)
      );
    }
  }, {
    keys: {
      vocab: VOCAB_KEY,
      events: QUERY_EVENTS_KEY,
      baselines: HISTORY_BASELINES_KEY,
      migrationState: MIGRATION_STATE_KEY
    },
    seedValues: seed
  });
  await page.reload();
  await waitForAppReady(page);
}

async function readHistory(page) {
  return page.evaluate(keys => {
    const parse = key => {
      const raw = localStorage.getItem(key);
      return raw === null ? null : JSON.parse(raw);
    };
    return {
      vocab: parse(keys.vocab),
      events: parse(keys.events),
      baselines: parse(keys.baselines),
      migrationState: parse(keys.migrationState),
      raw: {
        vocab: localStorage.getItem(keys.vocab),
        events: localStorage.getItem(keys.events),
        baselines: localStorage.getItem(keys.baselines)
      }
    };
  }, {
    vocab: VOCAB_KEY,
    events: QUERY_EVENTS_KEY,
    baselines: HISTORY_BASELINES_KEY,
    migrationState: MIGRATION_STATE_KEY
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

test("页面按依赖顺序加载 Query History Schema、Repository 与 Projector", async ({ page }) => {
  const result = await page.evaluate(() => {
    const scripts = Array.from(document.scripts, script => (
      new URL(script.src, location.href).pathname
    ));
    const positions = Object.fromEntries([
      "/js/query-event-backup-schema.js",
      "/js/history-baseline-backup-schema.js",
      "/js/local-data.js",
      "/js/query-event-repository.js",
      "/js/history-baseline-repository.js",
      "/js/query-history-migration-coordinator.js",
      "/js/query-history-projector.js",
      "/js/main.js"
    ].map(path => [path, scripts.indexOf(path)]));

    return {
      positions,
      globals: {
        queryRepository: typeof window.LingoFlowQueryEventRepository?.append,
        baselineRepository: typeof window.LingoFlowHistoryBaselineRepository?.list,
        migrationCoordinator: typeof window.LingoFlowQueryHistoryMigrationCoordinator
          ?.ensureCompleted,
        projector: typeof window.LingoFlowQueryHistoryProjector?.project
      },
      removedModernHelpers: {
        recordQueryEvent: typeof window.recordQueryEvent,
        getQueryEvents: typeof window.getQueryEvents,
        getHistoryBaselines: typeof window.getHistoryBaselines
      }
    };
  });

  expect(result.globals).toEqual({
    queryRepository: "function",
    baselineRepository: "function",
    migrationCoordinator: "function",
    projector: "function"
  });
  expect(result.removedModernHelpers).toEqual({
    recordQueryEvent: "undefined",
    getQueryEvents: "undefined",
    getHistoryBaselines: "undefined"
  });
  expect(Object.values(result.positions).every(index => index >= 0)).toBe(true);
  expect(result.positions["/js/query-event-backup-schema.js"])
    .toBeLessThan(result.positions["/js/query-event-repository.js"]);
  expect(result.positions["/js/history-baseline-backup-schema.js"])
    .toBeLessThan(result.positions["/js/history-baseline-repository.js"]);
  expect(result.positions["/js/local-data.js"])
    .toBeLessThan(result.positions["/js/query-history-migration-coordinator.js"]);
  expect(result.positions["/js/query-event-repository.js"])
    .toBeLessThan(result.positions["/js/query-history-migration-coordinator.js"]);
  expect(result.positions["/js/history-baseline-repository.js"])
    .toBeLessThan(result.positions["/js/query-history-migration-coordinator.js"]);
  for (const dependency of [
    "/js/query-event-repository.js",
    "/js/history-baseline-repository.js",
    "/js/query-history-migration-coordinator.js",
    "/js/query-history-projector.js"
  ]) {
    expect(result.positions[dependency]).toBeLessThan(result.positions["/js/main.js"]);
  }
});

test("首次查询先收口 Migration，再调用 append，并只由 Projector 生成 Vocab", async ({ page }) => {
  const result = await page.evaluate(migrationKey => {
    const originalEvents = window.LingoFlowQueryEventRepository;
    const originalCoordinator = window.LingoFlowQueryHistoryMigrationCoordinator;
    const originalProjector = window.LingoFlowQueryHistoryProjector;
    let migrationCalls = 0;
    let appendCalls = 0;
    let projectCalls = 0;
    let stateAtAppend = null;

    window.LingoFlowQueryEventRepository = Object.freeze({
      ...originalEvents,
      append(...args) {
        appendCalls += 1;
        stateAtAppend = JSON.parse(localStorage.getItem(migrationKey) || "null");
        return originalEvents.append(...args);
      }
    });
    window.LingoFlowQueryHistoryMigrationCoordinator = Object.freeze({
      ...originalCoordinator,
      ensureCompleted(...args) {
        migrationCalls += 1;
        return originalCoordinator.ensureCompleted(...args);
      }
    });
    window.LingoFlowQueryHistoryProjector = Object.freeze({
      project(...args) {
        projectCalls += 1;
        return originalProjector.project(...args);
      }
    });

    let event;
    try {
      event = addToVocab("Develop", {
        baseWord: "develop",
        phonetic: "/dɪˈveləp/",
        pos: "verb",
        meaning: "发展"
      }, "article");
    } finally {
      window.LingoFlowQueryEventRepository = originalEvents;
      window.LingoFlowQueryHistoryMigrationCoordinator = originalCoordinator;
      window.LingoFlowQueryHistoryProjector = originalProjector;
    }

    return {
      migrationCalls,
      appendCalls,
      projectCalls,
      stateAtAppend,
      event,
      events: originalEvents.list(),
      baselines: window.LingoFlowHistoryBaselineRepository.list(),
      vocab: getVocabData()
    };
  }, MIGRATION_STATE_KEY);

  expect(result.migrationCalls).toBe(1);
  expect(result.appendCalls).toBe(1);
  expect(result.projectCalls).toBe(1);
  expect(result.stateAtAppend).toEqual(MIGRATION_COMPLETED);
  expect(result.events).toHaveLength(1);
  expect(result.events[0]).toEqual(result.event);
  expect(result.baselines).toEqual([]);
  expect(result.vocab.develop).toMatchObject({
    count: 1,
    articleCount: 1,
    searchCount: 0
  });
});

test("连续现代查询一事一 Event，空 aggregation word 仍保存但不生成空 Vocab key", async ({ page }) => {
  const result = await page.evaluate(() => {
    const dictionaryResult = {
      baseWord: "develop",
      phonetic: "/dɪˈveləp/",
      pos: "verb",
      meaning: "发展"
    };
    addToVocab("Develop", dictionaryResult, "article");
    addToVocab("develop", dictionaryResult, "search");
    addToVocab("Develop", dictionaryResult, "article");
    addToVocab("中文", null, "search");
    return {
      events: window.LingoFlowQueryEventRepository.list(),
      baselines: window.LingoFlowHistoryBaselineRepository.list(),
      vocab: getVocabData()
    };
  });

  expect(result.events).toHaveLength(4);
  expect(new Set(result.events.map(event => event.id)).size).toBe(4);
  expect(result.events.filter(event => event.word === "develop")).toHaveLength(3);
  expect(result.events.find(event => event.word === "")).toMatchObject({
    displayWord: "中文",
    dictionaryFound: false,
    source: "search"
  });
  expect(result.baselines).toEqual([]);
  expect(Object.hasOwn(result.vocab, "")).toBe(false);
  expect(result.vocab.develop).toMatchObject({
    count: 3,
    articleCount: 2,
    searchCount: 1
  });
});

test("legacy-only 用户先建立一次 Baseline，再追加现代 Event 并正确投影", async ({ page }) => {
  const legacyVocab = {
    develop: {
      word: "develop",
      count: 4,
      articleCount: 3,
      searchCount: 1,
      firstSeen: "2025-01-01T00:00:00.000Z",
      lastSeen: "2025-02-01T00:00:00.000Z",
      displayWord: "Develop",
      phonetic: "/dɪˈveləp/",
      pos: "verb",
      meaning: "发展",
      dictionaryFound: true,
      source: "article"
    }
  };
  await replaceHistoryAndReload(page, { vocab: legacyVocab });

  const result = await page.evaluate(() => {
    const before = window.LingoFlowHistoryBaselineRepository.list();
    addToVocab("Develop", {
      baseWord: "develop",
      phonetic: "/dɪˈveləp/",
      pos: "verb",
      meaning: "发展"
    }, "search");
    return {
      before,
      after: window.LingoFlowHistoryBaselineRepository.list(),
      events: window.LingoFlowQueryEventRepository.list(),
      vocab: getVocabData()
    };
  });

  expect(result.before).toHaveLength(1);
  expect(result.after).toEqual(result.before);
  expect(result.events).toHaveLength(1);
  expect(result.vocab.develop).toMatchObject({
    count: 5,
    articleCount: 3,
    searchCount: 2,
    firstSeen: "2025-01-01T00:00:00.000Z"
  });
});

test("已有 Baseline 不会重复迁移，Baseline 与同时间 Event 投影结果确定", async ({ page }) => {
  const baseline = makeBaseline("baseline:existing", {
    "opaque/apple": {
      word: "apple",
      count: 2,
      articleCount: 1,
      searchCount: 1,
      firstSeen: "2020-01-01T00:00:00.000Z",
      lastSeen: "2020-01-02T00:00:00.000Z",
      displayWord: "Legacy Apple",
      meaning: "旧苹果",
      dictionaryFound: true,
      source: "article"
    }
  });
  const eventA = makeEvent("query:a", {
    displayWord: "Apple A",
    meaning: "A",
    source: "article"
  });
  const eventZ = makeEvent("query:z", {
    displayWord: "Apple Z",
    meaning: "Z",
    source: "search"
  });
  await replaceHistoryAndReload(page, {
    events: { [eventZ.id]: eventZ, [eventA.id]: eventA },
    baselines: { [baseline.id]: baseline }
  });

  const result = await page.evaluate(({ eventsKey, first, second }) => {
    rebuildVocabFromMergeData();
    const forward = getVocabData();
    localStorage.setItem(eventsKey, JSON.stringify({
      [first.id]: first,
      [second.id]: second
    }));
    rebuildVocabFromMergeData();
    const reversed = getVocabData();
    const baselinesBeforeQuery = window.LingoFlowHistoryBaselineRepository.list();
    addToVocab("Apple", {
      baseWord: "apple",
      phonetic: "/ˈæpəl/",
      pos: "noun",
      meaning: "苹果"
    }, "search");
    return {
      forward,
      reversed,
      baselinesBeforeQuery,
      baselinesAfterQuery: window.LingoFlowHistoryBaselineRepository.list(),
      eventsAfterQuery: window.LingoFlowQueryEventRepository.list(),
      vocabAfterQuery: getVocabData(),
      migrationState: JSON.parse(
        localStorage.getItem("EnglishReaderV052HistoryMigrationState") || "null"
      )
    };
  }, { eventsKey: QUERY_EVENTS_KEY, first: eventA, second: eventZ });

  expect(result.forward).toEqual(result.reversed);
  expect(result.baselinesBeforeQuery).toEqual([baseline]);
  expect(result.baselinesAfterQuery).toEqual(result.baselinesBeforeQuery);
  expect(result.eventsAfterQuery).toHaveLength(3);
  expect(result.vocabAfterQuery.apple).toMatchObject({
    count: 5,
    articleCount: 2,
    searchCount: 3
  });
  expect(result.migrationState).toEqual(MIGRATION_COMPLETED);
  expect(result.forward.apple).toMatchObject({
    count: 4,
    articleCount: 2,
    searchCount: 2,
    firstSeen: "2020-01-01T00:00:00.000Z",
    lastSeen: eventZ.timestamp,
    displayWord: "Apple Z",
    meaning: "Z",
    source: "search"
  });
});

test("按 word 删除同时移除 Event 与 opaque-locator Baseline record 后重新投影", async ({ page }) => {
  const appleEvent = makeEvent("query:remove-apple");
  const bananaEvent = makeEvent("query:keep-banana", {
    word: "banana",
    displayWord: "Banana",
    meaning: "香蕉",
    timestamp: "2026-08-28T11:00:00.000Z"
  });
  const baseline = makeBaseline("baseline:opaque-delete", {
    lemma: { word: "apple", count: 5 },
    "not-normalizeWord(apple)": { word: "apple", count: 2 },
    "opaque/pear": { word: "pear", count: 3 }
  });
  await replaceHistoryAndReload(page, {
    events: {
      [appleEvent.id]: appleEvent,
      [bananaEvent.id]: bananaEvent
    },
    baselines: { [baseline.id]: baseline }
  });

  const result = await page.evaluate(() => {
    rebuildVocabFromMergeData();
    removeVocabWord("apple");
    return {
      events: window.LingoFlowQueryEventRepository.list(),
      baselines: window.LingoFlowHistoryBaselineRepository.list(),
      vocab: getVocabData()
    };
  });

  expect(result.events.map(event => event.id)).toEqual([bananaEvent.id]);
  expect(result.baselines).toHaveLength(1);
  expect(result.baselines[0].id).toBe(baseline.id);
  expect(result.baselines[0].records).toEqual({
    "opaque/pear": { word: "pear", count: 3 }
  });
  expect(result.vocab.apple).toBeUndefined();
  expect(result.vocab.banana).toMatchObject({ count: 1 });
  expect(result.vocab.pear).toMatchObject({ count: 3 });
});

test("清空查询历史通过两个 Repository 删除 facts、清空 Vocab 并保留 Migration State", async ({ page }) => {
  const event = makeEvent("query:clear");
  const baseline = makeBaseline("baseline:clear", {
    "opaque-clear": { word: "pear", count: 2 }
  });
  await replaceHistoryAndReload(page, {
    events: { [event.id]: event },
    baselines: { [baseline.id]: baseline },
    migrationState: MIGRATION_COMPLETED
  });

  const result = await page.evaluate(() => {
    rebuildVocabFromMergeData();
    const beforeState = localStorage.getItem("EnglishReaderV052HistoryMigrationState");
    const originalConfirm = window.confirm;
    window.confirm = () => true;
    try {
      clearVocabBook();
    } finally {
      window.confirm = originalConfirm;
    }
    return {
      events: window.LingoFlowQueryEventRepository.list(),
      baselines: window.LingoFlowHistoryBaselineRepository.list(),
      vocab: getVocabData(),
      beforeState,
      afterState: localStorage.getItem("EnglishReaderV052HistoryMigrationState"),
      eventRaw: localStorage.getItem("EnglishReaderV052QueryEvents"),
      baselineRaw: localStorage.getItem("EnglishReaderV052HistoryBaselines")
    };
  });

  expect(result.events).toEqual([]);
  expect(result.baselines).toEqual([]);
  expect(result.vocab).toEqual({});
  expect(result.afterState).toBe(result.beforeState);
  expect(JSON.parse(result.afterState)).toEqual(MIGRATION_COMPLETED);
  expect(result.eventRaw).toBeNull();
  expect(result.baselineRaw).toBeNull();
});

test("malformed QueryEvent 或 Baseline 会阻断新事实且保留最后可用 Vocab", async ({ page }) => {
  const result = await page.evaluate(keys => {
    const migrationState = JSON.stringify({ version: 1, status: "completed" });
    const sentinel = JSON.stringify({
      protected: { word: "protected", count: 9, marker: "keep-exactly" }
    });
    const attempts = [];

    const attempt = (eventsRaw, baselinesRaw) => {
      localStorage.setItem(keys.migrationState, migrationState);
      localStorage.setItem(keys.vocab, sentinel);
      localStorage.setItem(keys.events, eventsRaw);
      localStorage.setItem(keys.baselines, baselinesRaw);
      let code = null;
      try {
        addToVocab("Develop", {
          baseWord: "develop",
          pos: "verb",
          meaning: "发展"
        }, "search");
      } catch (error) {
        code = error.code || error.name;
      }
      attempts.push({
        code,
        vocabRaw: localStorage.getItem(keys.vocab),
        eventsRaw: localStorage.getItem(keys.events),
        baselinesRaw: localStorage.getItem(keys.baselines)
      });
    };

    attempt("not-json-events", "{}");
    attempt("{}", "not-json-baselines");
    return { attempts, sentinel };
  }, {
    vocab: VOCAB_KEY,
    events: QUERY_EVENTS_KEY,
    baselines: HISTORY_BASELINES_KEY,
    migrationState: MIGRATION_STATE_KEY
  });

  expect(result.attempts[0]).toMatchObject({
    code: "query-event-storage-malformed",
    vocabRaw: result.sentinel,
    eventsRaw: "not-json-events",
    baselinesRaw: "{}"
  });
  expect(result.attempts[1]).toMatchObject({
    code: "history-baseline-storage-malformed",
    vocabRaw: result.sentinel,
    eventsRaw: "{}",
    baselinesRaw: "not-json-baselines"
  });
});

test("storage 读取失败不会被视为空 facts，也不会创建 QueryEvent", async ({ page }) => {
  const result = await page.evaluate(keys => {
    localStorage.setItem(keys.migrationState, JSON.stringify({
      version: 1,
      status: "completed"
    }));
    localStorage.setItem(keys.events, "{}");
    localStorage.setItem(keys.baselines, "{}");
    const vocabRaw = JSON.stringify({
      protected: { word: "protected", count: 6 }
    });
    localStorage.setItem(keys.vocab, vocabRaw);

    const originalGetItem = Storage.prototype.getItem;
    let code = null;
    Storage.prototype.getItem = function(key) {
      if (key === keys.baselines) throw new Error("forced baseline read failure");
      return originalGetItem.call(this, key);
    };
    try {
      addToVocab("Develop", null, "search");
    } catch (error) {
      code = error.code || error.name;
    } finally {
      Storage.prototype.getItem = originalGetItem;
    }

    return {
      code,
      eventsRaw: localStorage.getItem(keys.events),
      baselinesRaw: localStorage.getItem(keys.baselines),
      vocabAfter: localStorage.getItem(keys.vocab),
      vocabRaw
    };
  }, {
    vocab: VOCAB_KEY,
    events: QUERY_EVENTS_KEY,
    baselines: HISTORY_BASELINES_KEY,
    migrationState: MIGRATION_STATE_KEY
  });

  expect(result).toEqual({
    code: "history-baseline-storage-read-failed",
    eventsRaw: "{}",
    baselinesRaw: "{}",
    vocabAfter: result.vocabRaw,
    vocabRaw: result.vocabRaw
  });
});

test("Event 写入成功但 Vocab 写入失败时保留 immutable Event 与旧派生视图", async ({ page }) => {
  const result = await page.evaluate(keys => {
    localStorage.setItem(keys.migrationState, JSON.stringify({
      version: 1,
      status: "completed"
    }));
    const previousVocabRaw = JSON.stringify({
      protected: { word: "protected", count: 4 }
    });
    localStorage.setItem(keys.vocab, previousVocabRaw);

    const originalSetItem = Storage.prototype.setItem;
    let code = null;
    Storage.prototype.setItem = function(key, value) {
      if (key === keys.vocab) throw new Error("forced vocab write failure");
      return originalSetItem.call(this, key, value);
    };
    try {
      addToVocab("Develop", {
        baseWord: "develop",
        pos: "verb",
        meaning: "发展"
      }, "article");
    } catch (error) {
      code = error.name;
    } finally {
      Storage.prototype.setItem = originalSetItem;
    }

    return {
      code,
      events: window.LingoFlowQueryEventRepository.list(),
      vocabRaw: localStorage.getItem(keys.vocab),
      previousVocabRaw
    };
  }, {
    vocab: VOCAB_KEY,
    migrationState: MIGRATION_STATE_KEY
  });

  expect(result.code).toBe("Error");
  expect(result.events).toHaveLength(1);
  expect(result.events[0]).toMatchObject({
    word: "develop",
    source: "article"
  });
  expect(result.vocabRaw).toBe(result.previousVocabRaw);
});

test("未迁移 legacy Vocab 遇到 malformed fact namespace 时保持边界开放，修复后才迁移并追加", async ({ page }) => {
  const result = await page.evaluate(keys => {
    const legacyVocab = {
      develop: {
        word: "develop",
        count: 3,
        articleCount: 2,
        searchCount: 1,
        firstSeen: "2025-03-01T00:00:00.000Z",
        lastSeen: "2025-03-02T00:00:00.000Z",
        displayWord: "Develop",
        phonetic: "/dɪˈveləp/",
        pos: "verb",
        meaning: "发展",
        dictionaryFound: true,
        source: "article"
      }
    };
    const legacyRaw = JSON.stringify(legacyVocab);

    const runScenario = brokenName => {
      for (const key of Object.values(keys)) localStorage.removeItem(key);
      localStorage.setItem(keys.vocab, legacyRaw);
      localStorage.setItem(keys[brokenName], `malformed-${brokenName}`);

      let firstError = null;
      try {
        addToVocab("Develop", {
          baseWord: "develop",
          phonetic: "/dɪˈveləp/",
          pos: "verb",
          meaning: "发展"
        }, "search");
      } catch (error) {
        firstError = error.code || error.name;
      }

      const afterFailure = {
        firstError,
        migrationStateRaw: localStorage.getItem(keys.migrationState),
        vocabRaw: localStorage.getItem(keys.vocab),
        eventsRaw: localStorage.getItem(keys.events),
        baselinesRaw: localStorage.getItem(keys.baselines)
      };

      localStorage.removeItem(keys[brokenName]);
      addToVocab("Develop", {
        baseWord: "develop",
        phonetic: "/dɪˈveləp/",
        pos: "verb",
        meaning: "发展"
      }, "search");
      return {
        afterFailure,
        afterRepair: {
          migrationState: JSON.parse(
            localStorage.getItem(keys.migrationState) || "null"
          ),
          vocab: getVocabData(),
          events: window.LingoFlowQueryEventRepository.list(),
          baselines: window.LingoFlowHistoryBaselineRepository.list()
        }
      };
    };

    return {
      legacyRaw,
      malformedEvents: runScenario("events"),
      malformedBaselines: runScenario("baselines")
    };
  }, {
    vocab: VOCAB_KEY,
    events: QUERY_EVENTS_KEY,
    baselines: HISTORY_BASELINES_KEY,
    migrationState: MIGRATION_STATE_KEY
  });

  for (const [brokenName, scenario] of [
    ["events", result.malformedEvents],
    ["baselines", result.malformedBaselines]
  ]) {
    expect(scenario.afterFailure.firstError)
      .toBe("query-history-migration-prerequisite-failed");
    expect(scenario.afterFailure.migrationStateRaw).toBeNull();
    expect(scenario.afterFailure.vocabRaw).toBe(result.legacyRaw);
    expect(scenario.afterFailure[`${brokenName}Raw`]).toBe(`malformed-${brokenName}`);
    const otherRaw = brokenName === "events"
      ? scenario.afterFailure.baselinesRaw
      : scenario.afterFailure.eventsRaw;
    expect(otherRaw).toBeNull();

    expect(scenario.afterRepair.migrationState).toEqual(MIGRATION_COMPLETED);
    expect(scenario.afterRepair.events).toHaveLength(1);
    expect(scenario.afterRepair.baselines).toHaveLength(1);
    expect(scenario.afterRepair.baselines[0]).toMatchObject({
      id: expect.stringMatching(/^legacy-local:/),
      deviceId: "legacy-local",
      records: JSON.parse(result.legacyRaw)
    });
    expect(scenario.afterRepair.vocab.develop).toMatchObject({
      count: 4,
      articleCount: 2,
      searchCount: 2
    });
  }
});

test("旧 full NDJSON vocab-only restore 显式转换 Baseline、清空旧 Event 并保留 migration state", async ({ page }) => {
  const oldEvent = makeEvent("query:local-before-full-restore", {
    word: "local",
    displayWord: "Local",
    meaning: "本地旧事件"
  });
  await replaceHistoryAndReload(page, {
    events: { [oldEvent.id]: oldEvent },
    migrationState: MIGRATION_COMPLETED
  });

  const result = await page.evaluate(async ({ keys, completedState }) => {
    const legacyVocab = {
      develop: {
        word: "develop",
        count: 6,
        articleCount: 4,
        searchCount: 2,
        firstSeen: "2024-01-01T00:00:00.000Z",
        lastSeen: "2024-06-01T00:00:00.000Z",
        displayWord: "Develop",
        phonetic: "/dɪˈveləp/",
        pos: "verb",
        meaning: "发展",
        dictionaryFound: true,
        source: "search"
      }
    };
    const lines = [
      {
        type: "header",
        app: "EnglishReader",
        version: "0.5.1",
        createdAt: "2025-01-02T03:04:05.000Z"
      },
      { type: "vocab", data: legacyVocab },
      { type: "footer", entryCount: 0, lemmaCount: 0 }
    ];
    const file = new File(
      [lines.map(line => JSON.stringify(line)).join("\n") + "\n"],
      "legacy-vocab-only.erbackup",
      {
        type: "application/x-ndjson",
        lastModified: Date.parse("2025-01-02T03:04:05.000Z")
      }
    );
    const stateBefore = localStorage.getItem(keys.migrationState);

    const originals = {
      confirm: window.confirm,
      clearECDICTEntries: window.clearECDICTEntries,
      clearLemmaEntries: window.clearLemmaEntries,
      setECDICTMeta: window.setECDICTMeta,
      refreshDictionaryStatus: window.refreshDictionaryStatus
    };
    window.confirm = () => true;
    window.clearECDICTEntries = async () => {};
    window.clearLemmaEntries = async () => {};
    window.setECDICTMeta = async () => {};
    window.refreshDictionaryStatus = async () => {};
    try {
      await importBackupFile(file, "full");
    } finally {
      Object.assign(window, originals);
    }

    const baselinesAfterRestore = window.LingoFlowHistoryBaselineRepository.list();
    const eventsAfterRestore = window.LingoFlowQueryEventRepository.list();
    const vocabAfterRestore = getVocabData();
    const stateAfterRestore = localStorage.getItem(keys.migrationState);

    addToVocab("Develop", {
      baseWord: "develop",
      phonetic: "/dɪˈveləp/",
      pos: "verb",
      meaning: "发展"
    }, "search");

    return {
      completedState,
      legacyVocab,
      stateBefore,
      stateAfterRestore,
      baselinesAfterRestore,
      eventsAfterRestore,
      vocabAfterRestore,
      baselinesAfterQuery: window.LingoFlowHistoryBaselineRepository.list(),
      eventsAfterQuery: window.LingoFlowQueryEventRepository.list(),
      vocabAfterQuery: getVocabData()
    };
  }, {
    keys: {
      migrationState: MIGRATION_STATE_KEY
    },
    completedState: MIGRATION_COMPLETED
  });

  expect(JSON.parse(result.stateBefore)).toEqual(result.completedState);
  expect(result.stateAfterRestore).toBe(result.stateBefore);
  expect(result.eventsAfterRestore).toEqual([]);
  expect(result.baselinesAfterRestore).toHaveLength(1);
  expect(result.baselinesAfterRestore[0]).toMatchObject({
    id: expect.stringMatching(/^legacy-import:/),
    createdAt: "2025-01-02T03:04:05.000Z",
    deviceId: "legacy-import",
    records: result.legacyVocab
  });
  expect(result.vocabAfterRestore.develop).toMatchObject({ count: 6 });
  expect(result.baselinesAfterQuery).toEqual(result.baselinesAfterRestore);
  expect(result.eventsAfterQuery).toHaveLength(1);
  expect(result.vocabAfterQuery.develop).toMatchObject({
    count: 7,
    articleCount: 4,
    searchCount: 3
  });
  expect(result.vocabAfterQuery.local).toBeUndefined();
});

test("legacy backup 继续读写 map，Query History 仍未注册进 Backup v2 Envelope", async ({ page }) => {
  const event = makeEvent("query:legacy-backup");
  const baseline = makeBaseline("baseline:legacy-backup", {
    "legacy/locator": { word: "apple", count: 2 }
  });
  await replaceHistoryAndReload(page, {
    events: { [event.id]: event },
    baselines: { [baseline.id]: baseline },
    migrationState: MIGRATION_COMPLETED
  });

  const result = await page.evaluate(async ({ eventId, baselineId }) => {
    const originalDownload = window.downloadBlob;
    let captured = null;
    window.downloadBlob = (blob, filename) => {
      captured = { blob, filename };
    };
    try {
      await exportLearningBackup();
    } finally {
      window.downloadBlob = originalDownload;
    }
    const payload = JSON.parse(await captured.blob.text());
    const envelopeResult = window.LingoFlowBackupV2Envelope.buildEnvelope({
      articles: [],
      queryEvents: []
    });
    return {
      backupType: payload.backupType,
      version: payload.version,
      queryEventsIsMap: !Array.isArray(payload.queryEvents),
      baselineIsMap: !Array.isArray(payload.historyBaselines),
      queryEvent: payload.queryEvents[eventId],
      baseline: payload.historyBaselines[baselineId],
      v2Status: envelopeResult.status,
      filename: captured.filename
    };
  }, { eventId: event.id, baselineId: baseline.id });

  expect(result).toMatchObject({
    backupType: "learning",
    version: "0.5.2",
    queryEventsIsMap: true,
    baselineIsMap: true,
    queryEvent: event,
    baseline,
    v2Status: "rejected"
  });
  expect(result.filename).toMatch(/^english-reader-learning-\d{4}-\d{2}-\d{2}\.json$/);
});
