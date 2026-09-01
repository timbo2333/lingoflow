const { test, expect } = require("@playwright/test");

const projectErrors = new WeakMap();
const OWNER_A = { ownerId: "owner:a" };
const OWNER_B = { ownerId: "owner:b" };

function makeFavorite(id, overrides = {}) {
  return {
    id,
    type: "word",
    text: "resilient",
    createdAt: "2026-09-01T01:00:00.000Z",
    updatedAt: "2026-09-01T02:00:00.000Z",
    deletedAt: null,
    ...overrides
  };
}

function makeMutation(favorite, overrides = {}) {
  return {
    mutationId: `mutation:${favorite.id}`,
    entityType: "favorites",
    entityId: favorite.id,
    scope: "record",
    schemaVersion: "1",
    operation: "put",
    baseRevision: null,
    observedCursor: null,
    payload: favorite,
    ...overrides
  };
}

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
  await page.addScriptTag({ url: "/js/favorite-backup-schema.js" });
  await page.addScriptTag({ url: "/js/cloud-sync-protocol.js" });
  await page.addScriptTag({ url: "/js/fake-sync-service.js" });
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

test("valid Favorite mutation 通过纯协议验证且模块 API 冻结", async ({ page }) => {
  const mutation = makeMutation(makeFavorite("favorite:valid"));
  const result = await page.evaluate(input => {
    const protocol = window.LingoFlowCloudSyncProtocol;
    const validation = protocol.validateMutation(input);
    return {
      validation,
      protocolFrozen: Object.isFrozen(protocol),
      serviceModuleFrozen: Object.isFrozen(window.LingoFlowFakeSyncService),
      api: {
        owner: typeof protocol.validateOwnerContext,
        mutation: typeof protocol.validateMutation,
        result: typeof protocol.validateResult,
        change: typeof protocol.validatePullChange,
        createService: typeof window.LingoFlowFakeSyncService.create
      }
    };
  }, mutation);

  expect(result.validation).toMatchObject({
    status: "valid",
    mutationId: mutation.mutationId,
    entityType: "favorites",
    entityId: mutation.entityId,
    scope: "record",
    errors: []
  });
  expect(result.validation.mutation).toEqual(mutation);
  expect(result.protocolFrozen).toBe(true);
  expect(result.serviceModuleFrozen).toBe(true);
  expect(result.api).toEqual({
    owner: "function",
    mutation: "function",
    result: "function",
    change: "function",
    createService: "function"
  });
});

test("malformed mutation、revision、cursor 和非 JSON-safe 输入被拒绝且 getter 不执行", async ({ page }) => {
  const favorite = makeFavorite("favorite:malformed");
  const mutation = makeMutation(favorite);
  const result = await page.evaluate(input => {
    const protocol = window.LingoFlowCloudSyncProtocol;
    const cycle = structuredClone(input);
    cycle.payload.future = cycle;
    let getterRuns = 0;
    const accessor = structuredClone(input);
    Object.defineProperty(accessor, "payload", {
      enumerable: true,
      get() {
        getterRuns += 1;
        return input.payload;
      }
    });
    return {
      blankMutationId: protocol.validateMutation({ ...input, mutationId: "  " }),
      numericRevision: protocol.validateMutation({ ...input, baseRevision: 3 }),
      blankCursor: protocol.validateMutation({ ...input, observedCursor: " " }),
      unsupportedVersion: protocol.validateMutation({ ...input, schemaVersion: "2" }),
      cycle: protocol.validateMutation(cycle),
      accessor: protocol.validateMutation(accessor),
      getterRuns
    };
  }, mutation);

  expect(result.blankMutationId.errors[0].code).toBe("invalid-mutation-id");
  expect(result.numericRevision.errors[0].code).toBe("invalid-base-revision");
  expect(result.blankCursor.errors[0].code).toBe("invalid-observed-cursor");
  expect(result.unsupportedVersion.errors[0].code).toBe("unsupported-schema-version");
  expect(result.cycle.errors[0].code).toBe("invalid-json-value");
  expect(result.accessor.errors[0].code).toBe("invalid-json-value");
  expect(result.getterRuns).toBe(0);
});

test("unsupported entityType 被明确拒绝", async ({ page }) => {
  const mutation = makeMutation(makeFavorite("favorite:unsupported"), {
    entityType: "articles"
  });
  const result = await page.evaluate(input => (
    window.LingoFlowCloudSyncProtocol.validateMutation(input)
  ), mutation);

  expect(result.status).toBe("rejected");
  expect(result.errors).toContainEqual({
    code: "unsupported-entity",
    path: "entityType"
  });
});

test("Favorite Schema 非法 payload 被协议再次拒绝", async ({ page }) => {
  const favorite = makeFavorite("favorite:invalid-schema", { type: "term" });
  const mutation = makeMutation(favorite);
  const result = await page.evaluate(input => (
    window.LingoFlowCloudSyncProtocol.validateMutation(input)
  ), mutation);

  expect(result.status).toBe("rejected");
  expect(result.errors).toContainEqual(expect.objectContaining({
    code: "invalid-type",
    path: "payload.type"
  }));
});

test("entityId 与 Favorite payload.id 不一致时拒绝", async ({ page }) => {
  const mutation = makeMutation(makeFavorite("favorite:payload-id"), {
    entityId: "favorite:wrapper-id"
  });
  const result = await page.evaluate(input => (
    window.LingoFlowCloudSyncProtocol.validateMutation(input)
  ), mutation);

  expect(result.status).toBe("rejected");
  expect(result.errors).toContainEqual({
    code: "entity-id-mismatch",
    path: "entityId"
  });
});

test("首次 create 返回 applied", async ({ page }) => {
  const mutation = makeMutation(makeFavorite("favorite:create"));
  const result = await page.evaluate(({ owner, input }) => {
    const service = window.LingoFlowFakeSyncService.create();
    return service.push(owner, input);
  }, { owner: OWNER_A, input: mutation });

  expect(result).toMatchObject({
    status: "applied",
    mutationId: mutation.mutationId,
    entityType: "favorites",
    entityId: mutation.entityId,
    scope: "record"
  });
});

test("首次 create 返回 opaque revision string", async ({ page }) => {
  const mutation = makeMutation(makeFavorite("favorite:create-revision"));
  const result = await page.evaluate(({ owner, input }) => {
    const service = window.LingoFlowFakeSyncService.create();
    return service.push(owner, input);
  }, { owner: OWNER_A, input: mutation });

  expect(typeof result.revision).toBe("string");
  expect(result.revision.length).toBeGreaterThan(0);
});

test("首次 create 推进 owner global cursor", async ({ page }) => {
  const mutation = makeMutation(makeFavorite("favorite:create-cursor"));
  const result = await page.evaluate(({ owner, input }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const before = service.pull(owner, null);
    const created = service.push(owner, input);
    const after = service.pull(owner, null);
    return { before, created, after };
  }, { owner: OWNER_A, input: mutation });

  expect(result.before.nextCursor).not.toBe(result.created.cursor);
  expect(result.after.nextCursor).toBe(result.created.cursor);
  expect(result.after.changes).toHaveLength(1);
});

test("基于当前 revision 的 Favorite update applied", async ({ page }) => {
  const favorite = makeFavorite("favorite:update");
  const mutation = makeMutation(favorite);
  const updated = makeFavorite(favorite.id, {
    note: "Device A",
    updatedAt: "2026-09-01T03:00:00.000Z"
  });
  const result = await page.evaluate(({ owner, createInput, updatePayload }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const created = service.push(owner, createInput);
    const updateInput = {
      ...createInput,
      mutationId: "mutation:update:correct",
      baseRevision: created.revision,
      observedCursor: created.cursor,
      payload: updatePayload
    };
    return service.push(owner, updateInput);
  }, { owner: OWNER_A, createInput: mutation, updatePayload: updated });

  expect(result.status).toBe("applied");
});

test("合法 update 产生不同 server revision", async ({ page }) => {
  const favorite = makeFavorite("favorite:update-revision");
  const mutation = makeMutation(favorite);
  const updated = makeFavorite(favorite.id, {
    meaning: "有复原力的",
    updatedAt: "2026-09-01T03:00:00.000Z"
  });
  const result = await page.evaluate(({ owner, createInput, updatePayload }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const created = service.push(owner, createInput);
    const changed = service.push(owner, {
      ...createInput,
      mutationId: "mutation:update:revision",
      baseRevision: created.revision,
      payload: updatePayload
    });
    return { created, changed };
  }, { owner: OWNER_A, createInput: mutation, updatePayload: updated });

  expect(result.changed.status).toBe("applied");
  expect(result.changed.revision).not.toBe(result.created.revision);
});

test("stale revision 上传不同 payload 返回 conflict", async ({ page }) => {
  const favorite = makeFavorite("favorite:stale");
  const mutation = makeMutation(favorite);
  const result = await page.evaluate(({ owner, createInput }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const created = service.push(owner, createInput);
    const deviceA = service.push(owner, {
      ...createInput,
      mutationId: "mutation:device-a",
      baseRevision: created.revision,
      payload: {
        ...createInput.payload,
        note: "Device A note",
        updatedAt: "2026-09-01T03:00:00.000Z"
      }
    });
    const deviceB = service.push(owner, {
      ...createInput,
      mutationId: "mutation:device-b",
      baseRevision: created.revision,
      payload: {
        ...createInput.payload,
        meaning: "Device B meaning",
        updatedAt: "2026-09-01T04:00:00.000Z"
      }
    });
    return { deviceA, deviceB };
  }, { owner: OWNER_A, createInput: mutation });

  expect(result.deviceB).toMatchObject({
    status: "conflict",
    reason: "revision-mismatch",
    currentRevision: result.deviceA.revision
  });
});

test("conflict 保留 server 当前 Favorite 且不写 losing payload", async ({ page }) => {
  const favorite = makeFavorite("favorite:conflict-current");
  const mutation = makeMutation(favorite);
  const result = await page.evaluate(({ owner, createInput }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const created = service.push(owner, createInput);
    const deviceAPayload = {
      ...createInput.payload,
      note: "Device A wins no LWW",
      updatedAt: "2026-09-01T03:00:00.000Z"
    };
    const applied = service.push(owner, {
      ...createInput,
      mutationId: "mutation:conflict:a",
      baseRevision: created.revision,
      payload: deviceAPayload
    });
    const conflict = service.push(owner, {
      ...createInput,
      mutationId: "mutation:conflict:b",
      baseRevision: created.revision,
      payload: {
        ...createInput.payload,
        note: "Device B must not overwrite",
        updatedAt: "2026-09-01T09:00:00.000Z"
      }
    });
    return { applied, conflict, pulled: service.pull(owner, created.cursor) };
  }, { owner: OWNER_A, createInput: mutation });

  expect(result.conflict.currentPayload.note).toBe("Device A wins no LWW");
  expect(result.conflict.currentRevision).toBe(result.applied.revision);
  expect(result.pulled.changes).toHaveLength(1);
  expect(result.pulled.changes[0].payload.note).toBe("Device A wins no LWW");
});

test("exact current Favorite payload 返回 unchanged", async ({ page }) => {
  const mutation = makeMutation(makeFavorite("favorite:unchanged"));
  const result = await page.evaluate(({ owner, input }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const created = service.push(owner, input);
    const unchanged = service.push(owner, {
      ...input,
      mutationId: "mutation:unchanged:second",
      baseRevision: created.revision
    });
    return { created, unchanged };
  }, { owner: OWNER_A, input: mutation });

  expect(result.unchanged.status).toBe("unchanged");
});

test("unchanged 不增加 record revision", async ({ page }) => {
  const mutation = makeMutation(makeFavorite("favorite:unchanged-revision"));
  const result = await page.evaluate(({ owner, input }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const created = service.push(owner, input);
    const unchanged = service.push(owner, {
      ...input,
      mutationId: "mutation:unchanged:revision",
      baseRevision: created.revision
    });
    return { created, unchanged };
  }, { owner: OWNER_A, input: mutation });

  expect(result.unchanged.revision).toBe(result.created.revision);
});

test("unchanged 不增加 cursor 或 change log", async ({ page }) => {
  const mutation = makeMutation(makeFavorite("favorite:unchanged-cursor"));
  const result = await page.evaluate(({ owner, input }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const created = service.push(owner, input);
    const unchanged = service.push(owner, {
      ...input,
      mutationId: "mutation:unchanged:cursor",
      baseRevision: created.revision
    });
    return { created, unchanged, pulled: service.pull(owner, null) };
  }, { owner: OWNER_A, input: mutation });

  expect(result.unchanged.cursor).toBe(result.created.cursor);
  expect(result.pulled.nextCursor).toBe(result.created.cursor);
  expect(result.pulled.changes).toHaveLength(1);
});

test("same mutationId exact retry 返回第一次 applied result", async ({ page }) => {
  const mutation = makeMutation(makeFavorite("favorite:idempotent"));
  const result = await page.evaluate(({ owner, input }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const first = service.push(owner, input);
    first.status = "caller-mutated";
    const retry = service.push(owner, structuredClone(input));
    return { first, retry };
  }, { owner: OWNER_A, input: mutation });

  expect(result.retry.status).toBe("applied");
  expect(result.retry.mutationId).toBe(mutation.mutationId);
});

test("duplicate idempotent retry 不增加 revision", async ({ page }) => {
  const mutation = makeMutation(makeFavorite("favorite:idempotent-revision"));
  const result = await page.evaluate(({ owner, input }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const first = service.push(owner, input);
    const retry = service.push(owner, input);
    return { first, retry };
  }, { owner: OWNER_A, input: mutation });

  expect(result.retry.revision).toBe(result.first.revision);
});

test("duplicate idempotent retry 不增加 cursor 或 change", async ({ page }) => {
  const mutation = makeMutation(makeFavorite("favorite:idempotent-cursor"));
  const result = await page.evaluate(({ owner, input }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const first = service.push(owner, input);
    const retry = service.push(owner, input);
    return { first, retry, pulled: service.pull(owner, null) };
  }, { owner: OWNER_A, input: mutation });

  expect(result.retry.cursor).toBe(result.first.cursor);
  expect(result.pulled.nextCursor).toBe(result.first.cursor);
  expect(result.pulled.changes).toHaveLength(1);
});

test("same mutationId different request rejected 为 idempotency-key-reused", async ({ page }) => {
  const mutation = makeMutation(makeFavorite("favorite:idempotency-reuse"));
  const result = await page.evaluate(({ owner, input }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const first = service.push(owner, input);
    const reused = service.push(owner, {
      ...input,
      baseRevision: first.revision,
      payload: {
        ...input.payload,
        note: "different request",
        updatedAt: "2026-09-01T03:00:00.000Z"
      }
    });
    return { first, reused, pulled: service.pull(owner, null) };
  }, { owner: OWNER_A, input: mutation });

  expect(result.reused).toMatchObject({
    status: "rejected",
    reason: "idempotency-key-reused"
  });
  expect(result.pulled.changes).toHaveLength(1);
});

test("pull from initial cursor 返回 ordered create/update/create changes", async ({ page }) => {
  const favoriteA = makeFavorite("favorite:pull-a");
  const favoriteB = makeFavorite("favorite:pull-b", { text: "durable" });
  const result = await page.evaluate(({ owner, first, second }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const createdA = service.push(owner, first);
    service.push(owner, {
      ...first,
      mutationId: "mutation:pull:a:update",
      baseRevision: createdA.revision,
      payload: {
        ...first.payload,
        note: "updated",
        updatedAt: "2026-09-01T03:00:00.000Z"
      }
    });
    service.push(owner, second);
    return service.pull(owner, null);
  }, {
    owner: OWNER_A,
    first: makeMutation(favoriteA),
    second: makeMutation(favoriteB)
  });

  expect(result.status).toBe("ready");
  expect(result.changes.map(change => [change.entityId, change.payload.note || null]))
    .toEqual([
      [favoriteA.id, null],
      [favoriteA.id, "updated"],
      [favoriteB.id, null]
    ]);
});

test("pull from intermediate cursor 只返回后续 changes", async ({ page }) => {
  const mutationA = makeMutation(makeFavorite("favorite:middle-a"));
  const mutationB = makeMutation(makeFavorite("favorite:middle-b"));
  const result = await page.evaluate(({ owner, first, second }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const createdA = service.push(owner, first);
    service.push(owner, second);
    return { createdA, pulled: service.pull(owner, createdA.cursor) };
  }, { owner: OWNER_A, first: mutationA, second: mutationB });

  expect(result.pulled.changes).toHaveLength(1);
  expect(result.pulled.changes[0].entityId).toBe(mutationB.entityId);
});

test("重复使用同一 cursor 时 pull 结果 deterministic", async ({ page }) => {
  const mutation = makeMutation(makeFavorite("favorite:cursor-replay"));
  const result = await page.evaluate(({ owner, input }) => {
    const service = window.LingoFlowFakeSyncService.create();
    service.push(owner, input);
    const first = service.pull(owner, null);
    first.changes[0].payload.text = "caller mutation";
    const second = service.pull(owner, null);
    return { first, second };
  }, { owner: OWNER_A, input: mutation });

  expect(result.second.changes[0].payload.text).toBe("resilient");
  expect(result.second.nextCursor).toBe(result.first.nextCursor);
});

test("pull change 保存当时 revision 的 immutable payload snapshot", async ({ page }) => {
  const favorite = makeFavorite("favorite:historical-snapshot");
  const mutation = makeMutation(favorite);
  const result = await page.evaluate(({ owner, input }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const created = service.push(owner, input);
    service.push(owner, {
      ...input,
      mutationId: "mutation:historical:update",
      baseRevision: created.revision,
      payload: {
        ...input.payload,
        note: "later version",
        updatedAt: "2026-09-01T03:00:00.000Z"
      }
    });
    return service.pull(owner, null);
  }, { owner: OWNER_A, input: mutation });

  expect(result.changes).toHaveLength(2);
  expect(result.changes[0].payload.note).toBeUndefined();
  expect(result.changes[1].payload.note).toBe("later version");
  expect(result.changes[0].revision).not.toBe(result.changes[1].revision);
});

test("Owner A 与 Owner B 可保存相同 Favorite ID", async ({ page }) => {
  const mutation = makeMutation(makeFavorite("favorite:shared-id"));
  const result = await page.evaluate(({ ownerA, ownerB, input }) => {
    const service = window.LingoFlowFakeSyncService.create();
    return {
      ownerA: service.push(ownerA, input),
      ownerB: service.push(ownerB, {
        ...input,
        mutationId: "mutation:owner-b:same-id",
        payload: { ...input.payload, note: "Owner B" }
      })
    };
  }, { ownerA: OWNER_A, ownerB: OWNER_B, input: mutation });

  expect(result.ownerA.status).toBe("applied");
  expect(result.ownerB.status).toBe("applied");
});

test("Owner A pull 不包含 Owner B changes", async ({ page }) => {
  const mutationA = makeMutation(makeFavorite("favorite:owner-a"));
  const mutationB = makeMutation(makeFavorite("favorite:owner-b"));
  const result = await page.evaluate(({ ownerA, ownerB, first, second }) => {
    const service = window.LingoFlowFakeSyncService.create();
    service.push(ownerA, first);
    service.push(ownerB, second);
    return {
      ownerA: service.pull(ownerA, null),
      ownerB: service.pull(ownerB, null)
    };
  }, {
    ownerA: OWNER_A,
    ownerB: OWNER_B,
    first: mutationA,
    second: mutationB
  });

  expect(result.ownerA.changes.map(change => change.entityId)).toEqual([mutationA.entityId]);
  expect(result.ownerB.changes.map(change => change.entityId)).toEqual([mutationB.entityId]);
});

test("owner 不能由 mutation body 指定或切换", async ({ page }) => {
  const mutation = {
    ...makeMutation(makeFavorite("favorite:owner-injection")),
    ownerId: OWNER_B.ownerId
  };
  const result = await page.evaluate(({ ownerA, ownerB, input }) => {
    const service = window.LingoFlowFakeSyncService.create();
    return {
      pushed: service.push(ownerA, input),
      ownerA: service.pull(ownerA, null),
      ownerB: service.pull(ownerB, null)
    };
  }, { ownerA: OWNER_A, ownerB: OWNER_B, input: mutation });

  expect(result.pushed.status).toBe("rejected");
  expect(result.pushed.reason).toBe("unexpected-field");
  expect(result.ownerA.changes).toEqual([]);
  expect(result.ownerB.changes).toEqual([]);
});

test("active Favorite 基于当前 revision 更新为 tombstone", async ({ page }) => {
  const active = makeFavorite("favorite:tombstone");
  const tombstone = makeFavorite(active.id, {
    updatedAt: "2026-09-01T03:00:00.000Z",
    deletedAt: "2026-09-01T03:00:00.000Z"
  });
  const result = await page.evaluate(({ owner, createInput, tombstonePayload }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const created = service.push(owner, createInput);
    const deleted = service.push(owner, {
      ...createInput,
      mutationId: "mutation:tombstone:put",
      baseRevision: created.revision,
      payload: tombstonePayload
    });
    return { created, deleted };
  }, { owner: OWNER_A, createInput: makeMutation(active), tombstonePayload: tombstone });

  expect(result.deleted.status).toBe("applied");
  expect(result.deleted.revision).not.toBe(result.created.revision);
});

test("tombstone 作为完整 Favorite payload 出现在 pull change", async ({ page }) => {
  const active = makeFavorite("favorite:tombstone-pull");
  const tombstone = makeFavorite(active.id, {
    updatedAt: "2026-09-01T03:00:00.000Z",
    deletedAt: "2026-09-01T03:00:00.000Z"
  });
  const result = await page.evaluate(({ owner, createInput, tombstonePayload }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const created = service.push(owner, createInput);
    service.push(owner, {
      ...createInput,
      mutationId: "mutation:tombstone:pull",
      baseRevision: created.revision,
      payload: tombstonePayload
    });
    return service.pull(owner, created.cursor);
  }, { owner: OWNER_A, createInput: makeMutation(active), tombstonePayload: tombstone });

  expect(result.changes).toHaveLength(1);
  expect(result.changes[0].payload).toEqual(tombstone);
});

test("stale active update 无法复活 server tombstone", async ({ page }) => {
  const active = makeFavorite("favorite:no-resurrection");
  const tombstone = makeFavorite(active.id, {
    updatedAt: "2026-09-01T03:00:00.000Z",
    deletedAt: "2026-09-01T03:00:00.000Z"
  });
  const result = await page.evaluate(({ owner, createInput, tombstonePayload }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const created = service.push(owner, createInput);
    const deleted = service.push(owner, {
      ...createInput,
      mutationId: "mutation:no-resurrection:delete",
      baseRevision: created.revision,
      payload: tombstonePayload
    });
    const stale = service.push(owner, {
      ...createInput,
      mutationId: "mutation:no-resurrection:stale",
      baseRevision: created.revision,
      payload: {
        ...createInput.payload,
        note: "old device active edit",
        updatedAt: "2026-09-01T09:00:00.000Z"
      }
    });
    return { deleted, stale, pulled: service.pull(owner, created.cursor) };
  }, { owner: OWNER_A, createInput: makeMutation(active), tombstonePayload: tombstone });

  expect(result.stale.status).toBe("conflict");
  expect(result.stale.currentRevision).toBe(result.deleted.revision);
  expect(result.stale.currentPayload.deletedAt).toBe(tombstone.deletedAt);
  expect(result.pulled.changes).toHaveLength(1);
  expect(result.pulled.changes[0].payload.deletedAt).toBe(tombstone.deletedAt);
});

test("revision、cursor、owner 与 sync metadata 不进入 Favorite payload", async ({ page }) => {
  const favorite = makeFavorite("favorite:metadata-boundary", {
    futureAsset: { label: "kept" }
  });
  const mutation = makeMutation(favorite);
  const result = await page.evaluate(({ owner, input }) => {
    const protocol = window.LingoFlowCloudSyncProtocol;
    const service = window.LingoFlowFakeSyncService.create();
    const applied = service.push(owner, input);
    const pulled = service.pull(owner, null);
    const invalidPayload = {
      ...input,
      mutationId: "mutation:metadata:invalid",
      entityId: "favorite:metadata-invalid",
      payload: {
        ...input.payload,
        id: "favorite:metadata-invalid",
        cloud: { revision: "must-not-enter" }
      }
    };
    return {
      applied,
      payload: pulled.changes[0].payload,
      invalid: protocol.validateMutation(invalidPayload)
    };
  }, { owner: OWNER_A, input: mutation });

  expect(result.payload).toEqual(favorite);
  expect(result.payload).not.toHaveProperty("revision");
  expect(result.payload).not.toHaveProperty("cursor");
  expect(result.payload).not.toHaveProperty("ownerId");
  expect(result.payload).not.toHaveProperty("syncStatus");
  expect(result.invalid.errors).toContainEqual({
    code: "sync-metadata-in-payload",
    path: "payload.cloud.revision"
  });
});

test("Protocol validation 和 Fake Service 不修改输入对象", async ({ page }) => {
  const mutation = makeMutation(makeFavorite("favorite:no-mutation", {
    tags: ["sync"],
    futureAsset: { flags: [true, false] }
  }));
  const result = await page.evaluate(({ owner, input }) => {
    const before = JSON.stringify(input);
    const validation = window.LingoFlowCloudSyncProtocol.validateMutation(input);
    const service = window.LingoFlowFakeSyncService.create();
    service.push(owner, input);
    validation.mutation.payload.tags.push("caller-only");
    return {
      before,
      after: JSON.stringify(input),
      pulled: service.pull(owner, null)
    };
  }, { owner: OWNER_A, input: mutation });

  expect(result.after).toBe(result.before);
  expect(result.pulled.changes[0].payload.tags).toEqual(["sync"]);
});

test("Fake Service 不访问 fetch、localStorage、IndexedDB 或 FavoriteRepository", async ({ page }) => {
  const mutation = makeMutation(makeFavorite("favorite:no-io"));
  const result = await page.evaluate(({ owner, input }) => {
    let fetchCalls = 0;
    let storageCalls = 0;
    let indexedDbCalls = 0;
    const originalFetch = window.fetch;
    const originalGetItem = Storage.prototype.getItem;
    const originalSetItem = Storage.prototype.setItem;
    const originalOpen = indexedDB.open.bind(indexedDB);
    window.fetch = () => {
      fetchCalls += 1;
      throw new Error("fetch must not run");
    };
    Storage.prototype.getItem = function() {
      storageCalls += 1;
      throw new Error("storage must not run");
    };
    Storage.prototype.setItem = function() {
      storageCalls += 1;
      throw new Error("storage must not run");
    };
    indexedDB.open = function() {
      indexedDbCalls += 1;
      throw new Error("IndexedDB must not run");
    };
    const originalRepository = window.LingoFlowFavoriteRepository;
    window.LingoFlowFavoriteRepository = new Proxy({}, {
      get() {
        throw new Error("Repository must not run");
      }
    });

    try {
      const service = window.LingoFlowFakeSyncService.create();
      const pushed = service.push(owner, input);
      const pulled = service.pull(owner, null);
      return { pushed, pulled, fetchCalls, storageCalls, indexedDbCalls };
    } finally {
      window.fetch = originalFetch;
      Storage.prototype.getItem = originalGetItem;
      Storage.prototype.setItem = originalSetItem;
      indexedDB.open = originalOpen;
      window.LingoFlowFavoriteRepository = originalRepository;
    }
  }, { owner: OWNER_A, input: mutation });

  expect(result.pushed.status).toBe("applied");
  expect(result.pulled.changes).toHaveLength(1);
  expect(result.fetchCalls).toBe(0);
  expect(result.storageCalls).toBe(0);
  expect(result.indexedDbCalls).toBe(0);
});

test("applied result 使用严格字段 shape", async ({ page }) => {
  const result = await page.evaluate(() => {
    const protocol = window.LingoFlowCloudSyncProtocol;
    const valid = {
      status: "applied",
      mutationId: "mutation:result:applied",
      entityType: "favorites",
      entityId: "favorite:result:applied",
      scope: "record",
      schemaVersion: "1",
      revision: "opaque-revision",
      cursor: "opaque-cursor"
    };
    return {
      valid: protocol.validateResult(valid),
      missingCursor: protocol.validateResult((({ cursor, ...rest }) => rest)(valid))
    };
  });

  expect(result.valid.status).toBe("valid");
  expect(result.missingCursor.status).toBe("rejected");
  expect(result.missingCursor.errors).toContainEqual({
    code: "missing-field",
    path: "cursor"
  });
});

test("unchanged result 使用严格字段 shape", async ({ page }) => {
  const result = await page.evaluate(() => {
    const protocol = window.LingoFlowCloudSyncProtocol;
    const valid = {
      status: "unchanged",
      mutationId: "mutation:result:unchanged",
      entityType: "favorites",
      entityId: "favorite:result:unchanged",
      scope: "record",
      schemaVersion: "1",
      revision: "opaque-revision",
      cursor: "opaque-cursor"
    };
    return {
      valid: protocol.validateResult(valid),
      conflictMetadata: protocol.validateResult({
        ...valid,
        reason: "must-not-be-here"
      })
    };
  });

  expect(result.valid.status).toBe("valid");
  expect(result.conflictMetadata.status).toBe("rejected");
  expect(result.conflictMetadata.errors).toContainEqual({
    code: "unexpected-field",
    path: "reason"
  });
});

test("conflict result 使用严格字段 shape 且验证 current Favorite", async ({ page }) => {
  const favorite = makeFavorite("favorite:result:conflict");
  const result = await page.evaluate(payload => {
    const protocol = window.LingoFlowCloudSyncProtocol;
    const valid = {
      status: "conflict",
      mutationId: "mutation:result:conflict",
      entityType: "favorites",
      entityId: payload.id,
      scope: "record",
      schemaVersion: "1",
      reason: "revision-mismatch",
      currentRevision: "opaque-revision",
      currentCursor: "opaque-cursor",
      currentPayload: payload
    };
    return {
      valid: protocol.validateResult(valid),
      invalidPayload: protocol.validateResult({
        ...valid,
        currentPayload: { ...payload, type: "unsupported" }
      })
    };
  }, favorite);

  expect(result.valid.status).toBe("valid");
  expect(result.invalidPayload.status).toBe("rejected");
  expect(result.invalidPayload.errors).toContainEqual(expect.objectContaining({
    path: "payload.type"
  }));
});

test("rejected result 使用严格字段 shape", async ({ page }) => {
  const result = await page.evaluate(() => {
    const protocol = window.LingoFlowCloudSyncProtocol;
    const valid = {
      status: "rejected",
      mutationId: null,
      entityType: null,
      entityId: null,
      scope: null,
      reason: "invalid-mutation"
    };
    return {
      valid: protocol.validateResult(valid),
      missingReason: protocol.validateResult((({ reason, ...rest }) => rest)(valid))
    };
  });

  expect(result.valid.status).toBe("valid");
  expect(result.missingReason.status).toBe("rejected");
  expect(result.missingReason.errors).toContainEqual({
    code: "missing-field",
    path: "reason"
  });
});

test("rejected result 不得携带成功 revision、cursor 或 payload", async ({ page }) => {
  const result = await page.evaluate(() => (
    window.LingoFlowCloudSyncProtocol.validateResult({
      status: "rejected",
      mutationId: "mutation:result:rejected-metadata",
      entityType: "favorites",
      entityId: "favorite:result:rejected-metadata",
      scope: "record",
      reason: "invalid-mutation",
      revision: "fake-revision",
      cursor: "fake-cursor",
      currentPayload: {}
    })
  ));

  expect(result.status).toBe("rejected");
  expect(result.errors).toEqual(expect.arrayContaining([
    { code: "unexpected-field", path: "revision" },
    { code: "unexpected-field", path: "cursor" },
    { code: "unexpected-field", path: "currentPayload" }
  ]));
});

test("result identity 拒绝 unsupported entity、scope 与 schemaVersion", async ({ page }) => {
  const result = await page.evaluate(() => {
    const protocol = window.LingoFlowCloudSyncProtocol;
    const base = {
      status: "applied",
      mutationId: "mutation:result:identity",
      entityType: "favorites",
      entityId: "favorite:result:identity",
      scope: "record",
      schemaVersion: "1",
      revision: "opaque-revision",
      cursor: "opaque-cursor"
    };
    return {
      entity: protocol.validateResult({ ...base, entityType: "articles" }),
      scope: protocol.validateResult({ ...base, scope: "collection" }),
      version: protocol.validateResult({ ...base, schemaVersion: "2" })
    };
  });

  expect(result.entity.errors).toContainEqual({
    code: "unsupported-entity",
    path: "entityType"
  });
  expect(result.scope.errors).toContainEqual({
    code: "unsupported-scope",
    path: "scope"
  });
  expect(result.version.errors).toContainEqual({
    code: "unsupported-schema-version",
    path: "schemaVersion"
  });
});

test("baseRevision null 不覆盖已存在的不同 Favorite", async ({ page }) => {
  const mutation = makeMutation(makeFavorite("favorite:null-base-existing"));
  const result = await page.evaluate(({ owner, input }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const created = service.push(owner, input);
    const attempted = service.push(owner, {
      ...input,
      mutationId: "mutation:null-base-existing:second",
      payload: {
        ...input.payload,
        note: "must not overwrite",
        updatedAt: "2026-09-01T03:00:00.000Z"
      }
    });
    return { created, attempted, pulled: service.pull(owner, null) };
  }, { owner: OWNER_A, input: mutation });

  expect(result.attempted.status).toBe("conflict");
  expect(result.attempted.currentRevision).toBe(result.created.revision);
  expect(result.pulled.changes).toHaveLength(1);
  expect(result.pulled.changes[0].payload.note).toBeUndefined();
});

test("stale revision 提交 exact current payload 返回 unchanged", async ({ page }) => {
  const mutation = makeMutation(makeFavorite("favorite:stale-exact"));
  const result = await page.evaluate(({ owner, input }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const created = service.push(owner, input);
    const currentPayload = {
      ...input.payload,
      note: "current",
      updatedAt: "2026-09-01T03:00:00.000Z"
    };
    const updated = service.push(owner, {
      ...input,
      mutationId: "mutation:stale-exact:update",
      baseRevision: created.revision,
      payload: currentPayload
    });
    const unchanged = service.push(owner, {
      ...input,
      mutationId: "mutation:stale-exact:replay",
      baseRevision: created.revision,
      payload: currentPayload
    });
    return { updated, unchanged, pulled: service.pull(owner, null) };
  }, { owner: OWNER_A, input: mutation });

  expect(result.unchanged.status).toBe("unchanged");
  expect(result.unchanged.revision).toBe(result.updated.revision);
  expect(result.unchanged.cursor).toBe(result.updated.cursor);
  expect(result.pulled.changes).toHaveLength(2);
});

test("幂等请求只改变 object property insertion order 仍是 exact replay", async ({ page }) => {
  const mutation = makeMutation(makeFavorite("favorite:idempotent-property-order", {
    origin: { articleId: "article:1", articleTitle: "Title" }
  }));
  const result = await page.evaluate(({ owner, input }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const first = service.push(owner, input);
    const reorderedPayload = {};
    for (const key of Object.keys(input.payload).reverse()) {
      if (key === "origin") {
        reorderedPayload[key] = {
          articleTitle: input.payload.origin.articleTitle,
          articleId: input.payload.origin.articleId
        };
      } else {
        reorderedPayload[key] = input.payload[key];
      }
    }
    const reordered = {
      payload: reorderedPayload,
      observedCursor: input.observedCursor,
      baseRevision: input.baseRevision,
      operation: input.operation,
      schemaVersion: input.schemaVersion,
      scope: input.scope,
      entityId: input.entityId,
      entityType: input.entityType,
      mutationId: input.mutationId
    };
    const replay = service.push(owner, reordered);
    return { first, replay, pulled: service.pull(owner, null) };
  }, { owner: OWNER_A, input: mutation });

  expect(result.replay).toEqual(result.first);
  expect(result.pulled.changes).toHaveLength(1);
});

test("相同 mutationId 与 entityId 在不同 owner 的 receipt 和 cursor 完全独立", async ({ page }) => {
  const mutation = makeMutation(makeFavorite("favorite:owner-receipt-isolation"));
  const result = await page.evaluate(({ ownerA, ownerB, input }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const createdA = service.push(ownerA, input);
    const createdB = service.push(ownerB, input);
    service.push(ownerA, {
      ...input,
      mutationId: "mutation:owner-receipt-isolation:update-a",
      baseRevision: createdA.revision,
      payload: {
        ...input.payload,
        note: "Owner A second change",
        updatedAt: "2026-09-01T03:00:00.000Z"
      }
    });
    return {
      createdA,
      createdB,
      ownerA: service.pull(ownerA, null),
      ownerB: service.pull(ownerB, null)
    };
  }, { ownerA: OWNER_A, ownerB: OWNER_B, input: mutation });

  expect(result.createdA.status).toBe("applied");
  expect(result.createdB.status).toBe("applied");
  expect(result.ownerA.changes).toHaveLength(2);
  expect(result.ownerB.changes).toHaveLength(1);
  expect(result.ownerB.nextCursor).toBe(result.createdB.cursor);
});

test("pull 明确拒绝 malformed 与 future cursor", async ({ page }) => {
  const mutation = makeMutation(makeFavorite("favorite:cursor-validation"));
  const result = await page.evaluate(({ owner, input }) => {
    const service = window.LingoFlowFakeSyncService.create();
    service.push(owner, input);
    return {
      malformed: service.pull(owner, "not-a-cursor"),
      future: service.pull(owner, "cursor:99")
    };
  }, { owner: OWNER_A, input: mutation });

  expect(result.malformed).toEqual({
    status: "rejected",
    changes: [],
    nextCursor: null,
    reason: "invalid-cursor"
  });
  expect(result.future).toEqual({
    status: "rejected",
    changes: [],
    nextCursor: null,
    reason: "cursor-out-of-range"
  });
});

test("push 后修改调用方 mutation 不改变 server snapshot", async ({ page }) => {
  const mutation = makeMutation(makeFavorite("favorite:post-push-input-mutation", {
    tags: ["original"]
  }));
  const result = await page.evaluate(({ owner, input }) => {
    const service = window.LingoFlowFakeSyncService.create();
    service.push(owner, input);
    input.payload.text = "caller changed";
    input.payload.tags.push("caller-only");
    return service.pull(owner, null);
  }, { owner: OWNER_A, input: mutation });

  expect(result.changes[0].payload.text).toBe("resilient");
  expect(result.changes[0].payload.tags).toEqual(["original"]);
});

test("mutation 明确拒绝 unsupported scope 与 operation", async ({ page }) => {
  const mutation = makeMutation(makeFavorite("favorite:unsupported-boundary"));
  const result = await page.evaluate(input => {
    const protocol = window.LingoFlowCloudSyncProtocol;
    return {
      scope: protocol.validateMutation({ ...input, scope: "collection" }),
      operation: protocol.validateMutation({ ...input, operation: "merge" })
    };
  }, mutation);

  expect(result.scope.errors).toContainEqual({
    code: "unsupported-scope",
    path: "scope"
  });
  expect(result.operation.errors).toContainEqual({
    code: "unsupported-operation",
    path: "operation"
  });
});

test("tombstone current revision 下普通 active put 不能隐式 restore", async ({ page }) => {
  const active = makeFavorite("favorite:explicit-restore-required");
  const tombstone = makeFavorite(active.id, {
    updatedAt: "2026-09-01T03:00:00.000Z",
    deletedAt: "2026-09-01T03:00:00.000Z"
  });
  const result = await page.evaluate(({ owner, createInput, tombstonePayload }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const created = service.push(owner, createInput);
    const deleted = service.push(owner, {
      ...createInput,
      mutationId: "mutation:explicit-required:delete",
      baseRevision: created.revision,
      payload: tombstonePayload
    });
    const attempted = service.push(owner, {
      ...createInput,
      mutationId: "mutation:explicit-required:ordinary-put",
      baseRevision: deleted.revision,
      payload: {
        ...createInput.payload,
        updatedAt: "2026-09-01T04:00:00.000Z"
      }
    });
    return { deleted, attempted, pulled: service.pull(owner, deleted.cursor) };
  }, { owner: OWNER_A, createInput: makeMutation(active), tombstonePayload: tombstone });

  expect(result.attempted).toMatchObject({
    status: "rejected",
    reason: "explicit-restore-required"
  });
  expect(result.pulled.nextCursor).toBe(result.deleted.cursor);
  expect(result.pulled.changes).toEqual([]);
});

test("explicit restore 基于 current tombstone revision 产生新 revision、cursor 与 active change", async ({ page }) => {
  const active = makeFavorite("favorite:explicit-restore-success");
  const tombstone = makeFavorite(active.id, {
    updatedAt: "2026-09-01T03:00:00.000Z",
    deletedAt: "2026-09-01T03:00:00.000Z"
  });
  const restored = makeFavorite(active.id, {
    updatedAt: "2026-09-01T04:00:00.000Z"
  });
  const result = await page.evaluate(({ owner, createInput, tombstonePayload, restoredPayload }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const created = service.push(owner, createInput);
    const deleted = service.push(owner, {
      ...createInput,
      mutationId: "mutation:restore-success:delete",
      baseRevision: created.revision,
      payload: tombstonePayload
    });
    const restoredResult = service.push(owner, {
      ...createInput,
      mutationId: "mutation:restore-success:restore",
      operation: "restore",
      baseRevision: deleted.revision,
      observedCursor: deleted.cursor,
      payload: restoredPayload
    });
    return {
      deleted,
      restored: restoredResult,
      pulled: service.pull(owner, deleted.cursor)
    };
  }, {
    owner: OWNER_A,
    createInput: makeMutation(active),
    tombstonePayload: tombstone,
    restoredPayload: restored
  });

  expect(result.restored.status).toBe("applied");
  expect(result.restored.revision).not.toBe(result.deleted.revision);
  expect(result.restored.cursor).not.toBe(result.deleted.cursor);
  expect(result.pulled.nextCursor).toBe(result.restored.cursor);
  expect(result.pulled.changes).toHaveLength(1);
  expect(result.pulled.changes[0]).toMatchObject({
    operation: "restore",
    payload: restored
  });
});

test("stale explicit restore 返回 conflict 并保留 tombstone", async ({ page }) => {
  const active = makeFavorite("favorite:stale-explicit-restore");
  const tombstone = makeFavorite(active.id, {
    updatedAt: "2026-09-01T03:00:00.000Z",
    deletedAt: "2026-09-01T03:00:00.000Z"
  });
  const result = await page.evaluate(({ owner, createInput, tombstonePayload }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const created = service.push(owner, createInput);
    const deleted = service.push(owner, {
      ...createInput,
      mutationId: "mutation:stale-restore:delete",
      baseRevision: created.revision,
      payload: tombstonePayload
    });
    const restored = service.push(owner, {
      ...createInput,
      mutationId: "mutation:stale-restore:restore",
      operation: "restore",
      baseRevision: created.revision,
      payload: {
        ...createInput.payload,
        updatedAt: "2026-09-01T04:00:00.000Z"
      }
    });
    return { deleted, restored, pulled: service.pull(owner, deleted.cursor) };
  }, { owner: OWNER_A, createInput: makeMutation(active), tombstonePayload: tombstone });

  expect(result.restored.status).toBe("conflict");
  expect(result.restored.currentRevision).toBe(result.deleted.revision);
  expect(result.restored.currentPayload.deletedAt).toBe(tombstone.deletedAt);
  expect(result.pulled.changes).toEqual([]);
});

test("active record 上 explicit restore 被拒绝", async ({ page }) => {
  const mutation = makeMutation(makeFavorite("favorite:restore-active-target"));
  const result = await page.evaluate(({ owner, input }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const created = service.push(owner, input);
    const restored = service.push(owner, {
      ...input,
      mutationId: "mutation:restore-active-target:restore",
      operation: "restore",
      baseRevision: created.revision
    });
    return { created, restored, pulled: service.pull(owner, created.cursor) };
  }, { owner: OWNER_A, input: mutation });

  expect(result.restored).toMatchObject({
    status: "rejected",
    reason: "restore-target-not-tombstone"
  });
  expect(result.pulled.changes).toEqual([]);
});

test("explicit restore exact idempotent replay 不产生第二个 revision、cursor 或 change", async ({ page }) => {
  const active = makeFavorite("favorite:restore-idempotent");
  const tombstone = makeFavorite(active.id, {
    updatedAt: "2026-09-01T03:00:00.000Z",
    deletedAt: "2026-09-01T03:00:00.000Z"
  });
  const result = await page.evaluate(({ owner, createInput, tombstonePayload }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const created = service.push(owner, createInput);
    const deleted = service.push(owner, {
      ...createInput,
      mutationId: "mutation:restore-idempotent:delete",
      baseRevision: created.revision,
      payload: tombstonePayload
    });
    const restoreMutation = {
      ...createInput,
      mutationId: "mutation:restore-idempotent:restore",
      operation: "restore",
      baseRevision: deleted.revision,
      payload: {
        ...createInput.payload,
        updatedAt: "2026-09-01T04:00:00.000Z"
      }
    };
    const first = service.push(owner, restoreMutation);
    const replay = service.push(owner, structuredClone(restoreMutation));
    return { first, replay, pulled: service.pull(owner, deleted.cursor) };
  }, { owner: OWNER_A, createInput: makeMutation(active), tombstonePayload: tombstone });

  expect(result.replay).toEqual(result.first);
  expect(result.pulled.nextCursor).toBe(result.first.cursor);
  expect(result.pulled.changes).toHaveLength(1);
});

test("同 mutationId 的 put 与 restore 被视为不同请求", async ({ page }) => {
  const mutation = makeMutation(makeFavorite("favorite:idempotency-operation"));
  const result = await page.evaluate(({ owner, input }) => {
    const service = window.LingoFlowFakeSyncService.create();
    const first = service.push(owner, input);
    const reused = service.push(owner, {
      ...input,
      operation: "restore",
      baseRevision: first.revision
    });
    return { first, reused, pulled: service.pull(owner, null) };
  }, { owner: OWNER_A, input: mutation });

  expect(result.reused).toMatchObject({
    status: "rejected",
    reason: "idempotency-key-reused"
  });
  expect(result.pulled.changes).toHaveLength(1);
});
