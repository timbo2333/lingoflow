const { test, expect } = require("@playwright/test");

const projectErrors = new WeakMap();

test.beforeEach(async ({ page }) => {
  const errors = [];
  projectErrors.set(page, errors);
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
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
  await expect(page.locator("#inputText")).toBeVisible();
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

test("Modal shell moves focus inside, traps Tab, restores focus, and closes with Escape", async ({ page }) => {
  const trigger = page.locator("#homeSettingsButton");
  await trigger.click();
  await expect(page.locator("#settingsModal")).toHaveClass(/show/);
  await expect(page.locator("#readerFontSize")).toBeFocused();
  await expect(page.locator("body")).toHaveClass(/modalOpen/);

  const close = page.locator("#settingsModal .iconClose");
  const last = page.locator("#settingsAboutDisclosure > summary");
  await last.focus();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(last).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.locator("#settingsModal")).not.toHaveClass(/show/);
  await expect(trigger).toBeFocused();
  await expect(page.locator("body")).not.toHaveClass(/modalOpen/);
});

test("Account modal shares Escape, initial focus, focus restore, and accessible controls", async ({ page }) => {
  const trigger = page.locator("#accountButton");
  await trigger.click();
  await expect(page.locator("#authModal")).toHaveClass(/show/);
  await expect(page.locator("#authEmail")).toBeFocused();
  await expect(page.locator("#authModalClose")).toHaveAttribute("aria-label", "关闭账号");
  await expect(page.locator("#authPasswordVisibility")).toHaveAttribute("aria-label", "显示密码");

  await page.keyboard.press("Escape");
  await expect(page.locator("#authModal")).not.toHaveClass(/show/);
  await expect(trigger).toBeFocused();
});

test("Settings stays viewport-bound from 320px to 1440px and keeps advanced content folded", async ({ page }) => {
  const viewports = [
    { width: 320, height: 700 },
    { width: 390, height: 844 },
    { width: 768, height: 900 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 }
  ];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    if (!(await page.locator("#settingsModal").evaluate(node => node.classList.contains("show")))) {
      await page.click("#homeSettingsButton");
    }
    const metrics = await page.locator("#settingsModal").evaluate(modal => {
      const card = modal.querySelector(".modalCard");
      const header = modal.querySelector(".modalHeader");
      const body = modal.querySelector(".modalBody");
      const cardRect = card.getBoundingClientRect();
      const headerRect = header.getBoundingClientRect();
      return {
        pageFits: document.documentElement.scrollWidth <= window.innerWidth,
        cardFits: cardRect.left >= 0 && cardRect.right <= window.innerWidth &&
          cardRect.top >= 0 && cardRect.bottom <= window.innerHeight,
        closeVisible: headerRect.top >= 0 && headerRect.bottom <= window.innerHeight,
        bodyScrollable: body.scrollHeight > body.clientHeight,
        bodyOverflowY: getComputedStyle(body).overflowY
      };
    });
    expect(metrics.pageFits).toBe(true);
    expect(metrics.cardFits).toBe(true);
    expect(metrics.closeVisible).toBe(true);
    expect(metrics.bodyOverflowY).toBe("auto");
    if (viewport.width <= 390) expect(metrics.bodyScrollable).toBe(true);
  }

  await expect(page.locator("#settingsAdvancedDisclosure")).not.toHaveAttribute("open", "");
  await expect(page.locator("#settingsModal").getByText("ECDICT 数据", { exact: true })).toBeHidden();
  await page.locator("#settingsAdvancedDisclosure > summary").click();
  await page.locator("#offlineTechnicalDisclosure > summary").click();
  await expect(page.locator("#settingsModal").getByText("ECDICT 数据", { exact: true })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const beforeScroll = await page.locator("#settingsModal").evaluate(modal => {
    const header = modal.querySelector(".modalHeader");
    const body = modal.querySelector(".modalBody");
    const headerRect = header.getBoundingClientRect();
    return {
      headerTop: headerRect.top,
      headerBottom: headerRect.bottom,
      headerPosition: getComputedStyle(header).position,
      headerSurface: getComputedStyle(header).backgroundColor,
      pageFits: document.documentElement.scrollWidth <= window.innerWidth,
      bodyCanScroll: body.scrollHeight > body.clientHeight
    };
  });
  await page.locator("#settingsModal .modalBody").evaluate(body => {
    body.scrollTop = body.scrollHeight;
  });
  const afterScroll = await page.locator("#settingsModal").evaluate(modal => {
    const headerRect = modal.querySelector(".modalHeader").getBoundingClientRect();
    const body = modal.querySelector(".modalBody");
    return {
      headerTop: headerRect.top,
      headerBottom: headerRect.bottom,
      bodyScrollTop: body.scrollTop,
      pageY: window.scrollY
    };
  });
  expect(beforeScroll.headerPosition).toBe("sticky");
  expect(beforeScroll.headerSurface).not.toBe("rgba(0, 0, 0, 0)");
  expect(beforeScroll.bodyCanScroll).toBe(true);
  expect(beforeScroll.pageFits).toBe(true);
  expect(afterScroll.bodyScrollTop).toBeGreaterThan(0);
  expect(afterScroll.headerTop).toBeCloseTo(beforeScroll.headerTop, 0);
  expect(afterScroll.headerBottom).toBeLessThanOrEqual(844);
  expect(afterScroll.pageY).toBe(0);
});

test("Settings appearance updates its own modal surface in Light and Dark modes", async ({ page }) => {
  await page.click("#homeSettingsButton");
  await page.selectOption("#appearanceMode", "dark");
  await expect(page.locator("body")).toHaveClass(/darkMode/);
  const darkSurface = await page.locator("#settingsModal .settingsModalCard")
    .evaluate(card => getComputedStyle(card).backgroundColor);
  expect(darkSurface).not.toBe("rgb(255, 255, 255)");

  await page.selectOption("#appearanceMode", "light");
  await expect(page.locator("body")).not.toHaveClass(/darkMode/);
  const lightSurface = await page.locator("#settingsModal .settingsModalCard")
    .evaluate(card => getComputedStyle(card).backgroundColor);
  expect(lightSurface).toBe("rgb(255, 255, 255)");
});

test("Settings disclosure controls stay clear of the scrollbar when collapsed or expanded", async ({ page }) => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1440, height: 900 }
  ]) {
    await page.setViewportSize(viewport);
    if (!(await page.locator("#settingsModal").evaluate(node => node.classList.contains("show")))) {
      await page.click("#homeSettingsButton");
    }

    for (const appearance of ["light", "dark"]) {
      await page.selectOption("#appearanceMode", appearance);
      const advanced = page.locator("#settingsAdvancedDisclosure");
      if (await advanced.getAttribute("open") !== null) {
        await advanced.locator(":scope > summary").click();
      }

      for (const expanded of [false, true]) {
        if ((await advanced.getAttribute("open") !== null) !== expanded) {
          await advanced.locator(":scope > summary").click();
        }
        const layout = await page.locator("#settingsModal").evaluate(modal => {
          const body = modal.querySelector(".modalBody");
          const summary = modal.querySelector("#settingsAdvancedDisclosure > summary");
          const bodyRect = body.getBoundingClientRect();
          const summaryRect = summary.getBoundingClientRect();
          const summaryStyle = getComputedStyle(summary);
          const markerStyle = getComputedStyle(summary, "::after");
          return {
            gutter: getComputedStyle(body).scrollbarGutter,
            rightClearance: bodyRect.right - summaryRect.right,
            summaryDisplay: summaryStyle.display,
            markerContent: markerStyle.content,
            pageFits: document.documentElement.scrollWidth <= window.innerWidth
          };
        });
        expect(layout.gutter).toContain("stable");
        expect(layout.rightClearance).toBeGreaterThanOrEqual(12);
        expect(layout.summaryDisplay).toBe("flex");
        expect(["\"＋\"", "\"−\""]).toContain(layout.markerContent);
        expect(layout.pageFits).toBe(true);
      }
    }
  }
});

test("Backup v2 is the primary export and safe-merge import path", async ({ page }) => {
  await page.click("#homeSettingsButton");
  await page.evaluate(() => {
    Object.defineProperty(window, "LingoFlowBackupV2Export", {
      configurable: true,
      value: Object.freeze({
        exportBackup: async () => ({
          status: "ready",
          payload: {
            format: { name: "LingoFlow Backup", version: 2 },
            metadata: {},
            schema: {},
            data: {}
          }
        })
      })
    });
    window.__phase5RestoreCalls = [];
    Object.defineProperty(window, "LingoFlowBackupV2", {
      configurable: true,
      value: Object.freeze({
        restoreBackup: async envelope => {
          window.__phase5RestoreCalls.push(envelope);
          return {
            status: "completed",
            summary: { restored: 3, unchanged: 2, conflicts: 0 }
          };
        }
      })
    });
  });

  const downloadPromise = page.waitForEvent("download");
  await page.click("#currentBackupExportButton");
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^lingoflow-backup-v2-\d{4}-\d{2}-\d{2}\.json$/);
  await expect(page.locator("#currentBackupStatus")).toContainText("备份已导出");

  page.once("dialog", dialog => dialog.accept());
  await page.locator("#currentBackupFileInput").setInputFiles({
    name: "lingoflow-backup-v2.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      format: { name: "LingoFlow Backup", version: 2 },
      metadata: {},
      schema: {},
      data: {}
    }))
  });
  await expect(page.locator("#currentBackupStatus")).toContainText("恢复 3 项");
  expect(await page.evaluate(() => window.__phase5RestoreCalls.length)).toBe(1);

  page.once("dialog", dialog => dialog.dismiss());
  await page.locator("#currentBackupFileInput").setInputFiles({
    name: "cancelled.json",
    mimeType: "application/json",
    buffer: Buffer.from("{}")
  });
  await expect(page.locator("#currentBackupStatus")).toContainText("已取消导入");
  expect(await page.evaluate(() => window.__phase5RestoreCalls.length)).toBe(1);

  await page.locator("#currentBackupFileInput").setInputFiles({
    name: "malformed.json",
    mimeType: "application/json",
    buffer: Buffer.from("{not-json")
  });
  await expect(page.locator("#currentBackupStatus")).toContainText("无法识别");
  expect(await page.evaluate(() => window.__phase5RestoreCalls.length)).toBe(1);
});

test("Legacy overwrite is visually separated and keeps its confirmation semantics", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click("#homeSettingsButton");
  await page.locator("#settingsCompatibilityDisclosure > summary").click();
  await page.selectOption("#learningImportMode", "overwrite");
  await expect(page.locator("#learningImportModeHint")).toHaveAttribute("data-mode", "overwrite");
  await expect(page.locator("#learningImportModeHint")).toContainText("完全覆盖会替换");
  await expect(page.locator(".legacyDangerGroup .dangerButton")).toBeVisible();

  const layout = await page.locator("#settingsCompatibilityDisclosure").evaluate(disclosure => ({
    pageFits: document.documentElement.scrollWidth <= window.innerWidth,
    disclosureFits: disclosure.getBoundingClientRect().right <= window.innerWidth,
    importButtonsStacked: [...disclosure.querySelectorAll(".legacyImportLayout .backupButtonRow button")]
      .every(button => button.getBoundingClientRect().width > 250)
  }));
  expect(layout).toEqual({
    pageFits: true,
    disclosureFits: true,
    importButtonsStacked: true
  });
});

test("Offline dictionary stays advanced, renders failures, and cancel preserves installed data", async ({ page }) => {
  await page.evaluate(async () => {
    await setECDICTMeta("ready", true);
    await setECDICTMeta("count", 123);
    await setECDICTMeta("lemma_ready", true);
    await setECDICTMeta("lemma_count", 45);
  });
  await page.click("#homeSettingsButton");
  await page.locator("#settingsAdvancedDisclosure > summary").click();
  await expect(page.locator("#settingsOfflineSummary")).toContainText("已安装完整离线词典");
  await expect(page.locator("#offlineTechnicalDisclosure")).not.toHaveAttribute("open", "");
  await expect(page.getByRole("button", { name: "删除 ECDICT" })).toHaveClass(/dangerButtonSecondary/);
  await expect(page.getByRole("button", { name: "删除 Lemma" })).toHaveClass(/dangerButtonSecondary/);
  await expect(page.getByRole("button", { name: "删除全部离线资源" })).not.toHaveClass(/dangerButtonSecondary/);

  page.once("dialog", dialog => dialog.dismiss());
  await page.getByRole("button", { name: "删除全部离线资源" }).click();
  const stateAfterCancel = await page.evaluate(async () => ({
    ready: (await getECDICTMeta("ready"))?.value,
    count: (await getECDICTMeta("count"))?.value,
    lemmaReady: (await getECDICTMeta("lemma_ready"))?.value
  }));
  expect(stateAfterCancel).toEqual({ ready: true, count: 123, lemmaReady: true });

  await page.evaluate(() => {
    setDictionarySetupState(
      "error",
      "完整离线词典暂时无法安装",
      "请检查网络后重试。",
      { showRetry: true, hideProgress: true }
    );
    openDictionaryGuide();
  });
  await expect(page.locator("#dictionarySetupStatus")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#dictionaryGuideModal")).toHaveClass(/show/);
  await page.keyboard.press("Escape");
  await expect(page.locator("#dictionaryGuideModal")).not.toHaveClass(/show/);
  await expect(page.locator("#settingsModal")).toHaveClass(/show/);
});
