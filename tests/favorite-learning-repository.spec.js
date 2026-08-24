const { test, expect } = require("@playwright/test");

const LEARNING_STORAGE_PREFIX = "LingoFlowFavoriteLearningState:";
const FAVORITE_STORAGE_KEY = "LingoFlowFavoriteEntities";
const LEGACY_FAVORITE_STORAGE_KEY = "EnglishReaderV051Favorites";
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
  expect(await page.evaluate(() => typeof window.LingoFlowFavoriteLearningRepository)).toBe("object");
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

test("mastered 使用独立状态实体且不会修改 Favorite", async ({ page }) => {
  const result = await page.evaluate(({ favoriteKey, legacyKey, learningPrefix }) => {
    const favoriteRepository = window.LingoFlowFavoriteRepository;
    const learningRepository = window.LingoFlowFavoriteLearningRepository;
    const favorite = favoriteRepository.create({ type: "word", text: "independent" });
    const favoriteBefore = favoriteRepository.getById(favorite.id);
    const favoriteRawBefore = localStorage.getItem(favoriteKey);
    const legacyRaw = JSON.stringify({ independent: { mastered: true } });
    localStorage.setItem(legacyKey, legacyRaw);

    const state = learningRepository.setMastered(favorite.id, true);
    const favoriteAfter = favoriteRepository.getById(favorite.id);
    const learningRaw = localStorage.getItem(`${learningPrefix}${favorite.id}`);

    return {
      state,
      favoriteBefore,
      favoriteAfter,
      favoriteRawUnchanged: localStorage.getItem(favoriteKey) === favoriteRawBefore,
      legacyRawUnchanged: localStorage.getItem(legacyKey) === legacyRaw,
      stored: JSON.parse(learningRaw),
      frozen: Object.isFrozen(learningRepository),
      api: {
        get: typeof learningRepository.get,
        setMastered: typeof learningRepository.setMastered,
        remove: typeof learningRepository.remove,
        restore: typeof learningRepository.restore,
        list: typeof learningRepository.list,
        scheduleReview: typeof learningRepository.scheduleReview,
        setProgress: typeof learningRepository.setProgress,
        clear: typeof learningRepository.clear
      }
    };
  }, {
    favoriteKey: FAVORITE_STORAGE_KEY,
    legacyKey: LEGACY_FAVORITE_STORAGE_KEY,
    learningPrefix: LEARNING_STORAGE_PREFIX
  });

  expect(result.state).toEqual(result.stored);
  expect(Object.keys(result.state).sort()).toEqual([
    "createdAt",
    "deletedAt",
    "favoriteId",
    "mastered",
    "updatedAt"
  ]);
  expect(result.state.favoriteId).toBe(result.favoriteBefore.id);
  expect(result.state.mastered).toBe(true);
  expect(result.state.createdAt).toBe(result.state.updatedAt);
  expect(result.state.deletedAt).toBeNull();
  expect(result.favoriteAfter).toEqual(result.favoriteBefore);
  expect(result.favoriteAfter.mastered).toBeUndefined();
  expect(result.favoriteRawUnchanged).toBe(true);
  expect(result.legacyRawUnchanged).toBe(true);
  expect(result.frozen).toBe(true);
  expect(result.api).toEqual({
    get: "function",
    setMastered: "function",
    remove: "function",
    restore: "function",
    list: "function",
    scheduleReview: "undefined",
    setProgress: "undefined",
    clear: "undefined"
  });
});

test("setMastered 按 Favorite ID 隔离状态并保持幂等", async ({ page }) => {
  const result = await page.evaluate(learningPrefix => {
    const repository = window.LingoFlowFavoriteLearningRepository;
    const favoriteRepository = window.LingoFlowFavoriteRepository;
    const firstId = favoriteRepository.create({ type: "word", text: "same content" }).id;
    const secondId = favoriteRepository.create({ type: "word", text: "same content" }).id;
    const missing = repository.get(firstId);
    const first = repository.setMastered(firstId, true);
    const rawAfterFirst = localStorage.getItem(`${learningPrefix}${firstId}`);
    const unchanged = repository.setMastered(firstId, true);
    const rawAfterUnchanged = localStorage.getItem(`${learningPrefix}${firstId}`);
    const updated = repository.setMastered(firstId, false);
    const second = repository.setMastered(secondId, true);

    first.mastered = false;
    updated.mastered = true;
    const persisted = repository.get(firstId);

    return {
      missing,
      first,
      unchanged,
      updated,
      second,
      persisted,
      firstId,
      secondId,
      rawUnchangedByNoop: rawAfterFirst === rawAfterUnchanged,
      listed: repository.list()
    };
  }, LEARNING_STORAGE_PREFIX);

  expect(result.missing).toBeNull();
  expect(result.rawUnchangedByNoop).toBe(true);
  expect(result.unchanged.updatedAt).toBe(result.first.updatedAt);
  expect(result.updated.favoriteId).toBe(result.first.favoriteId);
  expect(result.updated.createdAt).toBe(result.first.createdAt);
  expect(Date.parse(result.updated.updatedAt)).toBeGreaterThan(Date.parse(result.first.updatedAt));
  expect(result.persisted.mastered).toBe(false);
  expect(result.second.mastered).toBe(true);
  expect(result.firstId).not.toBe(result.secondId);
  expect(result.listed.map(state => state.favoriteId).sort()).toEqual(
    [result.firstId, result.secondId].sort()
  );
});

test("Favorite 的软删除和恢复不会级联修改 Learning State", async ({ page }) => {
  const result = await page.evaluate(learningPrefix => {
    const favoriteRepository = window.LingoFlowFavoriteRepository;
    const learningRepository = window.LingoFlowFavoriteLearningRepository;
    const favorite = favoriteRepository.create({ type: "word", text: "lifecycle separation" });
    const state = learningRepository.setMastered(favorite.id, true);
    const rawBeforeFavoriteDelete = localStorage.getItem(`${learningPrefix}${favorite.id}`);

    const deletedFavorite = favoriteRepository.softDelete(favorite.id);
    const stateWhileFavoriteDeleted = learningRepository.get(favorite.id);
    const rawAfterFavoriteDelete = localStorage.getItem(`${learningPrefix}${favorite.id}`);
    const restoredFavorite = favoriteRepository.restore(favorite.id);
    const stateAfterFavoriteRestore = learningRepository.get(favorite.id);

    return {
      favorite,
      deletedFavorite,
      restoredFavorite,
      state,
      stateWhileFavoriteDeleted,
      stateAfterFavoriteRestore,
      rawDeleteUnchanged: rawAfterFavoriteDelete === rawBeforeFavoriteDelete,
      rawRestoreUnchanged:
        localStorage.getItem(`${learningPrefix}${favorite.id}`) === rawBeforeFavoriteDelete
    };
  }, LEARNING_STORAGE_PREFIX);

  expect(result.deletedFavorite.deletedAt).not.toBeNull();
  expect(result.restoredFavorite.id).toBe(result.favorite.id);
  expect(result.stateWhileFavoriteDeleted).toEqual(result.state);
  expect(result.stateAfterFavoriteRestore).toEqual(result.state);
  expect(result.rawDeleteUnchanged).toBe(true);
  expect(result.rawRestoreUnchanged).toBe(true);
});

test("remove 使用 soft delete，restore 保留原关联和创建时间", async ({ page }) => {
  const result = await page.evaluate(learningPrefix => {
    const repository = window.LingoFlowFavoriteLearningRepository;
    const favoriteId = "favorite:learning-lifecycle";
    const created = repository.setMastered(favoriteId, true);
    const removed = repository.remove(favoriteId);
    const rawAfterRemove = localStorage.getItem(`${learningPrefix}${favoriteId}`);
    const removedAgain = repository.remove(favoriteId);
    const rawAfterRemoveAgain = localStorage.getItem(`${learningPrefix}${favoriteId}`);
    let updateError = "";
    try {
      repository.setMastered(favoriteId, false);
    } catch (error) {
      updateError = error.message;
    }
    const rawAfterRejectedUpdate = localStorage.getItem(`${learningPrefix}${favoriteId}`);
    const restored = repository.restore(favoriteId);
    const rawAfterRestore = localStorage.getItem(`${learningPrefix}${favoriteId}`);
    const restoredAgain = repository.restore(favoriteId);

    return {
      created,
      removed,
      removedAgain,
      restored,
      restoredAgain,
      updateError,
      hidden: repository.get(favoriteId),
      active: repository.get(favoriteId, { includeDeleted: false }),
      all: repository.list({ includeDeleted: true }),
      rawRemoveIdempotent: rawAfterRemove === rawAfterRemoveAgain,
      rawRejectedUpdateUnchanged: rawAfterRemove === rawAfterRejectedUpdate,
      rawRestoreIdempotent: rawAfterRestore === localStorage.getItem(`${learningPrefix}${favoriteId}`)
    };
  }, LEARNING_STORAGE_PREFIX);

  expect(result.removed.favoriteId).toBe(result.created.favoriteId);
  expect(result.removed.createdAt).toBe(result.created.createdAt);
  expect(result.removed.mastered).toBe(true);
  expect(result.removed.deletedAt).toBe(result.removed.updatedAt);
  expect(result.removedAgain.deletedAt).toBe(result.removed.deletedAt);
  expect(result.updateError).toContain("必须先恢复");
  expect(result.restored.favoriteId).toBe(result.created.favoriteId);
  expect(result.restored.createdAt).toBe(result.created.createdAt);
  expect(result.restored.mastered).toBe(true);
  expect(result.restored.deletedAt).toBeNull();
  expect(Date.parse(result.restored.updatedAt)).toBeGreaterThan(Date.parse(result.removed.updatedAt));
  expect(result.restoredAgain.updatedAt).toBe(result.restored.updatedAt);
  expect(result.hidden).toEqual(result.restored);
  expect(result.active).toEqual(result.restored);
  expect(result.all).toEqual([result.restored]);
  expect(result.rawRemoveIdempotent).toBe(true);
  expect(result.rawRejectedUpdateUnchanged).toBe(true);
  expect(result.rawRestoreIdempotent).toBe(true);
});

test("soft-deleted Learning State 默认从 get 和 list 隐藏", async ({ page }) => {
  const result = await page.evaluate(() => {
    const repository = window.LingoFlowFavoriteLearningRepository;
    const favoriteId = "favorite:hidden-learning";
    repository.setMastered(favoriteId, false);
    const removed = repository.remove(favoriteId);

    return {
      removed,
      getDefault: repository.get(favoriteId),
      getDeleted: repository.get(favoriteId, { includeDeleted: true }),
      listDefault: repository.list(),
      listDeleted: repository.list({ deletedOnly: true }),
      listAll: repository.list({ includeDeleted: true })
    };
  });

  expect(result.getDefault).toBeNull();
  expect(result.getDeleted).toEqual(result.removed);
  expect(result.listDefault).toEqual([]);
  expect(result.listDeleted).toEqual([result.removed]);
  expect(result.listAll).toEqual([result.removed]);
});

test("无效输入和损坏存储不会被静默写回", async ({ page }) => {
  const result = await page.evaluate(learningPrefix => {
    const repository = window.LingoFlowFavoriteLearningRepository;
    const favoriteId = "favorite:corrupted-learning";
    const storageKey = `${learningPrefix}${favoriteId}`;
    const errors = [];

    for (const [id, value] of [
      ["", true],
      [" favorite:space", true],
      [favoriteId, 1],
      [favoriteId, "true"]
    ]) {
      try {
        repository.setMastered(id, value);
        errors.push("");
      } catch (error) {
        errors.push(error.message);
      }
    }

    let toStringCalls = 0;
    const objectId = {
      toString() {
        toStringCalls += 1;
        return favoriteId;
      }
    };
    const objectGet = repository.get(objectId);

    const corrupted = "{not valid json";
    localStorage.setItem(storageKey, corrupted);
    let getError = "";
    let listError = "";
    let setError = "";
    try { repository.get(favoriteId); } catch (error) { getError = error.message; }
    try { repository.list(); } catch (error) { listError = error.message; }
    try { repository.setMastered(favoriteId, true); } catch (error) { setError = error.message; }

    return {
      errors,
      toStringCalls,
      objectGet,
      getError,
      listError,
      setError,
      rawUnchanged: localStorage.getItem(storageKey) === corrupted
    };
  }, LEARNING_STORAGE_PREFIX);

  expect(result.errors.every(Boolean)).toBe(true);
  expect(result.toStringCalls).toBe(0);
  expect(result.objectGet).toBeNull();
  expect(result.getError).toContain("损坏");
  expect(result.listError).toContain("损坏");
  expect(result.setError).toContain("损坏");
  expect(result.rawUnchanged).toBe(true);
});

test("Learning State 在页面刷新后保持独立持久化", async ({ page }) => {
  const favoriteId = "favorite:reload-learning";
  const beforeReload = await page.evaluate(id => (
    window.LingoFlowFavoriteLearningRepository.setMastered(id, true)
  ), favoriteId);

  await page.reload();
  await expect(page.locator("#inputText")).toBeVisible();
  expect(await page.evaluate(() => typeof window.LingoFlowFavoriteLearningRepository)).toBe("object");

  const afterReload = await page.evaluate(id => (
    window.LingoFlowFavoriteLearningRepository.get(id)
  ), favoriteId);

  expect(afterReload).toEqual(beforeReload);
});
