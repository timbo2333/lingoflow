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
  expect(await page.evaluate(() => (
    typeof window.LingoFlowFavoriteLearningBackupSchema
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

test("模块被冻结且单项与集合验证均为纯同步 API", async ({ page }) => {
  const state = makeState("favorite:learning-api");
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowFavoriteLearningBackupSchema;
    const single = schema.validateFavoriteLearningState(incoming);
    const batch = schema.validateFavoriteLearningStates([incoming]);
    return {
      frozen: Object.isFrozen(schema),
      api: {
        validateFavoriteLearningState: typeof schema.validateFavoriteLearningState,
        validateFavoriteLearningStates: typeof schema.validateFavoriteLearningStates
      },
      singleIsPromise: Boolean(single?.then),
      batchIsPromise: Boolean(batch?.then)
    };
  }, state);

  expect(result).toEqual({
    frozen: true,
    api: {
      validateFavoriteLearningState: "function",
      validateFavoriteLearningStates: "function"
    },
    singleIsPromise: false,
    batchIsPromise: false
  });
});

test("validateFavoriteLearningState 接受 mastered true/false 与 tombstone", async ({ page }) => {
  const states = [
    makeState("favorite:learning-false"),
    makeState("favorite:learning-true", { mastered: true }),
    makeState("favorite:learning-deleted", {
      mastered: true,
      updatedAt: "2026-08-24T03:00:00.000Z",
      deletedAt: "2026-08-24T02:30:00.000Z"
    })
  ];
  const results = await page.evaluate(incoming => incoming.map(state => {
    const result = window.LingoFlowFavoriteLearningBackupSchema
      .validateFavoriteLearningState(state);
    return {
      result,
      isPromise: Boolean(result?.then),
      sameReference: result.favoriteLearningState === state
    };
  }), states);

  for (let index = 0; index < results.length; index += 1) {
    expect(results[index].isPromise).toBe(false);
    expect(results[index].sameReference).toBe(true);
    expect(results[index].result).toEqual({
      status: "valid",
      favoriteId: states[index].favoriteId,
      favoriteLearningState: states[index],
      errors: []
    });
  }
});

test("Schema 要求精确五字段并拒绝缺失与额外字段", async ({ page }) => {
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowFavoriteLearningBackupSchema;
    const missing = { ...incoming };
    delete missing.mastered;
    const extra = { ...incoming, reviewCount: 2 };

    return {
      missing: schema.validateFavoriteLearningState(missing),
      extra: schema.validateFavoriteLearningState(extra)
    };
  }, makeState("favorite:learning-exact"));

  expect(result.missing.status).toBe("rejected");
  expect(result.missing.errors).toContainEqual({
    code: "missing-field",
    path: "mastered"
  });
  expect(result.extra.status).toBe("rejected");
  expect(result.extra.errors).toContainEqual({
    code: "unknown-field",
    path: "reviewCount"
  });
});

test("validateFavoriteLearningState 拒绝非普通单项对象", async ({ page }) => {
  const results = await page.evaluate(() => {
    const schema = window.LingoFlowFavoriteLearningBackupSchema;
    const inherited = Object.create({
      favoriteId: "favorite:inherited",
      mastered: false,
      createdAt: "2026-08-24T01:00:00.000Z",
      updatedAt: "2026-08-24T02:00:00.000Z",
      deletedAt: null
    });
    return [null, [], new Date(), inherited].map(value => (
      schema.validateFavoriteLearningState(value)
    ));
  });

  for (const result of results) {
    expect(result).toEqual({
      status: "rejected",
      favoriteId: null,
      favoriteLearningState: null,
      errors: [{ code: "invalid-state", path: "$" }]
    });
  }
});

test("Schema 严格验证 favoriteId 与 mastered 类型且不做转换", async ({ page }) => {
  const cases = await page.evaluate(base => {
    const schema = window.LingoFlowFavoriteLearningBackupSchema;
    return [
      { value: { ...base, favoriteId: "" }, path: "favoriteId" },
      { value: { ...base, favoriteId: " favorite:spaced" }, path: "favoriteId" },
      { value: { ...base, favoriteId: 42 }, path: "favoriteId" },
      { value: { ...base, mastered: "true" }, path: "mastered" },
      { value: { ...base, mastered: 1 }, path: "mastered" },
      { value: { ...base, mastered: null }, path: "mastered" }
    ].map(candidate => ({
      path: candidate.path,
      result: schema.validateFavoriteLearningState(candidate.value),
      value: candidate.value
    }));
  }, makeState("favorite:learning-types"));

  for (const candidate of cases) {
    expect(candidate.result.status).toBe("rejected");
    expect(candidate.result.errors).toContainEqual(expect.objectContaining({
      path: candidate.path
    }));
  }
  expect(cases[1].value.favoriteId).toBe(" favorite:spaced");
  expect(cases[3].value.mastered).toBe("true");
});

test("Schema 只接受规范 UTC 时间并验证生命周期顺序", async ({ page }) => {
  const cases = await page.evaluate(base => {
    const schema = window.LingoFlowFavoriteLearningBackupSchema;
    return [
      { value: { ...base, createdAt: "2026-08-24T01:00:00Z" }, path: "createdAt" },
      { value: { ...base, updatedAt: "2026-08-24T10:00:00.000+08:00" }, path: "updatedAt" },
      { value: { ...base, deletedAt: "not-a-time" }, path: "deletedAt" },
      {
        value: {
          ...base,
          createdAt: "2026-08-24T03:00:00.000Z",
          updatedAt: "2026-08-24T02:00:00.000Z"
        },
        path: "$"
      },
      {
        value: {
          ...base,
          updatedAt: "2026-08-24T04:00:00.000Z",
          deletedAt: "2026-08-24T00:00:00.000Z"
        },
        path: "$"
      },
      {
        value: {
          ...base,
          updatedAt: "2026-08-24T04:00:00.000Z",
          deletedAt: "2026-08-24T05:00:00.000Z"
        },
        path: "$"
      }
    ].map(candidate => ({
      path: candidate.path,
      result: schema.validateFavoriteLearningState(candidate.value)
    }));
  }, makeState("favorite:learning-time"));

  for (const candidate of cases) {
    expect(candidate.result.status).toBe("rejected");
    expect(candidate.result.errors).toContainEqual(expect.objectContaining({
      path: candidate.path
    }));
  }
});

test("Schema 拒绝非 JSON 属性且不执行 getter", async ({ page }) => {
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowFavoriteLearningBackupSchema;
    let getterCalls = 0;
    const accessor = { ...incoming };
    Object.defineProperty(accessor, "mastered", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return true;
      }
    });
    const symbol = { ...incoming };
    symbol[Symbol("hidden")] = true;
    const hidden = { ...incoming };
    Object.defineProperty(hidden, "mastered", {
      enumerable: false,
      value: false
    });

    return {
      accessor: schema.validateFavoriteLearningState(accessor),
      symbol: schema.validateFavoriteLearningState(symbol),
      hidden: schema.validateFavoriteLearningState(hidden),
      getterCalls
    };
  }, makeState("favorite:learning-json"));

  expect(result.getterCalls).toBe(0);
  expect(result.accessor.status).toBe("rejected");
  expect(result.accessor.errors).toEqual([
    { code: "invalid-json-value", path: "mastered" }
  ]);
  expect(result.symbol.status).toBe("rejected");
  expect(result.symbol.errors).toEqual([
    { code: "invalid-json-value", path: "$" }
  ]);
  expect(result.hidden.status).toBe("rejected");
  expect(result.hidden.errors).toEqual([
    { code: "invalid-json-value", path: "mastered" }
  ]);
});

test("validateFavoriteLearningStates 处理非数组、空数组与重复 favoriteId", async ({ page }) => {
  const state = makeState("favorite:learning-duplicate");
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowFavoriteLearningBackupSchema;
    return {
      invalid: schema.validateFavoriteLearningStates(null),
      empty: schema.validateFavoriteLearningStates([]),
      duplicate: schema.validateFavoriteLearningStates([incoming, { ...incoming }])
    };
  }, state);

  expect(result.invalid).toEqual({
    status: "rejected",
    summary: { total: 0, valid: 0, rejected: 0 },
    favoriteLearningStates: [],
    items: [],
    errors: [{ code: "invalid-states", path: "$" }]
  });
  expect(result.empty).toEqual({
    status: "valid",
    summary: { total: 0, valid: 0, rejected: 0 },
    favoriteLearningStates: [],
    items: [],
    errors: []
  });
  expect(result.duplicate.status).toBe("rejected");
  expect(result.duplicate.favoriteLearningStates).toEqual([]);
  expect(result.duplicate.summary).toEqual({ total: 2, valid: 1, rejected: 1 });
  expect(result.duplicate.errors).toContainEqual({
    code: "duplicate-favorite-id",
    path: "favoriteId",
    index: 1,
    favoriteId: state.favoriteId
  });
});

test("集合验证拒绝稀疏、自定义属性和 accessor 数组且不执行 getter", async ({ page }) => {
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowFavoriteLearningBackupSchema;
    const sparse = new Array(2);
    sparse[0] = incoming;
    const custom = [incoming];
    custom.metadata = "not an entity item";
    let getterCalls = 0;
    const accessor = [incoming];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return incoming;
      }
    });
    const symbol = [incoming];
    symbol[Symbol("metadata")] = true;

    return {
      sparse: schema.validateFavoriteLearningStates(sparse),
      custom: schema.validateFavoriteLearningStates(custom),
      accessor: schema.validateFavoriteLearningStates(accessor),
      symbol: schema.validateFavoriteLearningStates(symbol),
      getterCalls
    };
  }, makeState("favorite:learning-array-shape"));

  expect(result.getterCalls).toBe(0);
  for (const validation of [
    result.sparse,
    result.custom,
    result.accessor,
    result.symbol
  ]) {
    expect(validation.status).toBe("rejected");
    expect(validation.summary).toEqual({ total: 0, valid: 0, rejected: 0 });
    expect(validation.favoriteLearningStates).toEqual([]);
    expect(validation.items).toEqual([]);
    expect(validation.errors).toHaveLength(1);
    expect(validation.errors[0]).toMatchObject({ code: "invalid-json-value" });
  }
});

test("批内任一无效状态会拒绝整个集合", async ({ page }) => {
  const states = [
    makeState("favorite:learning-valid"),
    makeState("favorite:learning-invalid", { mastered: "false" })
  ];
  const result = await page.evaluate(incoming => (
    window.LingoFlowFavoriteLearningBackupSchema
      .validateFavoriteLearningStates(incoming)
  ), states);

  expect(result.status).toBe("rejected");
  expect(result.summary).toEqual({ total: 2, valid: 1, rejected: 1 });
  expect(result.favoriteLearningStates).toEqual([]);
  expect(result.items.map(item => item.status)).toEqual(["valid", "rejected"]);
  expect(result.errors).toContainEqual({
    code: "invalid-mastered",
    path: "mastered",
    index: 1,
    favoriteId: states[1].favoriteId
  });
});

test("Schema 不修改或克隆输入状态与集合", async ({ page }) => {
  const states = [
    makeState("favorite:learning-stable-a"),
    makeState("favorite:learning-stable-b", { mastered: true })
  ];
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowFavoriteLearningBackupSchema;
    const before = JSON.stringify(incoming);
    incoming.forEach(Object.freeze);
    Object.freeze(incoming);

    const validation = schema.validateFavoriteLearningStates(incoming);
    return {
      validation,
      before,
      after: JSON.stringify(incoming),
      sameFirstReference: validation.favoriteLearningStates[0] === incoming[0],
      sameSecondReference: validation.favoriteLearningStates[1] === incoming[1]
    };
  }, states);

  expect(result.validation.status).toBe("valid");
  expect(result.before).toBe(result.after);
  expect(result.sameFirstReference).toBe(true);
  expect(result.sameSecondReference).toBe(true);
  expect(result.validation.favoriteLearningStates).toEqual(states);
});

test("Schema 不访问 localStorage、Repository 或 Favorite 关系", async ({ page }) => {
  const state = makeState("favorite:learning-isolated");
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowFavoriteLearningBackupSchema;
    const storageDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    const favoriteRepositoryDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "LingoFlowFavoriteRepository"
    );
    const learningRepositoryDescriptor = Object.getOwnPropertyDescriptor(
      window,
      "LingoFlowFavoriteLearningRepository"
    );
    let storageAccesses = 0;
    let favoriteRepositoryAccesses = 0;
    let learningRepositoryAccesses = 0;

    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        storageAccesses += 1;
        throw new Error("Schema 不应访问 localStorage。");
      }
    });
    Object.defineProperty(window, "LingoFlowFavoriteLearningRepository", {
      configurable: true,
      get() {
        learningRepositoryAccesses += 1;
        throw new Error("Schema 不应访问 Learning Repository。");
      }
    });
    Object.defineProperty(window, "LingoFlowFavoriteRepository", {
      configurable: true,
      get() {
        favoriteRepositoryAccesses += 1;
        throw new Error("Schema 不应检查 Favorite 是否存在。");
      }
    });

    let single;
    let batch;
    try {
      single = schema.validateFavoriteLearningState(incoming);
      batch = schema.validateFavoriteLearningStates([incoming]);
    } finally {
      if (storageDescriptor) {
        Object.defineProperty(window, "localStorage", storageDescriptor);
      } else {
        delete window.localStorage;
      }
      if (learningRepositoryDescriptor) {
        Object.defineProperty(
          window,
          "LingoFlowFavoriteLearningRepository",
          learningRepositoryDescriptor
        );
      } else {
        delete window.LingoFlowFavoriteLearningRepository;
      }
      if (favoriteRepositoryDescriptor) {
        Object.defineProperty(
          window,
          "LingoFlowFavoriteRepository",
          favoriteRepositoryDescriptor
        );
      } else {
        delete window.LingoFlowFavoriteRepository;
      }
    }

    return {
      storageAccesses,
      favoriteRepositoryAccesses,
      learningRepositoryAccesses,
      singleStatus: single.status,
      batchStatus: batch.status
    };
  }, state);

  expect(result).toEqual({
    storageAccesses: 0,
    favoriteRepositoryAccesses: 0,
    learningRepositoryAccesses: 0,
    singleStatus: "valid",
    batchStatus: "valid"
  });
});
