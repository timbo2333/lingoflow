const { test, expect } = require("@playwright/test");

const projectErrors = new WeakMap();

async function waitForAppReady(page) {
  await expect(page.locator("#inputText")).toBeVisible();
  await expect(page.locator("#dictionarySetupStatus")).not.toHaveAttribute(
    "data-state",
    "checking"
  );
}

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
  await waitForAppReady(page);
});

test.afterEach(async ({ page }) => {
  expect(projectErrors.get(page), "页面不应出现项目自身的 JavaScript 错误").toEqual([]);
});

test("Cloud exact hit 优先，不读取 ambiguous Lemma candidates", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const cloudCalls = [];
    let candidateReads = 0;
    const resolver = window.LingoFlowCloudLemmaResolver.create({
      cloudProvider: {
        name: "cloud_test",
        async lookup({ word }) {
          cloudCalls.push(word);
          return {
            status: "found",
            query: word,
            headword: "accounting",
            translation: "会计；核算",
            source: "supabase_core"
          };
        }
      },
      async getLemmaCandidates() {
        candidateReads += 1;
        return [
          { lemma: "account", frequency: 25721 },
          { lemma: "accounting", frequency: 2468 }
        ];
      }
    });

    return {
      outcome: await resolver.lookup({ word: "Accounting" }),
      cloudCalls,
      candidateReads
    };
  });

  expect(result.cloudCalls).toEqual(["accounting"]);
  expect(result.candidateReads).toBe(0);
  expect(result.outcome).toMatchObject({
    status: "found",
    headword: "accounting",
    source: "supabase_core"
  });
  expect(result.outcome.relation).toBeUndefined();
});

test("sanctions exact miss 后通过本地 Lemma 命中 sanction", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const db = await openECDICTDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction("lemmas", "readwrite");
      tx.objectStore("lemmas").put({ form: "sanctions", lemma: "sanction" });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });

    const cloudCalls = [];
    const resolver = window.LingoFlowCloudLemmaResolver.create({
      cloudProvider: {
        name: "cloud_test",
        async lookup({ word }) {
          cloudCalls.push(word);
          if (word === "sanction") {
            return {
              status: "found",
              headword: "sanction",
              phonetic: "/ˈsæŋkʃn/",
              translation: "制裁；批准",
              pos: null,
              source: "supabase_core"
            };
          }
          return { status: "not_found", query: word };
        }
      },
      getLemmaCandidates
    });

    return {
      outcome: await resolver.lookup({ word: "sanctions" }),
      cloudCalls
    };
  });

  expect(result.cloudCalls).toEqual(["sanctions", "sanction"]);
  expect(result.outcome).toMatchObject({
    status: "found",
    query: "sanctions",
    headword: "sanction",
    relation: "sanctions → sanction",
    source: "supabase_core"
  });
});

test("真实 Lemma 数据覆盖 -ed、-ing、-s/-es 与 irregular form", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const mappings = {
      looked: [{ lemma: "look", frequency: 119946 }],
      having: [{ lemma: "have", frequency: 1315648 }],
      goes: [{ lemma: "go", frequency: 227247 }],
      went: [{ lemma: "go", frequency: 227247 }]
    };
    const outcomes = {};
    const calls = {};

    for (const [surface, candidates] of Object.entries(mappings)) {
      calls[surface] = [];
      const resolver = window.LingoFlowCloudLemmaResolver.create({
        cloudProvider: {
          name: "cloud_test",
          async lookup({ word }) {
            calls[surface].push(word);
            if (word === candidates[0].lemma) {
              return {
                status: "found",
                headword: word,
                translation: `${word} 的释义`,
                source: "supabase_core"
              };
            }
            return { status: "not_found", query: word };
          }
        },
        getLemmaCandidates: async () => candidates
      });
      outcomes[surface] = await resolver.lookup({ word: surface });
    }

    return { outcomes, calls };
  });

  expect(result.calls).toEqual({
    looked: ["looked", "look"],
    having: ["having", "have"],
    goes: ["goes", "go"],
    went: ["went", "go"]
  });
  expect(result.outcomes.looked.relation).toBe("looked → look");
  expect(result.outcomes.having.relation).toBe("having → have");
  expect(result.outcomes.goes.relation).toBe("goes → go");
  expect(result.outcomes.went.relation).toBe("went → go");
});

test("ambiguous exact miss 按 Lemma frequency 排序并依次尝试", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const cloudCalls = [];
    const resolver = window.LingoFlowCloudLemmaResolver.create({
      cloudProvider: {
        name: "cloud_test",
        async lookup({ word }) {
          cloudCalls.push(word);
          if (word === "leaf") {
            return {
              status: "found",
              headword: "leaf",
              translation: "叶子",
              source: "supabase_core"
            };
          }
          return { status: "not_found", query: word };
        }
      },
      getLemmaCandidates: async () => [
        { lemma: "leaf", frequency: 5117 },
        { lemma: "leave", frequency: 63376 }
      ]
    });

    return {
      outcome: await resolver.lookup({ word: "leaves" }),
      cloudCalls
    };
  });

  expect(result.cloudCalls).toEqual(["leaves", "leave", "leaf"]);
  expect(result.outcome).toMatchObject({
    status: "found",
    headword: "leaf",
    relation: "leaves → leaf"
  });
});

test("所有 Lemma candidates miss 时返回 not_found", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const cloudCalls = [];
    const resolver = window.LingoFlowCloudLemmaResolver.create({
      cloudProvider: {
        name: "cloud_test",
        async lookup({ word }) {
          cloudCalls.push(word);
          return { status: "not_found", query: word };
        }
      },
      getLemmaCandidates: async () => [
        { lemma: "leave", frequency: 63376 },
        { lemma: "leaf", frequency: 5117 }
      ]
    });
    return {
      outcome: await resolver.lookup({ word: "leaves" }),
      cloudCalls
    };
  });

  expect(result.cloudCalls).toEqual(["leaves", "leave", "leaf"]);
  expect(result.outcome).toEqual({ status: "not_found", query: "leaves" });
});

test("显式 ready + candidates contract 可完成 Lemma lookup", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const calls = [];
    const resolver = window.LingoFlowCloudLemmaResolver.create({
      cloudProvider: {
        name: "cloud_test",
        async lookup({ word }) {
          calls.push(word);
          if (word === "sanction") {
            return {
              status: "found",
              headword: word,
              translation: "制裁",
              source: "supabase_core"
            };
          }
          return { status: "not_found", query: word };
        }
      },
      getLemmaCandidates: async () => ({
        status: "ready",
        candidates: [{ lemma: "sanction", frequency: 2104 }]
      })
    });
    return { outcome: await resolver.lookup({ word: "sanctions" }), calls };
  });

  expect(result.calls).toEqual(["sanctions", "sanction"]);
  expect(result.outcome).toMatchObject({
    status: "found",
    relation: "sanctions → sanction"
  });
});

test("Lemma candidate source unavailable 不伪装成 not_found", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const calls = [];
    const resolver = window.LingoFlowCloudLemmaResolver.create({
      cloudProvider: {
        name: "cloud_test",
        async lookup({ word }) {
          calls.push(word);
          return { status: "not_found", query: word };
        }
      },
      getLemmaCandidates: async () => ({
        status: "unavailable",
        reason: "lemma_pack_manifest_unavailable"
      })
    });
    return { outcome: await resolver.lookup({ word: "sanctions" }), calls };
  });

  expect(result.calls).toEqual(["sanctions"]);
  expect(result.outcome).toEqual({
    status: "unavailable",
    query: "sanctions",
    reason: "lemma_pack_manifest_unavailable"
  });
});

test("无效 Lemma candidate source response 按 unavailable 处理", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const resolver = window.LingoFlowCloudLemmaResolver.create({
      cloudProvider: {
        name: "cloud_test",
        async lookup({ word }) { return { status: "not_found", query: word }; }
      },
      getLemmaCandidates: async () => ({ candidates: [] })
    });
    return await resolver.lookup({ word: "sanctions" });
  });

  expect(result).toEqual({
    status: "unavailable",
    query: "sanctions",
    reason: "lemma_candidates_invalid_response"
  });
});

test("Cloud exact unavailable 时立即停止，不读取或请求 Lemma", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const cloudCalls = [];
    let candidateReads = 0;
    const resolver = window.LingoFlowCloudLemmaResolver.create({
      cloudProvider: {
        name: "cloud_test",
        async lookup({ word }) {
          cloudCalls.push(word);
          return { status: "unavailable", query: word, reason: "cloud_timeout" };
        }
      },
      async getLemmaCandidates() {
        candidateReads += 1;
        return [{ lemma: "sanction", frequency: 2104 }];
      }
    });
    return {
      outcome: await resolver.lookup({ word: "sanctions" }),
      cloudCalls,
      candidateReads
    };
  });

  expect(result.cloudCalls).toEqual(["sanctions"]);
  expect(result.candidateReads).toBe(0);
  expect(result.outcome).toEqual({
    status: "unavailable",
    query: "sanctions",
    reason: "cloud_timeout"
  });
});

test("Lemma RPC unavailable 时停止 fan-out，并让 Lookup Service 进入 Legacy fallback", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const cloudCalls = [];
    const resolver = window.LingoFlowCloudLemmaResolver.create({
      cloudProvider: {
        name: "cloud_test",
        async lookup({ word }) {
          cloudCalls.push(word);
          if (word === "leave") {
            return { status: "unavailable", query: word, reason: "cloud_unavailable" };
          }
          return { status: "not_found", query: word };
        }
      },
      getLemmaCandidates: async () => [
        { lemma: "leave", frequency: 63376 },
        { lemma: "leaf", frequency: 5117 }
      ]
    });
    window.LingoFlowDictionaryLookupService.setProviders([
      resolver,
      {
        name: "legacy_test",
        async lookup() {
          return {
            status: "found",
            headword: "leaves",
            translation: "Legacy 后备结果",
            source: "legacy_test"
          };
        }
      }
    ]);

    return {
      outcome: await window.LingoFlowDictionaryLookupService.lookup({ word: "leaves" }),
      cloudCalls
    };
  });

  expect(result.cloudCalls).toEqual(["leaves", "leave"]);
  expect(result.outcome).toMatchObject({
    status: "found",
    translation: "Legacy 后备结果",
    source: "legacy_test"
  });
});

test("默认只尝试两个 Lemma candidates，单次 lookup 最多三个 Cloud RPC", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const cloudCalls = [];
    const resolver = window.LingoFlowCloudLemmaResolver.create({
      cloudProvider: {
        name: "cloud_test",
        async lookup({ word }) {
          cloudCalls.push(word);
          return { status: "not_found", query: word };
        }
      },
      getLemmaCandidates: async () => [
        { lemma: "bath", frequency: 4457 },
        { lemma: "bathe", frequency: 444 },
        { lemma: "bthe", frequency: 311 },
        { lemma: "bathing", frequency: 158 }
      ]
    });
    return {
      outcome: await resolver.lookup({ word: "bathing" }),
      cloudCalls
    };
  });

  expect(result.cloudCalls).toEqual(["bathing", "bath", "bathe"]);
  expect(result.outcome.status).toBe("not_found");
});

test("Lemma import 保留 multiple candidates 与 frequency，同时兼容旧单值读取", async ({ page }) => {
  const result = await page.evaluate(async () => {
    await clearLemmaEntries();
    const source = [
      "leave/63376 -> leaves",
      "leaf/5117 -> leaves"
    ].join("\n");
    await importLemmaReadableStream(new Blob([source]).stream());

    return {
      legacyEntry: await getLemmaEntry("leaves"),
      candidates: await getLemmaCandidates("leaves")
    };
  });

  expect(result.legacyEntry).toMatchObject({
    form: "leaves",
    lemma: "leaf"
  });
  expect(result.candidates).toEqual([
    { lemma: "leave", frequency: 63376 },
    { lemma: "leaf", frequency: 5117 }
  ]);
});

test("Reader 与 directSearch 不直接依赖 Lemma / Cloud 实现", async ({ page }) => {
  const result = await page.evaluate(() => ({
    reader: showWordCard.toString(),
    search: directSearch.toString()
  }));

  for (const source of [result.reader, result.search]) {
    expect(source).toContain("LingoFlowDictionaryLookupService.lookup");
    expect(source).not.toMatch(/getLemma|CloudLemma|Supabase|lookup_dictionary|\.rpc\s*\(/);
  }
});

test("Cloud Lemma capability 已作为生产默认，并保留 Legacy fallback", async ({ page }) => {
  const result = await page.evaluate(() => {
    const scripts = Array.from(document.scripts, script => (
      new URL(script.src, location.href).pathname
    ));
    return {
      cloudProviderIndex: scripts.indexOf("/js/supabase-dictionary-provider.js"),
      resolverIndex: scripts.indexOf("/js/cloud-lemma-resolver.js"),
      legacyIndex: scripts.indexOf("/js/legacy-ecdict-provider.js"),
      providers: window.LingoFlowDictionaryLookupService.getProviderNames()
    };
  });

  expect(result.resolverIndex).toBeGreaterThan(result.cloudProviderIndex);
  expect(result.legacyIndex).toBeGreaterThan(result.resolverIndex);
  expect(result.providers).toEqual(["cloud_lemma_resolver", "legacy_ecdict"]);
});
