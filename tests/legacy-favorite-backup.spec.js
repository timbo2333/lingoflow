const { test, expect } = require("@playwright/test");

const LEGACY_FAVORITES_KEY = "EnglishReaderV051Favorites";

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

test("Legacy Favorite adapter 保留旧合并语义并与新 Repository 隔离", async ({ page }) => {
  const result = await page.evaluate(() => {
    const legacy = window.LingoFlowLegacyFavoriteBackup;
    const favorites = window.LingoFlowFavoriteRepository;
    const learning = window.LingoFlowFavoriteLearningRepository;

    const currentFavorite = favorites.create({
      type: "phrase",
      text: "make progress",
      meaning: "当前 Favorite Entity"
    });
    const learningState = learning.setMastered(currentFavorite.id, true);
    const currentEntities = favorites.list({ includeDeleted: true });

    const currentLegacy = {
      "old-phrase-key": {
        type: "phrase",
        word: "Make Progress",
        meaning: "取得进展",
        note: "old note",
        tags: ["old"],
        mastered: false,
        createdAt: "2025-01-01T00:00:00.000Z",
        updatedAt: "2025-01-02T00:00:00.000Z"
      }
    };
    const incomingLegacy = {
      "another-phrase-key": {
        type: "phrase",
        word: "make progress",
        meaning: "不断进步",
        note: "new note",
        tags: ["new"],
        mastered: true,
        createdAt: "2025-01-03T00:00:00.000Z",
        updatedAt: "2025-01-04T00:00:00.000Z"
      }
    };

    const merged = legacy.mergeSnapshots(currentLegacy, incomingLegacy);
    legacy.replaceSnapshot(merged);

    return {
      frozen: Object.isFrozen(legacy),
      methods: Object.keys(legacy).sort(),
      legacy: legacy.readSnapshot(),
      newEntitiesBefore: currentEntities,
      newEntitiesAfter: favorites.list({ includeDeleted: true }),
      learningBefore: learningState,
      learningAfter: learning.get(currentFavorite.id)
    };
  });

  expect(result.frozen).toBe(true);
  expect(result.methods).toEqual([
    "countSnapshot",
    "mergeSnapshots",
    "readSnapshot",
    "replaceSnapshot"
  ]);
  expect(Object.keys(result.legacy)).toEqual(["phrase:make progress"]);
  expect(result.legacy["phrase:make progress"]).toMatchObject({
    type: "phrase",
    meaning: "不断进步",
    tags: ["old", "new"],
    mastered: true,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-04T00:00:00.000Z"
  });
  expect(result.legacy["phrase:make progress"].note).toContain("old note");
  expect(result.legacy["phrase:make progress"].note).toContain("new note");
  expect(result.newEntitiesAfter).toEqual(result.newEntitiesBefore);
  expect(result.learningAfter).toEqual(result.learningBefore);
});

test("旧学习备份只导出 legacy Favorite snapshot", async ({ page }) => {
  const legacySnapshot = {
    "legacy-only": {
      word: "legacy-only",
      meaning: "只属于旧备份格式",
      mastered: true
    }
  };

  const created = await page.evaluate(snapshot => {
    const legacy = window.LingoFlowLegacyFavoriteBackup;
    legacy.replaceSnapshot(snapshot);
    const favorite = window.LingoFlowFavoriteRepository.create({
      type: "word",
      text: "current-only",
      meaning: "当前 Favorite Entity"
    });
    window.LingoFlowFavoriteLearningRepository.setMastered(favorite.id, true);
    return favorite;
  }, legacySnapshot);

  const downloadPromise = page.waitForEvent("download");
  await page.evaluate(() => exportLearningBackup());
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const backup = JSON.parse(Buffer.concat(chunks).toString("utf8"));

  expect(backup.favorites).toEqual(legacySnapshot);
  expect(backup).not.toHaveProperty("favoriteEntities");
  expect(backup).not.toHaveProperty("favoriteLearningStates");
  expect(JSON.stringify(backup)).not.toContain(created.id);
  expect(JSON.stringify(backup)).not.toContain("current-only");
  expect(await page.evaluate(() => ({
    legacy: window.LingoFlowLegacyFavoriteBackup.readSnapshot(),
    current: window.LingoFlowFavoriteRepository.list(),
    learning: window.LingoFlowFavoriteLearningRepository.list()
  }))).toMatchObject({
    legacy: legacySnapshot,
    current: [{ id: created.id, text: "current-only" }],
    learning: [{ favoriteId: created.id, mastered: true }]
  });
  expect(await page.evaluate(key => localStorage.getItem(key), LEGACY_FAVORITES_KEY))
    .toBe(JSON.stringify(legacySnapshot));
});
