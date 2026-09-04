const { test, expect } = require("@playwright/test");

const LEGACY_STORAGE_KEY = "EnglishReaderV051Favorites";
const ENTITY_STORAGE_KEY = "LingoFlowFavoriteEntities";
const projectErrors = new WeakMap();

function makeBackupFavorite(overrides = {}) {
  return {
    id: "favorite:backup-default",
    type: "word",
    text: "backup favorite",
    meaning: "A preserved Favorite snapshot.",
    createdAt: "2026-08-20T01:00:00.000Z",
    updatedAt: "2026-08-20T02:00:00.000Z",
    deletedAt: null,
    ...overrides
  };
}

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
  expect(await page.evaluate(() => typeof window.LingoFlowFavoriteRepository)).toBe("object");
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

test("Repository 使用新存储边界并完全忽略旧 Favorite 数据", async ({ page }) => {
  const result = await page.evaluate(({ legacyKey, entityKey }) => {
    const legacyRaw = JSON.stringify({
      develop: {
        word: "develop",
        meaning: "旧收藏",
        createdAt: "2026-01-01T00:00:00.000Z"
      }
    });
    localStorage.setItem(legacyKey, legacyRaw);

    const repository = window.LingoFlowFavoriteRepository;
    const before = repository.list();
    const created = repository.create({ type: "word", text: "develop" });
    const stored = JSON.parse(localStorage.getItem(entityKey));

    return {
      before,
      created,
      legacyUnchanged: localStorage.getItem(legacyKey) === legacyRaw,
      storedIds: Object.keys(stored),
      storedFavorite: stored[created.id],
      frozen: Object.isFrozen(repository),
      destructiveApis: {
        clear: typeof repository.clear,
        remove: typeof repository.remove,
        purge: typeof repository.purge,
        setAll: typeof repository.setAll
      }
    };
  }, { legacyKey: LEGACY_STORAGE_KEY, entityKey: ENTITY_STORAGE_KEY });

  expect(result.before).toEqual([]);
  expect(result.legacyUnchanged).toBe(true);
  expect(result.created.id).toMatch(/^favorite:/);
  expect(result.created.id).not.toBe("develop");
  expect(result.storedIds).toEqual([result.created.id]);
  expect(result.storedFavorite).toEqual(result.created);
  expect(result.frozen).toBe(true);
  expect(result.destructiveApis).toEqual({
    clear: "undefined",
    remove: "undefined",
    purge: "undefined",
    setAll: "undefined"
  });
});

test("创建 word 和 phrase 会生成独立稳定 ID 并保留内容快照", async ({ page }) => {
  const result = await page.evaluate(() => {
    const repository = window.LingoFlowFavoriteRepository;
    const input = {
      type: "word",
      text: "Develop",
      displayText: "Develop",
      phonetic: "/dɪˈveləp/",
      partOfSpeech: "verb",
      meaning: "发展；培养",
      context: "People develop skills through practice.",
      note: "重点词汇",
      tags: ["learning"],
      origin: {
        kind: "article",
        articleId: "article:not-present-locally",
        articleTitleSnapshot: "Learning",
        futureSourceField: { paragraph: 2 }
      },
      futureMetadata: { labels: ["important"] }
    };
    const before = JSON.stringify(input);
    const first = repository.create(input);
    const afterCreate = JSON.stringify(input);
    const second = repository.create({ type: "word", text: "Develop" });
    const phrase = repository.create({
      type: "phrase",
      text: "make progress",
      context: "Students make progress through practice."
    });

    input.tags.push("changed-outside");
    input.origin.futureSourceField.paragraph = 99;
    input.futureMetadata.labels.push("changed-outside");

    return {
      before,
      afterCreate,
      first,
      second,
      phrase,
      persistedFirst: repository.getById(first.id),
      total: repository.count()
    };
  });

  expect(result.afterCreate).toBe(result.before);
  expect(result.first).toMatchObject({
    type: "word",
    text: "Develop",
    meaning: "发展；培养",
    deletedAt: null,
    futureMetadata: { labels: ["important"] },
    origin: {
      kind: "article",
      articleId: "article:not-present-locally",
      futureSourceField: { paragraph: 2 }
    }
  });
  expect(result.first.createdAt).toBe(result.first.updatedAt);
  expect(Number.isFinite(Date.parse(result.first.createdAt))).toBe(true);
  expect(result.second.id).not.toBe(result.first.id);
  expect(result.phrase.id).not.toBe(result.first.id);
  expect(result.phrase.type).toBe("phrase");
  expect(result.persistedFirst).toEqual(result.first);
  expect(result.total).toBe(3);
});

test("内容查询只用于查找，不会合并相同文本或混淆类型", async ({ page }) => {
  const result = await page.evaluate(() => {
    const repository = window.LingoFlowFavoriteRepository;
    const first = repository.create({ type: "phrase", text: "Make   Progress" });
    const second = repository.create({ type: "phrase", text: "make progress" });
    const word = repository.create({ type: "word", text: "make progress" });
    const deleted = repository.softDelete(first.id);

    return {
      ids: { first: first.id, second: second.id, word: word.id },
      deleted,
      activePhraseIds: repository
        .findByContent({ type: "phrase", text: "MAKE PROGRESS" })
        .map(item => item.id),
      allPhraseIds: repository
        .findByContent({ type: "phrase", text: "make progress", includeDeleted: true })
        .map(item => item.id)
        .sort(),
      wordIds: repository
        .findByContent({ type: "word", text: "MAKE PROGRESS" })
        .map(item => item.id),
      activeCount: repository.count(),
      allCount: repository.count({ includeDeleted: true })
    };
  });

  expect(new Set(Object.values(result.ids)).size).toBe(3);
  expect(result.activePhraseIds).toEqual([result.ids.second]);
  expect(result.allPhraseIds).toEqual([result.ids.first, result.ids.second].sort());
  expect(result.wordIds).toEqual([result.ids.word]);
  expect(result.deleted.deletedAt).not.toBeNull();
  expect(result.activeCount).toBe(2);
  expect(result.allCount).toBe(3);
});

test("更新保留身份、创建时间和未知字段，并对无变化 patch 保持幂等", async ({ page }) => {
  const result = await page.evaluate(entityKey => {
    const repository = window.LingoFlowFavoriteRepository;
    const created = repository.create({
      type: "word",
      text: "develop",
      meaning: "发展",
      tags: ["initial"],
      origin: {
        kind: "article",
        articleId: "article:update-source",
        futureSourceField: { paragraph: 4 }
      },
      futureMetadata: { labels: ["keep"] }
    });
    const patch = {
      type: "phrase",
      meaning: "发展；培养",
      tags: ["updated"],
      origin: { articleTitleSnapshot: "Updated title" }
    };
    const updated = repository.update(created.id, patch);
    patch.tags.push("changed-outside");
    patch.origin.articleTitleSnapshot = "Changed outside";

    const storedAfterUpdate = localStorage.getItem(entityKey);
    const unchanged = repository.update(created.id, {
      meaning: updated.meaning,
      tags: updated.tags,
      origin: { articleTitleSnapshot: updated.origin.articleTitleSnapshot }
    });

    updated.futureMetadata.labels.push("changed-return-value");
    updated.origin.futureSourceField.paragraph = 99;

    return {
      created,
      updated,
      unchanged,
      persisted: repository.getById(created.id),
      storageUnchangedByNoop: localStorage.getItem(entityKey) === storedAfterUpdate
    };
  }, ENTITY_STORAGE_KEY);

  expect(result.updated.id).toBe(result.created.id);
  expect(result.updated.createdAt).toBe(result.created.createdAt);
  expect(Date.parse(result.updated.updatedAt)).toBeGreaterThan(Date.parse(result.created.updatedAt));
  expect(result.persisted).toMatchObject({
    type: "phrase",
    meaning: "发展；培养",
    tags: ["updated"],
    futureMetadata: { labels: ["keep"] },
    origin: {
      kind: "article",
      articleId: "article:update-source",
      articleTitleSnapshot: "Updated title",
      futureSourceField: { paragraph: 4 }
    }
  });
  expect(result.unchanged.updatedAt).toBe(result.updated.updatedAt);
  expect(result.storageUnchangedByNoop).toBe(true);
});

test("软删除和恢复保持原 ID 与内容，并且重复操作幂等", async ({ page }) => {
  const result = await page.evaluate(entityKey => {
    const repository = window.LingoFlowFavoriteRepository;
    const created = repository.create({
      type: "word",
      text: "recoverable",
      note: "必须保留",
      futureMetadata: { value: 7 }
    });
    const deleted = repository.softDelete(created.id);
    const rawAfterDelete = localStorage.getItem(entityKey);
    const hiddenWhileDeleted = repository.getById(created.id, { includeDeleted: false });
    const deletedAgain = repository.softDelete(created.id);
    const rawAfterDeleteAgain = localStorage.getItem(entityKey);
    let updateError = "";
    try {
      repository.update(created.id, { note: "不应写入" });
    } catch (error) {
      updateError = error.message;
    }
    const replacement = repository.create({ type: "word", text: "recoverable" });
    const restored = repository.restore(created.id);
    const rawAfterRestore = localStorage.getItem(entityKey);
    const restoredAgain = repository.restore(created.id);

    return {
      created,
      deleted,
      deletedAgain,
      replacement,
      restored,
      restoredAgain,
      updateError,
      rawDeleteIdempotent: rawAfterDelete === rawAfterDeleteAgain,
      rawRestoreIdempotent: rawAfterRestore === localStorage.getItem(entityKey),
      activeIds: repository.list().map(item => item.id).sort(),
      allIds: repository.list({ includeDeleted: true }).map(item => item.id).sort(),
      hiddenWhileDeleted,
      activeGet: repository.getById(created.id, { includeDeleted: false })
    };
  }, ENTITY_STORAGE_KEY);

  expect(result.deleted.id).toBe(result.created.id);
  expect(result.deleted.createdAt).toBe(result.created.createdAt);
  expect(result.deleted.deletedAt).toBe(result.deleted.updatedAt);
  expect(result.deleted.note).toBe("必须保留");
  expect(result.deleted.futureMetadata).toEqual({ value: 7 });
  expect(result.deletedAgain.deletedAt).toBe(result.deleted.deletedAt);
  expect(result.updateError).toContain("必须先恢复");
  expect(result.replacement.id).not.toBe(result.created.id);
  expect(result.restored.id).toBe(result.created.id);
  expect(result.restored.createdAt).toBe(result.created.createdAt);
  expect(result.restored.deletedAt).toBeNull();
  expect(Date.parse(result.restored.updatedAt)).toBeGreaterThan(Date.parse(result.deleted.updatedAt));
  expect(result.restoredAgain.updatedAt).toBe(result.restored.updatedAt);
  expect(result.activeIds).toEqual([result.created.id, result.replacement.id].sort());
  expect(result.allIds).toEqual(result.activeIds);
  expect(result.hiddenWhileDeleted).toBeNull();
  expect(result.activeGet).toEqual(result.restored);
  expect(result.rawDeleteIdempotent).toBe(true);
  expect(result.rawRestoreIdempotent).toBe(true);
});

test("实体边界拒绝生命周期注入、学习状态、派生状态和同步运行字段", async ({ page }) => {
  const result = await page.evaluate(() => {
    const repository = window.LingoFlowFavoriteRepository;
    const cases = [
      { type: "unknown", text: "invalid type" },
      { type: "word", text: "   " },
      { type: "word", text: "id injection", id: "favorite:provided" },
      { type: "word", text: "time injection", createdAt: "2020-01-01T00:00:00.000Z" },
      { type: "word", text: "learning", mastered: true },
      { type: "word", text: "learning count", reviewCount: 3 },
      { type: "word", text: "derived", dictionaryFound: true },
      { type: "word", text: "derived dictionary", dictionaryVersion: "v2" },
      { type: "word", text: "derived lemma", lemma: "derived" },
      { type: "word", text: "local index", normalizedKey: "local-index" },
      { type: "word", text: "sync", syncStatus: "dirty" },
      { type: "word", text: "nested learning", futureMetadata: { mastered: true } },
      { type: "word", text: "nested lemma", futureMetadata: { lemma: "derived" } },
      { type: "word", text: "tags", tags: ["ok", 1] },
      { type: "word", text: "origin", origin: { kind: "" } },
      { type: "word", text: "origin id", origin: { articleId: " article:space " } }
    ];
    const errors = cases.map(input => {
      try {
        repository.create(input);
        return "";
      } catch (error) {
        return error.message;
      }
    });

    let getterCalls = 0;
    const accessorInput = { type: "word" };
    Object.defineProperty(accessorInput, "text", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "getter text";
      }
    });
    let accessorError = "";
    try {
      repository.create(accessorInput);
    } catch (error) {
      accessorError = error.message;
    }

    const symbolInput = { type: "word", text: "symbol" };
    symbolInput[Symbol("hidden")] = "not-json";
    let symbolError = "";
    try {
      repository.create(symbolInput);
    } catch (error) {
      symbolError = error.message;
    }

    const weakOrigin = repository.create({
      type: "word",
      text: "weak article association",
      origin: { articleId: "article:missing-locally" }
    });

    return {
      errors,
      getterCalls,
      accessorError,
      symbolError,
      weakOrigin,
      count: repository.count()
    };
  });

  expect(result.errors.every(Boolean)).toBe(true);
  expect(result.getterCalls).toBe(0);
  expect(result.accessorError).toContain("数据属性");
  expect(result.symbolError).toContain("Symbol");
  expect(result.weakOrigin.origin).toEqual({ articleId: "article:missing-locally" });
  expect(result.count).toBe(1);
});

test("特殊 ID、危险 JSON 属性和带 getter 的查询参数不会破坏存储", async ({ page }) => {
  const result = await page.evaluate(entityKey => {
    const repository = window.LingoFlowFavoriteRepository;
    const before = localStorage.getItem(entityKey);
    const specialIds = ["constructor", "toString", "__proto__"];
    const specialResults = specialIds.map(id => {
      let updateError = "";
      try {
        repository.update(id, { note: "must not write" });
      } catch (error) {
        updateError = error.message;
      }
      return {
        id,
        get: repository.getById(id),
        deleted: repository.softDelete(id),
        restored: repository.restore(id),
        updateError
      };
    });
    const afterSpecialIds = localStorage.getItem(entityKey);

    const created = repository.create({ type: "word", text: "safe extension" });
    const dangerousPatch = JSON.parse('{"__proto__":{"preserved":true}}');
    const updated = repository.update(created.id, dangerousPatch);
    const persisted = repository.getById(created.id);

    let idToStringCalls = 0;
    const idObject = {
      toString() {
        idToStringCalls += 1;
        return created.id;
      }
    };
    const objectIdResult = repository.getById(idObject);

    let queryGetterCalls = 0;
    const query = { text: "safe extension" };
    Object.defineProperty(query, "type", {
      enumerable: true,
      get() {
        queryGetterCalls += 1;
        return "word";
      }
    });
    let queryError = "";
    try {
      repository.findByContent(query);
    } catch (error) {
      queryError = error.message;
    }

    let optionsGetterCalls = 0;
    const options = {};
    Object.defineProperty(options, "includeDeleted", {
      enumerable: true,
      get() {
        optionsGetterCalls += 1;
        return true;
      }
    });
    let optionsError = "";
    try {
      repository.list(options);
    } catch (error) {
      optionsError = error.message;
    }

    return {
      before,
      afterSpecialIds,
      specialResults,
      updatedHasProto: Object.prototype.hasOwnProperty.call(updated, "__proto__"),
      updatedProtoValue: updated.__proto__,
      persistedHasProto: Object.prototype.hasOwnProperty.call(persisted, "__proto__"),
      persistedProtoValue: persisted.__proto__,
      idToStringCalls,
      objectIdResult,
      queryGetterCalls,
      queryError,
      optionsGetterCalls,
      optionsError
    };
  }, ENTITY_STORAGE_KEY);

  expect(result.afterSpecialIds).toBe(result.before);
  for (const item of result.specialResults) {
    expect(item.get).toBeNull();
    expect(item.deleted).toBeNull();
    expect(item.restored).toBeNull();
    expect(item.updateError).toContain("不存在");
  }
  expect(result.updatedHasProto).toBe(true);
  expect(result.updatedProtoValue).toEqual({ preserved: true });
  expect(result.persistedHasProto).toBe(true);
  expect(result.persistedProtoValue).toEqual({ preserved: true });
  expect(result.idToStringCalls).toBe(0);
  expect(result.objectIdResult).toBeNull();
  expect(result.queryGetterCalls).toBe(0);
  expect(result.queryError).toContain("数据属性");
  expect(result.optionsGetterCalls).toBe(0);
  expect(result.optionsError).toContain("数据属性");
});

test("新 Favorite 在页面重新加载后仍可从 localStorage 读取", async ({ page }) => {
  const created = await page.evaluate(() => (
    window.LingoFlowFavoriteRepository.create({
      type: "phrase",
      text: "local first",
      context: "LingoFlow remains local first.",
      futureMetadata: { preserved: true }
    })
  ));

  await page.reload();
  await expect(page.locator("#inputText")).toBeVisible();
  expect(await page.evaluate(() => typeof window.LingoFlowFavoriteRepository)).toBe("object");

  const restored = await page.evaluate(id => (
    window.LingoFlowFavoriteRepository.getById(id)
  ), created.id);

  expect(restored).toEqual(created);
  expect(restored.futureMetadata).toEqual({ preserved: true });
});

test("损坏的新存储会显式失败且不会被创建操作覆盖", async ({ page }) => {
  const result = await page.evaluate(entityKey => {
    const repository = window.LingoFlowFavoriteRepository;
    const corrupted = "{not valid json";
    localStorage.setItem(entityKey, corrupted);

    let readError = "";
    let createError = "";
    try {
      repository.list();
    } catch (error) {
      readError = error.message;
    }
    try {
      repository.create({ type: "word", text: "must not overwrite" });
    } catch (error) {
      createError = error.message;
    }

    return {
      readError,
      createError,
      raw: localStorage.getItem(entityKey)
    };
  }, ENTITY_STORAGE_KEY);

  expect(result.readError).toContain("损坏");
  expect(result.createError).toContain("损坏");
  expect(result.raw).toBe("{not valid json");
});

test("删除时间早于创建时间的 tombstone 会被拒绝且不会覆盖原数据", async ({ page }) => {
  const result = await page.evaluate(entityKey => {
    const repository = window.LingoFlowFavoriteRepository;
    const id = "favorite:invalid-lifecycle";
    const raw = JSON.stringify({
      [id]: {
        id,
        type: "word",
        text: "invalid lifecycle",
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
        deletedAt: "2026-01-01T00:00:00.000Z"
      }
    });
    localStorage.setItem(entityKey, raw);

    let readError = "";
    let createError = "";
    try {
      repository.list({ includeDeleted: true });
    } catch (error) {
      readError = error.message;
    }
    try {
      repository.create({ type: "word", text: "must not overwrite" });
    } catch (error) {
      createError = error.message;
    }

    return {
      readError,
      createError,
      rawUnchanged: localStorage.getItem(entityKey) === raw
    };
  }, ENTITY_STORAGE_KEY);

  expect(result.readError).toContain("生命周期时间顺序无效");
  expect(result.createError).toContain("生命周期时间顺序无效");
  expect(result.rawUnchanged).toBe(true);
});

test("Backup Domain 原样恢复 active 与 tombstone，并允许不同 ID 的相同内容", async ({ page }) => {
  const active = makeBackupFavorite({
    id: "favorite:backup-active",
    futureMetadata: { preserved: ["active"] }
  });
  const tombstone = makeBackupFavorite({
    id: "favorite:backup-tombstone",
    updatedAt: "2026-08-20T03:00:00.000Z",
    deletedAt: "2026-08-20T02:30:00.000Z",
    futureMetadata: { preserved: ["deleted"] }
  });

  const result = await page.evaluate(({ activeRecord, deletedRecord }) => {
    const repository = window.LingoFlowFavoriteRepository;
    const input = [activeRecord, deletedRecord];
    const before = JSON.stringify(input);
    const assessment = repository.assessBackupRestore(activeRecord);
    const restored = repository.restoreBackupRecords(input);
    const after = JSON.stringify(input);
    return {
      assessment,
      restored,
      stored: repository.list({ includeDeleted: true }),
      active: repository.getById(activeRecord.id, { includeDeleted: true }),
      tombstone: repository.getById(deletedRecord.id, { includeDeleted: true }),
      inputUnchanged: before === after,
      methods: {
        assessBackupRestore: typeof repository.assessBackupRestore,
        restoreBackupRecords: typeof repository.restoreBackupRecords
      }
    };
  }, { activeRecord: active, deletedRecord: tombstone });

  expect(result.methods).toEqual({
    assessBackupRestore: "function",
    restoreBackupRecords: "function"
  });
  expect(result.assessment).toEqual({
    status: "restored",
    favoriteId: active.id,
    written: false,
    conflicts: [],
    conflictFields: []
  });
  expect(result.restored.status).toBe("completed");
  expect(result.restored.summary).toEqual({
    total: 2,
    restored: 2,
    unchanged: 0,
    conflicts: 0,
    rejected: 0,
    failed: 0,
    notAttempted: 0
  });
  expect(result.active).toEqual(active);
  expect(result.tombstone).toEqual(tombstone);
  expect(result.stored).toHaveLength(2);
  expect(result.inputUnchanged).toBe(true);
});

test("Favorite Backup exact match 返回 unchanged，重复恢复保持幂等", async ({ page }) => {
  const incoming = makeBackupFavorite({
    id: "favorite:backup-idempotent",
    type: "phrase",
    text: "stay idempotent",
    origin: {
      kind: "article",
      articleId: "article:not-required",
      futureSourceField: { paragraph: 3 }
    },
    futureMetadata: { version: 2 }
  });

  const result = await page.evaluate(({ record, entityKey }) => {
    const repository = window.LingoFlowFavoriteRepository;
    const first = repository.restoreBackupRecords([record]);
    const rawAfterFirst = localStorage.getItem(entityKey);
    const assessment = repository.assessBackupRestore(record);
    const second = repository.restoreBackupRecords([record]);
    return {
      first,
      assessment,
      second,
      stored: repository.getById(record.id, { includeDeleted: true }),
      rawUnchanged: localStorage.getItem(entityKey) === rawAfterFirst
    };
  }, { record: incoming, entityKey: ENTITY_STORAGE_KEY });

  expect(result.first.items[0]).toMatchObject({
    status: "restored",
    favoriteId: incoming.id,
    written: true
  });
  expect(result.assessment).toMatchObject({
    status: "unchanged",
    favoriteId: incoming.id,
    written: false
  });
  expect(result.second.status).toBe("completed");
  expect(result.second.summary).toMatchObject({ restored: 0, unchanged: 1, conflicts: 0 });
  expect(result.second.items[0]).toMatchObject({ status: "unchanged", written: false });
  expect(result.stored).toEqual(incoming);
  expect(result.rawUnchanged).toBe(true);
});

test("Favorite Backup 同 ID 差异返回 conflict，且不阻止不同 ID 同内容恢复", async ({ page }) => {
  const localContent = makeBackupFavorite({ id: "favorite:backup-content-conflict" });
  const localLifecycle = makeBackupFavorite({ id: "favorite:backup-lifecycle-conflict" });
  const incomingContent = {
    ...localContent,
    meaning: "Conflicting backup meaning."
  };
  const incomingLifecycle = {
    ...localLifecycle,
    updatedAt: "2026-08-20T04:00:00.000Z",
    deletedAt: "2026-08-20T03:00:00.000Z"
  };
  const sameContentNewId = makeBackupFavorite({ id: "favorite:backup-same-content-new-id" });

  const result = await page.evaluate(records => {
    const repository = window.LingoFlowFavoriteRepository;
    repository.restoreBackupRecords([records.localContent, records.localLifecycle]);
    const contentAssessment = repository.assessBackupRestore(records.incomingContent);
    const lifecycleAssessment = repository.assessBackupRestore(records.incomingLifecycle);
    const restored = repository.restoreBackupRecords([
      records.incomingContent,
      records.incomingLifecycle,
      records.sameContentNewId
    ]);
    return {
      contentAssessment,
      lifecycleAssessment,
      restored,
      contentStored: repository.getById(records.localContent.id, { includeDeleted: true }),
      lifecycleStored: repository.getById(records.localLifecycle.id, { includeDeleted: true }),
      newStored: repository.getById(records.sameContentNewId.id, { includeDeleted: true })
    };
  }, { localContent, localLifecycle, incomingContent, incomingLifecycle, sameContentNewId });

  expect(result.contentAssessment).toMatchObject({
    status: "conflict",
    written: false,
    conflicts: ["content"],
    conflictFields: ["meaning"]
  });
  expect(result.lifecycleAssessment).toMatchObject({
    status: "conflict",
    written: false,
    conflicts: ["lifecycle"],
    conflictFields: ["deletedAt", "updatedAt"]
  });
  expect(result.restored.status).toBe("completed-with-conflicts");
  expect(result.restored.summary).toMatchObject({ restored: 1, unchanged: 0, conflicts: 2 });
  expect(result.contentStored).toEqual(localContent);
  expect(result.lifecycleStored).toEqual(localLifecycle);
  expect(result.newStored).toEqual(sameContentNewId);
});

test("Favorite Backup 批次任一记录非法或 identity 重复时整批零写入", async ({ page }) => {
  const valid = makeBackupFavorite({ id: "favorite:backup-valid-not-written" });
  const invalid = makeBackupFavorite({
    id: "favorite:backup-invalid",
    type: "invalid"
  });

  const result = await page.evaluate(({ validRecord, invalidRecord, entityKey }) => {
    const repository = window.LingoFlowFavoriteRepository;
    const invalidBatch = repository.restoreBackupRecords([validRecord, invalidRecord]);
    const rawAfterInvalid = localStorage.getItem(entityKey);
    const duplicateBatch = repository.restoreBackupRecords([validRecord, { ...validRecord }]);
    return {
      invalidBatch,
      duplicateBatch,
      rawAfterInvalid,
      rawAfterDuplicate: localStorage.getItem(entityKey),
      all: repository.list({ includeDeleted: true })
    };
  }, { validRecord: valid, invalidRecord: invalid, entityKey: ENTITY_STORAGE_KEY });

  expect(result.invalidBatch.status).toBe("rejected");
  expect(result.invalidBatch.summary).toMatchObject({ restored: 0, rejected: 1, notAttempted: 1 });
  expect(result.duplicateBatch.status).toBe("rejected");
  expect(result.duplicateBatch.errors).toContainEqual(expect.objectContaining({
    code: "duplicate-favorite-id",
    favoriteId: valid.id
  }));
  expect(result.rawAfterInvalid).toBeNull();
  expect(result.rawAfterDuplicate).toBeNull();
  expect(result.all).toEqual([]);
});

test("Favorite Backup 批次递归拒绝 lemma 且整批零写入", async ({ page }) => {
  const valid = makeBackupFavorite({ id: "favorite:backup-valid-before-lemma" });
  const invalid = makeBackupFavorite({
    id: "favorite:backup-nested-lemma",
    futureMetadata: { nested: { lemma: "derived" } }
  });

  const result = await page.evaluate(({ records, entityKey }) => {
    const restored = window.LingoFlowFavoriteRepository.restoreBackupRecords(records);
    return {
      restored,
      raw: localStorage.getItem(entityKey)
    };
  }, { records: [valid, invalid], entityKey: ENTITY_STORAGE_KEY });

  expect(result.restored.status).toBe("rejected");
  expect(result.restored.summary).toMatchObject({
    restored: 0,
    rejected: 1,
    notAttempted: 1
  });
  expect(result.restored.items[1]).toMatchObject({
    favoriteId: invalid.id,
    status: "rejected",
    reason: "invalid-favorite",
    written: false
  });
  expect(result.raw).toBeNull();
});

test("Favorite Backup 初始存储读取失败时保留每项 identity 与具体错误", async ({ page }) => {
  const records = [
    makeBackupFavorite({ id: "favorite:backup-read-failure-a" }),
    makeBackupFavorite({ id: "favorite:backup-read-failure-b" })
  ];

  const result = await page.evaluate(({ incoming, entityKey }) => {
    const originalGetItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key) {
      if (key === entityKey) throw new DOMException("read blocked", "SecurityError");
      return originalGetItem.call(this, key);
    };
    try {
      const repository = window.LingoFlowFavoriteRepository;
      return {
        assessment: repository.assessBackupRestore(incoming[0]),
        restored: repository.restoreBackupRecords(incoming)
      };
    } finally {
      Storage.prototype.getItem = originalGetItem;
    }
  }, { incoming: records, entityKey: ENTITY_STORAGE_KEY });

  expect(result.assessment).toMatchObject({
    status: "rejected",
    favoriteId: records[0].id,
    written: false,
    reason: "favorite-storage-read-failed"
  });
  expect(result.restored.status).toBe("interrupted");
  expect(result.restored.summary).toMatchObject({
    total: 2,
    restored: 0,
    failed: 0,
    notAttempted: 2
  });
  expect(result.restored.items).toEqual([
    expect.objectContaining({
      index: 0,
      favoriteId: records[0].id,
      status: "not-attempted",
      written: false
    }),
    expect.objectContaining({
      index: 1,
      favoriteId: records[1].id,
      status: "not-attempted",
      written: false
    })
  ]);
  expect(result.restored.errors).toContainEqual(expect.objectContaining({
    code: "favorite-storage-read-failed",
    message: "read blocked"
  }));
});

test("Favorite Backup 存储写入失败时返回 interrupted 且不报告成功", async ({ page }) => {
  const incoming = makeBackupFavorite({ id: "favorite:backup-write-failure" });
  const result = await page.evaluate(({ record, entityKey }) => {
    const repository = window.LingoFlowFavoriteRepository;
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === entityKey) throw new DOMException("quota", "QuotaExceededError");
      return originalSetItem.call(this, key, value);
    };
    try {
      const restored = repository.restoreBackupRecords([record]);
      return {
        restored,
        raw: localStorage.getItem(entityKey)
      };
    } finally {
      Storage.prototype.setItem = originalSetItem;
    }
  }, { record: incoming, entityKey: ENTITY_STORAGE_KEY });

  expect(result.restored.status).toBe("interrupted");
  expect(result.restored.summary).toMatchObject({ restored: 0, failed: 1 });
  expect(result.restored.items[0]).toMatchObject({
    favoriteId: incoming.id,
    status: "failed",
    written: false
  });
  expect(result.restored.errors[0]).toMatchObject({ code: "favorite-storage-write-failed" });
  expect(result.raw).toBeNull();
});

test("commitExactSnapshot 原样提交 active remote snapshot 并保留 unknown fields", async ({ page }) => {
  const candidate = makeBackupFavorite({
    id: "favorite:exact-active",
    futureRemoteFact: { labels: ["server"] }
  });
  const result = await page.evaluate(candidate => {
    const repository = window.LingoFlowFavoriteRepository;
    const input = { entityId: candidate.id, expectedCurrent: null, candidate };
    const before = structuredClone(input);
    const committed = repository.commitExactSnapshot(input);
    input.candidate.futureRemoteFact.labels.push("outside");
    return {
      before,
      committed,
      stored: repository.getById(candidate.id, { includeDeleted: true })
    };
  }, candidate);
  expect(result.committed).toMatchObject({ status: "committed", written: true });
  expect(result.committed.favorite).toEqual(candidate);
  expect(result.stored).toEqual(candidate);
  expect(result.before.candidate).toEqual(candidate);
});

test("commitExactSnapshot 原样提交 tombstone 且不生成生命周期字段", async ({ page }) => {
  const tombstone = makeBackupFavorite({
    id: "favorite:exact-tombstone",
    updatedAt: "2026-09-01T01:00:00.000Z",
    deletedAt: "2026-09-01T01:00:00.000Z"
  });
  const result = await page.evaluate(tombstone => {
    const repository = window.LingoFlowFavoriteRepository;
    return {
      committed: repository.commitExactSnapshot({
        entityId: tombstone.id,
        expectedCurrent: null,
        candidate: tombstone
      }),
      stored: repository.getById(tombstone.id, { includeDeleted: true })
    };
  }, tombstone);
  expect(result.committed).toMatchObject({ status: "committed", written: true });
  expect(result.stored).toEqual(tombstone);
});

test("commitExactSnapshot exact current 返回 unchanged 且不重写 storage", async ({ page }) => {
  const favorite = makeBackupFavorite({ id: "favorite:exact-unchanged" });
  const result = await page.evaluate(({ favorite, entityKey }) => {
    localStorage.setItem(entityKey, JSON.stringify({ [favorite.id]: favorite }));
    const before = localStorage.getItem(entityKey);
    const committed = window.LingoFlowFavoriteRepository.commitExactSnapshot({
      entityId: favorite.id,
      expectedCurrent: null,
      candidate: favorite
    });
    return { committed, before, after: localStorage.getItem(entityKey) };
  }, { favorite, entityKey: ENTITY_STORAGE_KEY });
  expect(result.committed).toMatchObject({ status: "unchanged", written: false });
  expect(result.after).toBe(result.before);
});

test("commitExactSnapshot stale expectedCurrent 不覆盖并发本地值", async ({ page }) => {
  const before = makeBackupFavorite({ id: "favorite:exact-stale", meaning: "A" });
  const concurrent = { ...before, meaning: "local B", updatedAt: "2026-09-01T01:00:00.000Z" };
  const candidate = { ...before, meaning: "remote C", updatedAt: "2026-09-01T02:00:00.000Z" };
  const result = await page.evaluate(({ before, concurrent, candidate, entityKey }) => {
    localStorage.setItem(entityKey, JSON.stringify({ [before.id]: concurrent }));
    const committed = window.LingoFlowFavoriteRepository.commitExactSnapshot({
      entityId: before.id,
      expectedCurrent: before,
      candidate
    });
    return {
      committed,
      stored: window.LingoFlowFavoriteRepository.getById(before.id, { includeDeleted: true })
    };
  }, { before, concurrent, candidate, entityKey: ENTITY_STORAGE_KEY });
  expect(result.committed).toMatchObject({ status: "stale-local-state", written: false });
  expect(result.committed.favorite).toEqual(concurrent);
  expect(result.stored).toEqual(concurrent);
});
