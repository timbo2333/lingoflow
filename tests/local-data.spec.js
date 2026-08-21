const { test, expect } = require("@playwright/test");

const FAVORITES_STORAGE_KEY = "EnglishReaderV051Favorites";
const VOCAB_STORAGE_KEY = "EnglishReaderV05Vocab";
const QUERY_EVENTS_KEY = "EnglishReaderV052QueryEvents";
const READING_PREFS_KEY = "EnglishReaderV052ReadingPrefs";
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

test("收藏保留 word / phrase 类型，并支持编辑和删除", async ({ page }) => {
  await page.evaluate(() => {
    currentLookupState = {
      word: "Develop",
      result: {
        baseWord: "develop",
        phonetic: "/dɪˈveləp/",
        pos: "verb",
        meaning: "发展"
      },
      sentence: "People develop skills through practice.",
      source: "search"
    };

    saveCurrentFavorite();
    savePhraseFavorite({
      text: "make progress",
      context: "Students make progress through regular practice."
    });
  });

  const created = await page.evaluate(key => (
    JSON.parse(localStorage.getItem(key) || "{}")
  ), FAVORITES_STORAGE_KEY);

  expect(Object.keys(created).sort()).toEqual(["develop", "phrase:make progress"]);
  expect(created.develop).toMatchObject({
    type: "word",
    word: "develop",
    displayWord: "Develop",
    meaning: "发展",
    sentence: "People develop skills through practice.",
    source: "search"
  });
  expect(created["phrase:make progress"]).toMatchObject({
    type: "phrase",
    word: "make progress",
    sentence: "Students make progress through regular practice.",
    source: "article-selection"
  });

  await page.evaluate(() => openFavorites());
  const wordCard = page.locator('.favoriteItem[data-favorite-key="develop"]');
  await expect(wordCard).toBeVisible();
  await wordCard.locator(".editFavoriteButton").click();
  await wordCard.locator(".meaningEditor").fill("发展；培养");
  await wordCard.locator(".noteEditor").fill("baseline note");
  await wordCard.getByRole("button", { name: "保存修改", exact: true }).click();

  await expect.poll(async () => page.evaluate(key => {
    const favorites = JSON.parse(localStorage.getItem(key) || "{}");
    return {
      meaning: favorites.develop?.meaning,
      note: favorites.develop?.note
    };
  }, FAVORITES_STORAGE_KEY)).toEqual({
    meaning: "发展；培养",
    note: "baseline note"
  });

  page.once("dialog", dialog => dialog.accept());
  await wordCard.locator(".removeTiny").click();

  const afterDelete = await page.evaluate(key => (
    JSON.parse(localStorage.getItem(key) || "{}")
  ), FAVORITES_STORAGE_KEY);
  expect(afterDelete.develop).toBeUndefined();
  expect(afterDelete["phrase:make progress"]?.type).toBe("phrase");
});

test("查询会创建事件并更新 vocab 聚合", async ({ page }) => {
  await page.evaluate(() => {
    const result = {
      baseWord: "develop",
      phonetic: "/dɪˈveləp/",
      pos: "verb",
      meaning: "发展"
    };

    recordQueryEvent("Develop", result, "article");
    recordQueryEvent("develop", result, "search");
    rebuildVocabFromMergeData();
  });

  const stored = await page.evaluate(({ eventsKey, vocabKey }) => ({
    events: JSON.parse(localStorage.getItem(eventsKey) || "{}"),
    vocab: JSON.parse(localStorage.getItem(vocabKey) || "{}")
  }), {
    eventsKey: QUERY_EVENTS_KEY,
    vocabKey: VOCAB_STORAGE_KEY
  });

  const events = Object.values(stored.events);
  expect(events).toHaveLength(2);
  expect(new Set(events.map(event => event.id)).size).toBe(2);
  expect(events.every(event => event.id.startsWith("query:"))).toBe(true);
  expect(events.every(event => event.word === "develop")).toBe(true);
  expect(events.every(event => Boolean(event.deviceId))).toBe(true);
  expect(events.map(event => event.source).sort()).toEqual(["article", "search"]);

  expect(stored.vocab.develop).toMatchObject({
    word: "develop",
    count: 2,
    articleCount: 1,
    searchCount: 1,
    meaning: "发展",
    source: "search"
  });
});

test("修改单个阅读设置时保留其他偏好", async ({ page }) => {
  const originalPreferences = {
    fontSize: "21",
    lineHeight: "2",
    appearance: "dark",
    speechRate: "0.85",
    speechVoice: {
      name: "Baseline Voice",
      lang: "en-US",
      voiceURI: "baseline-voice"
    },
    futureSetting: "keep-me"
  };

  await page.evaluate(({ key, preferences }) => {
    localStorage.setItem(key, JSON.stringify(preferences));
    syncQuickReadingSetting("font", "24");
  }, {
    key: READING_PREFS_KEY,
    preferences: originalPreferences
  });

  const saved = await page.evaluate(key => (
    JSON.parse(localStorage.getItem(key) || "{}")
  ), READING_PREFS_KEY);

  expect(saved).toEqual({
    ...originalPreferences,
    fontSize: "24"
  });
});
