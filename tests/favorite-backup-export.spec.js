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
  await page.addScriptTag({ url: "/js/favorite-backup-schema.js" });
  await page.addScriptTag({ url: "/js/favorite-backup-export.js" });
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

function makeFavorite(id, overrides = {}) {
  return {
    id,
    type: "word",
    text: "resilient",
    createdAt: "2026-08-24T01:00:00.000Z",
    updatedAt: "2026-08-24T02:00:00.000Z",
    deletedAt: null,
    ...overrides
  };
}

test("Favorite Backup Export 导出活动 Favorite 并保留完整字段", async ({ page }) => {
  const favorite = makeFavorite("favorite:export-active", {
    displayText: "Resilient",
    meaning: "有韧性的",
    tags: ["backup", "favorite"],
    origin: {
      kind: "article",
      articleId: "article:export-source",
      articleTitleSnapshot: "Export source"
    }
  });

  const result = await page.evaluate(async incoming => {
    const restored = window.LingoFlowFavoriteRepository.restoreBackupRecords([incoming]);
    const exported = await window.LingoFlowFavoriteBackupExport.exportFavorites();
    const validation = exported.payload
      ? window.LingoFlowFavoriteBackupSchema.validateFavorites(exported.payload.favorites)
      : null;
    return {
      restored,
      exported,
      validation,
      frozen: Object.isFrozen(window.LingoFlowFavoriteBackupExport)
    };
  }, favorite);

  expect(result.restored.status).toBe("completed");
  expect(result.exported).toEqual({
    status: "ready",
    payload: { favorites: [favorite] }
  });
  expect(result.validation?.status).toBe("valid");
  expect(result.frozen).toBe(true);
});

test("Favorite Backup Export 包含软删除 tombstone", async ({ page }) => {
  const active = makeFavorite("favorite:export-active-record");
  const deleted = makeFavorite("favorite:export-deleted", {
    type: "phrase",
    text: "in the long run",
    createdAt: "2026-08-24T03:00:00.000Z",
    updatedAt: "2026-08-24T05:00:00.000Z",
    deletedAt: "2026-08-24T05:00:00.000Z"
  });

  const result = await page.evaluate(async incoming => {
    window.LingoFlowFavoriteRepository.restoreBackupRecords(incoming);
    return window.LingoFlowFavoriteBackupExport.exportFavorites();
  }, [active, deleted]);

  expect(result.status).toBe("ready");
  expect(result.payload.favorites).toHaveLength(2);
  expect(result.payload.favorites).toEqual(expect.arrayContaining([active, deleted]));
  expect(result.payload.favorites.find(item => item.id === deleted.id)?.deletedAt)
    .toBe(deleted.deletedAt);
});

test("Favorite Backup Export 接受空集合", async ({ page }) => {
  const result = await page.evaluate(() => (
    window.LingoFlowFavoriteBackupExport.exportFavorites()
  ));

  expect(result).toEqual({
    status: "ready",
    payload: { favorites: [] }
  });
});

test("Favorite Backup Export 使用 includeDeleted 读取并在 Schema 失败时拒绝整个集合", async ({ page }) => {
  const result = await page.evaluate(async () => {
    let listOptions = null;
    let validationInput = null;
    const invalidFavorites = [{ id: "favorite:invalid-export" }];

    window.LingoFlowFavoriteRepository = Object.freeze({
      list: options => {
        listOptions = options;
        return invalidFavorites;
      }
    });
    window.LingoFlowFavoriteBackupSchema = Object.freeze({
      validateFavorites: favorites => {
        validationInput = favorites;
        return { status: "rejected", favorites: [] };
      }
    });

    return {
      exported: await window.LingoFlowFavoriteBackupExport.exportFavorites(),
      listOptions,
      schemaReceivedRepositoryResult: validationInput === invalidFavorites
    };
  });

  expect(result).toEqual({
    exported: { status: "rejected", payload: null },
    listOptions: { includeDeleted: true },
    schemaReceivedRepositoryResult: true
  });
});

test("Favorite Backup Export 保留合法 unknown fields 且不修改存储数据", async ({ page }) => {
  const favorite = makeFavorite("favorite:export-unknown", {
    futureAsset: {
      label: "keep me",
      flags: [true, false],
      nested: { count: 2 }
    }
  });

  const result = await page.evaluate(async incoming => {
    const repository = window.LingoFlowFavoriteRepository;
    repository.restoreBackupRecords([incoming]);
    const before = localStorage.getItem("LingoFlowFavoriteEntities");
    const exported = await window.LingoFlowFavoriteBackupExport.exportFavorites();
    const exportedBeforeMutation = structuredClone(exported);
    const afterExport = localStorage.getItem("LingoFlowFavoriteEntities");

    exported.payload.favorites[0].futureAsset.nested.count = 99;
    exported.payload.favorites[0].text = "mutated payload";

    return {
      exportedBeforeMutation,
      before,
      afterExport,
      storedAfterPayloadMutation: repository.getById(incoming.id, { includeDeleted: true })
    };
  }, favorite);

  expect(result.exportedBeforeMutation).toEqual({
    status: "ready",
    payload: { favorites: [favorite] }
  });
  expect(result.afterExport).toBe(result.before);
  expect(result.storedAfterPayloadMutation).toEqual(favorite);
});

test("Favorite Backup Export 在 Repository 读取失败时返回 failed", async ({ page }) => {
  const result = await page.evaluate(async () => {
    window.LingoFlowFavoriteRepository = Object.freeze({
      list: () => {
        throw new Error("Favorite read failed");
      }
    });
    return window.LingoFlowFavoriteBackupExport.exportFavorites();
  });

  expect(result).toEqual({ status: "failed", payload: null });
});
