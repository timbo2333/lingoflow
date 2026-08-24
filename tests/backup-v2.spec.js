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
  expect(await page.evaluate(() => typeof window.LingoFlowBackupV2Schema)).toBe("object");
  expect(await page.evaluate(() => typeof window.LingoFlowBackupV2Envelope)).toBe("object");
  expect(await page.evaluate(() => typeof window.LingoFlowBackupV2)).toBe("object");
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
    title: `Backup article ${id}`,
    content: `Restorable content for ${id}.`,
    sourceType: "paste",
    createdAt: "2026-08-20T01:00:00.000Z",
    updatedAt: "2026-08-20T02:00:00.000Z",
    lastReadAt: "2026-08-20T04:00:00.000Z",
    deletedAt: null,
    ...overrides,
    reading: { ...reading, ...(overrides.reading || {}) }
  };
}

test("Backup v2 拒绝无效批次并接受空 Article 集合", async ({ page }) => {
  const results = await page.evaluate(async () => {
    const backup = window.LingoFlowBackupV2;
    return {
      nullBatch: await backup.assessArticles(null),
      missingArticles: await backup.assessArticles({}),
      invalidArticles: await backup.assessArticles({ articles: {} }),
      emptyAssessment: await backup.assessArticles({ articles: [] }),
      emptyRestore: await backup.restoreArticles({ articles: [] })
    };
  });

  expect(results.nullBatch).toMatchObject({
    status: "rejected",
    errors: [{ code: "invalid-batch" }]
  });
  expect(results.missingArticles).toMatchObject({
    status: "rejected",
    errors: [{ code: "missing-articles" }]
  });
  expect(results.invalidArticles).toMatchObject({
    status: "rejected",
    errors: [{ code: "invalid-articles" }]
  });
  expect(results.emptyAssessment).toEqual({
    status: "ready",
    summary: {
      total: 0,
      restorable: 0,
      unchanged: 0,
      conflicts: 0,
      rejected: 0
    },
    items: [],
    errors: []
  });
  expect(results.emptyRestore).toEqual({
    status: "completed",
    summary: {
      total: 0,
      restored: 0,
      unchanged: 0,
      conflicts: 0,
      rejected: 0,
      failed: 0,
      notAttempted: 0
    },
    items: [],
    errors: []
  });
});

test("restoreBackup 在 Envelope 无效时阻止 Article 验证、评估和恢复", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const calls = {
      schema: 0,
      assess: 0,
      restore: 0
    };
    window.LingoFlowBackupV2Schema = Object.freeze({
      validateArticles: () => {
        calls.schema += 1;
        return { status: "valid", articles: [], items: [], errors: [] };
      }
    });
    window.LingoFlowArticleLibrary = Object.freeze({
      assessArticleRestore: async () => {
        calls.assess += 1;
        return { status: "restored", written: false };
      },
      restoreArticle: async () => {
        calls.restore += 1;
        return { status: "restored", written: true };
      }
    });

    const restored = await window.LingoFlowBackupV2.restoreBackup({
      format: { name: "LingoFlow Backup", version: 3 },
      metadata: {},
      schema: { articles: "1" },
      data: { articles: [] }
    });
    return { restored, calls };
  });

  expect(result.calls).toEqual({ schema: 0, assess: 0, restore: 0 });
  expect(result.restored).toEqual({
    status: "rejected",
    summary: {
      total: 0,
      restored: 0,
      unchanged: 0,
      conflicts: 0,
      rejected: 0,
      failed: 0,
      notAttempted: 0
    },
    items: [],
    errors: [{
      code: "unsupported-format-version",
      path: "format.version"
    }]
  });
});

test("restoreBackup 让合法 Envelope 中的非法 Article 被 Schema 拒绝且不写入", async ({ page }) => {
  const article = makeArticle("article:envelope-valid-schema-rejected");
  delete article.title;
  const result = await page.evaluate(async incoming => {
    const originalSchema = window.LingoFlowBackupV2Schema;
    const originalLibrary = window.LingoFlowArticleLibrary;
    const calls = {
      schema: 0,
      assess: 0,
      restore: 0
    };

    const built = window.LingoFlowBackupV2Envelope.buildEnvelope({
      articles: [incoming]
    });
    const envelopeValidation = built.envelope
      ? window.LingoFlowBackupV2Envelope.validateEnvelope(built.envelope)
      : null;
    const beforeRestore = await originalLibrary.getArticle(incoming.id);

    window.LingoFlowBackupV2Schema = Object.freeze({
      validateArticles: articles => {
        calls.schema += 1;
        return originalSchema.validateArticles(articles);
      }
    });
    window.LingoFlowArticleLibrary = Object.freeze({
      assessArticleRestore: async () => {
        calls.assess += 1;
        return { status: "restored", written: false };
      },
      restoreArticle: async () => {
        calls.restore += 1;
        return { status: "restored", written: true };
      }
    });

    const restored = await window.LingoFlowBackupV2.restoreBackup(built.envelope);
    const afterRestore = await originalLibrary.getArticle(incoming.id);
    return {
      buildStatus: built.status,
      envelopeStatus: envelopeValidation?.status,
      beforeRestore,
      afterRestore,
      restored,
      calls
    };
  }, article);

  expect(result.buildStatus).toBe("ready");
  expect(result.envelopeStatus).toBe("valid");
  expect(result.calls).toEqual({ schema: 1, assess: 0, restore: 0 });
  expect(result.beforeRestore).toBeNull();
  expect(result.afterRestore).toBeNull();
  expect(result.restored).toMatchObject({
    status: "rejected",
    summary: {
      total: 1,
      restored: 0,
      rejected: 1,
      failed: 0,
      notAttempted: 0
    },
    errors: [{
      code: "missing-field",
      path: "title",
      index: 0,
      articleId: article.id
    }]
  });
});

test("Backup v2 在调用 Article Library 前拒绝批内重复 ID", async ({ page }) => {
  const article = makeArticle("article:duplicate-batch");
  const result = await page.evaluate(async incoming => {
    const schema = window.LingoFlowBackupV2Schema;
    let schemaCalls = 0;
    let assessCalls = 0;
    let restoreCalls = 0;
    window.LingoFlowBackupV2Schema = Object.freeze({
      validateArticles: articles => {
        schemaCalls += 1;
        return schema.validateArticles(articles);
      }
    });
    window.LingoFlowArticleLibrary = Object.freeze({
      assessArticleRestore: async () => {
        assessCalls += 1;
        return { status: "restored", written: false };
      },
      restoreArticle: async () => {
        restoreCalls += 1;
        return { status: "restored", written: true };
      }
    });

    const assessment = await window.LingoFlowBackupV2.assessArticles({
      articles: [incoming, { ...incoming }]
    });
    const restored = await window.LingoFlowBackupV2.restoreArticles({
      articles: [incoming, { ...incoming }]
    });
    return { assessment, restored, schemaCalls, assessCalls, restoreCalls };
  }, article);

  expect(result.assessment.status).toBe("rejected");
  expect(result.assessment.errors).toContainEqual(expect.objectContaining({
    code: "duplicate-article-id",
    articleId: article.id
  }));
  expect(result.restored.status).toBe("rejected");
  expect(result.restored.summary).toMatchObject({
    total: 2,
    rejected: 1,
    notAttempted: 1
  });
  expect(result.schemaCalls).toBe(2);
  expect(result.assessCalls).toBe(0);
  expect(result.restoreCalls).toBe(0);
});

test("assessArticles 在评估前通过 Article Schema 拒绝无效数据", async ({ page }) => {
  const article = makeArticle("article:assessment-schema-rejected");
  delete article.title;
  const result = await page.evaluate(async incoming => {
    const originalSchema = window.LingoFlowBackupV2Schema;
    const calls = {
      schema: 0,
      assess: 0,
      restore: 0
    };
    window.LingoFlowBackupV2Schema = Object.freeze({
      validateArticles: articles => {
        calls.schema += 1;
        return originalSchema.validateArticles(articles);
      }
    });
    window.LingoFlowArticleLibrary = Object.freeze({
      assessArticleRestore: async () => {
        calls.assess += 1;
        return { status: "restored", written: false };
      },
      restoreArticle: async () => {
        calls.restore += 1;
        return { status: "restored", written: true };
      }
    });

    const assessment = await window.LingoFlowBackupV2.assessArticles({
      articles: [incoming]
    });
    return { assessment, calls };
  }, article);

  expect(result.calls).toEqual({ schema: 1, assess: 0, restore: 0 });
  expect(result.assessment).toEqual({
    status: "rejected",
    summary: {
      total: 1,
      restorable: 0,
      unchanged: 0,
      conflicts: 0,
      rejected: 1
    },
    items: [],
    errors: [{
      code: "missing-field",
      path: "title",
      index: 0,
      articleId: article.id
    }]
  });
});

test("assessArticles 让 Schema 与异步评估使用同一份批次快照", async ({ page }) => {
  const articles = [
    makeArticle("article:assess-snapshot-first", { title: "First snapshot title" }),
    makeArticle("article:assess-snapshot-second", { title: "Second snapshot title" })
  ];
  const result = await page.evaluate(async incoming => {
    const schema = window.LingoFlowBackupV2Schema;
    const schemaTitles = [];
    const assessedTitles = [];
    let releaseFirst;
    let notifyFirstStarted;
    const firstStarted = new Promise(resolve => {
      notifyFirstStarted = resolve;
    });
    const firstGate = new Promise(resolve => {
      releaseFirst = resolve;
    });

    window.LingoFlowBackupV2Schema = Object.freeze({
      validateArticles: candidateArticles => {
        schemaTitles.push(...candidateArticles.map(article => article.title));
        return schema.validateArticles(candidateArticles);
      }
    });
    window.LingoFlowArticleLibrary = Object.freeze({
      assessArticleRestore: async article => {
        assessedTitles.push(article.title);
        if (assessedTitles.length === 1) {
          notifyFirstStarted();
          await firstGate;
        }
        return {
          status: "restored",
          articleId: article.id,
          written: false
        };
      },
      restoreArticle: async () => {
        throw new Error("只读评估不应调用 restoreArticle。");
      }
    });

    const assessmentPromise = window.LingoFlowBackupV2.assessArticles({
      articles: incoming
    });
    await firstStarted;
    incoming[1].title = "Changed after assessment started";
    releaseFirst();
    const assessment = await assessmentPromise;
    return {
      assessment,
      schemaTitles,
      assessedTitles,
      callerSecondTitle: incoming[1].title
    };
  }, articles);

  expect(result.assessment).toMatchObject({
    status: "ready",
    summary: { total: 2, restorable: 2, rejected: 0 }
  });
  expect(result.schemaTitles).toEqual(articles.map(article => article.title));
  expect(result.assessedTitles).toEqual(result.schemaTitles);
  expect(result.callerSecondTitle).toBe("Changed after assessment started");
});

test("restoreArticles 在 Schema 验证失败时不调用 Article Library", async ({ page }) => {
  const article = makeArticle("article:schema-rejected");
  delete article.title;
  const result = await page.evaluate(async incoming => {
    let assessCalls = 0;
    let restoreCalls = 0;
    window.LingoFlowArticleLibrary = Object.freeze({
      assessArticleRestore: async () => {
        assessCalls += 1;
        return { status: "restored", written: false };
      },
      restoreArticle: async () => {
        restoreCalls += 1;
        return { status: "restored", written: true };
      }
    });

    const restored = await window.LingoFlowBackupV2.restoreArticles({
      articles: [incoming]
    });
    return { restored, assessCalls, restoreCalls };
  }, article);

  expect(result.assessCalls).toBe(0);
  expect(result.restoreCalls).toBe(0);
  expect(result.restored).toMatchObject({
    status: "rejected",
    summary: {
      total: 1,
      restored: 0,
      rejected: 1,
      failed: 0,
      notAttempted: 0
    },
    errors: [{
      code: "missing-field",
      path: "title",
      index: 0,
      articleId: article.id
    }]
  });
  expect(result.restored.items).toEqual([
    expect.objectContaining({
      index: 0,
      articleId: article.id,
      status: "rejected",
      written: false
    })
  ]);
});

test("restoreArticles 让 Schema 与 Article Library 使用同一份未修改快照", async ({ page }) => {
  const article = makeArticle("article:schema-snapshot", {
    extension: {
      labels: ["backup", "article"]
    }
  });
  const result = await page.evaluate(async incoming => {
    const schema = window.LingoFlowBackupV2Schema;
    const observations = {
      schemaCalls: 0,
      schemaBefore: null,
      schemaAfter: null,
      assessedSameArticle: false,
      restoredSameArticle: false
    };
    let schemaArticle = null;
    window.LingoFlowBackupV2Schema = Object.freeze({
      validateArticles: articles => {
        observations.schemaCalls += 1;
        schemaArticle = articles[0];
        observations.schemaBefore = JSON.stringify(articles);
        const validation = schema.validateArticles(articles);
        observations.schemaAfter = JSON.stringify(articles);
        return validation;
      }
    });
    window.LingoFlowArticleLibrary = Object.freeze({
      assessArticleRestore: async candidate => {
        observations.assessedSameArticle = candidate === schemaArticle;
        return {
          status: "restored",
          articleId: candidate.id,
          written: false
        };
      },
      restoreArticle: async candidate => {
        observations.restoredSameArticle = candidate === schemaArticle;
        return {
          status: "restored",
          articleId: candidate.id,
          written: true
        };
      }
    });

    const inputBefore = JSON.stringify(incoming);
    const restored = await window.LingoFlowBackupV2.restoreArticles({
      articles: [incoming]
    });
    return {
      restored,
      observations,
      inputBefore,
      inputAfter: JSON.stringify(incoming)
    };
  }, article);

  expect(result.restored).toMatchObject({
    status: "completed",
    summary: { total: 1, restored: 1 }
  });
  expect(result.observations.schemaCalls).toBe(1);
  expect(result.observations.schemaBefore).toBe(JSON.stringify([article]));
  expect(result.observations.schemaAfter).toBe(result.observations.schemaBefore);
  expect(result.observations.assessedSameArticle).toBe(true);
  expect(result.observations.restoredSameArticle).toBe(true);
  expect(result.inputBefore).toBe(JSON.stringify(article));
  expect(result.inputAfter).toBe(result.inputBefore);
});

test("Backup v2 在写入前拒绝批内相同来源的不同 Article ID", async ({ page }) => {
  const first = makeArticle("article:library-first", {
    sourceType: "library",
    sourceId: "library:shared-backup-source"
  });
  const second = makeArticle("article:library-second", {
    sourceType: "library",
    sourceId: "library:shared-backup-source"
  });
  const result = await page.evaluate(async articles => {
    let assessCalls = 0;
    window.LingoFlowArticleLibrary = Object.freeze({
      assessArticleRestore: async () => {
        assessCalls += 1;
        return { status: "restored", written: false };
      },
      restoreArticle: async () => ({ status: "restored", written: true })
    });
    const assessment = await window.LingoFlowBackupV2.assessArticles({ articles });
    return { assessment, assessCalls };
  }, [first, second]);

  expect(result.assessment.status).toBe("rejected");
  expect(result.assessment.errors).toContainEqual(expect.objectContaining({
    code: "duplicate-article-source",
    articleId: second.id,
    conflictingArticleId: first.id
  }));
  expect(result.assessCalls).toBe(0);
});

test("assessArticles 只调用只读评估并准确汇总结果", async ({ page }) => {
  const articles = [
    makeArticle("article:assess-restorable"),
    makeArticle("article:assess-unchanged"),
    makeArticle("article:assess-conflict")
  ];
  const result = await page.evaluate(async incoming => {
    const schema = window.LingoFlowBackupV2Schema;
    const assessed = [];
    let schemaCalls = 0;
    let restoreCalls = 0;
    window.LingoFlowBackupV2Schema = Object.freeze({
      validateArticles: candidateArticles => {
        schemaCalls += 1;
        return schema.validateArticles(candidateArticles);
      }
    });
    window.LingoFlowArticleLibrary = Object.freeze({
      assessArticleRestore: async article => {
        assessed.push(article.id);
        if (article.id.endsWith("unchanged")) {
          return { status: "unchanged", articleId: article.id, written: false };
        }
        if (article.id.endsWith("conflict")) {
          return {
            status: "conflict",
            articleId: article.id,
            written: false,
            conflicts: ["content"],
            conflictFields: ["content"]
          };
        }
        return { status: "restored", articleId: article.id, written: false };
      },
      restoreArticle: async article => {
        restoreCalls += 1;
        return { status: "restored", articleId: article.id, written: true };
      }
    });

    const assessment = await window.LingoFlowBackupV2.assessArticles({ articles: incoming });
    return { assessment, assessed, schemaCalls, restoreCalls };
  }, articles);

  expect(result.assessed).toEqual(articles.map(article => article.id));
  expect(result.schemaCalls).toBe(1);
  expect(result.restoreCalls).toBe(0);
  expect(result.assessment).toMatchObject({
    status: "ready",
    summary: {
      total: 3,
      restorable: 1,
      unchanged: 1,
      conflicts: 1,
      rejected: 0
    },
    errors: []
  });
});

test("restoreArticles 成功恢复多个 Article 并保留软删除与 Reading Progress", async ({ page }) => {
  const articles = [
    makeArticle("article:batch-first"),
    makeArticle("article:batch-deleted", {
      deletedAt: "2026-08-20T05:00:00.000Z",
      reading: {
        progress: 0.81,
        paragraphIndex: 7,
        updatedAt: "2026-08-20T04:30:00.000Z"
      }
    })
  ];
  const result = await page.evaluate(async incoming => {
    const restored = await window.LingoFlowBackupV2.restoreArticles({ articles: incoming });
    const stored = await window.LingoFlowArticleLibrary.listArticles({ includeDeleted: true });
    return { restored, stored };
  }, articles);

  expect(result.restored).toMatchObject({
    status: "completed",
    summary: {
      total: 2,
      restored: 2,
      unchanged: 0,
      conflicts: 0,
      rejected: 0,
      failed: 0,
      notAttempted: 0
    }
  });
  expect(result.stored).toHaveLength(2);
  expect(result.stored).toEqual(expect.arrayContaining(articles));
});

test("restoreArticles 遇到冲突不覆盖本地 Article", async ({ page }) => {
  const local = makeArticle("article:batch-conflict");
  const incoming = { ...local, content: "Conflicting backup content." };
  const result = await page.evaluate(async ({ localArticle, candidate }) => {
    await window.LingoFlowArticleLibrary.restoreArticle(localArticle);
    const restored = await window.LingoFlowBackupV2.restoreArticles({ articles: [candidate] });
    const stored = await window.LingoFlowArticleLibrary.getArticle(localArticle.id);
    return { restored, stored };
  }, { localArticle: local, candidate: incoming });

  expect(result.restored).toMatchObject({
    status: "completed-with-conflicts",
    summary: {
      total: 1,
      restored: 0,
      conflicts: 1,
      failed: 0,
      notAttempted: 0
    }
  });
  expect(result.stored).toEqual(local);
});

test("restoreArticles 重复恢复保持幂等", async ({ page }) => {
  const article = makeArticle("article:batch-idempotent");
  const result = await page.evaluate(async incoming => {
    const first = await window.LingoFlowBackupV2.restoreArticles({ articles: [incoming] });
    const second = await window.LingoFlowBackupV2.restoreArticles({ articles: [incoming] });
    const stored = await window.LingoFlowArticleLibrary.listArticles({ includeDeleted: true });
    return { first, second, stored };
  }, article);

  expect(result.first.summary).toMatchObject({ restored: 1, unchanged: 0 });
  expect(result.second).toMatchObject({
    status: "completed",
    summary: {
      total: 1,
      restored: 0,
      unchanged: 1,
      conflicts: 0
    }
  });
  expect(result.stored).toEqual([article]);
});

test("restoreArticles 正确汇总 Article Library 的业务结果", async ({ page }) => {
  const articles = [
    makeArticle("article:result-restored"),
    makeArticle("article:result-unchanged"),
    makeArticle("article:result-conflict"),
    makeArticle("article:result-rejected")
  ];
  const result = await page.evaluate(async incoming => {
    window.LingoFlowArticleLibrary = Object.freeze({
      assessArticleRestore: async article => ({
        status: "restored",
        articleId: article.id,
        written: false
      }),
      restoreArticle: async article => {
        const suffix = article.id.split("-").pop();
        if (suffix === "restored") {
          return { status: "restored", articleId: article.id, written: true };
        }
        if (suffix === "unchanged") {
          return { status: "unchanged", articleId: article.id, written: false };
        }
        if (suffix === "conflict") {
          return {
            status: "conflict",
            articleId: article.id,
            written: false,
            conflicts: ["lifecycle"]
          };
        }
        return {
          status: "rejected",
          articleId: article.id,
          written: false,
          reason: "invalid-article"
        };
      }
    });
    return await window.LingoFlowBackupV2.restoreArticles({ articles: incoming });
  }, articles);

  expect(result).toMatchObject({
    status: "completed-with-conflicts",
    summary: {
      total: 4,
      restored: 1,
      unchanged: 1,
      conflicts: 1,
      rejected: 1,
      failed: 0,
      notAttempted: 0
    }
  });
  expect(result.items.map(item => item.status)).toEqual([
    "restored",
    "unchanged",
    "conflict",
    "rejected"
  ]);
});

test("restoreArticles 使用独立批次快照，不受调用方后续修改影响", async ({ page }) => {
  const original = makeArticle("article:snapshot-original");
  const replacement = makeArticle("article:snapshot-replacement");
  const result = await page.evaluate(async ({ originalArticle, replacementArticle }) => {
    let assessmentStarted;
    let releaseAssessment;
    const started = new Promise(resolve => {
      assessmentStarted = resolve;
    });
    const gate = new Promise(resolve => {
      releaseAssessment = resolve;
    });
    const assessed = [];
    const restored = [];

    window.LingoFlowArticleLibrary = Object.freeze({
      assessArticleRestore: async article => {
        assessed.push(structuredClone(article));
        assessmentStarted();
        await gate;
        return {
          status: "restored",
          articleId: article.id,
          written: false
        };
      },
      restoreArticle: async article => {
        restored.push(structuredClone(article));
        return {
          status: "restored",
          articleId: article.id,
          written: true
        };
      }
    });

    const batch = { articles: [originalArticle] };
    const restorePromise = window.LingoFlowBackupV2.restoreArticles(batch);
    await started;

    originalArticle.content = "Caller changed the original Article.";
    batch.articles = [replacementArticle];
    releaseAssessment();

    const outcome = await restorePromise;
    return { outcome, assessed, restored };
  }, { originalArticle: original, replacementArticle: replacement });

  expect(result.outcome).toMatchObject({
    status: "completed",
    summary: {
      total: 1,
      restored: 1,
      failed: 0,
      notAttempted: 0
    }
  });
  expect(result.assessed).toEqual([original]);
  expect(result.restored).toEqual([original]);
});

test("restoreArticles 在任一 Article 预检 rejected 时不写入整个批次", async ({ page }) => {
  const articles = [
    makeArticle("article:preflight-ready"),
    makeArticle("article:preflight-rejected")
  ];
  const result = await page.evaluate(async incoming => {
    const assessed = [];
    const restoreCalls = [];
    window.LingoFlowArticleLibrary = Object.freeze({
      assessArticleRestore: async article => {
        assessed.push(article.id);
        if (article.id.endsWith("rejected")) {
          return {
            status: "rejected",
            articleId: article.id,
            written: false,
            reason: "invalid-article"
          };
        }
        return {
          status: "restored",
          articleId: article.id,
          written: false
        };
      },
      restoreArticle: async article => {
        restoreCalls.push(article.id);
        return {
          status: "restored",
          articleId: article.id,
          written: true
        };
      }
    });

    const outcome = await window.LingoFlowBackupV2.restoreArticles({ articles: incoming });
    return { outcome, assessed, restoreCalls };
  }, articles);

  expect(result.assessed).toEqual(articles.map(article => article.id));
  expect(result.restoreCalls).toEqual([]);
  expect(result.outcome).toMatchObject({
    status: "rejected",
    summary: {
      total: 2,
      restored: 0,
      rejected: 1,
      failed: 0,
      notAttempted: 1
    },
    errors: [{
      code: "invalid-article",
      articleId: articles[1].id
    }]
  });
  expect(result.outcome.items.map(item => item.status)).toEqual([
    "not-attempted",
    "rejected"
  ]);
});

test("restoreArticles 在存储异常后停止并准确标记未尝试项", async ({ page }) => {
  const articles = [
    makeArticle("article:interrupt-first"),
    makeArticle("article:interrupt-failed"),
    makeArticle("article:interrupt-pending")
  ];
  const result = await page.evaluate(async incoming => {
    const restoreCalls = [];
    window.LingoFlowArticleLibrary = Object.freeze({
      assessArticleRestore: async article => ({
        status: "restored",
        articleId: article.id,
        written: false
      }),
      restoreArticle: async article => {
        restoreCalls.push(article.id);
        if (article.id.endsWith("failed")) throw new Error("storage unavailable");
        return { status: "restored", articleId: article.id, written: true };
      }
    });
    const restored = await window.LingoFlowBackupV2.restoreArticles({ articles: incoming });
    return { restored, restoreCalls };
  }, articles);

  expect(result.restoreCalls).toEqual([articles[0].id, articles[1].id]);
  expect(result.restored).toMatchObject({
    status: "interrupted",
    summary: {
      total: 3,
      restored: 1,
      unchanged: 0,
      conflicts: 0,
      rejected: 0,
      failed: 1,
      notAttempted: 1
    },
    errors: [{
      code: "article-restore-failed",
      articleId: articles[1].id,
      message: "storage unavailable"
    }]
  });
  expect(result.restored.items.map(item => item.status)).toEqual([
    "restored",
    "failed",
    "not-attempted"
  ]);
});
