const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
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

test("Home 首屏以文章输入和开始阅读为主，次级功能仍可到达", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "LingoFlow", level: 1 })).toBeVisible();
  await expect(page.locator(".description")).toHaveText("阅读英文，点一下就懂。");

  const composer = page.locator("#articleInputSurface");
  await expect(composer).toBeVisible();
  const startButton = composer.getByRole("button", { name: "开始阅读" });
  const input = page.locator("#inputText");
  await expect(startButton).toBeVisible();
  await expect(startButton).toBeDisabled();
  await expect(input).toHaveAttribute("placeholder", "粘贴英文文章…");
  await expect(input).not.toHaveAttribute("placeholder", /Example|I felt nervous/);

  await page.getByRole("button", { name: "插入示例" }).click();
  await expect(input).toHaveValue(/I felt nervous/);
  await expect(startButton).toBeEnabled();
  await input.fill("");
  await expect(startButton).toBeDisabled();
  await expect(page.locator("#directSearchInput")).toBeVisible();
  await expect(page.locator("#myArticlesInputButton")).toBeVisible();
  const favoritesButton = page.getByRole("button", { name: /我的收藏/ });
  const historyButton = page.getByRole("button", { name: /查询记录/ });
  const settingsButton = page.locator("#homeSettingsButton");
  await expect(favoritesButton).toBeVisible();
  await expect(historyButton).toBeVisible();
  await expect(page.locator("#accountButton")).toBeVisible();
  await expect(settingsButton).toBeVisible();
  await expect(settingsButton).toHaveText("⚙ 设置");
  await expect(page.locator(".homeQuickActions button")).toHaveCount(2);
  await expect(page.locator(".homeQuickActions")).not.toContainText("设置");

  await favoritesButton.click();
  await expect(page.locator("#favoritesModal")).toHaveClass(/show/);
  await page.locator("#favoritesModal .iconClose").click();

  await historyButton.click();
  await expect(page.locator("#vocabModal")).toHaveClass(/show/);
  await page.locator("#vocabModal .iconClose").click();

  await settingsButton.click();
  await expect(page.locator("#settingsModal")).toHaveClass(/show/);
  await page.locator("#settingsModal .iconClose").click();

  await page.locator("#accountButton").click();
  await expect(page.locator("#authModal")).toHaveClass(/show/);
  await page.locator("#authModalClose").click();

  const offline = page.locator(".homeOfflineDisclosure");
  await expect(offline).not.toHaveAttribute("open", "");
  await offline.locator("summary").click();
  await expect(page.locator("#dictionarySetupStatus")).toBeVisible();
});

test("Mobile Account 与 Settings 保持 44px 点击区域且不挤压 Desktop header", async ({ page }) => {
  for (const width of [320, 375, 390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    const layout = await page.evaluate(() => {
      const measure = id => {
        const rect = document.getElementById(id).getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      };
      return {
        account: measure("accountButton"),
        settings: measure("homeSettingsButton"),
        overflowX: document.documentElement.scrollWidth > window.innerWidth
      };
    });

    if (width <= 390) {
      expect(layout.account.height).toBeGreaterThanOrEqual(44);
      expect(layout.settings.height).toBeGreaterThanOrEqual(44);
      expect(layout.account.width).toBeGreaterThanOrEqual(44);
      expect(layout.settings.width).toBeGreaterThanOrEqual(44);
    } else {
      expect(layout.account.height).toBeLessThanOrEqual(40);
      expect(layout.settings.height).toBeLessThanOrEqual(40);
    }
    expect(layout.overflowX).toBe(false);
  }
});

test("Home Footer 降低工程数据集曝光并在 About 保留完整 attribution", async ({ page }) => {
  const footer = page.locator(".appFooter");
  await expect(footer).toContainText("词典数据来源与版权说明");
  await expect(footer).not.toContainText("ECDICT");

  await page.locator("#homeSettingsButton").click();
  await page.locator("#settingsAboutDisclosure > summary").click();
  const attribution = page.locator(".settingsDictionaryAttribution");
  await expect(attribution).toContainText("第三方 ECDICT 数据集");
  await expect(attribution).toContainText("原项目及各自数据来源所有");
});

test("整个文章输入区域接受 TXT drop 并保留既有导入来源", async ({ page }) => {
  const surface = page.locator("#articleInputSurface");
  await page.evaluate(() => {
    const dataTransfer = new DataTransfer();
    document.getElementById("articleInputSurface").dispatchEvent(new DragEvent("dragenter", {
      bubbles: true,
      cancelable: true,
      dataTransfer
    }));
  });
  await expect(surface).toHaveClass(/dragging/);
  await expect(page.locator("#articleDropOverlay")).toHaveCSS("opacity", "1");

  await page.evaluate(async () => {
    const file = new File(
      ["Phase 3 TXT title\nThis article came through the whole input surface."],
      "phase-3.txt",
      { type: "text/plain" }
    );
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    const surface = document.getElementById("articleInputSurface");
    surface.dispatchEvent(new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer
    }));
  });

  await expect(page.locator("#inputText")).toHaveValue(/Phase 3 TXT title/);
  await expect(page.locator(".dropZoneTitle")).toHaveText("已载入：phase-3.txt");
  await page.getByRole("button", { name: "开始阅读", exact: true }).click();
  await expect(page.locator("#readerLayout")).toHaveClass(/show/);

  const [article] = await page.evaluate(() => (
    window.LingoFlowArticleLibrary.listArticles()
  ));
  expect(article.title).toBe("phase-3");
  expect(article.sourceType).toBe("txt");
  expect(article.sourceTitle).toBe("phase-3.txt");
});

test("Home 继续阅读复用文章库的候选与真实打开链路", async ({ page }) => {
  const id = await page.evaluate(async () => {
    const library = window.LingoFlowArticleLibrary;
    const article = await library.createArticle({
      title: "Continue from Home",
      content: "Continue from Home\nA saved article remains available for reading.",
      sourceType: "paste"
    });
    await library.updateArticleReading(article.id, {
      progress: 0.42,
      paragraphIndex: 1,
      updatedAt: "2026-09-15T08:00:00.000Z",
      lastReadAt: "2026-09-15T08:00:00.000Z"
    });
    await refreshHomeContinueReading();
    return article.id;
  });

  const card = page.locator("#homeContinueReading");
  await expect(card).toBeVisible();
  await expect(page.locator("#homeContinueTitle")).toHaveText("Continue from Home");
  await expect(page.locator("#homeContinueMeta")).toHaveText("已阅读 42%");
  await expect(page.locator("#homeContinueButton")).toHaveAttribute("data-article-id", id);

  await page.locator("#homeContinueButton").click();
  await expect(page.locator("#readerLayout")).toHaveClass(/show/);
  await expect(page.locator("#readerArticleTitle")).toHaveText("Continue from Home");
});

test("文章列表以打开为主操作，编辑和删除收进更多菜单", async ({ page }) => {
  await page.evaluate(async () => {
    await window.LingoFlowArticleLibrary.createArticle({
      title: "A quiet reading list item",
      content: "A quiet reading list item body.",
      sourceType: "paste"
    });
  });
  await page.locator("#myArticlesInputButton").click();

  const item = page.locator(".myArticleItem").filter({ hasText: "A quiet reading list item" });
  await expect(item.getByRole("button", { name: "打开文章：A quiet reading list item" }))
    .toBeVisible();
  await expect(item.getByRole("button", { name: "编辑文章标题：A quiet reading list item" }))
    .toBeHidden();
  await item.locator(".myArticleMore > summary").click();
  await expect(item.getByRole("button", { name: "编辑文章标题：A quiet reading list item" }))
    .toBeVisible();
  await expect(item.getByRole("button", { name: "删除文章：A quiet reading list item" }))
    .toBeVisible();
});

test("文章库空状态、390px 与 Dark Mode 保持清晰", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#myArticlesInputButton").click();
  await expect(page.locator("#myArticlesList")).toContainText(
    "还没有保存的文章。回到首页粘贴一篇英文文章开始阅读。"
  );
  await page.getByRole("button", { name: "关闭我的文章" }).click();

  const mobileLayout = await page.evaluate(() => {
    const composer = document.getElementById("articleInputSurface").getBoundingClientRect();
    const controls = document.querySelector(".articleInputSurface .controls").getBoundingClientRect();
    return {
      composerLeft: composer.left,
      composerRight: composer.right,
      viewportWidth: window.innerWidth,
      controlsWidth: controls.width
    };
  });
  expect(mobileLayout.composerLeft).toBeGreaterThanOrEqual(0);
  expect(mobileLayout.composerRight).toBeLessThanOrEqual(mobileLayout.viewportWidth);
  expect(mobileLayout.controlsWidth).toBeGreaterThan(250);

  await page.evaluate(() => document.body.classList.add("darkMode"));
  await expect(page.locator("#articleInputSurface")).toHaveCSS("background-color", "rgb(29, 29, 32)");
  await expect(page.locator("#inputText")).toHaveCSS("color", "rgb(244, 244, 245)");
});
