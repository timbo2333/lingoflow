"use strict";

// Explicit MOCK fresh SELECT/auth adapters. No network, production create or
// public capability factory: even browser tests go through runPreparation.
const fixture = require("./progress-live-fixture-helpers");
const { openFixtureRuntimeSession } = require("./progress-live-fixture-runtime");
const sessions = new WeakMap();
async function seedFromMockVerification(page, input, providedSession = null, beforeSeed = null) {
  try {
    let session = providedSession || sessions.get(page);
    if (!session) {
      session = await openFixtureRuntimeSession({ ownerId: fixture.OWNER, articleId: input.definition.articleId },
        { cdpURL: "http://127.0.0.1:19993/", runtimeURL: "http://127.0.0.1:4173/" });
      sessions.set(page, session);
    }
    const current = await session.captureScope();
    if (input.runtimeIdentity !== input.baseline.runtimeIdentity || !Object.values(input.gates).every(v => v === true) ||
        ["ownerId", "bindingId", "generation", "scopeToken"].some(k => input.baseline[k] !== current[k])) return { status: "blocked" };
    const d = fixture.validateDefinition(input.definition), { article, progress } = input.server;
    const state = { article, progress, history: { articleChanges: "1", articleReceipts: "1", progressChanges: "1",
      progressReceipts: "1", articleSetupReceipt: "1", progressSetupReceipt: "1" },
    articleResult: { status: "applied", operation: "put", mutationId: d.articleMutationId, articleId: d.articleId,
      revision: article.revision, cursor: article.cursor, readingEpoch: article.readingEpoch, contentFingerprint: article.contentFingerprint },
    progressResult: { ...progress, status: "applied", mutationId: d.progressMutationId } };
    let journal = { ...fixture.newJournal(d), stage: "progress_seeded", completedStage: "progress_seeded",
      articleAttempted: true, progressAttempted: true, article, progress };
    let seeded = { status: "blocked" };
    const result = await fixture.runPreparation({ LF_PROGRESS_LIVE_TEST: "1", LF_PROGRESS_FIXTURE_PREPARE: "1",
      LF_PROGRESS_OWNER_A: fixture.OWNER, LF_PROGRESS_JWT_A: "mock.test.only", LF_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_mock",
      LF_SUPABASE_URL: "https://yebabpjplbgidzwpjhoy.supabase.co" }, { dedicatedTestAccount: true, articleId: d.articleId }, {
      acquireJournalLock: async () => {}, releaseJournalLock: async () => {},
      readJournal: async () => structuredClone(journal), writeJournal: async value => { journal = structuredClone(value); },
      verifyOwner: async () => fixture.OWNER, inspectServer: async () => structuredClone(state),
      articleSetup: async () => { throw new Error("Mock preparation must not setup Article"); },
      progressSeed: async () => { throw new Error("Mock preparation must not setup Progress"); },
      openRuntime: async () => ({ ...session, close: async () => {}, seedObservation: async capability => {
        if (beforeSeed) await beforeSeed(capability);
        seeded = await session.seedObservation(capability); return seeded;
      } })
    });
    return result.status === "ready" ? seeded : { status: "blocked" };
  } catch { return { status: "blocked" }; }
}
async function closeMockSession(page) { const session = sessions.get(page); sessions.delete(page); await session?.close(); }
module.exports = { seedFromMockVerification, closeMockSession };
