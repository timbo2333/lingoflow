const { test, expect } = require("./progress-strict-test");

for (const oldVersion of [4, 5, 6]) test(`SyncDB v${oldVersion} to v7 preserves populated stores`, async ({ browser }) => {
  const context = await browser.newContext({ baseURL: "http://127.0.0.1:4173" });
  const page = await context.newPage();
  try {
    await page.goto("/favicon.svg");
    await page.evaluate(async oldVersion => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("LingoFlowSyncDB", oldVersion);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore("control", { keyPath: "key" });
          const sidecars = db.createObjectStore("entitySidecars", {
            keyPath: ["ownerId", "entityType", "entityId", "scope"] });
          sidecars.createIndex("byOwnerEntityType", ["ownerId", "entityType"]);
          const outbox = db.createObjectStore("outbox", { keyPath: ["ownerId", "mutationId"] });
          outbox.createIndex("byOwnerRecord", ["ownerId", "entityType", "entityId", "scope"]);
          outbox.createIndex("byOwnerStatusCreatedAt", ["ownerId", "status", "createdAt"]);
          db.createObjectStore("articleSidecars", { keyPath: ["ownerId", "articleId"] });
          const articleOutbox = db.createObjectStore("articleOutbox", { keyPath: ["ownerId", "mutationId"] });
          articleOutbox.createIndex("byOwnerBinding", ["ownerId", "bindingId"]);
          if (oldVersion >= 5) {
            const issues = db.createObjectStore("syncIssues", { keyPath: ["ownerId", "mutationId"] });
            issues.createIndex("byOwnerRecord", ["ownerId", "entityType", "entityId", "scope"]);
            issues.createIndex("byOwnerKindCreatedAt", ["ownerId", "kind", "createdAt"]);
            const inbox = db.createObjectStore("inbox", { keyPath: ["ownerId", "bindingId", "inboxSeq"] });
            inbox.createIndex("byOwnerBindingCursor", ["ownerId", "bindingId", "cursor"], { unique: true });
            inbox.createIndex("byOwnerRecordSequence", ["ownerId", "bindingId", "entityType", "entityId", "scope", "inboxSeq"]);
            db.createObjectStore("progressDesired", { keyPath: ["ownerId", "bindingId", "articleId"] });
            if (oldVersion === 6) db.createObjectStore("progressRemoteObservations", {
              keyPath: ["ownerId", "bindingId", "articleId"] });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const stores = [
          "control", "entitySidecars", "outbox", "articleSidecars", "articleOutbox"
        ];
        if (oldVersion >= 5) stores.push("progressDesired", "syncIssues", "inbox");
        if (oldVersion === 6) stores.push("progressRemoteObservations");
        const tx = db.transaction(stores, "readwrite");
        if (oldVersion >= 5) {
          const desired = tx.objectStore("progressDesired");
          desired.put({
            ownerId: "migrated-owner", bindingId: "migrated-binding", articleId: "article-1", localSeq: 42,
            pending: null, confirmed: { checkpoint: { progress: 0.3, paragraphIndex: 3,
              contentFingerprint: "sha256:" + "a".repeat(64), updatedAt: "2026-10-01T00:00:00.000Z" },
            fence: { lifecycleToken: "old-lifecycle", action: { actionId: "old-action" } } }
          });
          desired.put({
            ownerId: "migrated-owner", bindingId: "migrated-binding", articleId: "article-2", localSeq: 43,
            confirmed: null, quarantined: null, pending: {
              ownerId: "migrated-owner", bindingId: "migrated-binding", articleId: "article-2",
              actionId: "old-pending-action", localSeq: 43,
              target: { progress: 0.4, paragraphIndex: 4,
                contentFingerprint: "sha256:" + "b".repeat(64), updatedAt: "2026-10-01T00:00:01.000Z" },
              scope: { scopeToken: "old-scope" }, articleFence: { lifecycleToken: "old-lifecycle" }
            }
          });
          desired.put({ ownerId: "migrated-owner", bindingId: "migrated-binding",
            articleId: "article-3", localSeq: 44, pending: null, confirmed: null,
            quarantined: { pending: { actionId: "old-quarantined-action" }, reason: "unsafe-replay" } });
        }
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
          bindingId: "migrated-binding", mutationId: "article-mutation-1", status: "ready" });
        if (oldVersion >= 5) {
          tx.objectStore("syncIssues").put({ ownerId: "migrated-owner",
            mutationId: "favorite-issue-1", bindingId: "migrated-binding", kind: "conflict" });
          tx.objectStore("inbox").put({ ownerId: "migrated-owner", bindingId: "migrated-binding",
            inboxSeq: 1, cursor: "cursor:1", entityType: "favorites", entityId: "favorite-1", scope: "record" });
        }
        if (oldVersion === 6) tx.objectStore("progressRemoteObservations").put({
          ownerId: "migrated-owner", bindingId: "migrated-binding", articleId: "article-1",
          kind: "revision", revision: "revision:10", cursor: "cursor:10",
          parentReadingEpoch: "11111111-2222-4333-8444-555555555555",
          contentFingerprint: "sha256:" + "a".repeat(64),
          checkpoint: { progress: 0.3, paragraphIndex: 3 }
        });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, oldVersion);
    await page.goto("/");
    const result = await page.evaluate(async () => {
      const repo = window.LingoFlowSyncStateRepository;
      const db = await repo.openDatabase();
      const stores = ["control", "entitySidecars", "outbox", "articleSidecars", "articleOutbox", "progressDesired", "progressRemoteObservations", "progressCloudAttempts", "syncIssues", "inbox"];
      const raw = await Promise.all(stores.map(name => new Promise((resolve, reject) => {
        const request = db.transaction(name, "readonly").objectStore(name).getAll();
        request.onsuccess = () => resolve([name, request.result]);
        request.onerror = () => reject(request.error);
      })));
      return { version: db.version, stores: [...db.objectStoreNames],
        raw: Object.fromEntries(raw),
        indexes: {
          articleOutbox: [...db.transaction("articleOutbox").objectStore("articleOutbox").indexNames],
          inbox: [...db.transaction("inbox").objectStore("inbox").indexNames],
          progressCloudAttempts: (() => {
            const store = db.transaction("progressCloudAttempts").objectStore("progressCloudAttempts");
            return { keyPath: store.keyPath, indexes: [...store.indexNames].map(name => {
              const index = store.index(name);
              return { name, keyPath: index.keyPath, unique: index.unique };
            }) };
          })()
        },
        binding: await repo.getWorkspaceBinding(),
        progress: await repo.listProgressDesired("migrated-owner", "migrated-binding") };
    });
    expect(result.version).toBe(7);
    expect(result.stores).toContain("progressRemoteObservations");
    expect(result.stores).toContain("progressDesired");
    expect(result.stores).toContain("progressCloudAttempts");
    expect(result.indexes.articleOutbox).toContain("byOwnerBinding");
    expect(result.indexes.inbox).toEqual(expect.arrayContaining(["byOwnerBindingCursor", "byOwnerRecordSequence"]));
    expect(result.indexes.progressCloudAttempts).toEqual({
      keyPath: ["ownerId", "bindingId", "articleId", "attemptId"],
      indexes: [
        { name: "byMutation", keyPath: ["ownerId", "cloudMutationId"], unique: true },
        { name: "byOwnerBinding", keyPath: ["ownerId", "bindingId"], unique: false },
        { name: "byScope", keyPath: ["ownerId", "bindingId", "articleId"], unique: false }
      ]
    });
    if (oldVersion === 6) {
      const fresh = await browser.newContext({ baseURL: "http://127.0.0.1:4173" });
      try {
        const freshPage = await fresh.newPage();
        await freshPage.goto("/");
        const freshSchema = await freshPage.evaluate(async () => {
          const db = await window.LingoFlowSyncStateRepository.openDatabase();
          const store = db.transaction("progressCloudAttempts").objectStore("progressCloudAttempts");
          return { keyPath: store.keyPath, indexes: [...store.indexNames].map(name => {
            const index = store.index(name);
            return { name, keyPath: index.keyPath, unique: index.unique };
          }) };
        });
        expect(freshSchema).toEqual(result.indexes.progressCloudAttempts);
      } finally {
        await fresh.close();
      }
    }
    expect(result.binding).toMatchObject({ status: "ready",
      binding: { ownerId: "migrated-owner", bindingId: "migrated-binding" } });
    if (oldVersion === 4) expect(result.progress).toEqual({ status: "ready", records: [], malformedCount: 0 });
    else {
      expect(result.progress.records).toHaveLength(3);
      expect(result.progress.malformedCount).toBe(0);
      expect(result.progress.records[0]).toMatchObject({ localSeq: 42,
        confirmed: { checkpoint: { progress: 0.3 }, causalBase: { kind: "unanchored", parent: null } } });
      expect(result.raw.progressDesired[0].confirmed).not.toHaveProperty("causalBase");
      expect(result.raw.progressDesired[0].confirmed.fence).toEqual({ lifecycleToken: "old-lifecycle", action: { actionId: "old-action" } });
      expect(result.progress.records[1].pending).toMatchObject({ actionId: "old-pending-action",
        causalBase: { kind: "unanchored", parent: null } });
      expect(result.raw.progressDesired[1].pending).not.toHaveProperty("causalBase");
      expect(result.progress.records[2].quarantined).toMatchObject({
        pending: { actionId: "old-quarantined-action" }, reason: "unsafe-replay" });
      expect(result.raw.syncIssues).toHaveLength(1);
      expect(result.raw.inbox).toHaveLength(1);
    }
    expect(result.raw.progressRemoteObservations).toHaveLength(oldVersion === 6 ? 1 : 0);
    expect(result.raw.progressCloudAttempts).toEqual([]);
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
