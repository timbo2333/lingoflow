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
  await expect(page.locator("#dictionarySetupStatus")).not.toHaveAttribute(
    "data-state",
    "checking"
  );
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

async function getArticles(page) {
  return await page.evaluate(() => (
    window.LingoFlowArticleLibrary.listArticles({ includeDeleted: true })
  ));
}

async function fillDraft(page, text) {
  await page.locator("#inputText").fill(text);
}

async function startReading(page) {
  await page.getByRole("button", { name: "生成可点击文章" }).click();
  await expect(page.locator("#readerLayout")).toHaveClass(/show/);
}

async function uploadTxt(page, filename, content) {
  await page.locator("#fileInput").setInputFiles({
    name: filename,
    mimeType: "text/plain",
    buffer: Buffer.from(content)
  });
  await expect(page.locator(".dropZoneTitle")).toHaveText(`已载入：${filename}`);
}

async function inspectDatabase(page, databaseName) {
  return await page.evaluate(async name => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    const result = {
      name: db.name,
      version: db.version,
      stores: Array.from(db.objectStoreNames).sort()
    };
    db.close();
    return result;
  }, databaseName);
}

test("LingoFlowLibraryDB 使用预期的 version、store 和索引", async ({ page }) => {
  const schema = await page.evaluate(async () => {
    const db = await window.LingoFlowArticleLibrary.openDatabase();
    const tx = db.transaction("articles", "readonly");
    const store = tx.objectStore("articles");

    return {
      name: db.name,
      version: db.version,
      storeName: store.name,
      keyPath: store.keyPath,
      indexes: Array.from(store.indexNames).sort().map(name => {
        const index = store.index(name);
        return {
          name,
          keyPath: index.keyPath,
          unique: index.unique
        };
      })
    };
  });

  expect(schema.name).toBe("LingoFlowLibraryDB");
  expect(schema.version).toBe(1);
  expect(schema.storeName).toBe("articles");
  expect(schema.keyPath).toBe("id");
  expect(schema.indexes).toEqual([
    { name: "byDeletedAt", keyPath: "deletedAt", unique: false },
    { name: "byLastReadAt", keyPath: "lastReadAt", unique: false },
    { name: "bySource", keyPath: ["sourceType", "sourceId"], unique: true }
  ]);
});

test("草稿输入时不落库，点击生成后才创建文章", async ({ page }) => {
  await fillDraft(page, "Draft title\nThis article is still only a draft.");
  expect(await getArticles(page)).toHaveLength(0);

  await startReading(page);

  const articles = await getArticles(page);
  expect(articles).toHaveLength(1);
  expect(articles[0]).toMatchObject({
    title: "Draft title",
    sourceType: "paste",
    content: "Draft title\nThis article is still only a draft."
  });
});

test("相同正文的不同新草稿使用不同 article id", async ({ page }) => {
  const text = "Repeated title\nThe same content may be saved again.";

  await fillDraft(page, text);
  await startReading(page);
  await page.getByRole("button", { name: /新草稿/ }).click();
  await fillDraft(page, text);
  await startReading(page);

  const articles = await getArticles(page);
  expect(articles).toHaveLength(2);
  expect(new Set(articles.map(article => article.id)).size).toBe(2);
  expect(articles.every(article => article.content === text)).toBe(true);
});

test("重新编辑保持 id、createdAt 和 reading，并更新 updatedAt", async ({ page }) => {
  await fillDraft(page, "Editable title\nOriginal article content.");
  await startReading(page);

  const [before] = await getArticles(page);
  const reading = {
    progress: 0.42,
    paragraphIndex: 3,
    updatedAt: "2026-08-18T00:00:00.000Z"
  };
  await page.evaluate(
    ({ id, readingState }) => window.LingoFlowArticleLibrary.updateArticleReading(id, readingState),
    { id: before.id, readingState: reading }
  );

  await page.waitForTimeout(20);
  await page.getByRole("button", { name: /重新编辑文章/ }).click();
  await fillDraft(page, "Editable title\nUpdated article content.");
  await startReading(page);

  const articles = await getArticles(page);
  expect(articles).toHaveLength(1);
  expect(articles[0].id).toBe(before.id);
  expect(articles[0].createdAt).toBe(before.createdAt);
  expect(Date.parse(articles[0].updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt));
  expect(articles[0].reading).toEqual(reading);
});

test("TXT 导入保留来源文件名并用文件名生成标题", async ({ page }) => {
  await uploadTxt(page, "test.txt", "Original TXT article content.");
  expect(await getArticles(page)).toHaveLength(0);

  await startReading(page);

  const [article] = await getArticles(page);
  expect(article.sourceType).toBe("txt");
  expect(article.sourceTitle).toBe("test.txt");
  expect(article.title).toBe("test");
  expect(article).not.toHaveProperty("sourceId");
});

test("TXT 后创建新草稿会清除旧来源", async ({ page }) => {
  await uploadTxt(page, "test.txt", "Original TXT article content.");
  await startReading(page);
  await page.getByRole("button", { name: /新草稿/ }).click();

  await expect(page.locator(".dropZoneTitle")).toHaveText("拖拽 TXT 文件到这里");
  await expect(page.locator(".dropZoneHint")).toHaveText("或点击此区域选择文件");
  await expect(page.locator("#inputText")).toHaveValue("");

  await fillDraft(page, "A clean pasted draft.");
  await startReading(page);

  const articles = await getArticles(page);
  const newArticle = articles.find(article => article.content === "A clean pasted draft.");
  expect(articles).toHaveLength(2);
  expect(newArticle).toMatchObject({ sourceType: "paste" });
  expect(newArticle).not.toHaveProperty("sourceTitle");
});

test("手动修改 TXT 草稿后保存为 paste 且移除 sourceTitle", async ({ page }) => {
  await uploadTxt(page, "test.txt", "Original TXT article content.");
  await fillDraft(page, "Manually replaced article content.");

  await expect(page.locator(".dropZoneTitle")).toHaveText("拖拽 TXT 文件到这里");
  await startReading(page);

  const [article] = await getArticles(page);
  expect(article.sourceType).toBe("paste");
  expect(article).not.toHaveProperty("sourceTitle");
  expect(article.title).toBe("Manually replaced article content.");
});

test("快速重复触发在一次保存过程中只创建一条文章", async ({ page }) => {
  const text = "Rapid trigger title\nOnly one record should be created.";
  await fillDraft(page, text);

  await page.evaluate(() => {
    const original = window.LingoFlowArticleLibrary;
    window.LingoFlowArticleLibrary = Object.freeze({
      ...original,
      createArticle: async input => {
        await new Promise(resolve => setTimeout(resolve, 120));
        return await original.createArticle(input);
      }
    });
  });

  const results = await page.evaluate(() => Promise.all([
    generateArticle(),
    generateArticle(),
    generateArticle()
  ]));

  const articles = await getArticles(page);
  expect(articles).toHaveLength(1);
  expect(articles[0].content).toBe(text);
  expect(new Set(results.map(result => result.id)).size).toBe(1);
});

test("页面刷新后文章仍保存在 IndexedDB", async ({ page }) => {
  await fillDraft(page, "Persistent title\nThis article must survive a reload.");
  await startReading(page);
  const [before] = await getArticles(page);

  await page.reload();
  await expect(page.locator("#inputText")).toBeVisible();

  const articles = await getArticles(page);
  expect(articles).toHaveLength(1);
  expect(articles[0].id).toBe(before.id);
  expect(articles[0].content).toBe(before.content);
});

test("文章操作不会改变 EnglishReaderECDICT schema", async ({ page }) => {
  const before = await inspectDatabase(page, "EnglishReaderECDICT");
  expect(before).toEqual({
    name: "EnglishReaderECDICT",
    version: 2,
    stores: ["entries", "lemmas", "meta"]
  });

  await fillDraft(page, "Dictionary boundary\nArticle data belongs in its own database.");
  await startReading(page);

  const after = await inspectDatabase(page, "EnglishReaderECDICT");
  expect(after).toEqual(before);
});
