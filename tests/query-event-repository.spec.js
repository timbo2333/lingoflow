const { test, expect } = require("@playwright/test");

const STORAGE_KEY = "EnglishReaderV052QueryEvents";
const DEVICE_ID_KEY = "EnglishReaderV052DeviceId";
const projectErrors = new WeakMap();

function makeEvent(id, overrides = {}) {
  return {
    id,
    deviceId: "device:backup-source",
    word: "develop",
    displayWord: "Develop",
    phonetic: "/dɪˈveləp/",
    pos: "verb",
    meaning: "发展",
    dictionaryFound: true,
    source: "article",
    timestamp: "2026-08-24T10:00:00.000Z",
    ...overrides
  };
}

function makeDictionaryResult(overrides = {}) {
  return {
    baseWord: "develop",
    phonetic: "/dɪˈveləp/",
    pos: "verb",
    meaning: "发展",
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
  await page.evaluate(({ storageKey, deviceKey }) => {
    localStorage.removeItem(storageKey);
    localStorage.removeItem(deviceKey);
  }, { storageKey: STORAGE_KEY, deviceKey: DEVICE_ID_KEY });
  await page.addScriptTag({ url: "/js/query-event-backup-schema.js" });
  await page.addScriptTag({ url: "/js/query-event-repository.js" });
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

test("Repository API 冻结，missing storage 是合法空集合", async ({ page }) => {
  const result = await page.evaluate(storageKey => {
    const repository = window.LingoFlowQueryEventRepository;
    return {
      frozen: Object.isFrozen(repository),
      raw: localStorage.getItem(storageKey),
      list: repository.list(),
      missing: repository.get("query:missing"),
      api: {
        append: typeof repository.append,
        get: typeof repository.get,
        list: typeof repository.list,
        removeById: typeof repository.removeById,
        removeByWord: typeof repository.removeByWord,
        clear: typeof repository.clear,
        assessBackupRestore: typeof repository.assessBackupRestore,
        restoreBackupRecords: typeof repository.restoreBackupRecords,
        update: typeof repository.update
      }
    };
  }, STORAGE_KEY);

  expect(result).toEqual({
    frozen: true,
    raw: null,
    list: [],
    missing: null,
    api: {
      append: "function",
      get: "function",
      list: "function",
      removeById: "function",
      removeByWord: "function",
      clear: "function",
      assessBackupRestore: "function",
      restoreBackupRecords: "function",
      update: "undefined"
    }
  });
});

test("malformed JSON、非法 map 根和非法实体都会严格失败且不覆盖原数据", async ({ page }) => {
  const result = await page.evaluate(storageKey => {
    const repository = window.LingoFlowQueryEventRepository;
    const cases = [
      { raw: "{not-json", expected: "query-event-storage-malformed" },
      { raw: "[]", expected: "query-event-storage-invalid-root" },
      { raw: "null", expected: "query-event-storage-invalid-root" },
      {
        raw: JSON.stringify({
          "query:invalid": {
            id: "query:invalid",
            deviceId: "device:one",
            word: "develop"
          }
        }),
        expected: "query-event-storage-invalid-record"
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

test("outer map key 与 entity.id 不一致时拒绝且不补造 identity", async ({ page }) => {
  const event = makeEvent("query:inner-id");
  const result = await page.evaluate(({ storageKey, record }) => {
    const raw = JSON.stringify({ "query:outer-id": record });
    localStorage.setItem(storageKey, raw);
    let error = null;
    try {
      window.LingoFlowQueryEventRepository.get("query:outer-id");
    } catch (caught) {
      error = {
        code: caught.code,
        details: caught.details,
        message: caught.message
      };
    }
    return {
      error,
      rawUnchanged: localStorage.getItem(storageKey) === raw
    };
  }, { storageKey: STORAGE_KEY, record: event });

  expect(result.error).toMatchObject({
    code: "query-event-storage-identity-mismatch",
    details: {
      outerId: "query:outer-id",
      queryEventId: event.id
    }
  });
  expect(result.rawUnchanged).toBe(true);
});

test("localStorage.getItem 异常作为明确 storage read failure 暴露", async ({ page }) => {
  const result = await page.evaluate(storageKey => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key) {
      if (key === storageKey) throw new DOMException("read blocked", "SecurityError");
      return original.call(this, key);
    };
    try {
      window.LingoFlowQueryEventRepository.list();
      return null;
    } catch (error) {
      return { code: error.code, message: error.message };
    } finally {
      Storage.prototype.getItem = original;
    }
  }, STORAGE_KEY);

  expect(result).toEqual({
    code: "query-event-storage-read-failed",
    message: "read blocked"
  });
});

test("list/get 返回独立快照且 unknown fields 不暴露存储引用", async ({ page }) => {
  const event = makeEvent("query:snapshot", {
    futureFact: { labels: ["one"], provenance: { page: 2 } }
  });
  const result = await page.evaluate(({ storageKey, record }) => {
    localStorage.setItem(storageKey, JSON.stringify({ [record.id]: record }));
    const repository = window.LingoFlowQueryEventRepository;
    const firstList = repository.list();
    const firstGet = repository.get(record.id);
    firstList[0].futureFact.labels.push("outside-list");
    firstGet.futureFact.provenance.page = 99;
    const secondList = repository.list();
    const secondGet = repository.get(record.id);
    return {
      firstList,
      firstGet,
      secondList,
      secondGet,
      stored: JSON.parse(localStorage.getItem(storageKey))[record.id]
    };
  }, { storageKey: STORAGE_KEY, record: event });

  expect(result.firstList[0].futureFact.labels).toEqual(["one", "outside-list"]);
  expect(result.firstGet.futureFact.provenance.page).toBe(99);
  expect(result.secondList).toEqual([event]);
  expect(result.secondGet).toEqual(event);
  expect(result.stored).toEqual(event);
});

test("append 镜像现有 writer，生成 opaque ID、设备身份、规范 word、精简快照和时间", async ({ page }) => {
  const dictionaryResult = makeDictionaryResult({
    baseWord: "Develop",
    futureDictionaryDetail: { labels: ["not-an-event-field"] }
  });
  const result = await page.evaluate(({ lookup, storageKey, deviceKey }) => {
    const repository = window.LingoFlowQueryEventRepository;
    const before = JSON.stringify(lookup);
    const created = repository.append("Develop!", lookup, "search");
    const missing = repository.append("中文", null);
    const after = JSON.stringify(lookup);
    lookup.futureDictionaryDetail.labels.push("outside-input");
    return {
      before,
      after,
      created,
      missing,
      persisted: repository.get(created.id),
      stored: JSON.parse(localStorage.getItem(storageKey))[created.id],
      deviceId: localStorage.getItem(deviceKey)
    };
  }, { lookup: dictionaryResult, storageKey: STORAGE_KEY, deviceKey: DEVICE_ID_KEY });

  expect(result.before).toBe(result.after);
  expect(result.created.id).toMatch(/^query:/);
  expect(result.created.deviceId).toMatch(/^device:/);
  expect(result.created.deviceId).toBe(result.deviceId);
  expect(result.created.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(result.created).toMatchObject({
    word: "develop",
    displayWord: "Develop!",
    phonetic: "/dɪˈveləp/",
    pos: "verb",
    meaning: "发展",
    dictionaryFound: true,
    source: "search"
  });
  expect(result.created).not.toHaveProperty("futureDictionaryDetail");
  expect(result.missing).toMatchObject({
    word: "",
    displayWord: "中文",
    phonetic: "",
    pos: "",
    meaning: "",
    dictionaryFound: false,
    source: "article"
  });
  expect(result.persisted).toEqual(result.created);
  expect(result.stored).toEqual(result.persisted);
});

test("append 不接受完整实体注入并拒绝危险 dictionaryResult，getter/toString 不执行", async ({ page }) => {
  const result = await page.evaluate(() => {
    const repository = window.LingoFlowQueryEventRepository;
    const baseResult = {
      baseWord: "develop",
      phonetic: "",
      pos: "verb",
      meaning: "发展"
    };

    let wordToStringCalls = 0;
    const fullEntityInsteadOfWord = {
      id: "query:provided",
      toString() {
        wordToStringCalls += 1;
        return "Develop";
      }
    };
    let fullEntityError = null;
    try {
      repository.append(fullEntityInsteadOfWord, baseResult);
    } catch (error) {
      fullEntityError = error.code;
    }

    let getterCalls = 0;
    const accessor = { ...baseResult };
    Object.defineProperty(accessor, "baseWord", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "develop";
      }
    });
    let accessorError = null;
    try {
      repository.append("Develop", accessor);
    } catch (error) {
      accessorError = error.code;
    }

    const symbolic = { ...baseResult, futureFact: Symbol("unsafe") };
    let symbolError = null;
    try {
      repository.append("Develop", symbolic);
    } catch (error) {
      symbolError = error.code;
    }

    const cyclic = { ...baseResult, futureFact: {} };
    cyclic.futureFact.self = cyclic.futureFact;
    let cycleError = null;
    try {
      repository.append("Develop", cyclic);
    } catch (error) {
      cycleError = error.code;
    }

    let sourceError = null;
    try {
      repository.append("Develop", baseResult, "other");
    } catch (error) {
      sourceError = error.code;
    }

    let baseWordTypeError = null;
    try {
      repository.append("Develop", { ...baseResult, baseWord: 42 });
    } catch (error) {
      baseWordTypeError = {
        name: error.name,
        code: error.code
      };
    }

    return {
      wordToStringCalls,
      fullEntityError,
      getterCalls,
      accessorError,
      symbolError,
      cycleError,
      sourceError,
      baseWordTypeError,
      list: repository.list()
    };
  });

  expect(result.wordToStringCalls).toBe(0);
  expect(result.fullEntityError).toBe("invalid-query-event-create-input");
  expect(result.getterCalls).toBe(0);
  expect(result.accessorError).toBe("invalid-query-event-create-input");
  expect(result.symbolError).toBe("invalid-query-event-create-input");
  expect(result.cycleError).toBe("invalid-query-event-create-input");
  expect(result.sourceError).toBe("invalid-query-event-create-input");
  expect(result.baseWordTypeError).toEqual({
    name: "Error",
    code: "invalid-query-event-create-input"
  });
  expect(result.list).toEqual([]);
});

test("生成 ID collision 时不覆盖已有 immutable event", async ({ page }) => {
  const existing = makeEvent("query:forced-collision");
  const result = await page.evaluate(({ storageKey, deviceKey, record, dictionaryResult }) => {
    localStorage.setItem(storageKey, JSON.stringify({ [record.id]: record }));
    localStorage.setItem(deviceKey, "device:existing");

    const cryptoPrototype = Object.getPrototypeOf(window.crypto);
    const originalDescriptor = Object.getOwnPropertyDescriptor(cryptoPrototype, "randomUUID");
    Object.defineProperty(cryptoPrototype, "randomUUID", {
      configurable: true,
      value: () => "forced-collision"
    });

    const before = localStorage.getItem(storageKey);
    let error = null;
    try {
      window.LingoFlowQueryEventRepository.append("Develop", dictionaryResult);
    } catch (caught) {
      error = { code: caught.code, message: caught.message };
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(cryptoPrototype, "randomUUID", originalDescriptor);
      } else {
        delete cryptoPrototype.randomUUID;
      }
    }
    return {
      error,
      unchanged: localStorage.getItem(storageKey) === before,
      stored: JSON.parse(localStorage.getItem(storageKey))[record.id]
    };
  }, {
    storageKey: STORAGE_KEY,
    deviceKey: DEVICE_ID_KEY,
    record: existing,
    dictionaryResult: makeDictionaryResult()
  });

  expect(result.error?.code).toBe("query-event-id-collision");
  expect(result.unchanged).toBe(true);
  expect(result.stored).toEqual(existing);
});

test("removeById 是 current-set hard delete，不修改事件也不生成 tombstone", async ({ page }) => {
  const event = makeEvent("query:hard-delete");
  const result = await page.evaluate(({ storageKey, record }) => {
    localStorage.setItem(storageKey, JSON.stringify({ [record.id]: record }));
    const repository = window.LingoFlowQueryEventRepository;
    const padded = repository.removeById(` ${record.id} `);
    const removed = repository.removeById(record.id);
    const again = repository.removeById(record.id);
    return {
      padded,
      removed,
      again,
      get: repository.get(record.id),
      list: repository.list(),
      raw: localStorage.getItem(storageKey)
    };
  }, { storageKey: STORAGE_KEY, record: event });

  expect(result.padded).toBeNull();
  expect(result.removed).toEqual(event);
  expect(result.removed).not.toHaveProperty("deletedAt");
  expect(result.removed).not.toHaveProperty("tombstone");
  expect(result.again).toBeNull();
  expect(result.get).toBeNull();
  expect(result.list).toEqual([]);
  expect(JSON.parse(result.raw)).toEqual({});
});

test("removeByWord 精确匹配已保存 word，跨事件删除且不 normalize", async ({ page }) => {
  const records = [
    makeEvent("query:word-b", { timestamp: "2026-08-24T10:00:01.000Z" }),
    makeEvent("query:word-a"),
    makeEvent("query:uppercase", { word: "Develop" }),
    makeEvent("query:keep", { word: "apple", displayWord: "Apple" })
  ];
  const result = await page.evaluate(({ storageKey, incoming }) => {
    localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(
      incoming.map(record => [record.id, record])
    )));
    const repository = window.LingoFlowQueryEventRepository;
    const invalid = repository.removeByWord(Symbol("develop"));
    const padded = repository.removeByWord(" develop ");
    const removed = repository.removeByWord("develop");
    return {
      invalid,
      padded,
      removed,
      remaining: repository.list(),
      raw: JSON.parse(localStorage.getItem(storageKey))
    };
  }, { storageKey: STORAGE_KEY, incoming: records });

  expect(result.invalid).toEqual({
    word: null,
    removedCount: 0,
    queryEventIds: []
  });
  expect(result.padded).toEqual({
    word: " develop ",
    removedCount: 0,
    queryEventIds: []
  });
  expect(result.removed).toEqual({
    word: "develop",
    removedCount: 2,
    queryEventIds: [records[1].id, records[0].id]
  });
  expect(result.remaining).toEqual([records[2], records[3]]);
  expect(result.raw).toEqual({
    [records[2].id]: records[2],
    [records[3].id]: records[3]
  });
});

test("removeByWord 无匹配时不写 storage，删除写入前检查 storage-changed", async ({ page }) => {
  const first = makeEvent("query:remove-word-race");
  const competing = makeEvent("query:competing", { word: "banana" });
  const result = await page.evaluate(({ storageKey, firstRecord, competingRecord }) => {
    const repository = window.LingoFlowQueryEventRepository;
    localStorage.setItem(storageKey, JSON.stringify({ [firstRecord.id]: firstRecord }));

    const originalSet = Storage.prototype.setItem;
    let writes = 0;
    Storage.prototype.setItem = function(key, value) {
      if (key === storageKey) writes += 1;
      return originalSet.call(this, key, value);
    };
    const missing = repository.removeByWord("missing");
    Storage.prototype.setItem = originalSet;

    const originalGet = Storage.prototype.getItem;
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
    let raceError = null;
    try {
      repository.removeByWord(firstRecord.word);
    } catch (error) {
      raceError = { code: error.code, message: error.message };
    } finally {
      Storage.prototype.getItem = originalGet;
    }
    const competingPreserved = JSON.parse(localStorage.getItem(storageKey));

    originalSet.call(localStorage, storageKey, JSON.stringify({
      [firstRecord.id]: firstRecord
    }));
    Storage.prototype.setItem = function(key, value) {
      if (key === storageKey) throw new DOMException("quota", "QuotaExceededError");
      return originalSet.call(this, key, value);
    };
    let writeFailure = null;
    try {
      repository.removeByWord(firstRecord.word);
    } catch (error) {
      writeFailure = { code: error.code, message: error.message };
    } finally {
      Storage.prototype.setItem = originalSet;
    }
    return {
      missing,
      writes,
      raceError,
      competingPreserved,
      writeFailure,
      storedAfterWriteFailure: JSON.parse(localStorage.getItem(storageKey))
    };
  }, { storageKey: STORAGE_KEY, firstRecord: first, competingRecord: competing });

  expect(result.missing).toEqual({
    word: "missing",
    removedCount: 0,
    queryEventIds: []
  });
  expect(result.writes).toBe(0);
  expect(result.raceError?.code).toBe("query-event-storage-changed");
  expect(result.competingPreserved).toEqual({ [competing.id]: competing });
  expect(result.writeFailure).toEqual({
    code: "query-event-storage-write-failed",
    message: "quota"
  });
  expect(result.storedAfterWriteFailure).toEqual({ [first.id]: first });
});

test("removeById 写入前检查 storage-changed，不覆盖并发数据", async ({ page }) => {
  const first = makeEvent("query:remove-id-race");
  const competing = makeEvent("query:remove-id-competing", { word: "banana" });
  const result = await page.evaluate(({ storageKey, firstRecord, competingRecord }) => {
    const repository = window.LingoFlowQueryEventRepository;
    localStorage.setItem(storageKey, JSON.stringify({ [firstRecord.id]: firstRecord }));
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
    let error = null;
    try {
      repository.removeById(firstRecord.id);
    } catch (caught) {
      error = { code: caught.code, message: caught.message };
    } finally {
      Storage.prototype.getItem = originalGet;
    }
    return {
      error,
      stored: JSON.parse(localStorage.getItem(storageKey))
    };
  }, { storageKey: STORAGE_KEY, firstRecord: first, competingRecord: competing });

  expect(result.error?.code).toBe("query-event-storage-changed");
  expect(result.stored).toEqual({ [competing.id]: competing });
});

test("clear 严格清除完整 QueryEvent namespace，missing storage 不写", async ({ page }) => {
  const records = [makeEvent("query:clear-b"), makeEvent("query:clear-a")];
  const result = await page.evaluate(({ storageKey, deviceKey, incoming }) => {
    localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(
      incoming.map(record => [record.id, record])
    )));
    localStorage.setItem(deviceKey, "device:must-remain");
    const repository = window.LingoFlowQueryEventRepository;
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
        deviceId: localStorage.getItem(deviceKey),
        list: repository.list()
      };
    } finally {
      Storage.prototype.removeItem = originalRemove;
    }
  }, { storageKey: STORAGE_KEY, deviceKey: DEVICE_ID_KEY, incoming: records });

  expect(result).toEqual({
    cleared: {
      removedCount: 2,
      queryEventIds: [records[1].id, records[0].id],
      written: true
    },
    missing: { removedCount: 0, queryEventIds: [], written: false },
    storedEmpty: { removedCount: 0, queryEventIds: [], written: true },
    removes: 2,
    raw: null,
    deviceId: "device:must-remain",
    list: []
  });
});

test("clear 拒绝损坏数据，报告并发变化和 removeItem 写入失败", async ({ page }) => {
  const initial = makeEvent("query:clear-initial");
  const competing = makeEvent("query:clear-competing", { word: "banana" });
  const result = await page.evaluate(({ storageKey, initialRecord, competingRecord }) => {
    const repository = window.LingoFlowQueryEventRepository;
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

    const malformedRaw = "{broken-query-events";
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
    code: "query-event-storage-read-failed",
    message: "read blocked"
  });
  expect(result.readFailurePreserved).toEqual({ [initial.id]: initial });
  expect(result.malformed).toBe("query-event-storage-malformed");
  expect(result.malformedUnchanged).toBe(true);
  expect(result.changed).toBe("query-event-storage-changed");
  expect(result.competingPreserved).toEqual({ [competing.id]: competing });
  expect(result.writeFailure).toEqual({
    code: "query-event-storage-write-failed",
    message: "remove blocked"
  });
  expect(result.finalRaw).toEqual({ [competing.id]: competing });
});

test("Backup assessment 区分 restorable、unchanged 和完整内容 conflict", async ({ page }) => {
  const local = makeEvent("query:assessment", {
    futureFact: { version: 1, labels: ["local"] }
  });
  const missing = makeEvent("query:missing-assessment");
  const result = await page.evaluate(({ storageKey, localRecord, missingRecord }) => {
    localStorage.setItem(storageKey, JSON.stringify({ [localRecord.id]: localRecord }));
    const repository = window.LingoFlowQueryEventRepository;
    return {
      missing: repository.assessBackupRestore(missingRecord),
      exact: repository.assessBackupRestore(localRecord),
      word: repository.assessBackupRestore({ ...localRecord, word: "changed" }),
      timestamp: repository.assessBackupRestore({
        ...localRecord,
        timestamp: "2026-08-24T10:00:01.000Z"
      }),
      unknown: repository.assessBackupRestore({
        ...localRecord,
        futureFact: { version: 2, labels: ["local"] }
      }),
      stored: repository.get(localRecord.id)
    };
  }, { storageKey: STORAGE_KEY, localRecord: local, missingRecord: missing });

  expect(result.missing).toMatchObject({
    status: "restorable",
    queryEventId: missing.id,
    written: false,
    conflictFields: []
  });
  expect(result.exact).toMatchObject({ status: "unchanged", written: false });
  expect(result.word).toMatchObject({ status: "conflict", conflictFields: ["word"] });
  expect(result.timestamp).toMatchObject({
    status: "conflict",
    conflictFields: ["timestamp"]
  });
  expect(result.unknown).toMatchObject({
    status: "conflict",
    conflictFields: ["futureFact"]
  });
  expect(result.stored).toEqual(local);
});

test("Backup restore 保留同 ID 冲突项并继续恢复其他独立事件", async ({ page }) => {
  const local = makeEvent("query:restore-conflict", {
    meaning: "本地释义"
  });
  const incomingConflict = {
    ...local,
    meaning: "备份中的不同释义"
  };
  const incomingRestorable = makeEvent("query:restore-after-conflict", {
    timestamp: "2026-08-24T10:00:01.000Z"
  });

  const result = await page.evaluate(({ storageKey, localRecord, incoming }) => {
    localStorage.setItem(storageKey, JSON.stringify({
      [localRecord.id]: localRecord
    }));
    const repository = window.LingoFlowQueryEventRepository;
    const restored = repository.restoreBackupRecords(incoming);
    return {
      restored,
      localAfter: repository.get(localRecord.id),
      added: repository.get(incoming[1].id)
    };
  }, {
    storageKey: STORAGE_KEY,
    localRecord: local,
    incoming: [incomingConflict, incomingRestorable]
  });

  expect(result.restored.status).toBe("completed-with-conflicts");
  expect(result.restored.summary).toMatchObject({
    restored: 1,
    conflicts: 1,
    failed: 0,
    notAttempted: 0
  });
  expect(result.restored.items[0]).toMatchObject({
    status: "conflict",
    queryEventId: local.id,
    written: false,
    conflictFields: ["meaning"]
  });
  expect(result.restored.items[1]).toMatchObject({
    status: "restored",
    queryEventId: incomingRestorable.id,
    written: true
  });
  expect(result.localAfter).toEqual(local);
  expect(result.added).toEqual(incomingRestorable);
});

test("不同 ID 的相同事件内容分别恢复为独立事件", async ({ page }) => {
  const first = makeEvent("query:same-content-a");
  const second = { ...first, id: "query:same-content-b" };
  const result = await page.evaluate(records => {
    const repository = window.LingoFlowQueryEventRepository;
    return {
      restore: repository.restoreBackupRecords(records),
      list: repository.list()
    };
  }, [first, second]);

  expect(result.restore.status).toBe("completed");
  expect(result.restore.summary).toMatchObject({ restored: 2, conflicts: 0 });
  expect(result.list).toHaveLength(2);
  expect(result.list.map(item => item.id)).toEqual([first.id, second.id]);
});

test("Backup restore 原样保留 ID/deviceId/timestamp/unknown fields，且幂等不修改输入", async ({ page }) => {
  const event = makeEvent("query:restore-preserve", {
    deviceId: "device:remote-original",
    timestamp: "2021-01-02T03:04:05.006Z",
    futureFact: { nested: [null, true, 2.5, { value: "exact" }] }
  });
  const result = await page.evaluate(({ record, storageKey }) => {
    const repository = window.LingoFlowQueryEventRepository;
    const before = JSON.stringify(record);
    const first = repository.restoreBackupRecords([record]);
    const after = JSON.stringify(record);
    const rawAfterFirst = localStorage.getItem(storageKey);
    record.futureFact.nested[3].value = "outside";
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
  }, { record: event, storageKey: STORAGE_KEY });

  expect(result.before).toBe(result.after);
  expect(result.first.items[0]).toMatchObject({
    status: "restored",
    queryEventId: event.id,
    written: true
  });
  expect(result.stored).toEqual(event);
  expect(result.second.items[0]).toMatchObject({ status: "unchanged", written: false });
  expect(result.rawUnchangedBySecond).toBe(true);
});

test("Backup 批次 schema invalid、duplicate 或危险结构时整批零写入且 getter 不执行", async ({ page }) => {
  const valid = makeEvent("query:valid-not-written");
  const invalid = makeEvent("query:invalid-source", { source: "other" });
  const result = await page.evaluate(({ validRecord, invalidRecord, storageKey }) => {
    const repository = window.LingoFlowQueryEventRepository;
    const invalidBatch = repository.restoreBackupRecords([validRecord, invalidRecord]);
    const duplicateBatch = repository.restoreBackupRecords([validRecord, { ...validRecord }]);

    let getterCalls = 0;
    const accessor = { ...validRecord, id: "query:accessor" };
    Object.defineProperty(accessor, "futureFact", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must-not-run";
      }
    });
    const accessorBatch = repository.restoreBackupRecords([accessor]);

    const cyclic = { ...validRecord, id: "query:cycle", futureFact: {} };
    cyclic.futureFact.self = cyclic.futureFact;
    const cycleBatch = repository.restoreBackupRecords([cyclic]);

    const symbolic = { ...validRecord, id: "query:symbol", futureFact: Symbol("unsafe") };
    const symbolBatch = repository.restoreBackupRecords([symbolic]);

    return {
      invalidBatch,
      duplicateBatch,
      accessorBatch,
      cycleBatch,
      symbolBatch,
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
  expect(result.getterCalls).toBe(0);
  expect(result.raw).toBeNull();
});

test("第二条写入失败时第一条保持 restored，失败项与后续项准确标记", async ({ page }) => {
  const records = [
    makeEvent("query:partial-first"),
    makeEvent("query:partial-second", { timestamp: "2026-08-24T10:00:01.000Z" }),
    makeEvent("query:partial-third", { timestamp: "2026-08-24T10:00:02.000Z" })
  ];
  const result = await page.evaluate(({ incoming, storageKey }) => {
    const repository = window.LingoFlowQueryEventRepository;
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
      queryEventId: records[0].id,
      status: "restored",
      written: true
    }),
    expect.objectContaining({
      index: 1,
      queryEventId: records[1].id,
      status: "failed",
      written: false
    }),
    expect.objectContaining({
      index: 2,
      queryEventId: records[2].id,
      status: "not-attempted",
      written: false
    })
  ]);
  expect(result.restored.errors[0]).toMatchObject({
    code: "query-event-storage-write-failed",
    index: 1,
    queryEventId: records[1].id
  });
  expect(Object.keys(result.stored)).toEqual([records[0].id]);
  expect(result.stored[records[0].id]).toEqual(records[0]);
});

test("初次 storage read failure 保留所有 queryEventId 并全部 not-attempted", async ({ page }) => {
  const records = [
    makeEvent("query:read-failure-a"),
    makeEvent("query:read-failure-b")
  ];
  const result = await page.evaluate(({ incoming, storageKey }) => {
    const repository = window.LingoFlowQueryEventRepository;
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
    queryEventId: records[0].id,
    written: false,
    reason: "query-event-storage-read-failed"
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
      queryEventId: records[0].id,
      status: "not-attempted",
      written: false
    }),
    expect.objectContaining({
      index: 1,
      queryEventId: records[1].id,
      status: "not-attempted",
      written: false
    })
  ]);
  expect(result.restored.errors[0]).toMatchObject({
    code: "query-event-storage-read-failed",
    message: "read blocked"
  });
});

test("Repository 不复用会吞掉损坏 JSON 的 QueryData.readJson 路径", async ({ page }) => {
  const result = await page.evaluate(storageKey => {
    const raw = "{broken-query-events";
    localStorage.setItem(storageKey, raw);
    const legacyBoundaryResult = window.LingoFlowLocalData.QueryData.getEvents();
    let repositoryError = null;
    try {
      window.LingoFlowQueryEventRepository.list();
    } catch (error) {
      repositoryError = { code: error.code, message: error.message };
    }
    return {
      legacyBoundaryResult,
      repositoryError,
      rawUnchanged: localStorage.getItem(storageKey) === raw
    };
  }, STORAGE_KEY);

  expect(result.legacyBoundaryResult).toEqual({});
  expect(result.repositoryError?.code).toBe("query-event-storage-malformed");
  expect(result.rawUnchanged).toBe(true);
});
