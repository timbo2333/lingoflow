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
  expect(await page.evaluate(() => typeof window.LingoFlowBackupV2Export)).toBe("object");
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

function makeArticle(id, overrides = {}) {
  const reading = {
    progress: 0.36,
    paragraphIndex: 2,
    updatedAt: "2026-08-20T03:00:00.000Z"
  };
  return {
    id,
    title: `Export article ${id}`,
    content: `Exportable content for ${id}.`,
    sourceType: "paste",
    createdAt: "2026-08-20T01:00:00.000Z",
    updatedAt: "2026-08-20T02:00:00.000Z",
    lastReadAt: "2026-08-20T04:00:00.000Z",
    deletedAt: null,
    ...overrides,
    reading: { ...reading, ...(overrides.reading || {}) }
  };
}

test("Backup v2 Export 导出活动 Article，并保留来源、阅读和生命周期字段", async ({ page }) => {
  const article = makeArticle("article:export-active", {
    sourceType: "library",
    sourceId: "library:export-active",
    sourceTitle: "Export source title",
    sourceAttribution: "Export attribution",
    extension: { labels: ["backup", "export"] }
  });
  const result = await page.evaluate(async incoming => {
    const library = window.LingoFlowArticleLibrary;
    await library.restoreArticle(incoming);
    const exported = await window.LingoFlowBackupV2Export.exportArticles();
    const validation = exported.payload
      ? window.LingoFlowBackupV2Schema.validateArticles(exported.payload.articles)
      : null;
    return { exported, validation };
  }, article);

  expect(result.exported).toEqual({
    status: "ready",
    payload: { articles: [article] }
  });
  expect(result.validation?.status).toBe("valid");
});

test("Backup v2 Export 同时导出软删除 Article", async ({ page }) => {
  const active = makeArticle("article:export-active-record");
  const deleted = makeArticle("article:export-deleted", {
    deletedAt: "2026-08-20T05:00:00.000Z",
    reading: {
      progress: 0.78,
      paragraphIndex: 7,
      updatedAt: "2026-08-20T04:30:00.000Z"
    }
  });
  const result = await page.evaluate(async incoming => {
    const library = window.LingoFlowArticleLibrary;
    for (const article of incoming) {
      await library.restoreArticle(article);
    }
    return await window.LingoFlowBackupV2Export.exportArticles();
  }, [active, deleted]);

  expect(result.status).toBe("ready");
  expect(result.payload.articles).toHaveLength(2);
  expect(result.payload.articles).toEqual(expect.arrayContaining([active, deleted]));
});

test("Backup v2 Export 接受空 Article 集合", async ({ page }) => {
  const result = await page.evaluate(() => (
    window.LingoFlowBackupV2Export.exportArticles()
  ));

  expect(result).toEqual({
    status: "ready",
    payload: { articles: [] }
  });
});

test("Backup v2 Export 在 Schema 拒绝异常 Article 时不返回 payload", async ({ page }) => {
  const result = await page.evaluate(async () => {
    let listOptions = null;
    window.LingoFlowArticleLibrary = Object.freeze({
      listArticles: async options => {
        listOptions = options;
        return [{ id: "article:invalid-export" }];
      }
    });

    return {
      result: await window.LingoFlowBackupV2Export.exportArticles(),
      listOptions
    };
  });

  expect(result.listOptions).toEqual({ includeDeleted: true });
  expect(result.result).toEqual({ status: "rejected", payload: null });
});

test("Backup v2 Export 在 Article Library 读取异常时返回 failed", async ({ page }) => {
  const result = await page.evaluate(async () => {
    window.LingoFlowArticleLibrary = Object.freeze({
      listArticles: async () => {
        throw new Error("Article read failed");
      }
    });
    return await window.LingoFlowBackupV2Export.exportArticles();
  });

  expect(result).toEqual({ status: "failed", payload: null });
});

test("Backup v2 Export 不调用恢复接口，也不修改已存储的 Article", async ({ page }) => {
  const article = makeArticle("article:export-read-only");
  const result = await page.evaluate(async incoming => {
    const original = window.LingoFlowArticleLibrary;
    await original.restoreArticle(incoming);
    let restoreCalls = 0;
    let assessmentCalls = 0;
    window.LingoFlowArticleLibrary = Object.freeze({
      listArticles: original.listArticles,
      restoreArticle: async () => {
        restoreCalls += 1;
        throw new Error("Export must not restore Article");
      },
      assessArticleRestore: async () => {
        assessmentCalls += 1;
        throw new Error("Export must not assess Article restore");
      }
    });

    const exported = await window.LingoFlowBackupV2Export.exportArticles();
    exported.payload.articles[0].content = "Mutated export payload";
    exported.payload.articles[0].reading.progress = 0.99;
    const stored = await original.getArticle(incoming.id);
    return { exported, stored, restoreCalls, assessmentCalls };
  }, article);

  expect(result.exported.status).toBe("ready");
  expect(result.restoreCalls).toBe(0);
  expect(result.assessmentCalls).toBe(0);
  expect(result.stored).toEqual(article);
});
