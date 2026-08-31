const { test, expect } = require("@playwright/test");

const STORAGE_KEY = "EnglishReaderV052ReadingPrefs";
const DEVICE_ID_KEY = "EnglishReaderV052DeviceId";
const MIGRATION_STATE_KEY = "EnglishReaderV052HistoryMigrationState";
const VOCAB_STORAGE_KEY = "EnglishReaderV05Vocab";
const projectErrors = new WeakMap();

function makeVoice(overrides = {}) {
  return {
    name: "Samantha",
    lang: "en-US",
    voiceURI: "com.apple.voice.compact.en-US.Samantha",
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
  await page.evaluate(storageKey => localStorage.removeItem(storageKey), STORAGE_KEY);
  await page.addScriptTag({ url: "/js/preferences-backup-schema.js" });
  await page.addScriptTag({ url: "/js/preferences-repository.js" });
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

test("Repository API 冻结且只暴露严格读取与 Backup restore 边界", async ({ page }) => {
  const result = await page.evaluate(() => {
    const repository = window.LingoFlowPreferencesRepository;
    return {
      frozen: Object.isFrozen(repository),
      api: {
        list: typeof repository.list,
        get: typeof repository.get,
        assessBackupRestore: typeof repository.assessBackupRestore,
        restoreBackupItems: typeof repository.restoreBackupItems,
        patch: typeof repository.patch,
        replace: typeof repository.replace,
        clear: typeof repository.clear
      }
    };
  });

  expect(result).toEqual({
    frozen: true,
    api: {
      list: "function",
      get: "function",
      assessBackupRestore: "function",
      restoreBackupItems: "function",
      patch: "undefined",
      replace: "undefined",
      clear: "undefined"
    }
  });
});

test("missing storage 是 ready 空集合且不展开默认值", async ({ page }) => {
  const result = await page.evaluate(storageKey => ({
    raw: localStorage.getItem(storageKey),
    listed: window.LingoFlowPreferencesRepository.list()
  }), STORAGE_KEY);

  expect(result.raw).toBeNull();
  expect(result.listed).toEqual({
    status: "ready",
    storageStatus: "missing",
    preferences: [],
    errors: []
  });
});

test("显式空 object 是 present ready 空集合且不展开默认值", async ({ page }) => {
  const result = await page.evaluate(storageKey => {
    localStorage.setItem(storageKey, "{}");
    return window.LingoFlowPreferencesRepository.list();
  }, STORAGE_KEY);

  expect(result).toEqual({
    status: "ready",
    storageStatus: "present",
    preferences: [],
    errors: []
  });
});

test("单字段与显式默认值按 item collection 原样读取", async ({ page }) => {
  const result = await page.evaluate(storageKey => {
    localStorage.setItem(storageKey, JSON.stringify({ appearance: "system" }));
    return {
      listed: window.LingoFlowPreferencesRepository.list(),
      raw: JSON.parse(localStorage.getItem(storageKey))
    };
  }, STORAGE_KEY);

  expect(result.listed).toEqual({
    status: "ready",
    storageStatus: "present",
    preferences: [{ key: "appearance", value: "system" }],
    errors: []
  });
  expect(result.raw).toEqual({ appearance: "system" });
  expect(result.listed.preferences).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ key: "fontSize" })
  ]));
});

test("malformed JSON 明确 failed 且不吞成空集合", async ({ page }) => {
  const result = await page.evaluate(storageKey => {
    const raw = "{broken-preferences";
    localStorage.setItem(storageKey, raw);
    return {
      listed: window.LingoFlowPreferencesRepository.list(),
      unchanged: localStorage.getItem(storageKey) === raw
    };
  }, STORAGE_KEY);

  expect(result.listed).toMatchObject({
    status: "failed",
    storageStatus: "failed",
    preferences: [],
    reason: "preferences-storage-malformed"
  });
  expect(result.listed.errors[0]).toMatchObject({
    code: "preferences-storage-malformed"
  });
  expect(result.unchanged).toBe(true);
});

test("array、null、string 与 number root 都是 invalid storage", async ({ page }) => {
  const result = await page.evaluate(storageKey => {
    const repository = window.LingoFlowPreferencesRepository;
    return ["[]", "null", "\"abc\"", "123"].map(raw => {
      localStorage.setItem(storageKey, raw);
      return {
        raw,
        listed: repository.list(),
        unchanged: localStorage.getItem(storageKey) === raw
      };
    });
  }, STORAGE_KEY);

  for (const item of result) {
    expect(item.listed).toMatchObject({
      status: "failed",
      storageStatus: "failed",
      preferences: [],
      reason: "preferences-storage-invalid-root"
    });
    expect(item.listed.errors[0].code).toBe("preferences-storage-invalid-root");
    expect(item.unchanged).toBe(true);
  }
});

test("localStorage.getItem 异常明确返回 storage-read-failed", async ({ page }) => {
  const result = await page.evaluate(storageKey => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key) {
      if (key === storageKey) throw new DOMException("read blocked", "SecurityError");
      return original.call(this, key);
    };
    try {
      return window.LingoFlowPreferencesRepository.list();
    } finally {
      Storage.prototype.getItem = original;
    }
  }, STORAGE_KEY);

  expect(result).toMatchObject({
    status: "failed",
    storageStatus: "failed",
    preferences: [],
    reason: "preferences-storage-read-failed"
  });
  expect(result.errors[0]).toMatchObject({
    code: "preferences-storage-read-failed",
    message: "read blocked"
  });
});

test("已知非法本地 value 不做类型转换、fallback、clamp 或 trim", async ({ page }) => {
  const result = await page.evaluate(storageKey => {
    const repository = window.LingoFlowPreferencesRepository;
    const cases = [
      { fontSize: 21 },
      { fontSize: " 21 " },
      { lineHeight: 2 },
      { appearance: "auto" },
      { speechRate: "9" }
    ];
    return cases.map(value => {
      const raw = JSON.stringify(value);
      localStorage.setItem(storageKey, raw);
      return {
        listed: repository.list(),
        raw: localStorage.getItem(storageKey)
      };
    });
  }, STORAGE_KEY);

  for (const item of result) {
    expect(item.listed).toMatchObject({
      status: "failed",
      storageStatus: "failed",
      preferences: [],
      reason: "preferences-storage-invalid-entry"
    });
    expect(item.raw).toBeTruthy();
  }
});

test("reserved 与 legacy key 在现代 storage 中都明确 invalid", async ({ page }) => {
  const result = await page.evaluate(storageKey => {
    const repository = window.LingoFlowPreferencesRepository;
    return [
      { deviceId: "device:must-not-be-portable" },
      { speed: "1.15" },
      { reading: { fontSize: "21" } }
    ].map(value => {
      localStorage.setItem(storageKey, JSON.stringify(value));
      return repository.list();
    });
  }, STORAGE_KEY);

  for (const listed of result) {
    expect(listed).toMatchObject({
      status: "failed",
      storageStatus: "failed",
      preferences: [],
      reason: "preferences-storage-invalid-entry"
    });
  }
});

test("合法 unknown local preference 与嵌套 value 原样保留", async ({ page }) => {
  const value = {
    mode: "future",
    nested: [null, true, 2.5, { syncStatus: "ordinary nested data" }]
  };
  const result = await page.evaluate(({ storageKey, incoming }) => {
    localStorage.setItem(storageKey, JSON.stringify({ futureSetting: incoming }));
    return window.LingoFlowPreferencesRepository.list();
  }, { storageKey: STORAGE_KEY, incoming: value });

  expect(result).toMatchObject({ status: "ready", storageStatus: "present" });
  expect(result.preferences).toEqual([{ key: "futureSetting", value }]);
});

test("get 严格区分 missing 与 found，missing 不返回 runtime default", async ({ page }) => {
  const result = await page.evaluate(storageKey => {
    localStorage.setItem(storageKey, JSON.stringify({ appearance: "dark" }));
    const repository = window.LingoFlowPreferencesRepository;
    return {
      missing: repository.get("fontSize"),
      found: repository.get("appearance"),
      invalid: repository.get(" fontSize ")
    };
  }, STORAGE_KEY);

  expect(result.missing).toEqual({
    status: "missing",
    preferenceKey: "fontSize",
    errors: []
  });
  expect(result.missing).not.toHaveProperty("value");
  expect(result.found).toEqual({
    status: "found",
    preferenceKey: "appearance",
    value: "dark",
    errors: []
  });
  expect(result.invalid).toMatchObject({
    status: "rejected",
    preferenceKey: " fontSize "
  });
});

test("list/get 返回的深层 snapshot 可修改但不会影响 storage 或后续读取", async ({ page }) => {
  const storedValue = { nested: { labels: ["one"] } };
  const result = await page.evaluate(({ storageKey, value }) => {
    localStorage.setItem(storageKey, JSON.stringify({ futureSetting: value }));
    const repository = window.LingoFlowPreferencesRepository;
    const firstList = repository.list();
    const firstGet = repository.get("futureSetting");
    firstList.preferences[0].value.nested.labels.push("outside-list");
    firstGet.value.nested.labels.push("outside-get");
    return {
      firstList,
      firstGet,
      secondList: repository.list(),
      secondGet: repository.get("futureSetting"),
      raw: JSON.parse(localStorage.getItem(storageKey))
    };
  }, { storageKey: STORAGE_KEY, value: storedValue });

  expect(result.firstList.preferences[0].value.nested.labels).toEqual([
    "one", "outside-list"
  ]);
  expect(result.firstGet.value.nested.labels).toEqual(["one", "outside-get"]);
  expect(result.secondList.preferences[0].value).toEqual(storedValue);
  expect(result.secondGet.value).toEqual(storedValue);
  expect(result.raw).toEqual({ futureSetting: storedValue });
});

test("assessment 区分 restorable、known unchanged 与 known conflict", async ({ page }) => {
  const result = await page.evaluate(storageKey => {
    localStorage.setItem(storageKey, JSON.stringify({ appearance: "dark" }));
    const repository = window.LingoFlowPreferencesRepository;
    return {
      restorable: repository.assessBackupRestore({ key: "fontSize", value: "21" }),
      unchanged: repository.assessBackupRestore({ key: "appearance", value: "dark" }),
      conflict: repository.assessBackupRestore({ key: "appearance", value: "light" })
    };
  }, STORAGE_KEY);

  expect(result.restorable).toMatchObject({
    status: "restorable",
    preferenceKey: "fontSize",
    written: false,
    conflictFields: []
  });
  expect(result.unchanged).toMatchObject({
    status: "unchanged",
    preferenceKey: "appearance",
    written: false,
    conflictFields: []
  });
  expect(result.conflict).toMatchObject({
    status: "conflict",
    preferenceKey: "appearance",
    written: false,
    conflictFields: ["value"]
  });
});

test("speechVoice 完整三字段 exact equality，任一差异均 conflict", async ({ page }) => {
  const voice = makeVoice();
  const result = await page.evaluate(({ storageKey, value }) => {
    localStorage.setItem(storageKey, JSON.stringify({ speechVoice: value }));
    const repository = window.LingoFlowPreferencesRepository;
    return {
      exact: repository.assessBackupRestore({ key: "speechVoice", value }),
      name: repository.assessBackupRestore({
        key: "speechVoice",
        value: { ...value, name: "Alex" }
      }),
      lang: repository.assessBackupRestore({
        key: "speechVoice",
        value: { ...value, lang: "en-GB" }
      }),
      uri: repository.assessBackupRestore({
        key: "speechVoice",
        value: { ...value, voiceURI: "" }
      })
    };
  }, { storageKey: STORAGE_KEY, value: voice });

  expect(result.exact.status).toBe("unchanged");
  for (const resultKey of ["name", "lang", "uri"]) {
    expect(result[resultKey]).toMatchObject({
      status: "conflict",
      preferenceKey: "speechVoice",
      conflictFields: ["value"]
    });
  }
});

test("speechVoice:null 是显式 restorable value，不等于 missing", async ({ page }) => {
  const result = await page.evaluate(() => {
    const repository = window.LingoFlowPreferencesRepository;
    return {
      assessment: repository.assessBackupRestore({ key: "speechVoice", value: null }),
      restored: repository.restoreBackupItems([{ key: "speechVoice", value: null }]),
      found: repository.get("speechVoice")
    };
  });

  expect(result.assessment.status).toBe("restorable");
  expect(result.restored.items[0]).toMatchObject({
    status: "restored",
    preferenceKey: "speechVoice",
    written: true
  });
  expect(result.found).toEqual({
    status: "found",
    preferenceKey: "speechVoice",
    value: null,
    errors: []
  });
});

test("unknown key 分别支持 restorable、unchanged 与 conflict", async ({ page }) => {
  const result = await page.evaluate(storageKey => {
    localStorage.setItem(storageKey, JSON.stringify({
      futureSetting: { mode: "local", list: [1, 2] }
    }));
    const repository = window.LingoFlowPreferencesRepository;
    return {
      restorable: repository.assessBackupRestore({
        key: "otherFutureSetting",
        value: { enabled: true }
      }),
      unchanged: repository.assessBackupRestore({
        key: "futureSetting",
        value: { mode: "local", list: [1, 2] }
      }),
      conflict: repository.assessBackupRestore({
        key: "futureSetting",
        value: { mode: "incoming", list: [1, 2] }
      })
    };
  }, STORAGE_KEY);

  expect(result.restorable.status).toBe("restorable");
  expect(result.unchanged.status).toBe("unchanged");
  expect(result.conflict).toMatchObject({
    status: "conflict",
    conflictFields: ["value"]
  });
});

test("对象 property insertion order 不导致 conflict", async ({ page }) => {
  const result = await page.evaluate(storageKey => {
    localStorage.setItem(storageKey, JSON.stringify({
      futureSetting: {
        alpha: 1,
        nested: { first: true, second: false }
      }
    }));
    return window.LingoFlowPreferencesRepository.assessBackupRestore({
      key: "futureSetting",
      value: {
        nested: { second: false, first: true },
        alpha: 1
      }
    });
  }, STORAGE_KEY);

  expect(result).toMatchObject({
    status: "unchanged",
    preferenceKey: "futureSetting",
    conflictFields: []
  });
});

test("array order 是完整 value 事实的一部分", async ({ page }) => {
  const result = await page.evaluate(storageKey => {
    localStorage.setItem(storageKey, JSON.stringify({
      futureSetting: { values: [1, 2, 3] }
    }));
    return window.LingoFlowPreferencesRepository.assessBackupRestore({
      key: "futureSetting",
      value: { values: [3, 2, 1] }
    });
  }, STORAGE_KEY);

  expect(result).toMatchObject({
    status: "conflict",
    preferenceKey: "futureSetting",
    conflictFields: ["value"]
  });
});

test("duplicate incoming key 整批 rejected 且零写入", async ({ page }) => {
  const result = await page.evaluate(storageKey => {
    const before = localStorage.getItem(storageKey);
    const restored = window.LingoFlowPreferencesRepository.restoreBackupItems([
      { key: "appearance", value: "dark" },
      { key: "appearance", value: "dark" }
    ]);
    return {
      restored,
      raw: localStorage.getItem(storageKey),
      unchanged: localStorage.getItem(storageKey) === before
    };
  }, STORAGE_KEY);

  expect(result.restored.status).toBe("rejected");
  expect(result.restored.summary).toMatchObject({
    restored: 0,
    rejected: 1,
    notAttempted: 1
  });
  expect(result.restored.items.every(item => item.written === false)).toBe(true);
  expect(result.raw).toBeNull();
  expect(result.unchanged).toBe(true);
});

test("任一 invalid incoming item 整批 rejected，危险 getter 不执行", async ({ page }) => {
  const result = await page.evaluate(storageKey => {
    let getterCalls = 0;
    const accessor = { key: "futureSetting" };
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return true;
      }
    });
    const repository = window.LingoFlowPreferencesRepository;
    return {
      invalidKnown: repository.restoreBackupItems([
        { key: "appearance", value: "dark" },
        { key: "speechRate", value: "9" }
      ]),
      accessor: repository.restoreBackupItems([accessor]),
      getterCalls,
      raw: localStorage.getItem(storageKey)
    };
  }, STORAGE_KEY);

  expect(result.invalidKnown.status).toBe("rejected");
  expect(result.invalidKnown.summary).toMatchObject({
    restored: 0,
    rejected: 1,
    notAttempted: 1
  });
  expect(result.accessor.status).toBe("rejected");
  expect(result.getterCalls).toBe(0);
  expect(result.raw).toBeNull();
});

test("restore 按 key merge：缺失本地 key 保留且 conflict 不阻止 restorable", async ({ page }) => {
  const result = await page.evaluate(storageKey => {
    localStorage.setItem(storageKey, JSON.stringify({
      appearance: "dark",
      lineHeight: "2.2",
      localFuture: { keep: true }
    }));
    const restored = window.LingoFlowPreferencesRepository.restoreBackupItems([
      { key: "appearance", value: "light" },
      { key: "lineHeight", value: "2.2" },
      { key: "fontSize", value: "23" }
    ]);
    return {
      restored,
      stored: JSON.parse(localStorage.getItem(storageKey))
    };
  }, STORAGE_KEY);

  expect(result.restored.status).toBe("completed-with-conflicts");
  expect(result.restored.summary).toMatchObject({
    restored: 1,
    unchanged: 1,
    conflicts: 1,
    failed: 0,
    notAttempted: 0
  });
  expect(result.restored.items).toEqual([
    expect.objectContaining({
      preferenceKey: "appearance",
      status: "conflict",
      written: false,
      conflictFields: ["value"]
    }),
    expect.objectContaining({
      preferenceKey: "lineHeight",
      status: "unchanged",
      written: false
    }),
    expect.objectContaining({
      preferenceKey: "fontSize",
      status: "restored",
      written: true
    })
  ]);
  expect(result.stored).toEqual({
    appearance: "dark",
    lineHeight: "2.2",
    localFuture: { keep: true },
    fontSize: "23"
  });
});

test("本地 unknown + Backup known 与本地 known + Backup unknown 都独立 merge", async ({ page }) => {
  const result = await page.evaluate(storageKey => {
    localStorage.setItem(storageKey, JSON.stringify({
      appearance: "system",
      localFuture: { preserve: [1, 2] }
    }));
    const restored = window.LingoFlowPreferencesRepository.restoreBackupItems([
      { key: "fontSize", value: "25" },
      { key: "backupFuture", value: { imported: true } }
    ]);
    return {
      restored,
      stored: JSON.parse(localStorage.getItem(storageKey))
    };
  }, STORAGE_KEY);

  expect(result.restored.status).toBe("completed");
  expect(result.restored.summary).toMatchObject({ restored: 2, conflicts: 0 });
  expect(result.stored).toEqual({
    appearance: "system",
    localFuture: { preserve: [1, 2] },
    fontSize: "25",
    backupFuture: { imported: true }
  });
});

test("多个 restorable 构建一次 merge 并只执行一次 setItem", async ({ page }) => {
  const result = await page.evaluate(storageKey => {
    const original = Storage.prototype.setItem;
    let preferenceWrites = 0;
    Storage.prototype.setItem = function(key, value) {
      if (key === storageKey) preferenceWrites += 1;
      return original.call(this, key, value);
    };
    try {
      const restored = window.LingoFlowPreferencesRepository.restoreBackupItems([
        { key: "fontSize", value: "21" },
        { key: "appearance", value: "dark" },
        { key: "futureSetting", value: { list: [1, 2] } }
      ]);
      return {
        restored,
        preferenceWrites,
        raw: localStorage.getItem(storageKey),
        stored: JSON.parse(localStorage.getItem(storageKey))
      };
    } finally {
      Storage.prototype.setItem = original;
    }
  }, STORAGE_KEY);

  expect(result.restored.status).toBe("completed");
  expect(result.restored.summary.restored).toBe(3);
  expect(result.preferenceWrites).toBe(1);
  expect(Array.isArray(result.stored)).toBe(false);
  expect(result.stored).toEqual({
    fontSize: "21",
    appearance: "dark",
    futureSetting: { list: [1, 2] }
  });
  expect(result.raw.startsWith("{")).toBe(true);
});

test("setItem failure 对所有 restorable 诚实标记 failed 且零新事实", async ({ page }) => {
  const result = await page.evaluate(storageKey => {
    localStorage.setItem(storageKey, JSON.stringify({ appearance: "dark" }));
    const before = localStorage.getItem(storageKey);
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === storageKey) throw new DOMException("quota", "QuotaExceededError");
      return original.call(this, key, value);
    };
    try {
      const restored = window.LingoFlowPreferencesRepository.restoreBackupItems([
        { key: "fontSize", value: "21" },
        { key: "speechRate", value: "1.15" }
      ]);
      return {
        restored,
        unchanged: localStorage.getItem(storageKey) === before,
        stored: JSON.parse(localStorage.getItem(storageKey))
      };
    } finally {
      Storage.prototype.setItem = original;
    }
  }, STORAGE_KEY);

  expect(result.restored.status).toBe("interrupted");
  expect(result.restored.summary).toMatchObject({
    restored: 0,
    failed: 2,
    notAttempted: 0
  });
  expect(result.restored.items).toEqual([
    expect.objectContaining({
      preferenceKey: "fontSize",
      status: "failed",
      written: false
    }),
    expect.objectContaining({
      preferenceKey: "speechRate",
      status: "failed",
      written: false
    })
  ]);
  expect(result.restored.errors[0]).toMatchObject({
    code: "preferences-storage-write-failed",
    message: "quota"
  });
  expect(result.unchanged).toBe(true);
  expect(result.stored).toEqual({ appearance: "dark" });
});

test("write-before CAS 检测 UI 修改并阻止 Backup 覆盖新字段", async ({ page }) => {
  const result = await page.evaluate(storageKey => {
    const initial = JSON.stringify({ appearance: "dark" });
    const concurrent = JSON.stringify({ appearance: "dark", fontSize: "23" });
    localStorage.setItem(storageKey, initial);

    const originalGet = Storage.prototype.getItem;
    const originalSet = Storage.prototype.setItem;
    let preferenceReads = 0;
    let backupWrites = 0;
    Storage.prototype.getItem = function(key) {
      if (key === storageKey) {
        preferenceReads += 1;
        if (preferenceReads === 2) {
          originalSet.call(this, key, concurrent);
          return concurrent;
        }
      }
      return originalGet.call(this, key);
    };
    Storage.prototype.setItem = function(key, value) {
      if (key === storageKey) backupWrites += 1;
      return originalSet.call(this, key, value);
    };

    try {
      const restored = window.LingoFlowPreferencesRepository.restoreBackupItems([
        { key: "speechRate", value: "1.15" }
      ]);
      return {
        restored,
        preferenceReads,
        backupWrites,
        stored: JSON.parse(originalGet.call(localStorage, storageKey))
      };
    } finally {
      Storage.prototype.getItem = originalGet;
      Storage.prototype.setItem = originalSet;
    }
  }, STORAGE_KEY);

  expect(result.preferenceReads).toBeGreaterThanOrEqual(2);
  expect(result.backupWrites).toBe(0);
  expect(result.restored.status).toBe("interrupted");
  expect(result.restored.summary).toMatchObject({ restored: 0, failed: 1 });
  expect(result.restored.items[0]).toMatchObject({
    preferenceKey: "speechRate",
    status: "failed",
    written: false
  });
  expect(result.restored.errors[0].code).toBe("preferences-storage-changed");
  expect(result.stored).toEqual({ appearance: "dark", fontSize: "23" });
  expect(result.stored).not.toHaveProperty("speechRate");
});

test("restore 对输入取深安全 snapshot，调用方后续 mutation 不改变 storage", async ({ page }) => {
  const value = { mode: "future", nested: { values: [1, 2] } };
  const result = await page.evaluate(({ storageKey, incomingValue }) => {
    const item = { key: "futureSetting", value: incomingValue };
    const before = JSON.stringify(item);
    const restored = window.LingoFlowPreferencesRepository.restoreBackupItems([item]);
    const after = JSON.stringify(item);
    item.value.nested.values.push(3);
    return {
      before,
      after,
      restored,
      stored: JSON.parse(localStorage.getItem(storageKey))
    };
  }, { storageKey: STORAGE_KEY, incomingValue: value });

  expect(result.after).toBe(result.before);
  expect(result.restored.items[0]).toMatchObject({
    status: "restored",
    preferenceKey: "futureSetting",
    written: true
  });
  expect(result.stored).toEqual({ futureSetting: value });
});

test("speechVoice restore 不检查当前设备 voices", async ({ page }) => {
  const voice = makeVoice({
    name: "Voice Not Installed Here",
    voiceURI: "missing:on-target-device"
  });
  const result = await page.evaluate(incoming => {
    const original = speechSynthesis.getVoices;
    let getVoicesCalls = 0;
    speechSynthesis.getVoices = function() {
      getVoicesCalls += 1;
      throw new Error("Repository must not inspect device voices");
    };
    try {
      return {
        restored: window.LingoFlowPreferencesRepository.restoreBackupItems([
          { key: "speechVoice", value: incoming }
        ]),
        getVoicesCalls
      };
    } finally {
      speechSynthesis.getVoices = original;
    }
  }, voice);

  expect(result.getVoicesCalls).toBe(0);
  expect(result.restored.items[0]).toMatchObject({
    status: "restored",
    preferenceKey: "speechVoice",
    written: true
  });
});

test("Repository 不访问 PreferenceData、deviceId、Migration、Query History、Projector 或 Vocab", async ({ page }) => {
  const result = await page.evaluate(({ storageKey, forbiddenStorageKeys }) => {
    const originalGet = Storage.prototype.getItem;
    const originalSet = Storage.prototype.setItem;
    const touchedStorageKeys = [];
    Storage.prototype.getItem = function(key) {
      touchedStorageKeys.push({ method: "get", key });
      return originalGet.call(this, key);
    };
    Storage.prototype.setItem = function(key, value) {
      touchedStorageKeys.push({ method: "set", key });
      return originalSet.call(this, key, value);
    };

    const dependencyNames = [
      "LingoFlowLocalData",
      "LingoFlowQueryEventRepository",
      "LingoFlowHistoryBaselineRepository",
      "LingoFlowQueryHistoryMigrationCoordinator",
      "LingoFlowQueryHistoryProjector"
    ];
    const descriptors = new Map();
    let dependencyReads = 0;
    for (const name of dependencyNames) {
      descriptors.set(name, Object.getOwnPropertyDescriptor(window, name));
      Object.defineProperty(window, name, {
        configurable: true,
        get() {
          dependencyReads += 1;
          throw new Error(`Repository must not access ${name}`);
        }
      });
    }

    try {
      const restored = window.LingoFlowPreferencesRepository.restoreBackupItems([
        { key: "appearance", value: "dark" }
      ]);
      return {
        restored,
        dependencyReads,
        touchedStorageKeys,
        forbiddenTouched: touchedStorageKeys.filter(item => (
          forbiddenStorageKeys.includes(item.key)
        )),
        stored: JSON.parse(originalGet.call(localStorage, storageKey))
      };
    } finally {
      Storage.prototype.getItem = originalGet;
      Storage.prototype.setItem = originalSet;
      for (const name of dependencyNames) {
        const descriptor = descriptors.get(name);
        if (descriptor) {
          Object.defineProperty(window, name, descriptor);
        } else {
          delete window[name];
        }
      }
    }
  }, {
    storageKey: STORAGE_KEY,
    forbiddenStorageKeys: [DEVICE_ID_KEY, MIGRATION_STATE_KEY, VOCAB_STORAGE_KEY]
  });

  expect(result.restored.status).toBe("completed");
  expect(result.dependencyReads).toBe(0);
  expect(result.forbiddenTouched).toEqual([]);
  expect(new Set(result.touchedStorageKeys.map(item => item.key))).toEqual(
    new Set([STORAGE_KEY])
  );
  expect(result.stored).toEqual({ appearance: "dark" });
});
