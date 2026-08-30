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
  await page.addScriptTag({ url: "/js/preferences-backup-schema.js" });
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

function makePreference(key, value) {
  return { key, value };
}

function makeSpeechVoice(overrides = {}) {
  return {
    name: "Samantha",
    lang: "en-US",
    voiceURI: "com.apple.voice.compact.en-US.Samantha",
    ...overrides
  };
}

test("模块被冻结且单项与集合验证均为纯同步 API", async ({ page }) => {
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowPreferencesBackupSchema;
    const single = schema.validatePreference(incoming);
    const batch = schema.validatePreferences([incoming]);
    return {
      frozen: Object.isFrozen(schema),
      api: {
        validatePreference: typeof schema.validatePreference,
        validatePreferences: typeof schema.validatePreferences
      },
      singleIsPromise: Boolean(single?.then),
      batchIsPromise: Boolean(batch?.then)
    };
  }, makePreference("fontSize", "21"));

  expect(result).toEqual({
    frozen: true,
    api: {
      validatePreference: "function",
      validatePreferences: "function"
    },
    singleIsPromise: false,
    batchIsPromise: false
  });
});

test("空 collection 合法且不会展开任何默认 preference", async ({ page }) => {
  const result = await page.evaluate(() => (
    window.LingoFlowPreferencesBackupSchema.validatePreferences([])
  ));

  expect(result).toEqual({
    status: "valid",
    summary: { total: 0, valid: 0, rejected: 0 },
    preferences: [],
    items: [],
    errors: []
  });
});

test("collection 必须是 array", async ({ page }) => {
  const results = await page.evaluate(() => {
    const schema = window.LingoFlowPreferencesBackupSchema;
    return [null, {}, "preferences", 1, true].map(value => (
      schema.validatePreferences(value)
    ));
  });

  for (const result of results) {
    expect(result.status).toBe("rejected");
    expect(result.preferences).toEqual([]);
    expect(result.errors).not.toEqual([]);
  }
});

test("collection 拒绝稀疏、自定义、Symbol 与 accessor 属性且不执行 getter", async ({ page }) => {
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowPreferencesBackupSchema;
    const sparse = new Array(2);
    sparse[0] = incoming;

    const custom = [incoming];
    custom.metadata = "unsafe";

    const symbol = [incoming];
    symbol[Symbol("metadata")] = true;

    let getterCalls = 0;
    const accessor = [incoming];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return incoming;
      }
    });

    return {
      validations: [sparse, custom, symbol, accessor].map(value => (
        schema.validatePreferences(value)
      )),
      getterCalls
    };
  }, makePreference("fontSize", "21"));

  expect(result.getterCalls).toBe(0);
  for (const validation of result.validations) {
    expect(validation.status).toBe("rejected");
    expect(validation.preferences).toEqual([]);
  }
});

test("每个 item 必须是 plain JSON object", async ({ page }) => {
  const results = await page.evaluate(() => {
    const schema = window.LingoFlowPreferencesBackupSchema;
    class PreferenceItem {
      constructor() {
        this.key = "fontSize";
        this.value = "21";
      }
    }
    const inherited = Object.create({ inherited: true });
    Object.assign(inherited, { key: "fontSize", value: "21" });
    return [null, [], "fontSize", new Date(), new PreferenceItem(), inherited]
      .map(value => schema.validatePreference(value));
  });

  for (const result of results) {
    expect(result.status).toBe("rejected");
    expect(result.preference).toBeNull();
  }
});

test("item 精确要求 key/value 且拒绝额外结构字段", async ({ page }) => {
  const result = await page.evaluate(() => {
    const schema = window.LingoFlowPreferencesBackupSchema;
    const missingKey = { value: "21" };
    const missingValue = { key: "fontSize" };
    const extraFields = ["id", "createdAt", "updatedAt", "timestamp", "revision"];
    return {
      missingKey: schema.validatePreference(missingKey),
      missingValue: schema.validatePreference(missingValue),
      extras: extraFields.map(field => ({
        field,
        validation: schema.validatePreference({
          key: "fontSize",
          value: "21",
          [field]: "unexpected"
        })
      })),
      missingObjects: {
        missingKeyHasKey: Object.prototype.hasOwnProperty.call(missingKey, "key"),
        missingValueHasValue: Object.prototype.hasOwnProperty.call(missingValue, "value")
      }
    };
  });

  expect(result.missingKey.status).toBe("rejected");
  expect(result.missingValue.status).toBe("rejected");
  expect(result.missingObjects).toEqual({
    missingKeyHasKey: false,
    missingValueHasValue: false
  });
  for (const { validation } of result.extras) {
    expect(validation.status).toBe("rejected");
  }
});

test("key 严格遵守 ASCII identity 语法且不接受类型转换", async ({ page }) => {
  const invalidKeys = [
    "",
    " setting",
    "setting ",
    "setting name",
    "9setting",
    ".setting",
    "_setting",
    "-setting",
    "设置",
    null,
    7,
    true
  ];
  const result = await page.evaluate(keys => {
    const schema = window.LingoFlowPreferencesBackupSchema;
    return {
      valid: schema.validatePreference({
        key: "Future.setting_1-beta",
        value: true
      }),
      invalid: keys.map(key => schema.validatePreference({ key, value: true }))
    };
  }, invalidKeys);

  expect(result.valid.status).toBe("valid");
  expect(result.valid.preference.key).toBe("Future.setting_1-beta");
  for (const validation of result.invalid) {
    expect(validation.status).toBe("rejected");
  }
});

test("key identity 原样、区分大小写且不被 normalize", async ({ page }) => {
  const result = await page.evaluate(() => {
    const schema = window.LingoFlowPreferencesBackupSchema;
    const input = { key: "FontSize", value: { exact: true } };
    const validation = schema.validatePreference(input);
    return {
      validation,
      inputKey: input.key
    };
  });

  expect(result.validation.status).toBe("valid");
  expect(result.validation.preference.key).toBe("FontSize");
  expect(result.inputKey).toBe("FontSize");
});

test("非字符串 key 被拒绝且不会触发隐式 property-key conversion", async ({ page }) => {
  const result = await page.evaluate(() => {
    const schema = window.LingoFlowPreferencesBackupSchema;
    const originalToString = Array.prototype.toString;
    let conversionCalls = 0;
    let validation;

    Array.prototype.toString = function() {
      conversionCalls += 1;
      return "fontSize";
    };
    try {
      validation = schema.validatePreference({ key: [], value: "21" });
    } finally {
      Array.prototype.toString = originalToString;
    }

    return { validation, conversionCalls };
  });

  expect(result.validation.status).toBe("rejected");
  expect(result.conversionCalls).toBe(0);
});

test("fontSize 接受全部精确 string enum", async ({ page }) => {
  const result = await page.evaluate(values => {
    const schema = window.LingoFlowPreferencesBackupSchema;
    return values.map(value => schema.validatePreference({ key: "fontSize", value }));
  }, ["18", "20", "21", "23", "25"]);

  expect(result.map(item => item.status)).toEqual([
    "valid", "valid", "valid", "valid", "valid"
  ]);
  expect(result.map(item => item.preference.value)).toEqual([
    "18", "20", "21", "23", "25"
  ]);
});

test("fontSize 拒绝 number、带空白和非枚举值且不转换", async ({ page }) => {
  const values = [18, 21, " 21 ", "21 ", "", "19", null, true];
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowPreferencesBackupSchema;
    return incoming.map(value => ({
      value,
      validation: schema.validatePreference({ key: "fontSize", value })
    }));
  }, values);

  for (let index = 0; index < result.length; index += 1) {
    expect(result[index].validation.status).toBe("rejected");
    expect(result[index].value).toBe(values[index]);
  }
});

test("lineHeight 接受全部精确 string enum", async ({ page }) => {
  const values = ["1.65", "1.85", "2", "2.2", "2.4"];
  const result = await page.evaluate(incoming => incoming.map(value => (
    window.LingoFlowPreferencesBackupSchema.validatePreference({
      key: "lineHeight",
      value
    })
  )), values);

  expect(result.map(item => item.status)).toEqual(values.map(() => "valid"));
  expect(result.map(item => item.preference.value)).toEqual(values);
});

test("lineHeight 拒绝 number、带空白和非枚举值", async ({ page }) => {
  const values = [1.65, 2, " 2", "2 ", "", "1.5", "2.0", null];
  const results = await page.evaluate(incoming => incoming.map(value => (
    window.LingoFlowPreferencesBackupSchema.validatePreference({
      key: "lineHeight",
      value
    })
  )), values);

  expect(results.map(item => item.status)).toEqual(values.map(() => "rejected"));
});

test("appearance 只接受 system/light/dark 并保留显式 system", async ({ page }) => {
  const values = ["system", "light", "dark"];
  const results = await page.evaluate(incoming => incoming.map(value => (
    window.LingoFlowPreferencesBackupSchema.validatePreference({
      key: "appearance",
      value
    })
  )), values);

  expect(results.map(item => item.status)).toEqual(values.map(() => "valid"));
  expect(results.map(item => item.preference.value)).toEqual(values);
});

test("appearance 拒绝解析结果以外的非法 enum 与非字符串", async ({ page }) => {
  const values = ["auto", "LIGHT", " system ", "", null, true, 1];
  const results = await page.evaluate(incoming => incoming.map(value => (
    window.LingoFlowPreferencesBackupSchema.validatePreference({
      key: "appearance",
      value
    })
  )), values);

  expect(results.map(item => item.status)).toEqual(values.map(() => "rejected"));
});

test("speechRate 接受全部精确 string enum", async ({ page }) => {
  const values = ["0.7", "0.85", "1", "1.15"];
  const results = await page.evaluate(incoming => incoming.map(value => (
    window.LingoFlowPreferencesBackupSchema.validatePreference({
      key: "speechRate",
      value
    })
  )), values);

  expect(results.map(item => item.status)).toEqual(values.map(() => "valid"));
  expect(results.map(item => item.preference.value)).toEqual(values);
});

test("speechRate 拒绝 number、带空白和非枚举值且不 fallback", async ({ page }) => {
  const values = [0.7, 1, " 1", "1 ", "", "0.8", "1.0", null];
  const results = await page.evaluate(incoming => incoming.map(value => (
    window.LingoFlowPreferencesBackupSchema.validatePreference({
      key: "speechRate",
      value
    })
  )), values);

  expect(results.map(item => item.status)).toEqual(values.map(() => "rejected"));
});

test("speechVoice null 是合法显式值并与缺少 item 不同", async ({ page }) => {
  const result = await page.evaluate(() => {
    const schema = window.LingoFlowPreferencesBackupSchema;
    return {
      explicit: schema.validatePreferences([{ key: "speechVoice", value: null }]),
      absent: schema.validatePreferences([])
    };
  });

  expect(result.explicit.status).toBe("valid");
  expect(result.explicit.preferences).toEqual([
    { key: "speechVoice", value: null }
  ]);
  expect(result.absent.status).toBe("valid");
  expect(result.absent.preferences).toEqual([]);
});

test("speechVoice 接受精确三字段对象以及空 voiceURI", async ({ page }) => {
  const voices = [makeSpeechVoice(), makeSpeechVoice({ voiceURI: "" })];
  const result = await page.evaluate(incoming => incoming.map(value => (
    window.LingoFlowPreferencesBackupSchema.validatePreference({
      key: "speechVoice",
      value
    })
  )), voices);

  expect(result.map(item => item.status)).toEqual(["valid", "valid"]);
  expect(result.map(item => item.preference.value)).toEqual(voices);
});

test("speechVoice 拒绝缺失 member、非法类型、空 name/lang 与空白值", async ({ page }) => {
  const voice = makeSpeechVoice();
  const result = await page.evaluate(base => {
    const schema = window.LingoFlowPreferencesBackupSchema;
    const without = field => {
      const value = { ...base };
      delete value[field];
      return value;
    };
    const candidates = [
      without("name"),
      without("lang"),
      without("voiceURI"),
      { ...base, name: "" },
      { ...base, name: "   " },
      { ...base, name: " Samantha" },
      { ...base, lang: "" },
      { ...base, lang: "en-US " },
      { ...base, voiceURI: "   " },
      { ...base, voiceURI: " uri" },
      { ...base, name: null },
      { ...base, lang: 1 },
      { ...base, voiceURI: false }
    ];
    return candidates.map(value => schema.validatePreference({
      key: "speechVoice",
      value
    }));
  }, voice);

  expect(result.map(item => item.status)).toEqual(result.map(() => "rejected"));
});

test("speechVoice 拒绝 unknown/runtime member、非普通对象和 accessor", async ({ page }) => {
  const result = await page.evaluate(base => {
    const schema = window.LingoFlowPreferencesBackupSchema;
    let getterCalls = 0;
    const accessor = { ...base };
    Object.defineProperty(accessor, "name", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "Unsafe";
      }
    });
    class Voice {
      constructor() {
        Object.assign(this, base);
      }
    }
    const candidates = [
      { ...base, localService: true },
      { ...base, default: false },
      { ...base, voiceAvailable: true },
      new Voice(),
      [base.name, base.lang, base.voiceURI],
      accessor
    ];
    return {
      validations: candidates.map(value => schema.validatePreference({
        key: "speechVoice",
        value
      })),
      getterCalls
    };
  }, makeSpeechVoice());

  expect(result.getterCalls).toBe(0);
  expect(result.validations.map(item => item.status)).toEqual(
    result.validations.map(() => "rejected")
  );
});

test("五个正式 preference 可以在同一 collection 中合法存在", async ({ page }) => {
  const preferences = [
    makePreference("fontSize", "21"),
    makePreference("lineHeight", "2"),
    makePreference("appearance", "dark"),
    makePreference("speechRate", "1.15"),
    makePreference("speechVoice", makeSpeechVoice())
  ];
  const result = await page.evaluate(incoming => (
    window.LingoFlowPreferencesBackupSchema.validatePreferences(incoming)
  ), preferences);

  expect(result.status).toBe("valid");
  expect(result.summary).toEqual({ total: 5, valid: 5, rejected: 0 });
  expect(result.preferences).toEqual(preferences);
});

test("unknown preference 接受全部合法 JSON primitive", async ({ page }) => {
  const values = [null, true, false, "text", "", 0, -2, 1.5];
  const result = await page.evaluate(incoming => incoming.map((value, index) => (
    window.LingoFlowPreferencesBackupSchema.validatePreference({
      key: `futurePrimitive${index}`,
      value
    })
  )), values);

  expect(result.map(item => item.status)).toEqual(values.map(() => "valid"));
  expect(result.map(item => item.preference.value)).toEqual(values);
});

test("unknown nested JSON value 原样保留且嵌套名称不递归套用 reserved key", async ({ page }) => {
  const result = await page.evaluate(() => {
    const schema = window.LingoFlowPreferencesBackupSchema;
    const value = {
      mode: "future",
      syncStatus: "nested-data",
      deviceId: "nested-data",
      nullable: null,
      levels: [1, true, { constructor: "nested-data" }]
    };
    Object.defineProperty(value, "__proto__", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: "nested-data"
    });
    const validation = schema.validatePreference({
      key: "futureSetting",
      value
    });
    return {
      validation,
      hasOwnProto: validation.status === "valid" &&
        Object.prototype.hasOwnProperty.call(validation.preference.value, "__proto__"),
      protoValue: validation.status === "valid"
        ? Object.getOwnPropertyDescriptor(validation.preference.value, "__proto__")?.value
        : null
    };
  });

  expect(result.validation.status).toBe("valid");
  expect(result.validation.preference.value).toMatchObject({
    mode: "future",
    syncStatus: "nested-data",
    deviceId: "nested-data",
    nullable: null,
    levels: [1, true, { constructor: "nested-data" }]
  });
  expect(result.hasOwnProto).toBe(true);
  expect(result.protoValue).toBe("nested-data");
});

test("文档定义的完整 reserved preference key 列表逐项 rejected", async ({ page }) => {
  const reservedKeys = [
    "deviceId",
    "historyMigrationState", "migrationState", "migrationCompleted",
    "migrationVersion", "lastBackup", "backupDismiss", "backupReminder",
    "syncStatus", "remoteId", "serverRevision", "dirty", "lastSyncedAt",
    "vectorClock",
    "voices", "currentVoice", "localService", "voiceAvailable", "darkMode",
    "resolvedAppearance", "permissionState", "permissions", "hardwareCapabilities",
    "dictionaryReady", "dictionaryVersion", "completedChunks", "importedRecords",
    "downloadCheckpoint", "dictionaryGuideDeferred", "dictionaryWasReady",
    "dictionaryTaskState", "dictionaryIntegritySnapshot",
    "speed", "reading", "preferences.speed", "preferences.reading",
    "__proto__", "prototype", "constructor"
  ];
  const result = await page.evaluate(keys => keys.map(key => ({
    key,
    validation: window.LingoFlowPreferencesBackupSchema.validatePreference({
      key,
      value: null
    })
  })), reservedKeys);

  expect(result).toHaveLength(reservedKeys.length);
  for (const { validation } of result) {
    expect(validation.status).toBe("rejected");
  }
});

test("reserved 匹配精确且区分大小写，不扩大为模糊规则", async ({ page }) => {
  const values = ["DeviceId", "SYNCSTATUS", "dictionaryready", "backupDismissed"];
  const result = await page.evaluate(keys => keys.map(key => (
    window.LingoFlowPreferencesBackupSchema.validatePreference({
      key,
      value: { portable: true }
    })
  )), values);

  expect(result.map(item => item.status)).toEqual(values.map(() => "valid"));
  expect(result.map(item => item.preference.key)).toEqual(values);
});

test("legacy speed/reading 及 wrapper path 被拒绝且不迁移成现代 key", async ({ page }) => {
  const keys = ["speed", "reading", "preferences.speed", "preferences.reading"];
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowPreferencesBackupSchema;
    const items = incoming.map(key => ({ key, value: "1" }));
    return {
      validations: items.map(item => schema.validatePreference(item)),
      after: items
    };
  }, keys);

  expect(result.validations.map(item => item.status)).toEqual(keys.map(() => "rejected"));
  expect(result.after.map(item => item.key)).toEqual(keys);
  expect(result.after.map(item => item.key)).not.toContain("speechRate");
});

test("duplicate key 无论 value 是否相同都拒绝整批，大小写不同仍是独立 key", async ({ page }) => {
  const result = await page.evaluate(() => {
    const schema = window.LingoFlowPreferencesBackupSchema;
    return {
      sameValue: schema.validatePreferences([
        { key: "futureSetting", value: 1 },
        { key: "futureSetting", value: 1 }
      ]),
      differentValue: schema.validatePreferences([
        { key: "futureSetting", value: 1 },
        { key: "futureSetting", value: 2 }
      ]),
      differentCase: schema.validatePreferences([
        { key: "futureSetting", value: 1 },
        { key: "FutureSetting", value: 1 }
      ])
    };
  });

  for (const validation of [result.sameValue, result.differentValue]) {
    expect(validation.status).toBe("rejected");
    expect(validation.preferences).toEqual([]);
    expect(validation.errors).toContainEqual(expect.objectContaining({
      code: "duplicate-preference-key",
      index: 1
    }));
  }
  expect(result.differentCase.status).toBe("valid");
  expect(result.differentCase.preferences.map(item => item.key)).toEqual([
    "futureSetting", "FutureSetting"
  ]);
});

test("任一非法 item 会拒绝整个 collection 且不返回部分有效 preferences", async ({ page }) => {
  const result = await page.evaluate(() => (
    window.LingoFlowPreferencesBackupSchema.validatePreferences([
      { key: "fontSize", value: "21" },
      { key: "appearance", value: "sepia" },
      { key: "lineHeight", value: "2" }
    ])
  ));

  expect(result.status).toBe("rejected");
  expect(result.summary).toEqual({ total: 3, valid: 2, rejected: 1 });
  expect(result.preferences).toEqual([]);
  expect(result.items.map(item => item.status)).toEqual([
    "valid", "rejected", "valid"
  ]);
});

test("unknown value 拒绝 undefined/function/Symbol/BigInt 和非有限 number", async ({ page }) => {
  const result = await page.evaluate(() => {
    const schema = window.LingoFlowPreferencesBackupSchema;
    const values = [
      undefined,
      function unsafe() {},
      Symbol("unsafe"),
      BigInt(1),
      NaN,
      Infinity,
      -Infinity
    ];
    return values.map((value, index) => schema.validatePreference({
      key: `futureUnsafe${index}`,
      value
    }));
  });

  expect(result.map(item => item.status)).toEqual(result.map(() => "rejected"));
});

test("unknown value 拒绝 cycle，但允许非循环共享引用并克隆为 JSON tree", async ({ page }) => {
  const result = await page.evaluate(() => {
    const schema = window.LingoFlowPreferencesBackupSchema;
    const cyclic = { mode: "cycle" };
    cyclic.self = cyclic;

    const shared = { label: "shared" };
    const nonCyclic = { left: shared, right: shared };
    const valid = schema.validatePreference({
      key: "futureShared",
      value: nonCyclic
    });
    return {
      cyclic: schema.validatePreference({ key: "futureCycle", value: cyclic }),
      valid,
      inputShared: nonCyclic.left === nonCyclic.right,
      snapshotBranchesIndependent: valid.status === "valid" &&
        valid.preference.value.left !== valid.preference.value.right
    };
  });

  expect(result.cyclic.status).toBe("rejected");
  expect(result.valid.status).toBe("valid");
  expect(result.inputShared).toBe(true);
  expect(result.snapshotBranchesIndependent).toBe(true);
});

test("unknown nested array 拒绝 sparse、自定义、Symbol 与 accessor 且不执行 getter", async ({ page }) => {
  const result = await page.evaluate(() => {
    const schema = window.LingoFlowPreferencesBackupSchema;
    const sparse = new Array(2);
    sparse[0] = "value";

    const custom = ["value"];
    custom.metadata = true;

    const symbol = ["value"];
    symbol[Symbol("metadata")] = true;

    let getterCalls = 0;
    const accessor = ["value"];
    Object.defineProperty(accessor, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "unsafe";
      }
    });

    return {
      validations: [sparse, custom, symbol, accessor].map((value, index) => (
        schema.validatePreference({ key: `futureArray${index}`, value })
      )),
      getterCalls
    };
  });

  expect(result.getterCalls).toBe(0);
  expect(result.validations.map(item => item.status)).toEqual(
    result.validations.map(() => "rejected")
  );
});

test("item 拒绝 accessor、Symbol 和 non-enumerable anomaly 且不执行 getter", async ({ page }) => {
  const result = await page.evaluate(() => {
    const schema = window.LingoFlowPreferencesBackupSchema;
    let getterCalls = 0;

    const accessor = { value: "21" };
    Object.defineProperty(accessor, "key", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "fontSize";
      }
    });

    const symbol = { key: "fontSize", value: "21" };
    symbol[Symbol("metadata")] = true;

    const hidden = { key: "fontSize", value: "21" };
    Object.defineProperty(hidden, "metadata", {
      enumerable: false,
      value: "silently lost"
    });

    return {
      validations: [accessor, symbol, hidden].map(value => (
        schema.validatePreference(value)
      )),
      getterCalls
    };
  });

  expect(result.getterCalls).toBe(0);
  expect(result.validations.map(item => item.status)).toEqual([
    "rejected", "rejected", "rejected"
  ]);
});

test("unknown nested object 拒绝 accessor、Symbol 与 non-enumerable anomaly", async ({ page }) => {
  const result = await page.evaluate(() => {
    const schema = window.LingoFlowPreferencesBackupSchema;
    let getterCalls = 0;

    const accessor = {};
    Object.defineProperty(accessor, "mode", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "unsafe";
      }
    });

    const symbol = { mode: "safe" };
    symbol[Symbol("metadata")] = true;

    const hidden = { mode: "safe" };
    Object.defineProperty(hidden, "metadata", {
      enumerable: false,
      value: "silently lost"
    });

    return {
      validations: [accessor, symbol, hidden].map((value, index) => (
        schema.validatePreference({ key: `futureObject${index}`, value })
      )),
      getterCalls
    };
  });

  expect(result.getterCalls).toBe(0);
  expect(result.validations.map(item => item.status)).toEqual([
    "rejected", "rejected", "rejected"
  ]);
});

test("unknown value 拒绝 Date/Map/Set/class instance 并接受 null-prototype plain object", async ({ page }) => {
  const result = await page.evaluate(() => {
    const schema = window.LingoFlowPreferencesBackupSchema;
    class FutureValue {
      constructor() {
        this.mode = "class";
      }
    }
    const nullPrototype = Object.create(null);
    nullPrototype.mode = "portable";

    const invalidValues = [new Date(), new Map(), new Set(), new FutureValue()];
    const valid = schema.validatePreference({
      key: "futureNullPrototype",
      value: nullPrototype
    });
    return {
      invalid: invalidValues.map((value, index) => schema.validatePreference({
        key: `futureNonPlain${index}`,
        value
      })),
      valid,
      validMode: valid.status === "valid" ? valid.preference.value.mode : null
    };
  });

  expect(result.invalid.map(item => item.status)).toEqual([
    "rejected", "rejected", "rejected", "rejected"
  ]);
  expect(result.valid.status).toBe("valid");
  expect(result.validMode).toBe("portable");
});

test("修改原 input 不影响单项或 collection validated snapshot", async ({ page }) => {
  const preference = makePreference("futureSetting", {
    mode: "original",
    nested: [1, { flag: true }]
  });
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowPreferencesBackupSchema;
    const single = schema.validatePreference(incoming);
    const batch = schema.validatePreferences([incoming]);
    incoming.key = "mutatedKey";
    incoming.value.mode = "mutated";
    incoming.value.nested[1].flag = false;
    return {
      singleSnapshot: single.preference,
      batchSnapshot: batch.preferences[0],
      inputAfter: incoming,
      singleSameReference: single.preference === incoming,
      batchSameReference: batch.preferences[0] === incoming
    };
  }, preference);

  expect(result.singleSnapshot).toEqual(preference);
  expect(result.batchSnapshot).toEqual(preference);
  expect(result.singleSameReference).toBe(false);
  expect(result.batchSameReference).toBe(false);
  expect(result.inputAfter.key).toBe("mutatedKey");
});

test("修改 validated snapshot 不影响 input，且不同验证调用不共享引用", async ({ page }) => {
  const preference = makePreference("futureSetting", {
    mode: "original",
    nested: [1, { flag: true }]
  });
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowPreferencesBackupSchema;
    const first = schema.validatePreference(incoming);
    const second = schema.validatePreference(incoming);
    const batch = schema.validatePreferences([incoming]);

    first.preference.value.mode = "first-mutated";
    first.preference.value.nested[1].flag = false;
    batch.preferences[0].value.mode = "batch-mutated";
    return {
      inputAfter: incoming,
      secondSnapshot: second.preference,
      firstSecondSame: first.preference === second.preference,
      secondBatchSame: second.preference === batch.preferences[0],
      nestedFirstSecondSame: first.preference.value === second.preference.value
    };
  }, preference);

  expect(result.inputAfter).toEqual(preference);
  expect(result.secondSnapshot).toEqual(preference);
  expect(result.firstSecondSame).toBe(false);
  expect(result.secondBatchSame).toBe(false);
  expect(result.nestedFirstSecondSame).toBe(false);
});

test("显式默认值保留，missing key 不会补默认或被删除", async ({ page }) => {
  const preferences = [
    { key: "fontSize", value: "21" },
    { key: "lineHeight", value: "2" },
    { key: "appearance", value: "system" },
    { key: "speechRate", value: "1" },
    { key: "speechVoice", value: null }
  ];
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowPreferencesBackupSchema;
    return {
      explicit: schema.validatePreferences(incoming),
      partial: schema.validatePreferences([{ key: "appearance", value: "system" }]),
      missing: schema.validatePreferences([])
    };
  }, preferences);

  expect(result.explicit.preferences).toEqual(preferences);
  expect(result.partial.preferences).toEqual([
    { key: "appearance", value: "system" }
  ]);
  expect(result.missing.preferences).toEqual([]);
});

test("Schema 不访问 storage、Repository、PreferenceData、DOM 或 normalization", async ({ page }) => {
  const result = await page.evaluate(incoming => {
    const schema = window.LingoFlowPreferencesBackupSchema;
    const names = [
      "localStorage",
      "LingoFlowPreferencesRepository",
      "LingoFlowPreferenceData",
      "PreferenceData",
      "normalizeSpeechRate",
      "getComputedStyle"
    ];
    const descriptors = new Map();
    const restoreModes = new Map();
    const accesses = Object.create(null);

    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(window, name);
      descriptors.set(name, descriptor);
      accesses[name] = 0;
      const failOnAccess = () => {
        accesses[name] += 1;
        throw new Error(`Schema 不应访问 ${name}。`);
      };
      if (!descriptor || descriptor.configurable) {
        Object.defineProperty(window, name, {
          configurable: true,
          get: failOnAccess
        });
        restoreModes.set(name, "descriptor");
      } else if (Object.prototype.hasOwnProperty.call(descriptor, "value") &&
          descriptor.writable) {
        window[name] = failOnAccess;
        restoreModes.set(name, "assignment");
      } else {
        throw new Error(`无法为 ${name} 安装隔离测试探针。`);
      }
    }

    let single;
    let batch;
    try {
      single = schema.validatePreference(incoming);
      batch = schema.validatePreferences([incoming]);
    } finally {
      for (const name of names) {
        const descriptor = descriptors.get(name);
        if (restoreModes.get(name) === "assignment") {
          window[name] = descriptor.value;
        } else if (descriptor) {
          Object.defineProperty(window, name, descriptor);
        } else {
          delete window[name];
        }
      }
    }

    return {
      accesses,
      singleStatus: single.status,
      batchStatus: batch.status
    };
  }, makePreference("appearance", "dark"));

  expect(result).toEqual({
    accesses: {
      localStorage: 0,
      LingoFlowPreferencesRepository: 0,
      LingoFlowPreferenceData: 0,
      PreferenceData: 0,
      normalizeSpeechRate: 0,
      getComputedStyle: 0
    },
    singleStatus: "valid",
    batchStatus: "valid"
  });
});
