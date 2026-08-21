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

test("Backup v2 在调用 Article Library 前拒绝批内重复 ID", async ({ page }) => {
  const article = makeArticle("article:duplicate-batch");
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

    const assessment = await window.LingoFlowBackupV2.assessArticles({
      articles: [incoming, { ...incoming }]
    });
    const restored = await window.LingoFlowBackupV2.restoreArticles({
      articles: [incoming, { ...incoming }]
    });
    return { assessment, restored, assessCalls, restoreCalls };
  }, article);

  expect(result.assessment.status).toBe("rejected");
  expect(result.assessment.errors).toContainEqual(expect.objectContaining({
    code: "duplicate-article-id",
    articleId: article.id
  }));
  expect(result.restored.status).toBe("rejected");
  expect(result.restored.summary).toMatchObject({
    total: 2,
    rejected: 2,
    notAttempted: 0
  });
  expect(result.assessCalls).toBe(0);
  expect(result.restoreCalls).toBe(0);
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
    const assessed = [];
    let restoreCalls = 0;
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
    return { assessment, assessed, restoreCalls };
  }, articles);

  expect(result.assessed).toEqual(articles.map(article => article.id));
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
