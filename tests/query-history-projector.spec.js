const { test, expect } = require("@playwright/test");

const projectErrors = new WeakMap();

function makeEvent(id, overrides = {}) {
  return {
    id,
    deviceId: "device:source",
    word: "apple",
    displayWord: "Apple",
    phonetic: "/ˈæpəl/",
    pos: "noun",
    meaning: "苹果",
    dictionaryFound: true,
    source: "article",
    timestamp: "2026-08-24T10:00:00.000Z",
    ...overrides
  };
}

function makeBaseline(id, overrides = {}) {
  return {
    id,
    createdAt: "2026-08-24T09:00:00.000Z",
    deviceId: "legacy-source",
    records: {
      "opaque-locator": {
        word: "apple",
        count: 3,
        articleCount: 1,
        searchCount: 1,
        firstSeen: "2020-01-01T00:00:00.000Z",
        lastSeen: "2020-01-03T00:00:00.000Z",
        displayWord: "Legacy Apple",
        meaning: "旧苹果",
        dictionaryFound: true,
        source: "legacy"
      }
    },
    ...overrides
  };
}

test.beforeEach(async ({ page }) => {
  const errors = [];
  projectErrors.set(page, errors);
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
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
  await page.addScriptTag({ url: "/js/query-history-projector.js" });
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

test("Projector API 冻结，两个空事实集合投影为空 vocab map", async ({ page }) => {
  const result = await page.evaluate(() => {
    const projector = window.LingoFlowQueryHistoryProjector;
    return {
      frozen: Object.isFrozen(projector),
      projectType: typeof projector.project,
      vocab: projector.project([], []),
      keys: Object.keys(projector.project([], [])),
      invalid: [
        () => projector.project({}, []),
        () => projector.project([], null)
      ].map(run => {
        try {
          run();
          return null;
        } catch (error) {
          return error.name;
        }
      })
    };
  });

  expect(result).toEqual({
    frozen: true,
    projectType: "function",
    vocab: {},
    keys: [],
    invalid: ["TypeError", "TypeError"]
  });
});

test("单个与多个 QueryEvent 按 article/search 聚合，空 word 事件不进入 Vocab", async ({ page }) => {
  const events = [
    makeEvent("query:article"),
    makeEvent("query:search", {
      source: "search",
      timestamp: "2026-08-24T10:01:00.000Z"
    }),
    makeEvent("query:no-aggregation-key", {
      word: "",
      displayWord: "中文",
      source: "search",
      timestamp: "2026-08-24T10:02:00.000Z"
    })
  ];
  const result = await page.evaluate(incoming => (
    window.LingoFlowQueryHistoryProjector.project(incoming, [])
  ), events);

  expect(Object.keys(result)).toEqual(["apple"]);
  expect(result.apple).toMatchObject({
    word: "apple",
    count: 2,
    articleCount: 1,
    searchCount: 1,
    firstSeen: events[0].timestamp,
    lastSeen: events[1].timestamp,
    source: "search"
  });
});

test("QueryEvent 无论输入顺序都按 timestamp/id 处理并确定 snapshot 胜者", async ({ page }) => {
  const events = [
    makeEvent("query:z", {
      displayWord: "Tie Z",
      meaning: "同时间较大 ID",
      source: "search",
      timestamp: "2026-08-24T10:02:00.000Z"
    }),
    makeEvent("query:early", {
      displayWord: "Early",
      meaning: "早期",
      timestamp: "2026-08-24T10:00:00.000Z"
    }),
    makeEvent("query:a", {
      displayWord: "Tie A",
      meaning: "同时间较小 ID",
      timestamp: "2026-08-24T10:02:00.000Z"
    })
  ];
  const result = await page.evaluate(incoming => {
    const projector = window.LingoFlowQueryHistoryProjector;
    return {
      projected: projector.project(incoming, []),
      reversed: projector.project(incoming.slice().reverse(), [])
    };
  }, events);

  expect(result.projected).toEqual(result.reversed);
  expect(result.projected.apple).toMatchObject({
    count: 3,
    firstSeen: "2026-08-24T10:00:00.000Z",
    lastSeen: "2026-08-24T10:02:00.000Z",
    displayWord: "Tie Z",
    meaning: "同时间较大 ID",
    source: "search"
  });
});

test("snapshot 使用最后一个非空文本，但 dictionaryFound:false 是有效最新事实", async ({ page }) => {
  const events = [
    makeEvent("query:first", {
      phonetic: "/first/",
      pos: "noun",
      meaning: "有内容",
      dictionaryFound: true
    }),
    makeEvent("query:last", {
      displayWord: "APPLE",
      phonetic: "",
      pos: "",
      meaning: "",
      dictionaryFound: false,
      source: "search",
      timestamp: "2026-08-24T11:00:00.000Z"
    })
  ];
  const result = await page.evaluate(incoming => (
    window.LingoFlowQueryHistoryProjector.project(incoming, [])
  ), events);

  expect(result.apple).toMatchObject({
    displayWord: "APPLE",
    phonetic: "/first/",
    pos: "noun",
    meaning: "有内容",
    dictionaryFound: false,
    source: "search"
  });
});

test("最小 Baseline compatibility record 投影计数且不虚构缺失时间或 snapshot", async ({ page }) => {
  const baseline = makeBaseline("baseline:minimal", {
    records: {
      "locator-not-word": { word: "banana", count: 4, source: "article" },
      "first-only": {
        word: "cherry",
        count: 2,
        firstSeen: "2020-01-01T00:00:00.000Z"
      },
      "last-only": {
        word: "date",
        count: 3,
        lastSeen: "2020-01-02T00:00:00.000Z"
      }
    }
  });
  const result = await page.evaluate(incoming => (
    window.LingoFlowQueryHistoryProjector.project([], [incoming])
  ), baseline);

  expect(result.banana).toEqual({
    word: "banana",
    count: 4,
    articleCount: 0,
    searchCount: 0,
    source: "article"
  });
  expect(result.banana).not.toHaveProperty("firstSeen");
  expect(result.banana).not.toHaveProperty("lastSeen");
  expect(result.cherry).toMatchObject({
    firstSeen: "2020-01-01T00:00:00.000Z"
  });
  expect(result.cherry).not.toHaveProperty("lastSeen");
  expect(result.date).toMatchObject({
    lastSeen: "2020-01-02T00:00:00.000Z"
  });
  expect(result.date).not.toHaveProperty("firstSeen");
});

test("单个 Baseline 按 record.word 聚合，不把 opaque locator 当 Vocab key", async ({ page }) => {
  const baseline = makeBaseline("baseline:locator", {
    records: {
      "legacy-key-123": {
        word: "apple",
        count: 5,
        articleCount: 2,
        searchCount: 1,
        firstSeen: "2020-01-01T00:00:00.000Z",
        lastSeen: "2020-01-02T00:00:00.000Z"
      }
    }
  });
  const result = await page.evaluate(incoming => (
    window.LingoFlowQueryHistoryProjector.project([], [incoming])
  ), baseline);

  expect(Object.keys(result)).toEqual(["apple"]);
  expect(result).not.toHaveProperty("legacy-key-123");
  expect(result.apple).toMatchObject({
    count: 5,
    articleCount: 2,
    searchCount: 1
  });
});

test("多个 Baseline 按 createdAt/id/locator 决定 snapshot，且不同 ID 相同事实不去重", async ({ page }) => {
  const baselines = [
    makeBaseline("baseline:z", {
      createdAt: "2026-08-24T09:00:00.000Z",
      records: {
        "locator-z": {
          word: "apple",
          count: 2,
          displayWord: "From Z",
          meaning: "Z snapshot"
        }
      }
    }),
    makeBaseline("baseline:a", {
      createdAt: "2026-08-24T09:00:00.000Z",
      records: {
        "locator-b": {
          word: "apple",
          count: 2,
          displayWord: "A locator B",
          meaning: "A/B snapshot"
        },
        "locator-a": {
          word: "apple",
          count: 2,
          displayWord: "A locator A",
          meaning: "A/A snapshot"
        }
      }
    })
  ];
  const result = await page.evaluate(incoming => {
    const projector = window.LingoFlowQueryHistoryProjector;
    const withReversedRecordInsertion = incoming.map(baseline => ({
      ...baseline,
      records: Object.fromEntries(Object.entries(baseline.records).reverse())
    }));
    const baselineA = incoming.find(baseline => baseline.id === "baseline:a");
    const baselineAReversed = withReversedRecordInsertion.find(
      baseline => baseline.id === "baseline:a"
    );
    return {
      forward: projector.project([], incoming),
      reverse: projector.project([], incoming.slice().reverse()),
      reversedRecords: projector.project([], withReversedRecordInsertion),
      forwardJson: JSON.stringify(projector.project([], incoming)),
      reversedRecordsJson: JSON.stringify(
        projector.project([], withReversedRecordInsertion)
      ),
      aOnly: projector.project([], [baselineA]),
      aOnlyReversed: projector.project([], [baselineAReversed]),
      aOnlyJson: JSON.stringify(projector.project([], [baselineA])),
      aOnlyReversedJson: JSON.stringify(projector.project([], [baselineAReversed]))
    };
  }, baselines);

  expect(result.forward).toEqual(result.reverse);
  expect(result.forward).toEqual(result.reversedRecords);
  expect(result.forwardJson).toBe(result.reversedRecordsJson);
  expect(result.aOnly).toEqual(result.aOnlyReversed);
  expect(result.aOnlyJson).toBe(result.aOnlyReversedJson);
  expect(result.aOnly.apple).toMatchObject({
    count: 4,
    displayWord: "A locator B",
    meaning: "A/B snapshot"
  });
  expect(result.forward.apple).toMatchObject({
    count: 6,
    displayWord: "From Z",
    meaning: "Z snapshot"
  });
});

test("QueryEvent + Baseline 混合投影累加事实，事件 snapshot 在 Baseline 后应用", async ({ page }) => {
  const baseline = makeBaseline("baseline:mixed");
  const events = [
    makeEvent("query:mixed-article", {
      timestamp: "2021-01-01T00:00:00.000Z",
      displayWord: "Modern Apple",
      meaning: "现代快照"
    }),
    makeEvent("query:mixed-search", {
      source: "search",
      timestamp: "2021-01-04T00:00:00.000Z",
      displayWord: "Latest Apple",
      meaning: "最新快照"
    })
  ];
  const result = await page.evaluate(({ queryEvents, historyBaselines }) => (
    window.LingoFlowQueryHistoryProjector.project(queryEvents, historyBaselines)
  ), { queryEvents: events, historyBaselines: [baseline] });

  expect(result.apple).toMatchObject({
    count: 5,
    articleCount: 2,
    searchCount: 2,
    firstSeen: "2020-01-01T00:00:00.000Z",
    lastSeen: "2021-01-04T00:00:00.000Z",
    displayWord: "Latest Apple",
    meaning: "最新快照",
    source: "search"
  });
});

test("数组乱序不影响结果，输出 word key 与 JSON 字段顺序固定", async ({ page }) => {
  const events = [
    makeEvent("query:pear", { word: "pear", displayWord: "Pear" }),
    makeEvent("query:apple", { word: "apple", displayWord: "Apple" }),
    makeEvent("query:banana", { word: "banana", displayWord: "Banana" })
  ];
  const result = await page.evaluate(incoming => {
    const projector = window.LingoFlowQueryHistoryProjector;
    const first = projector.project(incoming, []);
    const second = projector.project([incoming[2], incoming[0], incoming[1]], []);
    return {
      first,
      second,
      firstJson: JSON.stringify(first),
      secondJson: JSON.stringify(second),
      words: Object.keys(first),
      fields: Object.keys(first.apple)
    };
  }, events);

  expect(result.first).toEqual(result.second);
  expect(result.firstJson).toBe(result.secondJson);
  expect(result.words).toEqual(["apple", "banana", "pear"]);
  expect(result.fields).toEqual([
    "word",
    "count",
    "articleCount",
    "searchCount",
    "firstSeen",
    "lastSeen",
    "displayWord",
    "phonetic",
    "pos",
    "meaning",
    "dictionaryFound",
    "source"
  ]);
});

test("__proto__ word 作为普通 Vocab key 安全输出", async ({ page }) => {
  const event = makeEvent("query:proto", {
    word: "__proto__",
    displayWord: "__proto__"
  });
  const result = await page.evaluate(incoming => {
    const vocab = window.LingoFlowQueryHistoryProjector.project([incoming], []);
    return {
      nullPrototype: Object.getPrototypeOf(vocab) === null,
      keys: Object.keys(vocab),
      hasOwn: Object.prototype.hasOwnProperty.call(vocab, "__proto__"),
      value: vocab["__proto__"],
      json: JSON.stringify(vocab)
    };
  }, event);

  expect(result.nullPrototype).toBe(true);
  expect(result.keys).toEqual(["__proto__"]);
  expect(result.hasOwn).toBe(true);
  expect(result.value).toMatchObject({ word: "__proto__", count: 1 });
  expect(JSON.parse(result.json)["__proto__"]).toMatchObject({
    word: "__proto__",
    count: 1
  });
});

test("unknown fields 不进入 Vocab，unknown getter 不执行", async ({ page }) => {
  const event = makeEvent("query:unknown", {
    futureEventFact: { nested: ["private-extension"] }
  });
  const baseline = makeBaseline("baseline:unknown", {
    futureBaselineFact: { private: true },
    records: {
      locator: {
        word: "banana",
        count: 2,
        futureRecordFact: { private: true }
      }
    }
  });
  const result = await page.evaluate(({ eventRecord, baselineRecord }) => {
    let getterCalls = 0;
    Object.defineProperty(eventRecord, "futureGetter", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must-not-leak";
      }
    });
    Object.defineProperty(baselineRecord.records.locator, "futureGetter", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must-not-leak";
      }
    });
    const vocab = window.LingoFlowQueryHistoryProjector.project(
      [eventRecord],
      [baselineRecord]
    );
    return {
      getterCalls,
      appleFields: Object.keys(vocab.apple),
      bananaFields: Object.keys(vocab.banana),
      json: JSON.stringify(vocab)
    };
  }, { eventRecord: event, baselineRecord: baseline });

  expect(result.getterCalls).toBe(0);
  expect(result.appleFields).not.toContain("futureEventFact");
  expect(result.appleFields).not.toContain("futureGetter");
  expect(result.bananaFields).not.toContain("futureRecordFact");
  expect(result.bananaFields).not.toContain("futureGetter");
  expect(result.json).not.toContain("private-extension");
  expect(result.json).not.toContain("must-not-leak");
});

test("Projector 不修改输入数组、实体、records 或 locator", async ({ page }) => {
  const events = [
    makeEvent("query:later", { timestamp: "2026-08-24T11:00:00.000Z" }),
    makeEvent("query:earlier", { timestamp: "2026-08-24T10:00:00.000Z" })
  ];
  const baselines = [
    makeBaseline("baseline:later", { createdAt: "2026-08-24T09:00:00.000Z" }),
    makeBaseline("baseline:earlier", {
      createdAt: "2026-08-23T09:00:00.000Z",
      records: {
        "locator-must-stay": { word: "banana", count: 2 }
      }
    })
  ];
  const result = await page.evaluate(({ queryEvents, historyBaselines }) => {
    const beforeEvents = JSON.stringify(queryEvents);
    const beforeBaselines = JSON.stringify(historyBaselines);
    const vocab = window.LingoFlowQueryHistoryProjector.project(
      queryEvents,
      historyBaselines
    );
    vocab.apple.count = 999;
    return {
      beforeEvents,
      afterEvents: JSON.stringify(queryEvents),
      beforeBaselines,
      afterBaselines: JSON.stringify(historyBaselines),
      eventIds: queryEvents.map(item => item.id),
      baselineIds: historyBaselines.map(item => item.id),
      locatorStillPresent: Object.prototype.hasOwnProperty.call(
        historyBaselines[1].records,
        "locator-must-stay"
      )
    };
  }, { queryEvents: events, historyBaselines: baselines });

  expect(result.beforeEvents).toBe(result.afterEvents);
  expect(result.beforeBaselines).toBe(result.afterBaselines);
  expect(result.eventIds).toEqual(events.map(item => item.id));
  expect(result.baselineIds).toEqual(baselines.map(item => item.id));
  expect(result.locatorStillPresent).toBe(true);
});

test("不同 ID 的完全相同 QueryEvent 都计数，不按内容去重", async ({ page }) => {
  const first = makeEvent("query:duplicate-fact-a");
  const second = { ...first, id: "query:duplicate-fact-b" };
  const result = await page.evaluate(incoming => (
    window.LingoFlowQueryHistoryProjector.project(incoming, [])
  ), [first, second]);

  expect(result.apple).toMatchObject({
    count: 2,
    articleCount: 2,
    searchCount: 0
  });
});

test("多次执行完全确定，且不访问 storage、Repository、DOM、当前时间或随机数", async ({ page }) => {
  const event = makeEvent("query:pure");
  const baseline = makeBaseline("baseline:pure");
  const result = await page.evaluate(({ queryEvent, historyBaseline }) => {
    const originalGetItem = Storage.prototype.getItem;
    const originalSetItem = Storage.prototype.setItem;
    const originalNow = Date.now;
    const originalRandom = Math.random;
    const originalQuerySelector = Document.prototype.querySelector;
    let storageReads = 0;
    let storageWrites = 0;
    let domReads = 0;
    Storage.prototype.getItem = function() {
      storageReads += 1;
      throw new Error("storage must not be read");
    };
    Storage.prototype.setItem = function() {
      storageWrites += 1;
      throw new Error("storage must not be written");
    };
    Date.now = () => { throw new Error("current time must not be read"); };
    Math.random = () => { throw new Error("random must not be read"); };
    Document.prototype.querySelector = function() {
      domReads += 1;
      throw new Error("DOM must not be read");
    };
    try {
      const projector = window.LingoFlowQueryHistoryProjector;
      const outputs = Array.from({ length: 5 }, () => (
        JSON.stringify(projector.project([queryEvent], [historyBaseline]))
      ));
      return {
        outputs,
        storageReads,
        storageWrites,
        domReads,
        repositoryTouched: Boolean(
          projector.QueryEventRepository || projector.HistoryBaselineRepository
        )
      };
    } finally {
      Storage.prototype.getItem = originalGetItem;
      Storage.prototype.setItem = originalSetItem;
      Date.now = originalNow;
      Math.random = originalRandom;
      Document.prototype.querySelector = originalQuerySelector;
    }
  }, { queryEvent: event, historyBaseline: baseline });

  expect(new Set(result.outputs).size).toBe(1);
  expect(result.storageReads).toBe(0);
  expect(result.storageWrites).toBe(0);
  expect(result.domReads).toBe(0);
  expect(result.repositoryTouched).toBe(false);
});
