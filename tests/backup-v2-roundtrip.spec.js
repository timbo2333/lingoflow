const { test, expect } = require("@playwright/test");

async function loadBackupEnvironment(page) {
  await page.addInitScript(() => {
    localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
  });
  await page.goto("/");
  await expect(page.locator("#inputText")).toBeVisible();
  await page.waitForFunction(() => (
    window.LingoFlowArticleLibrary &&
    window.LingoFlowBackupV2Envelope &&
    window.LingoFlowBackupV2Export &&
    typeof window.LingoFlowBackupV2Export.exportBackup === "function" &&
    window.LingoFlowBackupV2 &&
    typeof window.LingoFlowBackupV2.restoreBackup === "function"
  ));
}

function createArticleFixture() {
  return {
    id: "article:roundtrip-article-1",
    title: "Backup Roundtrip Article",
    content: "This is a backup roundtrip test article.",
    sourceType: "paste",
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    lastReadAt: "2026-08-22T00:00:00.000Z",
    deletedAt: null,
    reading: {
      progress: 0.5,
      paragraphIndex: 2,
      updatedAt: "2026-08-22T00:00:00.000Z"
    }
  };
}

test("Backup v2 Envelope can export and restore Article data roundtrip", async ({ browser }) => {
  const article = createArticleFixture();
  const exportContext = await browser.newContext();
  let exported;

  try {
    const exportPage = await exportContext.newPage();
    await loadBackupEnvironment(exportPage);
    const exportResult = await exportPage.evaluate(async incoming => {
      const seeded = await window.LingoFlowArticleLibrary.restoreArticle(incoming);
      const backup = await window.LingoFlowBackupV2Export.exportBackup();
      const validation = backup.payload
        ? window.LingoFlowBackupV2Envelope.validateEnvelope(backup.payload)
        : null;
      return { seeded, backup, validation };
    }, article);

    expect(exportResult.seeded).toMatchObject({
      status: "restored",
      articleId: article.id,
      written: true
    });
    expect(exportResult.backup).toEqual({
      status: "ready",
      payload: {
        format: {
          name: "LingoFlow Backup",
          version: 2
        },
        metadata: {},
        schema: {
          articles: "1"
        },
        data: {
          articles: [article]
        }
      }
    });
    expect(exportResult.validation?.status).toBe("valid");
    exported = exportResult.backup.payload;
  } finally {
    await exportContext.close();
  }

  const restoreContext = await browser.newContext();
  try {
    const restorePage = await restoreContext.newPage();
    await loadBackupEnvironment(restorePage);
    const restoreResult = await restorePage.evaluate(async payload => {
      const beforeRestore = await window.LingoFlowArticleLibrary.getArticle(
        payload.data.articles[0].id
      );
      const restored = await window.LingoFlowBackupV2.restoreBackup(payload);
      const finalArticle = await window.LingoFlowArticleLibrary.getArticle(
        payload.data.articles[0].id
      );
      return { beforeRestore, restored, finalArticle };
    }, exported);

    expect(restoreResult.beforeRestore).toBeNull();
    expect(restoreResult.restored).toMatchObject({
      status: "completed",
      summary: {
        total: 1,
        restored: 1,
        unchanged: 0,
        conflicts: 0,
        rejected: 0,
        failed: 0,
        notAttempted: 0
      }
    });
    expect(restoreResult.finalArticle).toEqual(article);
  } finally {
    await restoreContext.close();
  }
});

test("Backup v2 Envelope roundtrip preserves a soft deleted Article", async ({ browser }) => {
  const article = {
    ...createArticleFixture(),
    id: "article:roundtrip-soft-deleted",
    title: "Soft Deleted Backup Roundtrip Article",
    createdAt: "2026-08-20T01:00:00.000Z",
    updatedAt: "2026-08-21T02:00:00.000Z",
    lastReadAt: "2026-08-21T03:00:00.000Z",
    deletedAt: "2026-08-22T04:00:00.000Z",
    reading: {
      progress: 0.82,
      paragraphIndex: 6,
      updatedAt: "2026-08-21T03:30:00.000Z"
    }
  };
  const exportContext = await browser.newContext();
  let exported;

  try {
    const exportPage = await exportContext.newPage();
    await loadBackupEnvironment(exportPage);
    const exportResult = await exportPage.evaluate(async incoming => {
      const seeded = await window.LingoFlowArticleLibrary.restoreArticle(incoming);
      const backup = await window.LingoFlowBackupV2Export.exportBackup();
      return { seeded, backup };
    }, article);

    expect(exportResult.seeded).toMatchObject({
      status: "restored",
      articleId: article.id,
      written: true
    });
    expect(exportResult.backup.status).toBe("ready");
    expect(exportResult.backup.payload.data.articles).toEqual([article]);
    exported = exportResult.backup.payload;
  } finally {
    await exportContext.close();
  }

  const restoreContext = await browser.newContext();
  try {
    const restorePage = await restoreContext.newPage();
    await loadBackupEnvironment(restorePage);
    const restoreResult = await restorePage.evaluate(async payload => {
      const articleId = payload.data.articles[0].id;
      const beforeRestore = await window.LingoFlowArticleLibrary.getArticle(articleId);
      const restored = await window.LingoFlowBackupV2.restoreBackup(payload);
      const finalArticle = await window.LingoFlowArticleLibrary.getArticle(articleId);
      return { beforeRestore, restored, finalArticle };
    }, exported);

    expect(restoreResult.beforeRestore).toBeNull();
    expect(restoreResult.restored).toMatchObject({
      status: "completed",
      summary: {
        total: 1,
        restored: 1,
        unchanged: 0,
        conflicts: 0,
        rejected: 0,
        failed: 0,
        notAttempted: 0
      }
    });
    expect(restoreResult.finalArticle).toEqual(article);
    expect(restoreResult.finalArticle).toMatchObject({
      createdAt: article.createdAt,
      updatedAt: article.updatedAt,
      lastReadAt: article.lastReadAt,
      deletedAt: article.deletedAt,
      reading: article.reading
    });
  } finally {
    await restoreContext.close();
  }
});
