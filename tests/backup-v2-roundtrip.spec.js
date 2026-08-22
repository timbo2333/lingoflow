const { test, expect } = require("@playwright/test");

async function loadBackupEnvironment(page) {
  await page.addInitScript(() => {
    localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
  });
  await page.goto("/");
  await expect(page.locator("#inputText")).toBeVisible();
  await page.waitForFunction(() => (
    window.LingoFlowArticleLibrary &&
    window.LingoFlowBackupV2Export &&
    window.LingoFlowBackupV2
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

test("Backup v2 export payload can restore Article data roundtrip", async ({ browser }) => {
  const article = createArticleFixture();
  const exportContext = await browser.newContext();
  let exported;

  try {
    const exportPage = await exportContext.newPage();
    await loadBackupEnvironment(exportPage);
    const exportResult = await exportPage.evaluate(async incoming => {
      const seeded = await window.LingoFlowArticleLibrary.restoreArticle(incoming);
      const backup = await window.LingoFlowBackupV2Export.exportArticles();
      return { seeded, backup };
    }, article);

    expect(exportResult.seeded).toMatchObject({
      status: "restored",
      articleId: article.id,
      written: true
    });
    expect(exportResult.backup).toEqual({
      status: "ready",
      payload: { articles: [article] }
    });
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
        payload.articles[0].id
      );
      const restored = await window.LingoFlowBackupV2.restoreArticles(payload);
      const finalArticle = await window.LingoFlowArticleLibrary.getArticle(
        payload.articles[0].id
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
