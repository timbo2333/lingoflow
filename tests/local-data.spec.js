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

test("Favorite UI 使用稳定 ID 创建和查询 word / phrase，并忽略旧收藏数据", async ({ page }) => {
  const legacyRaw = JSON.stringify({
    develop: {
      type: "word",
      word: "develop",
      meaning: "旧收藏不应被新 UI 读取",
      mastered: true
    }
  });

  await page.evaluate(({ legacyKey, legacyValue }) => {
    localStorage.setItem(legacyKey, legacyValue);
  }, {
    legacyKey: FAVORITES_STORAGE_KEY,
    legacyValue: legacyRaw
  });
  await page.reload();
  await expect(page.locator("#inputText")).toBeVisible();
  await expect(page.locator("#dictionarySetupStatus")).not.toHaveAttribute(
    "data-state",
    "checking"
  );

  const result = await page.evaluate(legacyKey => {
    const lookupResult = {
      baseWord: "develop",
      phonetic: "/dɪˈveləp/",
      pos: "verb",
      meaning: "发展"
    };
    const ignoredLegacyFavorite = isFavorite("Develop", lookupResult);

    currentLookupState = {
      word: "Develop",
      result: lookupResult,
      sentence: "People develop skills through practice.",
      source: "search"
    };

    const word = saveCurrentFavorite();
    const firstPhraseResult = savePhraseFavorite({
      text: "make progress",
      context: "Students make progress through regular practice."
    });
    const phraseBeforeRepeat = window.LingoFlowFavoriteRepository
      .findByContent({ type: "phrase", text: "make progress" })[0];
    const repeatedPhraseResult = savePhraseFavorite({
      text: "make progress",
      context: "A different article also says make progress."
    });
    const phraseAfterRepeat = window.LingoFlowFavoriteRepository
      .findByContent({ type: "phrase", text: "make progress" })[0];

    return {
      ignoredLegacyFavorite,
      isFavoriteAfterCreate: isFavorite("Develop", lookupResult),
      word,
      firstPhraseResult,
      repeatedPhraseResult,
      phraseBeforeRepeat,
      phraseAfterRepeat,
      favorites: window.LingoFlowFavoriteRepository.list(),
      legacyRaw: localStorage.getItem(legacyKey),
      badge: document.getElementById("favoriteCountBadge")?.textContent || ""
    };
  }, FAVORITES_STORAGE_KEY);

  expect(result.ignoredLegacyFavorite).toBe(false);
  expect(result.isFavoriteAfterCreate).toBe(true);
  expect(result.legacyRaw).toBe(legacyRaw);
  expect(result.badge).toBe("(2)");
  expect(result.firstPhraseResult).toMatchObject({ saved: true, existed: false });
  expect(result.repeatedPhraseResult).toMatchObject({ saved: true, existed: true });
  expect(result.phraseAfterRepeat).toEqual(result.phraseBeforeRepeat);
  expect(result.favorites).toHaveLength(2);

  const word = result.favorites.find(item => item.type === "word");
  const phrase = result.favorites.find(item => item.type === "phrase");
  expect(word).toMatchObject({
    type: "word",
    text: "develop",
    displayText: "Develop",
    meaning: "发展",
    partOfSpeech: "verb",
    context: "People develop skills through practice.",
    origin: { kind: "search" }
  });
  expect(phrase).toMatchObject({
    type: "phrase",
    text: "make progress",
    context: "Students make progress through regular practice.",
    origin: { kind: "article-selection" }
  });
  expect(word.id).toMatch(/^favorite:.+/);
  expect(phrase.id).toMatch(/^favorite:.+/);
  expect(word.id).not.toBe(phrase.id);
  expect(word.id).not.toBe(word.text);
  expect(Object.prototype.hasOwnProperty.call(word, "mastered")).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(word, "dictionaryFound")).toBe(false);

  await page.evaluate(() => openFavorites());
  await expect(page.locator(".favoriteItem")).toHaveCount(2);
  await expect(page.locator("#favoritesList")).not.toContainText("旧收藏不应被新 UI 读取");
  await expect(page.locator(`.favoriteItem[data-favorite-id="${word.id}"]`)).toBeVisible();
  await expect(page.locator(`.favoriteItem[data-favorite-id="${phrase.id}"]`)).toBeVisible();
});

test("Favorite UI 编辑保持稳定身份，并将 mastered 写入独立 Learning State", async ({ page }) => {
  const created = await page.evaluate(() => {
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
    return saveCurrentFavorite();
  });

  await page.evaluate(() => openFavorites());
  let wordCard = page.locator(`.favoriteItem[data-favorite-id="${created.id}"]`);
  await expect(wordCard).toBeVisible();
  await wordCard.locator(".editFavoriteButton").click();
  await wordCard.locator(".meaningEditor").fill("发展；培养");
  await wordCard.locator(".contextEditor").fill("Practice helps people develop lasting skills.");
  await wordCard.locator(".noteEditor").fill("baseline note");
  await wordCard.locator(".tagsEditor").fill("IELTS, 写作");
  await wordCard.locator(".masteredEditor").check();
  await wordCard.getByRole("button", { name: "保存修改", exact: true }).click();

  await expect.poll(async () => page.evaluate(favoriteId => {
    const favorite = window.LingoFlowFavoriteRepository.getById(favoriteId);
    const learning = window.LingoFlowFavoriteLearningRepository.get(favoriteId);
    return {
      meaning: favorite?.meaning,
      note: favorite?.note,
      context: favorite?.context,
      tags: favorite?.tags,
      mastered: learning?.mastered
    };
  }, created.id)).toEqual({
    meaning: "发展；培养",
    note: "baseline note",
    context: "Practice helps people develop lasting skills.",
    tags: ["IELTS", "写作"],
    mastered: true
  });

  const afterFirstSave = await page.evaluate(id => ({
    favorite: window.LingoFlowFavoriteRepository.getById(id),
    learning: window.LingoFlowFavoriteLearningRepository.get(id)
  }), created.id);
  expect(afterFirstSave.favorite.id).toBe(created.id);
  expect(afterFirstSave.favorite.createdAt).toBe(created.createdAt);
  expect(Date.parse(afterFirstSave.favorite.updatedAt)).toBeGreaterThan(Date.parse(created.updatedAt));
  expect(Object.prototype.hasOwnProperty.call(afterFirstSave.favorite, "mastered")).toBe(false);
  expect(afterFirstSave.learning).toMatchObject({
    favoriteId: created.id,
    mastered: true
  });

  await expect(page.locator(`.favoriteItem[data-favorite-id="${created.id}"] .masterBadge`))
    .toHaveText("✓ 已掌握");

  await page.locator("#favoriteMasterFilter").selectOption("mastered");
  await expect(page.locator(`.favoriteItem[data-favorite-id="${created.id}"]`)).toBeVisible();
  await page.locator("#favoriteMasterFilter").selectOption("learning");
  await expect(page.locator(`.favoriteItem[data-favorite-id="${created.id}"]`)).toHaveCount(0);
  await page.locator("#favoriteMasterFilter").selectOption("all");

  wordCard = page.locator(`.favoriteItem[data-favorite-id="${created.id}"]`);
  await wordCard.locator(".editFavoriteButton").click();
  await wordCard.locator(".masteredEditor").uncheck();
  await wordCard.getByRole("button", { name: "保存修改", exact: true }).click();

  await expect.poll(async () => page.evaluate(favoriteId => (
    window.LingoFlowFavoriteLearningRepository.get(favoriteId)?.mastered
  ), created.id)).toBe(false);

  const afterLearningOnlySave = await page.evaluate(id => ({
    favorite: window.LingoFlowFavoriteRepository.getById(id),
    learning: window.LingoFlowFavoriteLearningRepository.get(id)
  }), created.id);
  expect(afterLearningOnlySave.favorite.updatedAt).toBe(afterFirstSave.favorite.updatedAt);
  expect(Date.parse(afterLearningOnlySave.learning.updatedAt))
    .toBeGreaterThan(Date.parse(afterFirstSave.learning.updatedAt));
});

test("Favorite UI 删除使用 soft delete，并保留独立 Learning State", async ({ page }) => {
  const setup = await page.evaluate(() => {
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
    const favorite = saveCurrentFavorite();
    const sibling = window.LingoFlowFavoriteRepository.create({
      type: "word",
      text: "develop",
      displayText: "develop",
      meaning: "培养",
      context: "A second independent Favorite snapshot."
    });
    const learning = window.LingoFlowFavoriteLearningRepository.setMastered(favorite.id, true);
    openFavorites();
    return { favorite, sibling, learning };
  });

  const wordCard = page.locator(`.favoriteItem[data-favorite-id="${setup.favorite.id}"]`);
  const siblingCard = page.locator(`.favoriteItem[data-favorite-id="${setup.sibling.id}"]`);
  await expect(wordCard).toBeVisible();
  await expect(siblingCard).toBeVisible();
  page.once("dialog", dialog => dialog.accept());
  await wordCard.locator(".removeTiny").click();

  await expect(wordCard).toHaveCount(0);
  const afterDelete = await page.evaluate(id => ({
    active: window.LingoFlowFavoriteRepository.list(),
    deleted: window.LingoFlowFavoriteRepository.getById(id, { includeDeleted: true }),
    learning: window.LingoFlowFavoriteLearningRepository.get(id),
    isFavorite: isFavorite("Develop", { baseWord: "develop" }),
    badge: document.getElementById("favoriteCountBadge")?.textContent || ""
  }), setup.favorite.id);

  expect(afterDelete.active).toHaveLength(1);
  expect(afterDelete.active[0].id).toBe(setup.sibling.id);
  expect(afterDelete.deleted).toMatchObject({
    id: setup.favorite.id,
    text: setup.favorite.text,
    createdAt: setup.favorite.createdAt
  });
  expect(afterDelete.deleted.deletedAt).not.toBeNull();
  expect(afterDelete.deleted.updatedAt).toBe(afterDelete.deleted.deletedAt);
  expect(afterDelete.learning).toEqual(setup.learning);
  expect(afterDelete.isFavorite).toBe(true);
  expect(afterDelete.badge).toBe("(1)");
  await expect(siblingCard).toBeVisible();
});

test("同内容多个 Favorite 时，内容入口不会任意删除任何稳定实体", async ({ page }) => {
  const before = await page.evaluate(() => {
    const repository = window.LingoFlowFavoriteRepository;
    repository.create({
      type: "word",
      text: "develop",
      displayText: "Develop",
      meaning: "发展",
      context: "First independent snapshot."
    });
    repository.create({
      type: "word",
      text: "develop",
      displayText: "develop",
      meaning: "培养",
      context: "Second independent snapshot."
    });
    currentLookupState = {
      word: "Develop",
      result: { baseWord: "develop" },
      sentence: "",
      source: "search"
    };
    return repository.list({ includeDeleted: true });
  });

  let dialogMessage = "";
  page.once("dialog", async dialog => {
    dialogMessage = dialog.message();
    await dialog.accept();
  });
  await page.evaluate(() => toggleCurrentFavorite());

  const after = await page.evaluate(() => (
    window.LingoFlowFavoriteRepository.list({ includeDeleted: true })
  ));
  expect(dialogMessage).toContain("多个相同内容");
  expect(after).toEqual(before);
  expect(after).toHaveLength(2);
  expect(after.every(item => item.deletedAt === null)).toBe(true);
});

test("Favorite CSV 从新 Entity 与 Learning State 导出，并忽略 legacy 和 tombstone", async ({ page }) => {
  const legacyRaw = JSON.stringify({
    "legacy-only": {
      word: "legacy-only",
      meaning: "旧格式收藏不应进入当前 CSV",
      mastered: true
    }
  });
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), {
    key: FAVORITES_STORAGE_KEY,
    raw: legacyRaw
  });

  const seeded = await page.evaluate(() => {
    const favorites = window.LingoFlowFavoriteRepository;
    const learning = window.LingoFlowFavoriteLearningRepository;
    const word = favorites.create({
      type: "word",
      text: "develop",
      displayText: "Develop",
      phonetic: "/dɪˈveləp/",
      partOfSpeech: "verb",
      meaning: "发展",
      tags: ["IELTS", "writing"],
      context: "People develop skills through practice.",
      note: "note, with \"quote\""
    });
    const phrase = favorites.create({
      type: "phrase",
      text: "make progress",
      meaning: "取得进展",
      tags: ["phrase"],
      context: "Students make progress through practice.",
      note: ""
    });
    const deleted = favorites.create({
      type: "word",
      text: "deleted-only",
      meaning: "不应进入 CSV"
    });
    favorites.softDelete(deleted.id);
    learning.setMastered(word.id, true);
    learning.setMastered(phrase.id, false);
    return { word, phrase, deleted };
  });

  const downloadPromise = page.waitForEvent("download");
  await page.evaluate(() => exportFavoritesCSV());
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const csv = Buffer.concat(chunks).toString("utf8");

  const csvRow = values => values
    .map(value => `"${String(value ?? "").replace(/"/g, '""')}"`)
    .join(",");

  expect(download.suggestedFilename()).toBe("english-reader-favorites.csv");
  expect(csv.charCodeAt(0)).toBe(0xFEFF);
  const lines = csv.slice(1).split("\n");
  expect(lines[0]).toBe(csvRow([
    "type",
    "word",
    "phonetic",
    "pos",
    "meaning",
    "tags",
    "mastered",
    "context_sentence",
    "note",
    "created_at",
    "updated_at"
  ]));
  expect(lines.slice(1)).toHaveLength(2);
  expect(new Set(lines.slice(1))).toEqual(new Set([
    csvRow([
      "WORD",
      seeded.word.text,
      seeded.word.phonetic,
      seeded.word.partOfSpeech,
      seeded.word.meaning,
      seeded.word.tags.join("|"),
      "yes",
      seeded.word.context,
      seeded.word.note,
      seeded.word.createdAt,
      seeded.word.updatedAt
    ]),
    csvRow([
      "PHRASE",
      seeded.phrase.text,
      seeded.phrase.phonetic || "",
      seeded.phrase.partOfSpeech || "",
      seeded.phrase.meaning,
      seeded.phrase.tags.join("|"),
      "no",
      seeded.phrase.context,
      seeded.phrase.note,
      seeded.phrase.createdAt,
      seeded.phrase.updatedAt
    ])
  ]));
  expect(csv).not.toContain("legacy-only");
  expect(csv).not.toContain("deleted-only");
  expect(await page.evaluate(key => localStorage.getItem(key), FAVORITES_STORAGE_KEY))
    .toBe(legacyRaw);
});

test("收藏数量和设置页统计只使用新 Repository", async ({ page }) => {
  const legacyRaw = JSON.stringify({
    one: { word: "one" },
    two: { word: "two" },
    three: { word: "three" }
  });
  await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), {
    key: FAVORITES_STORAGE_KEY,
    raw: legacyRaw
  });

  const result = await page.evaluate(async legacyKey => {
    const favorites = window.LingoFlowFavoriteRepository;
    const learning = window.LingoFlowFavoriteLearningRepository;
    const active = favorites.create({
      type: "word",
      text: "active-only",
      meaning: "活动收藏"
    });
    const deleted = favorites.create({
      type: "phrase",
      text: "deleted phrase",
      meaning: "软删除收藏"
    });
    favorites.softDelete(deleted.id);
    learning.setMastered(active.id, true);

    updateVocabBadges();
    await openSettings();

    const favoriteBytes = favorites.getStorageBytes() + learning.getStorageBytes();
    return {
      badge: document.getElementById("favoriteCountBadge")?.textContent,
      toolbarBadge: document.getElementById("favoriteCountBadgeToolbar")?.textContent,
      settingsCount: document.getElementById("settingsFavoriteCount")?.textContent,
      settingsSize: document.getElementById("settingsFavoriteSize")?.textContent,
      expectedSize: `约 ${formatBytes(favoriteBytes)}`,
      activeCount: favorites.count(),
      allCount: favorites.count({ includeDeleted: true }),
      legacyRaw: localStorage.getItem(legacyKey)
    };
  }, FAVORITES_STORAGE_KEY);

  expect(result).toEqual({
    badge: "(1)",
    toolbarBadge: "(1)",
    settingsCount: "1 个收藏",
    settingsSize: result.expectedSize,
    expectedSize: result.expectedSize,
    activeCount: 1,
    allCount: 2,
    legacyRaw
  });
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
