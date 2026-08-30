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
  await page.addScriptTag({ url: "/js/query-event-backup-export.js" });
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

function makeQueryEvent(id, overrides = {}) {
  return {
    id,
    deviceId: "device:query-export",
    word: "resilient",
    displayWord: "Resilient",
    phonetic: "/rɪˈzɪliənt/",
    pos: "adj.",
    meaning: "有韧性的",
    dictionaryFound: true,
    source: "article",
    timestamp: "2026-08-28T01:02:03.004Z",
    ...overrides
  };
}

test("QueryEvent Export 接受空 current-set", async ({ page }) => {
  const result = await page.evaluate(() => (
    window.LingoFlowQueryEventBackupExport.exportQueryEvents()
  ));

  expect(result).toEqual({
    status: "ready",
    payload: { queryEvents: [] }
  });
});

test("QueryEvent Export 原样保留稳定身份、设备、时间、空 word 与 unknown fields", async ({ page }) => {
  const events = [
    makeQueryEvent("query:export-standard", {
      futureEventFact: {
        channel: "reader",
        flags: [true, false]
      }
    }),
    makeQueryEvent("query:export-empty-word", {
      word: "",
      displayWord: "中文",
      phonetic: "",
      pos: "",
      meaning: "",
      dictionaryFound: false,
      source: "search",
      timestamp: "2026-08-28T02:03:04.005Z"
    })
  ];

  const result = await page.evaluate(async incoming => {
    const restored = window.LingoFlowQueryEventRepository.restoreBackupRecords(incoming);
    const exported = await window.LingoFlowQueryEventBackupExport.exportQueryEvents();
    const validation = exported.payload
      ? window.LingoFlowQueryEventBackupSchema
        .validateQueryEvents(exported.payload.queryEvents)
      : null;
    return {
      restored,
      exported,
      validation,
      frozen: Object.isFrozen(window.LingoFlowQueryEventBackupExport)
    };
  }, events);

  expect(result.restored.status).toBe("completed");
  expect(result.exported).toEqual({
    status: "ready",
    payload: { queryEvents: events }
  });
  expect(result.validation?.status).toBe("valid");
  expect(result.frozen).toBe(true);
});

test("QueryEvent Export 只导出 current-set，hard delete 后不再导出事件", async ({ page }) => {
  const retained = makeQueryEvent("query:export-retained");
  const removed = makeQueryEvent("query:export-hard-deleted", {
    timestamp: "2026-08-28T03:04:05.006Z"
  });

  const result = await page.evaluate(async incoming => {
    const repository = window.LingoFlowQueryEventRepository;
    repository.restoreBackupRecords(incoming);
    repository.removeById(incoming[1].id);
    return window.LingoFlowQueryEventBackupExport.exportQueryEvents();
  }, [retained, removed]);

  expect(result).toEqual({
    status: "ready",
    payload: { queryEvents: [retained] }
  });
});

test("QueryEvent Export 返回独立快照且不修改 Repository 或输入", async ({ page }) => {
  const event = makeQueryEvent("query:export-snapshot", {
    futureEventFact: { nested: { value: 1 } }
  });

  const result = await page.evaluate(async incoming => {
    const repositoryValues = [incoming];
    const before = JSON.stringify(repositoryValues);
    window.LingoFlowQueryEventRepository = Object.freeze({
      list: () => repositoryValues
    });

    const exported = await window.LingoFlowQueryEventBackupExport.exportQueryEvents();
    const snapshot = structuredClone(exported);
    const afterExport = JSON.stringify(repositoryValues);
    exported.payload.queryEvents[0].word = "changed";
    exported.payload.queryEvents[0].futureEventFact.nested.value = 99;

    return {
      snapshot,
      before,
      afterExport,
      repositoryValues
    };
  }, event);

  expect(result.snapshot).toEqual({
    status: "ready",
    payload: { queryEvents: [event] }
  });
  expect(result.afterExport).toBe(result.before);
  expect(result.repositoryValues).toEqual([event]);
});

test("QueryEvent Export 在 Schema 拒绝时拒绝整批且不返回部分 payload", async ({ page }) => {
  const result = await page.evaluate(async valid => {
    window.LingoFlowQueryEventRepository = Object.freeze({
      list: () => [valid, { ...valid, id: "query:invalid", timestamp: 0 }]
    });
    return window.LingoFlowQueryEventBackupExport.exportQueryEvents();
  }, makeQueryEvent("query:valid-before-invalid"));

  expect(result).toEqual({ status: "rejected", payload: null });
});

test("QueryEvent Export 不把 strict storage read failure 解释为空集合", async ({ page }) => {
  const result = await page.evaluate(async () => {
    localStorage.setItem("EnglishReaderV052QueryEvents", "{malformed");
    return window.LingoFlowQueryEventBackupExport.exportQueryEvents();
  });

  expect(result).toEqual({ status: "failed", payload: null });
});
