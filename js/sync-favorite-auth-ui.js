(function() {
  "use strict";

  const PROMPT_SEEN_PREFIX = "lingoflowFavoriteActivationPromptSeen:";
  const RESEND_COOLDOWN_MS = 60000;
  const auth = window.LingoFlowSupabaseAuth;
  const sync = window.LingoFlowFavoriteAppSync;
  let mode = "sign-in";
  let busy = false;
  let confirmationDismissed = false;
  let passwordUpdateAcknowledged = false;
  let resendAvailableAt = 0;
  let resendTimer = null;

  function element(id) {
    return document.getElementById(id);
  }

  function setHidden(id, hidden) {
    const target = element(id);
    if (target) target.hidden = hidden;
  }

  function setFeedback(message, kind = "") {
    const target = element("authFeedback");
    if (!target) return;
    target.textContent = message || "";
    target.dataset.kind = kind;
  }

  function openModal() {
    element("authModal")?.classList.add("show");
    render();
  }

  function closeModal() {
    element("authModal")?.classList.remove("show");
  }

  function setMode(nextMode) {
    mode = nextMode === "sign-up" ? "sign-up" : "sign-in";
    const signingUp = mode === "sign-up";
    const signInMode = element("authSignInMode");
    const signUpMode = element("authSignUpMode");
    signInMode?.classList.toggle("active", !signingUp);
    signUpMode?.classList.toggle("active", signingUp);
    signInMode?.setAttribute("aria-selected", String(!signingUp));
    signUpMode?.setAttribute("aria-selected", String(signingUp));
    const password = element("authPassword");
    if (password) password.autocomplete = signingUp ? "new-password" : "current-password";
    setHidden("authConfirmPasswordGroup", !signingUp);
    setHidden("authPasswordRequirement", !signingUp);
    setHidden("authForgotPasswordButton", signingUp);
    const submit = element("authSubmitButton");
    if (submit) submit.textContent = signingUp ? "注册" : "登录";
    setFeedback("");
  }

  function passwordFieldName(inputId) {
    const names = {
      authConfirmPassword: "确认密码",
      authNewPassword: "新密码",
      authNewPasswordConfirmation: "确认新密码"
    };
    return names[inputId] || "密码";
  }

  function passwordPolicy() {
    const policy = auth?.getPasswordPolicy?.();
    return {
      minimumLength: Number.isInteger(policy?.minimumLength) ? policy.minimumLength : 6,
      message: typeof policy?.message === "string"
        ? policy.message
        : "密码至少需要 6 个字符。"
    };
  }

  function togglePasswordVisibility(inputId, button) {
    const input = element(inputId);
    if (!input || !button) return;
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    button.setAttribute("aria-pressed", String(!showing));
    button.setAttribute("aria-label", `${showing ? "显示" : "隐藏"}${passwordFieldName(inputId)}`);
    const icon = button.querySelector("[aria-hidden='true']");
    if (icon) icon.textContent = showing ? "👁" : "🙈";
  }

  function clearPasswordInput(inputId, buttonId) {
    const input = element(inputId);
    const button = element(buttonId);
    if (input) {
      input.value = "";
      input.type = "password";
    }
    if (button) {
      button.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-label", `显示${passwordFieldName(inputId)}`);
      const icon = button.querySelector("[aria-hidden='true']");
      if (icon) icon.textContent = "👁";
    }
  }

  function validationMessage(emailBox, password, confirmPassword) {
    const email = String(emailBox?.value || "").trim();
    if (!email) return "请输入邮箱。";
    const parts = email.split("@");
    if (emailBox?.validity?.typeMismatch || parts.length !== 2 ||
        !parts[0] || !parts[1] || /\s/.test(email)) {
      return "请输入有效邮箱地址。";
    }
    if (!password) return "请输入密码。";
    const policy = passwordPolicy();
    if (password.length < policy.minimumLength) return policy.message;
    if (mode === "sign-up" && !confirmPassword) return "请再次输入密码。";
    if (mode === "sign-up" && password !== confirmPassword) {
      return "两次输入的密码不一致";
    }
    return "";
  }

  function resetEmailValidationMessage(emailBox) {
    const email = String(emailBox?.value || "").trim();
    const parts = email.split("@");
    if (!email || emailBox?.validity?.typeMismatch || parts.length !== 2 ||
        !parts[0] || !parts[1] || /\s/.test(email)) {
      return "请输入有效的邮箱地址";
    }
    return "";
  }

  function newPasswordValidationMessage(password, confirmation) {
    if (!password) return "请输入新密码。";
    const policy = passwordPolicy();
    if (password.length < policy.minimumLength) return policy.message;
    if (!confirmation) return "请再次输入新密码。";
    if (password !== confirmation) return "两次输入的密码不一致";
    return "";
  }

  function authMessage(authState) {
    if (authState.status === "reset-requesting") return "正在发送密码重置邮件…";
    if (authState.status === "reset-email-sent") return "密码重置邮件已发送，请检查邮箱";
    if (authState.status === "reset-request" && authState.reason === "password-reset-request-failed") {
      return authState.message || "暂时无法重置密码，请稍后再试。";
    }
    if (authState.status === "recovery-invalid") {
      return "重置链接已失效，请重新申请。";
    }
    if (authState.status === "password-recovery") {
      if (authState.reason === "updating-password") return "正在更新密码…";
      if (authState.reason === "password-update-failed") {
        return authState.message || "暂时无法重置密码，请稍后再试。";
      }
      return "请设置新密码。";
    }
    if (authState.status === "otp-required") {
      if (authState.reason === "otp-resent") return "验证码已重新发送";
      if (authState.reason === "resending-otp") return "正在重新发送验证码…";
      if (authState.reason === "otp-verification-failed") {
        return authState.message || "验证码不正确或已过期，请重新输入。";
      }
      if (authState.reason === "resend-failed") {
        return authState.message || "暂时无法重新发送验证码，请稍后重试。";
      }
      return "验证码已发送";
    }
    if (authState.status === "verifying") return "正在验证…";
    if (authState.status === "authenticating") {
      return authState.reason === "signing-up" ? "正在发送验证码…" : "正在确认账号状态…";
    }
    if (authState.status === "authenticated" && authState.reason === "email-verified") {
      return "邮箱验证成功";
    }
    if (authState.status === "authenticated" && authState.reason === "password-updated") {
      return "密码已更新";
    }
    if (authState.status === "paused") return "账号服务暂时不可用，本地收藏仍可正常使用。";
    if (authState.status === "failed") {
      return authState.message || "账号操作暂时无法完成，请稍后重试。";
    }
    if (authState.status === "unavailable") return "账号配置暂时不可用，本地功能不受影响。";
    return "";
  }

  function authFeedbackKind(authState) {
    if (authState.status === "failed" ||
        [
          "resend-failed",
          "otp-verification-failed",
          "password-reset-request-failed",
          "password-update-failed",
          "recovery-link-invalid"
        ].includes(authState.reason)) {
      return "error";
    }
    if ([
      "otp-sent",
      "otp-resent",
      "email-verified",
      "password-reset-email-sent",
      "password-updated"
    ].includes(authState.reason)) {
      return "success";
    }
    return "info";
  }

  function updateResendButton() {
    const button = element("authResendOtpButton");
    if (!button) return;
    const remaining = Math.max(0, Math.ceil((resendAvailableAt - Date.now()) / 1000));
    button.disabled = busy || remaining > 0;
    button.textContent = remaining > 0
      ? `重新发送验证码（${remaining}s）`
      : "重新发送验证码";
    if (resendTimer) clearTimeout(resendTimer);
    resendTimer = remaining > 0
      ? setTimeout(updateResendButton, 1000)
      : null;
  }

  function startResendCooldown() {
    resendAvailableAt = Date.now() + RESEND_COOLDOWN_MS;
    updateResendButton();
  }

  function syncPresentation(syncState, authState) {
    const authenticated = ["authenticated", "password-recovery"].includes(authState.status);
    if (!authenticated) {
      if (["paused", "failed"].includes(authState.status)) {
        return { state: "unavailable", message: "同步暂时不可用" };
      }
      return { state: "local", message: "收藏与学习状态仅保存在当前设备" };
    }
    if (syncState.status === "activation-required") {
      return { state: "pending", message: "等待确认本地收藏" };
    }
    if (syncState.reason === "activation-deferred") {
      return { state: "local", message: "收藏与学习状态仅保存在当前设备" };
    }
    if (syncState.reason === "workspace-owner-mismatch" ||
        syncState.syncStatus === "attention") {
      return { state: "attention", message: "有同步数据需要处理" };
    }
    if (syncState.status === "starting" || syncState.syncStatus === "syncing") {
      return { state: "syncing", message: "正在同步收藏与学习状态…" };
    }
    if (syncState.syncStatus === "synced") {
      return { state: "synced", message: "收藏与学习状态已同步" };
    }
    if (syncState.syncStatus === "pending") {
      return { state: "pending", message: "有数据等待同步" };
    }
    if (syncState.syncStatus === "unavailable" || syncState.status === "paused") {
      return { state: "unavailable", message: "云同步暂时不可用" };
    }
    return { state: "unavailable", message: "云同步尚未启动" };
  }

  function maybePromptForActivation(syncState) {
    if (syncState.status !== "activation-required" || !syncState.ownerId) return;
    const key = `${PROMPT_SEEN_PREFIX}${syncState.ownerId}`;
    if (localStorage.getItem(key) === "1") return;
    localStorage.setItem(key, "1");
    openModal();
  }

  function render() {
    if (!auth || !sync) return;
    const authState = auth.getState();
    const syncState = sync.getState();
    const authenticated = authState.status === "authenticated";
    const otpActive = ["otp-required", "verifying"].includes(authState.status) &&
      !confirmationDismissed;
    const recoveryActive = authState.status === "password-recovery";
    const recoveryInvalid = authState.status === "recovery-invalid";
    const resetRequestActive = recoveryInvalid || [
      "reset-request",
      "reset-requesting",
      "reset-email-sent"
    ].includes(authState.status);
    const specialFlowActive = otpActive || recoveryActive || resetRequestActive;
    if (recoveryActive) passwordUpdateAcknowledged = false;
    const presentation = syncPresentation(syncState, authState);
    setHidden("authSignedOutPanel", authenticated);
    setHidden("authSignedInPanel", !authenticated);
    setHidden("authModeTabs", specialFlowActive);
    setHidden("authForm", specialFlowActive);
    setHidden("authOtpPanel", !otpActive);
    setHidden("authResetRequestPanel", !resetRequestActive);
    setHidden("authPasswordRecoveryPanel", !recoveryActive);
    setHidden(
      "authPasswordUpdatedNotice",
      authState.reason !== "password-updated" || passwordUpdateAcknowledged
    );

    if (recoveryActive || recoveryInvalid) {
      element("authModal")?.classList.add("show");
    }

    const resetEmail = element("authResetEmail");
    if (resetEmail && !resetEmail.value && authState.email) resetEmail.value = authState.email;
    const resetTitle = element("authResetRequestTitle");
    const resetMessage = element("authResetRequestMessage");
    if (resetTitle) {
      resetTitle.textContent = recoveryInvalid
        ? "重置链接已失效"
        : authState.status === "reset-email-sent" ? "邮件已发送" : "重置密码";
    }
    if (resetMessage) {
      resetMessage.textContent = recoveryInvalid
        ? "请重新申请密码重置邮件。"
        : authState.status === "reset-email-sent"
          ? "密码重置邮件已发送，请检查邮箱。"
          : "输入注册邮箱，我们会向你发送密码重置邮件。";
    }

    const otpEmail = element("authOtpEmail");
    if (otpEmail) {
      otpEmail.textContent = authState.email || element("authEmail")?.value || "该邮箱";
    }
    const otpTitle = element("authOtpTitle");
    if (otpTitle) {
      otpTitle.textContent = authState.reason === "otp-resent"
        ? "验证码已重新发送"
        : "验证码已发送";
    }

    const accountButton = element("accountButton");
    if (accountButton) {
      accountButton.textContent = recoveryActive
        ? "👤 设置新密码"
        : authenticated ? "👤 已登录" : "👤 登录 / 注册";
    }
    const email = element("authUserEmail");
    if (email) email.textContent = authState.user?.email || "已登录";
    const syncSummary = element("authSyncSummary");
    if (syncSummary) syncSummary.textContent = presentation.message;
    const syncBadge = element("favoriteSyncStatusBadge");
    if (syncBadge) {
      syncBadge.textContent = presentation.message;
      syncBadge.dataset.state = presentation.state;
    }

    const canActivate = authenticated && (
      syncState.status === "activation-required" ||
      syncState.reason === "activation-deferred"
    );
    setHidden("workspaceActivationPanel", !canActivate);
    setHidden(
      "workspaceBlockedPanel",
      !(authenticated && syncState.reason === "workspace-owner-mismatch")
    );
    const activationMessage = element("workspaceActivationMessage");
    if (activationMessage && canActivate) {
      const count = Number(syncState.localFavoriteCount || 0);
      activationMessage.textContent = count > 0
        ? `检测到当前浏览器已有 ${count} 条本地收藏。只有你明确同意后，这些收藏及其学习状态才会关联到此账号并上传。`
        : "确认后会为当前账号开启收藏与学习状态同步。";
    }

    const syncButton = element("authSyncNowButton");
    if (syncButton) {
      syncButton.textContent = ["pending", "unavailable"].includes(presentation.state)
        ? "重试同步"
        : "立即同步";
      syncButton.disabled = busy || syncState.status !== "ready" ||
        ["syncing", "attention"].includes(presentation.state);
    }
    const signOutButton = element("authSignOutButton");
    if (signOutButton) signOutButton.disabled = busy;
    const submit = element("authSubmitButton");
    if (submit) submit.disabled = busy || authState.status === "authenticating";
    const verifyOtpButton = element("authVerifyOtpButton");
    if (verifyOtpButton) {
      verifyOtpButton.disabled = busy || authState.status === "verifying";
      verifyOtpButton.textContent = authState.status === "verifying" ? "正在验证…" : "确认注册";
    }
    const resetRequestButton = element("authResetRequestButton");
    if (resetRequestButton) {
      resetRequestButton.disabled = busy || authState.status === "reset-requesting";
      resetRequestButton.textContent = authState.status === "reset-requesting"
        ? "正在发送…"
        : authState.status === "reset-email-sent"
          ? "重新发送密码重置邮件"
          : "发送密码重置邮件";
    }
    const updatePasswordButton = element("authUpdatePasswordButton");
    if (updatePasswordButton) {
      updatePasswordButton.disabled = busy || authState.reason === "updating-password";
      updatePasswordButton.textContent = authState.reason === "updating-password"
        ? "正在更新…"
        : "更新密码";
    }
    updateResendButton();

    const message = confirmationDismissed &&
      ["otp-required", "verifying"].includes(authState.status)
      ? ""
      : authMessage(authState);
    if (message) setFeedback(message, authFeedbackKind(authState));
    maybePromptForActivation(syncState);
  }

  async function submitAuth(event) {
    event.preventDefault();
    if (busy || !auth) return;
    const emailBox = element("authEmail");
    const email = emailBox?.value || "";
    const passwordBox = element("authPassword");
    const password = passwordBox?.value || "";
    const confirmPasswordBox = element("authConfirmPassword");
    const confirmPassword = confirmPasswordBox?.value || "";
    const invalid = validationMessage(emailBox, password, confirmPassword);
    if (invalid) {
      setFeedback(invalid, "error");
      return;
    }
    if (mode === "sign-up") confirmationDismissed = false;
    busy = true;
    setFeedback(mode === "sign-in" ? "正在登录…" : "正在发送验证码…", "info");
    render();
    const result = mode === "sign-in"
      ? await auth.signIn({ email, password })
      : await auth.signUp({ email, password });
    if (["authenticated", "otp-required"].includes(result.status)) {
      clearPasswordInput("authPassword", "authPasswordVisibility");
      clearPasswordInput("authConfirmPassword", "authConfirmPasswordVisibility");
    }
    if (result.status === "otp-required") {
      const otpCode = element("authOtpCode");
      if (otpCode) otpCode.value = "";
    }
    if (result.status === "authenticated") {
      await sync.bootstrap();
      setFeedback("登录成功。", "success");
    }
    busy = false;
    render();
  }

  function preventInvalidOtpInsertion(event) {
    if (event.inputType?.startsWith("insert") && event.data && !/^\d+$/.test(event.data)) {
      event.preventDefault();
    }
  }

  function otpValidationMessage(token) {
    if (!token) return "请输入验证码。";
    if (!/^\d+$/.test(token)) return "验证码只能包含数字。";
    if (token.length < 6 || token.length > 10) return "请输入 6–10 位数字验证码。";
    return "";
  }

  async function submitOtp(event) {
    event.preventDefault();
    if (busy || !auth) return;
    const token = element("authOtpCode")?.value || "";
    const invalid = otpValidationMessage(token);
    if (invalid) {
      setFeedback(invalid, "error");
      return;
    }
    const authState = auth.getState();
    const email = authState.email || element("authEmail")?.value || "";
    busy = true;
    setFeedback("正在验证…", "info");
    render();
    const result = await auth.verifySignUpOtp({ email, token });
    if (result.status === "authenticated") {
      const otpCode = element("authOtpCode");
      if (otpCode) otpCode.value = "";
      await sync.bootstrap();
      setFeedback("邮箱验证成功", "success");
    }
    busy = false;
    render();
  }

  async function resendConfirmation() {
    if (busy || Date.now() < resendAvailableAt || !auth) return;
    const authState = auth.getState();
    const email = authState.email || element("authEmail")?.value || "";
    busy = true;
    setFeedback("正在重新发送验证码…", "info");
    updateResendButton();
    const result = await auth.resendSignUpConfirmation({ email });
    busy = false;
    confirmationDismissed = false;
    if (result.reason === "otp-resent") {
      const otpCode = element("authOtpCode");
      if (otpCode) otpCode.value = "";
    }
    startResendCooldown();
    render();
    return result;
  }

  function beginPasswordResetRequest() {
    if (busy || !auth) return;
    const currentEmail = element("authEmail")?.value || "";
    const resetEmail = element("authResetEmail");
    if (resetEmail) resetEmail.value = currentEmail;
    auth.beginPasswordResetRequest({ email: currentEmail });
    setFeedback("");
    render();
    resetEmail?.focus();
  }

  async function submitPasswordResetRequest(event) {
    event.preventDefault();
    if (busy || !auth) return;
    const emailBox = element("authResetEmail");
    const invalid = resetEmailValidationMessage(emailBox);
    if (invalid) {
      setFeedback(invalid, "error");
      return;
    }
    busy = true;
    setFeedback("正在发送密码重置邮件…", "info");
    render();
    await auth.requestPasswordReset({ email: emailBox.value });
    busy = false;
    render();
  }

  function returnFromPasswordResetRequest() {
    if (busy || !auth) return;
    const email = element("authResetEmail")?.value || "";
    const authEmail = element("authEmail");
    if (authEmail) authEmail.value = email;
    auth.cancelPasswordResetRequest();
    setMode("sign-in");
    setFeedback("");
    render();
    element("authPassword")?.focus();
  }

  async function submitNewPassword(event) {
    event.preventDefault();
    if (busy || !auth) return;
    const password = element("authNewPassword")?.value || "";
    const confirmation = element("authNewPasswordConfirmation")?.value || "";
    const invalid = newPasswordValidationMessage(password, confirmation);
    if (invalid) {
      setFeedback(invalid, "error");
      return;
    }
    busy = true;
    setFeedback("正在更新密码…", "info");
    render();
    const result = await auth.updatePassword({ password });
    if (result.status === "authenticated") {
      clearPasswordInput("authNewPassword", "authNewPasswordVisibility");
      clearPasswordInput(
        "authNewPasswordConfirmation",
        "authNewPasswordConfirmationVisibility"
      );
      await sync.bootstrap();
      setFeedback("密码已更新", "success");
    }
    busy = false;
    render();
  }

  function continueAfterPasswordUpdate() {
    passwordUpdateAcknowledged = true;
    setHidden("authPasswordUpdatedNotice", true);
    closeModal();
  }

  function returnToSignIn() {
    confirmationDismissed = true;
    setMode("sign-in");
    const otpCode = element("authOtpCode");
    if (otpCode) otpCode.value = "";
    setFeedback("请使用原邮箱和密码登录。", "info");
    render();
    element("authPassword")?.focus();
  }

  async function activateWorkspace() {
    if (busy) return;
    busy = true;
    setFeedback("正在关联本地数据并启动同步…", "info");
    render();
    const result = await sync.activateWorkspace();
    busy = false;
    setFeedback(
      result.status === "ready" ? "本地收藏与学习状态已关联，云同步已启动。" : "关联失败，请稍后重试。",
      result.status === "ready" ? "success" : "error"
    );
    render();
  }

  function deferWorkspace() {
    sync.deferWorkspaceActivation();
    setFeedback("已暂不关联；本地收藏保持不变，也不会上传。", "info");
    render();
  }

  async function signOut() {
    if (busy) return;
    busy = true;
    setFeedback("正在退出登录…", "info");
    render();
    const result = await auth.signOut();
    busy = false;
    if (result.status === "signed-out") {
      sync.deactivate("auth-required");
      setFeedback("已退出登录；本地数据和待同步内容均已保留。", "success");
    }
    render();
  }

  async function syncNow() {
    if (busy || sync.getState().status !== "ready") return;
    busy = true;
    setFeedback("正在同步收藏与学习状态…", "info");
    render();
    const result = await sync.syncNow();
    busy = false;
    setFeedback(
      result.status === "completed" ? "收藏与学习状态同步完成。" : "同步暂未完成，稍后会继续重试。",
      result.status === "completed" ? "success" : "info"
    );
    render();
  }

  element("accountButton")?.addEventListener("click", openModal);
  element("authModalClose")?.addEventListener("click", closeModal);
  element("authModal")?.addEventListener("click", event => {
    if (event.target === element("authModal")) closeModal();
  });
  element("authSignInMode")?.addEventListener("click", () => setMode("sign-in"));
  element("authSignUpMode")?.addEventListener("click", () => setMode("sign-up"));
  element("authPasswordVisibility")?.addEventListener("click", event => {
    togglePasswordVisibility("authPassword", event.currentTarget);
  });
  element("authConfirmPasswordVisibility")?.addEventListener("click", event => {
    togglePasswordVisibility("authConfirmPassword", event.currentTarget);
  });
  element("authForgotPasswordButton")?.addEventListener("click", beginPasswordResetRequest);
  element("authForm")?.addEventListener("submit", submitAuth);
  element("authOtpCode")?.addEventListener("beforeinput", preventInvalidOtpInsertion);
  element("authOtpForm")?.addEventListener("submit", submitOtp);
  element("authResendOtpButton")?.addEventListener("click", resendConfirmation);
  element("authReturnToSignInButton")?.addEventListener("click", returnToSignIn);
  element("authResetRequestForm")?.addEventListener("submit", submitPasswordResetRequest);
  element("authResetReturnToSignInButton")?.addEventListener(
    "click",
    returnFromPasswordResetRequest
  );
  element("authNewPasswordVisibility")?.addEventListener("click", event => {
    togglePasswordVisibility("authNewPassword", event.currentTarget);
  });
  element("authNewPasswordConfirmationVisibility")?.addEventListener("click", event => {
    togglePasswordVisibility("authNewPasswordConfirmation", event.currentTarget);
  });
  element("authPasswordRecoveryForm")?.addEventListener("submit", submitNewPassword);
  element("authContinueAfterPasswordUpdate")?.addEventListener(
    "click",
    continueAfterPasswordUpdate
  );
  element("workspaceActivateButton")?.addEventListener("click", activateWorkspace);
  element("workspaceDeferButton")?.addEventListener("click", deferWorkspace);
  element("authSignOutButton")?.addEventListener("click", signOut);
  element("authSyncNowButton")?.addEventListener("click", syncNow);
  window.addEventListener("lingoflow:auth-state", render);
  window.addEventListener("lingoflow:favorite-sync-status", render);

  setMode("sign-in");
  render();
  void auth?.initialize().then(render);

  window.LingoFlowFavoriteAuthUI = Object.freeze({ open: openModal, render });
})();
