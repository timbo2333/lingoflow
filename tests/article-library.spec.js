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
    .toContainText(/阅读 [1-9][0-9]?%/);

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
      name: "打开文章：Keep farthest progress after toolbar navigation"
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
    .getByRole("button", { name: "打开文章：Restore saved paragraph" })
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
    .getByRole("button", { name: "打开文章：Progress fallback after layout change" })
    .click();
  await expect.poll(() => page.evaluate(() => Boolean(calculateArticleReadingSnapshot())))
    .toBe(true);

  const restoredProgress = await page.evaluate(() => (
    calculateArticleReadingSnapshot().progress
  ));
  expect(restoredProgress).toBeGreaterThan(0.57);
  expect(restoredProgress).toBeLessThan(0.69);
});

test("我的文章显示未开始和实际阅读百分比", async ({ page }) => {
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
    await library.updateArticleReading(nearEnd.id, {
      progress: 0.97,
      paragraphIndex: 2,
      updatedAt: "2026-08-18T05:10:00.000Z"
    });
  });

  await openMyArticles(page);
  await expect(getMyArticleItem(page, "Never started article").locator(".myArticleMeta"))
    .toContainText("未开始");
  await expect(getMyArticleItem(page, "Forty two percent article").locator(".myArticleMeta"))
    .toContainText("阅读 42%");
  await expect(getMyArticleItem(page, "Near end article").locator(".myArticleMeta"))
    .toContainText("阅读 97%");
  await expect(page.locator("#myArticlesList")).not.toContainText("已完成");
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
