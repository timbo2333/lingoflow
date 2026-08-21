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
  await page.addScriptTag({ url: "/js/backup-v2-schema.js" });
  expect(await page.evaluate(() => typeof window.LingoFlowBackupV2Schema)).toBe("object");
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

function makeArticle(id, overrides = {}) {
  const reading = {
    progress: 0.42,
    paragraphIndex: 3,
    updatedAt: "2026-08-21T03:00:00.000Z"
  };
  return {
    id,
    title: `Schema article ${id}`,
    content: `Schema validation content for ${id}.`,
    sourceType: "paste",
    createdAt: "2026-08-21T01:00:00.000Z",
    updatedAt: "2026-08-21T02:00:00.000Z",
    lastReadAt: "2026-08-21T04:00:00.000Z",
    deletedAt: null,
    ...overrides,
    reading: { ...reading, ...(overrides.reading || {}) }
  };
}

test("validateArticle 接受正常 Article 且为纯同步方法", async ({ page }) => {
  const article = makeArticle("article:schema-valid");
  const result = await page.evaluate(incoming => {
    const validation = window.LingoFlowBackupV2Schema.validateArticle(incoming);
    return {
      validation,
      isPromise: Boolean(validation?.then),
      sameReference: validation.article === incoming
    };
  }, article);

  expect(result.isPromise).toBe(false);
  expect(result.sameReference).toBe(true);
  expect(result.validation).toEqual({
    status: "valid",
    articleId: article.id,
    article,
    errors: []
  });
});

test("validateArticle 接受软删除 Article 并保留 Reading Progress", async ({ page }) => {
  const article = makeArticle("article:schema-deleted", {
    deletedAt: "2026-08-21T05:00:00.000Z",
    reading: {
      progress: 0.88,
      paragraphIndex: 9,
      updatedAt: "2026-08-21T04:30:00.000Z"
    }
  });
  const result = await page.evaluate(incoming => (
    window.LingoFlowBackupV2Schema.validateArticle(incoming)
  ), article);

  expect(result.status).toBe("valid");
  expect(result.article.deletedAt).toBe(article.deletedAt);
  expect(result.article.reading).toEqual(article.reading);
});

test("validateArticle 拒绝缺失字段且不自动补值", async ({ page }) => {
  const article = makeArticle("article:schema-missing");
  const result = await page.evaluate(incoming => {
    delete incoming.id;
    delete incoming.createdAt;
    delete incoming.reading.progress;
    const before = JSON.stringify(incoming);
    const validation = window.LingoFlowBackupV2Schema.validateArticle(incoming);
    return {
      validation,
      before,
      after: JSON.stringify(incoming),
      hasId: Object.prototype.hasOwnProperty.call(incoming, "id"),
      hasCreatedAt: Object.prototype.hasOwnProperty.call(incoming, "createdAt"),
      hasProgress: Object.prototype.hasOwnProperty.call(incoming.reading, "progress")
    };
  }, article);

  expect(result.validation.status).toBe("rejected");
  expect(result.validation.errors).toEqual(expect.arrayContaining([
    { code: "missing-field", path: "id" },
    { code: "missing-field", path: "createdAt" },
    { code: "missing-field", path: "reading.progress" }
  ]));
  expect(result.before).toBe(result.after);
  expect(result.hasId).toBe(false);
  expect(result.hasCreatedAt).toBe(false);
  expect(result.hasProgress).toBe(false);
});

test("validateArticle 拒绝字段类型和范围错误", async ({ page }) => {
  const cases = await page.evaluate(() => {
    const base = {
      id: "article:schema-types",
      title: "Schema types",
      content: "Type validation content.",
      sourceType: "paste",
      createdAt: "2026-08-21T01:00:00.000Z",
      updatedAt: "2026-08-21T02:00:00.000Z",
      lastReadAt: "2026-08-21T03:00:00.000Z",
      deletedAt: null,
      reading: {
        progress: 0.5,
        paragraphIndex: 2,
        updatedAt: "2026-08-21T03:00:00.000Z"
      }
    };
    const candidates = [
      { article: { ...base, id: 42 }, path: "id" },
      { article: { ...base, title: null }, path: "title" },
      { article: { ...base, content: [] }, path: "content" },
      { article: { ...base, sourceType: "remote" }, path: "sourceType" },
      { article: { ...base, createdAt: 123 }, path: "createdAt" },
      { article: { ...base, deletedAt: false }, path: "deletedAt" },
      {
        article: { ...base, reading: { ...base.reading, progress: "0.5" } },
        path: "reading.progress"
      },
      {
        article: { ...base, reading: { ...base.reading, paragraphIndex: 1.5 } },
        path: "reading.paragraphIndex"
      }
    ];
    return candidates.map(candidate => ({
      path: candidate.path,
      result: window.LingoFlowBackupV2Schema.validateArticle(candidate.article)
    }));
  });

  for (const candidate of cases) {
    expect(candidate.result.status).toBe("rejected");
    expect(candidate.result.errors).toContainEqual(expect.objectContaining({
      path: candidate.path
    }));
  }
});

test("validateArticle 拒绝非普通对象和非 JSON 数据", async ({ page }) => {
  const results = await page.evaluate(() => {
    const makeValid = () => ({
      id: "article:schema-json",
      title: "Schema JSON",
      content: "JSON validation content.",
      sourceType: "paste",
      createdAt: "2026-08-21T01:00:00.000Z",
      updatedAt: "2026-08-21T02:00:00.000Z",
      lastReadAt: "2026-08-21T03:00:00.000Z",
      deletedAt: null,
      reading: { progress: 0.2, paragraphIndex: 1, updatedAt: null }
    });
    const withFunction = makeValid();
    withFunction.extra = () => true;
    const withDate = makeValid();
    withDate.extra = new Date();
    const withNaN = makeValid();
    withNaN.extra = Number.NaN;
    const cyclic = makeValid();
    cyclic.extra = cyclic;

    return [null, [], withFunction, withDate, withNaN, cyclic].map(candidate => (
      window.LingoFlowBackupV2Schema.validateArticle(candidate)
    ));
  });

  expect(results).toHaveLength(6);
  for (const result of results) expect(result.status).toBe("rejected");
  expect(results.slice(2).map(result => result.errors[0].code)).toEqual([
    "invalid-json-value",
    "invalid-json-value",
    "invalid-json-value",
    "invalid-json-value"
  ]);
});

test("validateArticle 拒绝访问器属性且不触发 getter", async ({ page }) => {
  const article = makeArticle("article:schema-accessor");
  const result = await page.evaluate(incoming => {
    let getterCalls = 0;
    Object.defineProperty(incoming, "futureMetadata", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { value: "unsafe" };
      }
    });

    const validation = window.LingoFlowBackupV2Schema.validateArticle(incoming);
    return { validation, getterCalls };
  }, article);

  expect(result.getterCalls).toBe(0);
  expect(result.validation).toEqual({
    status: "rejected",
    articleId: article.id,
    article: null,
    errors: [{ code: "invalid-json-value", path: "futureMetadata" }]
  });
});

test("validateArticle 将非枚举必需 getter 视为无效且不读取", async ({ page }) => {
  const article = makeArticle("article:schema-hidden-id");
  const result = await page.evaluate(incoming => {
    let getterCalls = 0;
    Object.defineProperty(incoming, "id", {
      enumerable: false,
      get() {
        getterCalls += 1;
        return "article:schema-hidden-id";
      }
    });

    const validation = window.LingoFlowBackupV2Schema.validateArticle(incoming);
    const serialized = JSON.parse(JSON.stringify(incoming));
    return {
      validation,
      getterCalls,
      serializedHasId: Object.prototype.hasOwnProperty.call(serialized, "id")
    };
  }, article);

  expect(result.getterCalls).toBe(0);
  expect(result.serializedHasId).toBe(false);
  expect(result.validation).toEqual({
    status: "rejected",
    articleId: null,
    article: null,
    errors: [{ code: "invalid-json-value", path: "id" }]
  });
});

test("validateArticle 拒绝 Symbol 自有属性", async ({ page }) => {
  const article = makeArticle("article:schema-symbol");
  const result = await page.evaluate(incoming => {
    incoming[Symbol("futureMetadata")] = "not JSON data";
    return window.LingoFlowBackupV2Schema.validateArticle(incoming);
  }, article);

  expect(result).toEqual({
    status: "rejected",
    articleId: article.id,
    article: null,
    errors: [{ code: "invalid-json-value", path: "$" }]
  });
});

test("validateArticles 拒绝非数组并接受空数组", async ({ page }) => {
  const results = await page.evaluate(() => ({
    invalid: window.LingoFlowBackupV2Schema.validateArticles({}),
    empty: window.LingoFlowBackupV2Schema.validateArticles([])
  }));

  expect(results.invalid).toEqual({
    status: "rejected",
    summary: { total: 0, valid: 0, rejected: 0 },
    articles: [],
    items: [],
    errors: [{ code: "invalid-articles", path: "$" }]
  });
  expect(results.empty).toEqual({
    status: "valid",
    summary: { total: 0, valid: 0, rejected: 0 },
    articles: [],
    items: [],
    errors: []
  });
});

test("validateArticles 任一单项错误时拒绝整个批次", async ({ page }) => {
  const articles = [
    makeArticle("article:schema-batch-valid"),
    makeArticle("article:schema-batch-invalid", { content: "" })
  ];
  const result = await page.evaluate(incoming => (
    window.LingoFlowBackupV2Schema.validateArticles(incoming)
  ), articles);

  expect(result.status).toBe("rejected");
  expect(result.summary).toEqual({ total: 2, valid: 1, rejected: 1 });
  expect(result.articles).toEqual([]);
  expect(result.items.map(item => item.status)).toEqual(["valid", "rejected"]);
  expect(result.errors).toContainEqual(expect.objectContaining({
    code: "invalid-content",
    path: "content",
    index: 1,
    articleId: articles[1].id
  }));
});

test("validateArticles 拒绝批内重复 Article ID", async ({ page }) => {
  const article = makeArticle("article:schema-duplicate");
  const result = await page.evaluate(incoming => (
    window.LingoFlowBackupV2Schema.validateArticles([incoming, { ...incoming }])
  ), article);

  expect(result.status).toBe("rejected");
  expect(result.errors).toContainEqual(expect.objectContaining({
    code: "duplicate-article-id",
    path: "id",
    index: 1,
    articleId: article.id,
    conflictingArticleId: article.id
  }));
});

test("validateArticles 拒绝批内相同来源的不同 Article ID", async ({ page }) => {
  const articles = [
    makeArticle("article:schema-source-first", {
      sourceType: "library",
      sourceId: "library:schema-shared"
    }),
    makeArticle("article:schema-source-second", {
      sourceType: "library",
      sourceId: "library:schema-shared"
    })
  ];
  const result = await page.evaluate(incoming => (
    window.LingoFlowBackupV2Schema.validateArticles(incoming)
  ), articles);

  expect(result.status).toBe("rejected");
  expect(result.errors).toContainEqual(expect.objectContaining({
    code: "duplicate-article-source",
    path: "sourceId",
    index: 1,
    articleId: articles[1].id,
    conflictingArticleId: articles[0].id
  }));
});

test("Schema 保留合法未知字段且不修改输入", async ({ page }) => {
  const article = makeArticle("article:schema-unknown", {
    futureMetadata: {
      label: "keep me",
      flags: [true, false],
      nested: { count: 3 }
    }
  });
  const result = await page.evaluate(incoming => {
    const before = JSON.stringify(incoming);
    Object.freeze(incoming.futureMetadata.nested);
    Object.freeze(incoming.futureMetadata.flags);
    Object.freeze(incoming.futureMetadata);
    Object.freeze(incoming.reading);
    Object.freeze(incoming);

    const single = window.LingoFlowBackupV2Schema.validateArticle(incoming);
    const batch = window.LingoFlowBackupV2Schema.validateArticles([incoming]);
    return {
      single,
      batch,
      sameSingleReference: single.article === incoming,
      sameBatchReference: batch.articles[0] === incoming,
      before,
      after: JSON.stringify(incoming)
    };
  }, article);

  expect(result.single.status).toBe("valid");
  expect(result.batch.status).toBe("valid");
  expect(result.sameSingleReference).toBe(true);
  expect(result.sameBatchReference).toBe(true);
  expect(result.single.article.futureMetadata).toEqual(article.futureMetadata);
  expect(result.batch.articles[0].futureMetadata).toEqual(article.futureMetadata);
  expect(result.after).toBe(result.before);
});
