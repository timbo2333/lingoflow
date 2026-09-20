(function initAnnouncements(global) {
  "use strict";

  const SEEN_KEY = "lingoflow_announcements_seen_v1";
  const MAX_SEEN_IDS = 200;
  const REQUEST_TIMEOUT_MS = 5000;
  const REFRESH_INTERVAL_MS = 60000;
  let announcements = [];
  let loadStatus = "loading";
  let lastFetchedAt = 0;
  let inflight = null;
  let expiryTimer = null;
  let seenIds = readSeenIds();

  function readSeenIds() {
    try {
      const stored = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}");
      if (!Array.isArray(stored?.ids)) return [];
      return [...new Set(stored.ids.filter(id =>
        typeof id === "string" && id.length > 0 && id.length <= 128
      ))].slice(-MAX_SEEN_IDS);
    } catch {
      return [];
    }
  }

  function markSeen(ids) {
    const next = [...new Set([...seenIds, ...ids])].slice(-MAX_SEEN_IDS);
    seenIds = next;
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify({ ids: next }));
    } catch {
      // Seen is device-only UI state; storage failure cannot block announcements.
    }
  }

  function activeAnnouncements(rows, now = Date.now()) {
    if (!Array.isArray(rows)) return [];
    return rows.filter(row => {
      const published = Date.parse(row?.published_at);
      const expires = row?.expires_at == null ? Infinity : Date.parse(row.expires_at);
      return typeof row?.id === "string" && row.id.length > 0 &&
        typeof row.title === "string" && typeof row.content === "string" &&
        row.is_active === true && Number.isFinite(published) && published <= now &&
        expires > now;
    }).sort((a, b) =>
      Number(b.importance === "important") - Number(a.importance === "important") ||
      Date.parse(b.published_at) - Date.parse(a.published_at) ||
      a.id.localeCompare(b.id)
    );
  }

  function currentAnnouncements() {
    return activeAnnouncements(announcements);
  }

  function scheduleNextExpiry() {
    clearTimeout(expiryTimer);
    const nextExpiry = Math.min(...currentAnnouncements()
      .filter(item => item.expires_at !== null)
      .map(item => Date.parse(item.expires_at)));
    if (!Number.isFinite(nextExpiry)) return;
    expiryTimer = setTimeout(() => {
      updateBadge();
      render();
      scheduleNextExpiry();
    }, Math.min(nextExpiry - Date.now() + 10, 2147483647));
  }

  async function fetchActiveAnnouncements(options = {}) {
    const config = options.config || global.LingoFlowSupabaseConfig;
    const request = options.fetch || global.fetch.bind(global);
    if (!config?.projectUrl || !config?.publishableKey) {
      return { status: "unavailable", announcements: [] };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = new URL("/rest/v1/announcements", config.projectUrl);
      url.searchParams.set("select", "id,title,content,importance,published_at,expires_at,is_active");
      url.searchParams.set("is_active", "eq.true");
      url.searchParams.set("published_at", `lte.${new Date().toISOString()}`);
      url.searchParams.set("order", "importance.asc,published_at.desc");
      url.searchParams.set("limit", String(MAX_SEEN_IDS));
      // Publishable key only. The request uses the anon role even if Auth is signed in.
      const response = await request(url.href, {
        headers: { apikey: config.publishableKey, Accept: "application/json" },
        signal: controller.signal
      });
      if (!response.ok) throw new Error("announcement_fetch_failed");
      const rows = await response.json();
      if (!Array.isArray(rows)) throw new Error("announcement_response_invalid");
      return { status: "ready", announcements: activeAnnouncements(rows) };
    } catch {
      return { status: "unavailable", announcements: [] };
    } finally {
      clearTimeout(timer);
    }
  }

  function updateBadge() {
    const button = document.getElementById("announcementsButton");
    const badge = document.getElementById("announcementsBadge");
    if (!button || !badge) return;
    const unread = loadStatus === "ready"
      ? currentAnnouncements().filter(item => !seenIds.includes(item.id)).length
      : 0;
    badge.hidden = unread === 0;
    badge.textContent = unread >= 10 ? "9+" : String(unread);
    button.setAttribute("aria-label", unread
      ? `公告，${unread} 条未读`
      : "公告，暂无未读");
  }

  function render() {
    const list = document.getElementById("announcementsList");
    if (!list) return;
    list.replaceChildren();
    const current = currentAnnouncements();
    if (loadStatus !== "ready" || !current.length) {
      const message = document.createElement("p");
      message.className = "announcementEmpty";
      message.textContent = loadStatus === "unavailable"
        ? "暂时无法获取公告。"
        : loadStatus === "loading" ? "正在获取公告…" : "暂无新公告。";
      list.appendChild(message);
      return;
    }
    for (const item of current) {
      const article = document.createElement("article");
      article.className = "announcementItem";
      article.dataset.announcementId = item.id;
      const heading = document.createElement("div");
      heading.className = "announcementHeading";
      const title = document.createElement("h2");
      title.className = "announcementTitle";
      title.textContent = item.title;
      heading.appendChild(title);
      if (item.importance === "important") {
        const label = document.createElement("span");
        label.className = "announcementImportant";
        label.textContent = "重要";
        heading.appendChild(label);
      }
      const date = document.createElement("time");
      date.className = "announcementDate";
      date.dateTime = item.published_at;
      date.textContent = new Date(item.published_at).toLocaleDateString("zh-CN", {
        year: "numeric", month: "long", day: "numeric"
      });
      const content = document.createElement("p");
      content.className = "announcementContent";
      content.textContent = item.content;
      article.append(heading, date, content);
      list.appendChild(article);
    }
  }

  function markDisplayedAsSeen() {
    if (loadStatus !== "ready" ||
        !document.getElementById("announcementsModal")?.classList.contains("show")) return;
    // IDs, not edit timestamps: editing a row does not re-notify a device.
    markSeen(currentAnnouncements().map(item => item.id));
    updateBadge();
  }

  function refresh(force = false) {
    if (inflight) return inflight;
    if (!force && loadStatus === "ready" && Date.now() - lastFetchedAt < REFRESH_INTERVAL_MS) {
      return Promise.resolve();
    }
    inflight = fetchActiveAnnouncements().then(result => {
      loadStatus = result.status;
      announcements = result.announcements;
      lastFetchedAt = Date.now();
      updateBadge();
      render();
      markDisplayedAsSeen();
      scheduleNextExpiry();
    }).finally(() => { inflight = null; });
    return inflight;
  }

  function initialize() {
    const button = document.getElementById("announcementsButton");
    if (!button) return;
    button.addEventListener("click", () => {
      global.LingoFlowModalSystem.open("announcementsModal", {
        trigger: button,
        initialFocus: "#announcementsModalClose"
      });
      render();
      markDisplayedAsSeen();
      void refresh();
    });
    document.getElementById("announcementsModalClose")?.addEventListener("click", () => {
      global.LingoFlowModalSystem.close("announcementsModal");
    });
    updateBadge();
    void refresh();
  }

  global.LingoFlowAnnouncements = Object.freeze({
    initialize,
    fetchActiveAnnouncements,
    activeAnnouncements,
    readSeenIds
  });
})(window);
