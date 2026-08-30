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
  await page.addScriptTag({ url: "/js/history-baseline-backup-export.js" });
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

function makeHistoryBaseline(id, overrides = {}) {
  return {
    id,
    createdAt: "2026-08-28T01:02:03.004Z",
    deviceId: "device:baseline-export",
    records: {
      "legacy locator / Apple": {
        word: "apple",
        count: 2,
        displayWord: "Apple",
        dictionaryFound: true,
        futureCompatibility: {
          importedBy: "legacy-reader",
          flags: [true, false]
        }
      }
    },
    ...overrides
  };
}

test("HistoryBaseline Export 接受空集合", async ({ page }) => {
  const result = await page.evaluate(() => (
    window.LingoFlowHistoryBaselineBackupExport.exportHistoryBaselines()
  ));

  expect(result).toEqual({
    status: "ready",
    payload: { historyBaselines: [] }
  });
});

test("HistoryBaseline Export 保留 opaque ID、locator 与 unknown compatibility fields", async ({ page }) => {
  const baseline = makeHistoryBaseline("legacy-hash-that-must-not-be-recomputed", {
    records: {
      lemma: {
        word: "apple",
        count: 2,
        futureCompatibility: { label: "keep" }
      },
      "outer-key-not-normalized": {
        word: "banana",
        count: 1,
        source: "legacy-import"
      }
    },
    futureBaselineFact: { sourceVersion: 4 }
  });

  const result = await page.evaluate(async incoming => {
    const restored = window.LingoFlowHistoryBaselineRepository
      .restoreBackupRecords([incoming]);
    const exported = await window.LingoFlowHistoryBaselineBackupExport
      .exportHistoryBaselines();
    const validation = exported.payload
      ? window.LingoFlowHistoryBaselineBackupSchema
        .validateHistoryBaselines(exported.payload.historyBaselines)
      : null;
    return {
      restored,
      exported,
      validation,
      frozen: Object.isFrozen(window.LingoFlowHistoryBaselineBackupExport)
    };
  }, baseline);

  expect(result.restored.status).toBe("completed");
  expect(result.exported).toEqual({
    status: "ready",
    payload: { historyBaselines: [baseline] }
  });
  expect(Object.keys(result.exported.payload.historyBaselines[0].records)).toEqual([
    "lemma",
    "outer-key-not-normalized"
  ]);
  expect(result.validation?.status).toBe("valid");
  expect(result.frozen).toBe(true);
});

test("HistoryBaseline Export 不读取或导出 Vocab 与 Migration State", async ({ page }) => {
  const baseline = makeHistoryBaseline("baseline:export-boundary");

  const result = await page.evaluate(async incoming => {
    window.LingoFlowHistoryBaselineRepository.restoreBackupRecords([incoming]);
    localStorage.setItem("EnglishReaderV05Vocab", JSON.stringify({
      leaked: { word: "leaked", count: 99 }
    }));
    localStorage.setItem("EnglishReaderV052HistoryMigrationState", JSON.stringify({
      version: 1,
      status: "completed"
    }));
    return window.LingoFlowHistoryBaselineBackupExport.exportHistoryBaselines();
  }, baseline);

  expect(result).toEqual({
    status: "ready",
    payload: { historyBaselines: [baseline] }
  });
  expect(result.payload).not.toHaveProperty("vocab");
  expect(result.payload).not.toHaveProperty("migrationState");
});

test("HistoryBaseline Export 返回独立快照且不修改 Repository 或输入", async ({ page }) => {
  const baseline = makeHistoryBaseline("baseline:export-snapshot");

  const result = await page.evaluate(async incoming => {
    const repositoryValues = [incoming];
    const before = JSON.stringify(repositoryValues);
    window.LingoFlowHistoryBaselineRepository = Object.freeze({
      list: () => repositoryValues
    });

    const exported = await window.LingoFlowHistoryBaselineBackupExport
      .exportHistoryBaselines();
    const snapshot = structuredClone(exported);
    const afterExport = JSON.stringify(repositoryValues);
    exported.payload.historyBaselines[0].id = "changed";
    exported.payload.historyBaselines[0].records["legacy locator / Apple"].count = 99;

    return {
      snapshot,
      before,
      afterExport,
      repositoryValues
    };
  }, baseline);

  expect(result.snapshot).toEqual({
    status: "ready",
    payload: { historyBaselines: [baseline] }
  });
  expect(result.afterExport).toBe(result.before);
  expect(result.repositoryValues).toEqual([baseline]);
});

test("HistoryBaseline Export 在 Schema 拒绝时拒绝整批且不返回部分 payload", async ({ page }) => {
  const result = await page.evaluate(async valid => {
    window.LingoFlowHistoryBaselineRepository = Object.freeze({
      list: () => [valid, {
        ...valid,
        id: "baseline:invalid",
        records: { invalid: { word: "invalid", count: 0 } }
      }]
    });
    return window.LingoFlowHistoryBaselineBackupExport.exportHistoryBaselines();
  }, makeHistoryBaseline("baseline:valid-before-invalid"));

  expect(result).toEqual({ status: "rejected", payload: null });
});

test("HistoryBaseline Export 不把 strict storage read failure 解释为空集合", async ({ page }) => {
  const result = await page.evaluate(async () => {
    localStorage.setItem("EnglishReaderV052HistoryBaselines", "{malformed");
    return window.LingoFlowHistoryBaselineBackupExport.exportHistoryBaselines();
  });

  expect(result).toEqual({ status: "failed", payload: null });
});
