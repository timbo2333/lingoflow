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
  await page.addScriptTag({ url: "/js/preferences-backup-export.js" });
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

test("missing storage 导出 ready 空 collection 且不创建 storage", async ({ page }) => {
  const result = await page.evaluate(async storageKey => ({
    before: localStorage.getItem(storageKey),
    exported: await window.LingoFlowPreferencesBackupExport.exportPreferences(),
    after: localStorage.getItem(storageKey),
    frozen: Object.isFrozen(window.LingoFlowPreferencesBackupExport),
    api: typeof window.LingoFlowPreferencesBackupExport.exportPreferences
  }), STORAGE_KEY);

  expect(result.exported).toEqual({
    status: "ready",
    payload: { preferences: [] }
  });
  expect(result.before).toBeNull();
  expect(result.after).toBeNull();
  expect(result.frozen).toBe(true);
  expect(result.api).toBe("function");
});

test("显式空 object 导出 ready 空 collection 且保持原 storage", async ({ page }) => {
  const result = await page.evaluate(async storageKey => {
    localStorage.setItem(storageKey, "{}");
    const before = localStorage.getItem(storageKey);
    const exported = await window.LingoFlowPreferencesBackupExport.exportPreferences();
    return { before, exported, after: localStorage.getItem(storageKey) };
  }, STORAGE_KEY);

  expect(result.exported).toEqual({
    status: "ready",
    payload: { preferences: [] }
  });
  expect(result.before).toBe("{}");
  expect(result.after).toBe(result.before);
});

test("单个 known preference 按 item collection 导出", async ({ page }) => {
  const result = await page.evaluate(async storageKey => {
    localStorage.setItem(storageKey, JSON.stringify({ appearance: "dark" }));
    return window.LingoFlowPreferencesBackupExport.exportPreferences();
  }, STORAGE_KEY);

  expect(result).toEqual({
    status: "ready",
    payload: {
      preferences: [{ key: "appearance", value: "dark" }]
    }
  });
});

test("多个 partial preferences 只导出明确保存的 key", async ({ page }) => {
  const result = await page.evaluate(async storageKey => {
    localStorage.setItem(storageKey, JSON.stringify({
      appearance: "dark",
      speechRate: "1.15"
    }));
    return window.LingoFlowPreferencesBackupExport.exportPreferences();
  }, STORAGE_KEY);

  expect(result).toEqual({
    status: "ready",
    payload: {
      preferences: [
        { key: "appearance", value: "dark" },
        { key: "speechRate", value: "1.15" }
      ]
    }
  });
});

test("显式保存的 UI 默认值仍作为用户事实导出", async ({ page }) => {
  const result = await page.evaluate(async storageKey => {
    localStorage.setItem(storageKey, JSON.stringify({
      appearance: "system",
      fontSize: "21"
    }));
    return window.LingoFlowPreferencesBackupExport.exportPreferences();
  }, STORAGE_KEY);

  expect(result).toEqual({
    status: "ready",
    payload: {
      preferences: [
        { key: "appearance", value: "system" },
        { key: "fontSize", value: "21" }
      ]
    }
  });
});

test("speechVoice null 作为显式自动选择意图原样导出", async ({ page }) => {
  const result = await page.evaluate(async storageKey => {
    localStorage.setItem(storageKey, JSON.stringify({ speechVoice: null }));
    return window.LingoFlowPreferencesBackupExport.exportPreferences();
  }, STORAGE_KEY);

  expect(result).toEqual({
    status: "ready",
    payload: {
      preferences: [{ key: "speechVoice", value: null }]
    }
  });
});

test("speechVoice resource hint object 原样导出", async ({ page }) => {
  const voice = makeVoice();
  const result = await page.evaluate(async ({ storageKey, incoming }) => {
    localStorage.setItem(storageKey, JSON.stringify({ speechVoice: incoming }));
    let getVoicesCalls = 0;
    const originalGetVoices = window.speechSynthesis.getVoices;
    window.speechSynthesis.getVoices = () => {
      getVoicesCalls += 1;
      return [];
    };
    try {
      return {
        exported: await window.LingoFlowPreferencesBackupExport.exportPreferences(),
        getVoicesCalls
      };
    } finally {
      window.speechSynthesis.getVoices = originalGetVoices;
    }
  }, { storageKey: STORAGE_KEY, incoming: voice });

  expect(result).toEqual({
    exported: {
      status: "ready",
      payload: {
        preferences: [{ key: "speechVoice", value: voice }]
      }
    },
    getVoicesCalls: 0
  });
});

test("合法 unknown preference 不因当前 UI 不认识而遗漏", async ({ page }) => {
  const result = await page.evaluate(async storageKey => {
    localStorage.setItem(storageKey, JSON.stringify({ futureSetting: "portable" }));
    return window.LingoFlowPreferencesBackupExport.exportPreferences();
  }, STORAGE_KEY);

  expect(result).toEqual({
    status: "ready",
    payload: {
      preferences: [{ key: "futureSetting", value: "portable" }]
    }
  });
});

test("unknown preference 的 nested JSON value 完整保真", async ({ page }) => {
  const value = {
    mode: "x",
    flags: [true, false],
    nested: { count: 2, optional: null }
  };
  const result = await page.evaluate(async ({ storageKey, incoming }) => {
    localStorage.setItem(storageKey, JSON.stringify({ futureSetting: incoming }));
    return window.LingoFlowPreferencesBackupExport.exportPreferences();
  }, { storageKey: STORAGE_KEY, incoming: value });

  expect(result).toEqual({
    status: "ready",
    payload: {
      preferences: [{ key: "futureSetting", value }]
    }
  });
});

test("malformed JSON 与 invalid root 都 failed 且绝不伪装为空 collection", async ({ page }) => {
  const result = await page.evaluate(async storageKey => {
    localStorage.setItem(storageKey, "{broken-preferences");
    const malformed = await window.LingoFlowPreferencesBackupExport.exportPreferences();
    const invalidRoots = [];
    for (const raw of ["[]", "null", "\"preferences\"", "7"]) {
      localStorage.setItem(storageKey, raw);
      invalidRoots.push(await window.LingoFlowPreferencesBackupExport.exportPreferences());
    }
    return { malformed, invalidRoots };
  }, STORAGE_KEY);

  expect(result.malformed).toEqual({ status: "failed", payload: null });
  for (const invalidRoot of result.invalidRoots) {
    expect(invalidRoot).toEqual({ status: "failed", payload: null });
  }
});

test("localStorage read failure 明确 failed 且 payload 为 null", async ({ page }) => {
  const result = await page.evaluate(async storageKey => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key) {
      if (key === storageKey) throw new DOMException("read blocked", "SecurityError");
      return original.call(this, key);
    };
    try {
      return await window.LingoFlowPreferencesBackupExport.exportPreferences();
    } finally {
      Storage.prototype.getItem = original;
    }
  }, STORAGE_KEY);

  expect(result).toEqual({ status: "failed", payload: null });
});

test("invalid known local preference 不转换或 fallback", async ({ page }) => {
  const result = await page.evaluate(async storageKey => {
    localStorage.setItem(storageKey, JSON.stringify({ fontSize: 21 }));
    return window.LingoFlowPreferencesBackupExport.exportPreferences();
  }, STORAGE_KEY);

  expect(result).toEqual({ status: "failed", payload: null });
});

test("reserved local key 不能通过 unknown preference 边界导出", async ({ page }) => {
  const result = await page.evaluate(async storageKey => {
    localStorage.setItem(storageKey, JSON.stringify({ deviceId: "device:local-only" }));
    return window.LingoFlowPreferencesBackupExport.exportPreferences();
  }, STORAGE_KEY);

  expect(result).toEqual({ status: "failed", payload: null });
});

test("legacy local key 不在 Export 层转换为现代 key", async ({ page }) => {
  const result = await page.evaluate(async storageKey => {
    localStorage.setItem(storageKey, JSON.stringify({ speed: "1.15" }));
    return window.LingoFlowPreferencesBackupExport.exportPreferences();
  }, STORAGE_KEY);

  expect(result).toEqual({ status: "failed", payload: null });
});

test("Repository failed result 直接失败且不执行 Schema validation", async ({ page }) => {
  const result = await page.evaluate(async () => {
    let schemaCalls = 0;
    window.LingoFlowPreferencesRepository = Object.freeze({
      list: () => ({
        status: "failed",
        storageStatus: "failed",
        preferences: [],
        reason: "preferences-storage-read-failed",
        errors: [{ code: "preferences-storage-read-failed" }]
      })
    });
    window.LingoFlowPreferencesBackupSchema = Object.freeze({
      validatePreferences: () => {
        schemaCalls += 1;
        return { status: "valid", preferences: [] };
      }
    });
    return {
      exported: await window.LingoFlowPreferencesBackupExport.exportPreferences(),
      schemaCalls
    };
  });

  expect(result).toEqual({
    exported: { status: "failed", payload: null },
    schemaCalls: 0
  });
});

test("Repository malformed result 不能产生 ready payload", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const malformedResults = [
      null,
      {},
      { status: "ready" },
      { status: "ready", preferences: {} },
      { status: "unknown", preferences: [] }
    ];
    const exported = [];
    for (const malformed of malformedResults) {
      window.LingoFlowPreferencesRepository = Object.freeze({
        list: () => malformed
      });
      exported.push(await window.LingoFlowPreferencesBackupExport.exportPreferences());
    }
    return exported;
  });

  expect(result).toHaveLength(5);
  for (const exported of result) {
    expect(exported).toEqual({ status: "failed", payload: null });
  }
});

test("Repository throw 转为 failed 且不向调用方泄漏异常", async ({ page }) => {
  const result = await page.evaluate(async () => {
    window.LingoFlowPreferencesRepository = Object.freeze({
      list: () => {
        throw new Error("repository unavailable");
      }
    });
    return window.LingoFlowPreferencesBackupExport.exportPreferences();
  });

  expect(result).toEqual({ status: "failed", payload: null });
});

test("Export 必须重新执行 Schema，并区分 rejected、malformed 与 throw", async ({ page }) => {
  const preference = { key: "appearance", value: "dark" };
  const result = await page.evaluate(async incoming => {
    const preferences = [incoming];
    let validationInput = null;
    window.LingoFlowPreferencesRepository = Object.freeze({
      list: () => ({
        status: "ready",
        storageStatus: "present",
        preferences,
        errors: []
      })
    });
    window.LingoFlowPreferencesBackupSchema = Object.freeze({
      validatePreferences: value => {
        validationInput = value;
        return { status: "rejected", preferences: [], errors: [] };
      }
    });
    const rejected = await window.LingoFlowPreferencesBackupExport.exportPreferences();
    window.LingoFlowPreferencesBackupSchema = Object.freeze({
      validatePreferences: () => ({ status: "valid", preferences: {} })
    });
    const malformed = await window.LingoFlowPreferencesBackupExport.exportPreferences();
    window.LingoFlowPreferencesBackupSchema = Object.freeze({
      validatePreferences: () => {
        throw new Error("schema unavailable");
      }
    });
    const failed = await window.LingoFlowPreferencesBackupExport.exportPreferences();
    return {
      rejected,
      malformed,
      failed,
      schemaReceivedRepositorySnapshot: validationInput === preferences
    };
  }, preference);

  expect(result).toEqual({
    rejected: { status: "rejected", payload: null },
    malformed: { status: "failed", payload: null },
    failed: { status: "failed", payload: null },
    schemaReceivedRepositorySnapshot: true
  });
});

test("partial collection 不展开任何缺失的运行时默认值", async ({ page }) => {
  const result = await page.evaluate(async storageKey => {
    localStorage.setItem(storageKey, JSON.stringify({ appearance: "system" }));
    return window.LingoFlowPreferencesBackupExport.exportPreferences();
  }, STORAGE_KEY);

  expect(result.status).toBe("ready");
  expect(result.payload.preferences).toEqual([
    { key: "appearance", value: "system" }
  ]);
  expect(result.payload.preferences.map(item => item.key)).not.toEqual(
    expect.arrayContaining(["fontSize", "lineHeight", "speechRate", "speechVoice"])
  );
});

test("Export 只调用 list 且不调用 storage 或 Repository write API", async ({ page }) => {
  const result = await page.evaluate(async storageKey => {
    const calls = {
      list: 0,
      patch: 0,
      replace: 0,
      restore: 0,
      preferenceDataGet: 0,
      preferenceDataPatch: 0,
      preferenceDataReplace: 0,
      setItem: 0
    };
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === storageKey) calls.setItem += 1;
      return originalSetItem.call(this, key, value);
    };
    window.LingoFlowPreferencesRepository = Object.freeze({
      list: () => {
        calls.list += 1;
        return {
          status: "ready",
          storageStatus: "present",
          preferences: [{ key: "appearance", value: "dark" }],
          errors: []
        };
      },
      patch: () => { calls.patch += 1; },
      replace: () => { calls.replace += 1; },
      restoreBackupItems: () => { calls.restore += 1; }
    });
    window.PreferenceData = Object.freeze({
      get: () => { calls.preferenceDataGet += 1; return {}; },
      patch: () => { calls.preferenceDataPatch += 1; },
      replace: () => { calls.preferenceDataReplace += 1; }
    });
    try {
      return {
        exported: await window.LingoFlowPreferencesBackupExport.exportPreferences(),
        calls
      };
    } finally {
      Storage.prototype.setItem = originalSetItem;
    }
  }, STORAGE_KEY);

  expect(result.exported).toEqual({
    status: "ready",
    payload: { preferences: [{ key: "appearance", value: "dark" }] }
  });
  expect(result.calls).toEqual({
    list: 1,
    patch: 0,
    replace: 0,
    restore: 0,
    preferenceDataGet: 0,
    preferenceDataPatch: 0,
    preferenceDataReplace: 0,
    setItem: 0
  });
});

test("Export 不修改 Repository 提供的 input snapshot", async ({ page }) => {
  const preference = {
    key: "futureSetting",
    value: { nested: { count: 2 }, flags: [true, false] }
  };
  const result = await page.evaluate(async incoming => {
    const repositoryResult = {
      status: "ready",
      storageStatus: "present",
      preferences: [incoming],
      errors: []
    };
    const before = JSON.stringify(repositoryResult);
    window.LingoFlowPreferencesRepository = Object.freeze({
      list: () => repositoryResult
    });
    const exported = await window.LingoFlowPreferencesBackupExport.exportPreferences();
    return {
      exported,
      before,
      after: JSON.stringify(repositoryResult),
      repositoryResult
    };
  }, preference);

  expect(result.exported).toEqual({
    status: "ready",
    payload: { preferences: [preference] }
  });
  expect(result.after).toBe(result.before);
  expect(result.repositoryResult.preferences).toEqual([preference]);
});

test("payload 与 Repository snapshot 双向隔离可变引用", async ({ page }) => {
  const preference = {
    key: "futureSetting",
    value: { mode: "x", nested: { count: 2 } }
  };
  const result = await page.evaluate(async incoming => {
    const repositoryPreferences = [incoming];
    window.LingoFlowPreferencesRepository = Object.freeze({
      list: () => ({
        status: "ready",
        storageStatus: "present",
        preferences: repositoryPreferences,
        errors: []
      })
    });
    const exported = await window.LingoFlowPreferencesBackupExport.exportPreferences();
    repositoryPreferences[0].value.nested.count = 7;
    const payloadAfterRepositoryMutation = structuredClone(exported.payload);
    exported.payload.preferences[0].value.mode = "changed-payload";
    return {
      payloadAfterRepositoryMutation,
      repositoryPreferences
    };
  }, preference);

  expect(result.payloadAfterRepositoryMutation).toEqual({
    preferences: [preference]
  });
  expect(result.repositoryPreferences).toEqual([{
    key: "futureSetting",
    value: { mode: "x", nested: { count: 7 } }
  }]);
});

test("Export 不读取或修改 DeviceId", async ({ page }) => {
  const result = await page.evaluate(async ({ storageKey, deviceIdKey }) => {
    localStorage.setItem(storageKey, JSON.stringify({ appearance: "dark" }));
    localStorage.setItem(deviceIdKey, "device:must-stay-local");
    const originalGetItem = Storage.prototype.getItem;
    const originalSetItem = Storage.prototype.setItem;
    const reads = [];
    const writes = [];
    Storage.prototype.getItem = function(key) {
      reads.push(key);
      return originalGetItem.call(this, key);
    };
    Storage.prototype.setItem = function(key, value) {
      writes.push(key);
      return originalSetItem.call(this, key, value);
    };
    try {
      const exported = await window.LingoFlowPreferencesBackupExport.exportPreferences();
      return {
        exported,
        reads,
        writes,
        deviceId: originalGetItem.call(localStorage, deviceIdKey)
      };
    } finally {
      Storage.prototype.getItem = originalGetItem;
      Storage.prototype.setItem = originalSetItem;
    }
  }, { storageKey: STORAGE_KEY, deviceIdKey: DEVICE_ID_KEY });

  expect(result.exported.status).toBe("ready");
  expect(result.reads).toEqual([STORAGE_KEY]);
  expect(result.writes).toEqual([]);
  expect(result.deviceId).toBe("device:must-stay-local");
  expect(result.exported.payload).not.toHaveProperty("deviceId");
});

test("Export 不访问 Migration State 或 Migration Coordinator", async ({ page }) => {
  const result = await page.evaluate(async ({ storageKey, migrationStateKey }) => {
    localStorage.setItem(storageKey, JSON.stringify({ appearance: "dark" }));
    localStorage.setItem(migrationStateKey, JSON.stringify({ status: "completed" }));
    const calls = { coordinator: 0, migrationReads: 0, migrationWrites: 0 };
    const originalGetItem = Storage.prototype.getItem;
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.getItem = function(key) {
      if (key === migrationStateKey) calls.migrationReads += 1;
      return originalGetItem.call(this, key);
    };
    Storage.prototype.setItem = function(key, value) {
      if (key === migrationStateKey) calls.migrationWrites += 1;
      return originalSetItem.call(this, key, value);
    };
    window.LingoFlowQueryHistoryMigrationCoordinator = Object.freeze({
      prepare: () => { calls.coordinator += 1; },
      finalize: () => { calls.coordinator += 1; },
      ensureCompleted: () => { calls.coordinator += 1; }
    });
    try {
      return {
        exported: await window.LingoFlowPreferencesBackupExport.exportPreferences(),
        calls,
        migrationState: originalGetItem.call(localStorage, migrationStateKey)
      };
    } finally {
      Storage.prototype.getItem = originalGetItem;
      Storage.prototype.setItem = originalSetItem;
    }
  }, { storageKey: STORAGE_KEY, migrationStateKey: MIGRATION_STATE_KEY });

  expect(result.exported.status).toBe("ready");
  expect(result.calls).toEqual({
    coordinator: 0,
    migrationReads: 0,
    migrationWrites: 0
  });
  expect(JSON.parse(result.migrationState)).toEqual({ status: "completed" });
});

test("Export 不访问 Query History、Projector 或 Vocab", async ({ page }) => {
  const result = await page.evaluate(async ({ storageKey, vocabStorageKey }) => {
    localStorage.setItem(storageKey, JSON.stringify({ appearance: "dark" }));
    localStorage.setItem(vocabStorageKey, JSON.stringify({
      apple: { word: "apple", count: 4 }
    }));
    const calls = {
      queryEvents: 0,
      baselines: 0,
      projector: 0,
      vocabReads: 0,
      vocabWrites: 0
    };
    const originalGetItem = Storage.prototype.getItem;
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.getItem = function(key) {
      if (key === vocabStorageKey) calls.vocabReads += 1;
      return originalGetItem.call(this, key);
    };
    Storage.prototype.setItem = function(key, value) {
      if (key === vocabStorageKey) calls.vocabWrites += 1;
      return originalSetItem.call(this, key, value);
    };
    window.LingoFlowQueryEventRepository = Object.freeze({
      list: () => { calls.queryEvents += 1; return []; }
    });
    window.LingoFlowHistoryBaselineRepository = Object.freeze({
      list: () => { calls.baselines += 1; return []; }
    });
    window.LingoFlowQueryHistoryProjector = Object.freeze({
      project: () => { calls.projector += 1; return {}; }
    });
    try {
      const exported = await window.LingoFlowPreferencesBackupExport.exportPreferences();
      return {
        exported,
        calls,
        vocab: originalGetItem.call(localStorage, vocabStorageKey)
      };
    } finally {
      Storage.prototype.getItem = originalGetItem;
      Storage.prototype.setItem = originalSetItem;
    }
  }, { storageKey: STORAGE_KEY, vocabStorageKey: VOCAB_STORAGE_KEY });

  expect(result.exported.status).toBe("ready");
  expect(result.calls).toEqual({
    queryEvents: 0,
    baselines: 0,
    projector: 0,
    vocabReads: 0,
    vocabWrites: 0
  });
  expect(JSON.parse(result.vocab)).toEqual({
    apple: { word: "apple", count: 4 }
  });
  expect(result.exported.payload).not.toHaveProperty("queryEvents");
  expect(result.exported.payload).not.toHaveProperty("historyBaselines");
  expect(result.exported.payload).not.toHaveProperty("vocab");
});
