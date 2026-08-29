const { test, expect } = require("@playwright/test");

const VOCAB_KEY = "EnglishReaderV05Vocab";
const QUERY_EVENTS_KEY = "EnglishReaderV052QueryEvents";
const HISTORY_BASELINES_KEY = "EnglishReaderV052HistoryBaselines";
const MIGRATION_STATE_KEY = "EnglishReaderV052HistoryMigrationState";
const COMPLETED_STATE = { version: 1, status: "completed" };
const projectErrors = new WeakMap();

const STORAGE_KEYS = {
  vocab: VOCAB_KEY,
  events: QUERY_EVENTS_KEY,
  baselines: HISTORY_BASELINES_KEY,
  migrationState: MIGRATION_STATE_KEY
};

function makeEvent(id = "query:existing") {
  return {
    id,
    deviceId: "device:coordinator-test",
    word: "apple",
    displayWord: "Apple",
    phonetic: "/ˈæpəl/",
    pos: "noun",
    meaning: "苹果",
    dictionaryFound: true,
    source: "article",
    timestamp: "2026-08-28T10:00:00.000Z"
  };
}

function makeLegacyVocab() {
  return {
    "opaque/legacy-locator": {
      word: "apple",
      count: 4,
      articleCount: 2,
      searchCount: 1,
      firstSeen: "2026-07-01T10:00:00.000Z",
      lastSeen: "2026-07-03T10:00:00.000Z",
      displayWord: "Apple",
      phonetic: "/ˈæpəl/",
      pos: "noun",
      meaning: "苹果",
      dictionaryFound: true,
      source: "legacy"
    }
  };
}

function makeBaseline(id = "baseline:existing") {
  return {
    id,
    createdAt: "2026-08-20T10:00:00.000Z",
    deviceId: "legacy:coordinator-test",
    records: {
      "opaque-existing-locator": {
        word: "pear",
        count: 2
      }
    }
  };
}

async function resetHistory(page, seed = {}) {
  await page.evaluate(({ keys, values }) => {
    for (const key of Object.values(keys)) localStorage.removeItem(key);
    for (const [name, value] of Object.entries(values)) {
      localStorage.setItem(
        keys[name],
        typeof value === "string" ? value : JSON.stringify(value)
      );
    }
  }, { keys: STORAGE_KEYS, values: seed });
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
  await expect(page.locator("#inputText")).toBeVisible();
  await resetHistory(page);
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

test("Coordinator API 冻结并提供 prepare/finalize/ensureCompleted", async ({ page }) => {
  const result = await page.evaluate(() => {
    const coordinator = window.LingoFlowQueryHistoryMigrationCoordinator;
    return {
      frozen: Object.isFrozen(coordinator),
      prepare: typeof coordinator.prepare,
      finalize: typeof coordinator.finalize,
      ensureCompleted: typeof coordinator.ensureCompleted
    };
  });
  expect(result).toEqual({
    frozen: true,
    prepare: "function",
    finalize: "function",
    ensureCompleted: "function"
  });
});

test("合法 completed state 立即返回且不读取 facts 或写入 storage", async ({ page }) => {
  await resetHistory(page, {
    migrationState: COMPLETED_STATE,
    vocab: makeLegacyVocab()
  });
  const result = await page.evaluate(keys => {
    const originalEvents = window.LingoFlowQueryEventRepository;
    const originalBaselines = window.LingoFlowHistoryBaselineRepository;
    const originalSetItem = Storage.prototype.setItem;
    let factReads = 0;
    let writes = 0;
    window.LingoFlowQueryEventRepository = Object.freeze({
      ...originalEvents,
      list() {
        factReads += 1;
        return originalEvents.list();
      }
    });
    window.LingoFlowHistoryBaselineRepository = Object.freeze({
      ...originalBaselines,
      list() {
        factReads += 1;
        return originalBaselines.list();
      }
    });
    Storage.prototype.setItem = function(key, value) {
      if (Object.values(keys).includes(key)) writes += 1;
      return originalSetItem.call(this, key, value);
    };
    try {
      return {
        migration: window.LingoFlowQueryHistoryMigrationCoordinator.ensureCompleted(),
        factReads,
        writes,
        baselineRaw: localStorage.getItem(keys.baselines)
      };
    } finally {
      window.LingoFlowQueryEventRepository = originalEvents;
      window.LingoFlowHistoryBaselineRepository = originalBaselines;
      Storage.prototype.setItem = originalSetItem;
    }
  }, STORAGE_KEYS);

  expect(result.migration).toMatchObject({
    status: "completed",
    outcome: "already-completed",
    baselineWritten: false,
    migrationStateWritten: false,
    reason: null
  });
  expect(result.factReads).toBe(0);
  expect(result.writes).toBe(0);
  expect(result.baselineRaw).toBeNull();
});

test("malformed 或 unsupported Migration State 明确失败且原样保留", async ({ page }) => {
  const raws = [
    "{not-json",
    "null",
    "[]",
    JSON.stringify({ version: 2, status: "completed" }),
    JSON.stringify({ version: 1, status: "pending" }),
    JSON.stringify({ version: 1, status: "completed", extra: true })
  ];
  const result = await page.evaluate(({ key, values }) => values.map(raw => {
    localStorage.removeItem("EnglishReaderV052QueryEvents");
    localStorage.removeItem("EnglishReaderV052HistoryBaselines");
    localStorage.setItem(key, raw);
    const migration = window.LingoFlowQueryHistoryMigrationCoordinator.ensureCompleted();
    return { raw, migration, after: localStorage.getItem(key) };
  }), { key: MIGRATION_STATE_KEY, values: raws });

  for (const item of result) {
    expect(item.migration.status).toBe("failed");
    expect(item.migration.reason).toMatch(
      /^history-migration-state-(malformed|invalid)$/
    );
    expect(item.after).toBe(item.raw);
  }
});

test("Migration State storage read failure 不会被当作 missing", async ({ page }) => {
  const result = await page.evaluate(key => {
    const originalGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function(candidate) {
      if (candidate === key) throw new DOMException("state read blocked", "SecurityError");
      return originalGetItem.call(this, candidate);
    };
    try {
      return window.LingoFlowQueryHistoryMigrationCoordinator.ensureCompleted();
    } finally {
      Storage.prototype.getItem = originalGetItem;
    }
  }, MIGRATION_STATE_KEY);
  expect(result).toMatchObject({
    status: "failed",
    reason: "history-migration-state-storage-read-failed",
    baselineWritten: false,
    migrationStateWritten: false
  });
});

test("state missing 且已有 QueryEvent 时不包装 Vocab并收口 state", async ({ page }) => {
  const event = makeEvent();
  await resetHistory(page, {
    events: { [event.id]: event },
    vocab: makeLegacyVocab()
  });
  const result = await page.evaluate(keys => ({
    migration: window.LingoFlowQueryHistoryMigrationCoordinator.ensureCompleted(),
    baselines: window.LingoFlowHistoryBaselineRepository.list(),
    state: JSON.parse(localStorage.getItem(keys.migrationState))
  }), STORAGE_KEYS);
  expect(result.migration).toMatchObject({
    status: "completed",
    outcome: "completed-from-existing-query-events",
    baselineWritten: false,
    migrationStateWritten: true
  });
  expect(result.baselines).toEqual([]);
  expect(result.state).toEqual(COMPLETED_STATE);
});

test("state missing 且已有 History Baseline 时不重复迁移并收口 state", async ({ page }) => {
  const baseline = makeBaseline();
  await resetHistory(page, {
    baselines: { [baseline.id]: baseline },
    vocab: makeLegacyVocab()
  });
  const result = await page.evaluate(keys => ({
    migration: window.LingoFlowQueryHistoryMigrationCoordinator.ensureCompleted(),
    baselines: window.LingoFlowHistoryBaselineRepository.list(),
    state: JSON.parse(localStorage.getItem(keys.migrationState))
  }), STORAGE_KEYS);
  expect(result.migration).toMatchObject({
    status: "completed",
    outcome: "completed-from-existing-baseline",
    baselineWritten: false,
    migrationStateWritten: true,
    historyBaselineId: baseline.id
  });
  expect(result.baselines).toEqual([baseline]);
  expect(result.state).toEqual(COMPLETED_STATE);
});

test("空环境 prepare 不写 state，finalize 才安全收口", async ({ page }) => {
  const result = await page.evaluate(keys => {
    const coordinator = window.LingoFlowQueryHistoryMigrationCoordinator;
    const prepared = coordinator.prepare();
    const stateAfterPrepare = localStorage.getItem(keys.migrationState);
    const finalized = coordinator.finalize(prepared.token);
    return {
      prepared: { ...prepared, token: Boolean(prepared.token) },
      stateAfterPrepare,
      finalized,
      finalState: JSON.parse(localStorage.getItem(keys.migrationState)),
      baselines: window.LingoFlowHistoryBaselineRepository.list()
    };
  }, STORAGE_KEYS);
  expect(result.prepared).toMatchObject({
    status: "ready",
    outcome: "completed-no-legacy-data",
    baselineWritten: false,
    migrationStateWritten: false,
    legacyVocabStatus: "missing",
    token: true
  });
  expect(result.stateAfterPrepare).toBeNull();
  expect(result.finalized).toMatchObject({
    status: "completed",
    outcome: "completed-no-legacy-data",
    migrationStateWritten: true
  });
  expect(result.finalState).toEqual(COMPLETED_STATE);
  expect(result.baselines).toEqual([]);
});

test("已存储的合法空 Vocab 与 missing 明确区分，且不生成 Baseline", async ({ page }) => {
  await resetHistory(page, { vocab: {} });
  const result = await page.evaluate(keys => ({
    migration: window.LingoFlowQueryHistoryMigrationCoordinator.ensureCompleted(),
    baselineRaw: localStorage.getItem(keys.baselines),
    state: JSON.parse(localStorage.getItem(keys.migrationState))
  }), STORAGE_KEYS);
  expect(result.migration).toMatchObject({
    status: "completed",
    outcome: "completed-no-legacy-data",
    legacyVocabStatus: "empty",
    baselineWritten: false,
    migrationStateWritten: true
  });
  expect(result.baselineRaw).toBeNull();
  expect(result.state).toEqual(COMPLETED_STATE);
});

test("重复 finalize 会重新严格确认 state，并准确报告本次写入", async ({ page }) => {
  const result = await page.evaluate(key => {
    const coordinator = window.LingoFlowQueryHistoryMigrationCoordinator;
    const prepared = coordinator.prepare();
    const first = coordinator.finalize(prepared.token);
    const second = coordinator.finalize(prepared.token);
    localStorage.setItem(key, JSON.stringify({ version: 1, status: "broken" }));
    const malformed = coordinator.finalize(prepared.token);
    const malformedRaw = localStorage.getItem(key);
    localStorage.removeItem(key);
    const repaired = coordinator.finalize(prepared.token);
    return {
      first,
      second,
      malformed,
      malformedRaw,
      repaired,
      finalState: JSON.parse(localStorage.getItem(key))
    };
  }, MIGRATION_STATE_KEY);

  expect(result.first).toMatchObject({
    status: "completed",
    migrationStateWritten: true
  });
  expect(result.second).toMatchObject({
    status: "completed",
    outcome: "already-completed",
    migrationStateWritten: false
  });
  expect(result.malformed).toMatchObject({
    status: "failed",
    reason: "history-migration-state-invalid",
    migrationStateWritten: false
  });
  expect(result.malformedRaw).toBe(JSON.stringify({ version: 1, status: "broken" }));
  expect(result.repaired).toMatchObject({
    status: "completed",
    outcome: "completed-no-legacy-data",
    migrationStateWritten: true
  });
  expect(result.finalState).toEqual(COMPLETED_STATE);
});

test("legacy-only Vocab 先经 Schema 保存为 Baseline，再收口 state", async ({ page }) => {
  const legacyVocab = makeLegacyVocab();
  await resetHistory(page, { vocab: legacyVocab });
  const result = await page.evaluate(keys => {
    const coordinator = window.LingoFlowQueryHistoryMigrationCoordinator;
    const prepared = coordinator.prepare();
    const baselinesAfterPrepare = window.LingoFlowHistoryBaselineRepository.list();
    const validation = baselinesAfterPrepare.length
      ? window.LingoFlowHistoryBaselineBackupSchema
        .validateHistoryBaseline(baselinesAfterPrepare[0])
      : null;
    const stateAfterPrepare = localStorage.getItem(keys.migrationState);
    const finalized = coordinator.finalize(prepared.token);
    return {
      prepared: { ...prepared, token: Boolean(prepared.token) },
      finalized,
      baselinesAfterPrepare,
      validationStatus: validation?.status,
      stateAfterPrepare,
      finalState: JSON.parse(localStorage.getItem(keys.migrationState)),
      vocab: JSON.parse(localStorage.getItem(keys.vocab))
    };
  }, STORAGE_KEYS);

  expect(result.prepared).toMatchObject({
    status: "ready",
    outcome: "migrated-legacy-vocab",
    baselineWritten: true,
    migrationStateWritten: false,
    historyBaselineId: expect.stringMatching(/^legacy-local:/),
    token: true
  });
  expect(result.stateAfterPrepare).toBeNull();
  expect(result.baselinesAfterPrepare).toHaveLength(1);
  expect(result.baselinesAfterPrepare[0].records).toEqual(legacyVocab);
  expect(result.validationStatus).toBe("valid");
  expect(result.finalized).toMatchObject({
    status: "completed",
    outcome: "migrated-legacy-vocab",
    baselineWritten: true,
    migrationStateWritten: true
  });
  expect(result.finalState).toEqual(COMPLETED_STATE);
  expect(result.vocab).toEqual(legacyVocab);
});

test("空 QueryEvent storage 不是现代 fact，不会提前关闭 legacy migration", async ({ page }) => {
  const legacyVocab = makeLegacyVocab();
  await resetHistory(page, { events: {}, vocab: legacyVocab });
  const result = await page.evaluate(() => ({
    migration: window.LingoFlowQueryHistoryMigrationCoordinator.ensureCompleted(),
    events: window.LingoFlowQueryEventRepository.list(),
    baselines: window.LingoFlowHistoryBaselineRepository.list()
  }));
  expect(result.migration).toMatchObject({
    status: "completed",
    outcome: "migrated-legacy-vocab",
    baselineWritten: true,
    migrationStateWritten: true
  });
  expect(result.events).toEqual([]);
  expect(result.baselines).toHaveLength(1);
  expect(result.baselines[0].records).toEqual(legacyVocab);
});

test("malformed legacy Vocab 和 storage read failure 都保持 migration open", async ({ page }) => {
  await resetHistory(page, { vocab: "{not-json" });
  const malformed = await page.evaluate(keys => ({
    migration: window.LingoFlowQueryHistoryMigrationCoordinator.ensureCompleted(),
    baselineRaw: localStorage.getItem(keys.baselines),
    stateRaw: localStorage.getItem(keys.migrationState),
    vocabRaw: localStorage.getItem(keys.vocab)
  }), STORAGE_KEYS);
  expect(malformed).toMatchObject({
    migration: {
      status: "failed",
      reason: "history-migration-vocab-malformed",
      baselineWritten: false,
      migrationStateWritten: false
    },
    baselineRaw: null,
    stateRaw: null,
    vocabRaw: "{not-json"
  });

  await resetHistory(page, { vocab: "[]" });
  const invalidRoot = await page.evaluate(() => (
    window.LingoFlowQueryHistoryMigrationCoordinator.ensureCompleted()
  ));
  expect(invalidRoot).toMatchObject({
    status: "failed",
    reason: "history-migration-vocab-invalid-root",
    baselineWritten: false,
    migrationStateWritten: false
  });

  await resetHistory(page, { vocab: makeLegacyVocab() });
  const readFailure = await page.evaluate(key => {
    const originalGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function(candidate) {
      if (candidate === key) throw new DOMException("vocab read blocked", "SecurityError");
      return originalGetItem.call(this, candidate);
    };
    try {
      return window.LingoFlowQueryHistoryMigrationCoordinator.ensureCompleted();
    } finally {
      Storage.prototype.getItem = originalGetItem;
    }
  }, VOCAB_KEY);
  expect(readFailure).toMatchObject({
    status: "failed",
    reason: "history-migration-vocab-storage-read-failed",
    baselineWritten: false,
    migrationStateWritten: false
  });
});

test("Schema 拒绝 Baseline candidate 时不写 Baseline、不收口、不修改 Vocab", async ({ page }) => {
  const invalidVocab = {
    apple: { word: "apple", count: "4" }
  };
  await resetHistory(page, { vocab: invalidVocab });
  const result = await page.evaluate(keys => ({
    migration: window.LingoFlowQueryHistoryMigrationCoordinator.ensureCompleted(),
    baselineRaw: localStorage.getItem(keys.baselines),
    stateRaw: localStorage.getItem(keys.migrationState),
    vocab: JSON.parse(localStorage.getItem(keys.vocab))
  }), STORAGE_KEYS);
  expect(result.migration).toMatchObject({
    status: "failed",
    reason: "query-history-migration-baseline-candidate-rejected",
    baselineWritten: false,
    migrationStateWritten: false
  });
  expect(result.migration.errors[0].errors[0].code).toBe("invalid-count");
  expect(result.baselineRaw).toBeNull();
  expect(result.stateRaw).toBeNull();
  expect(result.vocab).toEqual(invalidVocab);
});

test("Baseline storage write failure 阻止 state 收口", async ({ page }) => {
  await resetHistory(page, { vocab: makeLegacyVocab() });
  const result = await page.evaluate(keys => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === keys.baselines) {
        throw new DOMException("baseline write blocked", "QuotaExceededError");
      }
      return originalSetItem.call(this, key, value);
    };
    let migration;
    try {
      migration = window.LingoFlowQueryHistoryMigrationCoordinator.ensureCompleted();
    } finally {
      Storage.prototype.setItem = originalSetItem;
    }
    return {
      migration,
      baselineRaw: localStorage.getItem(keys.baselines),
      stateRaw: localStorage.getItem(keys.migrationState)
    };
  }, STORAGE_KEYS);
  expect(result.migration).toMatchObject({
    status: "failed",
    reason: "history-baseline-storage-write-failed",
    baselineWritten: false,
    migrationStateWritten: false
  });
  expect(result.baselineRaw).toBeNull();
  expect(result.stateRaw).toBeNull();
});

test("Baseline 已写入但 state 写失败时准确报告，重试不创建第二份", async ({ page }) => {
  await resetHistory(page, { vocab: makeLegacyVocab() });
  const result = await page.evaluate(keys => {
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === keys.migrationState) {
        throw new DOMException("state write blocked", "QuotaExceededError");
      }
      return originalSetItem.call(this, key, value);
    };
    let first;
    try {
      first = window.LingoFlowQueryHistoryMigrationCoordinator.ensureCompleted();
    } finally {
      Storage.prototype.setItem = originalSetItem;
    }
    const baselinesAfterFailure = window.LingoFlowHistoryBaselineRepository.list();
    const second = window.LingoFlowQueryHistoryMigrationCoordinator.ensureCompleted();
    return {
      first,
      second,
      baselinesAfterFailure,
      baselinesAfterRetry: window.LingoFlowHistoryBaselineRepository.list(),
      state: JSON.parse(localStorage.getItem(keys.migrationState))
    };
  }, STORAGE_KEYS);
  expect(result.first).toMatchObject({
    status: "failed",
    reason: "history-migration-state-storage-write-failed",
    baselineWritten: true,
    migrationStateWritten: false,
    historyBaselineId: expect.stringMatching(/^legacy-local:/)
  });
  expect(result.baselinesAfterFailure).toHaveLength(1);
  expect(result.second).toMatchObject({
    status: "completed",
    outcome: "completed-from-existing-baseline",
    baselineWritten: false,
    migrationStateWritten: true
  });
  expect(result.baselinesAfterRetry).toEqual(result.baselinesAfterFailure);
  expect(result.state).toEqual(COMPLETED_STATE);
});

test("candidate 写入前出现 QueryEvent 时保守放弃 Baseline", async ({ page }) => {
  const event = makeEvent("query:concurrent-before-baseline");
  await resetHistory(page, { vocab: makeLegacyVocab() });
  const result = await page.evaluate(({ keys, injectedEvent }) => {
    const originalSchema = window.LingoFlowHistoryBaselineBackupSchema;
    let injected = false;
    window.LingoFlowHistoryBaselineBackupSchema = Object.freeze({
      ...originalSchema,
      validateHistoryBaseline(value) {
        const validation = originalSchema.validateHistoryBaseline(value);
        if (!injected && value?.deviceId === "legacy-local") {
          injected = true;
          localStorage.setItem(
            keys.events,
            JSON.stringify({ [injectedEvent.id]: injectedEvent })
          );
        }
        return validation;
      }
    });
    try {
      return {
        migration: window.LingoFlowQueryHistoryMigrationCoordinator.ensureCompleted(),
        events: window.LingoFlowQueryEventRepository.list(),
        baselines: window.LingoFlowHistoryBaselineRepository.list(),
        state: JSON.parse(localStorage.getItem(keys.migrationState))
      };
    } finally {
      window.LingoFlowHistoryBaselineBackupSchema = originalSchema;
    }
  }, { keys: STORAGE_KEYS, injectedEvent: event });
  expect(result.migration).toMatchObject({
    status: "completed",
    outcome: "completed-from-existing-query-events",
    baselineWritten: false,
    migrationStateWritten: true
  });
  expect(result.events).toEqual([event]);
  expect(result.baselines).toEqual([]);
  expect(result.state).toEqual(COMPLETED_STATE);
});

test("candidate 写入前出现 History Baseline 时不创建第二份", async ({ page }) => {
  const externalBaseline = makeBaseline("baseline:concurrent-before-migration");
  await resetHistory(page, { vocab: makeLegacyVocab() });
  const result = await page.evaluate(({ keys, injectedBaseline }) => {
    const originalSchema = window.LingoFlowHistoryBaselineBackupSchema;
    let injected = false;
    window.LingoFlowHistoryBaselineBackupSchema = Object.freeze({
      ...originalSchema,
      validateHistoryBaseline(value) {
        const validation = originalSchema.validateHistoryBaseline(value);
        if (!injected && value?.deviceId === "legacy-local") {
          injected = true;
          localStorage.setItem(
            keys.baselines,
            JSON.stringify({ [injectedBaseline.id]: injectedBaseline })
          );
        }
        return validation;
      }
    });
    try {
      return {
        migration: window.LingoFlowQueryHistoryMigrationCoordinator.ensureCompleted(),
        baselines: window.LingoFlowHistoryBaselineRepository.list(),
        state: JSON.parse(localStorage.getItem(keys.migrationState))
      };
    } finally {
      window.LingoFlowHistoryBaselineBackupSchema = originalSchema;
    }
  }, { keys: STORAGE_KEYS, injectedBaseline: externalBaseline });
  expect(result.migration).toMatchObject({
    status: "completed",
    outcome: "completed-from-existing-baseline",
    baselineWritten: false,
    migrationStateWritten: true,
    historyBaselineId: externalBaseline.id
  });
  expect(result.baselines).toEqual([externalBaseline]);
  expect(result.state).toEqual(COMPLETED_STATE);
});

test("candidate 校验期间 legacy Vocab 改变时不写陈旧 Baseline", async ({ page }) => {
  const initialVocab = makeLegacyVocab();
  const changedVocab = {
    ...initialVocab,
    "opaque/new-legacy-locator": {
      word: "pear",
      count: 1
    }
  };
  await resetHistory(page, { vocab: initialVocab });
  const result = await page.evaluate(({ keys, nextVocab }) => {
    const originalSchema = window.LingoFlowHistoryBaselineBackupSchema;
    let changed = false;
    window.LingoFlowHistoryBaselineBackupSchema = Object.freeze({
      ...originalSchema,
      validateHistoryBaseline(value) {
        const validation = originalSchema.validateHistoryBaseline(value);
        if (!changed && value?.deviceId === "legacy-local") {
          changed = true;
          localStorage.setItem(keys.vocab, JSON.stringify(nextVocab));
        }
        return validation;
      }
    });
    try {
      return {
        migration: window.LingoFlowQueryHistoryMigrationCoordinator.ensureCompleted(),
        baselineRaw: localStorage.getItem(keys.baselines),
        stateRaw: localStorage.getItem(keys.migrationState),
        vocab: JSON.parse(localStorage.getItem(keys.vocab))
      };
    } finally {
      window.LingoFlowHistoryBaselineBackupSchema = originalSchema;
    }
  }, { keys: STORAGE_KEYS, nextVocab: changedVocab });

  expect(result.migration).toMatchObject({
    status: "failed",
    reason: "query-history-migration-vocab-changed",
    baselineWritten: false,
    migrationStateWritten: false
  });
  expect(result.baselineRaw).toBeNull();
  expect(result.stateRaw).toBeNull();
  expect(result.vocab).toEqual(changedVocab);
});

test("prepare 与 finalize 之间 legacy Vocab 改变时不收口 state", async ({ page }) => {
  const initialVocab = makeLegacyVocab();
  const changedVocab = {
    ...initialVocab,
    "opaque/new-legacy-locator": {
      word: "pear",
      count: 1
    }
  };
  await resetHistory(page, { vocab: initialVocab });
  const result = await page.evaluate(({ keys, nextVocab }) => {
    const coordinator = window.LingoFlowQueryHistoryMigrationCoordinator;
    const prepared = coordinator.prepare();
    localStorage.setItem(keys.vocab, JSON.stringify(nextVocab));
    const finalized = coordinator.finalize(prepared.token);
    const retried = coordinator.ensureCompleted();
    return {
      prepared: { ...prepared, token: Boolean(prepared.token) },
      finalized,
      retried,
      baselines: window.LingoFlowHistoryBaselineRepository.list(),
      stateRaw: localStorage.getItem(keys.migrationState)
    };
  }, { keys: STORAGE_KEYS, nextVocab: changedVocab });

  expect(result.prepared).toMatchObject({
    status: "ready",
    outcome: "migrated-legacy-vocab",
    baselineWritten: true,
    token: true
  });
  expect(result.finalized).toMatchObject({
    status: "failed",
    reason: "query-history-migration-vocab-changed",
    baselineWritten: true,
    migrationStateWritten: false
  });
  expect(result.retried).toMatchObject({
    status: "failed",
    reason: "query-history-migration-vocab-changed",
    baselineWritten: false,
    migrationStateWritten: false
  });
  expect(result.baselines).toHaveLength(1);
  expect(result.baselines[0].records).toEqual(initialVocab);
  expect(result.stateRaw).toBeNull();
});

test("malformed migration-only Repository result 阻止 state 收口", async ({ page }) => {
  await resetHistory(page, { vocab: makeLegacyVocab() });
  const result = await page.evaluate(keys => {
    const originalRepository = window.LingoFlowHistoryBaselineRepository;
    window.LingoFlowHistoryBaselineRepository = Object.freeze({
      ...originalRepository,
      storeMigrationBaseline(value) {
        return {
          status: "stored",
          historyBaselineId: `${value.id}:wrong`,
          written: false,
          conflictFields: []
        };
      }
    });
    try {
      return {
        migration: window.LingoFlowQueryHistoryMigrationCoordinator.ensureCompleted(),
        baselineRaw: localStorage.getItem(keys.baselines),
        stateRaw: localStorage.getItem(keys.migrationState)
      };
    } finally {
      window.LingoFlowHistoryBaselineRepository = originalRepository;
    }
  }, STORAGE_KEYS);

  expect(result.migration).toMatchObject({
    status: "failed",
    reason: "query-history-migration-baseline-result-invalid",
    baselineWritten: false,
    migrationStateWritten: false
  });
  expect(result.baselineRaw).toBeNull();
  expect(result.stateRaw).toBeNull();
});

test("重复 ensureCompleted 幂等，伪造 preparation token 被拒绝", async ({ page }) => {
  await resetHistory(page, { vocab: makeLegacyVocab() });
  const result = await page.evaluate(() => {
    const coordinator = window.LingoFlowQueryHistoryMigrationCoordinator;
    const first = coordinator.ensureCompleted();
    const baselineRaw = localStorage.getItem("EnglishReaderV052HistoryBaselines");
    const stateRaw = localStorage.getItem("EnglishReaderV052HistoryMigrationState");
    const second = coordinator.ensureCompleted();
    return {
      first,
      second,
      forged: coordinator.finalize(Object.freeze({})),
      baselineUnchanged: localStorage.getItem("EnglishReaderV052HistoryBaselines") === baselineRaw,
      stateUnchanged: localStorage.getItem("EnglishReaderV052HistoryMigrationState") === stateRaw,
      baselineCount: coordinator ? window.LingoFlowHistoryBaselineRepository.list().length : -1
    };
  });
  expect(result.first).toMatchObject({
    status: "completed",
    outcome: "migrated-legacy-vocab",
    baselineWritten: true
  });
  expect(result.second).toMatchObject({
    status: "completed",
    outcome: "already-completed",
    baselineWritten: false,
    migrationStateWritten: false
  });
  expect(result.forged).toMatchObject({
    status: "failed",
    reason: "query-history-migration-preparation-invalid"
  });
  expect(result.baselineUnchanged).toBe(true);
  expect(result.stateUnchanged).toBe(true);
  expect(result.baselineCount).toBe(1);
});

test("Coordinator 不访问 DOM、Backup、Projector，clear history 保留 state", async ({ page }) => {
  const result = await page.evaluate(key => {
    const originalGetElementById = document.getElementById;
    const originalBackup = window.LingoFlowBackupV2;
    const originalProjector = window.LingoFlowQueryHistoryProjector;
    document.getElementById = () => {
      throw new Error("Coordinator must not access DOM");
    };
    window.LingoFlowBackupV2 = new Proxy({}, {
      get() {
        throw new Error("Coordinator must not access Backup v2");
      }
    });
    window.LingoFlowQueryHistoryProjector = new Proxy({}, {
      get() {
        throw new Error("Coordinator must not access Projector");
      }
    });
    let migration;
    try {
      migration = window.LingoFlowQueryHistoryMigrationCoordinator.ensureCompleted();
    } finally {
      document.getElementById = originalGetElementById;
      window.LingoFlowBackupV2 = originalBackup;
      window.LingoFlowQueryHistoryProjector = originalProjector;
    }
    const stateBeforeClear = localStorage.getItem(key);
    window.LingoFlowLocalData.QueryData.clearHistory();
    return {
      migration,
      stateBeforeClear,
      stateAfterClear: localStorage.getItem(key)
    };
  }, MIGRATION_STATE_KEY);
  expect(result.migration).toMatchObject({
    status: "completed",
    outcome: "completed-no-legacy-data"
  });
  expect(JSON.parse(result.stateBeforeClear)).toEqual(COMPLETED_STATE);
  expect(result.stateAfterClear).toBe(result.stateBeforeClear);
});
