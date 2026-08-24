const { test, expect } = require("@playwright/test");

const LEGACY_STORAGE_KEY = "EnglishReaderV051Favorites";
const ENTITY_STORAGE_KEY = "LingoFlowFavoriteEntities";
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
      { type: "word", text: "derived", dictionaryFound: true },
      { type: "word", text: "sync", syncStatus: "dirty" },
      { type: "word", text: "nested learning", futureMetadata: { mastered: true } },
      { type: "word", text: "tags", tags: ["ok", 1] },
      { type: "word", text: "origin", origin: { kind: "" } }
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
