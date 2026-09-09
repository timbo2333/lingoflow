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
    window.__productAuthCalls = { signUp: [], resend: [], verifyOtp: [], signIn: [] };
    window.__productAuthStates = [];
    window.addEventListener("lingoflow:auth-state", event => {
      window.__productAuthStates.push({
        status: event.detail?.status,
        reason: event.detail?.reason
      });
    });
    const readSession = () => {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    };
    const notify = (event, session) => {
      for (const callback of callbacks) callback(event, session);
    };
    window.__productAuthEmit = notify;
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
        window.__productAuthCalls.signUp.push({ email });
        if (email.startsWith("weak-server-")) {
          return {
            data: { user: null, session: null },
            error: {
              code: "weak_password",
              reasons: ["characters"],
              message: "AuthApiError: Password should be stronger"
            }
          };
        }
        if (email.startsWith("network-")) {
          throw new TypeError("Failed to fetch auth endpoint");
        }
        const ownerId = email.startsWith("beta-") ? ownerB : ownerA;
        return { data: { user: { id: ownerId, email }, session: null }, error: null };
      },
      async resend({ type, email, options }) {
        window.__productAuthCalls.resend.push({
          type,
          email,
          redirectPath: new URL(options.emailRedirectTo).pathname
        });
        if (email.startsWith("resend-rate-")) {
          return {
            data: null,
            error: {
              code: "over_email_send_rate_limit",
              status: 429,
              message: "AuthApiError: email rate limit exceeded"
            }
          };
        }
        return { data: { messageId: "confirmation-message" }, error: null };
      },
      async verifyOtp({ email, token, type }) {
        window.__productAuthCalls.verifyOtp.push({ email, type });
        if (!["123456", "12345678"].includes(token)) {
          return {
            data: { user: null, session: null },
            error: {
              code: "otp_expired",
              message: "Token has expired or is invalid"
            }
          };
        }
        const ownerId = email.startsWith("beta-") ? ownerB : ownerA;
        const session = {
          access_token: `test-access-token:${ownerId}`,
          user: { id: ownerId, email }
        };
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        notify("SIGNED_IN", session);
        return { data: { user: session.user, session }, error: null };
      },
      async signInWithPassword({ email }) {
        window.__productAuthCalls.signIn.push({ email });
        if (email.startsWith("failure-")) {
          return {
            data: { user: null, session: null },
            error: {
              code: "invalid_credentials",
              message: "AuthApiError: invalid_grant from RPC"
            }
          };
        }
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

async function signUpAwaitingOtp(page, email = "alpha@example.test") {
  await openAccountModal(page);
  await page.click("#authSignUpMode");
  await page.fill("#authEmail", email);
  await page.fill("#authPassword", "test-password");
  await page.fill("#authConfirmPassword", "test-password");
  await page.click("#authSubmitButton");
  await waitForAuth(page, "otp-required");
}

test.beforeEach(async ({ page }) => {
  await installProductAuthHarness(page);
});

test("未登录保持 local-only，session=null 的注册成功进入 OTP 状态且不绑定 workspace", async ({ page }) => {
  await page.goto("/");
  await waitForAuth(page, "signed-out");
  await expect(page.locator("#favoriteSyncStatusBadge"))
    .toHaveText("收藏与学习状态仅保存在当前设备");
  const favorite = await createLocalFavorite(page, "anonymous");

  await openAccountModal(page);
  await expect(page.locator("#authModal .modalSub")).toContainText("无需登录也能使用");
  await expect(page.locator("#authPrivacyNote")).toContainText("收藏与学习状态会保存到云端");
  await expect(page.locator("#authPrivacyNote")).toContainText("暂不提供自助删除账号");
  await signUpAwaitingOtp(page);

  const result = await page.evaluate(async id => ({
    favorite: window.LingoFlowFavoriteRepository.getById(id),
    binding: await window.LingoFlowSyncStateRepository.getWorkspaceBinding(),
    pushes: Number(localStorage.getItem("__lingoflowTestPushCount") || 0)
  }), favorite.id);
  expect(result.favorite).toEqual(favorite);
  expect(result.binding).toEqual({ status: "missing", binding: null });
  expect(result.pushes).toBe(0);
  await expect(page.locator("#authOtpPanel")).toBeVisible();
  await expect(page.locator("#authOtpTitle")).toHaveText("验证码已发送");
  await expect(page.locator("#authOtpEmail")).toHaveText("alpha@example.test");
  await expect(page.locator("#authOtpPanel")).toContainText("发送了邮箱验证码");
  await expect(page.locator("#authOtpPanel")).toContainText("请输入邮件中的验证码");
  await expect(page.locator("body")).not.toContainText("6 位验证码");
  await expect(page.locator("#authFeedback")).toHaveText("验证码已发送");
  await expect(page.locator("#authFeedback")).toHaveAttribute("data-kind", "success");
  await expect(page.locator("#authFeedback")).not.toContainText("注册失败");
  await expect(page.locator("#authEmail")).toHaveValue("alpha@example.test");
  await expect(page.locator("#authPassword")).toHaveValue("");
  await expect(page.locator("#authConfirmPassword")).toHaveValue("");

  await page.evaluate(() => window.__productAuthEmit("INITIAL_SESSION", null));
  await expect.poll(() => page.evaluate(() => (
    window.LingoFlowSupabaseAuth.getState().status
  ))).toBe("otp-required");
  await expect(page.locator("#authOtpPanel")).toBeVisible();
});

test("登录与注册密码框支持键盘显示隐藏且不改变 value", async ({ page }) => {
  await page.goto("/");
  await openAccountModal(page);

  const confirmPasswordGroup = page.locator("#authConfirmPasswordGroup");
  await expect(confirmPasswordGroup).toBeHidden();

  const password = page.locator("#authPassword");
  const passwordToggle = page.locator("#authPasswordVisibility");
  await password.fill("keyboard-secret");
  await expect(password).toHaveAttribute("type", "password");
  await expect(passwordToggle).toHaveAttribute("aria-label", "显示密码");
  await passwordToggle.focus();
  await page.keyboard.press("Enter");
  await expect(password).toHaveAttribute("type", "text");
  await expect(password).toHaveValue("keyboard-secret");
  await expect(passwordToggle).toHaveAttribute("aria-label", "隐藏密码");
  await passwordToggle.click();
  await expect(password).toHaveAttribute("type", "password");
  await expect(password).toHaveValue("keyboard-secret");

  await page.click("#authSignUpMode");
  const confirmation = page.locator("#authConfirmPassword");
  const confirmationToggle = page.locator("#authConfirmPasswordVisibility");
  await expect(confirmation).toBeVisible();
  await confirmation.fill("confirmation-secret");
  await confirmationToggle.focus();
  await page.keyboard.press("Space");
  await expect(confirmation).toHaveAttribute("type", "text");
  await expect(confirmation).toHaveValue("confirmation-secret");
  await expect(confirmationToggle).toHaveAttribute("aria-label", "隐藏确认密码");

  await page.click("#authSignInMode");
  await expect(confirmPasswordGroup).toBeHidden();
  await page.click("#authSignUpMode");
  await expect(confirmPasswordGroup).toBeVisible();
  await page.click("#authSignInMode");
  await expect(confirmPasswordGroup).toBeHidden();
});

test("注册前验证明确提示且不会调用 Supabase signUp", async ({ page }) => {
  await page.goto("/");
  await openAccountModal(page);
  await page.click("#authSignUpMode");

  await page.click("#authSubmitButton");
  await expect(page.locator("#authFeedback")).toHaveText("请输入邮箱。");

  await page.fill("#authEmail", "invalid-email");
  await page.click("#authSubmitButton");
  await expect(page.locator("#authFeedback")).toHaveText("请输入有效邮箱地址。");

  await page.fill("#authEmail", "validation@example.test");
  await page.click("#authSubmitButton");
  await expect(page.locator("#authFeedback")).toHaveText("请输入密码。");

  await page.fill("#authPassword", "12345");
  await page.click("#authSubmitButton");
  await expect(page.locator("#authFeedback")).toHaveText("密码至少需要 6 个字符。");

  await page.fill("#authPassword", "123456");
  await page.click("#authSubmitButton");
  await expect(page.locator("#authFeedback")).toHaveText("请再次输入密码。");

  await page.fill("#authConfirmPassword", "654321");
  await page.click("#authSubmitButton");
  await expect(page.locator("#authFeedback")).toHaveText("两次输入的密码不一致");
  await expect(page.locator("#authEmail")).toHaveValue("validation@example.test");
  await expect(page.locator("#authPassword")).toHaveValue("123456");
  await expect(page.locator("#authConfirmPassword")).toHaveValue("654321");

  expect(await page.evaluate(() => window.__productAuthCalls.signUp)).toEqual([]);
});

test("OTP 只接受 6–10 位数字，5 位、11 位与非数字不会提交", async ({ page }) => {
  await page.goto("/");
  await signUpAwaitingOtp(page, "otp-validation@example.test");

  await page.click("#authVerifyOtpButton");
  await expect(page.locator("#authFeedback")).toHaveText("请输入验证码。");

  await page.fill("#authOtpCode", "12345");
  await page.press("#authOtpCode", "Enter");
  await expect(page.locator("#authFeedback")).toHaveText("请输入 6–10 位数字验证码。");

  await page.fill("#authOtpCode", "");
  await page.locator("#authOtpCode").pressSequentially("12a34");
  await expect(page.locator("#authOtpCode")).toHaveValue("1234");
  await page.press("#authOtpCode", "Enter");
  await expect(page.locator("#authFeedback")).toHaveText("请输入 6–10 位数字验证码。");

  await page.fill("#authOtpCode", "");
  await page.locator("#authOtpCode").pressSequentially("12345678901");
  await expect(page.locator("#authOtpCode")).toHaveValue("1234567890");

  await page.evaluate(() => {
    document.getElementById("authOtpCode").value = "12345678901";
  });
  await page.click("#authVerifyOtpButton");
  await expect(page.locator("#authFeedback")).toHaveText("请输入 6–10 位数字验证码。");
  expect(await page.evaluate(() => window.__productAuthCalls.verifyOtp)).toEqual([]);
});

test("8 位 verifyOtp 成功后进入 authenticated 并保持 Workspace Activation 边界", async ({ page }) => {
  await page.goto("/");
  const favorite = await createLocalFavorite(page, "otp-activation");
  await signUpAwaitingOtp(page, "otp-success@example.test");

  await page.fill("#authOtpCode", "12345678");
  await page.press("#authOtpCode", "Enter");
  await waitForAuth(page, "authenticated");
  await waitForSync(page, "activation-required", "anonymous-favorites-require-consent");

  await expect(page.locator("#authFeedback")).toHaveText("邮箱验证成功");
  await expect(page.locator("#authFeedback")).toHaveAttribute("data-kind", "success");
  await expect(page.locator("#authOtpPanel")).toBeHidden();
  expect(await page.evaluate(() => window.__productAuthCalls.verifyOtp)).toEqual([{
    email: "otp-success@example.test",
    type: "email"
  }]);
  expect(await page.evaluate(() => window.__productAuthStates)).toEqual(
    expect.arrayContaining([
      { status: "authenticating", reason: "signing-up" },
      { status: "otp-required", reason: "otp-sent" },
      { status: "verifying", reason: "verifying-otp" },
      { status: "authenticated", reason: "email-verified" }
    ])
  );
  const result = await page.evaluate(async id => ({
    favorite: window.LingoFlowFavoriteRepository.getById(id),
    binding: await window.LingoFlowSyncStateRepository.getWorkspaceBinding(),
    pushes: Number(localStorage.getItem("__lingoflowTestPushCount") || 0)
  }), favorite.id);
  expect(result.favorite.id).toBe(favorite.id);
  expect(result.binding).toEqual({ status: "missing", binding: null });
  expect(result.pushes).toBe(0);
});

test("6 位 OTP 仍可完成验证", async ({ page }) => {
  await page.goto("/");
  await signUpAwaitingOtp(page, "otp-six-digit@example.test");

  await page.fill("#authOtpCode", "123456");
  await page.press("#authOtpCode", "Enter");
  await waitForAuth(page, "authenticated");

  await expect(page.locator("#authFeedback")).toHaveText("邮箱验证成功");
  expect(await page.evaluate(() => window.__productAuthCalls.verifyOtp)).toEqual([{
    email: "otp-six-digit@example.test",
    type: "email"
  }]);
});

test("verifyOtp 失败保留邮箱与验证码并显示友好文案", async ({ page }) => {
  await page.goto("/");
  await signUpAwaitingOtp(page, "otp-failure@example.test");
  await page.fill("#authOtpCode", "000000");
  await page.click("#authVerifyOtpButton");

  await expect.poll(() => page.evaluate(() => {
    const state = window.LingoFlowSupabaseAuth.getState();
    return { status: state.status, reason: state.reason, errorCode: state.errorCode };
  })).toEqual({
    status: "otp-required",
    reason: "otp-verification-failed",
    errorCode: "otp_expired"
  });
  await expect(page.locator("#authOtpPanel")).toBeVisible();
  await expect(page.locator("#authOtpEmail")).toHaveText("otp-failure@example.test");
  await expect(page.locator("#authOtpCode")).toHaveValue("000000");
  await expect(page.locator("#authFeedback"))
    .toHaveText("验证码不正确或已过期，请重新输入。");
  await expect(page.locator("#authFeedback")).not.toContainText("Token");
});

test("OTP 状态可重新发送并通过 cooldown 防止连续点击", async ({ page }) => {
  await page.goto("/");
  await signUpAwaitingOtp(page, "resend-success@example.test");

  await page.fill("#authOtpCode", "123456");
  await page.click("#authResendOtpButton");
  await expect.poll(() => page.evaluate(() => window.LingoFlowSupabaseAuth.getState().reason))
    .toBe("otp-resent");
  await expect(page.locator("#authOtpTitle")).toHaveText("验证码已重新发送");
  await expect(page.locator("#authFeedback")).toHaveText("验证码已重新发送");
  await expect(page.locator("#authOtpCode")).toHaveValue("");
  await expect(page.locator("#authResendOtpButton")).toBeDisabled();
  await expect(page.locator("#authResendOtpButton"))
    .toContainText("重新发送验证码（60s）");

  expect(await page.evaluate(() => window.__productAuthCalls.resend)).toEqual([{
    type: "signup",
    email: "resend-success@example.test",
    redirectPath: "/"
  }]);
  await page.evaluate(() => document.getElementById("authResendOtpButton").click());
  expect(await page.evaluate(() => window.__productAuthCalls.resend)).toHaveLength(1);

  await page.click("#authReturnToSignInButton");
  await expect(page.locator("#authOtpPanel")).toBeHidden();
  await expect(page.locator("#authForm")).toBeVisible();
  await expect(page.locator("#authSignInMode")).toHaveClass(/active/);
  await expect(page.locator("#authConfirmPasswordGroup")).toBeHidden();
  await expect(page.locator("#authEmail")).toHaveValue("resend-success@example.test");
});

test("重新发送频率限制只显示普通用户文案", async ({ page }) => {
  await page.goto("/");
  await signUpAwaitingOtp(page, "resend-rate-user@example.test");
  await page.click("#authResendOtpButton");

  await expect.poll(() => page.evaluate(() => {
    const state = window.LingoFlowSupabaseAuth.getState();
    return { reason: state.reason, errorCode: state.errorCode };
  })).toEqual({
    reason: "resend-failed",
    errorCode: "over_email_send_rate_limit"
  });
  await expect(page.locator("#authOtpPanel")).toBeVisible();
  await expect(page.locator("#authFeedback"))
    .toHaveText("操作过于频繁，请稍后再试。");
  await expect(page.locator("#authFeedback")).not.toContainText("AuthApiError");
  await expect(page.locator("#authFeedback")).not.toContainText("rate limit");
});

test("服务端 weak password 与网络异常映射为安全用户文案", async ({ page }) => {
  await page.goto("/");
  await openAccountModal(page);
  await page.click("#authSignUpMode");
  await page.fill("#authEmail", "weak-server-user@example.test");
  await page.fill("#authPassword", "server-accepted-length");
  await page.fill("#authConfirmPassword", "server-accepted-length");
  await page.click("#authSubmitButton");
  await waitForAuth(page, "failed");

  expect(await page.evaluate(() => window.LingoFlowSupabaseAuth.getState().errorCode))
    .toBe("weak_password");
  await expect(page.locator("#authFeedback"))
    .toHaveText("密码需要包含更多种类的字符（如字母、数字或符号）。");
  await expect(page.locator("#authFeedback")).not.toContainText("AuthApiError");

  await page.fill("#authEmail", "network-user@example.test");
  await page.click("#authSubmitButton");
  await waitForAuth(page, "failed");
  expect(await page.evaluate(() => window.LingoFlowSupabaseAuth.getState().errorCode))
    .toBe("network_error");
  await expect(page.locator("#authFeedback"))
    .toHaveText("网络连接异常，请稍后重试。");
  await expect(page.locator("#authFeedback")).not.toContainText("Failed to fetch");
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

test("账号失败只显示用户文案，不暴露服务端技术错误", async ({ page }) => {
  await page.goto("/");
  await openAccountModal(page);
  await page.fill("#authEmail", "failure-user@example.test");
  await page.fill("#authPassword", "test-password");
  await page.click("#authSubmitButton");
  await waitForAuth(page, "failed");

  await expect(page.locator("#authFeedback"))
    .toHaveText("登录失败，请检查邮箱和密码后重试。");
  await expect(page.locator("#authFeedback")).not.toContainText("AuthApiError");
  await expect(page.locator("#authFeedback")).not.toContainText("RPC");
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
  await expect(page.locator("#workspaceBlockedPanel")).toContainText("使用原账号登录");
  await expect(page.locator("#workspaceBlockedPanel")).toContainText("新的浏览器用户配置");
});
