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
    localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
  });
  await page.goto("/");
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "Reader 页面不应产生项目自身错误").toEqual([]);
});

async function startReading(page, title = "A calm reader shell") {
  const article = `${title}\n\nPeople develop useful reading habits through patient daily practice. ` +
    "A clear page helps readers stay focused on meaning instead of controls. ".repeat(18);
  await page.locator("#inputText").fill(article);
  await page.getByRole("button", { name: "开始阅读", exact: true }).click();
  await expect(page.locator("#readerLayout")).toHaveClass(/show/);
  return article;
}

async function installReaderLookupStub(page) {
  await page.evaluate(() => {
    window.LingoFlowDictionaryLookupService.setProviders([{
      name: "reader_visual_test",
      async lookup({ word }) {
        return {
          status: "found",
          headword: word.toLowerCase(),
          phonetic: null,
          translation: `测试释义：${word}`,
          pos: null,
          relation: "",
          source: "reader_visual_test"
        };
      }
    }]);
  });
}

test("移动端 Home 不显示空 Reader，进入阅读后显示标题与紧凑壳层", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });

  await expect(page.locator("#readerLayout")).toBeHidden();
  const homeState = await page.evaluate(() => ({
    layoutDisplay: getComputedStyle(document.getElementById("readerLayout")).display,
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
  }));
  expect(homeState).toEqual({ layoutDisplay: "none", horizontalOverflow: false });

  await startReading(page, "Mobile reading title");
  await expect(page.locator("body")).toHaveClass(/readerActive/);
  await expect(page.locator("#readerArticleTitle")).toHaveText("Mobile reading title");
  await expect(page.locator(".page > h1")).toBeHidden();

  const readerState = await page.evaluate(() => {
    const toolbar = document.getElementById("readingToolbar").getBoundingClientRect();
    const article = document.getElementById("article").getBoundingClientRect();
    return {
      toolbarHeight: toolbar.height,
      articleTop: article.top,
      articleWidth: article.width,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  });

  expect(readerState.toolbarHeight).toBeLessThanOrEqual(68);
  expect(readerState.articleTop).toBeLessThanOrEqual(100);
  expect(readerState.articleWidth).toBeGreaterThan(350);
  expect(readerState.horizontalOverflow).toBe(false);
});

test("桌面与中等宽度保持舒适正文宽度，Word Card 按断点切换", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startReading(page);

  const desktop = await page.evaluate(() => ({
    articleWidth: document.getElementById("article").getBoundingClientRect().width,
    layoutDisplay: getComputedStyle(document.getElementById("readerLayout")).display,
    asidePosition: getComputedStyle(document.querySelector("#readerLayout > aside")).position
  }));
  expect(desktop.articleWidth).toBeGreaterThanOrEqual(755);
  expect(desktop.articleWidth).toBeLessThanOrEqual(765);
  expect(desktop.layoutDisplay).toBe("grid");
  expect(desktop.asidePosition).toBe("sticky");

  await page.setViewportSize({ width: 1024, height: 820 });
  const medium = await page.evaluate(() => ({
    articleWidth: document.getElementById("article").getBoundingClientRect().width,
    layoutDisplay: getComputedStyle(document.getElementById("readerLayout")).display,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
  }));
  expect(medium.articleWidth).toBeGreaterThanOrEqual(755);
  expect(medium.articleWidth).toBeLessThanOrEqual(765);
  expect(medium.layoutDisplay).toBe("block");
  expect(medium.overflow).toBe(false);

  await installReaderLookupStub(page);
  await page.locator("#article .word").first().click();
  await expect(page.locator("#wordCard")).toHaveClass(/show/);
  expect(await page.locator("#wordCard").evaluate(element => (
    getComputedStyle(element).position
  ))).toBe("fixed");
  const closeTarget = await page.locator("#closeCard").evaluate(element => ({
    label: element.getAttribute("aria-label"),
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height
  }));
  expect(closeTarget).toEqual({
    label: "关闭单词释义",
    width: 44,
    height: 44
  });

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileCard = await page.evaluate(() => {
    const card = document.getElementById("wordCard");
    const rect = card.getBoundingClientRect();
    return {
      position: getComputedStyle(card).position,
      left: rect.left,
      right: window.innerWidth - rect.right,
      bottom: window.innerHeight - rect.bottom,
      hasSafeReadingSpace: document.body.classList.contains("readerWordCardOpen") &&
        Number.parseFloat(getComputedStyle(document.getElementById("readerLayout")).paddingBottom) > 100
    };
  });
  expect(mobileCard).toEqual({
    position: "fixed",
    left: 10,
    right: 10,
    bottom: 10,
    hasSafeReadingSpace: true
  });
});

test("Reader controls 支持键盘、明确标签和 44px 触控目标", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await startReading(page);

  const findSummary = page.locator("#readerFindMenu > summary");
  await findSummary.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#readerFindMenu")).toHaveAttribute("open", "");
  await expect(page.locator("#articleFindInput")).toBeFocused();

  await page.locator("#articleFindInput").fill("reading");
  await expect(page.locator("#articleFindCount")).not.toHaveText("");
  await page.keyboard.press("Escape");
  await expect(page.locator("#readerFindMenu")).not.toHaveAttribute("open", "");

  const moreSummary = page.locator("#readerMoreMenu > summary");
  await moreSummary.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#readerMoreMenu")).toHaveAttribute("open", "");
  for (const label of [
    "新草稿", "我的文章", "查询记录", "我的收藏", "设置", "更新日志", "帮助"
  ]) {
    await expect(page.locator("#readerMoreMenu").getByRole("button", { name: new RegExp(label) }))
      .toBeVisible();
  }
  await expect(page.locator("#speed")).toBeVisible();
  await expect(page.locator("#voiceSelect")).toBeVisible();
  await page.keyboard.press("Escape");

  const targets = await page.locator(
    ".readerHeaderRow .readerControl:visible, .readerIconButton:visible"
  ).evaluateAll(elements => elements.map(element => ({
    label: element.getAttribute("aria-label"),
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height
  })));

  expect(targets.length).toBeGreaterThanOrEqual(4);
  targets.forEach(target => {
    expect(target.label).toBeTruthy();
    expect(target.width).toBeGreaterThanOrEqual(44);
    expect(target.height).toBeGreaterThanOrEqual(44);
  });
});

test("已有 ReadingPrefs 继续优先，默认值只作用于未保存偏好的用户", async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem("EnglishReaderV052ReadingPrefs", JSON.stringify({
      fontSize: "25",
      lineHeight: "2.4",
      appearance: "dark"
    }));
  });
  await page.reload();
  await startReading(page, "Saved reading preferences");

  const saved = await page.evaluate(() => ({
    fontSize: getComputedStyle(document.getElementById("article")).fontSize,
    lineHeight: getComputedStyle(document.getElementById("article")).lineHeight,
    dark: document.body.classList.contains("darkMode"),
    background: getComputedStyle(document.querySelector(".readerHeaderRow")).backgroundColor
  }));
  expect(saved.fontSize).toBe("25px");
  expect(Number.parseFloat(saved.lineHeight)).toBeCloseTo(60, 0);
  expect(saved.dark).toBe(true);
  expect(saved.background).not.toBe("rgb(255, 255, 255)");
});

test("动态 Header 使用方向阈值隐藏和显示，并跟随正文标题可见性", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 820 });
  await startReading(page, "Dynamic header title that remains on one line");
  const toolbar = page.locator("#readingToolbar");

  await expect(toolbar).not.toHaveClass(/readerTitleVisible/);
  await expect(toolbar).not.toHaveClass(/readerHeaderHidden/);
  await page.waitForTimeout(380);

  await page.evaluate(() => window.scrollTo(0, 520));
  await expect(toolbar).toHaveClass(/readerHeaderHidden/);
  await expect(toolbar).toHaveClass(/readerTitleVisible/);

  await page.evaluate(() => window.scrollBy(0, -10));
  await expect(toolbar).toHaveClass(/readerHeaderHidden/);
  await page.evaluate(() => window.scrollBy(0, -15));
  await expect(toolbar).not.toHaveClass(/readerHeaderHidden/);
  await expect(toolbar).toHaveClass(/readerTitleVisible/);

  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(toolbar).not.toHaveClass(/readerHeaderHidden/);
  await expect(toolbar).not.toHaveClass(/readerTitleVisible/);
});

test("Direct Search 与正文查词不会污染 Reader 标题，新正文会更新自动标题", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installReaderLookupStub(page);

  await page.locator("#directSearchInput").fill("read");
  await page.getByRole("button", { name: "查询", exact: true }).click();
  await expect(page.locator("#directSearchResult")).toContainText("测试释义：read");

  const firstTitle = "Generative AI and the Evolution of the Modern Workplace";
  await page.locator("#inputText").fill(
    `${firstTitle}\n\nModern developer teams improve products through careful review. `.repeat(28)
  );
  await page.getByRole("button", { name: "开始阅读", exact: true }).click();
  await expect(page.locator("#readerLayout")).toHaveClass(/show/);
  await expect(page.locator("#readerArticleTitle")).toHaveText(firstTitle);
  await expect(page.locator("#readingToolbar")).not.toHaveClass(/readerTitleVisible/);

  await page.waitForTimeout(380);
  await page.evaluate(() => window.scrollTo(0, 620));
  await page.evaluate(() => window.scrollBy(0, -30));
  await expect(page.locator("#readingToolbar")).toHaveClass(/readerTitleVisible/);
  await expect(page.locator("#readerArticleTitle")).toHaveText(firstTitle);

  await page.locator("#article .word", { hasText: /^developer$/i }).first().click();
  await expect(page.locator("#currentWord")).toHaveText("developer");
  await expect(page.locator("#readerArticleTitle")).toHaveText(firstTitle);
  await page.locator("#article .word", { hasText: /^teams$/i }).first().click();
  await expect(page.locator("#currentWord")).toHaveText("teams");
  await expect(page.locator("#readerArticleTitle")).toHaveText(firstTitle);

  await page.getByRole("button", { name: /返回重新编辑文章/ }).click();
  await expect(page.locator("#inputText")).toBeVisible();
  await expect(page.locator("#readerLayout")).not.toHaveClass(/show/);
  const secondTitle = "A Different Article About Human-Centered Technology";
  await page.locator("#inputText").fill(
    `${secondTitle}\n\nThoughtful readers compare evidence and revise their conclusions. `.repeat(24)
  );
  await page.getByRole("button", { name: "开始阅读", exact: true }).click();
  await expect(page.locator("#readerArticleTitle")).toHaveText(secondTitle);
  await expect(page.locator("#inputText")).toBeEnabled();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
  await expect(page.locator("#readingToolbar")).not.toHaveClass(/readerTitleVisible/);

  await page.waitForTimeout(380);
  await page.evaluate(() => window.scrollTo(0, 620));
  await page.evaluate(() => window.scrollBy(0, -30));
  await expect(page.locator("#readingToolbar")).toHaveClass(/readerTitleVisible/);
  await expect(page.locator("#readerArticleTitle")).toHaveText(secondTitle);
});

test("宽屏 Word Card 避开 Header，打开关闭时正文阅读轴保持稳定", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startReading(page, "Stable reading axis with a visible dictionary note");
  await installReaderLookupStub(page);

  const before = await page.locator("#article").evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, center: rect.left + rect.width / 2 };
  });
  await page.locator("#article .word").first().click();
  await expect(page.locator("#wordCard")).toHaveClass(/show/);

  const visibleHeader = await page.evaluate(() => {
    const header = document.querySelector(".readerHeaderRow").getBoundingClientRect();
    const card = document.getElementById("wordCard").getBoundingClientRect();
    const headword = document.getElementById("currentWord").getBoundingClientRect();
    const article = document.getElementById("article").getBoundingClientRect();
    return {
      headerBottom: header.bottom,
      cardTop: card.top,
      headwordTop: headword.top,
      articleLeft: article.left,
      articleCenter: article.left + article.width / 2
    };
  });
  expect(visibleHeader.cardTop).toBeGreaterThanOrEqual(visibleHeader.headerBottom + 8);
  expect(visibleHeader.headwordTop).toBeGreaterThanOrEqual(visibleHeader.cardTop);
  expect(Math.abs(visibleHeader.articleLeft - before.left)).toBeLessThan(1);
  expect(Math.abs(visibleHeader.articleCenter - before.center)).toBeLessThan(1);
  expect(Math.abs(visibleHeader.articleCenter - 720)).toBeLessThan(2);

  await page.locator("#closeCard").click();
  const afterClose = await page.locator("#article").evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, center: rect.left + rect.width / 2 };
  });
  expect(Math.abs(afterClose.left - before.left)).toBeLessThan(1);
  expect(Math.abs(afterClose.center - before.center)).toBeLessThan(1);

  await page.waitForTimeout(380);
  await page.evaluate(() => window.scrollTo(0, 620));
  await expect(page.locator("#readingToolbar")).toHaveClass(/readerHeaderHidden/);
  await page.evaluate(() => showWordCard("developer", "A developer reads.", "article"));
  await expect(page.locator("#wordCard")).toHaveClass(/show/);
  const hiddenHeaderCardTop = await page.locator("#wordCard").evaluate(
    element => element.getBoundingClientRect().top
  );
  expect(Math.abs(hiddenHeaderCardTop - visibleHeader.cardTop)).toBeLessThan(1);
});

test("查找、Aa 和更多面板打开时锁定 Header", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 820 });
  await startReading(page, "Locked reader controls");
  await page.waitForTimeout(380);
  const toolbar = page.locator("#readingToolbar");

  await page.evaluate(() => window.scrollTo(0, 520));
  await expect(toolbar).toHaveClass(/readerHeaderHidden/);
  await page.evaluate(() => window.scrollBy(0, -30));
  await expect(toolbar).not.toHaveClass(/readerHeaderHidden/);

  await page.locator("#readerFindMenu > summary").click();
  await page.evaluate(() => window.scrollBy(0, 180));
  await expect(toolbar).not.toHaveClass(/readerHeaderHidden/);
  await page.keyboard.press("Escape");

  await page.locator("#readerMoreMenu > summary").click();
  await page.evaluate(() => window.scrollBy(0, 180));
  await expect(toolbar).not.toHaveClass(/readerHeaderHidden/);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "打开阅读显示设置" }).click();
  await page.evaluate(() => window.scrollBy(0, 180));
  await expect(toolbar).not.toHaveClass(/readerHeaderHidden/);
  await expect(page.locator("#readingSettingsModal")).toHaveClass(/show/);
});

test("Reduced Motion 关闭 Header 位移动画", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await startReading(page, "Reduced motion header");
  await page.waitForTimeout(380);
  await page.evaluate(() => window.scrollTo(0, 520));
  await expect(page.locator("#readingToolbar")).toHaveClass(/readerHeaderHidden/);

  const motion = await page.locator("#readingToolbar").evaluate(element => ({
    transform: getComputedStyle(element).transform,
    visibility: getComputedStyle(element).visibility,
    duration: getComputedStyle(element).transitionDuration
  }));
  expect(motion.transform).toBe("none");
  expect(motion.visibility).toBe("hidden");
  expect(motion.duration).toContain("0.001s");
});
