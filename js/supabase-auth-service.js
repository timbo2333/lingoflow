(function() {
  "use strict";

  const AUTH_REQUESTED_KEY = "lingoflowSupabaseAuthRequested";
  const SDK_TIMEOUT_MS = 15000;
  const MIN_PASSWORD_LENGTH = 6;
  let client = null;
  let clientPromise = null;
  let initializePromise = null;
  let recoverySessionActive = false;
  let state = Object.freeze({ status: "signed-out", reason: "not-signed-in" });

  function isOpaqueString(value) {
    return typeof value === "string" && Boolean(value.trim()) && value === value.trim();
  }

  function publicUser(user) {
    return user && isOpaqueString(user.id) ? {
      id: user.id,
      email: typeof user.email === "string" ? user.email : ""
    } : null;
  }

  function setState(next) {
    state = Object.freeze({ ...next });
    window.dispatchEvent(new CustomEvent("lingoflow:auth-state", {
      detail: { ...state }
    }));
    return { ...state };
  }

  function getState() {
    return { ...state };
  }

  function getConfig() {
    const config = window.LingoFlowSupabaseConfig;
    if (!config || !isOpaqueString(config.projectUrl) ||
        !isOpaqueString(config.publishableKey) ||
        !config.publishableKey.startsWith("sb_publishable_") ||
        !isOpaqueString(config.sdkUrl)) {
      return null;
    }
    return config;
  }

  function authCallbackPresent() {
    const search = new URLSearchParams(window.location.search);
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    return search.has("code") || search.has("token_hash") ||
      hash.has("access_token") || hash.has("refresh_token") || hash.has("error");
  }

  function authCallbackFailed() {
    const search = new URLSearchParams(window.location.search);
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    return search.has("error") || search.has("error_code") ||
      hash.has("error") || hash.has("error_code");
  }

  function authWasRequested() {
    return localStorage.getItem(AUTH_REQUESTED_KEY) === "1" || authCallbackPresent();
  }

  function markAuthRequested() {
    localStorage.setItem(AUTH_REQUESTED_KEY, "1");
  }

  function loadSdk(config) {
    if (window.supabase && typeof window.supabase.createClient === "function") {
      return Promise.resolve(window.supabase);
    }
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const timer = setTimeout(() => {
        script.remove();
        reject(new Error("Supabase Auth SDK 加载超时。"));
      }, SDK_TIMEOUT_MS);
      script.src = config.sdkUrl;
      script.async = true;
      script.crossOrigin = "anonymous";
      script.onload = () => {
        clearTimeout(timer);
        if (window.supabase && typeof window.supabase.createClient === "function") {
          resolve(window.supabase);
        } else {
          reject(new Error("Supabase Auth SDK 不可用。"));
        }
      };
      script.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Supabase Auth SDK 加载失败。"));
      };
      document.head.appendChild(script);
    });
  }

  async function ensureClient(options = {}) {
    const config = getConfig();
    if (!config) throw new Error("Supabase 公开客户端配置不可用。");
    if (options.markRequested) markAuthRequested();
    if (client) return client;
    if (clientPromise) return await clientPromise;

    clientPromise = (async () => {
      const sdk = await loadSdk(config);
      const created = sdk.createClient(config.projectUrl, config.publishableKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true
        }
      });
      if (!created?.auth || typeof created.auth.getSession !== "function" ||
          typeof created.auth.getUser !== "function" ||
          typeof created.auth.onAuthStateChange !== "function") {
        throw new Error("Supabase Auth client 不完整。");
      }
      created.auth.onAuthStateChange((event, session) => {
        if (event === "PASSWORD_RECOVERY") {
          const user = publicUser(session?.user);
          if (!user) {
            recoverySessionActive = false;
            setState({
              status: "recovery-invalid",
              reason: "recovery-link-invalid",
              message: "重置链接已失效，请重新申请。"
            });
            return;
          }
          recoverySessionActive = true;
          markAuthRequested();
          setState({ status: "password-recovery", reason: "recovery-session", user });
          return;
        }
        if (event === "SIGNED_OUT") {
          recoverySessionActive = false;
          setState({ status: "signed-out", reason: "signed-out" });
          return;
        }
        if (session?.user?.id) {
          if (recoverySessionActive) {
            setState({
              status: "password-recovery",
              reason: state.status === "password-recovery" ? state.reason : "recovery-session",
              user: publicUser(session.user)
            });
            return;
          }
          const verifyingOtp = state.status === "verifying";
          setState({
            status: verifyingOtp ? "verifying" : "authenticating",
            reason: verifyingOtp ? "verifying-otp" : "validating-session",
            ...(verifyingOtp && state.email ? { email: state.email } : {})
          });
          queueMicrotask(() => {
            void refreshAuthenticatedState().catch(() => {});
          });
          return;
        }
        if (event === "INITIAL_SESSION") {
          if ([
            "confirmation-required",
            "otp-required",
            "verifying",
            "reset-request",
            "reset-requesting",
            "reset-email-sent",
            "recovery-invalid"
          ].includes(state.status)) {
            return;
          }
          setState({ status: "signed-out", reason: "not-signed-in" });
        }
      });
      client = created;
      return created;
    })();

    try {
      return await clientPromise;
    } finally {
      clientPromise = null;
    }
  }

  function authFailure(reason, error) {
    return setState({
      status: "paused",
      reason,
      message: error?.message || "Auth 暂时不可用。"
    });
  }

  async function readVerifiedSession() {
    const activeClient = await ensureClient();
    let sessionResult;
    try {
      sessionResult = await activeClient.auth.getSession();
    } catch (error) {
      return { status: "paused", reason: "session-read-failed", error };
    }
    if (sessionResult?.error) {
      return { status: "paused", reason: "session-read-failed", error: sessionResult.error };
    }
    const session = sessionResult?.data?.session || null;
    if (!session) return { status: "signed-out", reason: "not-signed-in" };

    let userResult;
    try {
      userResult = await activeClient.auth.getUser();
    } catch (error) {
      return { status: "paused", reason: "auth-network-unavailable", error };
    }
    if (userResult?.error || !isOpaqueString(userResult?.data?.user?.id)) {
      return {
        status: "paused",
        reason: "authenticated-user-unavailable",
        error: userResult?.error || new Error("Authenticated user 不可用。")
      };
    }
    if (!isOpaqueString(session.access_token)) {
      return {
        status: "paused",
        reason: "access-token-unavailable",
        error: new Error("Access token 不可用。")
      };
    }
    return {
      status: "ready",
      user: publicUser(userResult.data.user),
      session
    };
  }

  async function refreshAuthenticatedState() {
    let verified;
    try {
      verified = await readVerifiedSession();
    } catch (error) {
      return authFailure("auth-client-unavailable", error);
    }
    if (verified.status === "signed-out") {
      return setState({ status: "signed-out", reason: verified.reason });
    }
    if (verified.status !== "ready") return authFailure(verified.reason, verified.error);
    if (recoverySessionActive) {
      return setState({
        status: "password-recovery",
        reason: state.status === "password-recovery" ? state.reason : "recovery-session",
        user: verified.user
      });
    }
    return setState({ status: "authenticated", user: verified.user });
  }

  async function initialize() {
    if (initializePromise) return await initializePromise;
    if (!getConfig()) {
      return setState({ status: "unavailable", reason: "public-config-unavailable" });
    }
    if (!authWasRequested()) {
      return setState({ status: "signed-out", reason: "not-signed-in" });
    }
    if (authCallbackFailed()) {
      recoverySessionActive = false;
      return setState({
        status: "recovery-invalid",
        reason: "recovery-link-invalid",
        message: "重置链接已失效，请重新申请。"
      });
    }

    initializePromise = (async () => {
      setState({ status: "authenticating", reason: "restoring-session" });
      return await refreshAuthenticatedState();
    })();
    try {
      return await initializePromise;
    } finally {
      initializePromise = null;
    }
  }

  function validationError(message) {
    const error = new Error(message);
    error.code = "validation_failed";
    return error;
  }

  function normalizeEmail(value) {
    const email = String(value || "").trim();
    const parts = email.split("@");
    if (!email || parts.length !== 2 || !parts[0] || !parts[1] || /\s/.test(email)) {
      throw validationError("请输入有效邮箱地址。");
    }
    return email;
  }

  function normalizeCredentials(value) {
    const email = normalizeEmail(value?.email);
    const password = normalizePassword(value?.password);
    return { email, password };
  }

  function normalizePassword(value) {
    const password = String(value || "");
    if (!password) throw validationError("请输入密码。");
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw validationError(`密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符。`);
    }
    return password;
  }

  function normalizeEmailOtp(value) {
    const token = String(value || "");
    if (!/^\d{6,10}$/.test(token)) {
      throw validationError("请输入 6–10 位数字验证码。");
    }
    return token;
  }

  function normalizedErrorCode(error) {
    const code = typeof error?.code === "string" ? error.code.trim().toLowerCase() : "";
    if (code) return code;
    const name = typeof error?.name === "string" ? error.name.trim().toLowerCase() : "";
    if (error instanceof TypeError ||
        ["authretryablefetcherror", "fetcherror", "networkerror"].includes(name) ||
        error?.originalError instanceof TypeError) {
      return "network_error";
    }
    return "unknown_error";
  }

  function isRateLimitError(error, code) {
    return Number(error?.status) === 429 ||
      code.includes("rate_limit") ||
      code === "over_request_rate_limit" ||
      code === "over_email_send_rate_limit";
  }

  function weakPasswordMessage(error) {
    const reasons = Array.isArray(error?.reasons) ? new Set(error.reasons) : new Set();
    const guidance = [];
    if (reasons.has("length")) {
      guidance.push(`密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符`);
    }
    if (reasons.has("characters")) {
      guidance.push("密码需要包含更多种类的字符（如字母、数字或符号）");
    }
    if (reasons.has("pwned")) {
      guidance.push("这个密码过于常见或已泄露，请更换一个密码");
    }
    return guidance.length > 0
      ? `${guidance.join("；")}。`
      : `密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符。`;
  }

  function mapAuthError(operation, error) {
    const errorCode = normalizedErrorCode(error);
    if (isRateLimitError(error, errorCode)) {
      return {
        errorCode,
        message: "操作过于频繁，请稍后再试。"
      };
    }
    if (errorCode === "validation_failed") {
      const validationMessage = {
        "request-password-reset": "请输入有效的邮箱地址",
        "update-password": error?.message || `密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符。`
      };
      return {
        errorCode,
        message: validationMessage[operation] || (operation === "verify"
          ? "请输入 6–10 位数字验证码。"
          : "请检查邮箱或密码格式。")
      };
    }
    if (errorCode === "weak_password") {
      return {
        errorCode,
        message: weakPasswordMessage(error)
      };
    }
    if (operation === "update-password" && errorCode === "same_password") {
      return {
        errorCode,
        message: "新密码不能与原密码相同，请设置一个不同的密码。"
      };
    }
    if (["network_error", "network_request_failed", "fetch_failed"].includes(errorCode)) {
      return {
        errorCode,
        message: "网络连接异常，请稍后重试。"
      };
    }
    if (operation === "sign-in" && errorCode === "email_not_confirmed") {
      return {
        errorCode,
        message: "邮箱尚未验证，请先完成验证码验证。"
      };
    }
    if (operation === "sign-in" && errorCode === "invalid_credentials") {
      return {
        errorCode,
        message: "登录失败，请检查邮箱和密码后重试。"
      };
    }
    if (operation === "verify" && [
      "otp_expired",
      "token_expired",
      "invalid_otp",
      "bad_code_verifier"
    ].includes(errorCode)) {
      return {
        errorCode,
        message: "验证码不正确或已过期，请重新输入。"
      };
    }
    if (operation === "update-password" && (
      Number(error?.status) === 401 || Number(error?.status) === 403 || [
        "bad_jwt",
        "jwt_expired",
        "refresh_token_not_found",
        "session_not_found",
        "token_expired"
      ].includes(errorCode)
    )) {
      return {
        errorCode,
        message: "重置链接已失效，请重新申请。"
      };
    }
    const fallback = {
      "sign-up": "注册暂时无法完成，请稍后重试。",
      "sign-in": "登录暂时无法完成，请稍后重试。",
      resend: "暂时无法重新发送验证码，请稍后重试。",
      verify: "邮箱验证暂时无法完成，请稍后重试。",
      "request-password-reset": "暂时无法重置密码，请稍后再试。",
      "update-password": "暂时无法重置密码，请稍后再试。",
      "sign-out": "退出登录失败，请检查网络后重试。"
    };
    return {
      errorCode,
      message: fallback[operation] || "账号操作暂时无法完成，请稍后重试。"
    };
  }

  function getPasswordPolicy() {
    return Object.freeze({
      minimumLength: MIN_PASSWORD_LENGTH,
      message: `密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符。`
    });
  }

  function emailRedirectTo() {
    return `${window.location.origin}${window.location.pathname}`;
  }

  async function signUp(value) {
    let credentials;
    try {
      credentials = normalizeCredentials(value);
      setState({ status: "authenticating", reason: "signing-up" });
      const activeClient = await ensureClient({ markRequested: true });
      const result = await activeClient.auth.signUp({
        ...credentials,
        options: { emailRedirectTo: emailRedirectTo() }
      });
      if (result?.error) throw result.error;
      const user = publicUser(result?.data?.user);
      if (!result?.data?.session) {
        if (!user) {
          const error = new Error("Sign-up response did not include a user.");
          error.code = "unexpected_response";
          throw error;
        }
        return setState({
          status: "otp-required",
          reason: "otp-sent",
          email: user.email || credentials.email
        });
      }
      return await refreshAuthenticatedState();
    } catch (error) {
      const mapped = mapAuthError("sign-up", error);
      return setState({
        status: "failed",
        reason: "sign-up-failed",
        ...mapped
      });
    }
  }

  async function resendSignUpConfirmation(value) {
    let email = "";
    try {
      email = normalizeEmail(value?.email);
      setState({
        status: "otp-required",
        reason: "resending-otp",
        email
      });
      const activeClient = await ensureClient({ markRequested: true });
      if (typeof activeClient.auth.resend !== "function") {
        const error = new Error("Auth resend is unavailable.");
        error.code = "unsupported_operation";
        throw error;
      }
      const result = await activeClient.auth.resend({
        type: "signup",
        email,
        options: { emailRedirectTo: emailRedirectTo() }
      });
      if (result?.error) throw result.error;
      return setState({
        status: "otp-required",
        reason: "otp-resent",
        email
      });
    } catch (error) {
      const mapped = mapAuthError("resend", error);
      return setState({
        status: "otp-required",
        reason: "resend-failed",
        email,
        ...mapped
      });
    }
  }

  async function verifySignUpOtp(value) {
    let email = "";
    try {
      email = normalizeEmail(value?.email);
      const token = normalizeEmailOtp(value?.token);
      setState({ status: "verifying", reason: "verifying-otp", email });
      const activeClient = await ensureClient({ markRequested: true });
      if (typeof activeClient.auth.verifyOtp !== "function") {
        const error = new Error("Auth OTP verification is unavailable.");
        error.code = "unsupported_operation";
        throw error;
      }
      const result = await activeClient.auth.verifyOtp({
        email,
        token,
        type: "email"
      });
      if (result?.error) throw result.error;
      const session = result?.data?.session || null;
      const user = publicUser(result?.data?.user || session?.user);
      if (!session || !isOpaqueString(session.access_token) || !user) {
        const error = new Error("OTP verification response did not include a session.");
        error.code = "unexpected_response";
        throw error;
      }
      const verified = await readVerifiedSession();
      if (verified.status !== "ready") {
        const error = new Error("Verified session is unavailable.");
        error.code = ["session-read-failed", "auth-network-unavailable"].includes(verified.reason)
          ? "network_error"
          : "unexpected_response";
        throw error;
      }
      return setState({
        status: "authenticated",
        reason: "email-verified",
        user: verified.user
      });
    } catch (error) {
      const mapped = mapAuthError("verify", error);
      return setState({
        status: "otp-required",
        reason: "otp-verification-failed",
        email,
        ...mapped
      });
    }
  }

  async function signIn(value) {
    let credentials;
    try {
      credentials = normalizeCredentials(value);
      setState({ status: "authenticating", reason: "signing-in" });
      const activeClient = await ensureClient({ markRequested: true });
      const result = await activeClient.auth.signInWithPassword(credentials);
      if (result?.error) throw result.error;
      return await refreshAuthenticatedState();
    } catch (error) {
      const mapped = mapAuthError("sign-in", error);
      return setState({
        status: "failed",
        reason: "sign-in-failed",
        ...mapped
      });
    }
  }

  function beginPasswordResetRequest(value = {}) {
    const email = typeof value.email === "string" ? value.email.trim() : "";
    return setState({
      status: "reset-request",
      reason: "password-reset-request",
      ...(email ? { email } : {})
    });
  }

  function cancelPasswordResetRequest() {
    if ([
      "reset-request",
      "reset-requesting",
      "reset-email-sent",
      "recovery-invalid"
    ].includes(state.status)) {
      return setState({ status: "signed-out", reason: "not-signed-in" });
    }
    return getState();
  }

  async function requestPasswordReset(value) {
    let email = "";
    try {
      email = normalizeEmail(value?.email);
      setState({ status: "reset-requesting", reason: "sending-password-reset", email });
      const activeClient = await ensureClient({ markRequested: true });
      if (typeof activeClient.auth.resetPasswordForEmail !== "function") {
        const error = new Error("Password reset request is unavailable.");
        error.code = "unsupported_operation";
        throw error;
      }
      const result = await activeClient.auth.resetPasswordForEmail(email, {
        redirectTo: emailRedirectTo()
      });
      if (result?.error) throw result.error;
      return setState({
        status: "reset-email-sent",
        reason: "password-reset-email-sent",
        email
      });
    } catch (error) {
      const mapped = mapAuthError("request-password-reset", error);
      return setState({
        status: "reset-request",
        reason: "password-reset-request-failed",
        ...(email ? { email } : {}),
        ...mapped
      });
    }
  }

  async function updatePassword(value) {
    const recoveryUser = publicUser(state.user);
    try {
      if (!recoverySessionActive || state.status !== "password-recovery" || !recoveryUser) {
        const error = new Error("Password recovery session is unavailable.");
        error.code = "session_not_found";
        throw error;
      }
      const password = normalizePassword(value?.password);
      setState({
        status: "password-recovery",
        reason: "updating-password",
        user: recoveryUser
      });
      const activeClient = await ensureClient({ markRequested: true });
      if (typeof activeClient.auth.updateUser !== "function") {
        const error = new Error("Password update is unavailable.");
        error.code = "unsupported_operation";
        throw error;
      }
      const result = await activeClient.auth.updateUser({ password });
      if (result?.error) throw result.error;
      const updatedUser = publicUser(result?.data?.user);
      if (updatedUser && updatedUser.id !== recoveryUser.id) {
        const error = new Error("Authenticated owner changed during password update.");
        error.code = "authenticated_owner_mismatch";
        throw error;
      }
      const verified = await readVerifiedSession();
      if (verified.status !== "ready" || verified.user.id !== recoveryUser.id) {
        const error = new Error("Updated password session is unavailable.");
        error.code = verified.status === "paused" ? "network_error" : "session_not_found";
        throw error;
      }
      recoverySessionActive = false;
      return setState({
        status: "authenticated",
        reason: "password-updated",
        user: verified.user
      });
    } catch (error) {
      const mapped = mapAuthError("update-password", error);
      const linkInvalid = mapped.message === "重置链接已失效，请重新申请。";
      if (linkInvalid) recoverySessionActive = false;
      return setState({
        status: linkInvalid ? "recovery-invalid" : "password-recovery",
        reason: linkInvalid ? "recovery-link-invalid" : "password-update-failed",
        ...(recoveryUser ? { user: recoveryUser } : {}),
        ...mapped
      });
    }
  }

  async function signOut() {
    try {
      const activeClient = await ensureClient({ markRequested: true });
      const result = await activeClient.auth.signOut({ scope: "local" });
      if (result?.error) throw result.error;
      return setState({ status: "signed-out", reason: "signed-out" });
    } catch (error) {
      const mapped = mapAuthError("sign-out", error);
      return setState({
        status: "failed",
        reason: "sign-out-failed",
        ...mapped
      });
    }
  }

  async function getSessionContext() {
    if (!authWasRequested()) return { status: "signed-out", reason: "not-signed-in" };
    let verified;
    try {
      verified = await readVerifiedSession();
    } catch (error) {
      return { status: "paused", reason: "auth-client-unavailable", message: error.message };
    }
    if (verified.status !== "ready") {
      return {
        status: verified.status,
        reason: verified.reason,
        ...(verified.error?.message ? { message: verified.error.message } : {})
      };
    }
    return { status: "ready", user: verified.user };
  }

  async function getAccessToken() {
    if (!authWasRequested()) return null;
    try {
      const activeClient = await ensureClient();
      const result = await activeClient.auth.getSession();
      return isOpaqueString(result?.data?.session?.access_token)
        ? result.data.session.access_token
        : null;
    } catch {
      return null;
    }
  }

  async function getPublicClient() {
    return await ensureClient();
  }

  window.LingoFlowSupabaseAuth = Object.freeze({
    initialize,
    getState,
    getPasswordPolicy,
    signUp,
    resendSignUpConfirmation,
    verifySignUpOtp,
    signIn,
    beginPasswordResetRequest,
    cancelPasswordResetRequest,
    requestPasswordReset,
    updatePassword,
    signOut,
    getSessionContext,
    getAccessToken,
    getPublicClient
  });
})();
