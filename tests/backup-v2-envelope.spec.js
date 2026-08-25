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
  await expect(page.locator("#inputText")).toBeVisible();
  expect(await page.evaluate(() => typeof window.LingoFlowBackupV2Envelope)).toBe("object");
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

function makeData() {
  return {
    articles: [{
      id: "article:envelope-fixture",
      title: "Envelope fixture",
      futureMetadata: {
        labels: ["backup", "envelope"]
      }
    }]
  };
}

function makeEnvelope(overrides = {}) {
  return {
    format: {
      name: "LingoFlow Backup",
      version: 2,
      ...(overrides.format || {})
    },
    metadata: {
      ...(overrides.metadata || {})
    },
    schema: {
      articles: "1",
      ...(overrides.schema || {})
    },
    data: overrides.data || makeData(),
    ...(overrides.extra || {})
  };
}

test("buildEnvelope 构建文档定义的 Article Envelope 且不修改输入", async ({ page }) => {
  const data = makeData();
  const result = await page.evaluate(incoming => {
    const before = JSON.stringify(incoming);
    const built = window.LingoFlowBackupV2Envelope.buildEnvelope(incoming);
    const isPromise = Boolean(built?.then);
    built.envelope.data.articles[0].title = "Changed in envelope";
    built.envelope.data.articles[0].futureMetadata.labels.push("changed");
    return {
      built,
      isPromise,
      before,
      after: JSON.stringify(incoming),
      original: incoming
    };
  }, data);

  expect(result.isPromise).toBe(false);
  expect(result.built.status).toBe("ready");
  expect(result.built.errors).toEqual([]);
  expect(result.built.envelope).toEqual({
    format: { name: "LingoFlow Backup", version: 2 },
    metadata: {},
    schema: { articles: "1" },
    data: {
      articles: [{
        ...data.articles[0],
        title: "Changed in envelope",
        futureMetadata: { labels: ["backup", "envelope", "changed"] }
      }]
    }
  });
  expect(result.after).toBe(result.before);
  expect(result.original).toEqual(data);
});

test("buildEnvelope 为传入的已注册实体生成完全对应的 schema 声明", async ({ page }) => {
  const data = {
    articles: [],
    favorites: [{ id: "favorite:envelope-container" }],
    favoriteLearningStates: [{ favoriteId: "favorite:envelope-container" }]
  };
  const result = await page.evaluate(incoming => (
    window.LingoFlowBackupV2Envelope.buildEnvelope(incoming)
  ), data);

  expect(result.status).toBe("ready");
  expect(result.envelope.schema).toEqual({
    articles: "1",
    favorites: "1",
    favoriteLearningStates: "1"
  });
  expect(result.envelope.data).toEqual(data);
});

test("validateEnvelope 接受空 Article 集合和合法未知字段且不修改输入", async ({ page }) => {
  const envelope = makeEnvelope({
    format: { compatibility: { minimumReader: 2 } },
    metadata: { generator: { name: "LingoFlow" } },
    data: {
      articles: [],
      futureMetadata: undefined
    },
    extra: {
      compatibility: { mode: "forward" }
    }
  });
  delete envelope.data.futureMetadata;

  const result = await page.evaluate(incoming => {
    const before = JSON.stringify(incoming);
    Object.freeze(incoming.format.compatibility);
    Object.freeze(incoming.format);
    Object.freeze(incoming.metadata.generator);
    Object.freeze(incoming.metadata);
    Object.freeze(incoming.schema);
    Object.freeze(incoming.data.articles);
    Object.freeze(incoming.data);
    Object.freeze(incoming.compatibility);
    Object.freeze(incoming);
    const validation = window.LingoFlowBackupV2Envelope.validateEnvelope(incoming);
    return {
      validation,
      sameReference: validation.envelope === incoming,
      before,
      after: JSON.stringify(incoming)
    };
  }, envelope);

  expect(result.validation.status).toBe("valid");
  expect(result.validation.errors).toEqual([]);
  expect(result.validation.envelope).toEqual(envelope);
  expect(result.sameReference).toBe(true);
  expect(result.after).toBe(result.before);
});

test("validateEnvelope 拒绝无效根结构和缺失必需分区", async ({ page }) => {
  const results = await page.evaluate(() => {
    const valid = {
      format: { name: "LingoFlow Backup", version: 2 },
      metadata: {},
      schema: { articles: "1" },
      data: { articles: [] }
    };
    return {
      nullEnvelope: window.LingoFlowBackupV2Envelope.validateEnvelope(null),
      arrayEnvelope: window.LingoFlowBackupV2Envelope.validateEnvelope([]),
      missing: ["format", "metadata", "schema", "data"].map(field => {
        const candidate = { ...valid };
        delete candidate[field];
        return window.LingoFlowBackupV2Envelope.validateEnvelope(candidate);
      })
    };
  });

  expect(results.nullEnvelope).toEqual({
    status: "rejected",
    envelope: null,
    errors: [{ code: "invalid-envelope", path: "$" }]
  });
  expect(results.arrayEnvelope.status).toBe("rejected");
  expect(results.missing.map(result => result.errors[0])).toEqual([
    { code: "missing-field", path: "format" },
    { code: "missing-field", path: "metadata" },
    { code: "missing-field", path: "schema" },
    { code: "missing-field", path: "data" }
  ]);
});

test("validateEnvelope 拒绝非法分区类型", async ({ page }) => {
  const results = await page.evaluate(() => {
    const makeValid = () => ({
      format: { name: "LingoFlow Backup", version: 2 },
      metadata: {},
      schema: { articles: "1" },
      data: { articles: [] }
    });
    return ["format", "metadata", "schema", "data"].map(field => {
      const candidate = makeValid();
      candidate[field] = [];
      return window.LingoFlowBackupV2Envelope.validateEnvelope(candidate);
    });
  });

  expect(results.map(result => result.errors[0])).toEqual([
    { code: "invalid-section", path: "format" },
    { code: "invalid-section", path: "metadata" },
    { code: "invalid-section", path: "schema" },
    { code: "invalid-section", path: "data" }
  ]);
});

test("validateEnvelope 验证格式身份、版本和 Article schema 声明", async ({ page }) => {
  const results = await page.evaluate(() => {
    const makeValid = () => ({
      format: { name: "LingoFlow Backup", version: 2 },
      metadata: {},
      schema: { articles: "1" },
      data: { articles: [] }
    });
    const wrongName = makeValid();
    wrongName.format.name = "Other Backup";
    const wrongVersion = makeValid();
    wrongVersion.format.version = 3;
    const wrongSchema = makeValid();
    wrongSchema.schema.articles = "2";
    const wrongCollection = makeValid();
    wrongCollection.data.articles = {};
    return [wrongName, wrongVersion, wrongSchema, wrongCollection].map(candidate => (
      window.LingoFlowBackupV2Envelope.validateEnvelope(candidate)
    ));
  });

  expect(results.map(result => result.status)).toEqual([
    "rejected",
    "rejected",
    "rejected",
    "rejected"
  ]);
  expect(results.map(result => result.errors[0])).toEqual([
    { code: "unsupported-format", path: "format.name" },
    { code: "unsupported-format-version", path: "format.version" },
    { code: "unsupported-schema-version", path: "schema.articles", entity: "articles" },
    { code: "invalid-entity-collection", path: "data.articles", entity: "articles" }
  ]);
});

test("validateEnvelope 要求 schema 与 data 同时声明 Article", async ({ page }) => {
  const results = await page.evaluate(() => {
    const base = {
      format: { name: "LingoFlow Backup", version: 2 },
      metadata: {}
    };
    return {
      missingSchema: window.LingoFlowBackupV2Envelope.validateEnvelope({
        ...base,
        schema: {},
        data: { articles: [] }
      }),
      missingData: window.LingoFlowBackupV2Envelope.validateEnvelope({
        ...base,
        schema: { articles: "1" },
        data: {}
      })
    };
  });

  expect(results.missingSchema.errors).toContainEqual({
    code: "missing-schema",
    path: "schema.articles",
    entity: "articles"
  });
  expect(results.missingData.errors).toContainEqual({
    code: "missing-data",
    path: "data.articles",
    entity: "articles"
  });
});

test("Envelope 接受全部已注册实体，并明确拒绝未注册实体", async ({ page }) => {
  const result = await page.evaluate(() => {
    let schemaCalls = 0;
    let libraryCalls = 0;
    window.LingoFlowBackupV2Schema = Object.freeze({
      validateArticles: () => {
        schemaCalls += 1;
        throw new Error("Envelope must not call Article Schema");
      }
    });
    window.LingoFlowArticleLibrary = Object.freeze({
      listArticles: () => {
        libraryCalls += 1;
        throw new Error("Envelope must not call Article Library");
      }
    });

    const registered = {
      format: { name: "LingoFlow Backup", version: 2 },
      metadata: {},
      schema: {
        articles: "1",
        favorites: "1",
        favoriteLearningStates: "1"
      },
      data: {
        articles: [],
        favorites: [],
        favoriteLearningStates: []
      }
    };
    const unsupported = {
      format: { name: "LingoFlow Backup", version: 2 },
      metadata: {},
      schema: { articles: "1", queryEvents: "1" },
      data: { articles: [], queryEvents: [] }
    };
    return {
      registered: window.LingoFlowBackupV2Envelope.validateEnvelope(registered),
      unsupported: window.LingoFlowBackupV2Envelope.validateEnvelope(unsupported),
      schemaCalls,
      libraryCalls
    };
  });

  expect(result.registered.status).toBe("valid");
  expect(result.registered.errors).toEqual([]);
  expect(result.unsupported.status).toBe("rejected");
  expect(result.unsupported.errors).toContainEqual({
    code: "unsupported-entity",
    path: "data.queryEvents",
    entity: "queryEvents"
  });
  expect(result.schemaCalls).toBe(0);
  expect(result.libraryCalls).toBe(0);
});

test("Envelope 只验证容器，不解释 Article 字段", async ({ page }) => {
  const result = await page.evaluate(() => {
    const envelope = {
      format: { name: "LingoFlow Backup", version: 2 },
      metadata: {},
      schema: { articles: "1" },
      data: { articles: [{ invalidArticleShape: true }] }
    };
    return window.LingoFlowBackupV2Envelope.validateEnvelope(envelope);
  });

  expect(result.status).toBe("valid");
  expect(result.envelope.data.articles).toEqual([{ invalidArticleShape: true }]);
});

test("Envelope 要求每个已注册实体的 schema 与 data key 一一对应", async ({ page }) => {
  const result = await page.evaluate(() => {
    const base = {
      format: { name: "LingoFlow Backup", version: 2 },
      metadata: {}
    };
    return {
      missingFavoriteData: window.LingoFlowBackupV2Envelope.validateEnvelope({
        ...base,
        schema: { articles: "1", favorites: "1" },
        data: { articles: [] }
      }),
      missingLearningSchema: window.LingoFlowBackupV2Envelope.validateEnvelope({
        ...base,
        schema: { articles: "1" },
        data: { articles: [], favoriteLearningStates: [] }
      })
    };
  });

  expect(result.missingFavoriteData.errors).toContainEqual({
    code: "missing-data",
    path: "data.favorites",
    entity: "favorites"
  });
  expect(result.missingLearningSchema.errors).toContainEqual({
    code: "missing-schema",
    path: "schema.favoriteLearningStates",
    entity: "favoriteLearningStates"
  });
});

test("Envelope 拒绝访问器、Symbol 和循环数据且不执行 getter", async ({ page }) => {
  const result = await page.evaluate(() => {
    const makeValid = () => ({
      format: { name: "LingoFlow Backup", version: 2 },
      metadata: {},
      schema: { articles: "1" },
      data: { articles: [] }
    });

    let getterCalls = 0;
    const withGetter = makeValid();
    Object.defineProperty(withGetter, "futureMetadata", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return {};
      }
    });

    const withSymbol = makeValid();
    withSymbol.metadata[Symbol("private")] = "not JSON";

    const cyclic = makeValid();
    cyclic.metadata.self = cyclic.metadata;

    return {
      getter: window.LingoFlowBackupV2Envelope.validateEnvelope(withGetter),
      symbol: window.LingoFlowBackupV2Envelope.validateEnvelope(withSymbol),
      cyclic: window.LingoFlowBackupV2Envelope.validateEnvelope(cyclic),
      getterCalls
    };
  });

  expect(result.getterCalls).toBe(0);
  expect(result.getter).toEqual({
    status: "rejected",
    envelope: null,
    errors: [{ code: "invalid-json-value", path: "futureMetadata" }]
  });
  expect(result.symbol.status).toBe("rejected");
  expect(result.symbol.errors[0]).toEqual({ code: "invalid-json-value", path: "metadata" });
  expect(result.cyclic.status).toBe("rejected");
  expect(result.cyclic.errors[0]).toEqual({
    code: "invalid-json-value",
    path: "metadata.self"
  });
});

test("Envelope 不读取必需字段 getter，并拒绝稀疏 Article 集合", async ({ page }) => {
  const result = await page.evaluate(() => {
    const makeValid = () => ({
      format: { name: "LingoFlow Backup", version: 2 },
      metadata: {},
      schema: { articles: "1" },
      data: { articles: [] }
    });

    let getterCalls = 0;
    const withGetter = makeValid();
    Object.defineProperty(withGetter, "format", {
      enumerable: false,
      get() {
        getterCalls += 1;
        return { name: "LingoFlow Backup", version: 2 };
      }
    });

    const sparse = makeValid();
    sparse.data.articles = new Array(2);
    sparse.data.articles[1] = { id: "article:sparse" };

    return {
      getter: window.LingoFlowBackupV2Envelope.validateEnvelope(withGetter),
      sparse: window.LingoFlowBackupV2Envelope.validateEnvelope(sparse),
      getterCalls
    };
  });

  expect(result.getterCalls).toBe(0);
  expect(result.getter).toEqual({
    status: "rejected",
    envelope: null,
    errors: [{ code: "invalid-json-value", path: "format" }]
  });
  expect(result.sparse).toEqual({
    status: "rejected",
    envelope: null,
    errors: [{ code: "invalid-json-value", path: "data.articles" }]
  });
});

test("buildEnvelope 拒绝无效或未支持的数据集合", async ({ page }) => {
  const result = await page.evaluate(() => ({
    missing: window.LingoFlowBackupV2Envelope.buildEnvelope({}),
    invalid: window.LingoFlowBackupV2Envelope.buildEnvelope({ articles: {} }),
    unsupported: window.LingoFlowBackupV2Envelope.buildEnvelope({
      articles: [],
      queryEvents: []
    })
  }));

  expect(result.missing.status).toBe("rejected");
  expect(result.invalid.errors).toContainEqual({
    code: "invalid-entity-collection",
    path: "data.articles",
    entity: "articles"
  });
  expect(result.unsupported.errors).toContainEqual({
    code: "unsupported-entity",
    path: "data.queryEvents",
    entity: "queryEvents"
  });
});

test("unwrapEnvelope 仅在 Envelope 有效时返回实体数据", async ({ page }) => {
  const result = await page.evaluate(() => {
    const valid = {
      format: { name: "LingoFlow Backup", version: 2 },
      metadata: {},
      schema: { articles: "1" },
      data: { articles: [] }
    };
    const invalid = { ...valid, format: { ...valid.format, version: 99 } };
    const validResult = window.LingoFlowBackupV2Envelope.unwrapEnvelope(valid);
    validResult.data.articles.push({ id: "article:unwrapped-copy" });
    const sourceAfterCopyChange = structuredClone(valid.data);
    valid.data.articles.push({ id: "article:source-change" });
    const copyAfterSourceChange = structuredClone(validResult.data);
    return {
      status: validResult.status,
      errors: validResult.errors,
      sameReference: validResult.data === valid.data,
      sourceAfterCopyChange,
      copyAfterSourceChange,
      invalidResult: window.LingoFlowBackupV2Envelope.unwrapEnvelope(invalid)
    };
  });

  expect(result.status).toBe("valid");
  expect(result.errors).toEqual([]);
  expect(result.sameReference).toBe(false);
  expect(result.sourceAfterCopyChange).toEqual({ articles: [] });
  expect(result.copyAfterSourceChange).toEqual({
    articles: [{ id: "article:unwrapped-copy" }]
  });
  expect(result.invalidResult.status).toBe("rejected");
  expect(result.invalidResult.data).toBeNull();
  expect(result.invalidResult.errors).toContainEqual({
    code: "unsupported-format-version",
    path: "format.version"
  });
});
