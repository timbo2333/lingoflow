// Mock-only fixture. No real credentials, Supabase SDK, or HTTP implementation.
async function installHarness(page, fixture = null) {
  return page.evaluate(async input => {
    const repo = window.LingoFlowSyncStateRepository;
    const lib = window.LingoFlowArticleLibrary;
    const flow = window.LingoFlowProgressLocalDesired;
    const resume = window.LingoFlowReadingResume;
    const owner = input?.owner || { ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", bindingId: "transport-binding" };
    const authState = { ownerId: owner.ownerId, status: "authenticated", calls: 0, verifiedHook: null, sessionHook: null };
    window.LingoFlowSupabaseAuth = {
      getState: () => ({ status: authState.status, user: { id: authState.ownerId } }),
      getSessionContext: async () => {
        authState.calls++;
        if (authState.verifiedHook) await authState.verifiedHook();
        return { status: "ready", user: { id: authState.ownerId } };
      },
      getPublicClient: async () => ({ auth: { getSession: async () => {
        if (authState.sessionHook) await authState.sessionHook();
        return { data: { session: { user: { id: authState.ownerId }, access_token: "mock-only-not-a-credential" } } };
      } } })
    };
    // Point mocked HTTP at a non-Supabase origin; network spies also trap the
    // real endpoint independently. Production defaults remain unconfigured.
    window.LingoFlowSupabaseConfig = { projectUrl: "https://mock.invalid", publishableKey: "mock-public" };
    if (!input) await repo.bindWorkspace(owner);
    const article = input ? await lib.getArticle(input.articleId)
      : await lib.createArticle({ content: "Mock transport fixture.\nSecond paragraph." });
    const fp = await resume.fingerprintContent(article.content);
    const epoch = "11111111-2222-4333-8444-555555555555";
    const args = [owner.ownerId, owner.bindingId, article.id];
    const raw = async (stores, work) => {
      const db = await repo.openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(stores, "readwrite"); work(tx);
        tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error);
      });
    };
    if (!input) {
      await repo.bindArticleRemoteRevision(...args, "revision:1", "a".repeat(64), "active", {
        articleRevision: "revision:1", readingEpoch: epoch, contentFingerprint: fp, lifecycle: "active" });
      const bootstrap = await repo.beginArticleBootstrap(owner.ownerId, owner.bindingId);
      await raw("control", tx => tx.objectStore("control").put({ ...bootstrap.state,
        status: "complete", phase: "complete", finalCursor: "cursor:0", pendingCursor: null,
        pendingHasMore: false, issueCount: 0 }));
      await repo.recordProgressRemoteObservation(...args, { kind: "revision", revision: "revision:10",
        cursor: "cursor:10", parentReadingEpoch: epoch, contentFingerprint: fp,
        checkpoint: { progress: 0.2, paragraphIndex: 2 } });
    }
    const movement = (progress, paragraphIndex = Math.round(progress * 10)) => flow.writeRealMovement(article.id,
      resume.createCheckpoint({ progress, paragraphIndex }, fp));
    const sent = async (progress = 0.3, paragraphIndex = Math.round(progress * 10)) => {
      await movement(progress, paragraphIndex);
      const prepared = await flow.prepareCloudAttempt(...args);
      if (prepared.status !== "prepared") throw new Error(`Fixture attempt: ${prepared.reason}`);
      const reserved = await flow.reserveCloudAttemptForDispatch(...args, prepared.attempt.attemptId);
      if (reserved.status !== "may_have_sent") throw new Error(`Fixture reserve: ${reserved.reason}`);
      return prepared.attempt;
    };
    const success = (attempt, status = "applied") => ({ status, mutationId: attempt.cloudMutationId,
      articleId: article.id, revision: status === "unchanged" ? "revision:10" : "revision:11",
      cursor: status === "unchanged" ? "cursor:10" : "cursor:11",
      progress: attempt.request.progress, paragraphIndex: attempt.request.paragraphIndex,
      parentReadingEpoch: epoch, contentFingerprint: fp, serverUpdatedAt: "2026-10-03T00:00:00Z" });
    const snapshot = async () => {
      const db = await repo.openDatabase();
      const names = ["control", "progressDesired", "progressRemoteObservations", "progressCloudAttempts",
        "articleOutbox", "articleSidecars"];
      const records = await new Promise((resolve, reject) => {
        const tx = db.transaction(names, "readonly"); const values = {};
        for (const name of names) tx.objectStore(name).getAll().onsuccess = event => { values[name] = event.target.result; };
        tx.oncomplete = () => resolve(values); tx.onerror = () => reject(tx.error);
      });
      return { records, article: await lib.getArticle(article.id) };
    };
    const authEvent = (status = "authenticated", id = authState.ownerId) => {
      authState.status = status; authState.ownerId = id;
      window.dispatchEvent(new CustomEvent("lingoflow:auth-state", { detail: { status, user: { id } } }));
    };
    const calls = [];
    const dispatcher = (respond, deadlineMs = 10000) => flow.createCloudDispatcher({ deadlineMs,
      fetchImpl: async (url, init) => {
        calls.push({ url, method: init.method, body: init.body });
        return respond(init);
      } });
    const response = (value, status = 200) => ({ status, json: async () => value });
    const alter = (attempt, work) => raw("progressCloudAttempts", tx => {
      const store = tx.objectStore("progressCloudAttempts");
      const get = store.get([...args, attempt.attemptId]);
      get.onsuccess = () => { work(get.result); store.put(get.result); };
    });
    window.h = { repo, lib, flow, resume, owner, article, fp, epoch, args, raw, movement, sent, success,
      snapshot, authState, authEvent, calls, dispatcher, response, alter };
    return { owner, articleId: article.id };
  }, fixture);
}

async function trapProgressNetwork(page) {
  page.__realProgress = [];
  page.on("request", request => {
    if (/\/rpc\/.*progress|\/rest\/v1\/progress/i.test(request.url())) page.__realProgress.push(request.url());
  });
  await page.route("https://**/*", route => route.abort());
  // Isolate this one-shot capability from the EXISTING production Article
  // worker, whose auth/startup scan would legitimately capture fixture Articles.
  // Use its existing injected gate; do not change any repository/Progress code.
  await page.route("**/js/article-sync-app-coordinator.js*", async route => {
    const response = await route.fetch();
    const source = await response.text();
    if (!source.includes("const app = create();")) throw new Error("Article fixture isolation seam changed");
    await route.fulfill({ response, body: source.replace("const app = create();", "const app = create({ gateEnabled: () => false });") });
  });
  await page.addInitScript(() => localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1"));
}

module.exports = { installHarness, trapProgressNetwork };
