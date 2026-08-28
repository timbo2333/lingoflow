const { test, expect } = require("@playwright/test");

const STORAGE_KEY = "EnglishReaderV052HistoryBaselines";
const MIGRATION_STATE_KEY = "EnglishReaderV052HistoryMigrationState";
const projectErrors = new WeakMap();

function makeBaseline(id, overrides = {}) {
  return {
    id,
    createdAt: "2026-08-24T10:00:00.000Z",
    deviceId: "device:legacy-source",
    records: {
      "legacy-key": {
        word: "apple",
        count: 5,
        articleCount: 2,
        searchCount: 1,
        displayWord: "Apple"
      }
    },
    ...overrides
  };
}

test.beforeEach(async ({ page }) => {
  const errors = [];
  projectErrors.set(page, errors);

  page.on("pageerror", error => {
    errors.push(`pageerror: ${error.message}`);
  });
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
  await page.evaluate(({ storageKey, migrationKey }) => {
    localStorage.removeItem(storageKey);
    localStorage.removeItem(migrationKey);
  }, { storageKey: STORAGE_KEY, migrationKey: MIGRATION_STATE_KEY });
  await page.addScriptTag({ url: "/js/history-baseline-backup-schema.js" });
  await page.addScriptTag({ url: "/js/history-baseline-repository.js" });
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

test("Repository API 冻结，missing storage 是合法空集合", async ({ page }) => {
  const result = await page.evaluate(storageKey => {
    const repository = window.LingoFlowHistoryBaselineRepository;
    return {
      frozen: Object.isFrozen(repository),
      raw: localStorage.getItem(storageKey),
      list: repository.list(),
      missing: repository.get("baseline:missing"),
      api: {
        get: typeof repository.get,
        list: typeof repository.list,
        findRecordLocatorsByWord: typeof repository.findRecordLocatorsByWord,
        removeRecordsByWord: typeof repository.removeRecordsByWord,
        clear: typeof repository.clear,
        assessBackupRestore: typeof repository.assessBackupRestore,
        restoreBackupRecords: typeof repository.restoreBackupRecords,
        updateBaseline: typeof repository.updateBaseline
      }
    };
  }, STORAGE_KEY);

  expect(result).toEqual({
    frozen: true,
    raw: null,
    list: [],
    missing: null,
    api: {
      get: "function",
      list: "function",
      findRecordLocatorsByWord: "function",
      removeRecordsByWord: "function",
      clear: "function",
      assessBackupRestore: "function",
      restoreBackupRecords: "function",
      updateBaseline: "undefined"
    }
  });
});

test("malformed JSON、非法根结构和非法 Baseline 都严格失败且不覆盖原数据", async ({ page }) => {
  const result = await page.evaluate(storageKey => {
    const repository = window.LingoFlowHistoryBaselineRepository;
    const cases = [
      { raw: "{not-json", expected: "history-baseline-storage-malformed" },
      { raw: "[]", expected: "history-baseline-storage-invalid-root" },
      { raw: "null", expected: "history-baseline-storage-invalid-root" },
      {
        raw: JSON.stringify({
          "baseline:invalid": {
            id: "baseline:invalid",
            createdAt: "2026-08-24T10:00:00.000Z"
          }
        }),
        expected: "history-baseline-storage-invalid-record"
      }
    ];

    return cases.map(candidate => {
      localStorage.setItem(storageKey, candidate.raw);
      let error = null;
      try {
        repository.list();
      } catch (caught) {
        error = { code: caught.code, message: caught.message };
      }
      return {
        expected: candidate.expected,
        error,
        unchanged: localStorage.getItem(storageKey) === candidate.raw
      };
    });
  }, STORAGE_KEY);

  for (const item of result) {
    expect(item.error?.code).toBe(item.expected);
    expect(item.unchanged).toBe(true);
  }
});

test("storage access error 明确失败，outer key/id 不一致不会被修复", async ({ page }) => {
  const baseline = makeBaseline("baseline:inner");
  const result = await page.evaluate(({ storageKey, record }) => {
    const repository = window.LingoFlowHistoryBaselineRepository;
    const raw = JSON.stringify({ "baseline:outer": record });
    localStorage.setItem(storageKey, raw);
    let mismatch = null;
    try {
      repository.get("baseline:outer");
    } catch (error) {
      mismatch = { code: error.code, details: error.details };
    }

    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key) {
      if (key === storageKey) throw new DOMException("read blocked", "SecurityError");
      return original.call(this, key);
    };
    let readFailure = null;
    try {
      repository.list();
    } catch (error) {
      readFailure = { code: error.code, message: error.message };
    } finally {
      Storage.prototype.getItem = original;
    }
    return {
      mismatch,
      readFailure,
      rawUnchanged: localStorage.getItem(storageKey) === raw
    };
  }, { storageKey: STORAGE_KEY, record: baseline });

  expect(result.mismatch).toEqual({
    code: "history-baseline-storage-identity-mismatch",
    details: {
      outerId: "baseline:outer",
      historyBaselineId: baseline.id
    }
  });
  expect(result.readFailure).toEqual({
    code: "history-baseline-storage-read-failed",
    message: "read blocked"
  });
  expect(result.rawUnchanged).toBe(true);
});

test("list/get 返回完整独立 snapshot，保留 locator 和 unknown fields", async ({ page }) => {
  const baseline = makeBaseline("baseline:snapshot", {
    records: {
      "legacy-key-123": {
        word: "apple",
        count: 5,
        futureRecordFact: { labels: ["one"] }
      }
    },
    futureBaselineFact: { provenance: { page: 2 } }
  });
  const result = await page.evaluate(({ storageKey, record }) => {
    localStorage.setItem(storageKey, JSON.stringify({ [record.id]: record }));
    const repository = window.LingoFlowHistoryBaselineRepository;
    const firstList = repository.list();
    const firstGet = repository.get(record.id);
    firstList[0].records["legacy-key-123"].futureRecordFact.labels.push("outside");
    firstGet.futureBaselineFact.provenance.page = 99;
    return {
      firstList,
      firstGet,
      secondList: repository.list(),
      secondGet: repository.get(record.id),
      stored: JSON.parse(localStorage.getItem(storageKey))[record.id]
    };
  }, { storageKey: STORAGE_KEY, record: baseline });

  expect(result.firstList[0].records["legacy-key-123"].futureRecordFact.labels)
    .toEqual(["one", "outside"]);
  expect(result.firstGet.futureBaselineFact.provenance.page).toBe(99);
  expect(result.secondList).toEqual([baseline]);
  expect(result.secondGet).toEqual(baseline);
  expect(result.stored).toEqual(baseline);
});

test("opaque locator 可与 record.word 不同，reserved 名称作为 locator 仍合法", async ({ page }) => {
  const baseline = makeBaseline("baseline:opaque-locators", {
    records: {
      lemma: { word: "apple", count: 2 },
      vocab: { word: "banana", count: 3 },
      syncStatus: { word: "pear", count: 4 }
    }
  });
  const result = await page.evaluate(({ storageKey, record }) => {
    Object.defineProperty(record.records, "__proto__", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: { word: "grape", count: 6 }
    });
    localStorage.setItem(storageKey, JSON.stringify({ [record.id]: record }));
    const repository = window.LingoFlowHistoryBaselineRepository;
    const stored = repository.get(record.id);
    return {
      stored,
      storedKeys: Object.keys(stored.records),
      apple: repository.findRecordLocatorsByWord("apple"),
      banana: repository.findRecordLocatorsByWord("banana"),
      pear: repository.findRecordLocatorsByWord("pear"),
      grape: repository.findRecordLocatorsByWord("grape")
    };
  }, { storageKey: STORAGE_KEY, record: baseline });

  expect(result.storedKeys).toEqual([
    "lemma",
    "vocab",
    "syncStatus",
    "__proto__"
  ]);
  expect(result.apple).toEqual([{ historyBaselineId: baseline.id, locator: "lemma" }]);
  expect(result.banana).toEqual([{ historyBaselineId: baseline.id, locator: "vocab" }]);
  expect(result.pear).toEqual([{ historyBaselineId: baseline.id, locator: "syncStatus" }]);
  expect(result.grape).toEqual([{ historyBaselineId: baseline.id, locator: "__proto__" }]);
});

test("record value 内 reserved field 被严格拒绝", async ({ page }) => {
  const baseline = makeBaseline("baseline:reserved-value", {
    records: {
      "legacy-key": {
        word: "apple",
        count: 2,
        syncStatus: "dirty"
      }
    }
  });
  const result = await page.evaluate(({ storageKey, record }) => {
    const raw = JSON.stringify({ [record.id]: record });
    localStorage.setItem(storageKey, raw);
    let error = null;
    try {
      window.LingoFlowHistoryBaselineRepository.list();
    } catch (caught) {
      error = { code: caught.code, details: caught.details };
    }
    return { error, rawUnchanged: localStorage.getItem(storageKey) === raw };
  }, { storageKey: STORAGE_KEY, record: baseline });

  expect(result.error?.code).toBe("history-baseline-storage-invalid-record");
  expect(result.error?.details.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "reserved-field" })
  ]));
  expect(result.rawUnchanged).toBe(true);
});

test("locator-safe lookup 精确比较 record.word，不 trim/normalize", async ({ page }) => {
  const first = makeBaseline("baseline:lookup-a", {
    records: {
      "legacy-a": { word: "apple", count: 2 },
      "legacy-uppercase": { word: "Apple", count: 1 }
    }
  });
  const second = makeBaseline("baseline:lookup-b", {
    records: {
      "totally-unrelated-key": { word: "apple", count: 4 }
    }
  });
  const result = await page.evaluate(({ storageKey, records }) => {
    localStorage.setItem(storageKey, JSON.stringify({
      [records[0].id]: records[0],
      [records[1].id]: records[1]
    }));
    const repository = window.LingoFlowHistoryBaselineRepository;
    return {
      exact: repository.findRecordLocatorsByWord("apple"),
      uppercase: repository.findRecordLocatorsByWord("Apple"),
      padded: repository.findRecordLocatorsByWord(" apple "),
      nonString: repository.findRecordLocatorsByWord(null)
    };
  }, { storageKey: STORAGE_KEY, records: [first, second] });

  expect(result.exact).toEqual([
    { historyBaselineId: first.id, locator: "legacy-a" },
    { historyBaselineId: second.id, locator: "totally-unrelated-key" }
  ]);
  expect(result.uppercase).toEqual([
    { historyBaselineId: first.id, locator: "legacy-uppercase" }
  ]);
  expect(result.padded).toEqual([]);
  expect(result.nonString).toEqual([]);
});

test("locator-safe 删除跨 Baseline 删除实际匹配 record，保持 ID/createdAt 和其他 locator", async ({ page }) => {
  const first = makeBaseline("baseline:remove-a", {
    createdAt: "2021-01-02T03:04:05.006Z",
    records: {
      "legacy-key-123": { word: "apple", count: 5 },
      "keep-banana": { word: "banana", count: 2 }
    }
  });
  const second = makeBaseline("baseline:remove-b", {
    createdAt: "2022-02-03T04:05:06.007Z",
    records: {
      lemma: { word: "apple", count: 1 },
      "keep-pear": { word: "pear", count: 3 }
    }
  });
  const result = await page.evaluate(({ storageKey, records }) => {
    localStorage.setItem(storageKey, JSON.stringify({
      [records[0].id]: records[0],
      [records[1].id]: records[1]
    }));
    const repository = window.LingoFlowHistoryBaselineRepository;
    const removed = repository.removeRecordsByWord("apple");
    return {
      removed,
      first: repository.get(records[0].id),
      second: repository.get(records[1].id)
    };
  }, { storageKey: STORAGE_KEY, records: [first, second] });

  expect(result.removed).toEqual({
    word: "apple",
    removedCount: 2,
    items: [
      { historyBaselineId: first.id, locators: ["legacy-key-123"] },
      { historyBaselineId: second.id, locators: ["lemma"] }
    ]
  });
  expect(result.first).toMatchObject({ id: first.id, createdAt: first.createdAt });
  expect(result.second).toMatchObject({ id: second.id, createdAt: second.createdAt });
  expect(result.first.records).toEqual({
    "keep-banana": { word: "banana", count: 2 }
  });
  expect(result.second.records).toEqual({
    "keep-pear": { word: "pear", count: 3 }
  });
});

test("删除不存在 word 不写 storage、不生成事实", async ({ page }) => {
  const baseline = makeBaseline("baseline:no-delete");
  const result = await page.evaluate(({ storageKey, record }) => {
    localStorage.setItem(storageKey, JSON.stringify({ [record.id]: record }));
    const before = localStorage.getItem(storageKey);
    const original = Storage.prototype.setItem;
    let writes = 0;
    Storage.prototype.setItem = function(key, value) {
      if (key === storageKey) writes += 1;
      return original.call(this, key, value);
    };
    try {
      const removed = window.LingoFlowHistoryBaselineRepository
        .removeRecordsByWord("missing");
      return {
        removed,
        writes,
        rawUnchanged: localStorage.getItem(storageKey) === before
      };
    } finally {
      Storage.prototype.setItem = original;
    }
  }, { storageKey: STORAGE_KEY, record: baseline });

  expect(result).toEqual({
    removed: { word: "missing", removedCount: 0, items: [] },
    writes: 0,
    rawUnchanged: true
  });
});

test("clear 严格清除完整 Baseline namespace，missing storage 不写", async ({ page }) => {
  const records = [
    makeBaseline("baseline:clear-b", {
      createdAt: "2026-08-24T10:00:01.000Z"
    }),
    makeBaseline("baseline:clear-a")
  ];
  const result = await page.evaluate(({ storageKey, incoming }) => {
    localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(
      incoming.map(record => [record.id, record])
    )));
    const repository = window.LingoFlowHistoryBaselineRepository;
    const originalRemove = Storage.prototype.removeItem;
    let removes = 0;
    Storage.prototype.removeItem = function(key) {
      if (key === storageKey) removes += 1;
      return originalRemove.call(this, key);
    };
    try {
      const cleared = repository.clear();
      const missing = repository.clear();
      localStorage.setItem(storageKey, "{}");
      const storedEmpty = repository.clear();
      return {
        cleared,
        missing,
        storedEmpty,
        removes,
        raw: localStorage.getItem(storageKey),
        list: repository.list()
      };
    } finally {
      Storage.prototype.removeItem = originalRemove;
    }
  }, { storageKey: STORAGE_KEY, incoming: records });

  expect(result).toEqual({
    cleared: {
      removedCount: 2,
      historyBaselineIds: [records[1].id, records[0].id],
      written: true
    },
    missing: { removedCount: 0, historyBaselineIds: [], written: false },
    storedEmpty: { removedCount: 0, historyBaselineIds: [], written: true },
    removes: 2,
    raw: null,
    list: []
  });
});

test("clear 拒绝损坏数据，报告并发变化和 removeItem 写入失败", async ({ page }) => {
  const initial = makeBaseline("baseline:clear-initial");
  const competing = makeBaseline("baseline:clear-competing", {
    createdAt: "2026-08-24T10:00:01.000Z"
  });
  const result = await page.evaluate(({ storageKey, initialRecord, competingRecord }) => {
    const repository = window.LingoFlowHistoryBaselineRepository;
    localStorage.setItem(storageKey, JSON.stringify({
      [initialRecord.id]: initialRecord
    }));
    const originalGetForFailure = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key) {
      if (key === storageKey) throw new DOMException("read blocked", "SecurityError");
      return originalGetForFailure.call(this, key);
    };
    let readFailure = null;
    try {
      repository.clear();
    } catch (error) {
      readFailure = { code: error.code, message: error.message };
    } finally {
      Storage.prototype.getItem = originalGetForFailure;
    }
    const readFailurePreserved = JSON.parse(localStorage.getItem(storageKey));

    const malformedRaw = "{broken-history-baselines";
    localStorage.setItem(storageKey, malformedRaw);
    let malformed = null;
    try {
      repository.clear();
    } catch (error) {
      malformed = error.code;
    }
    const malformedUnchanged = localStorage.getItem(storageKey) === malformedRaw;

    localStorage.setItem(storageKey, JSON.stringify({
      [initialRecord.id]: initialRecord
    }));
    const originalGet = Storage.prototype.getItem;
    const originalSet = Storage.prototype.setItem;
    let reads = 0;
    Storage.prototype.getItem = function(key) {
      if (key === storageKey) {
        reads += 1;
        if (reads === 2) {
          const changed = JSON.stringify({ [competingRecord.id]: competingRecord });
          originalSet.call(this, key, changed);
          return changed;
        }
      }
      return originalGet.call(this, key);
    };
    let changed = null;
    try {
      repository.clear();
    } catch (error) {
      changed = error.code;
    } finally {
      Storage.prototype.getItem = originalGet;
    }
    const competingPreserved = JSON.parse(localStorage.getItem(storageKey));

    const originalRemove = Storage.prototype.removeItem;
    Storage.prototype.removeItem = function(key) {
      if (key === storageKey) throw new DOMException("remove blocked", "SecurityError");
      return originalRemove.call(this, key);
    };
    let writeFailure = null;
    try {
      repository.clear();
    } catch (error) {
      writeFailure = { code: error.code, message: error.message };
    } finally {
      Storage.prototype.removeItem = originalRemove;
    }
    return {
      readFailure,
      readFailurePreserved,
      malformed,
      malformedUnchanged,
      changed,
      competingPreserved,
      writeFailure,
      finalRaw: JSON.parse(localStorage.getItem(storageKey))
    };
  }, { storageKey: STORAGE_KEY, initialRecord: initial, competingRecord: competing });

  expect(result.readFailure).toEqual({
    code: "history-baseline-storage-read-failed",
    message: "read blocked"
  });
  expect(result.readFailurePreserved).toEqual({ [initial.id]: initial });
  expect(result.malformed).toBe("history-baseline-storage-malformed");
  expect(result.malformedUnchanged).toBe(true);
  expect(result.changed).toBe("history-baseline-storage-changed");
  expect(result.competingPreserved).toEqual({ [competing.id]: competing });
  expect(result.writeFailure).toEqual({
    code: "history-baseline-storage-write-failed",
    message: "remove blocked"
  });
  expect(result.finalRaw).toEqual({ [competing.id]: competing });
});

test("Backup assessment 保守比较完整实体和 locator 关系", async ({ page }) => {
  const local = makeBaseline("baseline:assessment", {
    futureFact: { version: 1 },
    records: { "legacy-a": { word: "apple", count: 2 } }
  });
  const missing = makeBaseline("baseline:missing-assessment");
  const result = await page.evaluate(({ storageKey, localRecord, missingRecord }) => {
    localStorage.setItem(storageKey, JSON.stringify({ [localRecord.id]: localRecord }));
    const repository = window.LingoFlowHistoryBaselineRepository;
    return {
      missing: repository.assessBackupRestore(missingRecord),
      exact: repository.assessBackupRestore(localRecord),
      records: repository.assessBackupRestore({
        ...localRecord,
        records: { "legacy-a": { word: "apple", count: 3 } }
      }),
      locator: repository.assessBackupRestore({
        ...localRecord,
        records: { "legacy-b": { word: "apple", count: 2 } }
      }),
      unknown: repository.assessBackupRestore({
        ...localRecord,
        futureFact: { version: 2 }
      }),
      stored: repository.get(localRecord.id)
    };
  }, { storageKey: STORAGE_KEY, localRecord: local, missingRecord: missing });

  expect(result.missing).toMatchObject({
    status: "restorable",
    historyBaselineId: missing.id,
    written: false,
    conflictFields: []
  });
  expect(result.exact).toMatchObject({ status: "unchanged", written: false });
  expect(result.records).toMatchObject({ status: "conflict", conflictFields: ["records"] });
  expect(result.locator).toMatchObject({ status: "conflict", conflictFields: ["records"] });
  expect(result.unknown).toMatchObject({ status: "conflict", conflictFields: ["futureFact"] });
  expect(result.stored).toEqual(local);
});

test("不同 ID 的相同 records 作为两个独立 Baseline 恢复", async ({ page }) => {
  const first = makeBaseline("baseline:same-records-a");
  const second = { ...first, id: "baseline:same-records-b" };
  const result = await page.evaluate(records => {
    const repository = window.LingoFlowHistoryBaselineRepository;
    return {
      restore: repository.restoreBackupRecords(records),
      list: repository.list()
    };
  }, [first, second]);

  expect(result.restore.status).toBe("completed");
  expect(result.restore.summary).toMatchObject({ restored: 2, conflicts: 0 });
  expect(result.list).toEqual([first, second]);
});

test("Backup restore 原样保留历史 ID/hash 外观、locator 和 unknown fields，且不修改输入", async ({ page }) => {
  const baseline = makeBaseline("baseline:legacy-content-hash-that-no-longer-matches", {
    createdAt: "2021-01-02T03:04:05.006Z",
    deviceId: "legacy-import",
    records: {
      "not-normalized-APPLE-key": {
        word: "apple",
        count: 7,
        futureRecordFact: { values: [null, true, 2.5] }
      }
    },
    futureBaselineFact: { nested: { exact: "preserved" } }
  });
  const result = await page.evaluate(({ record, storageKey }) => {
    const repository = window.LingoFlowHistoryBaselineRepository;
    const before = JSON.stringify(record);
    const first = repository.restoreBackupRecords([record]);
    const after = JSON.stringify(record);
    const rawAfterFirst = localStorage.getItem(storageKey);
    record.records["not-normalized-APPLE-key"].count = 99;
    record.futureBaselineFact.nested.exact = "outside";
    const stored = repository.get(record.id);
    const second = repository.restoreBackupRecords([stored]);
    return {
      before,
      after,
      first,
      second,
      rawUnchangedBySecond: localStorage.getItem(storageKey) === rawAfterFirst,
      stored
    };
  }, { record: baseline, storageKey: STORAGE_KEY });

  expect(result.before).toBe(result.after);
  expect(result.first.items[0]).toMatchObject({
    status: "restored",
    historyBaselineId: baseline.id,
    written: true
  });
  expect(result.stored).toEqual(baseline);
  expect(Object.keys(result.stored.records)).toEqual(["not-normalized-APPLE-key"]);
  expect(result.second.items[0]).toMatchObject({ status: "unchanged", written: false });
  expect(result.rawUnchangedBySecond).toBe(true);
});

test("Backup 批次非法、duplicate、getter/cycle/symbol 时整批拒绝且零写入", async ({ page }) => {
  const valid = makeBaseline("baseline:valid-not-written");
  const invalid = makeBaseline("baseline:invalid-count", {
    records: { legacy: { word: "apple", count: 0 } }
  });
  const result = await page.evaluate(({ validRecord, invalidRecord, storageKey }) => {
    const repository = window.LingoFlowHistoryBaselineRepository;
    const invalidBatch = repository.restoreBackupRecords([validRecord, invalidRecord]);
    const duplicateBatch = repository.restoreBackupRecords([validRecord, { ...validRecord }]);

    let getterCalls = 0;
    const accessor = { ...validRecord, id: "baseline:accessor" };
    Object.defineProperty(accessor, "futureFact", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must-not-run";
      }
    });
    const accessorBatch = repository.restoreBackupRecords([accessor]);

    const cyclic = { ...validRecord, id: "baseline:cycle", futureFact: {} };
    cyclic.futureFact.self = cyclic.futureFact;
    const cycleBatch = repository.restoreBackupRecords([cyclic]);

    const symbolic = { ...validRecord, id: "baseline:symbol", futureFact: Symbol("unsafe") };
    const symbolBatch = repository.restoreBackupRecords([symbolic]);

    const sparse = [];
    sparse.length = 1000000000;
    const sparseBatch = repository.restoreBackupRecords(sparse);

    return {
      invalidBatch,
      duplicateBatch,
      accessorBatch,
      cycleBatch,
      symbolBatch,
      sparseBatch,
      getterCalls,
      raw: localStorage.getItem(storageKey)
    };
  }, { validRecord: valid, invalidRecord: invalid, storageKey: STORAGE_KEY });

  expect(result.invalidBatch.status).toBe("rejected");
  expect(result.invalidBatch.summary).toMatchObject({ rejected: 1, notAttempted: 1 });
  expect(result.duplicateBatch.status).toBe("rejected");
  expect(result.accessorBatch.status).toBe("rejected");
  expect(result.cycleBatch.status).toBe("rejected");
  expect(result.symbolBatch.status).toBe("rejected");
  expect(result.sparseBatch).toMatchObject({
    status: "rejected",
    summary: { total: 0 },
    items: []
  });
  expect(result.getterCalls).toBe(0);
  expect(result.raw).toBeNull();
});

test("第二条写入失败时第一条保持 restored，失败项与后续项准确标记", async ({ page }) => {
  const records = [
    makeBaseline("baseline:partial-first"),
    makeBaseline("baseline:partial-second", {
      createdAt: "2026-08-24T10:00:01.000Z"
    }),
    makeBaseline("baseline:partial-third", {
      createdAt: "2026-08-24T10:00:02.000Z"
    })
  ];
  const result = await page.evaluate(({ incoming, storageKey }) => {
    const repository = window.LingoFlowHistoryBaselineRepository;
    const original = Storage.prototype.setItem;
    let writes = 0;
    Storage.prototype.setItem = function(key, value) {
      if (key === storageKey) {
        writes += 1;
        if (writes === 2) throw new DOMException("quota", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
    try {
      const restored = repository.restoreBackupRecords(incoming);
      return {
        restored,
        stored: JSON.parse(localStorage.getItem(storageKey) || "{}"),
        writes
      };
    } finally {
      Storage.prototype.setItem = original;
    }
  }, { incoming: records, storageKey: STORAGE_KEY });

  expect(result.writes).toBe(2);
  expect(result.restored.status).toBe("interrupted");
  expect(result.restored.summary).toEqual({
    total: 3,
    restored: 1,
    unchanged: 0,
    conflicts: 0,
    rejected: 0,
    failed: 1,
    notAttempted: 1
  });
  expect(result.restored.items).toEqual([
    expect.objectContaining({
      index: 0,
      historyBaselineId: records[0].id,
      status: "restored",
      written: true
    }),
    expect.objectContaining({
      index: 1,
      historyBaselineId: records[1].id,
      status: "failed",
      written: false
    }),
    expect.objectContaining({
      index: 2,
      historyBaselineId: records[2].id,
      status: "not-attempted",
      written: false
    })
  ]);
  expect(result.restored.errors[0]).toMatchObject({
    code: "history-baseline-storage-write-failed",
    index: 1,
    historyBaselineId: records[1].id
  });
  expect(Object.keys(result.stored)).toEqual([records[0].id]);
  expect(result.stored[records[0].id]).toEqual(records[0]);
});

test("初次 storage read failure 保留所有 historyBaselineId", async ({ page }) => {
  const records = [
    makeBaseline("baseline:read-failure-a"),
    makeBaseline("baseline:read-failure-b")
  ];
  const result = await page.evaluate(({ incoming, storageKey }) => {
    const repository = window.LingoFlowHistoryBaselineRepository;
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key) {
      if (key === storageKey) throw new DOMException("read blocked", "SecurityError");
      return original.call(this, key);
    };
    try {
      return {
        assessment: repository.assessBackupRestore(incoming[0]),
        restored: repository.restoreBackupRecords(incoming)
      };
    } finally {
      Storage.prototype.getItem = original;
    }
  }, { incoming: records, storageKey: STORAGE_KEY });

  expect(result.assessment).toMatchObject({
    status: "failed",
    historyBaselineId: records[0].id,
    written: false,
    reason: "history-baseline-storage-read-failed"
  });
  expect(result.restored.status).toBe("interrupted");
  expect(result.restored.summary).toMatchObject({
    restored: 0,
    failed: 0,
    notAttempted: 2
  });
  expect(result.restored.items).toEqual([
    expect.objectContaining({
      index: 0,
      historyBaselineId: records[0].id,
      status: "not-attempted"
    }),
    expect.objectContaining({
      index: 1,
      historyBaselineId: records[1].id,
      status: "not-attempted"
    })
  ]);
  expect(result.restored.errors[0].code).toBe("history-baseline-storage-read-failed");
});

test("Repository 的 read/restore/delete 不读取或写入 Migration State", async ({ page }) => {
  const baseline = makeBaseline("baseline:migration-isolation");
  const result = await page.evaluate(({ storageKey, migrationKey, record }) => {
    localStorage.setItem(migrationKey, "opaque-control-state");
    const originalGet = Storage.prototype.getItem;
    const originalSet = Storage.prototype.setItem;
    let migrationReads = 0;
    let migrationWrites = 0;
    Storage.prototype.getItem = function(key) {
      if (key === migrationKey) migrationReads += 1;
      return originalGet.call(this, key);
    };
    Storage.prototype.setItem = function(key, value) {
      if (key === migrationKey) migrationWrites += 1;
      return originalSet.call(this, key, value);
    };
    try {
      const before = originalGet.call(localStorage, migrationKey);
      const restored = window.LingoFlowHistoryBaselineRepository
        .restoreBackupRecords([record]);
      window.LingoFlowHistoryBaselineRepository.list();
      window.LingoFlowHistoryBaselineRepository
        .removeRecordsByWord("missing");
      const cleared = window.LingoFlowHistoryBaselineRepository.clear();
      return {
        before,
        after: originalGet.call(localStorage, migrationKey),
        migrationReads,
        migrationWrites,
        restored,
        cleared,
        baselineRaw: originalGet.call(localStorage, storageKey)
      };
    } finally {
      Storage.prototype.getItem = originalGet;
      Storage.prototype.setItem = originalSet;
    }
  }, { storageKey: STORAGE_KEY, migrationKey: MIGRATION_STATE_KEY, record: baseline });

  expect(result.before).toBe("opaque-control-state");
  expect(result.after).toBe("opaque-control-state");
  expect(result.migrationReads).toBe(0);
  expect(result.migrationWrites).toBe(0);
  expect(result.restored.status).toBe("completed");
  expect(result.cleared).toEqual({
    removedCount: 1,
    historyBaselineIds: [baseline.id],
    written: true
  });
  expect(result.baselineRaw).toBeNull();
});
