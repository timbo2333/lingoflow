const { test, expect } = require("@playwright/test");

const projectErrors = new WeakMap();

test.beforeEach(async ({ page }) => {
  const errors = [];
  projectErrors.set(page, errors);

  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (message.type() !== "error") return;
    const sourceUrl = message.location().url || "";
    if (!sourceUrl || sourceUrl.includes("127.0.0.1")) {
      errors.push(`console.error: ${message.text()}`);
    }
  });

  await page.addInitScript(() => {
    try {
      localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
    } catch (_error) {
      // Cross-origin/data URL setup pages may not expose storage.
    }
  });
  await page.goto("/");
  await expect(page.locator("#inputText")).toBeVisible();
  await expectNavigationView(page, "home");
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

async function expectNavigationView(page, view, articleId) {
  await expect.poll(() => page.evaluate(() => (
    history.state?.lingoflowNavigation || null
  ))).toMatchObject(articleId ? { view, articleId } : { view });
}

function makeArticle(title, paragraphCount = 16) {
  return [
    title,
    ...Array.from({ length: paragraphCount }, (_, index) => (
      `Paragraph ${index + 1} gives readers enough English words to test stable navigation, ` +
      "dictionary selection, and saved reading progress across browser history."
    ))
  ].join("\n\n");
}

async function startReading(page, title = "Navigation article", paragraphCount = 16) {
  await page.locator("#inputText").fill(makeArticle(title, paragraphCount));
  await page.getByRole("button", { name: "开始阅读", exact: true }).click();
  await expect(page.locator("#readerLayout")).toHaveClass(/show/);
  await expect(page.locator("#readerArticleTitle")).toHaveText(title);
  await expectNavigationView(page, "reader");
  const state = await page.evaluate(() => history.state.lingoflowNavigation);
  expect(state).toMatchObject({ view: "reader" });
  return state.articleId;
}

async function createStoredArticle(page, title = "Library navigation article") {
  return page.evaluate(async ({ articleTitle, content }) => {
    return window.LingoFlowArticleLibrary.createArticle({
      title: articleTitle,
      content,
      sourceType: "paste"
    });
  }, {
    articleTitle: title,
    content: makeArticle(title)
  });
}

async function openArticleLibrary(page) {
  await page.locator("#myArticlesInputButton").click();
  await expect(page.locator("#myArticlesModal")).toHaveClass(/show/);
  await expect(page.locator("#myArticlesList")).not.toHaveAttribute("data-state", "loading");
  await expectNavigationView(page, "article-library");
}

async function openLibraryArticle(page, title) {
  const item = page.locator(".myArticleItem").filter({ hasText: title });
  await item.getByRole("button", { name: new RegExp(`(?:打开|继续阅读)文章：${title}`) }).click();
  await expect(page.locator("#readerLayout")).toHaveClass(/show/);
  await expect(page.locator("#readerArticleTitle")).toHaveText(title);
}

test("Home → Reader 支持真实 Back / Forward 并从存储恢复文章", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const initialLength = await page.evaluate(() => history.length);
  const articleId = await startReading(page, "Home reader history");

  expect(await page.evaluate(() => history.length)).toBe(initialLength + 1);
  await expectNavigationView(page, "reader", articleId);

  await page.goBack();
  await expect(page.locator("#inputText")).toBeVisible();
  await expect(page.locator("#readerLayout")).not.toHaveClass(/show/);
  await expectNavigationView(page, "home");

  await page.goForward();
  await expect(page.locator("#readerLayout")).toHaveClass(/show/);
  await expect(page.locator("#readerArticleTitle")).toHaveText("Home reader history");
  await expectNavigationView(page, "reader", articleId);
});

test("Home → Article Library → Reader 按上下文 Back / Forward", async ({ page }) => {
  const article = await createStoredArticle(page, "Library reader history");
  await openArticleLibrary(page);
  await openLibraryArticle(page, article.title);
  await expectNavigationView(page, "reader", article.id);

  await page.goBack();
  await expect(page.locator("#myArticlesModal")).toHaveClass(/show/);
  await expect(page.locator("#myArticlesList")).toContainText(article.title);
  await expectNavigationView(page, "article-library");

  await page.goBack();
  await expect(page.locator("#myArticlesModal")).not.toHaveClass(/show/);
  await expect(page.locator("#inputText")).toBeVisible();
  await expectNavigationView(page, "home");

  await page.goForward();
  await expect(page.locator("#myArticlesModal")).toHaveClass(/show/);
  await expectNavigationView(page, "article-library");

  await page.goForward();
  await expect(page.locator("#readerLayout")).toHaveClass(/show/);
  await expect(page.locator("#readerArticleTitle")).toHaveText(article.title);
  await expectNavigationView(page, "reader", article.id);
});

test("Reader Header 返回与 Browser Back 一致，390px 保持正常", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await startReading(page, "Mobile header back");

  await page.getByRole("button", { name: "返回上一页" }).click();
  await expect(page.locator("#inputText")).toBeVisible();
  await expect(page.locator("#readerLayout")).not.toHaveClass(/show/);
  await expectNavigationView(page, "home");

  await page.goForward();
  await expect(page.locator("#readerLayout")).toHaveClass(/show/);
  await expect(page.locator("#readerArticleTitle")).toHaveText("Mobile header back");
  expect(await page.evaluate(() => (
    document.documentElement.scrollWidth > document.documentElement.clientWidth
  ))).toBe(false);
});

test("Browser Back 离开 Reader 前保存阅读进度，Forward 后恢复", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 820 });
  const articleId = await startReading(page, "Progress through history", 70);

  const snapshot = await page.evaluate(() => {
    const metrics = getArticleReadingMetrics();
    window.scrollTo({
      top: metrics.startY + metrics.scrollRange * 0.5,
      behavior: "auto"
    });
    window.dispatchEvent(new Event("scroll"));
    return calculateArticleReadingSnapshot();
  });
  expect(snapshot.progress).toBeGreaterThan(0.4);

  await page.goBack();
  await expect(page.locator("#inputText")).toBeVisible();
  await expect.poll(() => page.evaluate(async id => (
    (await window.LingoFlowArticleLibrary.getArticle(id)).reading.progress
  ), articleId)).toBeGreaterThan(0.4);

  await page.goForward();
  await expect(page.locator("#readerLayout")).toHaveClass(/show/);
  await expect.poll(() => page.evaluate(() => (
    calculateArticleReadingSnapshot()?.progress || 0
  ))).toBeGreaterThan(0.35);
});

test("Reader reload 只 restore 当前 state，不新增重复 history entry", async ({ page }) => {
  const articleId = await startReading(page, "Reload reader history");
  const historyLength = await page.evaluate(() => history.length);

  await page.reload();
  await expect(page.locator("#readerLayout")).toHaveClass(/show/);
  await expect(page.locator("#readerArticleTitle")).toHaveText("Reload reader history");
  await expectNavigationView(page, "reader", articleId);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
});

test("历史中的文章不存在时安全 fallback Home", async ({ page }) => {
  const articleId = await startReading(page, "Deleted history article");
  await page.goBack();
  await expectNavigationView(page, "home");
  await page.evaluate(id => window.LingoFlowArticleLibrary.updateArticle(id, {
    deletedAt: new Date().toISOString()
  }), articleId);

  await page.goForward();
  await expect(page.locator("#inputText")).toBeVisible();
  await expect(page.locator("#readerLayout")).not.toHaveClass(/show/);
  await expectNavigationView(page, "home");
});

test("首次 Home 只 replace 当前 entry，Back 可离开应用", async ({ page }) => {
  await page.goto("data:text/html,<title>Navigation source</title><p>Previous site</p>");
  await page.goto("http://127.0.0.1:4173/");
  await expectNavigationView(page, "home");
  const historyLength = await page.evaluate(() => history.length);

  await page.goBack();
  await expect(page).toHaveURL(/^data:text\/html/);
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
});

test("Word Card、Aa、More 不写入 history，普通 Modal Back 不离开 Reader", async ({ page }) => {
  await startReading(page, "Transient UI history");
  await page.evaluate(() => {
    window.LingoFlowDictionaryLookupService.setProviders([{
      name: "navigation_test",
      async lookup({ word }) {
        return {
          status: "found",
          headword: word.toLowerCase(),
          phonetic: null,
          translation: "导航测试释义",
          pos: null,
          relation: "",
          source: "navigation_test"
        };
      }
    }]);
  });
  const baseline = await page.evaluate(() => ({
    length: history.length,
    state: JSON.stringify(history.state)
  }));

  await page.locator("#article .word").first().click();
  await expect(page.locator("#wordCard")).toHaveClass(/show/);
  await page.getByRole("button", { name: "打开阅读显示设置" }).click();
  await expect(page.locator("#readingSettingsModal")).toHaveClass(/show/);
  await page.locator("#readingSettingsModal .iconClose").click();
  await page.locator("#readerMoreMenu > summary").click();
  await expect(page.locator("#readerMoreMenu")).toHaveAttribute("open", "");

  expect(await page.evaluate(() => ({
    length: history.length,
    state: JSON.stringify(history.state)
  }))).toEqual(baseline);

  await page.getByRole("button", { name: /设置/ }).last().click();
  await expect(page.locator("#settingsModal")).toHaveClass(/show/);
  await page.goBack();
  await expect(page.locator("#settingsModal")).not.toHaveClass(/show/);
  await expect(page.locator("#readerLayout")).toHaveClass(/show/);
  await expectNavigationView(page, "reader");
  expect(await page.evaluate(() => history.length)).toBe(baseline.length);
});

test("1440px Reader navigation 不改变阅读布局", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startReading(page, "Desktop navigation layout");
  const before = await page.locator("#article").evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, center: rect.left + rect.width / 2 };
  });

  await page.goBack();
  await page.goForward();
  await expect(page.locator("#readerLayout")).toHaveClass(/show/);
  const after = await page.locator("#article").evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, center: rect.left + rect.width / 2 };
  });

  expect(Math.abs(after.width - before.width)).toBeLessThan(1);
  expect(Math.abs(after.center - before.center)).toBeLessThan(1);
});
