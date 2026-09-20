const { test, expect } = require("@playwright/test");

const projectErrors = new WeakMap();

async function waitForAppReady(page) {
  await expect(page.locator("#inputText")).toBeVisible();
  await expect(page.locator("#dictionarySetupStatus")).not.toHaveAttribute(
    "data-state",
    "checking"
  );
}

async function installLookup(page, lookup) {
  await page.evaluate(handler => {
    window.LingoFlowDictionaryLookupService.setProviders([{
      name: "dictionary_presentation_test",
      lookup: Function(`return (${handler})`)()
    }]);
  }, lookup.toString());
}

async function startReading(page) {
  await page.locator("#inputText").fill(
    "Presentation test\n\nReaders develop strong habits through calm daily practice."
  );
  await page.getByRole("button", { name: "开始阅读", exact: true }).click();
  await expect(page.locator("#readerLayout")).toHaveClass(/show/);
}

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
  await waitForAppReady(page);
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "词典展示不应产生项目自身错误").toEqual([]);
});

test("Word Card 与 Direct Search 共用安全的换行展示规则", async ({ page }) => {
  await installLookup(page, async ({ word }) => ({
    status: "found",
    query: word,
    headword: word.toLowerCase(),
    phonetic: null,
    translation: "v. 开发\\n[计] 开发程序\n[医] 生长",
    pos: null,
    relation: "",
    source: "presentation_test",
    attribution: "presentation_test"
  }));

  await page.evaluate(() => showWordCard("Develop", "", "article"));
  await expect(page.locator("#meaning .dictionaryDefinitionLine")).toHaveCount(3);
  await expect(page.locator("#meaning")).toHaveText("v. 开发[计] 开发程序[医] 生长");
  expect(await page.locator("#meaning").textContent()).not.toContain("\\n");

  await page.evaluate(() => directSearch("Develop"));
  const directLines = page.locator(
    "#directSearchResult .dictionaryDefinition > .dictionaryDefinitionLine"
  );
  await expect(directLines).toHaveCount(3);
  expect(await page.locator("#directSearchResult").textContent()).not.toContain("\\n");
  await expect(page.locator("#partOfSpeech")).toBeHidden();
});

test("无音标时发音操作紧邻 headword，词形说明保持轻量", async ({ page }) => {
  await startReading(page);
  await installLookup(page, async ({ word }) => ({
    status: "found",
    query: word,
    headword: word.toLowerCase(),
    phonetic: null,
    translation: "n. 专业；职业；行业（profession的复数形式）",
    pos: null,
    relation: "",
    source: "presentation_test",
    attribution: "presentation_test"
  }));

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 }
  ]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => showWordCard("Professions", "Context", "article"));

    const identity = page.locator("#wordCard .dictionaryIdentity");
    await expect(identity).toHaveClass(/dictionaryIdentityNoPhonetic/);
    await expect(page.locator("#phonetic")).toBeHidden();
    await expect(page.locator("#wordCardPronunciation"))
      .toHaveAttribute("aria-label", "朗读 Professions");

    const layout = await page.evaluate(() => {
      const headword = document.getElementById("currentWord").getBoundingClientRect();
      const pronunciation = document
        .getElementById("wordCardPronunciation")
        .getBoundingClientRect();
      const meaning = document.getElementById("meaning").getBoundingClientRect();
      return {
        headwordHeight: headword.height,
        centerDelta: Math.abs(
          (headword.top + headword.height / 2) -
          (pronunciation.top + pronunciation.height / 2)
        ),
        pronunciationWidth: pronunciation.width,
        pronunciationHeight: pronunciation.height,
        definitionGap: meaning.top - Math.max(headword.bottom, pronunciation.bottom)
      };
    });
    expect(layout.headwordHeight).toBeLessThan(40);
    expect(layout.centerDelta).toBeLessThan(10);
    expect(layout.pronunciationWidth).toBeGreaterThanOrEqual(44);
    expect(layout.pronunciationHeight).toBeGreaterThanOrEqual(44);
    expect(layout.definitionGap).toBeLessThanOrEqual(20);
  }

  const relation = page.locator("#meaning .dictionaryDefinitionRelationLine");
  await expect(relation).toHaveText("profession 的复数形式");
  const colors = await relation.evaluate(element => ({
    relation: getComputedStyle(element).color,
    primary: getComputedStyle(element.previousElementSibling).color
  }));
  expect(colors.relation).not.toBe(colors.primary);
});

test("Lemma 显示 canonical headword 与自然关系，Exact 不显示多余标记", async ({ page }) => {
  await installLookup(page, async ({ word }) => ({
    status: "found",
    query: word,
    headword: word.toLowerCase() === "professionals" ? "professional" : "accounting",
    phonetic: "/test/",
    translation: "专业人士",
    pos: "noun",
    relation: word.toLowerCase() === "professionals" ? "professionals → professional" : "",
    source: "presentation_test",
    attribution: "presentation_test"
  }));

  await page.evaluate(() => showWordCard("professionals", "", "article"));
  await expect(page.locator("#currentWord")).toHaveText("professional");
  await expect(page.locator("#morphologyRelation")).toHaveText("来自 professionals");

  await page.evaluate(() => directSearch("accounting"));
  await expect(page.locator("#directSearchResult .dictionaryHeadword"))
    .toHaveText("accounting");
  await expect(page.locator("#directSearchResult .morphologyBox")).not.toHaveClass(/show/);
});

test("not_found 与 unavailable 保持不同的用户状态", async ({ page }) => {
  await installLookup(page, async ({ word }) => ({
    status: word === "missing" ? "not_found" : "unavailable",
    query: word,
    reason: "cloud_unavailable"
  }));

  await page.evaluate(() => directSearch("missing"));
  await expect(page.locator("#directSearchResult .dictionaryResultCard"))
    .toHaveAttribute("data-lookup-status", "not_found");
  await expect(page.locator("#directSearchResult")).toContainText("暂未找到该词");
  await expect(page.locator("#directSearchResult")).not.toContainText("在线词典暂时不可用");

  await page.evaluate(() => directSearch("outage"));
  await expect(page.locator("#directSearchResult .dictionaryResultCard"))
    .toHaveAttribute("data-lookup-status", "unavailable");
  await expect(page.locator("#directSearchResult")).toContainText("在线词典暂时不可用");
  await expect(page.getByRole("button", { name: "查看完整离线词典" })).toBeVisible();
});

test("Direct Search 深色模式的词形关系不再出现硬编码白底", async ({ page }) => {
  await installLookup(page, async ({ word }) => ({
    status: "found",
    query: word,
    headword: "professional",
    phonetic: "/prəˈfeʃənəl/",
    translation: "专业人士",
    pos: "noun",
    relation: "professionals → professional",
    source: "presentation_test",
    attribution: "presentation_test"
  }));

  await page.evaluate(() => document.body.classList.add("darkMode"));
  await page.evaluate(() => directSearch("professionals"));

  const colors = await page.locator("#directSearchResult .morphologyBox").evaluate(element => ({
    background: getComputedStyle(element).backgroundColor,
    color: getComputedStyle(element).color,
    relationColor: getComputedStyle(element.querySelector(".morphologyRelation")).color
  }));
  expect(colors.background).not.toBe("rgb(255, 255, 255)");
  expect(colors.color).not.toBe(colors.background);
  expect(colors.relationColor).not.toBe(colors.background);
});

test("Word Card 收藏状态与发音按钮保留清晰的键盘行为", async ({ page }) => {
  await startReading(page);
  await installLookup(page, async ({ word }) => ({
    status: "found",
    query: word,
    headword: word.toLowerCase(),
    phonetic: "/dɪˈveləp/",
    translation: "发展",
    pos: "verb",
    relation: "",
    source: "presentation_test",
    attribution: "presentation_test"
  }));

  await page.evaluate(async () => {
    speakWord("Develop");
    await showWordCard("Develop", "Context", "article");
  });
  const favorite = page.locator("#favoriteCurrentButton");
  await expect(favorite).toHaveAttribute("aria-pressed", "false");
  await favorite.click();
  await expect(favorite).toHaveAttribute("aria-pressed", "true");
  await expect(favorite).toHaveText("★ 已收藏");

  const pronunciation = page.locator("#wordCardPronunciation");
  await expect(pronunciation).toHaveAttribute("aria-label", "朗读 Develop");
  const before = await page.evaluate(() => speechRequestId);
  await pronunciation.focus();
  await pronunciation.press("Enter");
  await expect.poll(() => page.evaluate(() => speechRequestId)).toBeGreaterThan(before);
  const target = await pronunciation.evaluate(element => ({
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height
  }));
  expect(target.width).toBeGreaterThanOrEqual(40);
  expect(target.height).toBeGreaterThanOrEqual(40);
});

test("1440 rail、1024 overlay 与 390 bottom sheet 保持 Reader 阅读轴", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startReading(page);
  await installLookup(page, async ({ word }) => ({
    status: "found",
    query: word,
    headword: word.toLowerCase(),
    phonetic: "/test/",
    translation: "一段用于响应式检查的释义。",
    pos: "noun",
    relation: "",
    source: "presentation_test",
    attribution: "presentation_test"
  }));

  const articleLeftBefore = await page.locator("#article").evaluate(
    element => element.getBoundingClientRect().left
  );
  await page.evaluate(() => showWordCard("Readers", "", "article"));
  const desktop = await page.evaluate(() => {
    const article = document.getElementById("article").getBoundingClientRect();
    const card = document.getElementById("wordCard").getBoundingClientRect();
    return {
      articleLeft: article.left,
      articleWidth: article.width,
      cardLeft: card.left,
      cardPosition: getComputedStyle(document.getElementById("wordCard")).position
    };
  });
  expect(desktop.articleLeft).toBe(articleLeftBefore);
  expect(desktop.articleWidth).toBeGreaterThanOrEqual(735);
  expect(desktop.articleWidth).toBeLessThanOrEqual(745);
  expect(desktop.cardLeft).toBeGreaterThan(desktop.articleLeft + desktop.articleWidth);
  expect(desktop.cardPosition).toBe("static");

  await page.setViewportSize({ width: 1024, height: 820 });
  const overlay = await page.locator("#wordCard").evaluate(element => {
    const rect = element.getBoundingClientRect();
    return {
      position: getComputedStyle(element).position,
      top: rect.top,
      right: window.innerWidth - rect.right,
      bottom: window.innerHeight - rect.bottom,
      overflowY: getComputedStyle(element).overflowY
    };
  });
  expect(overlay.position).toBe("fixed");
  expect(overlay.top).toBeGreaterThanOrEqual(0);
  expect(overlay.right).toBeGreaterThanOrEqual(20);
  expect(overlay.bottom).toBeGreaterThanOrEqual(20);
  expect(overlay.overflowY).toBe("auto");

  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.locator("#wordCard").evaluate(element => {
    const rect = element.getBoundingClientRect();
    const headword = document.getElementById("currentWord").getBoundingClientRect();
    return {
      position: getComputedStyle(element).position,
      left: rect.left,
      right: window.innerWidth - rect.right,
      bottom: window.innerHeight - rect.bottom,
      height: rect.height,
      headwordVisible: headword.top >= rect.top && headword.bottom <= rect.bottom
    };
  });
  expect(mobile.position).toBe("fixed");
  expect(mobile.left).toBe(10);
  expect(mobile.right).toBe(10);
  expect(mobile.bottom).toBe(10);
  expect(mobile.height).toBeLessThan(844);
  expect(mobile.headwordVisible).toBe(true);
});
