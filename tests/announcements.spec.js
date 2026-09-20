const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const SEEN_KEY = "lingoflow_announcements_seen_v1";
const NOW = Date.now();
const at = offset => new Date(NOW + offset).toISOString();
const row = (id, overrides = {}) => ({
  id,
  title: `公告 ${id}`,
  content: "第一行\n第二行",
  importance: "normal",
  published_at: at(-3600000),
  expires_at: null,
  is_active: true,
  ...overrides
});

async function openPage(page, rows, options = {}) {
  const calls = [];
  await page.route("**/rest/v1/announcements?**", async route => {
    calls.push({
      url: route.request().url(),
      headers: route.request().headers(),
      method: route.request().method()
    });
    if (options.unavailable) {
      await route.fulfill({ status: 503, body: "unavailable" });
    } else {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(rows)
      });
    }
  });
  await page.addInitScript(({ seen }) => {
    localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
    if (seen !== undefined) localStorage.setItem("lingoflow_announcements_seen_v1", seen);
  }, { seen: options.seen });
  await page.goto("/");
  await expect(page.locator("#inputText")).toBeVisible();
  await expect.poll(() => calls.length).toBeGreaterThan(0);
  return calls;
}

test("zero announcements show no badge and an accessible empty panel", async ({ page }) => {
  await openPage(page, []);
  await page.locator("#announcementsButton").click();
  await expect(page.locator("#announcementsBadge")).toBeHidden();
  await expect(page.locator("#announcementsList")).toHaveText("暂无新公告。");
  await expect(page.locator("#announcementsModal")).toHaveAttribute("aria-labelledby", "announcementsModalTitle");
});

test("one unread announcement is marked seen on open and stays seen after reload", async ({ page }) => {
  await openPage(page, [row("one")]);
  await expect(page.locator("#announcementsBadge")).toHaveText("1");
  await expect(page.locator("#announcementsButton")).toHaveAttribute("aria-label", "公告，1 条未读");
  await page.locator("#announcementsButton").click();
  await expect(page.locator(".announcementItem")).toHaveCount(1);
  await expect(page.locator("#announcementsBadge")).toBeHidden();
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), SEEN_KEY))
    .toEqual({ ids: ["one"] });
  await page.reload();
  await expect(page.locator("#announcementsBadge")).toBeHidden();
  await page.locator("#announcementsButton").click();
  await expect(page.locator(".announcementItem")).toHaveCount(1);
});

test("multiple unread count uses 9+ at ten, and previously seen IDs are excluded", async ({ page }) => {
  await openPage(page, Array.from({ length: 11 }, (_, i) => row(`id-${i}`)), {
    seen: JSON.stringify({ ids: ["id-0"] })
  });
  await expect(page.locator("#announcementsBadge")).toHaveText("9+");
  await expect(page.locator("#announcementsButton")).toHaveAttribute("aria-label", "公告，10 条未读");
  await page.locator("#announcementsButton").click();
  await expect(page.locator(".announcementItem")).toHaveCount(11);
  await expect(page.locator("#announcementsBadge")).toBeHidden();
});

test("nine unread uses the actual count and seen storage stays bounded", async ({ page }) => {
  const older = Array.from({ length: 210 }, (_, i) => `old-${i}`);
  await openPage(page, Array.from({ length: 9 }, (_, i) => row(`fresh-${i}`)), {
    seen: JSON.stringify({ ids: [...older, "old-209"] })
  });
  await expect(page.locator("#announcementsBadge")).toHaveText("9");
  await page.locator("#announcementsButton").click();
  const ids = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).ids, SEEN_KEY);
  expect(ids.length).toBeLessThanOrEqual(200);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toContain("fresh-8");
});

test("damaged seen storage safely falls back and subsequent save is deduplicated", async ({ page }) => {
  await openPage(page, [row("safe")], { seen: "{broken" });
  await expect(page.locator("#announcementsBadge")).toHaveText("1");
  await page.locator("#announcementsButton").click();
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), SEEN_KEY))
    .toEqual({ ids: ["safe"] });
});

test("inactive, future and expired rows are excluded; important then newest first", async ({ page }) => {
  await openPage(page, [
    row("inactive", { is_active: false }),
    row("future", { published_at: at(3600000) }),
    row("expired", { expires_at: at(-1000) }),
    row("older", { published_at: at(-7200000) }),
    row("newer", { published_at: at(-3600000) }),
    row("important-old", { importance: "important", published_at: at(-10800000) }),
    row("important-new", { importance: "important", published_at: at(-600000) })
  ]);
  await expect(page.locator("#announcementsBadge")).toHaveText("4");
  await page.locator("#announcementsButton").click();
  await expect(page.locator(".announcementItem")).toHaveCount(4);
  expect(await page.locator(".announcementItem").evaluateAll(items =>
    items.map(item => item.dataset.announcementId)
  )).toEqual(["important-new", "important-old", "newer", "older"]);
  await expect(page.locator(".announcementImportant")).toHaveCount(2);
});

test("an announcement that expires during an open session leaves the badge and list", async ({ page }) => {
  await openPage(page, [row("short-lived", {
    expires_at: new Date(Date.now() + 2200).toISOString()
  })]);
  await expect(page.locator("#announcementsBadge")).toHaveText("1");
  await expect(page.locator("#announcementsBadge")).toBeHidden({ timeout: 5000 });
  await page.locator("#announcementsButton").click();
  await expect(page.locator("#announcementsList")).toHaveText("暂无新公告。");
});

test("content newlines are preserved as text and markup cannot execute", async ({ page }) => {
  await openPage(page, [row("xss", {
    title: "<img src=x onerror=alert(1)>",
    content: "第一行\n<script>window.__announcementInjected=true</script>\n第三行"
  })]);
  await page.locator("#announcementsButton").click();
  await expect(page.locator(".announcementContent")).toHaveText(
    "第一行\n<script>window.__announcementInjected=true</script>\n第三行"
  );
  expect(await page.locator(".announcementContent").evaluate(el => getComputedStyle(el).whiteSpace))
    .toBe("pre-wrap");
  await expect(page.locator(".announcementItem img, .announcementItem script")).toHaveCount(0);
  expect(await page.evaluate(() => window.__announcementInjected)).toBeUndefined();
});

test("unavailable announcements do not block Home or show an error badge", async ({ page }) => {
  await openPage(page, [], { unavailable: true });
  await page.locator("#announcementsButton").click();
  await expect(page.locator("#announcementsList")).toHaveText("暂时无法获取公告。");
  await expect(page.locator("#announcementsBadge")).toBeHidden();
  await expect(page.locator("#inputText")).toBeVisible();
});

test("editing the same ID does not re-notify, but a new ID does", async ({ page }) => {
  let rows = [row("same")];
  await page.route("**/rest/v1/announcements?**", route => route.fulfill({
    contentType: "application/json", body: JSON.stringify(rows)
  }));
  await page.addInitScript(() => {
    localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
  });
  await page.goto("/");
  await expect(page.locator("#announcementsBadge")).toHaveText("1");
  await page.locator("#announcementsButton").click();
  await expect(page.locator("#announcementsBadge")).toBeHidden();
  rows = [row("same", { content: "已编辑" })];
  await page.reload();
  await expect(page.locator("#announcementsBadge")).toBeHidden();
  rows = [...rows, row("new")];
  await page.reload();
  await expect(page.locator("#announcementsBadge")).toHaveText("1");
});

test("bell uses only anon GET with the public key; modal Escape restores focus", async ({ page }) => {
  const calls = await openPage(page, [row("keyboard")]);
  await page.locator("#announcementsButton").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#announcementsModal")).toHaveClass(/show/);
  await expect(page.locator("#announcementsModalClose")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#announcementsModal")).not.toHaveClass(/show/);
  await expect(page.locator("#announcementsButton")).toBeFocused();
  expect(calls.every(call => call.method === "GET" &&
    call.headers.apikey?.startsWith("sb_publishable_") &&
    !call.headers.authorization)).toBe(true);
});

test("announcement modal reuses close button, backdrop and focus trap", async ({ page }) => {
  await openPage(page, [row("modal")]);
  const bell = page.locator("#announcementsButton");
  await bell.click();
  await expect(page.locator("#announcementsModalClose")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#announcementsModalClose")).toBeFocused();
  await page.locator("#announcementsModalClose").click();
  await expect(bell).toBeFocused();
  await bell.click();
  await page.locator("#announcementsModal").click({ position: { x: 2, y: 2 } });
  await expect(page.locator("#announcementsModal")).not.toHaveClass(/show/);
});

test("bell and panel fit 320/390/1440 and Light/Dark without horizontal overflow", async ({ page }) => {
  await openPage(page, [row("responsive")]);
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 780 });
    await page.locator("#announcementsButton").click();
    const metrics = await page.evaluate(() => {
      const bell = document.getElementById("announcementsButton").getBoundingClientRect();
      const card = document.querySelector("#announcementsModal .modalCard").getBoundingClientRect();
      return {
        pageFits: document.documentElement.scrollWidth <= innerWidth,
        bellWidth: bell.width,
        bellHeight: bell.height,
        cardFits: card.left >= 0 && card.right <= innerWidth
      };
    });
    expect(metrics).toEqual({ pageFits: true, bellWidth: 44, bellHeight: 44, cardFits: true });
    await page.keyboard.press("Escape");
  }
  await page.evaluate(() => document.body.classList.add("darkMode"));
  await page.locator("#announcementsButton").click();
  await expect(page.locator("#announcementsModal")).toHaveClass(/show/);
  const surface = await page.locator("#announcementsModal .modalCard")
    .evaluate(el => getComputedStyle(el).backgroundColor);
  expect(surface).not.toBe("rgb(255, 255, 255)");
});

test("fresh two-announcement shell uses versioned styles/scripts, visible bell and badge before opening", async ({ page }) => {
  await openPage(page, [
    row("normal", { title: "欢迎使用新版 LingoFlow" }),
    row("important", { title: "重要公告测试", importance: "important" })
  ]);
  await expect(page.locator("#announcementsBadge")).toHaveText("2");
  await expect(page.locator("#announcementsBadge")).toBeVisible();
  expect(await page.evaluate(() => ({
    css: document.querySelector('link[rel="stylesheet"]').getAttribute("href"),
    main: [...document.scripts].find(script => script.src.includes("/js/main.js"))?.getAttribute("src")
  }))).toEqual({
    css: "css/style.css?v=announcements-v1",
    main: "js/main.js?v=announcements-v1"
  });

  for (const { width, dark } of [
    { width: 1440, dark: false },
    { width: 1440, dark: true },
    { width: 390, dark: false }
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(value => document.body.classList.toggle("darkMode", value), dark);
    const state = await page.evaluate(() => {
      const button = document.getElementById("announcementsButton");
      const badge = document.getElementById("announcementsBadge");
      const svg = button.querySelector("svg");
      return {
        background: getComputedStyle(button).backgroundColor,
        svgFill: getComputedStyle(svg).fill,
        svgStroke: getComputedStyle(svg).stroke,
        badge: badge.textContent,
        hidden: badge.hidden,
        overflow: document.documentElement.scrollWidth > innerWidth
      };
    });
    expect(state.background).toBe("rgba(0, 0, 0, 0)");
    expect(state.svgFill).toBe("none");
    expect(state.svgStroke).not.toBe("none");
    expect(state.badge).toBe("2");
    expect(state.hidden).toBe(false);
    expect(state.overflow).toBe(false);
  }

  await page.locator("#announcementsButton").click();
  expect(await page.locator(".announcementTitle").allTextContents())
    .toEqual(["重要公告测试", "欢迎使用新版 LingoFlow"]);
  await expect(page.locator("#announcementsBadge")).toBeHidden();
  await page.reload();
  await expect(page.locator("#announcementsBadge")).toBeHidden();
});

test("migration grants read only and requires the published visibility predicate", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "supabase", "migrations",
    "20260919120000_add_announcements.sql"), "utf8");
  expect(sql).toMatch(/enable row level security/i);
  expect(sql).toMatch(/revoke all on table public\.announcements from public, anon, authenticated/i);
  expect(sql).toMatch(/grant select on table public\.announcements to anon, authenticated/i);
  expect(sql).toMatch(/for select\s+to anon, authenticated/i);
  expect(sql).toMatch(/is_active\s*=\s*true/i);
  expect(sql).toMatch(/published_at\s*<=\s*now\(\)/i);
  expect(sql).toMatch(/expires_at is null or expires_at > now\(\)/i);
  expect(sql).not.toMatch(/grant\s+(insert|update|delete)/i);
});
