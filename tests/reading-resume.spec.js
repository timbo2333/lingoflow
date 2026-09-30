const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
  });
  await page.goto("/");
  await expect(page.locator("#inputText")).toBeVisible();
});

test("Resume contract validates fields and preserves legacy reading extensions", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const resume = window.LingoFlowReadingResume;
    const library = window.LingoFlowArticleLibrary;
    const contentFingerprint = await resume.fingerprintContent("Article body");
    const checkpoint = resume.createCheckpoint(
      { progress: 0.3, paragraphIndex: 4 }, contentFingerprint,
      "2026-09-30T00:00:00.000Z"
    );
    const article = await library.createArticle({ content: "Article body" });
    const valid = await library.updateArticleReading(article.id, {
      progress: 0.8, paragraphIndex: 8,
      legacyExtension: { offset: 19 }, resume: checkpoint
    });
    const malformed = await library.updateArticleReading(article.id, {
      resume: { progress: -1, paragraphIndex: "4", contentFingerprint }
    });
    return {
      checkpoint, valid: valid.reading, malformed: malformed.reading,
      validForSameContent: resume.validForContent(valid.reading, contentFingerprint),
      validForOtherContent: resume.validForContent(valid.reading,
        await resume.fingerprintContent("Edited body")),
      invalids: [null, {}, { ...checkpoint, progress: 2 },
        { ...checkpoint, paragraphIndex: -1 },
        { ...checkpoint, contentFingerprint: "bad" },
        { ...checkpoint, updatedAt: "not-a-date" }]
        .map(value => resume.normalizeCheckpoint(value))
    };
  });
  expect(result.valid).toMatchObject({
    progress: 0.8, paragraphIndex: 8,
    legacyExtension: { offset: 19 }, resume: result.checkpoint
  });
  expect(result.validForSameContent).toEqual(result.checkpoint);
  expect(result.validForOtherContent).toBeNull();
  expect(result.malformed).not.toHaveProperty("resume");
  expect(result.malformed.legacyExtension).toEqual({ offset: 19 });
  expect(result.invalids).toEqual(Array(6).fill(null));
});

test("content-only SHA-256 is deterministic across payload sizes and Unicode", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const fingerprint = window.LingoFlowReadingResume.fingerprintContent;
    const encoder = new TextEncoder();
    const samples = ["Short article", "中🙂文 — English", ...[
      50_000, 250_000, 1_048_576
    ].map(bytes => "a".repeat(bytes))];
    const times = [];
    const fingerprints = [];
    for (const content of samples) {
      const started = performance.now();
      const first = await fingerprint(content);
      times.push(Math.round((performance.now() - started) * 10) / 10);
      fingerprints.push({ bytes: encoder.encode(content).length,
        first, second: await fingerprint(content) });
    }
    return { times, fingerprints,
      changedBody: (await fingerprint(samples[0])) !==
        (await fingerprint(samples[0] + "!")) };
  });
  expect(result.fingerprints.map(item => item.bytes)).toEqual([
    13, Buffer.byteLength("中🙂文 — English"), 50_000, 250_000, 1_048_576
  ]);
  for (const item of result.fingerprints) {
    expect(item.first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(item.second).toBe(item.first);
  }
  expect(result.changedBody).toBe(true);
  test.info().annotations.push({ type: "fingerprint timings ms", description: JSON.stringify(result.times) });
});

test("title-only edit keeps fingerprint and Resume; content edit keeps old Resume but invalidates it", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const library = window.LingoFlowArticleLibrary;
    const resume = window.LingoFlowReadingResume;
    const created = await library.createArticle({ title: "Before", content: "Same body" });
    const fingerprint = await resume.fingerprintContent(created.content);
    const checkpoint = resume.createCheckpoint({ progress: 0.3, paragraphIndex: 2 }, fingerprint);
    await library.updateArticleReading(created.id, { resume: checkpoint });
    const retitled = await library.updateArticle(created.id, { title: "After" });
    const edited = await library.updateArticle(created.id, { content: "Different body" });
    return {
      sameAfterTitle: resume.validForContent(retitled.reading,
        await resume.fingerprintContent(retitled.content)),
      afterContent: resume.validForContent(edited.reading,
        await resume.fingerprintContent(edited.content)),
      oldResumeRetained: edited.reading.resume,
      contentFingerprintChanged: fingerprint !== await resume.fingerprintContent(edited.content)
    };
  });
  expect(result.sameAfterTitle).toEqual(result.oldResumeRetained);
  expect(result.afterContent).toBeNull();
  expect(result.contentFingerprintChanged).toBe(true);
});

test("Resume-only local writes preserve lastReadAt and survive soft delete/restore", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const library = window.LingoFlowArticleLibrary;
    const resume = window.LingoFlowReadingResume;
    const created = await library.createArticle({ content: "Local only" });
    const checkpoint = resume.createCheckpoint({ progress: 0.4, paragraphIndex: 2 },
      await resume.fingerprintContent(created.content));
    const saved = await library.updateArticleReading(created.id, { resume: checkpoint });
    const deleted = await library.updateArticle(created.id, {
      deletedAt: "2026-09-30T00:00:00.000Z"
    });
    const restored = await library.updateArticle(created.id, { deletedAt: null });
    return { created, saved, deleted, restored };
  });
  expect(result.saved.lastReadAt).toBe(result.created.lastReadAt);
  expect(result.saved.reading).toMatchObject({
    progress: 0, paragraphIndex: 0, resume: result.saved.reading.resume
  });
  expect(result.deleted.reading.resume).toEqual(result.saved.reading.resume);
  expect(result.restored.reading.resume).toEqual(result.saved.reading.resume);
});

test("legacy Article restore accepts malformed optional Resume without storing it", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const now = "2026-09-30T00:00:00.000Z";
    const restored = await window.LingoFlowArticleLibrary.restoreArticle({
      id: "article:malformed-resume-import",
      title: "Old backup",
      content: "Old backup content",
      sourceType: "paste",
      createdAt: now,
      updatedAt: now,
      lastReadAt: now,
      deletedAt: null,
      reading: {
        progress: 0.7,
        paragraphIndex: 4,
        updatedAt: now,
        oldExtension: { anchor: "kept" },
        resume: { progress: 0.2, paragraphIndex: 1, contentFingerprint: "bad" }
      }
    });
    return { restored,
      article: await window.LingoFlowArticleLibrary.getArticle(
        "article:malformed-resume-import"
      ) };
  });
  expect(result.restored.status).toBe("restored");
  expect(result.article.reading).toMatchObject({
    progress: 0.7, paragraphIndex: 4, oldExtension: { anchor: "kept" }
  });
  expect(result.article.reading).not.toHaveProperty("resume");
});

test("over-1MiB local-only Article can still save a local Resume", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const content = "a".repeat(1_048_577);
    const library = window.LingoFlowArticleLibrary;
    const resume = window.LingoFlowReadingResume;
    const article = await library.createArticle({ content });
    const saved = await library.updateArticleReading(article.id, {
      resume: resume.createCheckpoint({ progress: 0.4, paragraphIndex: 1 },
        await resume.fingerprintContent(content))
    });
    return { bytes: new TextEncoder().encode(saved.content).length,
      reading: saved.reading,
      lastReadAtUnchanged: saved.lastReadAt === article.lastReadAt };
  });
  expect(result.bytes).toBe(1_048_577);
  expect(result.reading.resume.progress).toBe(0.4);
  expect(result.lastReadAtUnchanged).toBe(true);
});
