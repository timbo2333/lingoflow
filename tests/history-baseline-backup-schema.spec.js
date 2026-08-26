const { test, expect } = require("@playwright/test");

const projectErrors = new WeakMap();

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
  await page.addScriptTag({ url: "/js/history-baseline-backup-schema.js" });
  expect(await page.evaluate(() => (
    typeof window.LingoFlowHistoryBaselineBackupSchema
  ))).toBe("object");
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

function makeRecord(overrides = {}) {
  return {
    word: "develop",
    count: 7,
    articleCount: 4,
    searchCount: 2,
    firstSeen: "2026-08-01T10:00:00.000Z",
    lastSeen: "2026-08-02T10:00:00.000Z",
    displayWord: "Develop",
    phonetic: "/dɪˈveləp/",
    pos: "verb",
    meaning: "发展",
    dictionaryFound: true,
    source: "legacy-reader",
    ...overrides
  };
}

function makeBaseline(id, overrides = {}) {
  return {
    id,
    createdAt: "2026-08-24T10:00:00.000Z",
    deviceId: "legacy-source",
    records: {
      "compatibility-locator": makeRecord()
    },
    ...overrides
  };
}

test("模块被冻结且提供纯同步单项与集合验证 API", async ({ page }) => {
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowHistoryBaselineBackupSchema;
    const single = schema.validateHistoryBaseline(incoming);
    const batch = schema.validateHistoryBaselines([incoming]);
    return {
      frozen: Object.isFrozen(schema),
      api: {
        validateHistoryBaseline: typeof schema.validateHistoryBaseline,
        validateHistoryBaselines: typeof schema.validateHistoryBaselines
      },
      singleIsPromise: Boolean(single?.then),
      batchIsPromise: Boolean(batch?.then)
    };
  }, makeBaseline("legacy-local:api"));

  expect(result).toEqual({
    frozen: true,
    api: {
      validateHistoryBaseline: "function",
      validateHistoryBaselines: "function"
    },
    singleIsPromise: false,
    batchIsPromise: false
  });
});

test("接受完整记录、最小记录、空 Baseline 与 opaque locator", async ({ page }) => {
  const baselines = [
    makeBaseline("legacy-local:complete"),
    makeBaseline("legacy-import:minimal", {
      records: {
        "opaque locator": {
          word: "different-word",
          count: 1
        }
      }
    }),
    makeBaseline("legacy-local:empty", { records: {} }),
    makeBaseline("legacy-local:content-hash-looking", {
      records: {
        vocab: {
          word: "vocab",
          count: 2,
          articleCount: 0,
          searchCount: 0
        }
      }
    })
  ];

  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowHistoryBaselineBackupSchema;
    return {
      singles: incoming.map(item => schema.validateHistoryBaseline(item)),
      batch: schema.validateHistoryBaselines(incoming)
    };
  }, baselines);

  expect(result.singles.every(item => item.status === "valid")).toBe(true);
  expect(result.batch.status).toBe("valid");
  expect(result.batch.summary).toEqual({ total: 4, valid: 4, rejected: 0 });
  expect(result.batch.historyBaselines).toEqual(baselines);
  expect(Object.keys(result.batch.historyBaselines[1].records)).toEqual([
    "opaque locator"
  ]);
  expect(result.batch.historyBaselines[1].records["opaque locator"].word)
    .toBe("different-word");
});

test("顶层字段必需且严格验证 ID、deviceId、时间与 records 类型", async ({ page }) => {
  const result = await page.evaluate(base => {
    const schema = window.LingoFlowHistoryBaselineBackupSchema;
    const missing = { ...base };
    delete missing.id;
    delete missing.records;
    const cases = [
      { value: { ...base, id: "" }, path: "id" },
      { value: { ...base, id: " legacy-local:padded" }, path: "id" },
      { value: { ...base, id: 42 }, path: "id" },
      { value: { ...base, deviceId: "   " }, path: "deviceId" },
      { value: { ...base, deviceId: "legacy-source " }, path: "deviceId" },
      { value: { ...base, deviceId: null }, path: "deviceId" },
      { value: { ...base, createdAt: "2026-08-24T10:00:00Z" }, path: "createdAt" },
      { value: { ...base, createdAt: 1787556000000 }, path: "createdAt" },
      { value: { ...base, records: null }, path: "records" },
      { value: { ...base, records: [] }, path: "records" }
    ];
    return {
      missing: schema.validateHistoryBaseline(missing),
      cases: cases.map(candidate => ({
        path: candidate.path,
        validation: schema.validateHistoryBaseline(candidate.value)
      }))
    };
  }, makeBaseline("legacy-local:top-fields"));

  expect(result.missing.status).toBe("rejected");
  expect(result.missing.errors).toEqual(expect.arrayContaining([
    { code: "missing-field", path: "id" },
    { code: "missing-field", path: "records" }
  ]));
  for (const candidate of result.cases) {
    expect(candidate.validation.status).toBe("rejected");
    expect(candidate.validation.errors).toContainEqual(expect.objectContaining({
      path: candidate.path
    }));
  }
});

test("records 要求普通对象、合法 locator 以及必需的 word/count", async ({ page }) => {
  const result = await page.evaluate(base => {
    const schema = window.LingoFlowHistoryBaselineBackupSchema;
    const inheritedRecord = Object.create({ word: "develop", count: 1 });
    const cases = [
      { records: { "": { word: "develop", count: 1 } }, code: "invalid-record-locator" },
      { records: { " padded": { word: "develop", count: 1 } }, code: "invalid-record-locator" },
      { records: { locator: null }, code: "invalid-record" },
      { records: { locator: [] }, code: "invalid-record" },
      { records: { locator: inheritedRecord }, code: "invalid-json-value" },
      { records: { locator: { count: 1 } }, code: "missing-field" },
      { records: { locator: { word: "develop" } }, code: "missing-field" },
      { records: { locator: { word: " develop", count: 1 } }, code: "invalid-word" },
      { records: { locator: { word: "", count: 1 } }, code: "invalid-word" }
    ];
    return cases.map((candidate, index) => ({
      expectedCode: candidate.code,
      validation: schema.validateHistoryBaseline({
        ...base,
        id: `legacy-local:record-${index}`,
        records: candidate.records
      })
    }));
  }, makeBaseline("legacy-local:record-shape"));

  for (const candidate of result) {
    expect(candidate.validation.status).toBe("rejected");
    expect(candidate.validation.errors).toContainEqual(expect.objectContaining({
      code: candidate.expectedCode
    }));
  }
});

test("计数只接受安全整数并验证来源计数边界", async ({ page }) => {
  const invalidRecords = [
    { count: 0 },
    { count: -1 },
    { count: 1.5 },
    { count: "7" },
    { count: Number.MAX_SAFE_INTEGER + 1 },
    { count: 2, articleCount: -1 },
    { count: 2, articleCount: 1.5 },
    { count: 2, searchCount: "1" },
    { count: 2, articleCount: 3 },
    { count: 2, searchCount: 3 },
    { count: 2, articleCount: 2, searchCount: 1 }
  ];

  const result = await page.evaluate(({ base, records }) => {
    const schema = window.LingoFlowHistoryBaselineBackupSchema;
    return records.map((overrides, index) => schema.validateHistoryBaseline({
      ...base,
      id: `legacy-local:count-${index}`,
      records: {
        locator: {
          word: "develop",
          ...overrides
        }
      }
    }));
  }, { base: makeBaseline("legacy-local:count"), records: invalidRecords });

  for (const validation of result) {
    expect(validation.status).toBe("rejected");
    expect(validation.errors.some(error => (
      error.code === "invalid-count" ||
      error.code === "invalid-article-count" ||
      error.code === "invalid-search-count" ||
      error.code === "invalid-record-counts"
    ))).toBe(true);
  }
});

test("可选 snapshot 字段严格区分类型、缺失、空字符串与 null", async ({ page }) => {
  const result = await page.evaluate(base => {
    const schema = window.LingoFlowHistoryBaselineBackupSchema;
    const make = (id, record) => schema.validateHistoryBaseline({
      ...base,
      id,
      records: { locator: record }
    });
    return {
      validEmpty: make("legacy-local:empty-snapshots", {
        word: "develop",
        count: 1,
        articleCount: 0,
        searchCount: 0,
        displayWord: "",
        phonetic: "",
        pos: "",
        meaning: ""
      }),
      invalidText: make("legacy-local:invalid-text", {
        word: "develop",
        count: 1,
        meaning: null
      }),
      invalidDictionary: make("legacy-local:invalid-dictionary", {
        word: "develop",
        count: 1,
        dictionaryFound: "true"
      }),
      invalidSource: make("legacy-local:invalid-source", {
        word: "develop",
        count: 1,
        source: " legacy"
      })
    };
  }, makeBaseline("legacy-local:optional"));

  expect(result.validEmpty.status).toBe("valid");
  for (const validation of [
    result.invalidText,
    result.invalidDictionary,
    result.invalidSource
  ]) {
    expect(validation.status).toBe("rejected");
  }
});

test("时间必须为 canonical UTC 且只约束 firstSeen 不晚于 lastSeen", async ({ page }) => {
  const result = await page.evaluate(base => {
    const schema = window.LingoFlowHistoryBaselineBackupSchema;
    const validateRecord = (id, record) => schema.validateHistoryBaseline({
      ...base,
      id,
      records: { locator: { word: "develop", count: 1, ...record } }
    });
    return {
      invalidDate: validateRecord("legacy-local:invalid-date", {
        firstSeen: "2026-02-29T10:00:00.000Z"
      }),
      missingMillis: validateRecord("legacy-local:missing-millis", {
        firstSeen: "2026-08-01T10:00:00Z"
      }),
      offset: validateRecord("legacy-local:offset", {
        lastSeen: "2026-08-02T18:00:00.000+08:00"
      }),
      number: validateRecord("legacy-local:number-time", {
        lastSeen: 1785643200000
      }),
      reversed: validateRecord("legacy-local:reversed", {
        firstSeen: "2026-08-03T10:00:00.000Z",
        lastSeen: "2026-08-02T10:00:00.000Z"
      }),
      noCreatedAtRelation: validateRecord("legacy-local:no-created-relation", {
        firstSeen: "2026-08-25T10:00:00.000Z",
        lastSeen: "2026-08-26T10:00:00.000Z"
      })
    };
  }, makeBaseline("legacy-local:time"));

  for (const validation of [
    result.invalidDate,
    result.missingMillis,
    result.offset,
    result.number,
    result.reversed
  ]) {
    expect(validation.status).toBe("rejected");
  }
  expect(result.noCreatedAtRelation.status).toBe("valid");
});

test("集合接受空数组、拒绝重复 ID，并允许不同 ID 具有相同 records", async ({ page }) => {
  const baseline = makeBaseline("legacy-local:duplicate");
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowHistoryBaselineBackupSchema;
    return {
      invalid: schema.validateHistoryBaselines({}),
      empty: schema.validateHistoryBaselines([]),
      duplicate: schema.validateHistoryBaselines([incoming, { ...incoming }]),
      independent: schema.validateHistoryBaselines([
        incoming,
        { ...incoming, id: "legacy-local:independent" }
      ]),
      mixed: schema.validateHistoryBaselines([
        incoming,
        { ...incoming, id: "legacy-local:invalid-mixed", records: [] }
      ])
    };
  }, baseline);

  expect(result.invalid).toEqual({
    status: "rejected",
    summary: { total: 0, valid: 0, rejected: 0 },
    historyBaselines: [],
    items: [],
    errors: [{ code: "invalid-history-baselines", path: "$" }]
  });
  expect(result.empty).toEqual({
    status: "valid",
    summary: { total: 0, valid: 0, rejected: 0 },
    historyBaselines: [],
    items: [],
    errors: []
  });
  expect(result.duplicate.status).toBe("rejected");
  expect(result.duplicate.historyBaselines).toEqual([]);
  expect(result.duplicate.summary).toEqual({ total: 2, valid: 1, rejected: 1 });
  expect(result.duplicate.errors).toContainEqual({
    code: "duplicate-baseline-id",
    path: "id",
    index: 1,
    baselineId: baseline.id,
    conflictingBaselineId: baseline.id
  });
  expect(result.independent.status).toBe("valid");
  expect(result.independent.historyBaselines.map(item => item.id)).toEqual([
    "legacy-local:duplicate",
    "legacy-local:independent"
  ]);
  expect(result.mixed.status).toBe("rejected");
  expect(result.mixed.summary).toEqual({ total: 2, valid: 1, rejected: 1 });
  expect(result.mixed.historyBaselines).toEqual([]);
});

test("reserved fields 在顶层、record unknown extension 与嵌套数组中递归拒绝", async ({ page }) => {
  const reservedFields = [
    "updatedAt", "deletedAt", "tombstone", "queryEvents", "queryEventIds",
    "vocab", "vocabCache", "normalizedKey", "searchIndex", "migrationState",
    "migrationCompleted", "migrationVersion", "syncStatus", "remoteId",
    "serverRevision", "dirty", "lastSyncedAt", "vectorClock",
    "dictionaryResource", "dictionaryEntries", "dictionaryData",
    "lemmaResource", "lemmaMappings", "lemmaData"
  ];
  const result = await page.evaluate(({ baseline, fields }) => {
    const schema = window.LingoFlowHistoryBaselineBackupSchema;
    const nested = fields.map((field, index) => {
      const candidate = structuredClone(baseline);
      candidate.id = `legacy-local:reserved-${index}`;
      candidate.records["compatibility-locator"].futureSnapshot = {
        nested: [{ [field]: "forbidden" }]
      };
      return {
        field,
        validation: schema.validateHistoryBaseline(candidate)
      };
    });
    return {
      nested,
      topLevel: schema.validateHistoryBaseline({ ...baseline, updatedAt: null }),
      formalDictionaryFound: schema.validateHistoryBaseline(baseline),
      reservedLocator: schema.validateHistoryBaseline({
        ...baseline,
        id: "legacy-local:reserved-locator",
        records: {
          queryEvents: { word: "query-events", count: 1 },
          vocab: { word: "vocab", count: 1 }
        }
      })
    };
  }, { baseline: makeBaseline("legacy-local:reserved"), fields: reservedFields });

  for (const candidate of result.nested) {
    expect(candidate.validation.status).toBe("rejected");
    expect(candidate.validation.errors).toContainEqual({
      code: "reserved-field",
      path: `records[\"compatibility-locator\"].futureSnapshot.nested[0].${candidate.field}`
    });
  }
  expect(result.topLevel.errors).toContainEqual({
    code: "reserved-field",
    path: "updatedAt"
  });
  expect(result.formalDictionaryFound.status).toBe("valid");
  expect(result.reservedLocator.status).toBe("valid");
});

test("合法 unknown fields 原样进入独立 validated snapshot 且输入输出互不影响", async ({ page }) => {
  const baseline = makeBaseline("legacy-local:unknown", {
    futureProvenance: {
      label: "keep me",
      flags: [true, false],
      nested: { score: 2 }
    }
  });
  baseline.records["compatibility-locator"].futureSnapshot = {
    note: "preserve",
    values: [1, null, { enabled: true }]
  };

  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowHistoryBaselineBackupSchema;
    Object.freeze(incoming.futureProvenance.nested);
    Object.freeze(incoming.futureProvenance.flags);
    Object.freeze(incoming.futureProvenance);
    const single = schema.validateHistoryBaseline(incoming);
    const batch = schema.validateHistoryBaselines([incoming]);
    const references = {
      singleRoot: single.historyBaseline === incoming,
      singleRecords: single.historyBaseline.records === incoming.records,
      singleRecord: single.historyBaseline.records["compatibility-locator"] ===
        incoming.records["compatibility-locator"],
      singleUnknown: single.historyBaseline.futureProvenance === incoming.futureProvenance,
      batchRoot: batch.historyBaselines[0] === incoming,
      batchVsSingle: batch.historyBaselines[0] === single.historyBaseline
    };

    incoming.records["compatibility-locator"].count = 99;
    incoming.records.added = { word: "added", count: 1 };
    single.historyBaseline.records["compatibility-locator"].meaning = "changed output";
    single.historyBaseline.futureProvenance.flags.push(true);

    return {
      single,
      batch,
      inputCount: incoming.records["compatibility-locator"].count,
      inputMeaning: incoming.records["compatibility-locator"].meaning,
      inputFlags: incoming.futureProvenance.flags,
      references
    };
  }, baseline);

  expect(result.references).toEqual({
    singleRoot: false,
    singleRecords: false,
    singleRecord: false,
    singleUnknown: false,
    batchRoot: false,
    batchVsSingle: false
  });
  expect(result.single.historyBaseline.records["compatibility-locator"].count).toBe(7);
  expect(result.single.historyBaseline.records["compatibility-locator"].meaning)
    .toBe("changed output");
  expect(result.batch.historyBaselines[0].records["compatibility-locator"].count).toBe(7);
  expect(result.batch.historyBaselines[0].records["compatibility-locator"].meaning)
    .toBe("发展");
  expect(result.batch.historyBaselines[0].futureProvenance.flags).toEqual([true, false]);
  expect(result.inputCount).toBe(99);
  expect(result.inputMeaning).toBe("发展");
  expect(result.inputFlags).toEqual([true, false]);
});

test("拒绝 getter、Symbol、循环引用、非有限数值与非 JSON unknown values", async ({ page }) => {
  const result = await page.evaluate(base => {
    const schema = window.LingoFlowHistoryBaselineBackupSchema;
    let getterCalls = 0;

    const accessor = structuredClone(base);
    Object.defineProperty(accessor.records["compatibility-locator"], "futureSnapshot", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "unsafe";
      }
    });

    const requiredAccessor = structuredClone(base);
    Object.defineProperty(requiredAccessor, "id", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "legacy-local:accessor";
      }
    });

    const withSymbol = structuredClone(base);
    withSymbol.records["compatibility-locator"][Symbol("unsafe")] = true;

    const cyclic = structuredClone(base);
    cyclic.futureSnapshot = cyclic;

    const inherited = Object.create({ inherited: true });
    Object.assign(inherited, base, { id: "legacy-local:inherited" });

    const sparseUnknown = structuredClone(base);
    sparseUnknown.futureSnapshot = new Array(2);
    sparseUnknown.futureSnapshot[0] = "first";

    const nonEnumerable = structuredClone(base);
    Object.defineProperty(nonEnumerable.records["compatibility-locator"], "hidden", {
      enumerable: false,
      value: "unsafe"
    });

    const unsafe = [
      { ...base, id: "legacy-local:undefined", futureSnapshot: undefined },
      { ...base, id: "legacy-local:function", futureSnapshot() {} },
      { ...base, id: "legacy-local:bigint", futureSnapshot: BigInt(1) },
      { ...base, id: "legacy-local:nan", futureSnapshot: NaN },
      { ...base, id: "legacy-local:infinity", futureSnapshot: Infinity },
      cyclic,
      inherited,
      sparseUnknown,
      nonEnumerable
    ];

    return {
      accessor: schema.validateHistoryBaseline(accessor),
      requiredAccessor: schema.validateHistoryBaseline(requiredAccessor),
      symbol: schema.validateHistoryBaseline(withSymbol),
      unsafe: unsafe.map(item => schema.validateHistoryBaseline(item)),
      getterCalls
    };
  }, makeBaseline("legacy-local:json"));

  expect(result.getterCalls).toBe(0);
  for (const validation of [
    result.accessor,
    result.requiredAccessor,
    result.symbol,
    ...result.unsafe
  ]) {
    expect(validation.status).toBe("rejected");
    expect(validation.historyBaseline).toBeNull();
    expect(validation.errors.some(error => (
      error.code === "invalid-json-value" || error.code === "invalid-baseline"
    ))).toBe(true);
  }
});

test("验证器不访问存储、Repository、QueryEvent、Vocab 或 Migration State", async ({ page }) => {
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowHistoryBaselineBackupSchema;
    let accesses = 0;
    const originalStorageMethods = {};
    for (const method of ["getItem", "setItem", "removeItem", "clear", "key"]) {
      originalStorageMethods[method] = Storage.prototype[method];
      Storage.prototype[method] = function() {
        accesses += 1;
        throw new Error(`unexpected storage access: ${method}`);
      };
    }

    const trappedGlobals = [
      "LingoFlowLocalData",
      "LingoFlowHistoryBaselineRepository",
      "LingoFlowQueryEventRepository",
      "LingoFlowQueryEventBackupSchema",
      "LingoFlowVocabProjector",
      "EnglishReaderV052HistoryMigrationState"
    ];
    for (const name of trappedGlobals) {
      Object.defineProperty(window, name, {
        configurable: true,
        get() {
          accesses += 1;
          throw new Error(`unexpected global access: ${name}`);
        }
      });
    }

    const single = schema.validateHistoryBaseline(incoming);
    const batch = schema.validateHistoryBaselines([incoming]);

    for (const method of Object.keys(originalStorageMethods)) {
      Storage.prototype[method] = originalStorageMethods[method];
    }
    return {
      accesses,
      singleStatus: single.status,
      batchStatus: batch.status
    };
  }, makeBaseline("legacy-local:pure-boundary"));

  expect(result).toEqual({
    accesses: 0,
    singleStatus: "valid",
    batchStatus: "valid"
  });
});

test("集合拒绝稀疏、自定义属性、Symbol 与 accessor 且不执行 getter", async ({ page }) => {
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowHistoryBaselineBackupSchema;
    let getterCalls = 0;

    const sparse = new Array(2);
    sparse[0] = incoming;

    const custom = [incoming];
    custom.metadata = "unsafe";

    const symbol = [incoming];
    symbol[Symbol("metadata")] = true;

    const accessor = [incoming];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return incoming;
      }
    });

    return {
      validations: [sparse, custom, symbol, accessor].map(collection => (
        schema.validateHistoryBaselines(collection)
      )),
      getterCalls
    };
  }, makeBaseline("legacy-local:array"));

  expect(result.getterCalls).toBe(0);
  for (const validation of result.validations) {
    expect(validation.status).toBe("rejected");
    expect(validation.historyBaselines).toEqual([]);
  }
});

test("缺失字段不会被补齐，验证不生成 ID、时间或 locator", async ({ page }) => {
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowHistoryBaselineBackupSchema;
    delete incoming.id;
    delete incoming.createdAt;
    const before = JSON.stringify(incoming);
    const validation = schema.validateHistoryBaseline(incoming);
    return {
      validation,
      before,
      after: JSON.stringify(incoming),
      keys: Object.keys(incoming),
      locatorKeys: Object.keys(incoming.records)
    };
  }, makeBaseline("legacy-local:no-generation"));

  expect(result.validation.status).toBe("rejected");
  expect(result.validation.baselineId).toBeNull();
  expect(result.before).toBe(result.after);
  expect(result.keys).not.toContain("id");
  expect(result.keys).not.toContain("createdAt");
  expect(result.locatorKeys).toEqual(["compatibility-locator"]);
});
