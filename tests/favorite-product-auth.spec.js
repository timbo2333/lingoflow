const { test, expect } = require("@playwright/test");

const PROJECT_URL = "https://product-auth.test.supabase.co";
const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";

async function installProductAuthHarness(page) {
  await page.route("**/js/supabase-config.js", route => route.fulfill({
    contentType: "application/javascript",
    body: `window.LingoFlowSupabaseConfig = Object.freeze({
      projectUrl: ${JSON.stringify(PROJECT_URL)},
      publishableKey: "sb_publishable_product_auth_test",
      sdkUrl: "https://sdk.product-auth.test/supabase.js"
    });`
  }));
  await page.addInitScript(({ projectUrl, ownerA, ownerB }) => {
    localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
    const SESSION_KEY = "__lingoflowTestAuthSession";
    const PUSH_COUNT_KEY = "__lingoflowTestPushCount";
    const callbacks = new Set();
    const readSession = () => {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    };
    const notify = (event, session) => {
      for (const callback of callbacks) callback(event, session);
    };
    const auth = {
      async getSession() {
        return { data: { session: readSession() }, error: null };
      },
      async getUser() {
        const session = readSession();
        return session
          ? { data: { user: session.user }, error: null }
          : { data: { user: null }, error: { message: "not signed in" } };
      },
      onAuthStateChange(callback) {
        callbacks.add(callback);
        queueMicrotask(() => callback("INITIAL_SESSION", readSession()));
        return { data: { subscription: { unsubscribe: () => callbacks.delete(callback) } } };
      },
      async signUp({ email }) {
        const ownerId = email.startsWith("beta-") ? ownerB : ownerA;
        return { data: { user: { id: ownerId, email }, session: null }, error: null };
      },
      async signInWithPassword({ email }) {
        const ownerId = email.startsWith("beta-") ? ownerB : ownerA;
        const session = {
          access_token: `test-access-token:${ownerId}`,
          user: { id: ownerId, email }
        };
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        notify("SIGNED_IN", session);
        return { data: { user: session.user, session }, error: null };
      },
      async signOut() {
        localStorage.removeItem(SESSION_KEY);
        notify("SIGNED_OUT", null);
        return { error: null };
      }
    };
    window.supabase = {
      createClient(url, key, options) {
        window.__productAuthClientOptions = {
          url,
          keyIsPublishable: String(key).startsWith("sb_publishable_"),
          auth: { ...options.auth }
        };
        return { auth };
      }
    };

    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (url, options = {}) => {
      const requestUrl = String(url);
      if (!requestUrl.startsWith(projectUrl)) return await nativeFetch(url, options);
      if (localStorage.getItem("__lingoflowTestOffline") === "1") {
        throw new TypeError("simulated offline");
      }
      const body = JSON.parse(options.body || "{}");
      if (requestUrl.endsWith("/lingoflow_favorite_sync_push")) {
        const mutation = body.p_mutation;
        const nextCount = Number(localStorage.getItem(PUSH_COUNT_KEY) || 0) + 1;
        localStorage.setItem(PUSH_COUNT_KEY, String(nextCount));
        return new Response(JSON.stringify({
          status: "applied",
          mutationId: mutation.mutationId,
          entityType: mutation.entityType,
          entityId: mutation.entityId,
          scope: mutation.scope,
          schemaVersion: mutation.schemaVersion,
          revision: `revision:${nextCount}`,
          cursor: `cursor:${nextCount}`
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (requestUrl.endsWith("/lingoflow_favorite_sync_pull")) {
        const count = Number(localStorage.getItem(PUSH_COUNT_KEY) || 0);
        return new Response(JSON.stringify({
          status: "ready",
          changes: [],
          nextCursor: `cursor:${count}`
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    };
  }, { projectUrl: PROJECT_URL, ownerA: OWNER_A, ownerB: OWNER_B });
}

async function waitForAuth(page, status) {
  await expect.poll(() => page.evaluate(() => window.LingoFlowSupabaseAuth?.getState().status))
    .toBe(status);
}

async function waitForSync(page, status, reason = null) {
  await expect.poll(() => page.evaluate(() => {
    const state = window.LingoFlowFavoriteAppSync?.getState();
    return { status: state?.status, reason: state?.reason || null };
  })).toEqual(reason === null
    ? expect.objectContaining({ status })
    : { status, reason });
}

async function createLocalFavorite(page, text) {
  return await page.evaluate(async value => {
    currentLookupState = {
      word: value,
      result: { baseWord: value, meaning: "本地收藏" },
      sentence: "Local-first remains available.",
      source: "search"
    };
    return await saveCurrentFavorite();
  }, text);
}

async function openAccountModal(page) {
  const modal = page.locator("#authModal");
  if (!(await modal.evaluate(element => element.classList.contains("show")))) {
    await page.click("#accountButton");
  }
}

async function signIn(page, email = "alpha@example.test") {
  await openAccountModal(page);
  await page.click("#authSignInMode");
  await page.fill("#authEmail", email);
  await page.fill("#authPassword", "test-password");
  await page.click("#authSubmitButton");
  await waitForAuth(page, "authenticated");
}

test.beforeEach(async ({ page }) => {
  await installProductAuthHarness(page);
});

test("未登录保持 local-only，注册成功提示确认邮箱且不绑定 workspace", async ({ page }) => {
  await page.goto("/");
  await waitForAuth(page, "signed-out");
  const favorite = await createLocalFavorite(page, "anonymous");

  await openAccountModal(page);
  await page.click("#authSignUpMode");
  await page.fill("#authEmail", "alpha@example.test");
  await page.fill("#authPassword", "test-password");
  await page.click("#authSubmitButton");
  await waitForAuth(page, "confirmation-required");

  const result = await page.evaluate(async id => ({
    favorite: window.LingoFlowFavoriteRepository.getById(id),
    binding: await window.LingoFlowSyncStateRepository.getWorkspaceBinding(),
    pushes: Number(localStorage.getItem("__lingoflowTestPushCount") || 0)
  }), favorite.id);
  expect(result.favorite).toEqual(favorite);
  expect(result.binding).toEqual({ status: "missing", binding: null });
  expect(result.pushes).toBe(0);
  await expect(page.locator("#authFeedback")).toContainText("检查邮箱");
});

test("已有匿名 Favorite 登录后必须明确确认；暂不关联不会上传", async ({ page }) => {
  await page.goto("/");
  const favorite = await createLocalFavorite(page, "consent");
  await signIn(page);
  await waitForSync(page, "activation-required", "anonymous-favorites-require-consent");

  await expect(page.locator("#workspaceActivationPanel")).toBeVisible();
  expect(await page.evaluate(() => Number(localStorage.getItem("__lingoflowTestPushCount") || 0)))
    .toBe(0);
  await page.click("#workspaceDeferButton");
  await waitForSync(page, "inactive", "activation-deferred");

  const result = await page.evaluate(async id => ({
    favorite: window.LingoFlowFavoriteRepository.getById(id),
    binding: await window.LingoFlowSyncStateRepository.getWorkspaceBinding(),
    pushes: Number(localStorage.getItem("__lingoflowTestPushCount") || 0)
  }), favorite.id);
  expect(result.favorite).toEqual(favorite);
  expect(result.binding.status).toBe("missing");
  expect(result.pushes).toBe(0);
});

test("确认关联后保持 stable ID 上传，刷新恢复 session，退出保留数据且同账号可恢复", async ({ page }) => {
  await page.goto("/");
  const favorite = await createLocalFavorite(page, "activate");
  await signIn(page);
  await waitForSync(page, "activation-required");
  await page.click("#workspaceActivateButton");
  await waitForSync(page, "ready");
  await expect.poll(() => page.evaluate(() => (
    Number(localStorage.getItem("__lingoflowTestPushCount") || 0)
  ))).toBe(1);

  const first = await page.evaluate(async id => ({
    favorite: window.LingoFlowFavoriteRepository.getById(id),
    binding: await window.LingoFlowSyncStateRepository.getWorkspaceBinding(),
    sdk: window.__productAuthClientOptions
  }), favorite.id);
  expect(first.favorite.id).toBe(favorite.id);
  expect(first.binding).toMatchObject({ status: "ready", binding: { ownerId: OWNER_A } });
  expect(first.sdk.auth).toMatchObject({ persistSession: true, autoRefreshToken: true });

  await page.reload();
  await waitForAuth(page, "authenticated");
  await waitForSync(page, "ready");
  const afterReload = await page.evaluate(async () => (
    await window.LingoFlowSyncStateRepository.getWorkspaceBinding()
  ));
  expect(afterReload.binding.bindingId).toBe(first.binding.binding.bindingId);

  await openAccountModal(page);
  await page.click("#authSignOutButton");
  await waitForAuth(page, "signed-out");
  await waitForSync(page, "inactive", "auth-required");
  const afterLogout = await page.evaluate(async id => ({
    favorite: window.LingoFlowFavoriteRepository.getById(id),
    binding: await window.LingoFlowSyncStateRepository.getWorkspaceBinding()
  }), favorite.id);
  expect(afterLogout.favorite.id).toBe(favorite.id);
  expect(afterLogout.binding.binding.bindingId).toBe(first.binding.binding.bindingId);

  await signIn(page);
  await waitForSync(page, "ready");
  const rebound = await page.evaluate(async () => (
    await window.LingoFlowSyncStateRepository.getWorkspaceBinding()
  ));
  expect(rebound.binding.bindingId).toBe(first.binding.binding.bindingId);
});

test("不同账号登录不能接管已有 workspace 或上传其本地 Favorite", async ({ page }) => {
  await page.goto("/");
  await signIn(page);
  await waitForSync(page, "ready");
  const favorite = await createLocalFavorite(page, "owner-a");
  await expect.poll(() => page.evaluate(() => (
    Number(localStorage.getItem("__lingoflowTestPushCount") || 0)
  ))).toBe(1);

  await openAccountModal(page);
  await page.click("#authSignOutButton");
  await waitForAuth(page, "signed-out");
  await signIn(page, "beta-user@example.test");
  await waitForSync(page, "blocked", "workspace-owner-mismatch");

  const result = await page.evaluate(async id => ({
    favorite: window.LingoFlowFavoriteRepository.getById(id),
    binding: await window.LingoFlowSyncStateRepository.getWorkspaceBinding(),
    pushes: Number(localStorage.getItem("__lingoflowTestPushCount") || 0)
  }), favorite.id);
  expect(result.favorite.id).toBe(favorite.id);
  expect(result.binding.binding.ownerId).toBe(OWNER_A);
  expect(result.pushes).toBe(1);
  await expect(page.locator("#workspaceBlockedPanel")).toBeVisible();
});
