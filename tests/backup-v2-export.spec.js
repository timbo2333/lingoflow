const { test, expect } = require("@playwright/test");

const PREFERENCES_STORAGE_KEY = "EnglishReaderV052ReadingPrefs";
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
  expect(await page.evaluate(() => typeof window.LingoFlowBackupV2Export)).toBe("object");
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

function makeArticle(id, overrides = {}) {
  const reading = {
    progress: 0.36,
    paragraphIndex: 2,
    updatedAt: "2026-08-20T03:00:00.000Z"
  };
  return {
    id,
    title: `Export article ${id}`,
    content: `Exportable content for ${id}.`,
    sourceType: "paste",
    createdAt: "2026-08-20T01:00:00.000Z",
    updatedAt: "2026-08-20T02:00:00.000Z",
    lastReadAt: "2026-08-20T04:00:00.000Z",
    deletedAt: null,
    ...overrides,
    reading: { ...reading, ...(overrides.reading || {}) }
  };
}

test("Backup v2 Export 导出活动 Article，并保留来源、阅读和生命周期字段", async ({ page }) => {
  const article = makeArticle("article:export-active", {
    sourceType: "library",
    sourceId: "library:export-active",
    sourceTitle: "Export source title",
    sourceAttribution: "Export attribution",
    extension: { labels: ["backup", "export"] }
  });
  const result = await page.evaluate(async incoming => {
    const library = window.LingoFlowArticleLibrary;
    await library.restoreArticle(incoming);
    const exported = await window.LingoFlowBackupV2Export.exportArticles();
    const validation = exported.payload
      ? window.LingoFlowBackupV2Schema.validateArticles(exported.payload.articles)
      : null;
    return { exported, validation };
  }, article);

  expect(result.exported).toEqual({
    status: "ready",
    payload: { articles: [article] }
  });
  expect(result.validation?.status).toBe("valid");
});

test("Backup v2 Export 同时导出软删除 Article", async ({ page }) => {
  const active = makeArticle("article:export-active-record");
  const deleted = makeArticle("article:export-deleted", {
    deletedAt: "2026-08-20T05:00:00.000Z",
    reading: {
      progress: 0.78,
      paragraphIndex: 7,
      updatedAt: "2026-08-20T04:30:00.000Z"
    }
  });
  const result = await page.evaluate(async incoming => {
    const library = window.LingoFlowArticleLibrary;
    for (const article of incoming) {
      await library.restoreArticle(article);
    }
    return await window.LingoFlowBackupV2Export.exportArticles();
  }, [active, deleted]);

  expect(result.status).toBe("ready");
  expect(result.payload.articles).toHaveLength(2);
  expect(result.payload.articles).toEqual(expect.arrayContaining([active, deleted]));
});

test("Backup v2 Export 接受空 Article 集合", async ({ page }) => {
  const result = await page.evaluate(() => (
    window.LingoFlowBackupV2Export.exportArticles()
  ));

  expect(result).toEqual({
    status: "ready",
    payload: { articles: [] }
  });
});

test("exportBackup 将全部已注册实体导出结果封装为完整 Backup Envelope", async ({ page }) => {
  const article = makeArticle("article:export-envelope");
  const result = await page.evaluate(async incoming => {
    await window.LingoFlowArticleLibrary.restoreArticle(incoming);
    const exported = await window.LingoFlowBackupV2Export.exportBackup();
    const validation = exported.payload
      ? window.LingoFlowBackupV2Envelope.validateEnvelope(exported.payload)
      : null;
    return { exported, validation };
  }, article);

  expect(result.exported).toEqual({
    status: "ready",
    payload: {
      format: {
        name: "LingoFlow Backup",
        version: 2
      },
      metadata: {},
      schema: {
        articles: "1",
        favorites: "1",
        favoriteLearningStates: "1",
        queryEvents: "1",
        historyBaselines: "1",
        preferences: "1"
      },
      data: {
        articles: [article],
        favorites: [],
        favoriteLearningStates: [],
        queryEvents: [],
        historyBaselines: [],
        preferences: []
      }
    }
  });
  expect(result.validation?.status).toBe("valid");
});

test("exportBackup 按六实体固定顺序成功后才构建 Envelope", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const calls = [];
    window.LingoFlowArticleLibrary = Object.freeze({
      listArticles: async options => {
        calls.push(["articles", options]);
        return [];
      }
    });
    window.LingoFlowBackupV2Schema = Object.freeze({
      validateArticles: articles => ({ status: "valid", articles })
    });
    window.LingoFlowFavoriteBackupExport = Object.freeze({
      exportFavorites: async () => {
        calls.push(["favorites"]);
        return { status: "ready", payload: { favorites: [] } };
      }
    });
    window.LingoFlowFavoriteLearningBackupExport = Object.freeze({
      exportFavoriteLearningStates: async () => {
        calls.push(["favoriteLearningStates"]);
        return {
          status: "ready",
          payload: { favoriteLearningStates: [] }
        };
      }
    });
    window.LingoFlowQueryEventBackupExport = Object.freeze({
      exportQueryEvents: async () => {
        calls.push(["queryEvents"]);
        return { status: "ready", payload: { queryEvents: [] } };
      }
    });
    window.LingoFlowHistoryBaselineBackupExport = Object.freeze({
      exportHistoryBaselines: async () => {
        calls.push(["historyBaselines"]);
        return { status: "ready", payload: { historyBaselines: [] } };
      }
    });
    window.LingoFlowPreferencesBackupExport = Object.freeze({
      exportPreferences: async () => {
        calls.push(["preferences"]);
        return { status: "ready", payload: { preferences: [] } };
      }
    });
    window.LingoFlowBackupV2Envelope = Object.freeze({
      buildEnvelope: data => {
        calls.push(["envelope", Object.keys(data)]);
        return { status: "ready", envelope: { data } };
      }
    });

    return {
      exported: await window.LingoFlowBackupV2Export.exportBackup(),
      calls
    };
  });

  expect(result.exported).toEqual({
    status: "ready",
    payload: {
      data: {
        articles: [],
        favorites: [],
        favoriteLearningStates: [],
        queryEvents: [],
        historyBaselines: [],
        preferences: []
      }
    }
  });
  expect(result.calls).toEqual([
    ["articles", { includeDeleted: true }],
    ["favorites"],
    ["favoriteLearningStates"],
    ["queryEvents"],
    ["historyBaselines"],
    ["preferences"],
    ["articles", { includeDeleted: true }],
    ["favorites"],
    ["favoriteLearningStates"],
    ["queryEvents"],
    ["historyBaselines"],
    ["preferences"],
    ["envelope", [
      "articles",
      "favorites",
      "favoriteLearningStates",
      "queryEvents",
      "historyBaselines",
      "preferences"
    ]]
  ]);
});

test("exportBackup 对六实体第二轮仅 collection 重排保持 ready", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const collections = {
      articles: [
        { id: "article:order-a", marker: "a" },
        { id: "article:order-b", marker: "b" }
      ],
      favorites: [
        { id: "favorite:order-a", marker: "a" },
        { id: "favorite:order-b", marker: "b" }
      ],
      favoriteLearningStates: [
        { favoriteId: "favorite:order-a", marker: "a" },
        { favoriteId: "favorite:order-b", marker: "b" }
      ],
      queryEvents: [
        { id: "query-event:order-a", marker: "a" },
        { id: "query-event:order-b", marker: "b" }
      ],
      historyBaselines: [
        { id: "history-baseline:order-a", marker: "a" },
        { id: "history-baseline:order-b", marker: "b" }
      ],
      preferences: [
        { key: "appearance", value: "dark" },
        { key: "speechVoice", value: null }
      ]
    };
    const calls = {
      articles: 0,
      favorites: 0,
      favoriteLearningStates: 0,
      queryEvents: 0,
      historyBaselines: 0,
      preferences: 0,
      envelope: 0
    };
    const readCollection = entity => {
      calls[entity] += 1;
      const records = calls[entity] === 1
        ? collections[entity]
        : collections[entity].slice().reverse();
      return structuredClone(records);
    };

    window.LingoFlowArticleLibrary = Object.freeze({
      listArticles: async () => readCollection("articles")
    });
    window.LingoFlowBackupV2Schema = Object.freeze({
      validateArticles: articles => ({ status: "valid", articles })
    });
    window.LingoFlowFavoriteBackupExport = Object.freeze({
      exportFavorites: async () => ({
        status: "ready",
        payload: { favorites: readCollection("favorites") }
      })
    });
    window.LingoFlowFavoriteLearningBackupExport = Object.freeze({
      exportFavoriteLearningStates: async () => ({
        status: "ready",
        payload: {
          favoriteLearningStates: readCollection("favoriteLearningStates")
        }
      })
    });
    window.LingoFlowQueryEventBackupExport = Object.freeze({
      exportQueryEvents: async () => ({
        status: "ready",
        payload: { queryEvents: readCollection("queryEvents") }
      })
    });
    window.LingoFlowHistoryBaselineBackupExport = Object.freeze({
      exportHistoryBaselines: async () => ({
        status: "ready",
        payload: { historyBaselines: readCollection("historyBaselines") }
      })
    });
    window.LingoFlowPreferencesBackupExport = Object.freeze({
      exportPreferences: async () => ({
        status: "ready",
        payload: { preferences: readCollection("preferences") }
      })
    });
    window.LingoFlowBackupV2Envelope = Object.freeze({
      buildEnvelope: data => {
        calls.envelope += 1;
        return { status: "ready", envelope: { data } };
      }
    });

    return {
      exported: await window.LingoFlowBackupV2Export.exportBackup(),
      calls,
      collections
    };
  });

  expect(result.exported).toEqual({
    status: "ready",
    payload: { data: result.collections }
  });
  expect(result.calls).toEqual({
    articles: 2,
    favorites: 2,
    favoriteLearningStates: 2,
    queryEvents: 2,
    historyBaselines: 2,
    preferences: 2,
    envelope: 1
  });
});

test("exportBackup 将 missing 与已存储空 Preferences 都导出为空集合", async ({ page }) => {
  const result = await page.evaluate(async storageKey => {
    localStorage.removeItem(storageKey);
    const missing = await window.LingoFlowBackupV2Export.exportBackup();
    localStorage.setItem(storageKey, "{}");
    const storedEmpty = await window.LingoFlowBackupV2Export.exportBackup();
    return { missing, storedEmpty };
  }, PREFERENCES_STORAGE_KEY);

  expect(result.missing.status).toBe("ready");
  expect(result.missing.payload.data.preferences).toEqual([]);
  expect(result.storedEmpty.status).toBe("ready");
  expect(result.storedEmpty.payload.data.preferences).toEqual([]);
});

test("exportBackup 检测 Preferences 完整值在第二轮读取期间变化", async ({ page }) => {
  const result = await page.evaluate(async () => {
    let preferencesCalls = 0;
    let envelopeCalls = 0;
    const firstPreferences = [
      { key: "fontSize", value: 18 },
      { key: "speechVoice", value: null },
      {
        key: "futurePreference",
        value: { nested: ["stable", { enabled: true }] }
      }
    ];
    const secondPreferences = structuredClone(firstPreferences);
    secondPreferences[2].value.nested[1].enabled = false;
    const before = structuredClone({ firstPreferences, secondPreferences });

    window.LingoFlowArticleLibrary = Object.freeze({
      listArticles: async () => []
    });
    window.LingoFlowBackupV2Schema = Object.freeze({
      validateArticles: articles => ({ status: "valid", articles })
    });
    window.LingoFlowFavoriteBackupExport = Object.freeze({
      exportFavorites: async () => ({
        status: "ready",
        payload: { favorites: [] }
      })
    });
    window.LingoFlowFavoriteLearningBackupExport = Object.freeze({
      exportFavoriteLearningStates: async () => ({
        status: "ready",
        payload: { favoriteLearningStates: [] }
      })
    });
    window.LingoFlowQueryEventBackupExport = Object.freeze({
      exportQueryEvents: async () => ({
        status: "ready",
        payload: { queryEvents: [] }
      })
    });
    window.LingoFlowHistoryBaselineBackupExport = Object.freeze({
      exportHistoryBaselines: async () => ({
        status: "ready",
        payload: { historyBaselines: [] }
      })
    });
    window.LingoFlowPreferencesBackupExport = Object.freeze({
      exportPreferences: async () => {
        preferencesCalls += 1;
        return {
          status: "ready",
          payload: {
            preferences: preferencesCalls === 1
              ? firstPreferences
              : secondPreferences
          }
        };
      }
    });
    window.LingoFlowBackupV2Envelope = Object.freeze({
      buildEnvelope: () => {
        envelopeCalls += 1;
        return { status: "ready", envelope: {} };
      }
    });

    return {
      exported: await window.LingoFlowBackupV2Export.exportBackup(),
      preferencesCalls,
      envelopeCalls,
      before,
      after: { firstPreferences, secondPreferences }
    };
  });

  expect(result.exported).toEqual({
    status: "rejected",
    payload: null,
    reason: "inconsistent-export-snapshot"
  });
  expect(result.preferencesCalls).toBe(2);
  expect(result.envelopeCalls).toBe(0);
  expect(result.after).toEqual(result.before);
});

test("exportBackup 在 Preferences rejected 或 throw 时不构建部分 Envelope", async ({ page }) => {
  const result = await page.evaluate(async () => {
    let envelopeCalls = 0;
    window.LingoFlowArticleLibrary = Object.freeze({ listArticles: async () => [] });
    window.LingoFlowBackupV2Schema = Object.freeze({
      validateArticles: articles => ({ status: "valid", articles })
    });
    window.LingoFlowFavoriteBackupExport = Object.freeze({
      exportFavorites: async () => ({ status: "ready", payload: { favorites: [] } })
    });
    window.LingoFlowFavoriteLearningBackupExport = Object.freeze({
      exportFavoriteLearningStates: async () => ({
        status: "ready",
        payload: { favoriteLearningStates: [] }
      })
    });
    window.LingoFlowQueryEventBackupExport = Object.freeze({
      exportQueryEvents: async () => ({
        status: "ready",
        payload: { queryEvents: [] }
      })
    });
    window.LingoFlowHistoryBaselineBackupExport = Object.freeze({
      exportHistoryBaselines: async () => ({
        status: "ready",
        payload: { historyBaselines: [] }
      })
    });
    window.LingoFlowBackupV2Envelope = Object.freeze({
      buildEnvelope: () => {
        envelopeCalls += 1;
        return { status: "ready", envelope: {} };
      }
    });

    window.LingoFlowPreferencesBackupExport = Object.freeze({
      exportPreferences: async () => ({ status: "rejected", payload: null })
    });
    const rejected = await window.LingoFlowBackupV2Export.exportBackup();

    window.LingoFlowPreferencesBackupExport = Object.freeze({
      exportPreferences: async () => {
        throw new Error("preferences export failed");
      }
    });
    const thrown = await window.LingoFlowBackupV2Export.exportBackup();

    return { rejected, thrown, envelopeCalls };
  });

  expect(result.rejected).toEqual({ status: "rejected", payload: null });
  expect(result.thrown).toEqual({ status: "failed", payload: null });
  expect(result.envelopeCalls).toBe(0);
});

for (const changingEntity of ["queryEvents", "historyBaselines"]) {
  test(`exportBackup 检测 ${changingEntity} 两轮读取变化且不生成 Envelope`, async ({ page }) => {
    const result = await page.evaluate(async entity => {
      let queryCalls = 0;
      let baselineCalls = 0;
      let envelopeCalls = 0;
      const firstQueryEvents = [{ id: "query-event:first", marker: "first" }];
      const secondQueryEvents = entity === "queryEvents"
        ? [{ id: "query-event:first", marker: "second" }]
        : structuredClone(firstQueryEvents);
      const firstBaselines = [{ id: "history-baseline:first", marker: "first" }];
      const secondBaselines = entity === "historyBaselines"
        ? [{ id: "history-baseline:first", marker: "second" }]
        : structuredClone(firstBaselines);
      const before = structuredClone({
        firstQueryEvents,
        secondQueryEvents,
        firstBaselines,
        secondBaselines
      });

      window.LingoFlowArticleLibrary = Object.freeze({
        listArticles: async () => []
      });
      window.LingoFlowBackupV2Schema = Object.freeze({
        validateArticles: articles => ({ status: "valid", articles })
      });
      window.LingoFlowFavoriteBackupExport = Object.freeze({
        exportFavorites: async () => ({
          status: "ready",
          payload: { favorites: [] }
        })
      });
      window.LingoFlowFavoriteLearningBackupExport = Object.freeze({
        exportFavoriteLearningStates: async () => ({
          status: "ready",
          payload: { favoriteLearningStates: [] }
        })
      });
      window.LingoFlowQueryEventBackupExport = Object.freeze({
        exportQueryEvents: async () => {
          queryCalls += 1;
          return {
            status: "ready",
            payload: {
              queryEvents: queryCalls === 1
                ? firstQueryEvents
                : secondQueryEvents
            }
          };
        }
      });
      window.LingoFlowHistoryBaselineBackupExport = Object.freeze({
        exportHistoryBaselines: async () => {
          baselineCalls += 1;
          return {
            status: "ready",
            payload: {
              historyBaselines: baselineCalls === 1
                ? firstBaselines
                : secondBaselines
            }
          };
        }
      });
      window.LingoFlowBackupV2Envelope = Object.freeze({
        buildEnvelope: () => {
          envelopeCalls += 1;
          return { status: "ready", envelope: {} };
        }
      });

      const exported = await window.LingoFlowBackupV2Export.exportBackup();
      return {
        exported,
        queryCalls,
        baselineCalls,
        envelopeCalls,
        before,
        after: {
          firstQueryEvents,
          secondQueryEvents,
          firstBaselines,
          secondBaselines
        }
      };
    }, changingEntity);

    expect(result.exported).toEqual({
      status: "rejected",
      payload: null,
      reason: "inconsistent-export-snapshot"
    });
    expect(result.queryCalls).toBe(2);
    expect(result.baselineCalls).toBe(2);
    expect(result.envelopeCalls).toBe(0);
    expect(result.after).toEqual(result.before);
  });
}

test("exportBackup 检测 History Baseline locator 变化", async ({ page }) => {
  const result = await page.evaluate(async () => {
    let baselineCalls = 0;
    let envelopeCalls = 0;
    const record = { word: "apple", count: 2 };
    const firstBaselines = [{
      id: "history-baseline:locator-change",
      records: { "legacy-locator:first": structuredClone(record) }
    }];
    const secondBaselines = [{
      id: "history-baseline:locator-change",
      records: { "legacy-locator:second": structuredClone(record) }
    }];

    window.LingoFlowArticleLibrary = Object.freeze({
      listArticles: async () => []
    });
    window.LingoFlowBackupV2Schema = Object.freeze({
      validateArticles: articles => ({ status: "valid", articles })
    });
    window.LingoFlowFavoriteBackupExport = Object.freeze({
      exportFavorites: async () => ({
        status: "ready",
        payload: { favorites: [] }
      })
    });
    window.LingoFlowFavoriteLearningBackupExport = Object.freeze({
      exportFavoriteLearningStates: async () => ({
        status: "ready",
        payload: { favoriteLearningStates: [] }
      })
    });
    window.LingoFlowQueryEventBackupExport = Object.freeze({
      exportQueryEvents: async () => ({
        status: "ready",
        payload: { queryEvents: [] }
      })
    });
    window.LingoFlowHistoryBaselineBackupExport = Object.freeze({
      exportHistoryBaselines: async () => {
        baselineCalls += 1;
        return {
          status: "ready",
          payload: {
            historyBaselines: baselineCalls === 1
              ? firstBaselines
              : secondBaselines
          }
        };
      }
    });
    window.LingoFlowBackupV2Envelope = Object.freeze({
      buildEnvelope: () => {
        envelopeCalls += 1;
        return { status: "ready", envelope: {} };
      }
    });

    return {
      exported: await window.LingoFlowBackupV2Export.exportBackup(),
      baselineCalls,
      envelopeCalls
    };
  });

  expect(result.exported).toEqual({
    status: "rejected",
    payload: null,
    reason: "inconsistent-export-snapshot"
  });
  expect(result.baselineCalls).toBe(2);
  expect(result.envelopeCalls).toBe(0);
});

test("exportBackup 拒绝无法解析到同次导出 Favorite 的 Learning State", async ({ page }) => {
  const favoriteLearningState = {
    favoriteId: "favorite:orphan-export",
    mastered: false,
    createdAt: "2026-08-24T01:00:00.000Z",
    updatedAt: "2026-08-24T02:00:00.000Z",
    deletedAt: null
  };
  const result = await page.evaluate(async incoming => {
    const seeded = window.LingoFlowFavoriteLearningRepository
      .restoreBackupRecords([incoming]);
    const originalEnvelope = window.LingoFlowBackupV2Envelope;
    let envelopeCalls = 0;
    window.LingoFlowBackupV2Envelope = Object.freeze({
      buildEnvelope: data => {
        envelopeCalls += 1;
        return originalEnvelope.buildEnvelope(data);
      }
    });

    return {
      seeded,
      exported: await window.LingoFlowBackupV2Export.exportBackup(),
      envelopeCalls,
      stored: window.LingoFlowFavoriteLearningRepository.get(
        incoming.favoriteId,
        { includeDeleted: true }
      )
    };
  }, favoriteLearningState);

  expect(result.seeded.status).toBe("completed");
  expect(result.exported).toEqual({
    status: "rejected",
    payload: null,
    reason: "unresolved-favorite-reference",
    unresolvedFavoriteIds: [favoriteLearningState.favoriteId]
  });
  expect(result.envelopeCalls).toBe(0);
  expect(result.stored).toEqual(favoriteLearningState);
});

test("exportBackup 在有限二次读取发现数据变化时拒绝且不修改读取结果", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const firstFavorites = [
      {
        id: "favorite:snapshot-active",
        type: "word",
        text: "stable",
        createdAt: "2026-08-24T01:00:00.000Z",
        updatedAt: "2026-08-24T02:00:00.000Z",
        deletedAt: null
      },
      {
        id: "favorite:snapshot-tombstone",
        type: "phrase",
        text: "in time",
        createdAt: "2026-08-24T01:00:00.000Z",
        updatedAt: "2026-08-24T03:00:00.000Z",
        deletedAt: "2026-08-24T03:00:00.000Z"
      }
    ];
    const secondFavorites = structuredClone(firstFavorites);
    secondFavorites[0].text = "changed during export";
    const learningStates = [{
      favoriteId: firstFavorites[0].id,
      mastered: false,
      createdAt: "2026-08-24T01:00:00.000Z",
      updatedAt: "2026-08-24T02:00:00.000Z",
      deletedAt: null
    }];
    const inputsBefore = structuredClone({
      firstFavorites,
      secondFavorites,
      learningStates
    });
    let articleCalls = 0;
    let favoriteCalls = 0;
    let learningCalls = 0;
    let envelopeCalls = 0;

    window.LingoFlowArticleLibrary = Object.freeze({
      listArticles: async () => {
        articleCalls += 1;
        return [];
      }
    });
    window.LingoFlowBackupV2Schema = Object.freeze({
      validateArticles: articles => ({ status: "valid", articles })
    });
    window.LingoFlowFavoriteBackupExport = Object.freeze({
      exportFavorites: async () => {
        favoriteCalls += 1;
        return {
          status: "ready",
          payload: {
            favorites: favoriteCalls === 1 ? firstFavorites : secondFavorites
          }
        };
      }
    });
    window.LingoFlowFavoriteLearningBackupExport = Object.freeze({
      exportFavoriteLearningStates: async () => {
        learningCalls += 1;
        return {
          status: "ready",
          payload: { favoriteLearningStates: learningStates }
        };
      }
    });
    window.LingoFlowBackupV2Envelope = Object.freeze({
      buildEnvelope: () => {
        envelopeCalls += 1;
        return { status: "ready", envelope: {} };
      }
    });

    const exported = await window.LingoFlowBackupV2Export.exportBackup();
    return {
      exported,
      articleCalls,
      favoriteCalls,
      learningCalls,
      envelopeCalls,
      inputsBefore,
      inputsAfter: { firstFavorites, secondFavorites, learningStates }
    };
  });

  expect(result.exported).toEqual({
    status: "rejected",
    payload: null,
    reason: "inconsistent-export-snapshot"
  });
  expect(result.articleCalls).toBe(2);
  expect(result.favoriteCalls).toBe(2);
  expect(result.learningCalls).toBe(2);
  expect(result.envelopeCalls).toBe(0);
  expect(result.inputsAfter).toEqual(result.inputsBefore);
});

test("exportBackup 在任一实体导出失败时不构建部分 Envelope", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const originalFavoriteExport = window.LingoFlowFavoriteBackupExport;
    let favoriteCalls = 0;
    let learningCalls = 0;
    let envelopeCalls = 0;

    window.LingoFlowFavoriteBackupExport = Object.freeze({
      exportFavorites: async () => {
        favoriteCalls += 1;
        return { status: "rejected", payload: null };
      }
    });
    window.LingoFlowFavoriteLearningBackupExport = Object.freeze({
      exportFavoriteLearningStates: async () => {
        learningCalls += 1;
        return { status: "ready", payload: { favoriteLearningStates: [] } };
      }
    });
    window.LingoFlowBackupV2Envelope = Object.freeze({
      buildEnvelope: () => {
        envelopeCalls += 1;
        return { status: "ready", envelope: {} };
      }
    });
    const favoriteRejected = await window.LingoFlowBackupV2Export.exportBackup();

    window.LingoFlowFavoriteBackupExport = originalFavoriteExport;
    window.LingoFlowFavoriteLearningBackupExport = Object.freeze({
      exportFavoriteLearningStates: async () => {
        learningCalls += 1;
        return { status: "failed", payload: null };
      }
    });
    const learningFailed = await window.LingoFlowBackupV2Export.exportBackup();

    return {
      favoriteRejected,
      learningFailed,
      favoriteCalls,
      learningCalls,
      envelopeCalls
    };
  });

  expect(result.favoriteRejected).toEqual({ status: "rejected", payload: null });
  expect(result.learningFailed).toEqual({ status: "failed", payload: null });
  expect(result.favoriteCalls).toBe(1);
  expect(result.learningCalls).toBe(1);
  expect(result.envelopeCalls).toBe(0);
});

test("exportBackup 在 QueryEvent rejected 或 Baseline throw 时不构建部分 Envelope", async ({ page }) => {
  const result = await page.evaluate(async () => {
    let envelopeCalls = 0;

    const installSuccessfulDependencies = () => {
      window.LingoFlowArticleLibrary = Object.freeze({
        listArticles: async () => []
      });
      window.LingoFlowBackupV2Schema = Object.freeze({
        validateArticles: articles => ({ status: "valid", articles })
      });
      window.LingoFlowFavoriteBackupExport = Object.freeze({
        exportFavorites: async () => ({
          status: "ready",
          payload: { favorites: [] }
        })
      });
      window.LingoFlowFavoriteLearningBackupExport = Object.freeze({
        exportFavoriteLearningStates: async () => ({
          status: "ready",
          payload: { favoriteLearningStates: [] }
        })
      });
      window.LingoFlowQueryEventBackupExport = Object.freeze({
        exportQueryEvents: async () => ({
          status: "ready",
          payload: { queryEvents: [] }
        })
      });
      window.LingoFlowHistoryBaselineBackupExport = Object.freeze({
        exportHistoryBaselines: async () => ({
          status: "ready",
          payload: { historyBaselines: [] }
        })
      });
      window.LingoFlowBackupV2Envelope = Object.freeze({
        buildEnvelope: () => {
          envelopeCalls += 1;
          return { status: "ready", envelope: {} };
        }
      });
    };

    installSuccessfulDependencies();
    window.LingoFlowQueryEventBackupExport = Object.freeze({
      exportQueryEvents: async () => ({ status: "rejected", payload: null })
    });
    const queryRejected = await window.LingoFlowBackupV2Export.exportBackup();

    installSuccessfulDependencies();
    window.LingoFlowHistoryBaselineBackupExport = Object.freeze({
      exportHistoryBaselines: async () => {
        throw new Error("baseline export failed");
      }
    });
    const baselineThrown = await window.LingoFlowBackupV2Export.exportBackup();

    return { queryRejected, baselineThrown, envelopeCalls };
  });

  expect(result.queryRejected).toEqual({ status: "rejected", payload: null });
  expect(result.baselineThrown).toEqual({ status: "failed", payload: null });
  expect(result.envelopeCalls).toBe(0);
});

test("exportBackup 在 Article 被拒绝时不调用后续实体导出", async ({ page }) => {
  const result = await page.evaluate(async () => {
    let favoriteCalls = 0;
    let learningCalls = 0;
    let envelopeCalls = 0;
    window.LingoFlowArticleLibrary = Object.freeze({
      listArticles: async () => [{ id: "article:invalid-aggregate-export" }]
    });
    window.LingoFlowFavoriteBackupExport = Object.freeze({
      exportFavorites: async () => {
        favoriteCalls += 1;
        return { status: "ready", payload: { favorites: [] } };
      }
    });
    window.LingoFlowFavoriteLearningBackupExport = Object.freeze({
      exportFavoriteLearningStates: async () => {
        learningCalls += 1;
        return { status: "ready", payload: { favoriteLearningStates: [] } };
      }
    });
    window.LingoFlowBackupV2Envelope = Object.freeze({
      buildEnvelope: () => {
        envelopeCalls += 1;
        return { status: "ready", envelope: {} };
      }
    });

    return {
      exported: await window.LingoFlowBackupV2Export.exportBackup(),
      favoriteCalls,
      learningCalls,
      envelopeCalls
    };
  });

  expect(result.exported).toEqual({ status: "rejected", payload: null });
  expect(result.favoriteCalls).toBe(0);
  expect(result.learningCalls).toBe(0);
  expect(result.envelopeCalls).toBe(0);
});

test("exportBackup 在 Envelope 构建被拒绝时不返回 payload", async ({ page }) => {
  const result = await page.evaluate(async () => {
    window.LingoFlowBackupV2Envelope = Object.freeze({
      buildEnvelope: () => ({
        status: "rejected",
        envelope: null,
        errors: [{ code: "invalid-envelope", path: "$" }]
      })
    });
    return window.LingoFlowBackupV2Export.exportBackup();
  });

  expect(result).toEqual({ status: "rejected", payload: null });
});

test("Backup v2 Export 在 Schema 拒绝异常 Article 时不返回 payload", async ({ page }) => {
  const result = await page.evaluate(async () => {
    let listOptions = null;
    window.LingoFlowArticleLibrary = Object.freeze({
      listArticles: async options => {
        listOptions = options;
        return [{ id: "article:invalid-export" }];
      }
    });

    return {
      result: await window.LingoFlowBackupV2Export.exportArticles(),
      listOptions
    };
  });

  expect(result.listOptions).toEqual({ includeDeleted: true });
  expect(result.result).toEqual({ status: "rejected", payload: null });
});

test("Backup v2 Export 在 Article Library 读取异常时返回 failed", async ({ page }) => {
  const result = await page.evaluate(async () => {
    window.LingoFlowArticleLibrary = Object.freeze({
      listArticles: async () => {
        throw new Error("Article read failed");
      }
    });
    return await window.LingoFlowBackupV2Export.exportArticles();
  });

  expect(result).toEqual({ status: "failed", payload: null });
});

test("Backup v2 Export 不调用恢复接口，也不修改已存储的 Article", async ({ page }) => {
  const article = makeArticle("article:export-read-only");
  const result = await page.evaluate(async incoming => {
    const original = window.LingoFlowArticleLibrary;
    await original.restoreArticle(incoming);
    let restoreCalls = 0;
    let assessmentCalls = 0;
    window.LingoFlowArticleLibrary = Object.freeze({
      listArticles: original.listArticles,
      restoreArticle: async () => {
        restoreCalls += 1;
        throw new Error("Export must not restore Article");
      },
      assessArticleRestore: async () => {
        assessmentCalls += 1;
        throw new Error("Export must not assess Article restore");
      }
    });

    const exported = await window.LingoFlowBackupV2Export.exportArticles();
    exported.payload.articles[0].content = "Mutated export payload";
    exported.payload.articles[0].reading.progress = 0.99;
    const stored = await original.getArticle(incoming.id);
    return { exported, stored, restoreCalls, assessmentCalls };
  }, article);

  expect(result.exported.status).toBe("ready");
  expect(result.restoreCalls).toBe(0);
  expect(result.assessmentCalls).toBe(0);
  expect(result.stored).toEqual(article);
});
