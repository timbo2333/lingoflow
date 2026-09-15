const { test, expect } = require("@playwright/test");

async function waitForAppReady(page) {
  await expect(page.locator("#inputText")).toBeVisible();
  await expect(page.locator("#dictionarySetupStatus")).not.toHaveAttribute(
    "data-state",
    "checking"
  );
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
  });
  await page.goto("/");
  await waitForAppReady(page);
});

test("Favorites presents words, phrases, learning state, notes, and tags as a review list", async ({ page }) => {
  const favorites = await page.evaluate(async () => {
    const word = window.LingoFlowFavoriteRepository.create({
      type: "word",
      text: "resilient",
      displayText: "resilient",
      phonetic: "/rɪˈzɪliənt/",
      partOfSpeech: "adjective",
      meaning: "有韧性的；适应力强的",
      note: "常用于描述人或系统。",
      tags: ["IELTS", "写作"],
      context: "A resilient system can recover quickly."
    });
    const phrase = window.LingoFlowFavoriteRepository.create({
      type: "phrase",
      text: "make progress",
      displayText: "make progress",
      meaning: "取得进步"
    });
    window.LingoFlowFavoriteLearningRepository.setMastered(phrase.id, true);
    openFavorites();
    return { wordId: word.id, phraseId: phrase.id };
  });

  await expect(page.locator("#favoritesSummary"))
    .toHaveText("2 项收藏 · 1 项学习中 · 1 项已掌握");

  const wordCard = page.locator(`[data-favorite-id="${favorites.wordId}"]`);
  await expect(wordCard).toContainText("resilient");
  await expect(wordCard).toContainText("有韧性的；适应力强的");
  await expect(wordCard).toContainText("常用于描述人或系统。");
  await expect(wordCard).toContainText("#IELTS");
  await expect(wordCard.locator(".masterBadge")).toHaveText("学习中");
  const pronunciation = wordCard.getByRole("button", { name: "朗读 resilient" });
  await expect(pronunciation).toBeVisible();
  await pronunciation.click();
  await expect(pronunciation).toBeDisabled();
  await expect(pronunciation).toBeEnabled({ timeout: 1500 });

  const phraseCard = page.locator(`[data-favorite-id="${favorites.phraseId}"]`);
  await expect(phraseCard).toContainText("词组");
  await expect(phraseCard.locator(".masterBadge")).toHaveText("✓ 已掌握");
  await expect(phraseCard).toHaveClass(/mastered/);

  await page.locator('[data-master-filter="mastered"]').click();
  await expect(phraseCard).toBeVisible();
  await expect(wordCard).toHaveCount(0);
  await page.locator('[data-master-filter="all"]').click();
  await expect(wordCard).toBeVisible();
});

test("Favorites keeps learning direct while edit and delete stay in More", async ({ page }) => {
  const favoriteId = await page.evaluate(() => {
    const favorite = window.LingoFlowFavoriteRepository.create({
      type: "word",
      text: "deliberate",
      displayText: "deliberate",
      meaning: "深思熟虑的"
    });
    openFavorites();
    return favorite.id;
  });

  let card = page.locator(`[data-favorite-id="${favoriteId}"]`);
  await expect(card.locator(".favoriteLearningQuickButton")).toBeVisible();
  await expect(card.locator(".editFavoriteButton")).not.toBeVisible();

  await card.locator(".favoriteLearningQuickButton").click();
  card = page.locator(`[data-favorite-id="${favoriteId}"]`);
  await expect(card.locator(".masterBadge")).toHaveText("✓ 已掌握");

  await card.locator(".favoriteMore > summary").click();
  await expect(card.locator(".editFavoriteButton")).toBeVisible();
  await card.locator(".editFavoriteButton").click();
  await expect(card).toHaveClass(/editing/);
  await expect(card.locator(".meaningEditor")).toHaveValue("深思熟虑的");

  await card.locator(".favoriteCancelEditButton").click();
  card = page.locator(`[data-favorite-id="${favoriteId}"]`);
  await card.locator(".favoriteMore > summary").click();
  page.once("dialog", dialog => dialog.accept());
  await card.locator(".removeTiny").click();
  await expect(card).toHaveCount(0);
});

test("Favorites and Query History use natural empty states", async ({ page }) => {
  await page.evaluate(() => openFavorites());
  await expect(page.locator("#favoritesList")).toContainText("还没有收藏的词");
  await page.evaluate(() => {
    closeModal("favoritesModal");
    openVocabBook();
  });
  await expect(page.locator("#vocabList")).toContainText("还没有查询过单词");
  await expect(page.locator("#vocabList")).not.toContainText("暂无数据");
});

test("Query History switches between recent and high-frequency learning views", async ({ page }) => {
  await page.evaluate(() => {
    window.LingoFlowFavoriteRepository.create({
      type: "word",
      text: "environment",
      displayText: "environment",
      meaning: "环境"
    });
    setVocabData({
      environment: {
        word: "environment",
        phonetic: "/ɪnˈvaɪrənmənt/",
        pos: "noun",
        meaning: "环境",
        count: 8,
        articleCount: 5,
        searchCount: 3,
        firstSeen: "2026-09-01T10:00:00.000Z",
        lastSeen: "2026-09-14T10:00:00.000Z"
      },
      recent: {
        word: "recent",
        meaning: "最近的",
        count: 1,
        articleCount: 0,
        searchCount: 1,
        firstSeen: "2026-09-15T10:00:00.000Z",
        lastSeen: "2026-09-15T10:00:00.000Z"
      }
    });
    openVocabBook();
  });

  await expect(page.locator("#vocabSummary")).toHaveText("2 个词 · 共查询 9 次");
  await expect(page.locator(".vocabItem").first().locator(".vocabWord")).toHaveText("recent");
  await expect(page.locator(".vocabItem", { hasText: "environment" })
    .getByRole("button", { name: "environment 已收藏" }))
    .toBeDisabled();
  await expect(page.locator(".vocabItem", { hasText: "recent" })
    .getByRole("button", { name: "收藏 recent" }))
    .toBeEnabled();
  await expect(page.locator("#vocabList")).not.toContainText("文章点击");
  await expect(page.locator("#vocabList")).not.toContainText("首次：");

  const historyPronunciation = page.locator(".vocabItem", { hasText: "environment" })
    .getByRole("button", { name: "朗读 environment" });
  await historyPronunciation.click();
  await expect(historyPronunciation).toBeDisabled();
  await expect(historyPronunciation).toBeEnabled({ timeout: 1500 });

  await page.locator('[data-history-view="high"]').click();
  const first = page.locator(".vocabItem").first();
  await expect(first.locator(".vocabWord")).toHaveText("environment");
  await expect(first.locator(".historyLookupCount")).toHaveText("查过 8 次");
  await expect(first).toContainText("最近查询");
});

test("Query History favorites in place without creating another query event", async ({ page }) => {
  const before = await page.evaluate(() => {
    addToVocab("resilient", {
      phonetic: "/ˈrɛzɪliənt/",
      pos: "adjective",
      meaning: "有韧性的"
    }, "article");
    openVocabBook();
    return {
      count: getVocabData().resilient.count,
      eventCount: window.LingoFlowQueryEventRepository.list().length
    };
  });

  await expect(page.getByRole("button", { name: "查看释义" })).toHaveCount(0);
  const row = page.locator(".vocabItem", { hasText: "resilient" });
  await row.getByRole("button", { name: "收藏 resilient" }).click();
  await expect(row.getByRole("button", { name: "resilient 已收藏" })).toBeDisabled();

  await page.locator('[data-history-view="high"]').click();
  await expect(page.locator(".vocabItem", { hasText: "resilient" })
    .getByRole("button", { name: "resilient 已收藏" }))
    .toBeDisabled();
  await page.locator('[data-history-view="recent"]').click();
  await expect(page.locator(".vocabItem", { hasText: "resilient" })
    .getByRole("button", { name: "resilient 已收藏" }))
    .toBeDisabled();

  const after = await page.evaluate(async () => {
    await favoriteHistoryWord("resilient");
    return {
      count: getVocabData().resilient.count,
      eventCount: window.LingoFlowQueryEventRepository.list().length,
      favorites: window.LingoFlowFavoriteRepository.list()
    };
  });
  expect({ count: after.count, eventCount: after.eventCount }).toEqual(before);
  expect(after.favorites).toHaveLength(1);
  expect(after.favorites[0]).toMatchObject({
    type: "word",
    text: "resilient",
    phonetic: "/ˈrɛzɪliənt/",
    partOfSpeech: "adjective",
    meaning: "有韧性的"
  });

  await page.evaluate(() => {
    closeModal("vocabModal");
    openFavorites();
  });
  await expect(page.locator("#favoritesModal .favoriteItem", { hasText: "resilient" }))
    .toBeVisible();
});

test("Query History reuses dictionary line normalization without literal newlines", async ({ page }) => {
  await page.evaluate(() => {
    setVocabData({
      ai: { word: "ai", meaning: "[计] 人工智能\\n[俗] 三趾树懒", count: 1 },
      scientific: { word: "scientific", meaning: "adj. 科学的\nadj. 系统的", count: 1 },
      professions: { word: "professions", meaning: "n. 职业\\nprofession 的复数形式", count: 1 }
    });
    openVocabBook();
  });

  await expect(page.locator("#vocabList")).not.toContainText("\\n");
  for (const word of ["ai", "scientific", "professions"]) {
    const row = page.locator(".vocabItem", { hasText: word });
    await expect(row.locator(".historyMeaning .dictionaryDefinitionLine")).toHaveCount(2);
  }
});

test("Manage and row More popovers are exclusive and reset with view or modal changes", async ({ page }) => {
  await page.evaluate(() => {
    window.LingoFlowFavoriteRepository.create({
      type: "word", text: "alpha", displayText: "alpha", meaning: "第一个"
    });
    window.LingoFlowFavoriteRepository.create({
      type: "word", text: "beta", displayText: "beta", meaning: "第二个"
    });
    openFavorites();
  });

  const favoritesManage = page.locator("#favoritesModal .collectionManage");
  const favoriteMore = page.locator("#favoritesModal .favoriteMore");
  await favoritesManage.locator("summary").click();
  await expect(favoritesManage).toHaveAttribute("open", "");
  await favoriteMore.nth(0).locator("summary").click();
  await expect(favoritesManage).not.toHaveAttribute("open", "");
  await expect(favoriteMore.nth(0)).toHaveAttribute("open", "");
  await favoriteMore.nth(1).locator("summary").click();
  await expect(favoriteMore.nth(0)).not.toHaveAttribute("open", "");
  await expect(favoriteMore.nth(1)).toHaveAttribute("open", "");
  await page.locator("#favoritesModal .modalTitle").click();
  await expect(favoriteMore.nth(1)).not.toHaveAttribute("open", "");

  await favoritesManage.locator("summary").click();
  await page.keyboard.press("Escape");
  await expect(favoritesManage).not.toHaveAttribute("open", "");
  await expect(page.locator("#favoritesModal")).toHaveClass(/show/);

  await favoriteMore.nth(0).locator("summary").click();
  await page.locator('[data-master-filter="learning"]').click();
  await expect(page.locator("#favoritesModal .collectionManage[open], #favoritesModal .itemMore[open]"))
    .toHaveCount(0);
  await page.evaluate(() => closeModal("favoritesModal"));

  await page.evaluate(() => {
    setVocabData({
      alpha: { word: "alpha", meaning: "第一个", count: 2 },
      beta: { word: "beta", meaning: "第二个", count: 1 }
    });
    openVocabBook();
  });
  const historyManage = page.locator("#vocabModal .collectionManage");
  const historyMore = page.locator("#vocabModal .historyItemMore");
  await historyManage.locator("summary").click();
  await historyMore.nth(0).locator("summary").click();
  await expect(historyManage).not.toHaveAttribute("open", "");
  await expect(historyMore.nth(0)).toHaveAttribute("open", "");
  await page.locator('[data-history-view="high"]').click();
  await expect(page.locator("#vocabModal .collectionManage[open], #vocabModal .itemMore[open]"))
    .toHaveCount(0);
});

test("Learning collections stay centered and overflow-free at 1440 and 1024", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    window.LingoFlowFavoriteRepository.create({
      type: "word",
      text: "editorial",
      displayText: "editorial",
      meaning: "编辑的；社论的"
    });
    openFavorites();
  });

  const desktop = await page.locator("#favoritesModal .learningCollectionModal")
    .evaluate(element => {
      const box = element.getBoundingClientRect();
      return {
        width: box.width,
        centered: Math.abs(box.left - (window.innerWidth - box.right)) < 2,
        pageFits: document.documentElement.scrollWidth <= window.innerWidth
      };
    });
  expect(desktop.width).toBeLessThanOrEqual(900);
  expect(desktop.centered).toBe(true);
  expect(desktop.pageFits).toBe(true);

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.evaluate(() => {
    closeModal("favoritesModal");
    setVocabData({
      editorial: {
        word: "editorial",
        meaning: "社论",
        count: 4,
        lastSeen: "2026-09-15T10:00:00.000Z"
      }
    });
    openVocabBook();
  });
  const tablet = await page.locator("#vocabModal .learningCollectionModal")
    .evaluate(element => {
      const box = element.getBoundingClientRect();
      return {
        insideViewport: box.left >= 0 && box.right <= window.innerWidth,
        pageFits: document.documentElement.scrollWidth <= window.innerWidth
      };
    });
  expect(tablet).toEqual({ insideViewport: true, pageFits: true });
});

test("Learning collections remain single-column, touchable, and overflow-free on mobile and dark mode", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    document.body.classList.add("darkMode");
    window.LingoFlowFavoriteRepository.create({
      type: "phrase",
      text: "a deliberately long phrase for responsive reading",
      displayText: "a deliberately long phrase for responsive reading",
      meaning: "用于验证移动端长词组布局",
      note: "操作仍然留在收藏项内部。",
      tags: ["mobile"]
    });
    openFavorites();
  });

  const favoriteLayout = await page.evaluate(() => {
    const modal = document.querySelector("#favoritesModal .learningCollectionModal");
    const quick = document.querySelector(".favoriteLearningQuickButton");
    return {
      pageFits: document.documentElement.scrollWidth <= window.innerWidth,
      modalFits: modal.getBoundingClientRect().right <= window.innerWidth,
      quickHeight: quick.getBoundingClientRect().height,
      background: getComputedStyle(modal).backgroundColor
    };
  });
  expect(favoriteLayout.pageFits).toBe(true);
  expect(favoriteLayout.modalFits).toBe(true);
  expect(favoriteLayout.quickHeight).toBeGreaterThanOrEqual(44);
  expect(favoriteLayout.background).not.toBe("rgb(255, 255, 255)");

  await page.evaluate(() => {
    closeModal("favoritesModal");
    setVocabData({
      responsive: {
        word: "responsive-layout-with-a-long-headword",
        meaning: "移动端查询记录不会横向溢出",
        count: 5,
        lastSeen: "2026-09-15T10:00:00.000Z"
      }
    });
    openVocabBook();
  });

  await expect(page.locator("#vocabModal .vocabItem")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
});
