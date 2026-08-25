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
  await page.addScriptTag({ url: "/js/favorite-backup-schema.js" });
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

function makeFavorite(id, overrides = {}) {
  return {
    id,
    type: "word",
    text: "resilient",
    createdAt: "2026-08-24T01:00:00.000Z",
    updatedAt: "2026-08-24T02:00:00.000Z",
    deletedAt: null,
    ...overrides
  };
}

test("模块被冻结且验证 API 为纯同步方法", async ({ page }) => {
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowFavoriteBackupSchema;
    const single = schema.validateFavorite(incoming);
    const batch = schema.validateFavorites([incoming]);
    return {
      frozen: Object.isFrozen(schema),
      api: {
        validateFavorite: typeof schema.validateFavorite,
        validateFavorites: typeof schema.validateFavorites
      },
      singleIsPromise: Boolean(single?.then),
      batchIsPromise: Boolean(batch?.then)
    };
  }, makeFavorite("favorite:api"));

  expect(result).toEqual({
    frozen: true,
    api: {
      validateFavorite: "function",
      validateFavorites: "function"
    },
    singleIsPromise: false,
    batchIsPromise: false
  });
});

test("validateFavorite 接受两种类型、内容字段和软删除生命周期", async ({ page }) => {
  const favorites = [
    makeFavorite("favorite:word", {
      displayText: "Resilient",
      phonetic: "/rɪˈzɪliənt/",
      partOfSpeech: "adjective",
      meaning: "有韧性的",
      context: "A resilient system.",
      note: "Review later",
      tags: ["architecture", "sync"],
      origin: {
        kind: "article",
        articleId: "article:one",
        articleTitleSnapshot: "A title"
      }
    }),
    makeFavorite("favorite:phrase", {
      type: "phrase",
      text: "in the long run",
      updatedAt: "2026-08-24T03:00:00.000Z",
      deletedAt: "2026-08-24T03:00:00.000Z"
    })
  ];

  const result = await page.evaluate(incoming => ({
    single: window.LingoFlowFavoriteBackupSchema.validateFavorite(incoming[0]),
    batch: window.LingoFlowFavoriteBackupSchema.validateFavorites(incoming)
  }), favorites);

  expect(result.single.status).toBe("valid");
  expect(result.single.favorite).toEqual(favorites[0]);
  expect(result.batch.status).toBe("valid");
  expect(result.batch.summary).toEqual({ total: 2, valid: 2, rejected: 0 });
  expect(result.batch.favorites).toEqual(favorites);
});

test("validateFavorite 拒绝字段类型、非规范时间和生命周期乱序", async ({ page }) => {
  const cases = [
    { favorite: makeFavorite(" favorite:id"), path: "id" },
    { favorite: makeFavorite("favorite:type", { type: "term" }), path: "type" },
    { favorite: makeFavorite("favorite:text", { text: "   " }), path: "text" },
    { favorite: makeFavorite("favorite:note", { note: false }), path: "note" },
    { favorite: makeFavorite("favorite:tags", { tags: ["ok", 3] }), path: "tags" },
    {
      favorite: makeFavorite("favorite:origin", { origin: { articleId: " article:one" } }),
      path: "origin.articleId"
    },
    {
      favorite: makeFavorite("favorite:origin-array", { origin: [] }),
      path: "origin"
    },
    {
      favorite: makeFavorite("favorite:origin-kind", { origin: { kind: "   " } }),
      path: "origin.kind"
    },
    {
      favorite: makeFavorite("favorite:time", { createdAt: "2026-08-24T01:00:00Z" }),
      path: "createdAt"
    },
    {
      favorite: makeFavorite("favorite:offset", {
        updatedAt: "2026-08-24T10:00:00.000+08:00"
      }),
      path: "updatedAt"
    },
    {
      favorite: makeFavorite("favorite:invalid-date", {
        updatedAt: "2026-02-29T02:00:00.000Z"
      }),
      path: "updatedAt"
    },
    {
      favorite: makeFavorite("favorite:order", {
        createdAt: "2026-08-24T03:00:00.000Z",
        updatedAt: "2026-08-24T02:00:00.000Z"
      }),
      path: "updatedAt"
    },
    {
      favorite: makeFavorite("favorite:deleted-order", {
        deletedAt: "2026-08-24T03:00:00.000Z"
      }),
      path: "deletedAt"
    },
    {
      favorite: makeFavorite("favorite:deleted-before-create", {
        deletedAt: "2026-08-24T00:30:00.000Z"
      }),
      path: "deletedAt"
    }
  ];

  const results = await page.evaluate(incoming => incoming.map(candidate => ({
    path: candidate.path,
    result: window.LingoFlowFavoriteBackupSchema.validateFavorite(candidate.favorite)
  })), cases);

  for (const candidate of results) {
    expect(candidate.result.status).toBe("rejected");
    expect(candidate.result.errors).toContainEqual(expect.objectContaining({
      path: candidate.path
    }));
  }
});

test("Schema 保留文本原值、显式空字段和 null origin", async ({ page }) => {
  const favorite = makeFavorite("favorite:field-values", {
    text: "  keep surrounding whitespace  ",
    displayText: "",
    phonetic: "",
    partOfSpeech: "",
    meaning: "",
    context: "",
    note: "",
    tags: [],
    origin: null
  });
  const result = await page.evaluate(incoming => {
    const before = JSON.stringify(incoming);
    const validation = window.LingoFlowFavoriteBackupSchema.validateFavorite(incoming);
    return {
      validation,
      before,
      after: JSON.stringify(incoming),
      sameReference: validation.favorite === incoming
    };
  }, favorite);

  expect(result.validation.status).toBe("valid");
  expect(result.validation.favorite).toEqual(favorite);
  expect(result.validation.favorite.text).toBe("  keep surrounding whitespace  ");
  expect(result.sameReference).toBe(true);
  expect(result.after).toBe(result.before);
});

test("validateFavorite 不补必需字段且不修改输入", async ({ page }) => {
  const favorite = makeFavorite("favorite:missing");
  const result = await page.evaluate(incoming => {
    delete incoming.id;
    delete incoming.deletedAt;
    const before = JSON.stringify(incoming);
    const validation = window.LingoFlowFavoriteBackupSchema.validateFavorite(incoming);
    return {
      validation,
      before,
      after: JSON.stringify(incoming),
      hasId: Object.prototype.hasOwnProperty.call(incoming, "id"),
      hasDeletedAt: Object.prototype.hasOwnProperty.call(incoming, "deletedAt")
    };
  }, favorite);

  expect(result.validation.status).toBe("rejected");
  expect(result.validation.errors).toEqual(expect.arrayContaining([
    { code: "missing-field", path: "id" },
    { code: "missing-field", path: "deletedAt" }
  ]));
  expect(result.before).toBe(result.after);
  expect(result.hasId).toBe(false);
  expect(result.hasDeletedAt).toBe(false);
});

test("validateFavorites 接受空数组并拒绝非数组与重复 ID", async ({ page }) => {
  const favorite = makeFavorite("favorite:duplicate");
  const results = await page.evaluate(incoming => ({
    invalid: window.LingoFlowFavoriteBackupSchema.validateFavorites({}),
    empty: window.LingoFlowFavoriteBackupSchema.validateFavorites([]),
    duplicate: window.LingoFlowFavoriteBackupSchema.validateFavorites([
      incoming,
      { ...incoming }
    ])
  }), favorite);

  expect(results.invalid.status).toBe("rejected");
  expect(results.empty).toEqual({
    status: "valid",
    summary: { total: 0, valid: 0, rejected: 0 },
    favorites: [],
    items: [],
    errors: []
  });
  expect(results.duplicate.status).toBe("rejected");
  expect(results.duplicate.favorites).toEqual([]);
  expect(results.duplicate.errors).toContainEqual(expect.objectContaining({
    code: "duplicate-favorite-id",
    path: "id",
    index: 1,
    favoriteId: favorite.id,
    conflictingFavoriteId: favorite.id
  }));
});

test("同内容不同 ID 保持独立，任一非法项会拒绝整个集合", async ({ page }) => {
  const favorites = [
    makeFavorite("favorite:same-content-a"),
    makeFavorite("favorite:same-content-b")
  ];
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowFavoriteBackupSchema;
    const independent = schema.validateFavorites(incoming);
    const invalidSecond = { ...incoming[1], type: "term" };
    const mixed = schema.validateFavorites([incoming[0], invalidSecond]);
    return { independent, mixed };
  }, favorites);

  expect(result.independent.status).toBe("valid");
  expect(result.independent.favorites.map(item => item.id)).toEqual([
    "favorite:same-content-a",
    "favorite:same-content-b"
  ]);
  expect(result.mixed.status).toBe("rejected");
  expect(result.mixed.summary).toEqual({ total: 2, valid: 1, rejected: 1 });
  expect(result.mixed.favorites).toEqual([]);
  expect(result.mixed.items.map(item => item.status)).toEqual(["valid", "rejected"]);
});

test("所有 reserved fields 在任意嵌套层级均被拒绝", async ({ page }) => {
  const reservedFields = [
    "mastered", "reviewCount", "dueAt", "interval", "proficiency",
    "reviewInterval", "nextReviewAt", "dictionaryFound", "dictionaryVersion",
    "lemma",
    "syncStatus", "remoteId", "serverRevision", "deviceId", "dirty",
    "lastSyncedAt", "vectorClock", "normalizedKey", "searchIndex"
  ];
  const results = await page.evaluate(({ favorite, fields }) => fields.map(field => {
    const candidate = structuredClone(favorite);
    candidate.futureMetadata = { safe: true, nested: [{ [field]: "forbidden" }] };
    return {
      field,
      result: window.LingoFlowFavoriteBackupSchema.validateFavorite(candidate)
    };
  }), { favorite: makeFavorite("favorite:reserved"), fields: reservedFields });

  for (const { field, result } of results) {
    expect(result.status).toBe("rejected");
    expect(result.errors).toContainEqual({
      code: "reserved-field",
      path: `futureMetadata.nested[0].${field}`
    });
  }

  const topLevel = await page.evaluate(incoming => {
    const schema = window.LingoFlowFavoriteBackupSchema;
    return {
      mastered: schema.validateFavorite({ ...incoming, mastered: false }),
      lemma: schema.validateFavorite({ ...incoming, lemma: "resilient" }),
      mixed: schema.validateFavorites([
        incoming,
        { ...incoming, id: "favorite:reserved-mixed", lemma: "resilient" }
      ])
    };
  }, makeFavorite("favorite:reserved-top-level"));
  expect(topLevel.mastered.errors).toContainEqual({
    code: "reserved-field",
    path: "mastered"
  });
  expect(topLevel.lemma.errors).toContainEqual({
    code: "reserved-field",
    path: "lemma"
  });
  expect(topLevel.mixed.status).toBe("rejected");
  expect(topLevel.mixed.summary).toEqual({ total: 2, valid: 1, rejected: 1 });
  expect(topLevel.mixed.favorites).toEqual([]);
});

test("合法 unknown fields 被保留且验证不修改引用内容", async ({ page }) => {
  const favorite = makeFavorite("favorite:unknown", {
    futureAsset: {
      label: "keep me",
      flags: [true, false],
      nested: { count: 2 }
    }
  });
  const result = await page.evaluate(incoming => {
    const before = JSON.stringify(incoming);
    Object.freeze(incoming.futureAsset.nested);
    Object.freeze(incoming.futureAsset.flags);
    Object.freeze(incoming.futureAsset);
    Object.freeze(incoming);
    const single = window.LingoFlowFavoriteBackupSchema.validateFavorite(incoming);
    const batch = window.LingoFlowFavoriteBackupSchema.validateFavorites([incoming]);
    return {
      single,
      batch,
      sameSingleReference: single.favorite === incoming,
      sameBatchReference: batch.favorites[0] === incoming,
      before,
      after: JSON.stringify(incoming)
    };
  }, favorite);

  expect(result.single.status).toBe("valid");
  expect(result.batch.status).toBe("valid");
  expect(result.sameSingleReference).toBe(true);
  expect(result.sameBatchReference).toBe(true);
  expect(result.single.favorite.futureAsset).toEqual(favorite.futureAsset);
  expect(result.after).toBe(result.before);
});

test("getter、Symbol、稀疏数组与外层自定义属性均安全拒绝", async ({ page }) => {
  const result = await page.evaluate(incoming => {
    let getterCalls = 0;
    Object.defineProperty(incoming, "futureAsset", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "unsafe";
      }
    });
    const accessor = window.LingoFlowFavoriteBackupSchema.validateFavorite(incoming);

    const withSymbol = {
      id: "favorite:symbol",
      type: "word",
      text: "symbol",
      createdAt: "2026-08-24T01:00:00.000Z",
      updatedAt: "2026-08-24T02:00:00.000Z",
      deletedAt: null
    };
    withSymbol[Symbol("unsafe")] = true;
    const symbol = window.LingoFlowFavoriteBackupSchema.validateFavorite(withSymbol);

    const makeSafe = id => ({
      id,
      type: "word",
      text: "safe collection item",
      createdAt: "2026-08-24T01:00:00.000Z",
      updatedAt: "2026-08-24T02:00:00.000Z",
      deletedAt: null
    });

    const requiredAccessorValue = makeSafe("favorite:required-accessor");
    Object.defineProperty(requiredAccessorValue, "id", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "favorite:required-accessor";
      }
    });
    const requiredAccessor = window.LingoFlowFavoriteBackupSchema
      .validateFavorite(requiredAccessorValue);

    const nestedAccessorValue = makeSafe("favorite:nested-accessor");
    nestedAccessorValue.futureAsset = {};
    Object.defineProperty(nestedAccessorValue.futureAsset, "label", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "unsafe";
      }
    });
    const nestedAccessor = window.LingoFlowFavoriteBackupSchema
      .validateFavorite(nestedAccessorValue);

    const hiddenRequiredValue = makeSafe("favorite:hidden-required");
    Object.defineProperty(hiddenRequiredValue, "id", {
      enumerable: false,
      value: "favorite:hidden-required"
    });
    const hiddenRequired = window.LingoFlowFavoriteBackupSchema
      .validateFavorite(hiddenRequiredValue);

    const collection = [makeSafe("favorite:array")];
    Object.defineProperty(collection, "metadata", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return true;
      }
    });
    const outer = window.LingoFlowFavoriteBackupSchema.validateFavorites(collection);

    const sparse = [];
    sparse.length = 2;
    sparse[1] = makeSafe("favorite:sparse");
    const sparseResult = window.LingoFlowFavoriteBackupSchema.validateFavorites(sparse);

    const custom = [makeSafe("favorite:custom")];
    custom.metadata = true;
    const customResult = window.LingoFlowFavoriteBackupSchema.validateFavorites(custom);

    const symbolCollection = [makeSafe("favorite:symbol-collection")];
    symbolCollection[Symbol("metadata")] = true;
    const symbolCollectionResult = window.LingoFlowFavoriteBackupSchema
      .validateFavorites(symbolCollection);

    return {
      accessor,
      requiredAccessor,
      nestedAccessor,
      hiddenRequired,
      symbol,
      outer,
      sparseResult,
      customResult,
      symbolCollectionResult,
      getterCalls
    };
  }, makeFavorite("favorite:accessor"));

  expect(result.getterCalls).toBe(0);
  expect(result.accessor.status).toBe("rejected");
  expect(result.accessor.errors).toEqual([
    { code: "invalid-json-value", path: "futureAsset" }
  ]);
  expect(result.requiredAccessor.errors).toEqual([
    { code: "invalid-json-value", path: "id" }
  ]);
  expect(result.nestedAccessor.errors).toEqual([
    { code: "invalid-json-value", path: "futureAsset.label" }
  ]);
  expect(result.hiddenRequired.errors).toEqual([
    { code: "invalid-json-value", path: "id" }
  ]);
  expect(result.symbol.status).toBe("rejected");
  expect(result.outer.status).toBe("rejected");
  expect(result.sparseResult.status).toBe("rejected");
  expect(result.customResult.status).toBe("rejected");
  expect(result.symbolCollectionResult.status).toBe("rejected");
});

test("非普通对象与其他非 JSON 值均被拒绝", async ({ page }) => {
  const results = await page.evaluate(base => {
    const schema = window.LingoFlowFavoriteBackupSchema;
    const inherited = Object.create({ inherited: true });
    Object.assign(inherited, base, { id: "favorite:inherited" });

    const cyclic = { ...base, id: "favorite:cycle" };
    cyclic.futureAsset = cyclic;

    const sparseTags = new Array(2);
    sparseTags[0] = "first";

    return {
      entities: [null, [], new Date(), inherited].map(value => (
        schema.validateFavorite(value)
      )),
      unsafeValues: [
        { ...base, id: "favorite:undefined", futureAsset: undefined },
        { ...base, id: "favorite:function", futureAsset() {} },
        { ...base, id: "favorite:bigint", futureAsset: BigInt(1) },
        { ...base, id: "favorite:nan", futureAsset: NaN },
        { ...base, id: "favorite:infinity", futureAsset: Infinity },
        cyclic,
        { ...base, id: "favorite:sparse-tags", tags: sparseTags }
      ].map(value => schema.validateFavorite(value))
    };
  }, makeFavorite("favorite:json-base"));

  for (const result of results.entities) {
    expect(result.status).toBe("rejected");
    expect(result.favorite).toBeNull();
  }
  for (const result of results.unsafeValues) {
    expect(result.status).toBe("rejected");
    expect(result.errors).toContainEqual(expect.objectContaining({
      code: "invalid-json-value"
    }));
  }
});

test("Schema 不访问存储、Repository 或 Article 关系", async ({ page }) => {
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowFavoriteBackupSchema;
    const names = [
      "localStorage",
      "LingoFlowFavoriteRepository",
      "LingoFlowFavoriteLearningRepository",
      "LingoFlowArticleLibrary"
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
      single = schema.validateFavorite(incoming);
      batch = schema.validateFavorites([incoming]);
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
  }, makeFavorite("favorite:isolated", {
    origin: {
      kind: "article",
      articleId: "article:not-present",
      articleTitleSnapshot: "Snapshot survives without Article"
    }
  }));

  expect(result).toEqual({
    accesses: {
      localStorage: 0,
      LingoFlowFavoriteRepository: 0,
      LingoFlowFavoriteLearningRepository: 0,
      LingoFlowArticleLibrary: 0
    },
    singleStatus: "valid",
    batchStatus: "valid"
  });
});
