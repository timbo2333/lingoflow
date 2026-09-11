const { test, expect } = require("@playwright/test");

const LIVE_ENABLED = process.env.LINGOFLOW_LIVE_DICTIONARY_SMOKE === "1";
const SMOKE_KEY = "lingoflow_dictionary_cloud_first_smoke";

async function openLiveApp(page) {
  await page.goto("/__lingoflow_test_cleanup__.html");
  await page.evaluate(async key => {
    for (const name of ["LingoFlowDictionaryCacheDB", "LingoFlowCoreLemmaDB"]) {
      await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = resolve;
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error(`Delete blocked for ${name}`));
      });
    }
    localStorage.setItem("EnglishReaderDictionaryGuideDeferred", "1");
    localStorage.setItem(key, "1");
  }, SMOKE_KEY);
  await page.goto("/");
  await expect(page.locator("#inputText")).toBeVisible();
}

test.describe("LIVE Supabase Dictionary smoke", () => {
  test.skip(!LIVE_ENABLED, "Set LINGOFLOW_LIVE_DICTIONARY_SMOKE=1 to run live checks.");

  test("live Cloud exact lookup", async ({ page }) => {
    await openLiveApp(page);
    const result = await page.evaluate(async () => (
      await window.LingoFlowDictionaryLookupService.lookup({ word: "academic" })
    ));
    expect(result).toMatchObject({
      status: "found",
      headword: "academic",
      source: "supabase_core"
    });
  });

  test("live Core Lemma lookup resolves sanctions and went", async ({ page }) => {
    await openLiveApp(page);
    const result = await page.evaluate(async () => ({
      sanctions: await window.LingoFlowDictionaryLookupService.lookup({ word: "sanctions" }),
      went: await window.LingoFlowDictionaryLookupService.lookup({ word: "went" })
    }));
    expect(result.sanctions).toMatchObject({
      status: "found",
      headword: "sanction",
      relation: "sanctions → sanction"
    });
    expect(result.went).toMatchObject({
      status: "found",
      headword: "go",
      relation: "went → go"
    });
  });
});
