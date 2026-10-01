const { test, expect } = require("@playwright/test");

test("SyncDB v4 to v5 preserves binding and creates isolated Progress store", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:4173" });
  const page = await context.newPage();
  try {
    await page.goto("/favicon.svg");
    await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("LingoFlowSyncDB", 4);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore("control", { keyPath: "key" });
          db.createObjectStore("entitySidecars", {
            keyPath: ["ownerId", "entityType", "entityId", "scope"] });
          db.createObjectStore("outbox", { keyPath: ["ownerId", "mutationId"] });
          db.createObjectStore("articleSidecars", { keyPath: ["ownerId", "articleId"] });
          db.createObjectStore("articleOutbox", { keyPath: ["ownerId", "mutationId"] });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction([
          "control", "entitySidecars", "outbox", "articleSidecars", "articleOutbox"
        ], "readwrite");
        tx.objectStore("control").put({ key: "workspace-binding",
          ownerId: "migrated-owner", bindingId: "migrated-binding" });
        tx.objectStore("control").put({ key: "article-bootstrap-state:migrated-owner:migrated-binding",
          phase: "catching-up", cursor: "12" });
        tx.objectStore("control").put({ key: "article-runtime-state:migrated-owner:migrated-binding",
          phase: "running", cursor: "13" });
        tx.objectStore("entitySidecars").put({ ownerId: "migrated-owner",
          entityType: "favorites", entityId: "favorite-1", scope: "saved", revision: 3 });
        tx.objectStore("outbox").put({ ownerId: "migrated-owner",
          mutationId: "favorite-mutation-1", status: "ready" });
        tx.objectStore("articleSidecars").put({ ownerId: "migrated-owner",
          articleId: "article-1", revision: 4 });
        tx.objectStore("articleOutbox").put({ ownerId: "migrated-owner",
          mutationId: "article-mutation-1", status: "ready" });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    });
    await page.goto("/");
    const result = await page.evaluate(async () => {
      const repo = window.LingoFlowSyncStateRepository;
      const db = await repo.openDatabase();
      const stores = ["control", "entitySidecars", "outbox", "articleSidecars", "articleOutbox"];
      const raw = await Promise.all(stores.map(name => new Promise((resolve, reject) => {
        const request = db.transaction(name, "readonly").objectStore(name).getAll();
        request.onsuccess = () => resolve([name, request.result]);
        request.onerror = () => reject(request.error);
      })));
      return { version: db.version, stores: [...db.objectStoreNames],
        raw: Object.fromEntries(raw),
        binding: await repo.getWorkspaceBinding(),
        progress: await repo.listProgressDesired("migrated-owner", "migrated-binding") };
    });
    expect(result.version).toBe(5);
    expect(result.stores).toContain("progressDesired");
    expect(result.binding).toMatchObject({ status: "ready",
      binding: { ownerId: "migrated-owner", bindingId: "migrated-binding" } });
    expect(result.progress).toEqual({ status: "ready", records: [], malformedCount: 0 });
    expect(result.raw.control).toHaveLength(3);
    expect(result.raw.control.map(item => item.key)).toEqual(expect.arrayContaining([
      "workspace-binding", "article-bootstrap-state:migrated-owner:migrated-binding",
      "article-runtime-state:migrated-owner:migrated-binding"
    ]));
    for (const name of ["entitySidecars", "outbox", "articleSidecars", "articleOutbox"]) {
      expect(result.raw[name]).toHaveLength(1);
    }
  } finally {
    await context.close();
  }
});
