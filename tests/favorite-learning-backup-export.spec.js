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
  await expect(page.locator("#inputText")).toBeVisible();
  await page.addScriptTag({ url: "/js/favorite-learning-backup-schema.js" });
  await page.addScriptTag({ url: "/js/favorite-learning-backup-export.js" });
  expect(await page.evaluate(() => (
    typeof window.LingoFlowFavoriteLearningBackupExport
  ))).toBe("object");
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

function makeState(favoriteId, overrides = {}) {
  return {
    favoriteId,
    mastered: false,
    createdAt: "2026-08-24T01:00:00.000Z",
    updatedAt: "2026-08-24T02:00:00.000Z",
    deletedAt: null,
    ...overrides
  };
}

test("Learning Export 导出 active 与 tombstone，并保留 mastered true/false 和生命周期", async ({ page }) => {
  const states = [
    makeState("favorite:learning-export-false"),
    makeState("favorite:learning-export-true", { mastered: true }),
    makeState("favorite:learning-export-deleted", {
      mastered: true,
      updatedAt: "2026-08-24T04:00:00.000Z",
      deletedAt: "2026-08-24T03:00:00.000Z"
    })
  ];
  const expectedStates = [...states]
    .sort((left, right) => left.favoriteId.localeCompare(right.favoriteId));
  const result = await page.evaluate(async incoming => {
    const repository = window.LingoFlowFavoriteLearningRepository;
    const restore = repository.restoreBackupRecords(incoming);
    const exported = await window.LingoFlowFavoriteLearningBackupExport
      .exportFavoriteLearningStates();
    const validation = exported.payload
      ? window.LingoFlowFavoriteLearningBackupSchema
        .validateFavoriteLearningStates(exported.payload.favoriteLearningStates)
      : null;
    return { restore, exported, validation };
  }, states);

  expect(result.restore.status).toBe("completed");
  expect(result.exported).toEqual({
    status: "ready",
    payload: { favoriteLearningStates: expectedStates }
  });
  expect(result.validation?.status).toBe("valid");
});

test("Learning Export 接受空集合", async ({ page }) => {
  const result = await page.evaluate(() => (
    window.LingoFlowFavoriteLearningBackupExport.exportFavoriteLearningStates()
  ));

  expect(result).toEqual({
    status: "ready",
    payload: { favoriteLearningStates: [] }
  });
});

test("Learning Export 使用 includeDeleted:true，并在 Schema 拒绝时不返回 payload", async ({ page }) => {
  const result = await page.evaluate(async incoming => {
    let listOptions = null;
    window.LingoFlowFavoriteLearningRepository = Object.freeze({
      list: options => {
        listOptions = options;
        return [{ ...incoming, mastered: "true" }];
      }
    });

    return {
      exported: await window.LingoFlowFavoriteLearningBackupExport
        .exportFavoriteLearningStates(),
      listOptions
    };
  }, makeState("favorite:learning-export-invalid"));

  expect(result.listOptions).toEqual({ includeDeleted: true });
  expect(result.exported).toEqual({ status: "rejected", payload: null });
});

test("Learning Export 不修改记录，也不生成身份或生命周期字段", async ({ page }) => {
  const state = makeState("favorite:learning-export-read-only", {
    mastered: true,
    createdAt: "2026-08-23T10:00:00.000Z",
    updatedAt: "2026-08-24T10:00:00.000Z"
  });
  const result = await page.evaluate(async incoming => {
    const repository = window.LingoFlowFavoriteLearningRepository;
    repository.restoreBackupRecords([incoming]);
    const before = repository.get(incoming.favoriteId, { includeDeleted: true });
    const exported = await window.LingoFlowFavoriteLearningBackupExport
      .exportFavoriteLearningStates();
    exported.payload.favoriteLearningStates[0].mastered = false;
    exported.payload.favoriteLearningStates[0].updatedAt = "2026-08-25T10:00:00.000Z";
    const after = repository.get(incoming.favoriteId, { includeDeleted: true });
    return {
      before,
      after,
      exportedKeys: Object.keys(exported.payload.favoriteLearningStates[0]).sort(),
      frozen: Object.isFrozen(window.LingoFlowFavoriteLearningBackupExport)
    };
  }, state);

  expect(result.before).toEqual(state);
  expect(result.after).toEqual(state);
  expect(result.exportedKeys).toEqual([
    "createdAt",
    "deletedAt",
    "favoriteId",
    "mastered",
    "updatedAt"
  ]);
  expect(result.frozen).toBe(true);
});

test("Learning Export 在 Repository 读取异常时返回 failed", async ({ page }) => {
  const result = await page.evaluate(async () => {
    window.LingoFlowFavoriteLearningRepository = Object.freeze({
      list: () => {
        throw new Error("Learning State read failed");
      }
    });
    return window.LingoFlowFavoriteLearningBackupExport.exportFavoriteLearningStates();
  });

  expect(result).toEqual({ status: "failed", payload: null });
});
