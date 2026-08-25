const { test, expect } = require("@playwright/test");

async function loadBackupEnvironment(page) {
  await page.addInitScript(() => {
    localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
  });
  await page.goto("/");
  await expect(page.locator("#inputText")).toBeVisible();
  await page.waitForFunction(() => (
    window.LingoFlowArticleLibrary &&
    window.LingoFlowBackupV2Schema &&
    window.LingoFlowFavoriteBackupSchema &&
    window.LingoFlowFavoriteLearningBackupSchema &&
    window.LingoFlowBackupV2Envelope &&
    window.LingoFlowBackupV2Export &&
    window.LingoFlowFavoriteRepository &&
    window.LingoFlowFavoriteLearningRepository &&
    window.LingoFlowBackupV2 &&
    typeof window.LingoFlowBackupV2.restoreBackup === "function"
  ));
}

function makeArticle(id, overrides = {}) {
  const reading = {
    progress: 0.4,
    paragraphIndex: 2,
    updatedAt: "2026-08-25T02:00:00.000Z"
  };
  return {
    id,
    title: `Multi-entity article ${id}`,
    content: `Restorable multi-entity content for ${id}.`,
    sourceType: "paste",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T01:00:00.000Z",
    lastReadAt: "2026-08-25T02:00:00.000Z",
    deletedAt: null,
    ...overrides,
    reading: { ...reading, ...(overrides.reading || {}) }
  };
}

function makeFavorite(id, overrides = {}) {
  return {
    id,
    type: "word",
    text: `favorite text ${id}`,
    createdAt: "2026-08-25T03:00:00.000Z",
    updatedAt: "2026-08-25T04:00:00.000Z",
    deletedAt: null,
    ...overrides
  };
}

function makeLearningState(favoriteId, mastered, overrides = {}) {
  return {
    favoriteId,
    mastered,
    createdAt: "2026-08-25T06:00:00.000Z",
    updatedAt: "2026-08-25T07:00:00.000Z",
    deletedAt: null,
    ...overrides
  };
}

function makeEnvelope(data) {
  return {
    format: { name: "LingoFlow Backup", version: 2 },
    metadata: {},
    schema: Object.fromEntries(Object.keys(data).map(entity => [entity, "1"])),
    data
  };
}

function makeThreeEntityData(prefix) {
  const favorite = makeFavorite(`favorite:${prefix}`);
  return {
    articles: [makeArticle(`article:${prefix}`)],
    favorites: [favorite],
    favoriteLearningStates: [makeLearningState(favorite.id, false)]
  };
}

async function readStoredDomains(page) {
  return page.evaluate(async () => ({
    articles: await window.LingoFlowArticleLibrary.listArticles({ includeDeleted: true }),
    favorites: window.LingoFlowFavoriteRepository.list({ includeDeleted: true }),
    favoriteLearningStates: window.LingoFlowFavoriteLearningRepository.list({
      includeDeleted: true
    })
  }));
}

test("Backup v2 roundtrip preserves Article, Favorite tombstone, and mastered true/false", async ({ browser }) => {
  const article = makeArticle("article:multi-roundtrip");
  const activeFavorite = makeFavorite("favorite:multi-roundtrip-active", {
    text: "resilient"
  });
  const deletedFavorite = makeFavorite("favorite:multi-roundtrip-deleted", {
    type: "phrase",
    text: "in the long run",
    updatedAt: "2026-08-25T05:00:00.000Z",
    deletedAt: "2026-08-25T05:00:00.000Z"
  });
  const learningStates = [
    makeLearningState(activeFavorite.id, false),
    makeLearningState(deletedFavorite.id, true)
  ];
  const fixture = {
    article,
    favorites: [activeFavorite, deletedFavorite],
    favoriteLearningStates: learningStates
  };

  const exportContext = await browser.newContext();
  let exported;
  try {
    const exportPage = await exportContext.newPage();
    await loadBackupEnvironment(exportPage);
    const exportResult = await exportPage.evaluate(async incoming => {
      const articleResult = await window.LingoFlowArticleLibrary.restoreArticle(
        incoming.article
      );
      const favoriteResult = window.LingoFlowFavoriteRepository.restoreBackupRecords(
        incoming.favorites
      );
      const learningResult = window.LingoFlowFavoriteLearningRepository
        .restoreBackupRecords(incoming.favoriteLearningStates);
      const backup = await window.LingoFlowBackupV2Export.exportBackup();
      return { articleResult, favoriteResult, learningResult, backup };
    }, fixture);

    expect(exportResult.articleResult).toMatchObject({
      status: "restored",
      articleId: article.id,
      written: true
    });
    expect(exportResult.favoriteResult).toMatchObject({
      status: "completed",
      summary: { total: 2, restored: 2 }
    });
    expect(exportResult.learningResult).toMatchObject({
      status: "completed",
      summary: { total: 2, restored: 2 }
    });
    expect(exportResult.backup.status).toBe("ready");
    expect(exportResult.backup.payload.schema).toEqual({
      articles: "1",
      favorites: "1",
      favoriteLearningStates: "1"
    });
    expect(exportResult.backup.payload.data.articles).toEqual([article]);
    expect(exportResult.backup.payload.data.favorites).toHaveLength(2);
    expect(exportResult.backup.payload.data.favorites).toEqual(expect.arrayContaining(
      fixture.favorites
    ));
    expect(exportResult.backup.payload.data.favoriteLearningStates).toHaveLength(2);
    expect(exportResult.backup.payload.data.favoriteLearningStates).toEqual(
      expect.arrayContaining(learningStates)
    );
    exported = exportResult.backup.payload;
  } finally {
    await exportContext.close();
  }

  const restoreContext = await browser.newContext();
  try {
    const restorePage = await restoreContext.newPage();
    await loadBackupEnvironment(restorePage);
    expect(await readStoredDomains(restorePage)).toEqual({
      articles: [],
      favorites: [],
      favoriteLearningStates: []
    });

    const restoreResult = await restorePage.evaluate(async incoming => (
      window.LingoFlowBackupV2.restoreBackup(incoming)
    ), exported);
    const stored = await readStoredDomains(restorePage);

    expect(restoreResult).toMatchObject({
      status: "completed",
      summary: {
        total: 5,
        restored: 5,
        unchanged: 0,
        conflicts: 0,
        rejected: 0,
        failed: 0,
        notAttempted: 0
      },
      errors: []
    });
    expect(restoreResult.items).toHaveLength(5);
    expect(restoreResult.items.filter(item => item.entity === "articles")).toHaveLength(1);
    expect(restoreResult.items.filter(item => item.entity === "favorites")).toHaveLength(2);
    expect(restoreResult.items.filter(item => (
      item.entity === "favoriteLearningStates"
    ))).toHaveLength(2);

    expect(stored.articles).toEqual([article]);
    expect(stored.favorites).toHaveLength(2);
    expect(stored.favorites).toEqual(expect.arrayContaining(fixture.favorites));
    expect(stored.favoriteLearningStates).toHaveLength(2);
    expect(stored.favoriteLearningStates).toEqual(expect.arrayContaining(learningStates));
    expect(stored.favorites.find(item => item.id === deletedFavorite.id)?.deletedAt)
      .toBe(deletedFavorite.deletedAt);
    expect(stored.favoriteLearningStates.find(item => (
      item.favoriteId === activeFavorite.id
    ))).toHaveProperty("mastered", false);
    expect(stored.favoriteLearningStates.find(item => (
      item.favoriteId === deletedFavorite.id
    ))).toHaveProperty("mastered", true);
  } finally {
    await restoreContext.close();
  }
});

for (const localFavoriteCase of [
  { label: "active", overrides: {} },
  {
    label: "tombstone",
    overrides: {
      updatedAt: "2026-08-25T05:00:00.000Z",
      deletedAt: "2026-08-25T05:00:00.000Z"
    }
  }
]) {
  test(`Learning State can resolve a local Favorite ${localFavoriteCase.label} not present in backup favorites`, async ({ page }) => {
    await loadBackupEnvironment(page);
    const localFavorite = makeFavorite(
      `favorite:local-${localFavoriteCase.label}`,
      localFavoriteCase.overrides
    );
    const state = makeLearningState(localFavorite.id, true);

    const result = await page.evaluate(async incoming => {
      const localRestore = window.LingoFlowFavoriteRepository.restoreBackupRecords([
        incoming.localFavorite
      ]);
      const built = window.LingoFlowBackupV2Envelope.buildEnvelope({
        articles: [],
        favorites: [],
        favoriteLearningStates: [incoming.state]
      });
      const restored = await window.LingoFlowBackupV2.restoreBackup(built.envelope);
      return {
        localRestore,
        buildStatus: built.status,
        restored,
        favorite: window.LingoFlowFavoriteRepository.getById(
          incoming.localFavorite.id,
          { includeDeleted: true }
        ),
        learningState: window.LingoFlowFavoriteLearningRepository.get(
          incoming.localFavorite.id,
          { includeDeleted: true }
        )
      };
    }, { localFavorite, state });

    expect(result.localRestore).toMatchObject({
      status: "completed",
      summary: { restored: 1 }
    });
    expect(result.buildStatus).toBe("ready");
    expect(result.restored).toMatchObject({
      status: "completed",
      summary: {
        total: 1,
        restored: 1,
        rejected: 0,
        failed: 0,
        notAttempted: 0
      },
      errors: []
    });
    expect(result.restored.items).toEqual([
      expect.objectContaining({
        entity: "favoriteLearningStates",
        favoriteId: localFavorite.id,
        status: "restored",
        written: true
      })
    ]);
    expect(result.favorite).toEqual(localFavorite);
    expect(result.learningState).toEqual(state);
  });
}

test("unresolved Learning State rejects the whole restore before any domain write", async ({ page }) => {
  await loadBackupEnvironment(page);
  const data = makeThreeEntityData("unresolved-valid");
  const missingFavoriteId = "favorite:unresolved-missing";
  data.favoriteLearningStates = [makeLearningState(missingFavoriteId, true)];
  const envelope = makeEnvelope(data);

  const result = await page.evaluate(async incoming => {
    const originalArticleLibrary = window.LingoFlowArticleLibrary;
    const originalFavoriteRepository = window.LingoFlowFavoriteRepository;
    const originalLearningRepository = window.LingoFlowFavoriteLearningRepository;
    const restoreCalls = [];

    window.LingoFlowArticleLibrary = Object.freeze({
      ...originalArticleLibrary,
      restoreArticle: async article => {
        restoreCalls.push({ entity: "articles", value: structuredClone(article) });
        return originalArticleLibrary.restoreArticle(article);
      }
    });
    window.LingoFlowFavoriteRepository = Object.freeze({
      ...originalFavoriteRepository,
      restoreBackupRecords: favorites => {
        restoreCalls.push({ entity: "favorites", value: structuredClone(favorites) });
        return originalFavoriteRepository.restoreBackupRecords(favorites);
      }
    });
    window.LingoFlowFavoriteLearningRepository = Object.freeze({
      ...originalLearningRepository,
      restoreBackupRecords: states => {
        restoreCalls.push({
          entity: "favoriteLearningStates",
          value: structuredClone(states)
        });
        return originalLearningRepository.restoreBackupRecords(states);
      }
    });

    const before = {
      articles: await originalArticleLibrary.listArticles({ includeDeleted: true }),
      favorites: originalFavoriteRepository.list({ includeDeleted: true }),
      favoriteLearningStates: originalLearningRepository.list({ includeDeleted: true })
    };
    const restored = await window.LingoFlowBackupV2.restoreBackup(incoming.envelope);
    const after = {
      articles: await originalArticleLibrary.listArticles({ includeDeleted: true }),
      favorites: originalFavoriteRepository.list({ includeDeleted: true }),
      favoriteLearningStates: originalLearningRepository.list({ includeDeleted: true })
    };
    return { before, restored, after, restoreCalls };
  }, { envelope });

  expect(result.before).toEqual({
    articles: [],
    favorites: [],
    favoriteLearningStates: []
  });
  expect(result.after).toEqual(result.before);
  expect(result.restoreCalls).toEqual([]);
  expect(result.restored).toMatchObject({
    status: "rejected",
    summary: {
      total: 3,
      restored: 0,
      unchanged: 0,
      conflicts: 0,
      rejected: 1,
      failed: 0,
      notAttempted: 2
    }
  });
  expect(result.restored.items).toContainEqual(expect.objectContaining({
    entity: "favoriteLearningStates",
    favoriteId: missingFavoriteId,
    status: "rejected",
    relationshipStatus: "unresolved",
    written: false
  }));
  expect(result.restored.errors).toContainEqual(expect.objectContaining({
    code: "unresolved-favorite-reference",
    entity: "favoriteLearningStates",
    favoriteId: missingFavoriteId
  }));
});

const schemaRejectionCases = [
  {
    name: "Article",
    entity: "articles",
    invalidate(data) {
      delete data.articles[0].title;
    }
  },
  {
    name: "Favorite",
    entity: "favorites",
    invalidate(data) {
      data.favorites[0].type = "sentence";
    }
  },
  {
    name: "Favorite lemma mixed batch",
    entity: "favorites",
    invalidate(data) {
      data.favorites.push(makeFavorite("favorite:schema-rejected-nested-lemma", {
        futureMetadata: { nested: { lemma: "derived" } }
      }));
    }
  },
  {
    name: "Learning State",
    entity: "favoriteLearningStates",
    invalidate(data) {
      data.favoriteLearningStates[0].mastered = "false";
    }
  }
];

for (const schemaCase of schemaRejectionCases) {
  test(`${schemaCase.name} Schema rejection causes global zero writes`, async ({ page }) => {
    await loadBackupEnvironment(page);
    const data = makeThreeEntityData(`schema-rejected-${schemaCase.entity}`);
    schemaCase.invalidate(data);
    const totalRecords = Object.values(data)
      .reduce((total, records) => total + records.length, 0);
    const envelope = makeEnvelope(data);

    const result = await page.evaluate(async incoming => {
      const originalArticleLibrary = window.LingoFlowArticleLibrary;
      const originalFavoriteRepository = window.LingoFlowFavoriteRepository;
      const originalLearningRepository = window.LingoFlowFavoriteLearningRepository;
      const calls = { assess: [], restore: [] };

      window.LingoFlowArticleLibrary = Object.freeze({
        ...originalArticleLibrary,
        assessArticleRestore: async article => {
          calls.assess.push("articles");
          return originalArticleLibrary.assessArticleRestore(article);
        },
        restoreArticle: async article => {
          calls.restore.push("articles");
          return originalArticleLibrary.restoreArticle(article);
        }
      });
      window.LingoFlowFavoriteRepository = Object.freeze({
        ...originalFavoriteRepository,
        assessBackupRestore: favorite => {
          calls.assess.push("favorites");
          return originalFavoriteRepository.assessBackupRestore(favorite);
        },
        restoreBackupRecords: favorites => {
          calls.restore.push("favorites");
          return originalFavoriteRepository.restoreBackupRecords(favorites);
        }
      });
      window.LingoFlowFavoriteLearningRepository = Object.freeze({
        ...originalLearningRepository,
        assessBackupRestore: state => {
          calls.assess.push("favoriteLearningStates");
          return originalLearningRepository.assessBackupRestore(state);
        },
        restoreBackupRecords: states => {
          calls.restore.push("favoriteLearningStates");
          return originalLearningRepository.restoreBackupRecords(states);
        }
      });

      const restored = await window.LingoFlowBackupV2.restoreBackup(incoming.envelope);
      const stored = {
        articles: await originalArticleLibrary.listArticles({ includeDeleted: true }),
        favorites: originalFavoriteRepository.list({ includeDeleted: true }),
        favoriteLearningStates: originalLearningRepository.list({ includeDeleted: true })
      };
      return { restored, calls, stored };
    }, { envelope });

    expect(result.restored.status).toBe("rejected");
    expect(result.restored.summary).toMatchObject({
      total: totalRecords,
      restored: 0,
      failed: 0
    });
    expect(result.restored.errors).toContainEqual(expect.objectContaining({
      entity: schemaCase.entity
    }));
    expect(result.calls).toEqual({ assess: [], restore: [] });
    expect(result.stored).toEqual({
      articles: [],
      favorites: [],
      favoriteLearningStates: []
    });
  });
}

test("restoreBackup rejects an unregistered entity before Schema or Domain access", async ({ page }) => {
  await loadBackupEnvironment(page);
  const envelope = {
    format: { name: "LingoFlow Backup", version: 2 },
    metadata: {},
    schema: { articles: "1", queryEvents: "1" },
    data: { articles: [], queryEvents: [] }
  };

  const result = await page.evaluate(async incoming => {
    const calls = [];
    const articleSchema = window.LingoFlowBackupV2Schema;
    const favoriteSchema = window.LingoFlowFavoriteBackupSchema;
    const learningSchema = window.LingoFlowFavoriteLearningBackupSchema;
    const articleLibrary = window.LingoFlowArticleLibrary;
    const favoriteRepository = window.LingoFlowFavoriteRepository;
    const learningRepository = window.LingoFlowFavoriteLearningRepository;

    window.LingoFlowBackupV2Schema = Object.freeze({
      ...articleSchema,
      validateArticles: articles => {
        calls.push("schema:articles");
        return articleSchema.validateArticles(articles);
      }
    });
    window.LingoFlowFavoriteBackupSchema = Object.freeze({
      ...favoriteSchema,
      validateFavorites: favorites => {
        calls.push("schema:favorites");
        return favoriteSchema.validateFavorites(favorites);
      }
    });
    window.LingoFlowFavoriteLearningBackupSchema = Object.freeze({
      ...learningSchema,
      validateFavoriteLearningStates: states => {
        calls.push("schema:favoriteLearningStates");
        return learningSchema.validateFavoriteLearningStates(states);
      }
    });
    window.LingoFlowArticleLibrary = Object.freeze({
      ...articleLibrary,
      assessArticleRestore: async article => {
        calls.push("assess:articles");
        return articleLibrary.assessArticleRestore(article);
      },
      restoreArticle: async article => {
        calls.push("restore:articles");
        return articleLibrary.restoreArticle(article);
      }
    });
    window.LingoFlowFavoriteRepository = Object.freeze({
      ...favoriteRepository,
      assessBackupRestore: favorite => {
        calls.push("assess:favorites");
        return favoriteRepository.assessBackupRestore(favorite);
      },
      restoreBackupRecords: favorites => {
        calls.push("restore:favorites");
        return favoriteRepository.restoreBackupRecords(favorites);
      }
    });
    window.LingoFlowFavoriteLearningRepository = Object.freeze({
      ...learningRepository,
      assessBackupRestore: state => {
        calls.push("assess:favoriteLearningStates");
        return learningRepository.assessBackupRestore(state);
      },
      restoreBackupRecords: states => {
        calls.push("restore:favoriteLearningStates");
        return learningRepository.restoreBackupRecords(states);
      }
    });

    return {
      restored: await window.LingoFlowBackupV2.restoreBackup(incoming),
      calls
    };
  }, envelope);

  expect(result.restored.status).toBe("rejected");
  expect(result.restored.errors).toContainEqual({
    code: "unsupported-entity",
    path: "data.queryEvents",
    entity: "queryEvents"
  });
  expect(result.calls).toEqual([]);
  expect(await readStoredDomains(page)).toEqual({
    articles: [],
    favorites: [],
    favoriteLearningStates: []
  });
});

test("restoreBackup completes every Schema and Domain Assessment before explicit writes", async ({ page }) => {
  await loadBackupEnvironment(page);
  const data = makeThreeEntityData("phase-order");

  const result = await page.evaluate(async incoming => {
    const built = window.LingoFlowBackupV2Envelope.buildEnvelope(incoming.data);
    const calls = [];
    const restoredPayloads = {
      articles: [],
      favorites: null,
      favoriteLearningStates: null
    };
    const envelope = window.LingoFlowBackupV2Envelope;
    const articleSchema = window.LingoFlowBackupV2Schema;
    const favoriteSchema = window.LingoFlowFavoriteBackupSchema;
    const learningSchema = window.LingoFlowFavoriteLearningBackupSchema;
    const articleLibrary = window.LingoFlowArticleLibrary;
    const favoriteRepository = window.LingoFlowFavoriteRepository;
    const learningRepository = window.LingoFlowFavoriteLearningRepository;

    window.LingoFlowBackupV2Envelope = Object.freeze({
      ...envelope,
      validateEnvelope: value => {
        calls.push("envelope:validate");
        return envelope.validateEnvelope(value);
      },
      unwrapEnvelope: value => {
        calls.push("envelope:unwrap");
        return envelope.unwrapEnvelope(value);
      }
    });
    window.LingoFlowBackupV2Schema = Object.freeze({
      ...articleSchema,
      validateArticles: articles => {
        calls.push("schema:articles");
        return articleSchema.validateArticles(articles);
      }
    });
    window.LingoFlowFavoriteBackupSchema = Object.freeze({
      ...favoriteSchema,
      validateFavorites: favorites => {
        calls.push("schema:favorites");
        return favoriteSchema.validateFavorites(favorites);
      }
    });
    window.LingoFlowFavoriteLearningBackupSchema = Object.freeze({
      ...learningSchema,
      validateFavoriteLearningStates: states => {
        calls.push("schema:favoriteLearningStates");
        return learningSchema.validateFavoriteLearningStates(states);
      }
    });
    window.LingoFlowArticleLibrary = Object.freeze({
      ...articleLibrary,
      assessArticleRestore: async article => {
        calls.push("assess:articles");
        return articleLibrary.assessArticleRestore(article);
      },
      restoreArticle: async article => {
        calls.push("restore:articles");
        restoredPayloads.articles.push(structuredClone(article));
        return articleLibrary.restoreArticle(article);
      }
    });
    window.LingoFlowFavoriteRepository = Object.freeze({
      ...favoriteRepository,
      assessBackupRestore: favorite => {
        calls.push("assess:favorites");
        return favoriteRepository.assessBackupRestore(favorite);
      },
      restoreBackupRecords: favorites => {
        calls.push("restore:favorites");
        restoredPayloads.favorites = structuredClone(favorites);
        return favoriteRepository.restoreBackupRecords(favorites);
      }
    });
    window.LingoFlowFavoriteLearningRepository = Object.freeze({
      ...learningRepository,
      assessBackupRestore: state => {
        calls.push("assess:favoriteLearningStates");
        return learningRepository.assessBackupRestore(state);
      },
      restoreBackupRecords: states => {
        calls.push("restore:favoriteLearningStates");
        restoredPayloads.favoriteLearningStates = structuredClone(states);
        return learningRepository.restoreBackupRecords(states);
      }
    });

    const restored = await window.LingoFlowBackupV2.restoreBackup(built.envelope);
    return { buildStatus: built.status, restored, calls, restoredPayloads };
  }, { data });

  expect(result.buildStatus).toBe("ready");
  expect(result.restored).toMatchObject({
    status: "completed",
    summary: { total: 3, restored: 3 }
  });
  expect(result.calls.slice(0, 5)).toEqual([
    "envelope:validate",
    "envelope:unwrap",
    "schema:articles",
    "schema:favorites",
    "schema:favoriteLearningStates"
  ]);

  const firstAssessmentIndexes = [
    "assess:articles",
    "assess:favorites",
    "assess:favoriteLearningStates"
  ].map(value => result.calls.indexOf(value));
  expect(firstAssessmentIndexes.every(index => index >= 0)).toBe(true);
  expect(firstAssessmentIndexes[0]).toBeLessThan(firstAssessmentIndexes[1]);
  expect(firstAssessmentIndexes[1]).toBeLessThan(firstAssessmentIndexes[2]);

  const firstWriteIndex = result.calls.findIndex(value => value.startsWith("restore:"));
  const lastAssessmentIndex = result.calls.reduce((last, value, index) => (
    value.startsWith("assess:") ? index : last
  ), -1);
  expect(firstWriteIndex).toBeGreaterThan(lastAssessmentIndex);
  expect(result.restoredPayloads).toEqual({
    articles: data.articles,
    favorites: data.favorites,
    favoriteLearningStates: data.favoriteLearningStates
  });
});

test("a malformed completed Domain result interrupts dispatch instead of reporting success", async ({ page }) => {
  await loadBackupEnvironment(page);
  const data = makeThreeEntityData("malformed-domain-result");

  const result = await page.evaluate(async incoming => {
    const built = window.LingoFlowBackupV2Envelope.buildEnvelope(incoming.data);
    const favoriteRepository = window.LingoFlowFavoriteRepository;
    const learningRepository = window.LingoFlowFavoriteLearningRepository;
    const restoreCalls = [];

    window.LingoFlowFavoriteRepository = Object.freeze({
      ...favoriteRepository,
      restoreBackupRecords: favorites => {
        restoreCalls.push("favorites");
        return {
          status: "completed",
          summary: {
            total: favorites.length,
            restored: favorites.length,
            unchanged: 0,
            conflicts: 0,
            rejected: 0,
            failed: 0,
            notAttempted: 0
          },
          items: favorites.map((favorite, index) => ({
            index,
            favoriteId: favorite.id,
            status: "restored",
            written: false
          })),
          errors: []
        };
      }
    });
    window.LingoFlowFavoriteLearningRepository = Object.freeze({
      ...learningRepository,
      restoreBackupRecords: states => {
        restoreCalls.push("favoriteLearningStates");
        return learningRepository.restoreBackupRecords(states);
      }
    });

    const restored = await window.LingoFlowBackupV2.restoreBackup(built.envelope);
    return {
      restored,
      restoreCalls,
      favorite: favoriteRepository.getById(incoming.data.favorites[0].id, {
        includeDeleted: true
      }),
      learningState: learningRepository.get(
        incoming.data.favoriteLearningStates[0].favoriteId,
        { includeDeleted: true }
      )
    };
  }, { data });

  expect(result.restoreCalls).toEqual(["favorites"]);
  expect(result.restored).toMatchObject({
    status: "interrupted",
    summary: {
      total: 3,
      restored: 1,
      failed: 1,
      notAttempted: 1
    },
    errors: [{
      code: "favorites-restore-failed",
      entity: "favorites",
      message: "favorites Domain 返回了无效的恢复结果。"
    }]
  });
  expect(result.favorite).toBeNull();
  expect(result.learningState).toBeNull();
});

test("a malformed second Article result preserves the first confirmed write", async ({ page }) => {
  await loadBackupEnvironment(page);
  const data = makeThreeEntityData("malformed-second-article");
  data.articles = [
    makeArticle("article:malformed-second-first"),
    makeArticle("article:malformed-second-invalid")
  ];

  const result = await page.evaluate(async incoming => {
    const built = window.LingoFlowBackupV2Envelope.buildEnvelope(incoming.data);
    const articleLibrary = window.LingoFlowArticleLibrary;
    const favoriteRepository = window.LingoFlowFavoriteRepository;
    const learningRepository = window.LingoFlowFavoriteLearningRepository;
    const restoreCalls = [];

    window.LingoFlowArticleLibrary = Object.freeze({
      ...articleLibrary,
      restoreArticle: async article => {
        restoreCalls.push(`articles:${article.id}`);
        if (article.id === incoming.data.articles[1].id) {
          return {
            status: "restored",
            articleId: "article:wrong-identity",
            written: true
          };
        }
        return articleLibrary.restoreArticle(article);
      }
    });
    window.LingoFlowFavoriteRepository = Object.freeze({
      ...favoriteRepository,
      restoreBackupRecords: favorites => {
        restoreCalls.push("favorites");
        return favoriteRepository.restoreBackupRecords(favorites);
      }
    });
    window.LingoFlowFavoriteLearningRepository = Object.freeze({
      ...learningRepository,
      restoreBackupRecords: states => {
        restoreCalls.push("favoriteLearningStates");
        return learningRepository.restoreBackupRecords(states);
      }
    });

    const restored = await window.LingoFlowBackupV2.restoreBackup(built.envelope);
    return {
      restored,
      restoreCalls,
      stored: {
        articles: await articleLibrary.listArticles({ includeDeleted: true }),
        favorites: favoriteRepository.list({ includeDeleted: true }),
        favoriteLearningStates: learningRepository.list({ includeDeleted: true })
      }
    };
  }, { data });

  expect(result.restoreCalls).toEqual([
    `articles:${data.articles[0].id}`,
    `articles:${data.articles[1].id}`
  ]);
  expect(result.restored).toMatchObject({
    status: "interrupted",
    summary: {
      total: 4,
      restored: 1,
      unchanged: 0,
      conflicts: 0,
      rejected: 0,
      failed: 1,
      notAttempted: 2
    }
  });
  expect(result.restored.items).toEqual([
    expect.objectContaining({
      entity: "articles",
      articleId: data.articles[0].id,
      status: "restored",
      written: true
    }),
    expect.objectContaining({
      entity: "articles",
      articleId: data.articles[1].id,
      status: "failed",
      written: false
    }),
    expect.objectContaining({
      entity: "favorites",
      favoriteId: data.favorites[0].id,
      status: "not-attempted",
      written: false
    }),
    expect.objectContaining({
      entity: "favoriteLearningStates",
      favoriteId: data.favoriteLearningStates[0].favoriteId,
      status: "not-attempted",
      written: false
    })
  ]);
  expect(result.restored.errors).toContainEqual(expect.objectContaining({
    code: "article-restore-failed",
    entity: "articles",
    articleId: data.articles[1].id,
    message: "Article Library 返回了无效的恢复结果。"
  }));
  expect(result.stored).toEqual({
    articles: [data.articles[0]],
    favorites: [],
    favoriteLearningStates: []
  });
});

test("Favorite initial storage read failure preserves partial restore identities", async ({ page }) => {
  await loadBackupEnvironment(page);
  const data = makeThreeEntityData("favorite-read-failure");

  const result = await page.evaluate(async incoming => {
    const built = window.LingoFlowBackupV2Envelope.buildEnvelope(incoming.data);
    const articleLibrary = window.LingoFlowArticleLibrary;
    const favoriteRepository = window.LingoFlowFavoriteRepository;
    const learningRepository = window.LingoFlowFavoriteLearningRepository;
    const restoreCalls = [];

    window.LingoFlowArticleLibrary = Object.freeze({
      ...articleLibrary,
      restoreArticle: async article => {
        restoreCalls.push("articles");
        return articleLibrary.restoreArticle(article);
      }
    });
    window.LingoFlowFavoriteRepository = Object.freeze({
      ...favoriteRepository,
      restoreBackupRecords: favorites => {
        restoreCalls.push("favorites");
        const storagePrototype = Object.getPrototypeOf(localStorage);
        const originalGetItem = storagePrototype.getItem;
        storagePrototype.getItem = function(key) {
          if (key === "LingoFlowFavoriteEntities") {
            throw new Error("favorite storage unavailable");
          }
          return originalGetItem.call(this, key);
        };
        try {
          return favoriteRepository.restoreBackupRecords(favorites);
        } finally {
          storagePrototype.getItem = originalGetItem;
        }
      }
    });
    window.LingoFlowFavoriteLearningRepository = Object.freeze({
      ...learningRepository,
      restoreBackupRecords: states => {
        restoreCalls.push("favoriteLearningStates");
        return learningRepository.restoreBackupRecords(states);
      }
    });

    const restored = await window.LingoFlowBackupV2.restoreBackup(built.envelope);
    return {
      restored,
      restoreCalls,
      stored: {
        articles: await articleLibrary.listArticles({ includeDeleted: true }),
        favorites: favoriteRepository.list({ includeDeleted: true }),
        favoriteLearningStates: learningRepository.list({ includeDeleted: true })
      }
    };
  }, { data });

  expect(result.restoreCalls).toEqual(["articles", "favorites"]);
  expect(result.restored).toMatchObject({
    status: "interrupted",
    summary: {
      total: 3,
      restored: 1,
      unchanged: 0,
      conflicts: 0,
      rejected: 0,
      failed: 0,
      notAttempted: 2
    }
  });
  expect(result.restored.items).toEqual([
    expect.objectContaining({
      entity: "articles",
      articleId: data.articles[0].id,
      status: "restored",
      written: true
    }),
    expect.objectContaining({
      entity: "favorites",
      favoriteId: data.favorites[0].id,
      status: "not-attempted",
      written: false
    }),
    expect.objectContaining({
      entity: "favoriteLearningStates",
      favoriteId: data.favoriteLearningStates[0].favoriteId,
      status: "not-attempted",
      written: false
    })
  ]);
  expect(result.restored.errors).toContainEqual(expect.objectContaining({
    code: "favorite-storage-read-failed",
    entity: "favorites",
    message: "favorite storage unavailable"
  }));
  expect(result.stored).toEqual({
    articles: [data.articles[0]],
    favorites: [],
    favoriteLearningStates: []
  });
});
