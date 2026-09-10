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
    const REMOTE_CHANGES_KEY = "__lingoflowTestRemoteChanges";
    const callbacks = new Set();
    window.__productAuthCalls = {
      signUp: [],
      resend: [],
      verifyOtp: [],
      signIn: [],
      resetPassword: [],
      updateUser: []
    };
    window.__productAuthStates = [];
    window.__setProductAuthRemoteChanges = (ownerId, changes) => {
      const stored = JSON.parse(sessionStorage.getItem(REMOTE_CHANGES_KEY) || "{}");
      stored[ownerId] = structuredClone(changes);
      sessionStorage.setItem(REMOTE_CHANGES_KEY, JSON.stringify(stored));
    };
    const passwords = new Map();
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
    window.__productAuthBeginRecovery = email => {
      const ownerId = email.startsWith("beta-") ? ownerB : ownerA;
      const session = {
        access_token: `test-access-token:${ownerId}`,
        user: { id: ownerId, email }
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      notify("SIGNED_IN", session);
      notify("PASSWORD_RECOVERY", session);
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
      async resetPasswordForEmail(email, options) {
        window.__productAuthCalls.resetPassword.push({
          email,
          redirectOrigin: new URL(options.redirectTo).origin,
          redirectPath: new URL(options.redirectTo).pathname
        });
        if (email.startsWith("reset-rate-")) {
          return {
            data: null,
            error: {
              code: "over_email_send_rate_limit",
              status: 429,
              message: "AuthApiError: recovery email rate limit exceeded"
            }
          };
        }
        if (email.startsWith("reset-network-")) {
          throw new TypeError("Failed to fetch password recovery endpoint");
        }
        return { data: {}, error: null };
      },
      async updateUser(attributes) {
        window.__productAuthCalls.updateUser.push({ fields: Object.keys(attributes).sort() });
        const session = readSession();
        if (!session) {
          return {
            data: { user: null },
            error: { code: "session_not_found", status: 401, message: "JWT expired" }
          };
        }
        if (attributes.password === "weak-password") {
          return {
            data: { user: null },
            error: {
              code: "weak_password",
              reasons: ["characters"],
              message: "AuthApiError: Password should be stronger"
            }
          };
        }
        if (attributes.password === "same-password") {
          return {
            data: { user: null },
            error: {
              code: "same_password",
              message: "AuthApiError: New password should be different from the old password."
            }
          };
        }
        passwords.set(session.user.email, attributes.password);
        notify("USER_UPDATED", session);
        return { data: { user: session.user }, error: null };
      },
      async signInWithPassword({ email, password }) {
        window.__productAuthCalls.signIn.push({ email });
        const expectedPassword = passwords.get(email) || "test-password";
        if (email.startsWith("failure-") || password !== expectedPassword) {
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
        const authorization = options.headers?.Authorization ||
          options.headers?.authorization || "";
        const ownerId = String(authorization).split("test-access-token:")[1] || "";
        const stored = JSON.parse(sessionStorage.getItem(REMOTE_CHANGES_KEY) || "{}");
        const changes = Array.isArray(stored[ownerId]) ? stored[ownerId] : [];
        const cursorNumber = value => Number(String(value || "cursor:0").slice(7)) || 0;
        const after = body.p_after_cursor === null ? 0 : cursorNumber(body.p_after_cursor);
        const nextCursor = changes.reduce(
          (maximum, item) => Math.max(maximum, cursorNumber(item.cursor)),
          Number(localStorage.getItem(PUSH_COUNT_KEY) || 0)
        );
        return new Response(JSON.stringify({
          status: "ready",
          changes: changes.filter(item => cursorNumber(item.cursor) > after),
          nextCursor: `cursor:${nextCursor}`
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

async function signIn(page, email = "alpha@example.test", password = "test-password") {
  await openAccountModal(page);
  await page.click("#authSignInMode");
  await page.fill("#authEmail", email);
  await page.fill("#authPassword", password);
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

test("账号 Modal 仅在 pointer 起止都位于 backdrop 时关闭", async ({ page }) => {
  await page.goto("/");
  await waitForAuth(page, "signed-out");
  await openAccountModal(page);
  await page.fill("#authEmail", "selection@example.test");

  const inputBox = await page.locator("#authEmail").boundingBox();
  const modalCardBox = await page.locator("#authModal .modalCard").boundingBox();
  expect(inputBox).not.toBeNull();
  expect(modalCardBox).not.toBeNull();

  await page.mouse.move(inputBox.x + inputBox.width / 2, inputBox.y + inputBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(modalCardBox.x - 10, modalCardBox.y + modalCardBox.height / 2);
  await page.mouse.up();

  await expect(page.locator("#authModal")).toHaveClass(/show/);
  await expect(page.locator("#authEmail")).toHaveValue("selection@example.test");

  await page.mouse.click(modalCardBox.x - 10, modalCardBox.y + modalCardBox.height / 2);
  await expect(page.locator("#authModal")).not.toHaveClass(/show/);

  await openAccountModal(page);
  await page.click("#authModalClose");
  await expect(page.locator("#authModal")).not.toHaveClass(/show/);
});

test("共用 Modal backdrop 规则同样忽略从输入框开始的拖动", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => document.getElementById("favoritesModal").classList.add("show"));
  await page.fill("#favoriteFilterInput", "preserved filter");

  const inputBox = await page.locator("#favoriteFilterInput").boundingBox();
  const modalCardBox = await page.locator("#favoritesModal .modalCard").boundingBox();
  expect(inputBox).not.toBeNull();
  expect(modalCardBox).not.toBeNull();

  await page.mouse.move(inputBox.x + inputBox.width / 2, inputBox.y + inputBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(modalCardBox.x - 10, modalCardBox.y + modalCardBox.height / 2);
  await page.mouse.up();

  await expect(page.locator("#favoritesModal")).toHaveClass(/show/);
  await expect(page.locator("#favoriteFilterInput")).toHaveValue("preserved filter");

  await page.mouse.click(modalCardBox.x - 10, modalCardBox.y + modalCardBox.height / 2);
  await expect(page.locator("#favoritesModal")).not.toHaveClass(/show/);

  await page.evaluate(() => document.getElementById("favoritesModal").classList.add("show"));
  await page.keyboard.press("Escape");
  await expect(page.locator("#favoritesModal")).not.toHaveClass(/show/);
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
  await expect(page.locator("#authForgotPasswordButton")).toBeHidden();
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
  await expect(page.locator("#authForgotPasswordButton")).toBeVisible();

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
  await expect(page.locator("#authForgotPasswordButton")).toBeHidden();
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
  await expect(page.locator("#authForgotPasswordButton")).toBeVisible();
  await page.click("#authSignUpMode");
  await expect(confirmPasswordGroup).toBeVisible();
  await page.click("#authSignInMode");
  await expect(confirmPasswordGroup).toBeHidden();
});

test("忘记密码入口仅在登录显示，邮箱校验通过后发送正确 recovery redirect", async ({ page }) => {
  await page.goto("/");
  await openAccountModal(page);
  await expect(page.locator("#authForgotPasswordButton")).toBeVisible();
  await page.click("#authForgotPasswordButton");

  await expect(page.locator("#authResetRequestPanel")).toBeVisible();
  await expect(page.locator("#authModeTabs")).toBeHidden();
  await page.fill("#authResetEmail", "invalid-email");
  await page.click("#authResetRequestButton");
  await expect(page.locator("#authFeedback")).toHaveText("请输入有效的邮箱地址");
  expect(await page.evaluate(() => window.__productAuthCalls.resetPassword)).toEqual([]);

  await page.fill("#authResetEmail", "reset-user@example.test");
  await page.press("#authResetEmail", "Enter");
  await expect.poll(() => page.evaluate(() => (
    window.LingoFlowSupabaseAuth.getState().status
  ))).toBe("reset-email-sent");
  await expect(page.locator("#authFeedback"))
    .toHaveText("密码重置邮件已发送，请检查邮箱");
  await expect(page.locator("#authResetRequestTitle")).toHaveText("邮件已发送");

  const pageUrl = new URL(page.url());
  expect(await page.evaluate(() => window.__productAuthCalls.resetPassword)).toEqual([{
    email: "reset-user@example.test",
    redirectOrigin: pageUrl.origin,
    redirectPath: "/"
  }]);

  await page.click("#authResetReturnToSignInButton");
  await expect(page.locator("#authForm")).toBeVisible();
  await expect(page.locator("#authForgotPasswordButton")).toBeVisible();
  await expect(page.locator("#authEmail")).toHaveValue("reset-user@example.test");
});

test("密码重置邮件限流与网络错误只显示安全中文文案", async ({ page }) => {
  await page.goto("/");
  await openAccountModal(page);
  await page.click("#authForgotPasswordButton");
  await page.fill("#authResetEmail", "reset-rate-user@example.test");
  await page.click("#authResetRequestButton");

  await expect.poll(() => page.evaluate(() => {
    const state = window.LingoFlowSupabaseAuth.getState();
    return { status: state.status, reason: state.reason, errorCode: state.errorCode };
  })).toEqual({
    status: "reset-request",
    reason: "password-reset-request-failed",
    errorCode: "over_email_send_rate_limit"
  });
  await expect(page.locator("#authFeedback")).toHaveText("操作过于频繁，请稍后再试。");

  await page.fill("#authResetEmail", "reset-network-user@example.test");
  await page.click("#authResetRequestButton");
  await expect.poll(() => page.evaluate(() => (
    window.LingoFlowSupabaseAuth.getState().errorCode
  ))).toBe("network_error");
  await expect(page.locator("#authFeedback")).toHaveText("网络连接异常，请稍后重试。");
  await expect(page.locator("#authFeedback")).not.toContainText("AuthApiError");
  await expect(page.locator("#authFeedback")).not.toContainText("recovery");
});

test("失效恢复链接进入重新申请状态且不显示技术错误", async ({ page }) => {
  await page.goto("/#error=access_denied&error_code=otp_expired");
  await expect.poll(() => page.evaluate(() => (
    window.LingoFlowSupabaseAuth.getState().status
  ))).toBe("recovery-invalid");

  await expect(page.locator("#authModal")).toHaveClass(/show/);
  await expect(page.locator("#authResetRequestPanel")).toBeVisible();
  await expect(page.locator("#authResetRequestTitle")).toHaveText("重置链接已失效");
  await expect(page.locator("#authFeedback")).toHaveText("重置链接已失效，请重新申请。");
  await expect(page.locator("#authFeedback")).not.toContainText("otp_expired");
  await expect(page.locator("#authFeedback")).not.toContainText("token");
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

test("same_password 显示明确提示并保留新密码输入", async ({ page }) => {
  await page.goto("/");
  await signIn(page);
  await page.click("#authModalClose");
  await page.evaluate(() => window.__productAuthBeginRecovery("alpha@example.test"));
  await waitForAuth(page, "password-recovery");

  await page.fill("#authNewPassword", "same-password");
  await page.fill("#authNewPasswordConfirmation", "same-password");
  await page.click("#authUpdatePasswordButton");

  await expect.poll(() => page.evaluate(() => {
    const state = window.LingoFlowSupabaseAuth.getState();
    return { reason: state.reason, errorCode: state.errorCode };
  })).toEqual({
    reason: "password-update-failed",
    errorCode: "same_password"
  });
  await expect(page.locator("#authFeedback"))
    .toHaveText("新密码不能与原密码相同，请设置一个不同的密码。");
  await expect(page.locator("#authFeedback")).not.toContainText("暂时无法重置密码");
  await expect(page.locator("#authNewPassword")).toHaveValue("same-password");
  await expect(page.locator("#authNewPasswordConfirmation")).toHaveValue("same-password");
});

test("recovery session 更新密码后保持 owner、workspace 与本地数据并可重新登录", async ({ page }) => {
  await page.goto("/");
  await signIn(page);
  await waitForSync(page, "ready");
  const favorite = await createLocalFavorite(page, "password-recovery-data");
  await expect.poll(() => page.evaluate(() => (
    Number(localStorage.getItem("__lingoflowTestPushCount") || 0)
  ))).toBe(1);
  await page.evaluate(id => {
    window.LingoFlowFavoriteLearningRepository.setMastered(id, true);
  }, favorite.id);
  await expect.poll(() => page.evaluate(id => (
    window.LingoFlowFavoriteLearningRepository.get(id)?.mastered
  ), favorite.id)).toBe(true);

  const before = await page.evaluate(async id => ({
    favorite: window.LingoFlowFavoriteRepository.getById(id),
    learning: window.LingoFlowFavoriteLearningRepository.get(id),
    binding: await window.LingoFlowSyncStateRepository.getWorkspaceBinding(),
    pushes: Number(localStorage.getItem("__lingoflowTestPushCount") || 0)
  }), favorite.id);
  await page.click("#authModalClose");
  await page.evaluate(() => window.__productAuthBeginRecovery("alpha@example.test"));
  await waitForAuth(page, "password-recovery");

  await expect(page.locator("#authModal")).toHaveClass(/show/);
  await expect(page.locator("#authPasswordRecoveryPanel")).toBeVisible();
  await expect(page.locator("#authPasswordRecoveryPanel")).toContainText("设置新密码");
  const newPassword = page.locator("#authNewPassword");
  await newPassword.fill("new-test-password");
  await page.click("#authNewPasswordVisibility");
  await expect(newPassword).toHaveAttribute("type", "text");
  await expect(newPassword).toHaveValue("new-test-password");
  await page.click("#authNewPasswordVisibility");
  const newPasswordConfirmation = page.locator("#authNewPasswordConfirmation");
  await newPasswordConfirmation.fill("different-password");
  await page.click("#authNewPasswordConfirmationVisibility");
  await expect(newPasswordConfirmation).toHaveAttribute("type", "text");
  await expect(newPasswordConfirmation).toHaveValue("different-password");
  await page.click("#authNewPasswordConfirmationVisibility");
  await page.click("#authUpdatePasswordButton");
  await expect(page.locator("#authFeedback")).toHaveText("两次输入的密码不一致");
  expect(await page.evaluate(() => window.__productAuthCalls.updateUser)).toEqual([]);

  await page.fill("#authNewPassword", "weak-password");
  await page.fill("#authNewPasswordConfirmation", "weak-password");
  await page.click("#authUpdatePasswordButton");
  await expect.poll(() => page.evaluate(() => (
    window.LingoFlowSupabaseAuth.getState().reason
  ))).toBe("password-update-failed");
  await expect(page.locator("#authFeedback"))
    .toHaveText("密码需要包含更多种类的字符（如字母、数字或符号）。");
  await expect(page.locator("#authFeedback")).not.toContainText("AuthApiError");

  await page.fill("#authNewPassword", "new-test-password");
  await page.fill("#authNewPasswordConfirmation", "new-test-password");
  await page.press("#authNewPasswordConfirmation", "Enter");
  await waitForAuth(page, "authenticated");
  await waitForSync(page, "ready");
  await expect(page.locator("#authFeedback")).toHaveText("密码已更新");
  await expect(page.locator("#authPasswordUpdatedNotice")).toBeVisible();
  expect(await page.evaluate(() => window.__productAuthCalls.updateUser)).toEqual([
    { fields: ["password"] },
    { fields: ["password"] }
  ]);

  const after = await page.evaluate(async ({ id, password }) => ({
    favorite: window.LingoFlowFavoriteRepository.getById(id),
    learning: window.LingoFlowFavoriteLearningRepository.get(id),
    binding: await window.LingoFlowSyncStateRepository.getWorkspaceBinding(),
    pushes: Number(localStorage.getItem("__lingoflowTestPushCount") || 0),
    passwordStored: Object.values(localStorage).some(value => value.includes(password))
  }), { id: favorite.id, password: "new-test-password" });
  expect(after.favorite).toEqual(before.favorite);
  expect(after.learning).toEqual(before.learning);
  expect(after.binding).toEqual(before.binding);
  expect(after.binding.binding.ownerId).toBe(OWNER_A);
  expect(after.pushes).toBe(before.pushes);
  expect(after.passwordStored).toBe(false);

  await page.click("#authContinueAfterPasswordUpdate");
  await expect(page.locator("#authModal")).not.toHaveClass(/show/);
  await openAccountModal(page);
  await page.click("#authSignOutButton");
  await waitForAuth(page, "signed-out");
  await signIn(page, "alpha@example.test", "new-test-password");
  await waitForSync(page, "ready");
  const reloginBinding = await page.evaluate(async () => (
    await window.LingoFlowSyncStateRepository.getWorkspaceBinding()
  ));
  expect(reloginBinding).toEqual(before.binding);
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

test("账号冲突显示双方账号，使用原账号会退出当前账号并保留原 Workspace", async ({ page }) => {
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
  await expect(page.locator("#workspaceBlockedPanel"))
    .toContainText("此设备已关联另一个 LingoFlow 账号");
  await expect(page.locator("#workspaceCurrentAccountLabel"))
    .toHaveText("beta****ser@example.test");
  await expect(page.locator("#workspaceBoundAccountLabel"))
    .toHaveText("al****a@example.test");
  await expect(page.locator("#workspaceUseOriginalAccountButton")).toBeVisible();
  await expect(page.locator("#workspaceChooseCurrentAccountButton")).toBeVisible();
  await expect(page.locator("#workspaceBlockedPanel")).toContainText("新的浏览器用户配置");

  await page.click("#workspaceUseOriginalAccountButton");
  await waitForAuth(page, "signed-out");
  await waitForSync(page, "inactive", "auth-required");
  await expect(page.locator("#authEmail")).toHaveValue("alpha@example.test");
  const preserved = await page.evaluate(async id => ({
    favorite: window.LingoFlowFavoriteRepository.getById(id),
    binding: await window.LingoFlowSyncStateRepository.getWorkspaceBinding()
  }), favorite.id);
  expect(preserved.favorite.id).toBe(favorite.id);
  expect(preserved.binding.binding.ownerId).toBe(OWNER_A);
});

test("切换当前账号必须二次确认，取消不会修改任何本地数据", async ({ page }) => {
  await page.goto("/");
  await signIn(page);
  await waitForSync(page, "ready");
  const favorite = await createLocalFavorite(page, "cancel-switch");
  await page.evaluate(async () => {
    localStorage.setItem("EnglishReaderV052ReadingPrefs", JSON.stringify({ fontSize: 19 }));
    const db = await window.LingoFlowSyncStateRepository.openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("control", "readwrite");
      tx.objectStore("control").delete("workspace-account-label");
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("metadata delete aborted"));
    });
  });

  await openAccountModal(page);
  await page.click("#authSignOutButton");
  await waitForAuth(page, "signed-out");
  await signIn(page, "beta-user@example.test");
  await waitForSync(page, "blocked", "workspace-owner-mismatch");
  await expect(page.locator("#workspaceBoundAccountLabel"))
    .toHaveText("此前关联的账号（本地未保存邮箱信息）");
  const before = await page.evaluate(async id => ({
    favorite: window.LingoFlowFavoriteRepository.getById(id),
    preferences: localStorage.getItem("EnglishReaderV052ReadingPrefs"),
    binding: await window.LingoFlowSyncStateRepository.getWorkspaceBinding()
  }), favorite.id);

  await page.click("#workspaceChooseCurrentAccountButton");
  await expect(page.locator("#workspaceSwitchConfirmation")).toBeVisible();
  await expect(page.locator("#workspaceSwitchConfirmation"))
    .toContainText("目前只有收藏和学习状态支持从当前账号云端恢复");
  await expect(page.locator("#workspaceSwitchConfirmation"))
    .toContainText("文章、阅读进度、查询记录和阅读偏好不会自动从云端恢复");
  await expect(page.locator("#workspaceBackupAndSwitchButton")).toBeVisible();
  await expect(page.locator("#workspaceDirectSwitchButton")).toBeVisible();
  await page.click("#workspaceCancelSwitchButton");
  await expect(page.locator("#workspaceConflictDecision")).toBeVisible();

  const after = await page.evaluate(async id => ({
    favorite: window.LingoFlowFavoriteRepository.getById(id),
    preferences: localStorage.getItem("EnglishReaderV052ReadingPrefs"),
    binding: await window.LingoFlowSyncStateRepository.getWorkspaceBinding()
  }), favorite.id);
  expect(after).toEqual(before);
});

test("直接切换会精确清理 A 用户资产和同步状态，保留词典与 deviceId，并恢复 B 云端数据", async ({ page }) => {
  await page.goto("/");
  await signIn(page);
  await waitForSync(page, "ready");
  await page.evaluate(() => {
    localStorage.setItem("__lingoflowTestOffline", "1");
  });
  const favorite = await createLocalFavorite(page, "owner-a-pending");
  await page.evaluate(async id => {
    await window.LingoFlowFavoriteAppSync.setMastered(id, true);
    await window.LingoFlowArticleLibrary.createArticle({
      title: "Account A article",
      content: "This local article must not cross the account boundary.",
      sourceType: "paste"
    });
    localStorage.setItem("EnglishReaderV051Favorites", JSON.stringify({ legacy: true }));
    localStorage.setItem("EnglishReaderV05Vocab", JSON.stringify({ legacyWord: 1 }));
    localStorage.setItem("EnglishReaderV052QueryEvents", JSON.stringify([{ id: "query:a" }]));
    localStorage.setItem("EnglishReaderV052HistoryBaselines", JSON.stringify({ old: 3 }));
    localStorage.setItem(
      "EnglishReaderV052HistoryMigrationState",
      JSON.stringify({ version: 1, status: "completed" })
    );
    localStorage.setItem("EnglishReaderV052ReadingPrefs", JSON.stringify({ fontSize: 21 }));
    localStorage.setItem("EnglishReaderV052DeviceId", "device:preserved");
    await setECDICTMeta("account-switch-public-resource", "preserved");
  }, favorite.id);
  await expect.poll(() => page.evaluate(async () => {
    const binding = await window.LingoFlowSyncStateRepository.getWorkspaceBinding();
    const outbox = await window.LingoFlowSyncStateRepository.listOutbox({
      ownerId: binding.binding.ownerId
    });
    return outbox.items.length;
  })).toBeGreaterThanOrEqual(2);
  const pushesBefore = await page.evaluate(() => (
    Number(localStorage.getItem("__lingoflowTestPushCount") || 0)
  ));

  await openAccountModal(page);
  await page.click("#authSignOutButton");
  await waitForAuth(page, "signed-out");
  await signIn(page, "beta-user@example.test");
  await waitForSync(page, "blocked", "workspace-owner-mismatch");
  await page.evaluate(ownerB => {
    const favoriteId = "favorite:owner-b-cloud";
    const timestamp = "2026-09-10T00:00:00.000Z";
    const remoteFavorite = {
      id: favoriteId,
      type: "word",
      text: "beta-cloud",
      meaning: "Account B cloud favorite",
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null
    };
    const remoteLearning = {
      favoriteId,
      mastered: true,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null
    };
    window.__setProductAuthRemoteChanges(ownerB, [
      {
        cursor: "cursor:1",
        entityType: "favorites",
        entityId: favoriteId,
        scope: "record",
        schemaVersion: "1",
        revision: "revision:1",
        operation: "put",
        payload: remoteFavorite
      },
      {
        cursor: "cursor:2",
        entityType: "favoriteLearningStates",
        entityId: favoriteId,
        scope: "record",
        schemaVersion: "1",
        revision: "revision:2",
        operation: "put",
        payload: remoteLearning
      }
    ]);
    localStorage.removeItem("__lingoflowTestOffline");
  }, OWNER_B);

  await page.click("#workspaceChooseCurrentAccountButton");
  const navigated = page.waitForEvent("framenavigated", frame => frame === page.mainFrame());
  await page.click("#workspaceDirectSwitchButton");
  await navigated;
  await waitForAuth(page, "authenticated");
  await waitForSync(page, "ready");
  await expect.poll(() => page.evaluate(() => (
    window.LingoFlowFavoriteAppSync.getState().syncStatus
  ))).toBe("synced");

  const result = await page.evaluate(async ({ oldFavoriteId, ownerA, cloudFavoriteId }) => {
    const binding = await window.LingoFlowSyncStateRepository.getWorkspaceBinding();
    const metadata = await window.LingoFlowSyncStateRepository.getWorkspaceAccountLabel();
    const syncDatabase = await window.LingoFlowSyncStateRepository.openDatabase();
    const syncStores = ["control", "entitySidecars", "outbox", "syncIssues", "inbox"];
    const syncTransaction = syncDatabase.transaction(syncStores, "readonly");
    const syncRecords = await Promise.all(syncStores.map(storeName => new Promise(
      (resolve, reject) => {
        const request = syncTransaction.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      }
    )));
    return {
      binding,
      metadata,
      oldFavorite: window.LingoFlowFavoriteRepository.getById(oldFavoriteId, {
        includeDeleted: true
      }),
      oldLearning: window.LingoFlowFavoriteLearningRepository.get(oldFavoriteId, {
        includeDeleted: true
      }),
      cloudFavorite: window.LingoFlowFavoriteRepository.getById(cloudFavoriteId),
      cloudLearning: window.LingoFlowFavoriteLearningRepository.get(cloudFavoriteId),
      articles: await window.LingoFlowArticleLibrary.listArticles({ includeDeleted: true }),
      oldOutbox: await window.LingoFlowSyncStateRepository.listOutbox({ ownerId: ownerA }),
      oldSyncRecordCount: syncRecords.flat().filter(item => item.ownerId === ownerA).length,
      oldStorage: [
        "EnglishReaderV051Favorites",
        "EnglishReaderV05Vocab",
        "EnglishReaderV052QueryEvents",
        "EnglishReaderV052HistoryBaselines",
        "EnglishReaderV052HistoryMigrationState",
        "EnglishReaderV052ReadingPrefs"
      ].map(key => localStorage.getItem(key)),
      deviceId: localStorage.getItem("EnglishReaderV052DeviceId"),
      dictionaryMeta: await getECDICTMeta("account-switch-public-resource"),
      pushes: Number(localStorage.getItem("__lingoflowTestPushCount") || 0)
    };
  }, {
    oldFavoriteId: favorite.id,
    ownerA: OWNER_A,
    cloudFavoriteId: "favorite:owner-b-cloud"
  });
  expect(result.binding).toMatchObject({ status: "ready", binding: { ownerId: OWNER_B } });
  expect(result.metadata).toMatchObject({
    status: "ready",
    metadata: { ownerId: OWNER_B, label: "beta-user@example.test" }
  });
  expect(result.oldFavorite).toBeNull();
  expect(result.oldLearning).toBeNull();
  expect(result.articles).toEqual([]);
  expect(result.oldOutbox.items).toEqual([]);
  expect(result.oldSyncRecordCount).toBe(0);
  expect(result.oldStorage).toEqual([
    null,
    null,
    null,
    null,
    JSON.stringify({ version: 1, status: "completed" }),
    null
  ]);
  expect(result.deviceId).toBe("device:preserved");
  expect(result.dictionaryMeta).toEqual({
    key: "account-switch-public-resource",
    value: "preserved"
  });
  expect(result.pushes).toBe(pushesBefore);
  expect(result.cloudFavorite).toMatchObject({ id: "favorite:owner-b-cloud" });
  expect(result.cloudLearning).toMatchObject({
    favoriteId: "favorite:owner-b-cloud",
    mastered: true
  });
});

test("导出备份并切换会先下载 Backup v2，再建立当前账号 Workspace", async ({ page }) => {
  await page.goto("/");
  await signIn(page);
  await waitForSync(page, "ready");
  const favorite = await createLocalFavorite(page, "backup-before-switch");
  await expect.poll(() => page.evaluate(() => (
    window.LingoFlowFavoriteAppSync.getState().syncStatus
  ))).toBe("synced");
  await page.evaluate(async () => {
    await window.LingoFlowArticleLibrary.createArticle({
      title: "Backup-first article",
      content: "This article must be present in the exported backup.",
      sourceType: "paste"
    });
  });
  await openAccountModal(page);
  await page.click("#authSignOutButton");
  await waitForAuth(page, "signed-out");
  await signIn(page, "beta-user@example.test");
  await waitForSync(page, "blocked", "workspace-owner-mismatch");
  await page.click("#workspaceChooseCurrentAccountButton");

  const downloadPromise = page.waitForEvent("download");
  const navigated = page.waitForEvent("framenavigated", frame => frame === page.mainFrame());
  await page.click("#workspaceBackupAndSwitchButton");
  const download = await downloadPromise;
  await navigated;
  expect(download.suggestedFilename()).toMatch(/^lingoflow-backup-\d{4}-\d{2}-\d{2}\.json$/);
  await waitForAuth(page, "authenticated");
  await waitForSync(page, "ready");
  const result = await page.evaluate(async id => ({
    binding: await window.LingoFlowSyncStateRepository.getWorkspaceBinding(),
    oldFavorite: window.LingoFlowFavoriteRepository.getById(id, { includeDeleted: true }),
    articles: await window.LingoFlowArticleLibrary.listArticles({ includeDeleted: true })
  }), favorite.id);
  expect(result.binding.binding.ownerId).toBe(OWNER_B);
  expect(result.oldFavorite).toBeNull();
  expect(result.articles).toEqual([]);
});

test("切换事务失败会回滚本地用户资产，并保持 Account A binding", async ({ page }) => {
  await page.goto("/");
  await signIn(page);
  await waitForSync(page, "ready");
  const favorite = await createLocalFavorite(page, "rollback-switch");
  const article = await page.evaluate(async () => {
    localStorage.setItem("EnglishReaderV052ReadingPrefs", JSON.stringify({ lineHeight: 2 }));
    return await window.LingoFlowArticleLibrary.createArticle({
      title: "Rollback article",
      content: "The article and binding must survive a failed switch.",
      sourceType: "paste"
    });
  });
  await openAccountModal(page);
  await page.click("#authSignOutButton");
  await waitForAuth(page, "signed-out");
  await signIn(page, "beta-user@example.test");
  await waitForSync(page, "blocked", "workspace-owner-mismatch");
  await page.evaluate(() => {
    const originalClear = IDBObjectStore.prototype.clear;
    window.__restoreAccountSwitchClear = () => {
      IDBObjectStore.prototype.clear = originalClear;
    };
    IDBObjectStore.prototype.clear = function(...args) {
      if (this.name === "control") throw new Error("simulated sync replacement failure");
      return originalClear.apply(this, args);
    };
  });
  await page.click("#workspaceChooseCurrentAccountButton");
  await page.click("#workspaceDirectSwitchButton");
  await expect(page.locator("#authFeedback"))
    .toHaveText("账号切换未完成，原 Workspace 关联已保留。请稍后重试。");
  await page.evaluate(() => window.__restoreAccountSwitchClear());

  const result = await page.evaluate(async ({ favoriteId, articleId }) => ({
    binding: await window.LingoFlowSyncStateRepository.getWorkspaceBinding(),
    favorite: window.LingoFlowFavoriteRepository.getById(favoriteId),
    article: await window.LingoFlowArticleLibrary.getArticle(articleId),
    preferences: localStorage.getItem("EnglishReaderV052ReadingPrefs")
  }), { favoriteId: favorite.id, articleId: article.id });
  expect(result.binding.binding.ownerId).toBe(OWNER_A);
  expect(result.favorite.id).toBe(favorite.id);
  expect(result.article.id).toBe(article.id);
  expect(result.preferences).toBe(JSON.stringify({ lineHeight: 2 }));
  await waitForSync(page, "blocked", "workspace-owner-mismatch");
});
