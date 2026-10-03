const { test, expect } = require("@playwright/test");
const { installHarness, trapProgressNetwork } = require("./progress-transport-helpers");

test.beforeEach(async ({ page }) => {
  await trapProgressNetwork(page);
  await page.goto("/");
  await installHarness(page);
});
test.afterEach(async ({ page }) => expect(page.__realProgress, "Zero real Progress endpoint calls").toEqual([]));

test("loading/creating is lazy; default identity API has no HTTP implementation or automatic callers", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const attempt = await h.sent();
    const created = h.flow.createCloudDispatcher();
    for (const type of ["online", "focus", "visibilitychange", "pagehide"]) window.dispatchEvent(new Event(type));
    const before = await h.snapshot();
    const result = await h.flow.dispatchProgressCloudAttempt(...h.args, attempt.attemptId);
    return { result, auth: h.authState.calls, calls: h.calls, before, after: await h.snapshot(), type: typeof created };
  });
  expect(result.result.reason).toBe("transport-not-configured");
  expect(result.auth).toBe(0);
  expect(result.calls).toEqual([]);
  expect(result.after).toEqual(result.before);
  expect(result.type).toBe("function");
});

for (const progress of [0, 1, 0.3]) {
  test(`fixed wire ${progress}: clone/JSON/reversed keys/repeated dispatch/2 reloads remain byte-identical`, async ({ page }) => {
    const initial = await page.evaluate(async progress => {
      const attempt = await h.sent(progress);
      const permission = await h.repo.prepareProgressCloudDispatch(...h.args, attempt.attemptId);
      await h.alter(attempt, value => {
        value.request = Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(structuredClone(value.request)))).reverse());
      });
      const dispatch = h.dispatcher(() => h.response(null, 503));
      await dispatch(...h.args, attempt.attemptId);
      await dispatch(...h.args, attempt.attemptId);
      return { attempt, fixture: { owner: h.owner, articleId: h.article.id }, calls: h.calls,
        frozen: Object.isFrozen(permission.immutableRequest) && Object.isFrozen(permission) };
    }, progress);
    const bodies = initial.calls.map(item => item.body);
    for (let reload = 0; reload < 2; reload++) {
      await page.reload();
      await installHarness(page, initial.fixture);
      bodies.push(await page.evaluate(async attemptId => {
        await h.dispatcher(() => h.response(null, 503))(...h.args, attemptId);
        return h.calls[0].body;
      }, initial.attempt.attemptId));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(initial.frozen).toBe(true);
    const envelope = JSON.parse(bodies[0]);
    expect(Object.keys(envelope)).toEqual(["p_expected_owner_id", "p_mutation"]);
    expect(Object.keys(envelope.p_mutation)).toEqual(["mutationId", "articleId", "expectedState",
      "expectedProgressRevision", "parentReadingEpoch", "contentFingerprint", "progress", "paragraphIndex"]);
    expect(envelope.p_mutation).toEqual(initial.attempt.request);
    expect(envelope.p_expected_owner_id).toBe(initial.fixture.owner.ownerId);
    expect(envelope.p_mutation.progress).toBe(progress);
    expect(initial.calls.every(call => call.method === "POST" && call.url.endsWith("/rpc/lingoflow_progress_sync_push"))).toBe(true);
  });
}

for (const bad of ["null-paragraph", "int32-overflow", "absent", "extra-field", "coerced-progress", "revision-overflow", "bad-provenance"]) {
  test(`malformed/CREATE request ${bad} never sends or fills defaults`, async ({ page }) => {
    const result = await page.evaluate(async bad => {
      const attempt = await h.sent();
      await h.alter(attempt, value => {
        if (bad === "null-paragraph") value.request.paragraphIndex = null;
        if (bad === "int32-overflow") value.request.paragraphIndex = 2147483648;
        if (bad === "absent") value.request.expectedState = "absent";
        if (bad === "extra-field") value.request.wireMutation = {};
        if (bad === "coerced-progress") value.request.progress = "0.3";
        if (bad === "revision-overflow") {
          value.request.expectedProgressRevision = "revision:9223372036854775808";
          value.sourceCausalBase.revision = value.request.expectedProgressRevision;
        }
        if (bad === "bad-provenance") value.sourceFence.action.actionId = crypto.randomUUID();
      });
      const before = await h.snapshot();
      const result = await h.dispatcher(() => { throw new Error("must not send"); })(...h.args, attempt.attemptId);
      return { result, calls: h.calls, before, after: await h.snapshot() };
    }, bad);
    expect(result.calls).toEqual([]);
    expect(result.result.status).not.toBe("received");
    expect(result.after).toEqual(result.before);
  });
}

test("int32 maximum is serialized exactly", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const attempt = await h.sent(0.3, 2147483647);
    await h.dispatcher(() => h.response(null, 500))(...h.args, attempt.attemptId);
    return JSON.parse(h.calls[0].body).p_mutation.paragraphIndex;
  });
  expect(result).toBe(2147483647);
});

for (const status of ["awaiting_postflight", "prepared", "blocked_before_dispatch", "superseded", "terminal", "succeeded"]) {
  test(`${status} cannot dispatch; only reserve creates may_have_sent`, async ({ page }) => {
    const result = await page.evaluate(async status => {
      const attempt = await h.sent();
      if (status === "succeeded") await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId, h.success(attempt));
      else if (status === "terminal") await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId,
        { status: "conflict", reason: "revision-mismatch", mutationId: attempt.cloudMutationId,
          articleId: attempt.articleId, currentRevision: "revision:12", currentCursor: "cursor:12" });
      else await h.alter(attempt, value => { value.status = status;
        value.reason = ["blocked_before_dispatch", "superseded"].includes(status) ? "test-block" : null; });
      const before = await h.snapshot();
      const result = await h.dispatcher(() => { throw new Error("must not send"); })(...h.args, attempt.attemptId);
      return { result, calls: h.calls, before, after: await h.snapshot() };
    }, status);
    expect(result.calls).toEqual([]);
    expect(result.after).toEqual(result.before);
    expect(result.result.status).not.toBe("succeeded");
  });
}

for (const reason of ["mutation-id-reuse", "same-id-wrong-payload", "owner-context-mismatch", "canonical-contradiction", "local-authority-contradiction", "legacy-attention"]) {
  test(`${reason} attention is not retry permission`, async ({ page }) => {
    const result = await page.evaluate(async reason => {
      const attempt = await h.sent();
      if (reason === "canonical-contradiction") {
        await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId, h.success(attempt));
        await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId,
          { ...h.success(attempt), revision: "revision:12", cursor: "cursor:12" });
      } else {
        await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId,
          reason === "mutation-id-reuse" ? { status: "rejected", reason, mutationId: attempt.cloudMutationId, articleId: attempt.articleId }
            : reason === "owner-context-mismatch" ? { status: "rejected", reason }
              : reason === "same-id-wrong-payload" ? { ...h.success(attempt), progress: 0.8 }
                : { ...h.success(attempt), mutationId: crypto.randomUUID() });
        if (reason === "legacy-attention") await h.alter(attempt, value => { delete value.settlement.facts; });
        if (reason === "local-authority-contradiction") await h.raw("progressRemoteObservations", tx => {
          tx.objectStore("progressRemoteObservations").put({ ...h.owner, articleId: h.article.id, kind: "invalid" });
        });
      }
      const before = await h.snapshot();
      const result = await h.dispatcher(() => { throw new Error("must not send"); })(...h.args, attempt.attemptId);
      return { result, calls: h.calls, before, after: await h.snapshot() };
    }, reason);
    expect(result.calls).toEqual([]);
    expect(result.after).toEqual(result.before);
  });
}

for (const flaw of ["wrong-owner", "wrong-binding", "missing-attempt", "scope-occupied", "workspace-transition"]) {
  test(`${flaw} gate refuses before auth/network`, async ({ page }) => {
    const result = await page.evaluate(async flaw => {
      const attempt = await h.sent();
      const args = [...h.args, attempt.attemptId];
      if (flaw === "wrong-owner") args[0] = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      if (flaw === "wrong-binding") args[1] = "other-binding";
      if (flaw === "missing-attempt") args[3] = crypto.randomUUID();
      if (flaw === "scope-occupied") await h.raw("progressCloudAttempts", tx => {
        const duplicate = structuredClone(attempt); duplicate.status = "may_have_sent";
        duplicate.attemptId = crypto.randomUUID(); duplicate.cloudMutationId = crypto.randomUUID();
        duplicate.request.mutationId = duplicate.cloudMutationId;
        tx.objectStore("progressCloudAttempts").put(duplicate);
      });
      if (flaw === "workspace-transition") window.LingoFlowArticleLibrary = { ...h.lib, getWorkspaceTransition: async () => ({ status: "prepared" }) };
      const before = await h.snapshot();
      const result = await h.dispatcher(() => { throw new Error("must not send"); })(...args);
      return { result, calls: h.calls, auth: h.authState.calls, before, after: await h.snapshot() };
    }, flaw);
    expect(result.calls).toEqual([]);
    expect(result.auth).toBe(0);
    expect(result.after).toEqual(result.before);
  });
}

for (const failure of ["fetch-reject", "500", "503", "429", "400", "401", "403", "malformed-json", "unknown-status", "auth-rejection"]) {
  test(`${failure}: one HTTP only and zero durable settlement`, async ({ page }) => {
    const result = await page.evaluate(async failure => {
      const attempt = await h.sent();
      const before = await h.snapshot();
      const result = await h.dispatcher(() => {
        if (failure === "fetch-reject") throw new Error("mock network");
        if (failure === "malformed-json") return { status: 200, json: async () => { throw new Error("mock JSON"); } };
        if (failure === "unknown-status") return h.response({ status: "unknown" });
        if (failure === "auth-rejection") return h.response({ status: "rejected", reason: "authentication-required" });
        return h.response(null, Number(failure));
      })(...h.args, attempt.attemptId);
      return { result, before, after: await h.snapshot(), calls: h.calls.length };
    }, failure);
    expect(result.calls).toBe(1);
    expect(result.after).toEqual(result.before);
    expect(result.result.status).toBe(["401", "403", "auth-rejection"].includes(failure) ? "auth-paused" : "unknown");
  });
}

for (const phase of ["auth", "fetch", "body"]) {
  test(`deadline during ${phase}: late continuation cannot fetch/settle`, async ({ page }) => {
    const result = await page.evaluate(async phase => {
      const attempt = await h.sent();
      const before = await h.snapshot();
      let release;
      const stalled = new Promise(resolve => { release = resolve; });
      if (phase === "auth") h.authState.verifiedHook = () => stalled;
      let aborted = false;
      const result = await h.dispatcher(async init => {
        init.signal.addEventListener("abort", () => { aborted = true; });
        if (phase === "fetch") await stalled;
        return { status: 200, json: async () => { if (phase === "body") await stalled; return h.success(attempt); } };
      }, 150)(...h.args, attempt.attemptId);
      release();
      await new Promise(resolve => setTimeout(resolve, 50));
      return { result, before, after: await h.snapshot(), calls: h.calls.length, aborted };
    }, phase);
    expect(result.result).toEqual({ status: "unknown", reason: "deadline-exceeded" });
    expect(result.calls).toBe(phase === "auth" ? 0 : 1);
    if (phase !== "auth") expect(result.aborted).toBe(true);
    expect(result.after).toEqual(result.before);
  });
}

for (const status of ["applied", "unchanged"]) {
  test(`${status} delegates ordinary settlement; no Article side effects`, async ({ page }) => {
    const result = await page.evaluate(async status => {
      // An unchanged server response keeps its revision only when the server's
      // existing checkpoint already matches the request. Do not fabricate a
      // same-revision/different-checkpoint observation contradiction.
      if (status === "unchanged") await h.raw("progressRemoteObservations", tx => {
        const store = tx.objectStore("progressRemoteObservations"); const get = store.get(h.args);
        get.onsuccess = () => store.put({ ...get.result, checkpoint: { progress: 0.3, paragraphIndex: 3 } });
      });
      const attempt = await h.sent();
      const before = await h.snapshot();
      const result = await h.dispatcher(() => h.response(h.success(attempt, status)))(...h.args, attempt.attemptId);
      const after = await h.snapshot();
      return { result, before, after, observation: await h.repo.getProgressRemoteObservation(...h.args),
        coverage: await h.flow.evaluateLatestLocalCloudCoverage(...h.args), calls: h.calls.length };
    }, status);
    expect(result.result.status).toBe("succeeded");
    expect(result.result.resultStatus).toBe(status);
    expect(result.observation.observation.revision).toBe(status === "applied" ? "revision:11" : "revision:10");
    expect(result.calls).toBe(1);
    expect(result.after.article).toEqual(result.before.article);
    expect(result.after.records.articleOutbox).toEqual(result.before.records.articleOutbox);
    expect(result.after.records.articleSidecars).toEqual(result.before.records.articleSidecars);
    expect(result.after.records.progressDesired[0].confirmed).toBeNull();
    expect(result.coverage.status).toBe("covered");
  });
}

for (const reason of ["revision-mismatch", "parent-not-ready", "parent-epoch-mismatch", "fingerprint-mismatch", "article-deleted", "mutation-id-reuse"]) {
  test(`valid ${reason} uses existing reason-specific settlement only`, async ({ page }) => {
    const result = await page.evaluate(async reason => {
      const attempt = await h.sent();
      const before = await h.snapshot();
      const raw = reason === "revision-mismatch" ? { status: "conflict", reason, mutationId: attempt.cloudMutationId,
        articleId: attempt.articleId, currentRevision: "revision:12", currentCursor: "cursor:12" }
        : { status: "rejected", reason, mutationId: attempt.cloudMutationId, articleId: attempt.articleId };
      const result = await h.dispatcher(() => h.response(raw))(...h.args, attempt.attemptId);
      return { result, before, after: await h.snapshot(), calls: h.calls.length };
    }, reason);
    expect(result.result.status).toBe(reason === "mutation-id-reuse" ? "settlement_attention" : "terminal");
    expect(result.result.reason).toBe(reason);
    expect(result.calls).toBe(1);
    expect(result.after.records.progressRemoteObservations).toEqual(result.before.records.progressRemoteObservations);
    expect(result.after.records.progressDesired).toEqual(result.before.records.progressDesired);
    expect(result.after.article).toEqual(result.before.article);
    expect(result.after.records.articleOutbox).toEqual(result.before.records.articleOutbox);
    expect(result.after.records.articleSidecars).toEqual(result.before.records.articleSidecars);
    if (["parent-not-ready", "parent-epoch-mismatch", "fingerprint-mismatch", "article-deleted"].includes(reason)) {
      expect(result.after.records.progressCloudAttempts[0].settlement.parentRejection.rejectionEventOrdinal).toBeGreaterThan(0);
    }
  });
}

test("attention recovery same ID/body, no state rewind; newer confirmed/pending/localSeq survive", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const attempt = await h.sent();
    const first = h.dispatcher(() => h.response({ ...h.success(attempt), articleId: "wrong-response-id" }));
    const uncertain = await first(...h.args, attempt.attemptId);
    await h.movement(0.7);
    const context = await h.lib.getProgressContext(h.article.id, h.owner);
    await h.repo.prepareProgressMovement({ ...h.owner, articleId: h.article.id,
      target: h.resume.createCheckpoint({ progress: 0.8, paragraphIndex: 8 }, h.fp),
      beforeResume: context.article.reading.resume, articleFence: context.fence, scope: context.scope });
    const before = await h.repo.getProgressDesired(...h.args);
    const retry = h.dispatcher(async () => {
      const stored = await h.repo.getProgressCloudAttempt(...h.args, attempt.attemptId);
      if (stored.attempt.status !== "settlement_attention") throw new Error("attention was rewound");
      return h.response(h.success(attempt));
    });
    const recovered = await retry(...h.args, attempt.attemptId);
    return { uncertain, recovered, before, after: await h.repo.getProgressDesired(...h.args), calls: h.calls,
      attempts: await h.repo.listProgressCloudAttempts(...h.args) };
  });
  expect(result.uncertain.status).toBe("settlement_attention");
  expect(result.recovered.status).toBe("succeeded");
  expect(result.recovered.localCoverageAtSettlement).toBe("advanced");
  expect(result.after).toEqual(result.before);
  expect(result.calls[1].body).toBe(result.calls[0].body);
  expect(result.attempts.attempts).toHaveLength(1);
});

for (const phase of ["auth", "pre-fetch", "fetch", "body"]) {
  test(`owner switch at ${phase} drops stale context without durable mutation`, async ({ page }) => {
    const result = await page.evaluate(async phase => {
      const attempt = await h.sent();
      const before = await h.snapshot();
      const switchOwner = async () => {
        await h.flow.prepareAccountSwitch();
        h.authEvent("authenticated", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
      };
      if (phase === "auth") h.authState.verifiedHook = switchOwner;
      if (phase === "pre-fetch") h.authState.sessionHook = switchOwner;
      const result = await h.dispatcher(async () => {
        if (phase === "fetch") await switchOwner();
        return { status: 200, json: async () => { if (phase === "body") await switchOwner(); return h.success(attempt); } };
      })(...h.args, attempt.attemptId);
      return { result, before, after: await h.snapshot(), calls: h.calls.length };
    }, phase);
    expect(result.calls).toBe(["auth", "pre-fetch"].includes(phase) ? 0 : 1);
    expect(result.result.status).toBe("not-ready");
    expect(result.after).toEqual(result.before);
  });
}

for (const boundary of ["logout-relogin", "token-refresh", "session-loss", "same-owner-new-binding"]) {
  test(`${boundary} prevents old response settlement even if owner returns`, async ({ page }) => {
    const result = await page.evaluate(async boundary => {
      const attempt = await h.sent();
      const before = await h.snapshot();
      const result = await h.dispatcher(async () => {
        if (boundary === "logout-relogin") { h.authEvent("signed-out"); h.authEvent("authenticated", h.owner.ownerId); }
        if (boundary === "token-refresh") { h.authEvent("authenticating"); h.authEvent("authenticated"); }
        if (boundary === "session-loss") h.authEvent("signed-out");
        if (boundary === "same-owner-new-binding") await h.raw("control", tx => {
          const store = tx.objectStore("control"); const get = store.get("workspace-binding");
          get.onsuccess = () => store.put({ ...get.result, bindingId: "new-binding" });
        });
        return h.response(h.success(attempt));
      })(...h.args, attempt.attemptId);
      const after = await h.snapshot();
      let newBindingRetry;
      if (boundary === "same-owner-new-binding") newBindingRetry = await h.dispatcher(() => { throw new Error("must not send"); })(
        h.owner.ownerId, "new-binding", h.article.id, attempt.attemptId);
      return { result, before, after, newBindingRetry, calls: h.calls.length };
    }, boundary);
    expect(result.result.status).toBe("not-ready");
    expect(result.calls).toBe(1);
    expect(result.after.records.progressCloudAttempts).toEqual(result.before.records.progressCloudAttempts);
    expect(result.after.records.progressRemoteObservations).toEqual(result.before.records.progressRemoteObservations);
    expect(result.after.records.progressDesired).toEqual(result.before.records.progressDesired);
    expect(result.after.article).toEqual(result.before.article);
  });
}

test("paired session token owner mismatch never reaches HTTP", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const attempt = await h.sent();
    const original = window.LingoFlowSupabaseAuth;
    window.LingoFlowSupabaseAuth = { ...original, getPublicClient: async () => ({ auth: { getSession: async () => ({
      data: { session: { user: { id: "different-owner" }, access_token: "mock-only" } }
    }) } }) };
    return { result: await h.dispatcher(() => { throw new Error("must not send"); })(...h.args, attempt.attemptId), calls: h.calls };
  });
  expect(result.result.status).toBe("auth-paused");
  expect(result.calls).toEqual([]);
});

test("newer confirmed position survives success; localSeq continues on subsequent movement", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const attempt = await h.sent();
    let before;
    const result = await h.dispatcher(async () => {
      await h.movement(0.8);
      before = await h.repo.getProgressDesired(...h.args);
      return h.response(h.success(attempt));
    })(...h.args, attempt.attemptId);
    const after = await h.repo.getProgressDesired(...h.args);
    await h.movement(0.4);
    const next = await h.repo.getProgressDesired(...h.args);
    return { result, before, after, next };
  });
  expect(result.result.status).toBe("succeeded");
  expect(result.result.localCoverageAtSettlement).toBe("advanced");
  expect(result.after).toEqual(result.before);
  expect(result.next.record.localSeq).toBe(result.after.record.localSeq + 1);
  expect(result.next.record.confirmed.checkpoint.progress).toBe(0.4);
});

test("final read-only dispatch gate changing generation has no unguarded await to HTTP", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const attempt = await h.sent();
    const original = window.LingoFlowSyncStateRepository;
    let checks = 0;
    window.LingoFlowSyncStateRepository = { ...original, prepareProgressCloudDispatch: async (...args) => {
      const result = await original.prepareProgressCloudDispatch(...args);
      if (++checks === 2) h.authEvent("authenticated");
      return result;
    } };
    const before = await h.snapshot();
    const result = await h.dispatcher(() => { throw new Error("must not send"); })(...h.args, attempt.attemptId);
    return { result, checks, calls: h.calls, before, after: await h.snapshot() };
  });
  expect(result.checks).toBe(2);
  expect(result.calls).toEqual([]);
  expect(result.result.status).toBe("not-ready");
  expect(result.after).toEqual(result.before);
});

test("actual A→B binding replacement during HTTP keeps A unresolved and cannot touch B scope", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const attempt = await h.sent();
    const other = { ownerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", bindingId: "binding-b" };
    let afterSwitch;
    const result = await h.dispatcher(async () => {
      await h.flow.prepareAccountSwitch();
      const replacement = await h.repo.replaceWorkspaceBinding({ from: h.owner, to: other, accountLabel: "mock@example.invalid" });
      if (replacement.status !== "replaced") throw new Error("fixture switch failed");
      h.authEvent("authenticated", other.ownerId);
      afterSwitch = await h.snapshot();
      return h.response(h.success(attempt));
    })(...h.args, attempt.attemptId);
    return { result, afterSwitch, after: await h.snapshot(),
      retry: await h.dispatcher(() => { throw new Error("must not send"); })(other.ownerId, other.bindingId, h.article.id, attempt.attemptId) };
  });
  expect(result.result.status).toBe("not-ready");
  expect(result.after).toEqual(result.afterSwitch);
  expect(result.after.records.progressCloudAttempts[0].status).toBe("may_have_sent");
  expect(result.after.records.progressCloudAttempts[0].bindingId).toBe("transport-binding");
  expect(result.retry.status).not.toBe("succeeded");
});

test("guard change in settlement's asynchronous Library precheck cannot start writes", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const attempt = await h.sent();
    const original = window.LingoFlowArticleLibrary;
    let changed = false;
    window.LingoFlowArticleLibrary = { ...original, getProgressContext: async (...args) => {
      const context = await original.getProgressContext(...args);
      if (!changed) { changed = true; h.authEvent("authenticated"); }
      return context;
    } };
    const before = await h.snapshot();
    const result = await h.dispatcher(() => h.response(h.success(attempt)))(...h.args, attempt.attemptId);
    return { result, changed, before, after: await h.snapshot() };
  });
  expect(result.changed).toBe(true);
  expect(result.result.status).toBe("not-ready");
  expect(result.after).toEqual(result.before);
});

for (const invalidation of ["generation", "last-write-generation", "deadline"]) {
  test(`settlement queued-write ${invalidation} change aborts entire transaction`, async ({ page }) => {
    const result = await page.evaluate(async invalidation => {
      const attempt = await h.sent();
      const before = await h.snapshot();
      const put = IDBObjectStore.prototype.put;
      let hit = false;
      IDBObjectStore.prototype.put = function(...args) {
        const request = put.apply(this, args);
        if (this.name === (invalidation === "last-write-generation" ? "progressCloudAttempts" : "progressRemoteObservations") && !hit) {
          hit = true;
          if (invalidation !== "deadline") h.authEvent("authenticated");
          else {
            const start = performance.now(); while (performance.now() - start < 200) { /* simulate queued write passing deadline */ }
          }
        }
        return request;
      };
      let result;
      try { result = await h.dispatcher(() => h.response(h.success(attempt)), invalidation === "deadline" ? 150 : 10000)(...h.args, attempt.attemptId); }
      finally { IDBObjectStore.prototype.put = put; }
      await new Promise(resolve => setTimeout(resolve, 30));
      return { result, hit, before, after: await h.snapshot() };
    }, invalidation);
    expect(result.hit).toBe(true);
    expect(result.result.status).toBe(invalidation === "deadline" ? "unknown" : "not-ready");
    expect(result.after).toEqual(result.before);
  });
}

for (const attention of [false, true]) {
  test(`two real tabs duplicate ${attention ? "recoverable attention" : "may_have_sent"}: same wire + idempotent settlement, no Web Locks`, async ({ page, context }) => {
    const setup = await page.evaluate(async attention => {
      const attempt = await h.sent();
      if (attention) await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId,
        { ...h.success(attempt), mutationId: crypto.randomUUID() });
      return { attempt, fixture: { owner: h.owner, articleId: h.article.id } };
    }, attention);
    const other = await context.newPage();
    await trapProgressNetwork(other); await other.goto("/"); await installHarness(other, setup.fixture);
    let arrivals = 0;
    const waiting = [];
    await context.exposeBinding("mockTransportBarrier", () => new Promise(resolve => {
      waiting.push(resolve);
      if (++arrivals === 2) for (const release of waiting) release();
    }));
    const run = target => target.evaluate(async attempt => {
      Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
      const result = await h.dispatcher(async () => {
        await window.mockTransportBarrier(); return h.response(h.success(attempt));
      })(...h.args, attempt.attemptId);
      return { result, calls: h.calls, attempts: await h.repo.listProgressCloudAttempts(...h.args) };
    }, setup.attempt);
    const results = await Promise.all([run(page), run(other)]);
    expect(results.map(item => item.calls.length)).toEqual([1, 1]);
    expect(results[0].calls[0].body).toBe(results[1].calls[0].body);
    expect(results.every(item => item.result.status === "succeeded")).toBe(true);
    expect(results.some(item => item.result.idempotent)).toBe(true);
    expect(results[1].attempts.attempts).toHaveLength(1);
    expect(other.__realProgress).toEqual([]);
    await other.close();
  });
}

test("repository settlement refuses a replaced durable cloudMutationId, not merely matching attemptId", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const attempt = await h.sent();
    await h.alter(attempt, value => {
      value.cloudMutationId = crypto.randomUUID(); value.request.mutationId = value.cloudMutationId;
    });
    const before = await h.snapshot();
    const result = await h.repo.settleProgressCloudResult(...h.args, attempt.attemptId,
      h.success(attempt), () => true, attempt.cloudMutationId);
    return { result, before, after: await h.snapshot() };
  });
  expect(result.result.status).toBe("not-ready");
  expect(result.after).toEqual(result.before);
});
