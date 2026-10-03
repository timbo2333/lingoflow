const { test, expect } = require("@playwright/test");

test.beforeEach(async ({ page }) => {
  page.__progressRequests = [];
  page.on("request", request => {
    if (/\/rpc\/.*progress|\/rest\/v1\/progress/i.test(request.url())) page.__progressRequests.push(request.url());
  });
  await page.route("https://**/*", route => route.abort());
  await page.addInitScript(() => localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1"));
  await page.goto("/");
  await page.evaluate(async () => {
    const repo = window.LingoFlowSyncStateRepository;
    const lib = window.LingoFlowArticleLibrary;
    const flow = window.LingoFlowProgressLocalDesired;
    const resume = window.LingoFlowReadingResume;
    const owner = { ownerId: "evidence-owner", bindingId: "evidence-binding" };
    window.LingoFlowSupabaseAuth = { getState: () => ({ status: "authenticated", user: { id: owner.ownerId } }) };
    await repo.bindWorkspace(owner);
    const article = await lib.createArticle({ content: "Evidence fixture.\nSecond paragraph." });
    const fp = await resume.fingerprintContent(article.content);
    const epoch = "11111111-2222-4333-8444-555555555555";
    const epoch2 = "22222222-2222-4333-8444-555555555555";
    const args = [owner.ownerId, owner.bindingId, article.id];
    const context = { articleRevision: "revision:1", readingEpoch: epoch, contentFingerprint: fp, lifecycle: "active" };
    const raw = async (stores, work) => {
      const db = await repo.openDatabase();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(stores, "readwrite"); work(tx);
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
      });
    };
    await repo.bindArticleRemoteRevision(...args, "revision:1", "a".repeat(64), "active", context);
    const bootstrap = await repo.beginArticleBootstrap(owner.ownerId, owner.bindingId);
    await raw("control", tx => tx.objectStore("control").put({ ...bootstrap.state,
      status: "complete", phase: "complete", finalCursor: "cursor:0", pendingCursor: null,
      pendingHasMore: false, issueCount: 0 }));
    await repo.recordProgressRemoteObservation(...args, { kind: "revision", revision: "revision:10",
      cursor: "cursor:10", parentReadingEpoch: epoch, contentFingerprint: fp,
      checkpoint: { progress: 0.2, paragraphIndex: 2 } });
    const movement = progress => flow.writeRealMovement(article.id,
      resume.createCheckpoint({ progress, paragraphIndex: Math.round(progress * 10) }, fp));
    const sent = async () => {
      await movement(0.3);
      const prepared = await flow.prepareCloudAttempt(...args);
      if (prepared.status !== "prepared") throw new Error(`Fixture attempt: ${prepared.reason}`);
      await flow.reserveCloudAttemptForDispatch(...args, prepared.attempt.attemptId);
      return prepared.attempt;
    };
    const success = attempt => ({ status: "applied", mutationId: attempt.cloudMutationId,
      articleId: article.id, revision: "revision:11", cursor: "cursor:11",
      progress: attempt.request.progress, paragraphIndex: attempt.request.paragraphIndex,
      parentReadingEpoch: epoch, contentFingerprint: fp, serverUpdatedAt: "2026-10-03T00:00:00Z" });
    const reject = (attempt, reason = "parent-not-ready") => repo.settleProgressCloudResult(...args,
      attempt.attemptId, { status: "rejected", reason, mutationId: attempt.cloudMutationId, articleId: article.id });
    const snapshot = async (parent = context) => ({ status: "found", articleId: article.id,
      projection: window.LingoFlowArticleSyncProjection.projectArticleForSync(await lib.getArticle(article.id)),
      revision: parent.articleRevision, cursor: `cursor:${parent.articleRevision.slice(9)}`,
      lifecycle: parent.lifecycle, serverReadingContext: parent });
    const begin = async () => (await repo.beginArticleServerContextObservation(...args)).ticket;
    const confirm = async (ticket, parent = context) => repo.recordArticleServerContextConfirmation(ticket, await snapshot(parent));
    const sidecar = async () => (await repo.getArticleSidecar(...args)).sidecar;
    const clockKey = `article-context-evidence:${JSON.stringify(args)}`;
    window.h = { repo, lib, flow, resume, owner, article, fp, epoch, epoch2, args, context,
      raw, movement, sent, success, reject, snapshot, begin, confirm, sidecar, clockKey };
  });
});

test.afterEach(async ({ page }) => expect(page.__progressRequests).toEqual([]));

test("wrong response identity is uncertainty; same-ID wrong payload is protocol contradiction", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const attempt = await h.sent();
    const parser = window.LingoFlowProgressCloudResult;
    const wrong = parser.parse({ ...h.success(attempt), mutationId: crypto.randomUUID() }, attempt.request);
    const payload = parser.parse({ ...h.success(attempt), progress: 0.8 }, attempt.request);
    return { wrong, payload, categories: [wrong, payload].map(value => parser.attentionCategory(value.reason, value.facts)) };
  });
  expect(result.categories).toEqual(["settlement-uncertainty", "protocol-identity-conflict"]);
  expect(result.payload.facts.mismatchedFields).toEqual(["progress"]);
});

test("recovery returns deeply frozen original IDs/payload without writes or normalization", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const attempt = await h.sent();
    await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId,
      { ...h.success(attempt), mutationId: crypto.randomUUID() });
    const before = await h.repo.listProgressCloudAttempts(...h.args);
    const recovered = await h.flow.prepareReceiptRecovery(...h.args, attempt.attemptId);
    const after = await h.repo.listProgressCloudAttempts(...h.args);
    return { attempt, recovered, before, after, frozen: Object.isFrozen(recovered) && Object.isFrozen(recovered.immutableRequest) };
  });
  expect(result.recovered).toEqual({ status: "recoverable", attemptId: result.attempt.attemptId,
    cloudMutationId: result.attempt.cloudMutationId, immutableRequest: result.attempt.request });
  expect(result.frozen).toBe(true);
  expect(result.after).toEqual(result.before);
});

for (const reason of ["mutation-id-reuse", "owner-context-mismatch", "conflicting-duplicate-result",
  "inconsistent-observation", "malformed-observation", "same-id-payload", "legacy-reason-only"]) {
  test(`${reason} fails closed and keeps the attempt occupying scope`, async ({ page }) => {
    const result = await page.evaluate(async reason => {
      const attempt = await h.sent();
      if (reason === "conflicting-duplicate-result") {
        await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId, h.success(attempt));
        await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId,
          { ...h.success(attempt), revision: "revision:12", cursor: "cursor:12" });
      } else if (["inconsistent-observation", "malformed-observation"].includes(reason)) {
        await h.raw("progressRemoteObservations", tx => tx.objectStore("progressRemoteObservations").put({
          ...h.owner, articleId: h.article.id, ...(reason === "malformed-observation" ? { kind: "broken" }
            : { kind: "revision", revision: "revision:11", cursor: "cursor:11", parentReadingEpoch: h.epoch,
              contentFingerprint: h.fp, checkpoint: { progress: 0.9, paragraphIndex: 9 } }) }));
        await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId, h.success(attempt));
      } else {
        const response = reason === "mutation-id-reuse" ? { status: "rejected", reason,
          mutationId: attempt.cloudMutationId, articleId: h.article.id }
          : reason === "owner-context-mismatch" ? { status: "rejected", reason }
            : { ...h.success(attempt), ...(reason === "same-id-payload" ? { progress: 0.9 }
              : { mutationId: crypto.randomUUID() }) };
        await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId, response);
        if (reason === "legacy-reason-only") await h.raw("progressCloudAttempts", tx => {
          const store = tx.objectStore("progressCloudAttempts");
          const get = store.get([...h.args, attempt.attemptId]);
          get.onsuccess = () => { delete get.result.settlement.facts; store.put(get.result); };
        });
      }
      return { recovery: await h.repo.prepareProgressReceiptRecovery(...h.args, attempt.attemptId),
        next: await h.flow.prepareCloudAttempt(...h.args), list: await h.repo.listProgressCloudAttempts(...h.args) };
    }, reason);
    expect(result.recovery.status).toBe("blocked");
    expect(result.list.attempts).toHaveLength(1);
    expect(result.list.attempts[0].status).toBe("settlement_attention");
    expect(result.next.status).not.toBe("prepared");
  });
}

test("mock recovered success uses ordinary settlement and preserves newer desired/pending/seq", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const attempt = await h.sent();
    await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId, { ...h.success(attempt), articleId: "other" });
    await h.movement(0.7);
    const current = await h.lib.getProgressContext(h.article.id, h.owner);
    await h.repo.prepareProgressMovement({ ...h.owner, articleId: h.article.id,
      target: h.resume.createCheckpoint({ progress: 0.8, paragraphIndex: 8 }, h.fp),
      beforeResume: current.article.reading.resume, articleFence: current.fence, scope: current.scope });
    const before = await h.repo.getProgressDesired(...h.args);
    const recovery = await h.repo.prepareProgressReceiptRecovery(...h.args, attempt.attemptId);
    const settled = await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId, h.success(attempt));
    const after = await h.repo.getProgressDesired(...h.args);
    return { before, after, recovery, settled };
  });
  expect(result.recovery.status).toBe("recoverable");
  expect(result.settled.status).toBe("succeeded");
  expect(result.after).toEqual(result.before);
  expect(result.after.record.pending).not.toBeNull();
});

test("ordinary malformed/unknown response stays may_have_sent", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const attempt = await h.sent();
    for (const response of [null, {}, { status: "unknown" }, "not-json"]) {
      await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId, response);
    }
    return h.repo.getProgressCloudAttempt(...h.args, attempt.attemptId);
  });
  expect(result.attempt.status).toBe("may_have_sent");
});

for (const ordering of ["no-confirmation", "confirmation-before-rejection", "request-before-rejection", "request-after-rejection"]) {
  test(`parent-not-ready ordering: ${ordering}`, async ({ page }) => {
    const result = await page.evaluate(async ordering => {
      const attempt = await h.sent();
      const desiredBefore = await h.repo.getProgressDesired(...h.args);
      let ticket;
      if (["confirmation-before-rejection", "request-before-rejection"].includes(ordering)) ticket = await h.begin();
      if (ordering === "confirmation-before-rejection") await h.confirm(ticket);
      const rejected = await h.reject(attempt);
      const terminal = await h.repo.getProgressCloudAttempt(...h.args, attempt.attemptId);
      if (ordering === "request-after-rejection") ticket = await h.begin();
      if (["request-before-rejection", "request-after-rejection"].includes(ordering)) await h.confirm(ticket);
      return { rejected, terminal, desiredBefore, desiredAfter: await h.repo.getProgressDesired(...h.args),
        next: await h.flow.prepareCloudAttempt(...h.args), sidecar: await h.sidecar() };
    }, ordering);
    expect(result.rejected.status).toBe("terminal");
    expect(result.terminal.attempt.settlement.parentRejection.rejectedParent).toEqual(result.terminal.attempt.sourceCausalBase.parent);
    expect(result.desiredAfter).toEqual(result.desiredBefore);
    expect(result.next.status).toBe(ordering === "request-after-rejection" ? "prepared" : "not-ready");
    if (ordering === "request-before-rejection") {
      expect(result.sidecar.serverContextConfirmation.confirmationSeq).toBeGreaterThan(result.terminal.attempt.settlement.parentRejection.confirmationSeqAtRejection ?? 0);
      expect(result.sidecar.serverContextConfirmation.requestEventOrdinal).toBeLessThan(result.terminal.attempt.settlement.parentRejection.rejectionEventOrdinal);
    }
  });
}

test("same revision current snapshot confirms once per observation, persisted reload does not increment", async ({ page }) => {
  const first = await page.evaluate(async () => {
    const ticket = await h.begin();
    const first = await h.confirm(ticket);
    const duplicate = await h.confirm(ticket);
    return { first, duplicate, args: h.args, sidecar: await h.sidecar() };
  });
  expect(first.first.status).toBe("confirmed");
  expect(first.duplicate.status).toBe("unchanged");
  expect(first.sidecar.serverContextConfirmation.confirmationSeq).toBe(1);
  await page.reload();
  const reloaded = await page.evaluate(async args => (await window.LingoFlowSyncStateRepository.getArticleSidecar(...args)).sidecar, first.args);
  expect(reloaded.serverContextConfirmation).toEqual(first.sidecar.serverContextConfirmation);
});

for (const reason of ["parent-epoch-mismatch", "fingerprint-mismatch", "article-deleted"]) {
  test(`${reason} cannot be washed away by same-context confirmation`, async ({ page }) => {
    const result = await page.evaluate(async reason => {
      const attempt = await h.sent(); await h.reject(attempt, reason);
      await h.confirm(await h.begin());
      return h.flow.prepareCloudAttempt(...h.args);
    }, reason);
    expect(result.reason).toBe("parent-refresh-required");
  });
}

test("new legal epoch establishes evidence but does not rebase old desired", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const attempt = await h.sent(); await h.reject(attempt, "parent-epoch-mismatch");
    const before = await h.repo.getProgressDesired(...h.args);
    const context = { ...h.context, articleRevision: "revision:2", readingEpoch: h.epoch2 };
    const confirmed = await h.confirm(await h.begin(), context);
    await h.repo.bindArticleRemoteRevision(...h.args, "revision:2", "b".repeat(64), "active", context);
    return { confirmed, before, after: await h.repo.getProgressDesired(...h.args), next: await h.flow.prepareCloudAttempt(...h.args) };
  });
  expect(result.confirmed.status).toBe("confirmed");
  expect(result.after).toEqual(result.before);
  expect(result.next.reason).toBe("parent-epoch-mismatch");
});

test("same epoch contradictory fingerprint/stale or malformed snapshot cannot confirm", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const ticket = await h.begin();
    const malformed = await h.repo.recordArticleServerContextConfirmation(ticket, { status: "found" });
    const contradiction = await h.confirm(ticket, { ...h.context, articleRevision: "revision:2", lifecycle: "deleted" });
    const valid = await h.confirm(ticket);
    return { malformed, contradiction, valid, sidecar: await h.sidecar() };
  });
  expect(result.malformed.status).toBe("invalid-current-snapshot");
  expect(result.contradiction.status).toBe("invalid-current-snapshot");
  expect(result.valid.status).toBe("confirmed");
  expect(result.sidecar.serverContextConfirmation.confirmationSeq).toBe(1);
});

test("generic context/bind, local save/Resume and Backup export never confirm", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.confirm(await h.begin());
    const first = (await h.sidecar()).serverContextConfirmation;
    await h.repo.recordArticleServerReadingContext(...h.args, h.context);
    await h.repo.bindArticleRemoteRevision(...h.args, "revision:1", "a".repeat(64), "active", h.context);
    await h.repo.setArticleSidecarLifecycle(...h.args, "revision:1", "active", h.context);
    await h.lib.updateArticle(h.article.id, { title: "Local title" });
    await h.movement(0.4);
    const exported = await window.LingoFlowBackupV2Export.exportBackup();
    return { first, after: (await h.sidecar()).serverContextConfirmation,
      backup: JSON.stringify(exported.payload), version: h.repo.DB_VERSION };
  });
  expect(result.after).toEqual(result.first);
  expect(result.backup).not.toMatch(/serverContextConfirmation|confirmationSeq|requestEventOrdinal|rejectionEventOrdinal/);
  expect(result.version).toBe(7);
});

test("confirmation and rejection writes each roll back atomically on transaction abort", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const attempt = await h.sent(); const ticket = await h.begin();
    const original = IDBObjectStore.prototype.put;
    let failStore = "control";
    IDBObjectStore.prototype.put = function(...args) {
      if (this.name === failStore && (args[0]?.kind === "article-context-evidence" || args[0]?.status === "terminal")) {
        throw new DOMException("injected evidence abort", "QuotaExceededError");
      }
      return original.apply(this, args);
    };
    let confirmationFailed = false, rejectionFailed = false;
    try { await h.confirm(ticket); } catch { confirmationFailed = true; }
    const before = await h.sidecar();
    failStore = "progressCloudAttempts";
    try { await h.reject(attempt); } catch { rejectionFailed = true; }
    IDBObjectStore.prototype.put = original;
    const stored = await h.repo.getProgressCloudAttempt(...h.args, attempt.attemptId);
    const completed = await h.reject(attempt);
    return { confirmationFailed, rejectionFailed, before, stored, completed,
      final: await h.repo.getProgressCloudAttempt(...h.args, attempt.attemptId), ticket };
  });
  expect(result.confirmationFailed).toBe(true);
  expect(result.rejectionFailed).toBe(true);
  expect(result.before.serverContextConfirmation).toBeUndefined();
  expect(result.stored.attempt.status).toBe("may_have_sent");
  expect(result.final.attempt.settlement.parentRejection.rejectionEventOrdinal).toBe(result.ticket.requestEventOrdinal + 1);
});

for (const counter of ["malformed", "exhausted"]) {
  test(`evidence ${counter} counter fails closed without reset`, async ({ page }) => {
    const result = await page.evaluate(async counter => {
      await h.begin();
      await h.raw("control", tx => {
        const store = tx.objectStore("control"); const get = store.get(h.clockKey);
        get.onsuccess = () => store.put({ ...get.result, eventOrdinal: counter === "malformed" ? -1 : Number.MAX_SAFE_INTEGER });
      });
      return h.repo.beginArticleServerContextObservation(...h.args);
    }, counter);
    expect(result.status).toBe(counter === "malformed" ? "malformed-confirmation-evidence" : "evidence-counter-exhausted");
  });
}

test("generation guard rejects an old snapshot callback", async ({ page }) => {
  const result = await page.evaluate(async () => {
    let generation = 1;
    const guard = () => generation === 1;
    const ticket = (await h.repo.beginArticleServerContextObservation(...h.args, guard)).ticket;
    generation++;
    const result = await h.repo.recordArticleServerContextConfirmation(ticket, await h.snapshot(), guard);
    return { result, sidecar: await h.sidecar() };
  });
  expect(result.result).toEqual({ status: "blocked", reason: "scope-mismatch" });
  expect(result.sidecar.serverContextConfirmation).toBeUndefined();
});

for (const sameOwner of [false, true]) {
  test(`replacement isolates old evidence/recovery (${sameOwner ? "new binding" : "new owner"})`, async ({ page }) => {
    const result = await page.evaluate(async sameOwner => {
      const attempt = await h.sent();
      await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId, { ...h.success(attempt), articleId: "other" });
      const ticket = await h.begin();
      const next = { ownerId: sameOwner ? h.owner.ownerId : "evidence-owner-b", bindingId: "evidence-binding-b" };
      if (sameOwner) await h.raw("control", tx => tx.objectStore("control").put({ key: "workspace-binding", ...next }));
      else await h.repo.replaceWorkspaceBinding({ from: h.owner, to: next, accountLabel: "B" });
      window.LingoFlowSupabaseAuth = { getState: () => ({ status: "authenticated", user: { id: next.ownerId } }) };
      return { recovery: await h.repo.prepareProgressReceiptRecovery(...h.args, attempt.attemptId),
        confirmation: await h.confirm(ticket) };
    }, sameOwner);
    expect(result.recovery.status).toBe("blocked");
    expect(result.confirmation.status).toBe("blocked");
  });
}

test("two real tabs obtain the same recovery request without minting IDs", async ({ page }) => {
  const data = await page.evaluate(async () => {
    const attempt = await h.sent();
    await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId, { ...h.success(attempt), articleId: "other" });
    return { args: h.args, attempt };
  });
  const second = await page.context().newPage();
  await second.goto("/");
  await second.evaluate(ownerId => {
    window.LingoFlowSupabaseAuth = { getState: () => ({ status: "authenticated", user: { id: ownerId } }) };
  }, data.args[0]);
  const [a, b] = await Promise.all([page, second].map(tab => tab.evaluate(async data =>
    window.LingoFlowSyncStateRepository.prepareProgressReceiptRecovery(...data.args, data.attempt.attemptId), data)));
  expect(a).toEqual(b);
  expect(a.status).toBe("recoverable");
  await second.close();
});

test("existing Article snapshot seam confirms once with mock HTTP; push receipt never confirms", async ({ page }) => {
  const result = await page.evaluate(async () => {
    let generation = 1; const captured = generation;
    const snap = await h.snapshot(); const calls = [];
    const service = window.LingoFlowArticleSyncCloudService.create({ projectUrl: "https://example.supabase.co",
      publishableKey: "test-publishable", state: h.repo, captureSnapshotGuard: () => () => generation === captured,
      auth: { getSessionContext: async () => ({ status: "ready", user: { id: h.owner.ownerId } }), getAccessToken: async () => "test-token" },
      fetchImpl: async url => { calls.push(url.split("/").at(-1)); return { ok: true, status: 200,
        json: async () => ({ ...snap, readingEpoch: h.epoch, contentFingerprint: h.fp }) }; }
    });
    await service.snapshot(h.owner, h.article.id);
    const first = (await h.sidecar()).serverContextConfirmation;
    await h.repo.recordArticleServerReadingContext(...h.args, h.context);
    return { calls, first, after: (await h.sidecar()).serverContextConfirmation };
  });
  expect(result.calls).toEqual(["lingoflow_article_sync_snapshot"]);
  expect(result.first.confirmationSeq).toBe(1);
  expect(result.after).toEqual(result.first);
});

test("missing baseline is null while an initialized zero counter is exactly zero", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const attempt = await h.sent(); await h.reject(attempt);
    const stored = await h.repo.getProgressCloudAttempt(...h.args, attempt.attemptId);
    return stored.attempt.settlement.parentRejection;
  });
  expect(result.confirmationSeqAtRejection).toBeNull();
  // The request-before-rejection integration above initializes a legitimate
  // zero counter; this is different from guessing evidence for an old row.
  const initialized = await page.evaluate(async () => {
    await h.confirm(await h.begin());
    await h.raw("progressCloudAttempts", tx => tx.objectStore("progressCloudAttempts").clear());
    const next = await h.sent(); await h.reject(next);
    return (await h.repo.getProgressCloudAttempt(...h.args, next.attemptId)).attempt.settlement.parentRejection;
  });
  expect(initialized.confirmationSeqAtRejection).toBe(1);
});

test("request start initializes zero evidence baseline without claiming a confirmation", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const attempt = await h.sent(); await h.begin(); await h.reject(attempt);
    return (await h.repo.getProgressCloudAttempt(...h.args, attempt.attemptId)).attempt.settlement.parentRejection;
  });
  expect(result.confirmationSeqAtRejection).toBe(0);
});

test("legacy terminal without rejection evidence stays blocked after a current snapshot", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const attempt = await h.sent(); await h.reject(attempt);
    await h.raw("progressCloudAttempts", tx => {
      const store = tx.objectStore("progressCloudAttempts"); const get = store.get([...h.args, attempt.attemptId]);
      get.onsuccess = () => { delete get.result.settlement.parentRejection; store.put(get.result); };
    });
    await h.confirm(await h.begin());
    return h.flow.prepareCloudAttempt(...h.args);
  });
  expect(result.reason).toBe("parent-refresh-required");
});

test("valid contradictory same-epoch content is diagnosed, not fresh confirmation", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const ticket = await h.begin(); const snapshot = await h.snapshot();
    snapshot.projection.content = "Different content in the very same epoch";
    snapshot.serverReadingContext = { ...h.context, articleRevision: "revision:2",
      contentFingerprint: await h.resume.fingerprintContent(snapshot.projection.content) };
    snapshot.revision = "revision:2"; snapshot.cursor = "cursor:2";
    const wrong = await h.repo.recordArticleServerContextConfirmation(ticket, snapshot);
    const replay = await h.confirm(ticket);
    return { wrong, replay, sidecar: await h.sidecar() };
  });
  expect(result.wrong.status).toBe("inconsistent-parent-context");
  expect(result.replay.status).toBe("parent-context-diagnostic");
  expect(result.sidecar.serverContextConfirmation).toBeUndefined();
});

test("stale current snapshot cannot increment confirmation", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const parent = { ...h.context, articleRevision: "revision:2" };
    await h.confirm(await h.begin(), parent);
    await h.repo.bindArticleRemoteRevision(...h.args, "revision:2", "b".repeat(64), "active", parent);
    const first = (await h.sidecar()).serverContextConfirmation;
    const stale = await h.confirm(await h.begin());
    return { stale, first, after: (await h.sidecar()).serverContextConfirmation };
  });
  expect(result.stale.status).toBe("stale-parent-context");
  expect(result.after).toEqual(result.first);
});

test("deleted-parent needs post-rejection active restore context, not a historical bind", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const attempt = await h.sent(); await h.reject(attempt, "article-deleted");
    const restored = { ...h.context, articleRevision: "revision:3", readingEpoch: h.epoch2 };
    await h.repo.bindArticleRemoteRevision(...h.args, restored.articleRevision, "b".repeat(64), "active", restored);
    const blocked = await h.flow.prepareCloudAttempt(...h.args);
    await h.confirm(await h.begin(), restored);
    const unrebase = await h.flow.prepareCloudAttempt(...h.args);
    await h.movement(0.4);
    const next = await h.flow.prepareCloudAttempt(...h.args);
    return { blocked, unrebase, next };
  });
  expect(result.blocked.reason).toBe("parent-refresh-required");
  expect(result.unrebase.reason).toBe("parent-epoch-mismatch");
  expect(result.next.status).toBe("prepared");
});

test("fingerprint mismatch requires legal new epoch and local-content-compatible new movement", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const attempt = await h.sent(); await h.reject(attempt, "fingerprint-mismatch");
    await h.lib.updateArticle(h.article.id, { content: "Legally edited local content." });
    const fingerprint = await h.resume.fingerprintContent((await h.lib.getArticle(h.article.id)).content);
    const parent = { ...h.context, articleRevision: "revision:2", readingEpoch: h.epoch2, contentFingerprint: fingerprint };
    await h.confirm(await h.begin(), parent);
    await h.repo.bindArticleRemoteRevision(...h.args, "revision:2", "b".repeat(64), "active", parent);
    const old = await h.flow.prepareCloudAttempt(...h.args);
    await h.flow.writeRealMovement(h.article.id, h.resume.createCheckpoint({ progress: 0.4, paragraphIndex: 4 }, fingerprint));
    const fresh = await h.flow.prepareCloudAttempt(...h.args);
    return { old, fresh, fingerprint };
  });
  expect(result.old.status).not.toBe("prepared");
  expect(result.fresh.status).toBe("prepared");
  expect(result.fresh.attempt.request.contentFingerprint).toBe(result.fingerprint);
});

test("workspace switching fence blocks recovery and snapshot evidence even before binding replacement", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const attempt = await h.sent(); await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId,
      { ...h.success(attempt), mutationId: crypto.randomUUID() });
    const ticket = await h.begin(); const snapshot = await h.snapshot();
    await h.lib.beginWorkspaceTransition({ from: h.owner,
      to: { ownerId: "other-owner", bindingId: "other-binding" }, storageSnapshot: [] });
    return { recovery: await h.flow.prepareReceiptRecovery(...h.args, attempt.attemptId),
      confirmation: await h.repo.recordArticleServerContextConfirmation(ticket, snapshot),
      begin: await h.repo.beginArticleServerContextObservation(...h.args) };
  });
  expect(result.recovery.status).toBe("blocked");
  expect(result.confirmation.status).toBe("blocked");
  expect(result.begin.status).toBe("blocked");
});

test("Backup import preserves resume without introducing evidence or unlocking a gate", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const attempt = await h.sent(); await h.reject(attempt);
    const article = await h.lib.getArticle(h.article.id);
    const importedId = `article:imported-evidence:${crypto.randomUUID()}`;
    const restored = await window.LingoFlowBackupV2.restoreArticles({ articles: [{ ...article, id: importedId }] });
    return { restored, imported: await h.lib.getArticle(importedId), article,
      importedDesired: await h.repo.getProgressDesired(h.owner.ownerId, h.owner.bindingId, importedId),
      sidecar: await h.sidecar(), next: await h.flow.prepareCloudAttempt(...h.args) };
  });
  expect(result.restored.status).toBe("completed");
  expect(result.restored.summary.rejected).toBe(0);
  expect(result.restored.summary.restored).toBe(1);
  expect(result.imported.reading.resume).toEqual(result.article.reading.resume);
  expect(result.importedDesired.record).toBeNull();
  expect(result.sidecar.serverContextConfirmation).toBeUndefined();
  expect(result.next.status).not.toBe("prepared");
});

test("historical applied/unchanged Article receipts establish context but never confirmation", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const engine = window.LingoFlowArticleSyncLocalEngine.create();
    const created = await engine.createArticle({ content: "Historical receipt body." }, h.owner);
    const mutation = (await h.repo.listArticleMutations(h.owner.ownerId, h.owner.bindingId)).items[0];
    const parent = { articleRevision: "revision:1", readingEpoch: h.epoch,
      contentFingerprint: await h.resume.fingerprintContent(mutation.candidate.content), lifecycle: "active" };
    const result = await h.repo.settleArticleMutationSuccess(h.owner.ownerId, h.owner.bindingId, mutation.mutationId,
      { status: "unchanged", mutationId: mutation.mutationId, articleId: created.article.id,
        operation: "put", revision: "revision:1", cursor: "cursor:1", serverReadingContext: parent });
    return { result, sidecar: (await h.repo.getArticleSidecar(h.owner.ownerId, h.owner.bindingId, created.article.id)).sidecar };
  });
  expect(result.result.status).toBe("settled");
  expect(result.sidecar.serverReadingContext.articleRevision).toBe("revision:1");
  expect(result.sidecar.serverContextConfirmation).toBeUndefined();
});

test("runtime history, empty pull and cursor advancement cannot increase sequence", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.confirm(await h.begin()); const before = (await h.sidecar()).serverContextConfirmation;
    await h.repo.beginArticleRuntime(h.owner.ownerId, h.owner.bindingId);
    await h.repo.persistArticleRuntimePullPage(h.owner.ownerId, h.owner.bindingId, "cursor:0",
      { status: "ready", changes: [], nextCursor: "cursor:0", hasMore: false });
    const committed = await h.repo.commitArticleRuntimePullPage(h.owner.ownerId, h.owner.bindingId);
    // This is the exact sidecar ingestion boundary used for historical runtime changes.
    await h.repo.bindArticleRemoteRevision(...h.args, "revision:2", "b".repeat(64), "active", { ...h.context, articleRevision: "revision:2" });
    return { before, after: (await h.sidecar()).serverContextConfirmation, committed };
  });
  expect(result.committed.status).toBe("committed");
  expect(result.after).toEqual(result.before);
});

test("two tabs allocate unique durable request ordinals and duplicate responses do not reconfirm", async ({ page }) => {
  const second = await page.context().newPage(); await second.goto("/");
  const args = await page.evaluate(() => h.args);
  await second.evaluate(ownerId => { window.LingoFlowSupabaseAuth = { getState: () => ({ status: "authenticated", user: { id: ownerId } }) }; }, args[0]);
  const tickets = await Promise.all([page, second].map(tab => tab.evaluate(async args =>
    window.LingoFlowSyncStateRepository.beginArticleServerContextObservation(...args), args)));
  expect(new Set(tickets.map(value => value.ticket.requestEventOrdinal)).size).toBe(2);
  const ticket = tickets.sort((a, b) => b.ticket.requestEventOrdinal - a.ticket.requestEventOrdinal)[0].ticket;
  const snapshot = await page.evaluate(() => h.snapshot());
  const confirmations = await Promise.all([page, second].map(tab => tab.evaluate(async ({ ticket, snapshot }) =>
    window.LingoFlowSyncStateRepository.recordArticleServerContextConfirmation(ticket, snapshot), { ticket, snapshot })));
  expect(confirmations.map(value => value.status).sort()).toEqual(["confirmed", "unchanged"]);
  await second.close();
});

test("malformed confirmation evidence blocks parent release; counter never resets", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const attempt = await h.sent(); await h.reject(attempt); await h.confirm(await h.begin());
    await h.raw("articleSidecars", tx => {
      const store = tx.objectStore("articleSidecars"); const get = store.get([h.owner.ownerId, h.article.id]);
      get.onsuccess = () => store.put({ ...get.result,
        serverContextConfirmation: { ...get.result.serverContextConfirmation, confirmationSeq: "bad" } });
    });
    return { next: await h.flow.prepareCloudAttempt(...h.args), begin: await h.repo.beginArticleServerContextObservation(...h.args) };
  });
  expect(result.next.status).not.toBe("prepared");
  expect(result.begin.status).toBe("malformed-confirmation-evidence");
});

test("request without runtime-generation context never fabricates snapshot evidence", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const snapshot = await h.snapshot(); let calls = 0;
    const service = window.LingoFlowArticleSyncCloudService.create({ projectUrl: "https://example.supabase.co",
      publishableKey: "test-publishable", captureSnapshotGuard: () => null,
      auth: { getSessionContext: async () => ({ status: "ready", user: { id: h.owner.ownerId } }), getAccessToken: async () => "test-token" },
      fetchImpl: async () => { calls++; return { ok: true, status: 200, json: async () => ({ ...snapshot, readingEpoch: h.epoch, contentFingerprint: h.fp }) }; } });
    await service.snapshot(h.owner, h.article.id);
    return { calls, sidecar: await h.sidecar() };
  });
  expect(result.calls).toBe(1);
  expect(result.sidecar.serverContextConfirmation).toBeUndefined();
});

for (const responseType of ["conflict", "rejected"]) {
  test(`wrong-ID ${responseType} retains safe uncertainty facts`, async ({ page }) => {
    const result = await page.evaluate(async responseType => {
      const attempt = await h.sent();
      const response = { status: responseType, mutationId: crypto.randomUUID(), articleId: h.article.id,
        reason: responseType === "conflict" ? "revision-mismatch" : "parent-not-ready",
        ...(responseType === "conflict" ? { currentRevision: "revision:11", currentCursor: "cursor:11" } : {}) };
      await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId, response);
      return { recovered: await h.repo.prepareProgressReceiptRecovery(...h.args, attempt.attemptId),
        attempt: (await h.repo.getProgressCloudAttempt(...h.args, attempt.attemptId)).attempt };
    }, responseType);
    expect(result.recovered.status).toBe("recoverable");
    expect(result.attempt.settlement.facts).toEqual({ mutationIdMatches: false, articleIdMatches: true,
      mismatchedFields: ["mutationId"], hadAcceptedCanonicalResult: false });
  });
}

test("malformed identity/facts do not grant a recovery path", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const attempt = await h.sent();
    const malformed = await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId,
      { ...h.success(attempt), mutationId: undefined });
    await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId, { ...h.success(attempt), articleId: "other" });
    await h.raw("progressCloudAttempts", tx => {
      const store = tx.objectStore("progressCloudAttempts"); const get = store.get([...h.args, attempt.attemptId]);
      get.onsuccess = () => { get.result.settlement.facts.mismatchedFields = ["invented-field"]; store.put(get.result); };
    });
    return { malformed, recovery: await h.repo.prepareProgressReceiptRecovery(...h.args, attempt.attemptId) };
  });
  expect(result.malformed.status).toBe("unparseable");
  expect(result.recovery.status).toBe("malformed-attempt");
  const next = await page.evaluate(() => h.flow.prepareCloudAttempt(...h.args));
  expect(next.status).toBe("malformed-attempt");
});

test("recovery cannot overwrite an observation diagnostic discovered afterwards", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const attempt = await h.sent(); await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId,
      { ...h.success(attempt), articleId: "other" });
    await h.raw("progressRemoteObservations", tx => {
      const store = tx.objectStore("progressRemoteObservations"); const get = store.get(h.args);
      get.onsuccess = () => store.put({ ...get.result, diagnostic: { reason: "inconsistent-observation" } });
    });
    return { recovery: await h.repo.prepareProgressReceiptRecovery(...h.args, attempt.attemptId),
      settlement: await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId, h.success(attempt)),
      attempt: (await h.repo.getProgressCloudAttempt(...h.args, attempt.attemptId)).attempt };
  });
  expect(result.recovery).toEqual({ status: "blocked", reason: "local-authority-contradiction" });
  expect(result.settlement.status).toBe("blocked");
  expect(result.attempt.status).toBe("settlement_attention");
});

test("confirmation sequence exhaustion is diagnostic, never wrap/reset", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.confirm(await h.begin());
    const ticket = { ...h.owner, articleId: h.article.id, observationId: crypto.randomUUID(), requestEventOrdinal: Number.MAX_SAFE_INTEGER };
    await h.raw(["control", "articleSidecars"], tx => {
      const control = tx.objectStore("control"); const getClock = control.get(h.clockKey);
      getClock.onsuccess = () => control.put({ ...getClock.result, eventOrdinal: Number.MAX_SAFE_INTEGER,
        confirmationSeq: Number.MAX_SAFE_INTEGER, lastConfirmedRequestOrdinal: Number.MAX_SAFE_INTEGER - 1, requests: [ticket] });
      const store = tx.objectStore("articleSidecars"); const get = store.get([h.owner.ownerId, h.article.id]);
      get.onsuccess = () => store.put({ ...get.result, serverContextConfirmation: { ...get.result.serverContextConfirmation,
        confirmationSeq: Number.MAX_SAFE_INTEGER, requestEventOrdinal: Number.MAX_SAFE_INTEGER - 1 } });
    });
    const confirmation = await h.confirm(ticket);
    return { confirmation, seq: (await h.sidecar()).serverContextConfirmation.confirmationSeq };
  });
  expect(result.confirmation.status).toBe("evidence-counter-exhausted");
  expect(result.seq).toBe(Number.MAX_SAFE_INTEGER);
});

test("one observation replay with different canonical facts is a contradiction, never a new confirmation", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const ticket = await h.begin(); await h.confirm(ticket);
    const first = (await h.sidecar()).serverContextConfirmation;
    const response = await h.snapshot(); response.cursor = "cursor:2";
    const duplicate = await h.repo.recordArticleServerContextConfirmation(ticket, response);
    return { duplicate, first, sidecar: await h.sidecar(), parent: await h.repo.getArticleServerReadingContext(...h.args) };
  });
  expect(result.duplicate.status).toBe("contradictory-current-snapshot");
  expect(result.sidecar.serverContextConfirmation).toEqual(result.first);
  expect(result.parent.context).toBeNull();
});

test("generation changed during snapshot validation cannot write a parent diagnostic", async ({ page }) => {
  const result = await page.evaluate(async () => {
    let current = true;
    const guard = () => current;
    const ticket = (await h.repo.beginArticleServerContextObservation(...h.args, guard)).ticket;
    const snapshot = await h.snapshot({ ...h.context, readingEpoch: h.epoch2 });
    const original = window.LingoFlowReadingResume;
    window.LingoFlowReadingResume = { ...original, fingerprintContent: async content => {
      const fingerprint = await original.fingerprintContent(content);
      current = false;
      return fingerprint;
    } };
    const before = await h.sidecar();
    const response = await h.repo.recordArticleServerContextConfirmation(ticket, snapshot, guard);
    window.LingoFlowReadingResume = original;
    return { response, before, after: await h.sidecar() };
  });
  expect(result.response).toEqual({ status: "blocked", reason: "scope-mismatch" });
  expect(result.after).toEqual(result.before);
});

test("generation changed during duplicate diagnostic write rolls back the whole transaction", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const ticket = await h.begin(); await h.confirm(ticket);
    const before = await h.sidecar();
    const snapshot = await h.snapshot(); snapshot.cursor = "cursor:2";
    let current = true;
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, ...args) {
      const request = original.call(this, value, ...args);
      if (this.name === "articleSidecars" && value.serverReadingContextDiagnostic) {
        request.addEventListener("success", () => { current = false; });
      }
      return request;
    };
    let response;
    try { response = await h.repo.recordArticleServerContextConfirmation(ticket, snapshot, () => current); }
    catch (error) { response = { status: "aborted", name: error.name }; }
    finally { IDBObjectStore.prototype.put = original; }
    return { response, before, after: await h.sidecar() };
  });
  expect(["blocked", "aborted"]).toContain(result.response.status);
  expect(result.after).toEqual(result.before);
});

test("generation changed during parent contradiction write also rolls back", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const ticket = await h.begin(); const before = await h.sidecar();
    const snapshot = await h.snapshot({ ...h.context, readingEpoch: h.epoch2 });
    let current = true;
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(value, ...args) {
      const request = original.call(this, value, ...args);
      if (this.name === "articleSidecars" && value.serverReadingContextDiagnostic) {
        request.addEventListener("success", () => { current = false; });
      }
      return request;
    };
    let response;
    try { response = await h.repo.recordArticleServerContextConfirmation(ticket, snapshot, () => current); }
    catch (error) { response = { status: "aborted", name: error.name }; }
    finally { IDBObjectStore.prototype.put = original; }
    return { response, before, after: await h.sidecar() };
  });
  expect(["blocked", "aborted"]).toContain(result.response.status);
  expect(result.after).toEqual(result.before);
});

test("new same-context snapshot is fresh, repeated rejection takes a new baseline", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const first = await h.sent(); await h.reject(first);
    await h.confirm(await h.begin());
    const second = await h.flow.prepareCloudAttempt(...h.args);
    await h.flow.reserveCloudAttemptForDispatch(...h.args, second.attempt.attemptId);
    await h.reject(second.attempt);
    const rejected = (await h.repo.getProgressCloudAttempt(...h.args, second.attempt.attemptId)).attempt;
    const blocked = await h.flow.prepareCloudAttempt(...h.args);
    const snapshot = await h.confirm(await h.begin());
    const next = await h.flow.prepareCloudAttempt(...h.args);
    return { first, second, rejected, blocked, snapshot, next };
  });
  expect(result.second.attempt.attemptId).not.toBe(result.first.attemptId);
  expect(result.rejected.settlement.parentRejection.confirmationSeqAtRejection).toBe(1);
  expect(result.blocked.reason).toBe("parent-refresh-required");
  expect(result.snapshot.confirmation.confirmationSeq).toBe(2);
  expect(result.snapshot.confirmation.context).toEqual(result.rejected.sourceCausalBase.parent);
  expect(result.next.status).toBe("prepared");
});

test("abandoned request survives reload without becoming confirmation or unlocking rejection", async ({ page }) => {
  const data = await page.evaluate(async () => {
    const attempt = await h.sent(); const ticket = await h.begin(); await h.reject(attempt);
    return { args: h.args, ticket };
  });
  await page.reload();
  const result = await page.evaluate(async ({ args }) => {
    window.LingoFlowSupabaseAuth = { getState: () => ({ status: "authenticated", user: { id: args[0] } }) };
    const repo = window.LingoFlowSyncStateRepository;
    const db = await repo.openDatabase();
    const clock = await new Promise(resolve => {
      const tx = db.transaction("control");
      const get = tx.objectStore("control").get(`article-context-evidence:${JSON.stringify(args)}`);
      get.onsuccess = () => resolve(get.result);
    });
    return { clock, sidecar: (await repo.getArticleSidecar(...args)).sidecar,
      next: await window.LingoFlowProgressLocalDesired.prepareCloudAttempt(...args) };
  }, data);
  expect(result.clock.confirmationSeq).toBe(0);
  expect(result.clock.requests).toEqual([data.ticket]);
  expect(result.sidecar.serverContextConfirmation).toBeUndefined();
  expect(result.next.reason).toBe("parent-refresh-required");
});

test("snapshot fetch observes an already committed request ticket; no additional request", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const snapshot = await h.snapshot(); const clocks = [];
    const service = window.LingoFlowArticleSyncCloudService.create({
      projectUrl: "https://example.supabase.co", publishableKey: "test-publishable",
      captureSnapshotGuard: () => () => true,
      auth: { getSessionContext: async () => ({ status: "ready", user: { id: h.owner.ownerId } }),
        getAccessToken: async () => "test-token" },
      fetchImpl: async () => {
        const db = await h.repo.openDatabase();
        clocks.push(await new Promise(resolve => {
          const tx = db.transaction("control"); const get = tx.objectStore("control").get(h.clockKey);
          get.onsuccess = () => resolve(get.result);
        }));
        return { ok: true, status: 200, json: async () => ({ ...snapshot,
          readingEpoch: h.epoch, contentFingerprint: h.fp }) };
      }
    });
    await service.snapshot(h.owner, h.article.id);
    return { clocks, sidecar: await h.sidecar() };
  });
  expect(result.clocks).toHaveLength(1);
  expect(result.clocks[0].requests).toHaveLength(1);
  expect(result.clocks[0].confirmationSeq).toBe(0);
  expect(result.sidecar.serverContextConfirmation.observationId).toBe(result.clocks[0].requests[0].observationId);
});

// Queue actual cross-tab transactions behind one held sidecar transaction.
// Both operations are outstanding together. An earlier queued confirmation
// write also blocks rejection's preliminary read, so that case releases after
// the read is queued; the other cases overlap both writes. No Web Locks.
for (const ordering of ["confirmation-first", "new-request-after-rejection", "old-request-late-response"]) {
  test(`cross-tab overlapping transactions preserve event order: ${ordering}`, async ({ page }) => {
    const data = await page.evaluate(async ordering => ({ args: h.args, attempt: await h.sent(),
      snapshot: await h.snapshot(), ticket: ordering === "new-request-after-rejection" ? null : await h.begin() }), ordering);
    const second = await page.context().newPage();
    await second.route("https://**/*", route => route.abort());
    await second.goto("/");
    await second.evaluate(ownerId => {
      window.LingoFlowSupabaseAuth = { getState: () => ({ status: "authenticated", user: { id: ownerId } }) };
    }, data.args[0]);
    await page.evaluate(async args => {
      const db = await h.repo.openDatabase();
      const tx = db.transaction("articleSidecars", "readwrite");
      window.reviewRelease = false;
      const pump = () => {
        const request = tx.objectStore("articleSidecars").get([args[0], args[2]]);
        request.onsuccess = () => { window.reviewLockActive = true; if (!window.reviewRelease) pump(); };
      };
      pump();
    }, data.args);
    await page.waitForFunction(() => window.reviewLockActive);
    for (const tab of [page, second]) await tab.evaluate(() => {
      const original = IDBDatabase.prototype.transaction;
      window.reviewTransaction = original;
      IDBDatabase.prototype.transaction = function(stores, mode, ...options) {
        const tx = original.call(this, stores, mode, ...options);
        if (mode === "readwrite" && Array.from(tx.objectStoreNames).includes("control") &&
            Array.from(tx.objectStoreNames).includes("articleSidecars")) window.reviewQueued = true;
        if (mode === "readonly" && Array.from(tx.objectStoreNames).includes("control") &&
            Array.from(tx.objectStoreNames).includes("progressCloudAttempts")) window.reviewPreflightQueued = true;
        return tx;
      };
    });
    const confirmationFirst = ordering === "confirmation-first";
    const queueRejection = async () => {
      await second.evaluate(data => {
        window.reviewOperation = window.LingoFlowSyncStateRepository.settleProgressCloudResult(
          ...data.args, data.attempt.attemptId, { status: "rejected", reason: "parent-not-ready",
            mutationId: data.attempt.cloudMutationId, articleId: data.args[2] });
      }, data);
      await second.waitForFunction(confirmationFirst
        ? () => window.reviewPreflightQueued : () => window.reviewQueued);
    };
    const queueSnapshot = async () => {
      await page.evaluate(data => {
        const repo = h.repo;
        window.reviewOperation = data.ticket
          ? repo.recordArticleServerContextConfirmation(data.ticket, data.snapshot)
          : repo.beginArticleServerContextObservation(...data.args).then(started =>
            repo.recordArticleServerContextConfirmation(started.ticket, data.snapshot));
      }, data);
      await page.waitForFunction(() => window.reviewQueued);
    };
    if (confirmationFirst) { await queueSnapshot(); await queueRejection(); }
    else { await queueRejection(); await queueSnapshot(); }
    await page.evaluate(() => { window.reviewRelease = true; });
    const [confirmation, rejection] = await Promise.all([page, second].map(tab => tab.evaluate(() => window.reviewOperation)));
    const result = await page.evaluate(async data => ({
      terminal: (await h.repo.getProgressCloudAttempt(...h.args, data.attempt.attemptId)).attempt,
      sidecar: await h.sidecar(), next: await h.flow.prepareCloudAttempt(...h.args)
    }), data);
    for (const tab of [page, second]) await tab.evaluate(() => { IDBDatabase.prototype.transaction = window.reviewTransaction; });
    await second.close();
    expect(confirmation.status).toBe("confirmed");
    expect(rejection.status).toBe("terminal");
    const proof = result.sidecar.serverContextConfirmation;
    const baseline = result.terminal.settlement.parentRejection;
    if (ordering === "new-request-after-rejection") {
      expect(proof.requestEventOrdinal).toBeGreaterThan(baseline.rejectionEventOrdinal);
      expect(result.next.status).toBe("prepared");
    } else {
      expect(proof.requestEventOrdinal).toBeLessThan(baseline.rejectionEventOrdinal);
      expect(result.next.reason).toBe("parent-refresh-required");
    }
    expect(baseline.confirmationSeqAtRejection).toBe(confirmationFirst ? 1
      : ordering === "old-request-late-response" ? 0 : null);
  });
}

test("historical unchanged receipt matching an existing current proof cannot refresh it", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await h.confirm(await h.begin()); const before = (await h.sidecar()).serverContextConfirmation;
    const mutationId = `historical-receipt:${crypto.randomUUID()}`;
    const projection = (await h.snapshot()).projection;
    await h.repo.prepareArticleMutation({ ...h.owner, articleId: h.article.id, mutationId, operation: "put",
      candidate: projection, candidateFingerprint: "a".repeat(64), beforeFingerprint: "a".repeat(64), baseRevision: "revision:1" });
    await h.repo.updateArticleMutationStatus(h.owner.ownerId, h.owner.bindingId, mutationId, "ready");
    const settled = await h.repo.settleArticleMutationSuccess(h.owner.ownerId, h.owner.bindingId, mutationId,
      { status: "unchanged", mutationId, articleId: h.article.id, operation: "put", revision: "revision:1",
        cursor: "cursor:1", serverReadingContext: h.context });
    return { settled, before, after: (await h.sidecar()).serverContextConfirmation };
  });
  expect(result.settled.status).toBe("settled");
  expect(result.after).toEqual(result.before);
});

test("generation change while reading recovery prevents original request escaping the wrapper", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const attempt = await h.sent();
    await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId, { ...h.success(attempt), articleId: "other" });
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function(stores, mode, ...options) {
      const tx = original.call(this, stores, mode, ...options);
      if (mode === "readonly" && Array.from(tx.objectStoreNames).includes("progressCloudAttempts") &&
          Array.from(tx.objectStoreNames).includes("progressRemoteObservations")) {
        tx.addEventListener("complete", () => { void h.flow.prepareAccountSwitch(); });
      }
      return tx;
    };
    const recovered = await h.flow.prepareReceiptRecovery(...h.args, attempt.attemptId);
    IDBDatabase.prototype.transaction = original;
    return { recovered, stored: await h.repo.getProgressCloudAttempt(...h.args, attempt.attemptId) };
  });
  expect(result.recovered).toEqual({ status: "blocked", reason: "scope-mismatch" });
  expect(result.stored.attempt.status).toBe("settlement_attention");
});
