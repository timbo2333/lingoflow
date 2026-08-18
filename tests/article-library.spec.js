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

async function openMyArticles(page) {
  await page.locator("#myArticlesInputButton:visible, #myArticlesToolbarButton:visible").click();
  await expect(page.locator("#myArticlesModal")).toHaveClass(/show/);
  await expect(page.locator("#myArticlesList")).not.toHaveAttribute("data-state", "loading");
}

function getMyArticleItem(page, title) {
  return page.locator(".myArticleItem").filter({ hasText: title });
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

test("我的文章空状态可以创建新草稿且不会提前落库", async ({ page }) => {
  await openMyArticles(page);

  await expect(page.locator("#myArticlesList")).toHaveAttribute("data-state", "empty");
  await expect(page.locator("#myArticlesList")).toContainText("还没有文章");

  await page.locator("#newDraftFromArticlesButton").click();
  await expect(page.locator("#myArticlesModal")).not.toHaveClass(/show/);
  await expect(page.locator("#inputText")).toBeVisible();
  await expect(page.locator("#inputText")).toHaveValue("");
  expect(await getArticles(page)).toHaveLength(0);
});

test("我的文章只显示未删除文章并按 lastReadAt 排序", async ({ page }) => {
  await page.evaluate(async () => {
    const library = window.LingoFlowArticleLibrary;
    const paste = await library.createArticle({
      title: "Earlier pasted article",
      content: "Earlier pasted article content.",
      sourceType: "paste"
    });
    const txt = await library.createArticle({
      title: "Latest TXT article",
      content: "Latest TXT article content.",
      sourceType: "txt",
      sourceTitle: "latest.txt"
    });
    const deleted = await library.createArticle({
      title: "Deleted article",
      content: "This article must stay hidden.",
      sourceType: "paste"
    });

    await library.updateArticleReading(paste.id, {
      lastReadAt: "2026-08-17T08:00:00.000Z"
    });
    await library.updateArticleReading(txt.id, {
      lastReadAt: "2026-08-18T08:00:00.000Z"
    });
    await library.updateArticle(deleted.id, {
      deletedAt: "2026-08-18T09:00:00.000Z"
    });
  });

  await openMyArticles(page);

  const items = page.locator(".myArticleItem");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0).locator(".myArticleTitle")).toHaveText("Latest TXT article");
  await expect(items.nth(1).locator(".myArticleTitle")).toHaveText("Earlier pasted article");
  await expect(items.nth(0).locator(".myArticleMeta")).toContainText("TXT 导入 · latest.txt");
  await expect(items.nth(0).locator(".myArticleMeta")).toContainText("最近阅读：");
  await expect(items.nth(0).locator(".myArticleMeta")).toContainText("2026");
  await expect(items.nth(1).locator(".myArticleMeta")).toContainText("粘贴文本");
  await expect(page.locator("#myArticlesList")).not.toContainText("Deleted article");
});

test("从我的文章重新打开正文不会创建重复记录", async ({ page }) => {
  await fillDraft(page, "Reopen title\nThis saved article should reopen without duplication.");
  await startReading(page);

  const [created] = await getArticles(page);
  const reading = {
    progress: 0.37,
    paragraphIndex: 2,
    updatedAt: "2026-08-18T01:00:00.000Z",
    lastReadAt: "2026-08-17T01:00:00.000Z"
  };
  await page.evaluate(
    ({ id, changes }) => window.LingoFlowArticleLibrary.updateArticleReading(id, changes),
    { id: created.id, changes: reading }
  );
  const [beforeOpen] = await getArticles(page);

  await page.getByRole("button", { name: /新草稿/ }).click();
  await openMyArticles(page);
  await getMyArticleItem(page, "Reopen title")
    .getByRole("button", { name: "打开文章：Reopen title" })
    .click();

  await expect(page.locator("#readerLayout")).toHaveClass(/show/);
  await expect(page.locator("#article")).toContainText(
    "This saved article should reopen without duplication."
  );

  const articles = await getArticles(page);
  expect(articles).toHaveLength(1);
  expect(articles[0].id).toBe(created.id);
  expect(articles[0].updatedAt).toBe(beforeOpen.updatedAt);
  expect(articles[0].reading).toEqual({
    progress: reading.progress,
    paragraphIndex: reading.paragraphIndex,
    updatedAt: reading.updatedAt
  });
  expect(Date.parse(articles[0].lastReadAt)).toBeGreaterThan(
    Date.parse(beforeOpen.lastReadAt)
  );
});

test("从我的文章创建新草稿会生成新的 article id", async ({ page }) => {
  await fillDraft(page, "First library article\nThe first saved article.");
  await startReading(page);
  const [first] = await getArticles(page);

  await openMyArticles(page);
  await page.locator("#newDraftFromArticlesButton").click();
  await expect(page.locator("#inputText")).toBeVisible();
  await expect(page.locator("#inputText")).toHaveValue("");

  await fillDraft(page, "Second library article\nThe second saved article.");
  await startReading(page);

  const articles = await getArticles(page);
  expect(articles).toHaveLength(2);
  expect(articles.some(article => article.id === first.id)).toBe(true);
  expect(articles.some(article => article.id !== first.id)).toBe(true);
});

test("行内编辑标题保持文章数据并同步当前文章状态", async ({ page }) => {
  await fillDraft(page, "Original title\nOriginal article body.");
  await startReading(page);

  let [article] = await getArticles(page);
  const reading = {
    progress: 0.58,
    paragraphIndex: 4,
    updatedAt: "2026-08-18T02:00:00.000Z"
  };
  await page.evaluate(
    ({ id, changes }) => window.LingoFlowArticleLibrary.updateArticleReading(id, changes),
    { id: article.id, changes: reading }
  );
  [article] = await getArticles(page);
  await page.waitForTimeout(20);

  await openMyArticles(page);
  const item = getMyArticleItem(page, "Original title");
  await item.getByRole("button", { name: "编辑文章标题：Original title" }).click();
  await item.locator(".myArticleTitleInput").fill("Renamed article");
  await item.getByRole("button", { name: "保存" }).click();

  await expect(getMyArticleItem(page, "Renamed article")).toBeVisible();
  let [renamed] = await getArticles(page);
  expect(renamed.id).toBe(article.id);
  expect(renamed.title).toBe("Renamed article");
  expect(renamed.content).toBe(article.content);
  expect(renamed.createdAt).toBe(article.createdAt);
  expect(renamed.reading).toEqual(reading);
  expect(renamed.sourceType).toBe(article.sourceType);
  expect(Date.parse(renamed.updatedAt)).toBeGreaterThan(Date.parse(article.updatedAt));

  await page.getByRole("button", { name: "关闭我的文章" }).click();
  await page.getByRole("button", { name: /重新编辑文章/ }).click();
  await fillDraft(page, "Updated article body without changing the renamed title.");
  await startReading(page);

  [renamed] = await getArticles(page);
  expect(renamed.id).toBe(article.id);
  expect(renamed.title).toBe("Renamed article");
  expect(renamed.content).toBe("Updated article body without changing the renamed title.");
  expect(renamed.reading).toEqual(reading);
});

test("刷新页面后仍可从我的文章重新打开旧文章", async ({ page }) => {
  await fillDraft(page, "Reload library title\nThis article should reopen after reload.");
  await startReading(page);
  const [before] = await getArticles(page);

  await page.reload();
  await expect(page.locator("#inputText")).toBeVisible();
  await openMyArticles(page);
  await getMyArticleItem(page, "Reload library title")
    .getByRole("button", { name: "打开文章：Reload library title" })
    .click();

  await expect(page.locator("#readerLayout")).toHaveClass(/show/);
  await expect(page.locator("#article")).toContainText("This article should reopen after reload.");
  const articles = await getArticles(page);
  expect(articles).toHaveLength(1);
  expect(articles[0].id).toBe(before.id);
});
