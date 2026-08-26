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
  await page.addScriptTag({ url: "/js/query-event-backup-schema.js" });
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

function makeQueryEvent(id, overrides = {}) {
  return {
    id,
    deviceId: "device:local-one",
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

test("模块被冻结且单项与集合验证均为纯同步 API", async ({ page }) => {
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowQueryEventBackupSchema;
    const single = schema.validateQueryEvent(incoming);
    const batch = schema.validateQueryEvents([incoming]);
    return {
      frozen: Object.isFrozen(schema),
      api: {
        validateQueryEvent: typeof schema.validateQueryEvent,
        validateQueryEvents: typeof schema.validateQueryEvents
      },
      singleIsPromise: Boolean(single?.then),
      batchIsPromise: Boolean(batch?.then)
    };
  }, makeQueryEvent("query:api"));

  expect(result).toEqual({
    frozen: true,
    api: {
      validateQueryEvent: "function",
      validateQueryEvents: "function"
    },
    singleIsPromise: false,
    batchIsPromise: false
  });
});

test("接受 article/search、词典命中与未命中的完整正式字段", async ({ page }) => {
  const events = [
    makeQueryEvent("query:article"),
    makeQueryEvent("query:search-miss", {
      word: "missing",
      displayWord: "Missing",
      phonetic: "",
      pos: "",
      meaning: "",
      dictionaryFound: false,
      source: "search"
    })
  ];
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowQueryEventBackupSchema;
    return {
      singles: incoming.map(item => schema.validateQueryEvent(item)),
      batch: schema.validateQueryEvents(incoming)
    };
  }, events);

  expect(result.singles.map(item => item.status)).toEqual(["valid", "valid"]);
  expect(result.singles[0].queryEvent).toEqual(events[0]);
  expect(result.batch.status).toBe("valid");
  expect(result.batch.summary).toEqual({ total: 2, valid: 2, rejected: 0 });
  expect(result.batch.queryEvents).toEqual(events);
});

test("word 必须存在，精确空字符串合法且不会从 displayWord 补造", async ({ page }) => {
  const result = await page.evaluate(base => {
    const schema = window.LingoFlowQueryEventBackupSchema;
    const missing = { ...base };
    delete missing.word;
    const empty = { ...base, id: "query:empty-word", word: "", displayWord: "中文" };
    const before = JSON.stringify(empty);
    const validation = schema.validateQueryEvent(empty);
    return {
      missing: schema.validateQueryEvent(missing),
      validation,
      before,
      after: JSON.stringify(empty),
      word: empty.word,
      sameReference: validation.queryEvent === empty
    };
  }, makeQueryEvent("query:word-boundary"));

  expect(result.missing.status).toBe("rejected");
  expect(result.missing.errors).toContainEqual({
    code: "missing-field",
    path: "word"
  });
  expect(result.validation.status).toBe("valid");
  expect(result.word).toBe("");
  expect(result.sameReference).toBe(false);
  expect(result.after).toBe(result.before);
});

test("word 拒绝 null、非字符串、仅空白和首尾空白且不做 trim", async ({ page }) => {
  const cases = [
    null,
    42,
    " ",
    "\t\n",
    " develop",
    "develop ",
    " develop "
  ];
  const results = await page.evaluate(({ base, values }) => {
    const schema = window.LingoFlowQueryEventBackupSchema;
    return values.map((value, index) => {
      const event = { ...base, id: `query:word-${index}`, word: value };
      const validation = schema.validateQueryEvent(event);
      return { validation, value: event.word };
    });
  }, { base: makeQueryEvent("query:word-types"), values: cases });

  for (let index = 0; index < results.length; index += 1) {
    expect(results[index].validation.status).toBe("rejected");
    expect(results[index].validation.errors).toContainEqual({
      code: "invalid-word",
      path: "word"
    });
    expect(results[index].value).toBe(cases[index]);
  }
});

test("id、deviceId 与 displayWord 必须是非空且无首尾空白的字符串", async ({ page }) => {
  const cases = [
    { field: "id", value: "", code: "invalid-id" },
    { field: "id", value: " query:one", code: "invalid-id" },
    { field: "id", value: null, code: "invalid-id" },
    { field: "deviceId", value: "", code: "invalid-device-id" },
    { field: "deviceId", value: "device:one ", code: "invalid-device-id" },
    { field: "deviceId", value: 1, code: "invalid-device-id" },
    { field: "displayWord", value: "", code: "invalid-display-word" },
    { field: "displayWord", value: " Develop", code: "invalid-display-word" },
    { field: "displayWord", value: null, code: "invalid-display-word" }
  ];
  const results = await page.evaluate(({ base, candidates }) => {
    const schema = window.LingoFlowQueryEventBackupSchema;
    return candidates.map(candidate => ({
      ...candidate,
      validation: schema.validateQueryEvent({
        ...base,
        [candidate.field]: candidate.value
      })
    }));
  }, { base: makeQueryEvent("query:string-boundary"), candidates: cases });

  for (const candidate of results) {
    expect(candidate.validation.status).toBe("rejected");
    expect(candidate.validation.errors).toContainEqual({
      code: candidate.code,
      path: candidate.field
    });
  }
});

test("快照文本允许空白原值但拒绝 null 与非字符串", async ({ page }) => {
  const accepted = makeQueryEvent("query:snapshot-whitespace", {
    phonetic: "",
    pos: "   ",
    meaning: "  preserve this snapshot  "
  });
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowQueryEventBackupSchema;
    const invalid = [
      { ...incoming, id: "query:phonetic-null", phonetic: null },
      { ...incoming, id: "query:pos-number", pos: 4 },
      { ...incoming, id: "query:meaning-boolean", meaning: false }
    ];
    return {
      accepted: schema.validateQueryEvent(incoming),
      invalid: invalid.map(item => schema.validateQueryEvent(item))
    };
  }, accepted);

  expect(result.accepted.status).toBe("valid");
  expect(result.accepted.queryEvent).toEqual(accepted);
  for (const validation of result.invalid) {
    expect(validation.status).toBe("rejected");
    expect(validation.errors).toContainEqual(expect.objectContaining({
      code: "invalid-field"
    }));
  }
});

test("dictionaryFound 只接受 boolean，source 只接受 article 或 search", async ({ page }) => {
  const result = await page.evaluate(base => {
    const schema = window.LingoFlowQueryEventBackupSchema;
    return {
      valid: ["article", "search"].map((source, index) => (
        schema.validateQueryEvent({
          ...base,
          id: `query:source-valid-${index}`,
          source,
          dictionaryFound: index === 0
        })
      )),
      dictionary: ["true", 1, null].map((value, index) => (
        schema.validateQueryEvent({
          ...base,
          id: `query:dictionary-${index}`,
          dictionaryFound: value
        })
      )),
      sources: ["", "article ", "library", null, 1].map((value, index) => (
        schema.validateQueryEvent({
          ...base,
          id: `query:source-${index}`,
          source: value
        })
      ))
    };
  }, makeQueryEvent("query:boolean-source"));

  expect(result.valid.map(item => item.status)).toEqual(["valid", "valid"]);
  for (const validation of result.dictionary) {
    expect(validation.errors).toContainEqual({
      code: "invalid-dictionary-found",
      path: "dictionaryFound"
    });
  }
  for (const validation of result.sources) {
    expect(validation.errors).toContainEqual({
      code: "invalid-source",
      path: "source"
    });
  }
});

test("timestamp 只接受真实的 canonical ISO 8601 UTC 毫秒时间", async ({ page }) => {
  const invalidValues = [
    "2026-08-24T10:00:00Z",
    "2026-08-24T18:00:00.000+08:00",
    "2026-08-24 10:00:00.000Z",
    "2026-02-29T10:00:00.000Z",
    " 2026-08-24T10:00:00.000Z",
    1787565600000,
    null
  ];
  const result = await page.evaluate(({ base, values }) => {
    const schema = window.LingoFlowQueryEventBackupSchema;
    return values.map((timestamp, index) => {
      const event = { ...base, id: `query:time-${index}`, timestamp };
      const validation = schema.validateQueryEvent(event);
      return { validation, timestamp: event.timestamp };
    });
  }, { base: makeQueryEvent("query:time"), values: invalidValues });

  for (let index = 0; index < result.length; index += 1) {
    expect(result[index].validation.status).toBe("rejected");
    expect(result[index].validation.errors).toContainEqual({
      code: "invalid-timestamp",
      path: "timestamp"
    });
    expect(result[index].timestamp).toBe(invalidValues[index]);
  }
});

test("不补齐任何必需字段且不修改输入", async ({ page }) => {
  const result = await page.evaluate(incoming => {
    delete incoming.deviceId;
    delete incoming.phonetic;
    delete incoming.timestamp;
    const before = JSON.stringify(incoming);
    const validation = window.LingoFlowQueryEventBackupSchema
      .validateQueryEvent(incoming);
    return {
      validation,
      before,
      after: JSON.stringify(incoming),
      keys: Object.keys(incoming)
    };
  }, makeQueryEvent("query:missing"));

  expect(result.validation.status).toBe("rejected");
  expect(result.validation.errors).toEqual(expect.arrayContaining([
    { code: "missing-field", path: "deviceId" },
    { code: "missing-field", path: "phonetic" },
    { code: "missing-field", path: "timestamp" }
  ]));
  expect(result.after).toBe(result.before);
  expect(result.keys).not.toContain("deviceId");
  expect(result.keys).not.toContain("phonetic");
  expect(result.keys).not.toContain("timestamp");
});

test("集合接受空数组，拒绝非数组、稀疏数组与重复 ID", async ({ page }) => {
  const event = makeQueryEvent("query:duplicate");
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowQueryEventBackupSchema;
    const sparse = new Array(2);
    sparse[0] = incoming;
    return {
      invalid: schema.validateQueryEvents({}),
      empty: schema.validateQueryEvents([]),
      sparse: schema.validateQueryEvents(sparse),
      duplicate: schema.validateQueryEvents([incoming, { ...incoming }])
    };
  }, event);

  expect(result.invalid).toEqual({
    status: "rejected",
    summary: { total: 0, valid: 0, rejected: 0 },
    queryEvents: [],
    items: [],
    errors: [{ code: "invalid-query-events", path: "$" }]
  });
  expect(result.empty).toEqual({
    status: "valid",
    summary: { total: 0, valid: 0, rejected: 0 },
    queryEvents: [],
    items: [],
    errors: []
  });
  expect(result.sparse.status).toBe("rejected");
  expect(result.duplicate.status).toBe("rejected");
  expect(result.duplicate.queryEvents).toEqual([]);
  expect(result.duplicate.errors).toContainEqual({
    code: "duplicate-query-event-id",
    path: "id",
    index: 1,
    queryEventId: event.id,
    conflictingQueryEventId: event.id
  });
});

test("不同 ID 的相同内容保持独立，任一非法项拒绝整个集合", async ({ page }) => {
  const events = [
    makeQueryEvent("query:same-a"),
    makeQueryEvent("query:same-b")
  ];
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowQueryEventBackupSchema;
    return {
      independent: schema.validateQueryEvents(incoming),
      mixed: schema.validateQueryEvents([
        incoming[0],
        { ...incoming[1], source: "library" }
      ])
    };
  }, events);

  expect(result.independent.status).toBe("valid");
  expect(result.independent.queryEvents.map(item => item.id)).toEqual([
    "query:same-a",
    "query:same-b"
  ]);
  expect(result.mixed.status).toBe("rejected");
  expect(result.mixed.summary).toEqual({ total: 2, valid: 1, rejected: 1 });
  expect(result.mixed.queryEvents).toEqual([]);
  expect(result.mixed.items.map(item => item.status)).toEqual(["valid", "rejected"]);
});

test("所有具体 reserved fields 在任意嵌套层级均被拒绝", async ({ page }) => {
  const fields = [
    "count", "articleCount", "searchCount", "firstSeen", "lastSeen",
    "vocab", "vocabCache", "createdAt", "updatedAt", "deletedAt",
    "tombstone", "migrationState", "migrationCompleted", "migrationVersion",
    "syncStatus", "remoteId", "serverRevision", "dirty", "lastSyncedAt",
    "vectorClock", "normalizedKey", "searchIndex", "dictionaryResource",
    "dictionaryEntries", "dictionaryData", "lemmaResource", "lemmaMappings",
    "lemmaData"
  ];
  const results = await page.evaluate(({ base, reserved }) => reserved.map(field => {
    const event = structuredClone(base);
    event.futureFact = { safe: true, nested: [{ [field]: "forbidden" }] };
    return {
      field,
      validation: window.LingoFlowQueryEventBackupSchema.validateQueryEvent(event)
    };
  }), { base: makeQueryEvent("query:reserved"), reserved: fields });

  for (const { field, validation } of results) {
    expect(validation.status).toBe("rejected");
    expect(validation.errors).toContainEqual({
      code: "reserved-field",
      path: `futureFact.nested[0].${field}`
    });
  }
});

test("顶层 reserved field 与混合批次均被拒绝", async ({ page }) => {
  const result = await page.evaluate(base => {
    const schema = window.LingoFlowQueryEventBackupSchema;
    return {
      topLevel: schema.validateQueryEvent({ ...base, count: 1 }),
      mixed: schema.validateQueryEvents([
        base,
        { ...base, id: "query:reserved-second", deletedAt: null }
      ])
    };
  }, makeQueryEvent("query:reserved-top"));

  expect(result.topLevel.errors).toContainEqual({
    code: "reserved-field",
    path: "count"
  });
  expect(result.mixed.status).toBe("rejected");
  expect(result.mixed.summary).toEqual({ total: 2, valid: 1, rejected: 1 });
  expect(result.mixed.queryEvents).toEqual([]);
  expect(result.mixed.errors).toContainEqual(expect.objectContaining({
    code: "reserved-field",
    path: "deletedAt",
    index: 1,
    queryEventId: "query:reserved-second"
  }));
});

test("合法 unknown fields 进入独立 validated snapshot 且双向 mutation 不串联", async ({ page }) => {
  const event = makeQueryEvent("query:unknown", {
    futureFact: {
      label: "keep me",
      confidence: 0.75,
      nullable: null,
      flags: [true, false],
      detail: { scope: "single-event" }
    }
  });
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowQueryEventBackupSchema;
    const before = JSON.stringify(incoming);
    const single = schema.validateQueryEvent(incoming);
    const batch = schema.validateQueryEvents([incoming]);
    const snapshotBeforeInputMutation = structuredClone(single.queryEvent);
    const batchSnapshotBeforeInputMutation = structuredClone(batch.queryEvents[0]);
    incoming.futureFact.detail.scope = "input-mutated";
    incoming.futureFact.flags.push(true);
    const snapshotAfterInputMutation = structuredClone(single.queryEvent);
    const batchSnapshotAfterInputMutation = structuredClone(batch.queryEvents[0]);
    single.queryEvent.futureFact.detail.scope = "snapshot-mutated";
    single.queryEvent.futureFact.flags.push(null);
    batch.queryEvents[0].futureFact.detail.scope = "batch-snapshot-mutated";
    batch.queryEvents[0].futureFact.flags.push("batch");
    return {
      single,
      batch,
      sameSingleReference: single.queryEvent === incoming,
      sameBatchReference: batch.queryEvents[0] === incoming,
      sameNestedSingleReference: single.queryEvent.futureFact === incoming.futureFact,
      sameNestedBatchReference: batch.queryEvents[0].futureFact === incoming.futureFact,
      sameSnapshotsBetweenCalls: single.queryEvent === batch.queryEvents[0],
      sameNestedSnapshotsBetweenCalls:
        single.queryEvent.futureFact.detail === batch.queryEvents[0].futureFact.detail,
      snapshotBeforeInputMutation,
      snapshotAfterInputMutation,
      batchSnapshotBeforeInputMutation,
      batchSnapshotAfterInputMutation,
      inputAfterSnapshotMutation: structuredClone(incoming),
      before,
      after: JSON.stringify(incoming)
    };
  }, event);

  expect(result.single.status).toBe("valid");
  expect(result.batch.status).toBe("valid");
  expect(result.sameSingleReference).toBe(false);
  expect(result.sameBatchReference).toBe(false);
  expect(result.sameNestedSingleReference).toBe(false);
  expect(result.sameNestedBatchReference).toBe(false);
  expect(result.sameSnapshotsBetweenCalls).toBe(false);
  expect(result.sameNestedSnapshotsBetweenCalls).toBe(false);
  expect(result.snapshotBeforeInputMutation).toEqual(event);
  expect(result.snapshotAfterInputMutation).toEqual(event);
  expect(result.batchSnapshotBeforeInputMutation).toEqual(event);
  expect(result.batchSnapshotAfterInputMutation).toEqual(event);
  expect(result.inputAfterSnapshotMutation.futureFact).toEqual({
    ...event.futureFact,
    flags: [true, false, true],
    detail: { scope: "input-mutated" }
  });
  expect(JSON.parse(result.after).futureFact).toEqual(
    result.inputAfterSnapshotMutation.futureFact
  );
});

test("getter、Symbol、循环、非普通对象和其他非 JSON 值安全拒绝", async ({ page }) => {
  const result = await page.evaluate(base => {
    const schema = window.LingoFlowQueryEventBackupSchema;
    let getterCalls = 0;
    const accessor = { ...base, id: "query:accessor" };
    Object.defineProperty(accessor, "futureFact", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "unsafe";
      }
    });
    const symbol = { ...base, id: "query:symbol" };
    symbol[Symbol("future")] = true;
    const cyclic = { ...base, id: "query:cyclic" };
    cyclic.futureFact = cyclic;
    const inherited = Object.create({ inherited: true });
    Object.assign(inherited, base, { id: "query:inherited" });

    const unsafe = [
      { ...base, id: "query:undefined", futureFact: undefined },
      { ...base, id: "query:function", futureFact() {} },
      { ...base, id: "query:bigint", futureFact: BigInt(1) },
      { ...base, id: "query:nan", futureFact: NaN },
      { ...base, id: "query:infinity", futureFact: Infinity },
      { ...base, id: "query:date", futureFact: new Date() },
      cyclic
    ];
    return {
      entities: [null, [], new Date(), inherited].map(value => (
        schema.validateQueryEvent(value)
      )),
      accessor: schema.validateQueryEvent(accessor),
      symbol: schema.validateQueryEvent(symbol),
      unsafe: unsafe.map(value => schema.validateQueryEvent(value)),
      getterCalls
    };
  }, makeQueryEvent("query:json"));

  expect(result.getterCalls).toBe(0);
  expect(result.accessor.errors).toEqual([
    { code: "invalid-json-value", path: "futureFact" }
  ]);
  expect(result.symbol.errors).toEqual([
    { code: "invalid-json-value", path: "$" }
  ]);
  for (const validation of [...result.entities, ...result.unsafe]) {
    expect(validation.status).toBe("rejected");
    expect(validation.queryEvent).toBeNull();
  }
});

test("集合拒绝自定义属性、accessor 与 Symbol 且不执行 getter", async ({ page }) => {
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowQueryEventBackupSchema;
    const custom = [incoming];
    custom.metadata = "invalid";
    let getterCalls = 0;
    const accessor = [incoming];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return incoming;
      }
    });
    const symbol = [incoming];
    symbol[Symbol("metadata")] = true;
    return {
      custom: schema.validateQueryEvents(custom),
      accessor: schema.validateQueryEvents(accessor),
      symbol: schema.validateQueryEvents(symbol),
      getterCalls
    };
  }, makeQueryEvent("query:collection-shape"));

  expect(result.getterCalls).toBe(0);
  for (const validation of [result.custom, result.accessor, result.symbol]) {
    expect(validation.status).toBe("rejected");
    expect(validation.summary).toEqual({ total: 0, valid: 0, rejected: 0 });
    expect(validation.queryEvents).toEqual([]);
    expect(validation.items).toEqual([]);
    expect(validation.errors).toHaveLength(1);
    expect(validation.errors[0]).toMatchObject({ code: "invalid-json-value" });
  }
});

test("Schema 不访问 localStorage、Repository、Vocab 或 Dictionary", async ({ page }) => {
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowQueryEventBackupSchema;
    const names = [
      "localStorage",
      "LingoFlowQueryEventRepository",
      "LingoFlowLocalData",
      "LingoFlowArticleLibrary",
      "LingoFlowDictionary"
    ];
    const descriptors = new Map();
    const accesses = Object.create(null);

    for (const name of names) {
      descriptors.set(name, Object.getOwnPropertyDescriptor(window, name));
      accesses[name] = 0;
      Object.defineProperty(window, name, {
        configurable: true,
        get() {
          accesses[name] += 1;
          throw new Error(`Schema 不应访问 ${name}。`);
        }
      });
    }

    let single;
    let batch;
    try {
      single = schema.validateQueryEvent(incoming);
      batch = schema.validateQueryEvents([incoming]);
    } finally {
      for (const name of names) {
        const descriptor = descriptors.get(name);
        if (descriptor) Object.defineProperty(window, name, descriptor);
        else delete window[name];
      }
    }

    return {
      accesses,
      singleStatus: single.status,
      batchStatus: batch.status
    };
  }, makeQueryEvent("query:isolated"));

  expect(result).toEqual({
    accesses: {
      localStorage: 0,
      LingoFlowQueryEventRepository: 0,
      LingoFlowLocalData: 0,
      LingoFlowArticleLibrary: 0,
      LingoFlowDictionary: 0
    },
    singleStatus: "valid",
    batchStatus: "valid"
  });
});
