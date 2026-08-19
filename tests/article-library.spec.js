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
  await expect.poll(async () => (
    page.evaluate(() => Boolean(calculateArticleReadingSnapshot()))
  )).toBe(true);
}

async function openMyArticles(page) {
  await page.locator("#myArticlesInputButton:visible, #myArticlesToolbarButton:visible").click();
  await expect(page.locator("#myArticlesModal")).toHaveClass(/show/);
  await expect(page.locator("#myArticlesList")).not.toHaveAttribute("data-state", "loading");
}

async function openRecentlyDeleted(page) {
  await page.locator("#myArticlesViewButton").click();
  await expect(page.locator("#myArticlesTitle")).toContainText("最近删除");
  await expect(page.locator("#myArticlesList")).toHaveAttribute("data-view", "deleted");
  await expect(page.locator("#myArticlesList")).not.toHaveAttribute("data-state", "loading");
}

async function selectMyArticlesFilter(page, label, filterKey) {
  const button = page.locator("#myArticlesFilters").getByRole("button", {
    name: label,
    exact: true
  });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#myArticlesList")).toHaveAttribute("data-filter", filterKey);
  await expect(page.locator("#myArticlesList")).not.toHaveAttribute("data-state", "loading");
}

function getMyArticleItem(page, title) {
  return page.locator(".myArticleItem").filter({ hasText: title });
}

function makeLongArticle(title, paragraphCount = 48) {
  const paragraphs = Array.from({ length: paragraphCount }, (_, index) => (
    `Paragraph ${index + 1} contains enough English words to create a stable reading ` +
    `position across several wrapped lines in the article reader. ` +
    `The reader should remember this paragraph after the page is reopened.`
  ));
  return [title, ...paragraphs].join("\n");
}

async function scrollArticleToProgress(page, progress) {
  await page.evaluate(value => {
    const metrics = getArticleReadingMetrics();
    if (!metrics) throw new Error("Article reading metrics are unavailable.");
    window.scrollTo({
      top: metrics.startY + metrics.scrollRange * value,
      behavior: "auto"
    });
  }, progress);
  await page.waitForTimeout(50);
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
  await expect(page.locator("#myArticlesSummary")).toHaveText(
    "共 0 篇 · 未开始 0 · 阅读中 0 · 接近读完 0 · 已读完 0"
  );

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
    .getByRole("button", { name: "继续阅读文章：Reopen title" })
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

test("滚动后自动保存正文范围 progress、paragraphIndex 和 reading.updatedAt", async ({ page }) => {
  const content = makeLongArticle("Automatic reading progress");
  await fillDraft(page, content);
  await startReading(page);

  const [before] = await getArticles(page);
  await scrollArticleToProgress(page, 0.46);

  await expect.poll(async () => {
    const [article] = await getArticles(page);
    return article.reading.updatedAt;
  }, { timeout: 2500 }).not.toBeNull();

  const [after] = await getArticles(page);
  expect(after.reading.progress).toBeGreaterThan(0.35);
  expect(after.reading.progress).toBeLessThan(0.57);
  expect(after.reading.progress).toBeGreaterThanOrEqual(0);
  expect(after.reading.progress).toBeLessThanOrEqual(1);
  expect(after.reading.paragraphIndex).toBeGreaterThan(0);
  expect(after.lastReadAt).toBe(before.lastReadAt);
  expect(after.updatedAt).toBe(before.updatedAt);
  expect(after.title).toBe(before.title);
  expect(after.content).toBe(before.content);

  const paragraphMarkers = await page.locator("#article .word").evaluateAll(words => ({
    total: words.length,
    marked: words.filter(word => word.hasAttribute("data-paragraph-index")).length
  }));
  expect(paragraphMarkers.marked).toBe(paragraphMarkers.total);
});

test("正文外页面高度变化不会改变文章 progress", async ({ page }) => {
  await fillDraft(page, makeLongArticle("Article-only progress"));
  await startReading(page);
  await scrollArticleToProgress(page, 0.41);

  const before = await page.evaluate(() => calculateArticleReadingSnapshot().progress);
  const documentHeightBefore = await page.evaluate(() => document.documentElement.scrollHeight);

  await page.evaluate(() => {
    const extra = document.createElement("div");
    extra.id = "testOutsideArticleHeight";
    extra.style.height = "4000px";
    document.body.appendChild(extra);
  });

  const documentHeightAfter = await page.evaluate(() => document.documentElement.scrollHeight);
  const after = await page.evaluate(() => calculateArticleReadingSnapshot().progress);
  expect(documentHeightAfter).toBeGreaterThan(documentHeightBefore + 3000);
  expect(after).toBeCloseTo(before, 5);
});

test("连续滚动由 700ms trailing debounce 合并为一次进度写入", async ({ page }) => {
  await fillDraft(page, makeLongArticle("Debounced progress"));
  await startReading(page);

  await page.evaluate(() => {
    const original = window.LingoFlowArticleLibrary;
    window.__readingProgressWrites = [];
    window.LingoFlowArticleLibrary = Object.freeze({
      ...original,
      updateArticleReading: async (id, changes) => {
        if (Object.prototype.hasOwnProperty.call(changes, "progress")) {
          window.__readingProgressWrites.push({ id, changes: { ...changes } });
        }
        return await original.updateArticleReading(id, changes);
      }
    });
  });

  await scrollArticleToProgress(page, 0.18);
  await page.waitForTimeout(120);
  await scrollArticleToProgress(page, 0.31);
  await page.waitForTimeout(120);
  await scrollArticleToProgress(page, 0.44);

  await expect.poll(() => page.evaluate(() => window.__readingProgressWrites.length), {
    timeout: 2500
  }).toBe(1);
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.__readingProgressWrites.length)).toBe(1);

  const [article] = await getArticles(page);
  expect(article.reading.progress).toBeGreaterThan(0.35);
});

test("debounce 未结束时重新编辑和新草稿都会强制 flush", async ({ page }) => {
  await fillDraft(page, makeLongArticle("Flush before transitions"));
  await startReading(page);
  const [created] = await getArticles(page);

  await scrollArticleToProgress(page, 0.29);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
  await page.waitForTimeout(100);
  await page.getByRole("button", { name: /重新编辑文章/ }).click();
  await expect(page.locator("#inputText")).toBeVisible();

  await expect.poll(async () => {
    const articles = await getArticles(page);
    return articles.find(article => article.id === created.id).reading.progress;
  }).toBeGreaterThan(0.2);

  await startReading(page);
  await scrollArticleToProgress(page, 0.54);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
  await page.waitForTimeout(100);
  await page.getByRole("button", { name: /新草稿/ }).click();
  await expect(page.locator("#inputText")).toBeVisible();
  await expect(page.locator("#inputText")).toHaveValue("");

  await expect.poll(async () => {
    const articles = await getArticles(page);
    return articles.find(article => article.id === created.id).reading.progress;
  }).toBeGreaterThan(0.45);
});

test("打开我的文章和切换文章前会 flush 当前阅读进度", async ({ page }) => {
  await fillDraft(page, makeLongArticle("Current article to flush"));
  await startReading(page);
  const [current] = await getArticles(page);

  await page.evaluate(async () => {
    await window.LingoFlowArticleLibrary.createArticle({
      title: "Target saved article",
      content: "Target saved article content.",
      sourceType: "paste"
    });
  });

  await scrollArticleToProgress(page, 0.48);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
  await page.waitForTimeout(100);
  await openMyArticles(page);

  await expect(getMyArticleItem(page, "Current article to flush").locator(".myArticleMeta"))
    .toContainText(/阅读中 · [1-9][0-9]?%/);

  await getMyArticleItem(page, "Target saved article")
    .getByRole("button", { name: "打开文章：Target saved article" })
    .click();
  await expect(page.locator("#myArticlesModal")).not.toHaveClass(/show/);
  await expect(page.locator("#article")).toContainText("Target saved article content.");

  const articles = await getArticles(page);
  const flushed = articles.find(article => article.id === current.id);
  expect(flushed.reading.updatedAt).not.toBeNull();
  expect(flushed.reading.progress).toBeGreaterThan(0.4);
});

test("回到顶部超过 debounce 后通过真实 UI 重开仍恢复最远进度", async ({ page }) => {
  await fillDraft(page, makeLongArticle("Keep farthest progress after toolbar navigation", 70));
  await startReading(page);
  const [created] = await getArticles(page);

  await scrollArticleToProgress(page, 0.6);
  await expect.poll(async () => {
    const articles = await getArticles(page);
    return articles.find(article => article.id === created.id).reading.progress;
  }, { timeout: 2500 }).toBeGreaterThan(0.55);

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
  await page.waitForTimeout(850);

  const [afterTop] = await getArticles(page);
  expect(afterTop.reading.progress).toBeGreaterThan(0.55);

  await openMyArticles(page);
  await getMyArticleItem(page, "Keep farthest progress after toolbar navigation")
    .getByRole("button", {
      name: "继续阅读文章：Keep farthest progress after toolbar navigation"
    })
    .click();
  await expect(page.locator("#myArticlesModal")).not.toHaveClass(/show/);

  await expect.poll(() => page.evaluate(() => (
    calculateArticleReadingSnapshot()?.progress || 0
  ))).toBeGreaterThan(0.5);

  const [reopened] = await getArticles(page);
  expect(reopened.reading.progress).toBeGreaterThan(0.55);
});

test("持久化进度只前进，视觉进度仍可随向上回读下降", async ({ page }) => {
  await fillDraft(page, makeLongArticle("Farthest progress and live UI", 70));
  await startReading(page);

  await scrollArticleToProgress(page, 0.6);
  await expect.poll(async () => (await getArticles(page))[0].reading.progress, {
    timeout: 2500
  }).toBeGreaterThan(0.55);

  await scrollArticleToProgress(page, 0.8);
  await expect.poll(async () => (await getArticles(page))[0].reading.progress, {
    timeout: 2500
  }).toBeGreaterThan(0.75);
  const [atEighty] = await getArticles(page);

  await scrollArticleToProgress(page, 0.3);
  await page.waitForTimeout(850);

  const currentView = await page.evaluate(() => ({
    progress: calculateArticleReadingSnapshot().progress,
    progressBarPercent: Number.parseFloat(
      document.getElementById("readingProgress").style.width
    )
  }));
  const [afterReadingBack] = await getArticles(page);

  expect(currentView.progress).toBeGreaterThan(0.25);
  expect(currentView.progress).toBeLessThan(0.35);
  expect(currentView.progressBarPercent).toBeGreaterThan(25);
  expect(currentView.progressBarPercent).toBeLessThan(35);
  expect(afterReadingBack.reading.progress).toBe(atEighty.reading.progress);
  expect(afterReadingBack.reading.paragraphIndex).toBe(atEighty.reading.paragraphIndex);
});

test("刷新后从我的文章打开会恢复保存的 paragraphIndex", async ({ page }) => {
  await fillDraft(page, makeLongArticle("Restore saved paragraph", 60));
  await startReading(page);
  await scrollArticleToProgress(page, 0.52);

  await expect.poll(async () => {
    const [article] = await getArticles(page);
    return article.reading.updatedAt;
  }, { timeout: 2500 }).not.toBeNull();
  const [saved] = await getArticles(page);
  expect(saved.reading.paragraphIndex).toBeGreaterThan(0);

  await page.reload();
  await expect(page.locator("#inputText")).toBeVisible();
  await openMyArticles(page);
  await getMyArticleItem(page, "Restore saved paragraph")
    .getByRole("button", { name: "继续阅读文章：Restore saved paragraph" })
    .click();
  await expect(page.locator("#myArticlesModal")).not.toHaveClass(/show/);
  await expect.poll(() => page.evaluate(() => Boolean(calculateArticleReadingSnapshot())))
    .toBe(true);

  const restored = await page.evaluate(paragraphIndex => {
    const word = document.querySelector(
      `.word[data-paragraph-index="${paragraphIndex}"]`
    );
    return {
      distanceFromAnchor: word
        ? Math.abs(word.getBoundingClientRect().top - getReadingAnchorOffset())
        : null,
      readingUpdatedAt: currentArticle?.reading?.updatedAt || null
    };
  }, saved.reading.paragraphIndex);

  expect(restored.distanceFromAnchor).not.toBeNull();
  expect(restored.distanceFromAnchor).toBeLessThan(50);
  expect(restored.readingUpdatedAt).toBe(saved.reading.updatedAt);

  const [afterOpen] = await getArticles(page);
  expect(afterOpen.reading.updatedAt).toBe(saved.reading.updatedAt);
});

test("paragraphIndex 无效时在不同 viewport 和字体下使用 progress 恢复", async ({ page }) => {
  await fillDraft(page, makeLongArticle("Progress fallback after layout change", 60));
  await startReading(page);
  const [created] = await getArticles(page);

  await page.evaluate(async id => {
    await window.LingoFlowArticleLibrary.updateArticleReading(id, {
      progress: 0.63,
      paragraphIndex: 9999,
      updatedAt: "2026-08-18T04:00:00.000Z"
    });
    const prefs = JSON.parse(
      localStorage.getItem("EnglishReaderV052ReadingPrefs") || "{}"
    );
    localStorage.setItem("EnglishReaderV052ReadingPrefs", JSON.stringify({
      ...prefs,
      fontSize: "26",
      lineHeight: "2.2"
    }));
  }, created.id);

  await page.setViewportSize({ width: 620, height: 760 });
  await page.reload();
  await openMyArticles(page);
  await getMyArticleItem(page, "Progress fallback after layout change")
    .getByRole("button", { name: "继续阅读文章：Progress fallback after layout change" })
    .click();
  await expect.poll(() => page.evaluate(() => Boolean(calculateArticleReadingSnapshot())))
    .toBe(true);

  const restoredProgress = await page.evaluate(() => (
    calculateArticleReadingSnapshot().progress
  ));
  expect(restoredProgress).toBeGreaterThan(0.57);
  expect(restoredProgress).toBeLessThan(0.69);
});

test("我的文章显示统一阅读状态和实际百分比", async ({ page }) => {
  await page.evaluate(async () => {
    const library = window.LingoFlowArticleLibrary;
    await library.createArticle({
      title: "Never started article",
      content: "Never started content.",
      sourceType: "paste"
    });
    const inProgress = await library.createArticle({
      title: "Forty two percent article",
      content: "Forty two percent content.",
      sourceType: "paste"
    });
    const almostFinished = await library.createArticle({
      title: "Eighty eight percent article",
      content: "Eighty eight percent content.",
      sourceType: "paste"
    });
    const nearEnd = await library.createArticle({
      title: "Near end article",
      content: "Near end content.",
      sourceType: "paste"
    });
    await library.updateArticleReading(inProgress.id, {
      progress: 0.42,
      paragraphIndex: 1,
      updatedAt: "2026-08-18T05:00:00.000Z"
    });
    await library.updateArticleReading(almostFinished.id, {
      progress: 0.88,
      paragraphIndex: 2,
      updatedAt: "2026-08-18T05:05:00.000Z"
    });
    await library.updateArticleReading(nearEnd.id, {
      progress: 0.97,
      paragraphIndex: 3,
      updatedAt: "2026-08-18T05:10:00.000Z"
    });
  });

  await openMyArticles(page);
  const notStarted = getMyArticleItem(page, "Never started article");
  const reading = getMyArticleItem(page, "Forty two percent article");
  const nearComplete = getMyArticleItem(page, "Eighty eight percent article");
  const completed = getMyArticleItem(page, "Near end article");

  await expect(notStarted.locator(".myArticleMeta"))
    .toContainText("未开始");
  await expect(reading.locator(".myArticleMeta"))
    .toContainText("阅读中 · 42%");
  await expect(nearComplete.locator(".myArticleMeta"))
    .toContainText("接近读完 · 88%");
  await expect(completed.locator(".myArticleMeta"))
    .toContainText("已读完 · 97%");
  await expect(notStarted).toHaveAttribute("data-reading-status", "not-started");
  await expect(reading).toHaveAttribute("data-reading-status", "reading");
  await expect(nearComplete).toHaveAttribute("data-reading-status", "near-complete");
  await expect(completed).toHaveAttribute("data-reading-status", "completed");
});

test("标题更新与排队中的阅读进度写入会同时保留", async ({ page }) => {
  await fillDraft(page, makeLongArticle("Concurrent title and progress"));
  await startReading(page);
  const [created] = await getArticles(page);
  await scrollArticleToProgress(page, 0.43);

  await page.evaluate(async id => {
    const progressSave = flushReadingProgress();
    const titleSave = window.LingoFlowArticleLibrary.updateArticle(id, {
      title: "Title preserved with progress"
    });
    await Promise.all([progressSave, titleSave]);
  }, created.id);

  const [updated] = await getArticles(page);
  expect(updated.id).toBe(created.id);
  expect(updated.title).toBe("Title preserved with progress");
  expect(updated.content).toBe(created.content);
  expect(updated.reading.updatedAt).not.toBeNull();
  expect(updated.reading.progress).toBeGreaterThan(0.35);
});

test("visibilitychange hidden 和 pagehide 会 best-effort flush", async ({ page }) => {
  await fillDraft(page, makeLongArticle("Lifecycle flush"));
  await startReading(page);
  const [created] = await getArticles(page);

  await scrollArticleToProgress(page, 0.27);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden"
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await expect.poll(async () => {
    const articles = await getArticles(page);
    return articles[0]?.reading?.progress || 0;
  }).toBeGreaterThan(0.2);

  const [afterVisibility] = await getArticles(page);
  await scrollArticleToProgress(page, 0.56);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));

  await expect.poll(async () => {
    const [article] = await getArticles(page);
    return article.reading.progress;
  }).toBeGreaterThan(afterVisibility.reading.progress + 0.15);

  const [afterPageHide] = await getArticles(page);
  expect(afterPageHide.id).toBe(created.id);
  expect(afterPageHide.reading.progress).toBeLessThanOrEqual(1);
});

test("软删除写入 deletedAt 并保留完整文章数据", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const library = window.LingoFlowArticleLibrary;
    const created = await library.createArticle({
      title: "Soft delete data",
      content: "The complete article data must survive a soft deletion.",
      sourceType: "txt",
      sourceTitle: "soft-delete.txt",
      sourceAttribution: "Local test file"
    });
    const withReading = await library.updateArticleReading(created.id, {
      progress: 0.64,
      paragraphIndex: 5,
      updatedAt: "2026-08-18T02:00:00.000Z",
      lastReadAt: "2026-08-18T03:00:00.000Z"
    });
    const deleted = await library.updateArticle(created.id, {
      deletedAt: "2026-08-18T04:00:00.000Z"
    });

    return {
      before: withReading,
      deleted,
      active: await library.listArticles(),
      trash: await library.listArticles({ deletedOnly: true })
    };
  });

  expect(Number.isNaN(Date.parse(result.deleted.deletedAt))).toBe(false);
  expect(result.active).toHaveLength(0);
  expect(result.trash).toHaveLength(1);
  expect(result.deleted).toMatchObject({
    id: result.before.id,
    title: result.before.title,
    content: result.before.content,
    sourceType: result.before.sourceType,
    sourceTitle: result.before.sourceTitle,
    sourceAttribution: result.before.sourceAttribution,
    createdAt: result.before.createdAt,
    lastReadAt: result.before.lastReadAt,
    reading: result.before.reading
  });
});

test("最近删除使用 deletedAt 倒序且只返回已删除文章", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const library = window.LingoFlowArticleLibrary;
    const active = await library.createArticle({
      title: "Still active",
      content: "This article remains active.",
      sourceType: "paste"
    });
    const older = await library.createArticle({
      title: "Older deleted",
      content: "Older deleted content.",
      sourceType: "paste"
    });
    const newer = await library.createArticle({
      title: "Newer deleted",
      content: "Newer deleted content.",
      sourceType: "paste"
    });
    await library.updateArticle(older.id, {
      deletedAt: "2026-08-17T08:00:00.000Z"
    });
    await library.updateArticle(newer.id, {
      deletedAt: "2026-08-18T08:00:00.000Z"
    });
    return {
      activeId: active.id,
      trash: await library.listArticles({ deletedOnly: true })
    };
  });

  expect(result.trash.map(article => article.title)).toEqual([
    "Newer deleted",
    "Older deleted"
  ]);
  expect(result.trash.every(article => article.deletedAt)).toBe(true);
  expect(result.trash.some(article => article.id === result.activeId)).toBe(false);
});

test("普通 UI 删除无需确认并在操作期间禁用，最近删除只提供恢复", async ({ page }) => {
  await fillDraft(page, "Current article\nThis article stays open while another is deleted.");
  await startReading(page);
  await page.evaluate(async () => {
    await window.LingoFlowArticleLibrary.createArticle({
      title: "Delete through UI",
      content: "This article will be deleted through the real UI.",
      sourceType: "paste"
    });
  });
  await openMyArticles(page);

  await page.evaluate(() => {
    const original = window.LingoFlowArticleLibrary;
    window.LingoFlowArticleLibrary = Object.freeze({
      ...original,
      updateArticle: async (id, changes) => {
        if (changes.deletedAt) {
          await new Promise(resolve => setTimeout(resolve, 120));
        }
        return await original.updateArticle(id, changes);
      }
    });
  });

  let dialogCount = 0;
  page.on("dialog", async dialog => {
    dialogCount += 1;
    await dialog.dismiss();
  });

  const item = getMyArticleItem(page, "Delete through UI");
  const deleteButton = item.getByRole("button", { name: "删除文章：Delete through UI" });
  await deleteButton.click();
  await expect(item).toHaveClass(/busy/);
  await expect(deleteButton).toBeDisabled();
  await expect(getMyArticleItem(page, "Delete through UI")).toHaveCount(0);
  expect(dialogCount).toBe(0);

  await openRecentlyDeleted(page);
  const deletedItem = getMyArticleItem(page, "Delete through UI");
  await expect(deletedItem).toBeVisible();
  await expect(deletedItem.locator(".myArticleMeta")).toContainText("删除于：");
  await expect(deletedItem.locator(".myArticleMeta")).toContainText(/\d{4}/);
  await expect(deletedItem.getByRole("button")).toHaveCount(1);
  await expect(deletedItem.getByRole("button", {
    name: "恢复文章：Delete through UI"
  })).toBeVisible();
});

test("删除当前阅读文章前 flush 进度并清理 active、current 和 session", async ({ page }) => {
  await fillDraft(page, makeLongArticle("Delete active reading article", 70));
  await startReading(page);
  const [created] = await getArticles(page);
  await scrollArticleToProgress(page, 0.47);
  await openMyArticles(page);

  await getMyArticleItem(page, "Delete active reading article")
    .getByRole("button", { name: "删除文章：Delete active reading article" })
    .click();
  await expect(getMyArticleItem(page, "Delete active reading article")).toHaveCount(0);

  const state = await page.evaluate(async id => ({
    article: await window.LingoFlowArticleLibrary.getArticle(id),
    activeArticleId,
    currentArticle,
    currentArticleText,
    articleDraftMode,
    readingProgressSession,
    inputValue: document.getElementById("inputText").value,
    inputVisible: document.getElementById("inputPanel").style.display !== "none",
    readerVisible: document.getElementById("readerLayout").classList.contains("show")
  }), created.id);

  expect(state.article.deletedAt).not.toBeNull();
  expect(state.article.reading.progress).toBeGreaterThan(0.4);
  expect(state.article.reading.updatedAt).not.toBeNull();
  expect(state.activeArticleId).toBeNull();
  expect(state.currentArticle).toBeNull();
  expect(state.currentArticleText).toBe("");
  expect(state.articleDraftMode).toBe("new");
  expect(state.readingProgressSession).toBeNull();
  expect(state.inputValue).toBe("");
  expect(state.inputVisible).toBe(true);
  expect(state.readerVisible).toBe(false);
});

test("删除非当前文章不影响正在阅读的文章", async ({ page }) => {
  await fillDraft(page, makeLongArticle("Article still being read"));
  await startReading(page);
  const [active] = await getArticles(page);
  const otherId = await page.evaluate(async () => {
    const other = await window.LingoFlowArticleLibrary.createArticle({
      title: "Other article to delete",
      content: "Deleting this must not disturb the current article.",
      sourceType: "paste"
    });
    return other.id;
  });

  await openMyArticles(page);
  await getMyArticleItem(page, "Other article to delete")
    .getByRole("button", { name: "删除文章：Other article to delete" })
    .click();

  const state = await page.evaluate(() => ({
    activeArticleId,
    currentArticleId: currentArticle?.id || null,
    sessionArticleId: readingProgressSession?.articleId || null,
    currentArticleText,
    readerVisible: document.getElementById("readerLayout").classList.contains("show")
  }));
  const deleted = await page.evaluate(id => (
    window.LingoFlowArticleLibrary.getArticle(id)
  ), otherId);

  expect(deleted.deletedAt).not.toBeNull();
  expect(state.activeArticleId).toBe(active.id);
  expect(state.currentArticleId).toBe(active.id);
  expect(state.sessionArticleId).toBe(active.id);
  expect(state.currentArticleText).toBe(active.content);
  expect(state.readerVisible).toBe(true);
});

test("删除有未保存正文修改的当前文章会触发草稿保护", async ({ page }) => {
  await fillDraft(page, "Protected article\nThe saved article body.");
  await startReading(page);
  const [created] = await getArticles(page);
  await page.getByRole("button", { name: /重新编辑文章/ }).click();
  await page.locator("#inputText").fill("Protected article\nUnsaved article body.");
  await openMyArticles(page);

  let dialogMessage = "";
  page.once("dialog", async dialog => {
    dialogMessage = dialog.message();
    await dialog.dismiss();
  });
  await getMyArticleItem(page, "Protected article")
    .getByRole("button", { name: "删除文章：Protected article" })
    .click();

  const article = await page.evaluate(id => (
    window.LingoFlowArticleLibrary.getArticle(id)
  ), created.id);
  expect(dialogMessage).toContain("当前草稿还没有保存");
  expect(article.deletedAt).toBeNull();
  await expect(page.locator("#inputText")).toHaveValue(
    "Protected article\nUnsaved article body."
  );
  await expect(getMyArticleItem(page, "Protected article")).toBeVisible();
});

test("恢复保留文章身份和进度、更新 updatedAt，并在刷新后保持", async ({ page }) => {
  const original = await page.evaluate(async () => {
    const library = window.LingoFlowArticleLibrary;
    const created = await library.createArticle({
      title: "Restore complete article",
      content: "Restoring must preserve this complete article.",
      sourceType: "txt",
      sourceTitle: "restore.txt",
      sourceAttribution: "Restore test"
    });
    await library.updateArticleReading(created.id, {
      progress: 0.71,
      paragraphIndex: 6,
      updatedAt: "2026-08-18T05:00:00.000Z",
      lastReadAt: "2026-08-18T06:00:00.000Z"
    });
    return await library.updateArticle(created.id, {
      deletedAt: "2026-08-18T07:00:00.000Z"
    });
  });

  await page.reload();
  await openMyArticles(page);
  await expect(getMyArticleItem(page, "Restore complete article")).toHaveCount(0);
  await openRecentlyDeleted(page);
  await expect(getMyArticleItem(page, "Restore complete article")).toBeVisible();
  await page.waitForTimeout(20);
  await getMyArticleItem(page, "Restore complete article")
    .getByRole("button", { name: "恢复文章：Restore complete article" })
    .click();
  await expect(getMyArticleItem(page, "Restore complete article")).toHaveCount(0);

  const restored = await page.evaluate(id => (
    window.LingoFlowArticleLibrary.getArticle(id)
  ), original.id);
  expect(restored).toMatchObject({
    id: original.id,
    title: original.title,
    content: original.content,
    sourceType: original.sourceType,
    sourceTitle: original.sourceTitle,
    sourceAttribution: original.sourceAttribution,
    createdAt: original.createdAt,
    lastReadAt: original.lastReadAt,
    reading: original.reading,
    deletedAt: null
  });
  expect(Date.parse(restored.updatedAt)).toBeGreaterThan(Date.parse(original.updatedAt));

  await page.reload();
  await openMyArticles(page);
  await expect(getMyArticleItem(page, "Restore complete article")).toBeVisible();
  await openRecentlyDeleted(page);
  await expect(getMyArticleItem(page, "Restore complete article")).toHaveCount(0);
});

test("标题编辑与软删除并发时两项局部更新都保留", async ({ page }) => {
  const article = await page.evaluate(async () => {
    const library = window.LingoFlowArticleLibrary;
    const created = await library.createArticle({
      title: "Concurrent original title",
      content: "Concurrent updates must preserve article data.",
      sourceType: "paste"
    });
    await Promise.all([
      library.updateArticle(created.id, { title: "Concurrent renamed title" }),
      library.updateArticle(created.id, {
        deletedAt: "2026-08-18T08:00:00.000Z"
      })
    ]);
    return await library.getArticle(created.id);
  });

  expect(article.title).toBe("Concurrent renamed title");
  expect(article.deletedAt).toBe("2026-08-18T08:00:00.000Z");
  expect(article.content).toBe("Concurrent updates must preserve article data.");
  expect((await getArticles(page))).toHaveLength(1);
});

test("阅读状态公共函数统一处理阈值、clamp 和旧数据", async ({ page }) => {
  const statuses = await page.evaluate(() => {
    const read = reading => getArticleReadingStatus({ reading });
    return {
      negative: read({ progress: -0.5, updatedAt: null }),
      notStarted: read({ progress: 0, updatedAt: null }),
      zeroStarted: read({ progress: 0, updatedAt: "2026-08-18T09:00:00.000Z" }),
      legacyStarted: read({ progress: 0.42, updatedAt: null }),
      beforeNear: read({ progress: 0.7999, updatedAt: "2026-08-18T09:00:00.000Z" }),
      nearBoundary: read({ progress: 0.80, updatedAt: "2026-08-18T09:00:00.000Z" }),
      completeBoundary: read({ progress: 0.95, updatedAt: "2026-08-18T09:00:00.000Z" }),
      aboveOne: read({ progress: 1.5, updatedAt: "2026-08-18T09:00:00.000Z" })
    };
  });

  expect(statuses.negative).toMatchObject({
    key: "not-started", progress: 0, percent: 0
  });
  expect(statuses.notStarted.key).toBe("not-started");
  expect(statuses.zeroStarted.key).toBe("reading");
  expect(statuses.legacyStarted.key).toBe("reading");
  expect(statuses.beforeNear.key).toBe("reading");
  expect(statuses.nearBoundary.key).toBe("near-complete");
  expect(statuses.completeBoundary.key).toBe("completed");
  expect(statuses.aboveOne).toMatchObject({
    key: "completed", progress: 1, percent: 100
  });
});

test("阅读统计与列表状态一致且纯展示不会修改文章数据", async ({ page }) => {
  const before = await page.evaluate(async () => {
    const library = window.LingoFlowArticleLibrary;
    const notStarted = await library.createArticle({
      title: "Summary not started",
      content: "Summary not started content.",
      sourceType: "paste"
    });
    const reading = await library.createArticle({
      title: "Summary reading",
      content: "Summary reading content.",
      sourceType: "paste"
    });
    const nearComplete = await library.createArticle({
      title: "Summary near complete",
      content: "Summary near complete content.",
      sourceType: "paste"
    });
    const completed = await library.createArticle({
      title: "Summary completed",
      content: "Summary completed content.",
      sourceType: "paste"
    });
    const deleted = await library.createArticle({
      title: "Deleted summary article",
      content: "Deleted articles must not be counted.",
      sourceType: "paste"
    });

    await library.updateArticleReading(reading.id, {
      progress: 0.42,
      paragraphIndex: 1,
      updatedAt: "2026-08-18T09:10:00.000Z"
    });
    await library.updateArticleReading(nearComplete.id, {
      progress: 0.88,
      paragraphIndex: 2,
      updatedAt: "2026-08-18T09:20:00.000Z"
    });
    await library.updateArticleReading(completed.id, {
      progress: 0.97,
      paragraphIndex: 3,
      updatedAt: "2026-08-18T09:30:00.000Z"
    });
    await library.updateArticleReading(deleted.id, {
      progress: 1,
      paragraphIndex: 4,
      updatedAt: "2026-08-18T09:40:00.000Z"
    });
    await library.updateArticle(deleted.id, {
      deletedAt: "2026-08-18T09:50:00.000Z"
    });

    const articles = await library.listArticles({ includeDeleted: true });
    return Object.fromEntries(articles.map(article => [article.id, {
      lastReadAt: article.lastReadAt,
      updatedAt: article.updatedAt,
      readingUpdatedAt: article.reading.updatedAt
    }]));
  });

  await openMyArticles(page);
  await expect(page.locator("#myArticlesSummary")).toHaveText(
    "共 4 篇 · 未开始 1 · 阅读中 1 · 接近读完 1 · 已读完 1"
  );

  const summary = await page.evaluate(async () => {
    const articles = await window.LingoFlowArticleLibrary.listArticles({
      includeDeleted: true
    });
    return calculateArticleReadingSummary(articles);
  });
  expect(summary).toEqual({
    total: 4,
    counts: {
      "not-started": 1,
      reading: 1,
      "near-complete": 1,
      completed: 1
    }
  });

  const after = await page.evaluate(async () => {
    const articles = await window.LingoFlowArticleLibrary.listArticles({
      includeDeleted: true
    });
    return Object.fromEntries(articles.map(article => [article.id, {
      lastReadAt: article.lastReadAt,
      updatedAt: article.updatedAt,
      readingUpdatedAt: article.reading.updatedAt
    }]));
  });
  expect(after).toEqual(before);
});

test("删除和恢复会即时更新统计，最近删除不显示摘要", async ({ page }) => {
  await page.evaluate(async () => {
    const library = window.LingoFlowArticleLibrary;
    await library.createArticle({
      title: "Statistics remaining article",
      content: "This article remains active.",
      sourceType: "paste"
    });
    const completed = await library.createArticle({
      title: "Statistics completed article",
      content: "This completed article will be restored.",
      sourceType: "paste"
    });
    await library.updateArticleReading(completed.id, {
      progress: 0.96,
      paragraphIndex: 2,
      updatedAt: "2026-08-18T10:00:00.000Z"
    });
  });

  await openMyArticles(page);
  const summary = page.locator("#myArticlesSummary");
  await expect(summary).toHaveText(
    "共 2 篇 · 未开始 1 · 阅读中 0 · 接近读完 0 · 已读完 1"
  );

  await getMyArticleItem(page, "Statistics completed article")
    .getByRole("button", { name: "删除文章：Statistics completed article" })
    .click();
  await expect(summary).toHaveText(
    "共 1 篇 · 未开始 1 · 阅读中 0 · 接近读完 0 · 已读完 0"
  );

  await openRecentlyDeleted(page);
  await expect(summary).toBeHidden();
  await getMyArticleItem(page, "Statistics completed article")
    .getByRole("button", { name: "恢复文章：Statistics completed article" })
    .click();
  await page.locator("#myArticlesViewButton").click();
  await expect(page.locator("#myArticlesList")).toHaveAttribute("data-view", "active");
  await expect(summary).toHaveText(
    "共 2 篇 · 未开始 1 · 阅读中 0 · 接近读完 0 · 已读完 1"
  );
});

test("向上回读不降低用于状态和统计的最远阅读进度", async ({ page }) => {
  await fillDraft(page, makeLongArticle("Reading status uses farthest progress", 70));
  await startReading(page);

  await scrollArticleToProgress(page, 0.83);
  await expect.poll(async () => {
    const [article] = await getArticles(page);
    return article.reading.progress;
  }).toBeGreaterThanOrEqual(0.80);
  const [atFarthest] = await getArticles(page);
  expect(atFarthest.reading.progress).toBeLessThan(0.95);

  await scrollArticleToProgress(page, 0.30);
  await page.waitForTimeout(850);
  const [afterReviewing] = await getArticles(page);
  expect(afterReviewing.reading.progress).toBeCloseTo(atFarthest.reading.progress, 5);

  await openMyArticles(page);
  await expect(getMyArticleItem(page, "Reading status uses farthest progress")
    .locator(".myArticleMeta")).toContainText("接近读完 · 83%");
  await expect(page.locator("#myArticlesSummary")).toHaveText(
    "共 1 篇 · 未开始 0 · 阅读中 0 · 接近读完 1 · 已读完 0"
  );
});

test("一屏短文章不会仅因正文完整可见而自动成为已读完", async ({ page }) => {
  await fillDraft(page, "Short article\nThis complete article fits inside one viewport.");
  await startReading(page);
  await page.waitForTimeout(850);

  const [stored] = await getArticles(page);
  expect(stored.reading).toEqual({
    progress: 0,
    paragraphIndex: 0,
    updatedAt: null
  });

  await openMyArticles(page);
  const item = getMyArticleItem(page, "Short article");
  await expect(item).toHaveAttribute("data-reading-status", "not-started");
  await expect(item.locator(".myArticleMeta")).toContainText("未开始");
  await expect(page.locator("#myArticlesSummary")).toHaveText(
    "共 1 篇 · 未开始 1 · 阅读中 0 · 接近读完 0 · 已读完 0"
  );
});

test("五种状态筛选复用统一状态并保持全局统计和按钮文案", async ({ page }) => {
  await page.evaluate(async () => {
    const library = window.LingoFlowArticleLibrary;
    await library.createArticle({
      title: "Filter not started",
      content: "Not started filter content.",
      sourceType: "paste"
    });
    const legacyReading = await library.createArticle({
      title: "Filter legacy reading",
      content: "Legacy reading filter content.",
      sourceType: "paste"
    });
    const nearBoundary = await library.createArticle({
      title: "Filter near boundary",
      content: "Near complete boundary content.",
      sourceType: "paste"
    });
    const completeBoundary = await library.createArticle({
      title: "Filter complete boundary",
      content: "Completed boundary content.",
      sourceType: "paste"
    });
    const deletedReading = await library.createArticle({
      title: "Filter deleted reading",
      content: "Deleted reading content.",
      sourceType: "paste"
    });

    await library.updateArticleReading(legacyReading.id, {
      progress: 0.42,
      paragraphIndex: 1,
      updatedAt: null,
      lastReadAt: "2026-08-18T08:00:00.000Z"
    });
    await library.updateArticleReading(nearBoundary.id, {
      progress: 0.80,
      paragraphIndex: 2,
      updatedAt: "2026-08-18T08:10:00.000Z",
      lastReadAt: "2026-08-18T08:10:00.000Z"
    });
    await library.updateArticleReading(completeBoundary.id, {
      progress: 0.95,
      paragraphIndex: 3,
      updatedAt: "2026-08-18T08:20:00.000Z",
      lastReadAt: "2026-08-18T08:20:00.000Z"
    });
    await library.updateArticleReading(deletedReading.id, {
      progress: 0.60,
      paragraphIndex: 4,
      updatedAt: "2026-08-18T08:30:00.000Z",
      lastReadAt: "2026-08-18T08:30:00.000Z"
    });
    await library.updateArticle(deletedReading.id, {
      deletedAt: "2026-08-18T09:00:00.000Z"
    });
  });

  await openMyArticles(page);
  const summary = page.locator("#myArticlesSummary");
  const list = page.locator("#myArticlesList");
  const expectedSummary =
    "共 4 篇 · 未开始 1 · 阅读中 1 · 接近读完 1 · 已读完 1";
  await expect(summary).toHaveText(expectedSummary);

  await expect(getMyArticleItem(page, "Filter not started")
    .getByRole("button", { name: "打开文章：Filter not started" })).toBeVisible();
  await expect(getMyArticleItem(page, "Filter legacy reading")
    .getByRole("button", { name: "继续阅读文章：Filter legacy reading" })).toBeVisible();
  await expect(getMyArticleItem(page, "Filter near boundary")
    .getByRole("button", { name: "继续阅读文章：Filter near boundary" })).toBeVisible();
  await expect(getMyArticleItem(page, "Filter complete boundary")
    .getByRole("button", { name: "打开文章：Filter complete boundary" })).toBeVisible();

  const cases = [
    ["未开始", "not-started", "Filter not started"],
    ["阅读中", "reading", "Filter legacy reading"],
    ["接近读完", "near-complete", "Filter near boundary"],
    ["已读完", "completed", "Filter complete boundary"]
  ];
  for (const [label, key, title] of cases) {
    await selectMyArticlesFilter(page, label, key);
    await expect(page.locator(".myArticleItem")).toHaveCount(1);
    await expect(getMyArticleItem(page, title)).toHaveAttribute("data-reading-status", key);
    await expect(summary).toHaveText(expectedSummary);
  }

  await selectMyArticlesFilter(page, "全部", "all");
  await expect(page.locator(".myArticleItem")).toHaveCount(4);
  await expect(list).not.toContainText("Filter deleted reading");
});

test("筛选无结果显示专用空状态且重新打开默认恢复全部", async ({ page }) => {
  await page.evaluate(async () => {
    await window.LingoFlowArticleLibrary.createArticle({
      title: "Only unstarted filter article",
      content: "Only an unstarted article exists.",
      sourceType: "paste"
    });
  });

  await openMyArticles(page);
  await expect(page.locator("#myArticlesContinue")).toBeHidden();
  await selectMyArticlesFilter(page, "已读完", "completed");
  await expect(page.locator("#myArticlesList")).toContainText(
    "没有符合当前状态的文章"
  );
  await expect(page.locator("#myArticlesSummary")).toHaveText(
    "共 1 篇 · 未开始 1 · 阅读中 0 · 接近读完 0 · 已读完 0"
  );

  await page.getByRole("button", { name: "关闭我的文章" }).click();
  await openMyArticles(page);
  await expect(page.locator("#myArticlesFilters")
    .getByRole("button", { name: "全部", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(getMyArticleItem(page, "Only unstarted filter article")).toBeVisible();
});

test("继续阅读候选选择最近的未完成已开始文章并排除其他状态", async ({ page }) => {
  const ids = await page.evaluate(async () => {
    const library = window.LingoFlowArticleLibrary;
    const notStarted = await library.createArticle({
      title: "Candidate not started newest",
      content: "This article has not started.",
      sourceType: "paste"
    });
    const reading = await library.createArticle({
      title: "Candidate reading older",
      content: "This is an older reading candidate.",
      sourceType: "paste"
    });
    const nearComplete = await library.createArticle({
      title: "Candidate near complete latest",
      content: "This is the latest valid candidate.",
      sourceType: "paste"
    });
    const completed = await library.createArticle({
      title: "Candidate completed newest",
      content: "Completed articles are excluded.",
      sourceType: "paste"
    });
    const deleted = await library.createArticle({
      title: "Candidate deleted newest",
      content: "Deleted articles are excluded.",
      sourceType: "paste"
    });

    await library.updateArticleReading(reading.id, {
      progress: 0.41,
      paragraphIndex: 1,
      updatedAt: "2026-08-18T09:00:00.000Z",
      lastReadAt: "2026-08-18T09:00:00.000Z"
    });
    await library.updateArticleReading(nearComplete.id, {
      progress: 0.84,
      paragraphIndex: 2,
      updatedAt: "2026-08-18T10:00:00.000Z",
      lastReadAt: "2026-08-18T10:00:00.000Z"
    });
    await library.updateArticleReading(completed.id, {
      progress: 0.98,
      paragraphIndex: 3,
      updatedAt: "2026-08-20T10:00:00.000Z",
      lastReadAt: "2026-08-20T10:00:00.000Z"
    });
    await library.updateArticleReading(deleted.id, {
      progress: 0.55,
      paragraphIndex: 4,
      updatedAt: "2026-08-21T10:00:00.000Z",
      lastReadAt: "2026-08-21T10:00:00.000Z"
    });
    await library.updateArticle(deleted.id, {
      deletedAt: "2026-08-21T11:00:00.000Z"
    });
    return {
      notStarted: notStarted.id,
      reading: reading.id,
      nearComplete: nearComplete.id,
      completed: completed.id,
      deleted: deleted.id
    };
  });

  await openMyArticles(page);
  const continueButton = page.locator("#myArticlesContinueButton");
  await expect(page.locator("#myArticlesContinue")).toBeVisible();
  await expect(continueButton).toHaveAttribute("data-article-id", ids.nearComplete);
  await expect(page.locator("#myArticlesContinueTitle"))
    .toHaveText("Candidate near complete latest");
  await expect(page.locator("#myArticlesContinueProgress")).toHaveText("· 84%");

  const candidateId = await page.evaluate(async () => {
    const articles = await window.LingoFlowArticleLibrary.listArticles({
      includeDeleted: true
    });
    return getContinueReadingArticle(articles)?.id || null;
  });
  expect(candidateId).toBe(ids.nearComplete);
});

test("继续阅读入口复用真实打开链路并 flush、恢复位置和更新 lastReadAt", async ({ page }) => {
  await fillDraft(page, makeLongArticle("Continue reading real path", 70));
  await startReading(page);
  const [created] = await getArticles(page);
  await scrollArticleToProgress(page, 0.58);

  await openMyArticles(page);
  const [beforeContinue] = await getArticles(page);
  expect(beforeContinue.id).toBe(created.id);
  expect(beforeContinue.reading.progress).toBeGreaterThan(0.50);
  await expect(page.locator("#myArticlesContinueButton"))
    .toHaveAttribute("data-article-id", created.id);

  await page.waitForTimeout(20);
  await page.locator("#myArticlesContinueButton").click();
  await expect(page.locator("#myArticlesModal")).not.toHaveClass(/show/);
  await expect(page.locator("#readerLayout")).toHaveClass(/show/);
  await expect.poll(() => page.evaluate(() => (
    calculateArticleReadingSnapshot()?.progress || 0
  ))).toBeGreaterThan(0.50);

  const [afterContinue] = await getArticles(page);
  expect(afterContinue.id).toBe(created.id);
  expect(afterContinue.reading).toEqual(beforeContinue.reading);
  expect(Date.parse(afterContinue.lastReadAt)).toBeGreaterThan(
    Date.parse(beforeContinue.lastReadAt)
  );
});

test("继续阅读入口保留未保存草稿保护", async ({ page }) => {
  const candidate = await page.evaluate(async () => {
    const library = window.LingoFlowArticleLibrary;
    const created = await library.createArticle({
      title: "Protected continue candidate",
      content: "Opening this article must protect the current draft.",
      sourceType: "paste"
    });
    return await library.updateArticleReading(created.id, {
      progress: 0.40,
      paragraphIndex: 1,
      updatedAt: "2026-08-18T11:00:00.000Z",
      lastReadAt: "2026-08-18T11:00:00.000Z"
    });
  });
  const draft = "Unsaved draft that must remain on the page.";
  await fillDraft(page, draft);
  await openMyArticles(page);

  page.once("dialog", dialog => dialog.dismiss());
  await page.locator("#myArticlesContinueButton").click();
  await expect(page.locator("#myArticlesModal")).toHaveClass(/show/);
  await expect(page.locator("#inputText")).toHaveValue(draft);
  await expect(page.locator("#myArticlesContinueButton")).toBeEnabled();

  const stored = await page.evaluate(id => (
    window.LingoFlowArticleLibrary.getArticle(id)
  ), candidate.id);
  expect(stored.lastReadAt).toBe(candidate.lastReadAt);
});

test("删除恢复会重算继续阅读且最近删除隐藏控件并保留筛选", async ({ page }) => {
  const ids = await page.evaluate(async () => {
    const library = window.LingoFlowArticleLibrary;
    const latest = await library.createArticle({
      title: "Latest continue candidate",
      content: "The latest candidate can be deleted and restored.",
      sourceType: "paste"
    });
    const fallback = await library.createArticle({
      title: "Fallback continue candidate",
      content: "This candidate should become the fallback.",
      sourceType: "paste"
    });
    await library.updateArticleReading(latest.id, {
      progress: 0.45,
      paragraphIndex: 1,
      updatedAt: "2026-08-18T12:00:00.000Z",
      lastReadAt: "2026-08-18T12:00:00.000Z"
    });
    await library.updateArticleReading(fallback.id, {
      progress: 0.35,
      paragraphIndex: 1,
      updatedAt: "2026-08-18T11:00:00.000Z",
      lastReadAt: "2026-08-18T11:00:00.000Z"
    });
    return { latest: latest.id, fallback: fallback.id };
  });

  await openMyArticles(page);
  await selectMyArticlesFilter(page, "阅读中", "reading");
  const continueButton = page.locator("#myArticlesContinueButton");
  await expect(continueButton).toHaveAttribute("data-article-id", ids.latest);

  await getMyArticleItem(page, "Latest continue candidate")
    .getByRole("button", { name: "删除文章：Latest continue candidate" })
    .click();
  await expect(continueButton).toHaveAttribute("data-article-id", ids.fallback);
  await expect(continueButton).toContainText("Fallback continue candidate");

  await openRecentlyDeleted(page);
  await expect(page.locator("#myArticlesSummary")).toBeHidden();
  await expect(page.locator("#myArticlesFilters")).toBeHidden();
  await expect(page.locator("#myArticlesContinue")).toBeHidden();
  await getMyArticleItem(page, "Latest continue candidate")
    .getByRole("button", { name: "恢复文章：Latest continue candidate" })
    .click();

  await page.locator("#myArticlesViewButton").click();
  await expect(page.locator("#myArticlesList")).toHaveAttribute("data-view", "active");
  await expect(page.locator("#myArticlesList")).toHaveAttribute("data-filter", "reading");
  await expect(page.locator("#myArticlesFilters")
    .getByRole("button", { name: "阅读中", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await expect(continueButton).toHaveAttribute("data-article-id", ids.latest);
});

test("快速切换筛选和最近删除时旧异步结果不会覆盖当前视图", async ({ page }) => {
  await page.evaluate(async () => {
    const library = window.LingoFlowArticleLibrary;
    const reading = await library.createArticle({
      title: "Async reading article",
      content: "Reading result may arrive late.",
      sourceType: "paste"
    });
    const completed = await library.createArticle({
      title: "Async completed article",
      content: "Completed result should remain current.",
      sourceType: "paste"
    });
    const deleted = await library.createArticle({
      title: "Async deleted article",
      content: "Deleted view should remain current.",
      sourceType: "paste"
    });
    await library.updateArticleReading(reading.id, {
      progress: 0.40,
      updatedAt: "2026-08-18T13:00:00.000Z"
    });
    await library.updateArticleReading(completed.id, {
      progress: 0.96,
      updatedAt: "2026-08-18T13:10:00.000Z"
    });
    await library.updateArticle(deleted.id, {
      deletedAt: "2026-08-18T13:20:00.000Z"
    });
  });
  await openMyArticles(page);

  await page.evaluate(() => {
    const original = window.LingoFlowArticleLibrary;
    window.LingoFlowArticleLibrary = Object.freeze({
      ...original,
      listArticles: async options => {
        const filterAtRequest = myArticlesFilter;
        if (!options?.deletedOnly && filterAtRequest === "reading") {
          await new Promise(resolve => setTimeout(resolve, 180));
        }
        return await original.listArticles(options);
      }
    });
  });

  await page.locator("#myArticlesFilters")
    .getByRole("button", { name: "阅读中", exact: true }).click();
  await page.waitForTimeout(20);
  await page.locator("#myArticlesFilters")
    .getByRole("button", { name: "已读完", exact: true }).click();
  await expect(page.locator("#myArticlesList")).toHaveAttribute("data-filter", "completed");
  await expect(getMyArticleItem(page, "Async completed article")).toBeVisible();
  await page.waitForTimeout(220);
  await expect(getMyArticleItem(page, "Async completed article")).toBeVisible();
  await expect(getMyArticleItem(page, "Async reading article")).toHaveCount(0);

  await page.locator("#myArticlesFilters")
    .getByRole("button", { name: "阅读中", exact: true }).click();
  await page.waitForTimeout(20);
  await page.locator("#myArticlesViewButton").click();
  await expect(page.locator("#myArticlesList")).toHaveAttribute("data-view", "deleted");
  await expect(getMyArticleItem(page, "Async deleted article")).toBeVisible();
  await page.waitForTimeout(220);
  await expect(page.locator("#myArticlesList")).toHaveAttribute("data-view", "deleted");
  await expect(getMyArticleItem(page, "Async deleted article")).toBeVisible();
  await expect(getMyArticleItem(page, "Async reading article")).toHaveCount(0);
});
