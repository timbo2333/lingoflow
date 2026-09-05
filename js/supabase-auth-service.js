(function() {
  "use strict";

  const AUTH_REQUESTED_KEY = "lingoflowSupabaseAuthRequested";
  const SDK_TIMEOUT_MS = 15000;
  let client = null;
  let clientPromise = null;
  let initializePromise = null;
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
        if (event === "SIGNED_OUT") {
          setState({ status: "signed-out", reason: "signed-out" });
          return;
        }
        if (session?.user?.id) {
          setState({ status: "authenticating", reason: "validating-session" });
          queueMicrotask(() => {
            void refreshAuthenticatedState().catch(() => {});
          });
          return;
        }
        if (event === "INITIAL_SESSION") {
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

  function normalizeCredentials(value) {
    const email = String(value?.email || "").trim();
    const password = String(value?.password || "");
    if (!email || !email.includes("@")) throw new Error("请输入有效邮箱。");
    if (password.length < 6) throw new Error("密码至少需要 6 个字符。");
    return { email, password };
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
      if (!result?.data?.session) {
        return setState({
          status: "confirmation-required",
          reason: "check-email"
        });
      }
      return await refreshAuthenticatedState();
    } catch (error) {
      return setState({
        status: "failed",
        reason: "sign-up-failed",
        message: error?.message || "注册失败。"
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
      return setState({
        status: "failed",
        reason: "sign-in-failed",
        message: error?.message || "登录失败。"
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
      return setState({
        status: "failed",
        reason: "sign-out-failed",
        message: error?.message || "退出登录失败。"
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

  window.LingoFlowSupabaseAuth = Object.freeze({
    initialize,
    getState,
    signUp,
    signIn,
    signOut,
    getSessionContext,
    getAccessToken
  });
})();
