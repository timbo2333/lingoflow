const { test, expect } = require("@playwright/test");

const CREATED = "2026-09-01T01:00:00.000Z";
const UPDATED = "2026-09-02T01:00:00.000Z";
const READ = "2026-09-03T01:00:00.000Z";

function article(overrides = {}) {
  return {
    id: "article:legacy-import-42",
    title: "Local article",
    content: "Local content.",
    sourceType: "paste",
    createdAt: CREATED,
    updatedAt: UPDATED,
    deletedAt: null,
    lastReadAt: READ,
    reading: {
      progress: 0.63,
      paragraphIndex: 7,
      updatedAt: READ,
      legacyReadingPosition: { offset: 19 }
    },
    localReadingExtension: { annotation: "device-only" },
    ...overrides
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
  });
  await page.goto("/");
});

test("Article sync projection 白名单排除 reading、lastReadAt 与本地扩展", async ({ page }) => {
  const projected = await page.evaluate(value => (
    window.LingoFlowArticleSyncProjection.projectArticleForSync(value)
  ), article());
  expect(Object.keys(projected)).toEqual([
    "id", "title", "content", "sourceType", "createdAt", "updatedAt", "deletedAt"
  ]);
  expect(projected.id).toBe("article:legacy-import-42");
  expect(projected).not.toHaveProperty("reading");
  expect(projected).not.toHaveProperty("lastReadAt");
  expect(projected).not.toHaveProperty("localReadingExtension");
});

test("reading-only 更新不使 Article sync projection 变脏", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const library = window.LingoFlowArticleLibrary;
    const projection = window.LingoFlowArticleSyncProjection;
    const before = await library.createArticle({
      title: "Reading-only change",
      content: "This content is not edited.",
      sourceType: "paste"
    });
    const after = await library.updateArticleReading(before.id, {
      lastReadAt: "2026-09-04T01:00:00.000Z",
      progress: 0.63,
      paragraphIndex: 7,
      updatedAt: "2026-09-04T01:00:00.000Z"
    });
    return {
      equal: projection.compareArticleSyncProjection(before, after),
      before: projection.projectArticleForSync(before),
      after: projection.projectArticleForSync(after),
      reading: after.reading
    };
  });
  expect(result.equal).toBe(true);
  expect(result.after).toEqual(result.before);
  expect(result.reading).toMatchObject({ progress: 0.63, paragraphIndex: 7 });
});

test("来源字段仅按 Article contract 保留；远端来源切换会移除过时 metadata", async ({ page }) => {
  const local = article({
    sourceType: "library",
    sourceId: "library:edition-one",
    sourceTitle: "Edition one",
    sourceAttribution: "Local attribution"
  });
  const result = await page.evaluate(value => {
    const projection = window.LingoFlowArticleSyncProjection;
    const library = projection.projectArticleForSync(value);
    const remote = {
      ...library,
      sourceType: "paste",
      sourceId: null,
      sourceTitle: null,
      sourceAttribution: null
    };
    const merged = projection.mergeRemoteArticleProjection(value, remote);
    const changed = projection.compareArticleSyncProjection(value, merged);
    return { library, merged, changed };
  }, local);
  expect(result.library).toMatchObject({
    sourceType: "library",
    sourceId: "library:edition-one",
    sourceTitle: "Edition one"
  });
  expect(result.merged.sourceType).toBe("paste");
  expect(result.merged).not.toHaveProperty("sourceId");
  expect(result.merged).not.toHaveProperty("sourceTitle");
  expect(result.merged).not.toHaveProperty("sourceAttribution");
  expect(result.merged.reading).toEqual(local.reading);
  expect(result.changed).toBe(false);
});

test("remote 内容更新与删除都保留本地 Reading Progress 和兼容扩展", async ({ page }) => {
  const local = article();
  const result = await page.evaluate(value => {
    const projection = window.LingoFlowArticleSyncProjection;
    const incoming = {
      ...projection.projectArticleForSync(value),
      title: "Remote title",
      content: "Remote content."
    };
    const updated = projection.mergeRemoteArticleProjection(value, incoming);
    const deleted = projection.mergeRemoteArticleProjection(updated, {
      ...incoming,
      deletedAt: "2026-09-05T01:00:00.000Z"
    });
    return { updated, deleted, local: value };
  }, local);

  expect(result.updated).toMatchObject({ title: "Remote title", content: "Remote content." });
  expect(result.deleted.deletedAt).toBe("2026-09-05T01:00:00.000Z");
  for (const record of [result.updated, result.deleted]) {
    expect(record.reading).toEqual(local.reading);
    expect(record.lastReadAt).toBe(READ);
    expect(record.localReadingExtension).toEqual(local.localReadingExtension);
  }
  expect(result.local).toEqual(local);
});

test("新设备 hydrate 给出合法本地默认值，保留 UUID、fallback 与 legacy ID；非法投影拒绝", async ({ page }) => {
  const result = await page.evaluate(value => {
    const projection = window.LingoFlowArticleSyncProjection;
    const remote = projection.projectArticleForSync(value);
    const hydrated = projection.mergeRemoteArticleProjection(null, remote);
    const accepted = window.LingoFlowBackupV2Schema.validateArticle(hydrated).status;
    const stableIds = [
      "article:40c2c103-9730-4f62-9c92-290651882e85",
      "article:1770000000000:random-a:random-b",
      "article:legacy-import-42"
    ].map(id => projection.mergeRemoteArticleProjection(null, { ...remote, id }).id);
    const rejects = [
      { ...remote, id: " " },
      { ...remote, content: "  " },
      { ...remote, reading: { progress: 0.9 } },
      { ...remote, sourceType: "library", sourceId: null }
    ].map(candidate => {
      try {
        projection.sanitizeArticleSyncProjection(candidate);
        return false;
      } catch {
        return true;
      }
    });
    return { hydrated, accepted, rejects, stableIds };
  }, article());

  expect(result.hydrated.id).toBe("article:legacy-import-42");
  expect(result.hydrated.reading).toEqual({ progress: 0, paragraphIndex: 0, updatedAt: null });
  expect(result.hydrated.lastReadAt).toBe(CREATED);
  expect(result.accepted).toBe("valid");
  expect(result.stableIds).toEqual([
    "article:40c2c103-9730-4f62-9c92-290651882e85",
    "article:1770000000000:random-a:random-b",
    "article:legacy-import-42"
  ]);
  expect(result.rejects).toEqual([true, true, true, true]);
});

test("5 KB 至 1 MB 正文可稳定投影与 JSON 序列化，不推断网络上限", async ({ page }) => {
  const sizes = await page.evaluate(value => {
    const projection = window.LingoFlowArticleSyncProjection;
    return [5, 50, 250, 1024].map(kb => {
      const content = "x".repeat(kb * 1024);
      const projected = projection.projectArticleForSync({ ...value, content });
      const restored = JSON.parse(JSON.stringify(projected));
      return {
        contentBytes: new TextEncoder().encode(restored.content).length,
        serializedBytes: new TextEncoder().encode(JSON.stringify(projected)).length,
        same: projection.compareArticleSyncProjection(projected, restored)
      };
    });
  }, article());
  expect(sizes.map(item => item.contentBytes)).toEqual([
    5 * 1024, 50 * 1024, 250 * 1024, 1024 * 1024
  ]);
  expect(sizes.every(item => item.same && item.serializedBytes > item.contentBytes)).toBe(true);
});

test("Backup v2 仍导出完整 reading，不能复用 Article Cloud projection serializer", async ({ page }) => {
  const record = article();
  const result = await page.evaluate(async value => {
    await window.LingoFlowArticleLibrary.restoreArticle(value);
    const backup = await window.LingoFlowBackupV2Export.exportArticles();
    const cloud = window.LingoFlowArticleSyncProjection.projectArticleForSync(value);
    return { backup: backup.payload.articles[0], cloud };
  }, record);
  expect(result.backup.reading).toEqual(record.reading);
  expect(result.backup.lastReadAt).toBe(READ);
  expect(result.cloud).not.toHaveProperty("reading");
  expect(result.cloud).not.toHaveProperty("lastReadAt");
});
