/* =========================
   V0.5.1 内置增强词库
   ========================= */

const basicDictionary = {
  apple: {
    phonetic: "/ˈæpəl/",
    pos: "noun",
    meaning: "苹果"
  },
  friend: {
    phonetic: "/frend/",
    pos: "noun",
    meaning: "朋友"
  },
  friends: {
    phonetic: "/frendz/",
    pos: "noun",
    meaning: "朋友；friend 的复数"
  },
  like: {
    phonetic: "/laɪk/",
    pos: "verb / prep.",
    meaning: "喜欢；像；类似于"
  },
  talk: {
    phonetic: "/tɔːk/",
    pos: "verb",
    meaning: "说话；交谈"
  },
  talking: {
    phonetic: "/ˈtɔːkɪŋ/",
    pos: "verb",
    meaning: "交谈；talk 的现在分词"
  },
  ask: {
    phonetic: "/æsk/",
    pos: "verb",
    meaning: "询问；请求"
  },
  asked: {
    phonetic: "/æskt/",
    pos: "verb",
    meaning: "询问；请求；ask 的过去式"
  },
  help: {
    phonetic: "/help/",
    pos: "verb / noun",
    meaning: "帮助；协助"
  },
  helped: {
    phonetic: "/helpt/",
    pos: "verb",
    meaning: "帮助；help 的过去式"
  },
  idea: {
    phonetic: "/aɪˈdɪə/",
    pos: "noun",
    meaning: "想法；主意"
  },
  ideas: {
    phonetic: "/aɪˈdɪəz/",
    pos: "noun",
    meaning: "想法；主意；idea 的复数"
  },
  little: {
    phonetic: "/ˈlɪtəl/",
    pos: "adj. / adv.",
    meaning: "小的；少量的；一点"
  },
  problem: {
    phonetic: "/ˈprɒbləm/",
    pos: "noun",
    meaning: "问题；困难"
  },
  solve: {
    phonetic: "/sɒlv/",
    pos: "verb",
    meaning: "解决；解答"
  },
  someone: {
    phonetic: "/ˈsʌmwʌn/",
    pos: "pronoun",
    meaning: "某人；有人"
  },
  some: {
    phonetic: "/sʌm/",
    pos: "determiner / pronoun",
    meaning: "一些；某些"
  },
  give: {
    phonetic: "/ɡɪv/",
    pos: "verb",
    meaning: "给；给予"
  },
  gave: {
    phonetic: "/ɡeɪv/",
    pos: "verb",
    meaning: "给；give 的过去式"
  },
  still: {
    phonetic: "/stɪl/",
    pos: "adv.",
    meaning: "仍然；依然"
  },
  feel: {
    phonetic: "/fiːl/",
    pos: "verb",
    meaning: "感觉；觉得"
  },
  felt: {
    phonetic: "/felt/",
    pos: "verb",
    meaning: "感觉；feel 的过去式"
  },
  might: {
    phonetic: "/maɪt/",
    pos: "modal verb",
    meaning: "可能；也许"
  },
  but: {
    phonetic: "/bʌt/",
    pos: "conjunction",
    meaning: "但是；可是"
  },
  their: {
    phonetic: "/ðeə/",
    pos: "determiner",
    meaning: "他们的；她们的；它们的"
  },
  me: {
    phonetic: "/miː/",
    pos: "pronoun",
    meaning: "我；宾格"
  },
  my: {
    phonetic: "/maɪ/",
    pos: "determiner",
    meaning: "我的"
  },
  the: {
    phonetic: "/ðə/ /ðiː/",
    pos: "article",
    meaning: "这；那；这些；那些（定冠词）"
  },
  a: {
    phonetic: "/ə/ /eɪ/",
    pos: "article",
    meaning: "一个；一（不定冠词）"
  },
  an: {
    phonetic: "/ən/ /æn/",
    pos: "article",
    meaning: "一个；一（用于元音音素前）"
  },
  and: {
    phonetic: "/ænd/",
    pos: "conjunction",
    meaning: "和；而且"
  },
  to: {
    phonetic: "/tuː/ /tə/",
    pos: "prep. / infinitive marker",
    meaning: "到；向；用于不定式"
  },
  for: {
    phonetic: "/fɔːr/",
    pos: "preposition",
    meaning: "为了；对于；给"
  },
  of: {
    phonetic: "/əv/",
    pos: "preposition",
    meaning: "……的；属于"
  },
  in: {
    phonetic: "/ɪn/",
    pos: "preposition",
    meaning: "在……里面；在……中"
  },
  on: {
    phonetic: "/ɒn/",
    pos: "preposition",
    meaning: "在……上；关于"
  },
  is: {
    phonetic: "/ɪz/",
    pos: "verb",
    meaning: "是；be 的第三人称单数"
  },
  was: {
    phonetic: "/wɒz/",
    pos: "verb",
    meaning: "是；be 的过去式"
  },
  i: {
    phonetic: "/aɪ/",
    pos: "pronoun",
    meaning: "我"
  },
  when: {
    phonetic: "/wen/",
    pos: "adv. / conjunction",
    meaning: "什么时候；当……的时候"
  },
  very: {
    phonetic: "/ˈveri/",
    pos: "adverb",
    meaning: "非常；很"
  },
  can: {
    phonetic: "/kæn/",
    pos: "modal verb",
    meaning: "能够；可以"
  },
  bring: {
    phonetic: "/brɪŋ/",
    pos: "verb",
    meaning: "带来；拿来"
  },
  protecting: {
    phonetic: "/prəˈtektɪŋ/",
    pos: "verb",
    meaning: "保护；protect 的现在分词"
  }
};

const ieltsDictionary = {
  nervous: {
    phonetic: "/ˈnɜːvəs/",
    pos: "adjective",
    meaning: "紧张的；焦虑的；不安的",
    ielts: "口语中非常常用。常见搭配：feel nervous、get nervous、be nervous about。近义表达有 anxious、uneasy。"
  },
  advice: {
    phonetic: "/ədˈvaɪs/",
    pos: "noun",
    meaning: "建议；忠告",
    ielts: "注意 advice 是不可数名词。不能说 an advice。可以说 a piece of advice。常见搭配：give advice、ask for advice、seek advice。"
  },
  trouble: {
    phonetic: "/ˈtrʌbəl/",
    pos: "noun / verb",
    meaning: "麻烦；困难；问题；使烦恼",
    ielts: "常见表达：have trouble doing something，意思是“做某事有困难”。"
  },
  suggestion: {
    phonetic: "/səˈdʒestʃən/",
    pos: "noun",
    meaning: "建议；提议",
    ielts: "常见搭配：make a suggestion、offer a suggestion。写作中可以用于提出解决方案。"
  },
  suggestions: {
    phonetic: "/səˈdʒestʃənz/",
    pos: "noun",
    meaning: "建议；suggestion 的复数",
    ielts: "常见搭配：make suggestions、provide suggestions。"
  },
  important: {
    phonetic: "/ɪmˈpɔːtənt/",
    pos: "adjective",
    meaning: "重要的",
    ielts: "雅思写作中不要反复使用 important。可根据语境替换为 significant、crucial、essential、vital。"
  },
  significant: {
    phonetic: "/sɪɡˈnɪfɪkənt/",
    pos: "adjective",
    meaning: "重要的；显著的；意义重大的",
    ielts: "雅思写作常用。常见搭配：significant impact、significant increase、significant difference。"
  },
  environment: {
    phonetic: "/ɪnˈvaɪrənmənt/",
    pos: "noun",
    meaning: "环境；周围状况",
    ielts: "环境类是雅思写作高频话题。常见搭配：protect the environment、environmental problems、natural environment。"
  },
  benefit: {
    phonetic: "/ˈbenɪfɪt/",
    pos: "noun / verb",
    meaning: "好处；益处；使受益",
    ielts: "写作高频词。常见表达：bring benefits、benefit from、be beneficial to。"
  },
  benefits: {
    phonetic: "/ˈbenɪfɪts/",
    pos: "noun",
    meaning: "好处；益处；benefit 的复数",
    ielts: "写作高频表达：bring significant benefits、provide benefits、long-term benefits。"
  },
  solution: {
    phonetic: "/səˈluːʃən/",
    pos: "noun",
    meaning: "解决办法；答案",
    ielts: "问题解决类作文常用。常见搭配：find a solution、effective solution、long-term solution、solution to a problem。"
  }
};

/* =========================
   语音
   ========================= */

let voices = [];
let currentSpokenWord = "";
let speechTimer = null;
let speechRequestId = 0;
const SPEECH_RATE_VALUES = new Set(["0.7", "0.85", "1", "1.15"]);

function normalizeSpeechRate(value) {
  const normalized = String(value ?? "1");
  return SPEECH_RATE_VALUES.has(normalized) ? normalized : "1";
}

function getSavedSpeechVoice() {
  const saved = getReadingPreferences().speechVoice;
  if (!saved || typeof saved !== "object" || !saved.name || !saved.lang) return null;

  return {
    name: String(saved.name),
    lang: String(saved.lang),
    voiceURI: String(saved.voiceURI || "")
  };
}

function getSpeechRate() {
  return normalizeSpeechRate(getReadingPreferences().speechRate);
}

function getVoiceStableId(voice) {
  return encodeURIComponent(JSON.stringify([
    voice?.name || "",
    voice?.lang || "",
    voice?.voiceURI || ""
  ]));
}

function getVoicePreference(voice) {
  return voice ? {
    name: voice.name || "",
    lang: voice.lang || "",
    voiceURI: voice.voiceURI || ""
  } : null;
}

function resolvePreferredVoice(preference, availableVoices = voices) {
  const list = Array.from(availableVoices || []);
  const englishVoices = list.filter(voice =>
    String(voice.lang || "").toLowerCase().startsWith("en")
  );

  if (preference) {
    const savedLang = preference.lang.toLowerCase();
    const exactVoice = preference.voiceURI && list.find(voice =>
      voice.name === preference.name &&
      String(voice.lang || "").toLowerCase() === savedLang &&
      voice.voiceURI === preference.voiceURI
    );
    if (exactVoice) return exactVoice;

    const nameAndLanguage = list.find(voice =>
      voice.name === preference.name &&
      String(voice.lang || "").toLowerCase() === savedLang
    );
    if (nameAndLanguage) return nameAndLanguage;

    const sameLanguage = list.find(voice =>
      String(voice.lang || "").toLowerCase() === savedLang
    );
    if (sameLanguage) return sameLanguage;

    if (englishVoices.length) return englishVoices[0];
    return null;
  }

  return englishVoices.find(voice => voice.lang === "en-US" && voice.localService) ||
    englishVoices.find(voice => voice.localService) ||
    englishVoices.find(voice => voice.lang === "en-US") ||
    englishVoices[0] ||
    null;
}

function populateVoiceSelect(select, selectedVoice) {
  if (!select) return;

  select.innerHTML = '<option value="">自动选择</option>';

  voices.forEach(voice => {
    if (!String(voice.lang || "").toLowerCase().startsWith("en")) return;

    const option = document.createElement("option");
    option.value = getVoiceStableId(voice);
    option.textContent = `${voice.name} (${voice.lang})`;
    select.appendChild(option);
  });

  const selectedValue = selectedVoice ? getVoiceStableId(selectedVoice) : "";
  select.value = Array.from(select.options).some(option => option.value === selectedValue)
    ? selectedValue
    : "";
}

function syncSpeechPreferenceControls() {
  const rate = getSpeechRate();
  ["speed", "settingsSpeechRate"].forEach(id => {
    const select = document.getElementById(id);
    if (select) select.value = rate;
  });

  const savedVoice = getSavedSpeechVoice();
  const selectedVoice = savedVoice ? resolvePreferredVoice(savedVoice) : null;
  populateVoiceSelect(document.getElementById("voiceSelect"), selectedVoice);
  populateVoiceSelect(document.getElementById("settingsVoiceSelect"), selectedVoice);
}

function saveSpeechPreferences(patch) {
  const preferences = {
    ...getReadingPreferences(),
    ...patch
  };
  localStorage.setItem(READING_PREFS_KEY, JSON.stringify(preferences));
  syncSpeechPreferenceControls();
}

function handleSpeechVoiceChange(value) {
  const selectedVoice = value
    ? voices.find(voice => getVoiceStableId(voice) === value) || null
    : null;
  saveSpeechPreferences({ speechVoice: getVoicePreference(selectedVoice) });
}

function handleSpeechRateChange(value) {
  saveSpeechPreferences({ speechRate: normalizeSpeechRate(value) });
}

function applyAvailableVoices(availableVoices) {
  voices = Array.from(availableVoices || []);
  syncSpeechPreferenceControls();
}

function loadVoices() {
  applyAvailableVoices(speechSynthesis.getVoices());
}

function initializeSpeechPreferences() {
  speechSynthesis.onvoiceschanged = loadVoices;
  loadVoices();
}

function buildUtterance(word) {
  const utterance = new SpeechSynthesisUtterance(word);
  const selectedVoice = resolvePreferredVoice(getSavedSpeechVoice());

  utterance.rate = Number(getSpeechRate());
  utterance.lang = selectedVoice?.lang || "en-US";
  if (selectedVoice) utterance.voice = selectedVoice;

  return utterance;
}

function previewSpeechSettings(button) {
  try {
    speakWord("Hello, welcome to LingoFlow.");
    flashSpeechButton(button, true);
  } catch (error) {
    console.error("Speech preview error:", error);
    flashSpeechButton(button, false);
  }
}

function flashSpeechButton(button, success = true) {
  if (!button) return;

  const original = button.dataset.originalLabel || button.textContent.trim();
  button.dataset.originalLabel = original;
  button.textContent = success ? "🔊 播放中" : "⚠️ 播放失败";
  button.disabled = true;

  setTimeout(() => {
    button.textContent = button.dataset.originalLabel || original;
    button.disabled = false;
  }, success ? 850 : 1300);
}

function speakFavoriteWord(word, button) {
  if (!word) return;
  try {
    speakWord(word);
    flashSpeechButton(button, true);
  } catch (error) {
    console.error("Favorite speech error:", error);
    flashSpeechButton(button, false);
  }
}

function speakHistoryWord(word, button) {
  if (!word) return;
  try {
    speakWord(word);
    flashSpeechButton(button, true);
  } catch (error) {
    console.error("History speech error:", error);
    flashSpeechButton(button, false);
  }
}

function speakWord(word) {
  currentSpokenWord = word;

  // 每次点击生成新的请求号；旧的延迟朗读会自动失效
  const requestId = ++speechRequestId;

  if (speechTimer) {
    clearTimeout(speechTimer);
    speechTimer = null;
  }

  try {
    if (speechSynthesis.paused) speechSynthesis.resume();
    speechSynthesis.cancel();
  } catch (error) {
    console.warn("Speech cancel warning:", error);
  }

  const utterance = buildUtterance(word);

  // Chrome/Windows 下 cancel 后立刻 speak 偶尔会吞掉下一条。
  // 留一个很短的缓冲，快速连续点词时只朗读最后一次点击。
  speechTimer = setTimeout(() => {
    if (requestId !== speechRequestId) return;

    try {
      if (speechSynthesis.paused) speechSynthesis.resume();
      speechSynthesis.speak(utterance);
    } catch (error) {
      console.error("Speech synthesis error:", error);
    }
  }, 55);
}

function repeatCurrentWord() {
  if (currentSpokenWord) speakWord(currentSpokenWord);
}

/* =========================
   ECDICT 本地数据库 + 词典查询
   ========================= */

const ECDICT_DB_NAME = "EnglishReaderECDICT";
const ECDICT_DB_VERSION = 2;
const DICTIONARY_MANIFEST_PATH = "data/dictionary/manifest.json";
const ECDICT_WRITE_BATCH_SIZE = 1500;
const LEMMA_WRITE_BATCH_SIZE = 2500;
const ECDICT_AUTO_VERSION_META = "auto_ecdict_dictionary_version";
const ECDICT_AUTO_CHUNKS_META = "auto_ecdict_completed_chunks";
const ECDICT_AUTO_RECORDS_META = "auto_ecdict_imported_records";
const ECDICT_AUTO_CHECKPOINT_KEYS = [
  ECDICT_AUTO_VERSION_META,
  ECDICT_AUTO_CHUNKS_META,
  ECDICT_AUTO_RECORDS_META
];
const DICTIONARY_GUIDE_DEFERRED_KEY = "EnglishReaderDictionaryGuideDeferred";
const DICTIONARY_WAS_READY_KEY = "EnglishReaderDictionaryWasReady";
let ecdictDbPromise = null;
let dictionaryInitializationPromise = null;
let dictionaryStartupCheckPromise = null;
let dictionaryAutoAbortController = null;
let dictionaryTaskState = "idle";
let dictionaryIntegritySnapshot = null;

function createDictionaryAbortError(message = "词库加载已暂停。") {
  try {
    return new DOMException(message, "AbortError");
  } catch {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
  }
}

function isDictionaryAbortError(error) {
  return error?.name === "AbortError";
}

function throwIfDictionaryTaskAborted(signal) {
  if (signal?.aborted) throw createDictionaryAbortError();
}

function openECDICTDatabase() {
  if (ecdictDbPromise) return ecdictDbPromise;

  ecdictDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(ECDICT_DB_NAME, ECDICT_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains("entries")) {
        db.createObjectStore("entries", { keyPath: "word" });
      }

      if (!db.objectStoreNames.contains("meta")) {
        db.createObjectStore("meta", { keyPath: "key" });
      }

      if (!db.objectStoreNames.contains("lemmas")) {
        db.createObjectStore("lemmas", { keyPath: "form" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return ecdictDbPromise;
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getECDICTMeta(key) {
  const db = await openECDICTDatabase();
  const tx = db.transaction("meta", "readonly");
  return await idbRequest(tx.objectStore("meta").get(key));
}

async function getECDICTMetaValues(keys) {
  const db = await openECDICTDatabase();
  const tx = db.transaction("meta", "readonly");
  const store = tx.objectStore("meta");
  const values = await Promise.all(keys.map(key => idbRequest(store.get(key))));

  return Object.fromEntries(keys.map((key, index) => [key, values[index]?.value]));
}

async function setECDICTMeta(key, value) {
  const db = await openECDICTDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("meta", "readwrite");
    tx.objectStore("meta").put({ key, value });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Meta transaction aborted"));
  });
}

async function setECDICTMetaValues(values, keysToDelete = []) {
  const db = await openECDICTDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("meta", "readwrite");
    const store = tx.objectStore("meta");

    for (const [key, value] of Object.entries(values)) {
      store.put({ key, value });
    }

    for (const key of keysToDelete) store.delete(key);

    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Meta transaction aborted"));
  });
}

async function countECDICTStore(storeName) {
  const db = await openECDICTDatabase();

  if (!db.objectStoreNames.contains(storeName)) {
    throw new Error(`本地词典数据库缺少 ${storeName}，无法在不升级数据库版本的情况下恢复。`);
  }

  const tx = db.transaction(storeName, "readonly");
  return Number(await idbRequest(tx.objectStore(storeName).count()));
}

async function clearECDICTEntries() {
  const db = await openECDICTDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("entries", "readwrite");
    tx.objectStore("entries").clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function writeECDICTBatch(batch) {
  const db = await openECDICTDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("entries", "readwrite");
    const store = tx.objectStore("entries");

    for (const item of batch) store.put(item);

    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  });
}

async function deleteECDICTBatch(batch) {
  const db = await openECDICTDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("entries", "readwrite");
    const store = tx.objectStore("entries");

    for (const item of batch) store.delete(item.word);

    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  });
}

async function getECDICTEntry(word) {
  const db = await openECDICTDatabase();
  const tx = db.transaction("entries", "readonly");
  return await idbRequest(tx.objectStore("entries").get(normalizeWord(word)));
}

function scoreSearchSuggestion(item, prefix) {
  const word = String(item.word || "").toLowerCase();
  const tag = String(item.tag || "").toLowerCase();
  const translation = String(item.translation || "").toLowerCase();

  let score = 0;

  // 考试/常用词标签优先
  const tagWeights = {
    "zk": 75,
    "gk": 90,
    "cet4": 120,
    "cet6": 110,
    "ky": 90,
    "toefl": 95,
    "ielts": 130,
    "gre": 70
  };

  for (const [name, weight] of Object.entries(tagWeights)) {
    if (tag.split(/\s+/).includes(name)) score += weight;
  }

  // 正常常用词优先于缩写、人名、药名、极生僻专名
  if (/\babbr\b|缩写/.test(translation)) score -= 110;
  if (/\[人名\]|\[地名\]|\[医\]|\[药\]|\[化\]|\[商标\]/.test(translation)) score -= 95;

  // 有正常中文释义、词性、音标时稍微加分
  if (item.translation) score += 15;
  if (item.pos) score += 8;
  if (item.phonetic) score += 6;

  // 和输入长度接近的候选更靠前，但不会压过常用词标签
  const extraLength = Math.max(0, word.length - prefix.length);
  score += Math.max(0, 34 - extraLength * 4);

  // 完全等于输入只小幅加分，避免 "deve" 这种缩写霸榜
  if (word === prefix) score += 18;

  // 纯英文字母的常规单词略优先
  if (/^[a-z]+$/.test(word)) score += 8;

  return score;
}

async function getECDICTPrefix(prefix, limit = 8) {
  const p = normalizeWord(prefix);
  if (!p) return [];

  const db = await openECDICTDatabase();
  const tx = db.transaction("entries", "readonly");
  const store = tx.objectStore("entries");
  const range = IDBKeyRange.bound(p, p + "\uffff");

  // 先多取一些候选，再在内存里做轻量排序。
  // 这样不需要改 77 万词的数据库结构，也不需要重新导入。
  const candidates = await new Promise((resolve, reject) => {
    const results = [];
    const request = store.openCursor(range);

    request.onsuccess = () => {
      const cursor = request.result;

      if (!cursor || results.length >= 80) {
        resolve(results);
        return;
      }

      results.push(cursor.value);
      cursor.continue();
    };

    request.onerror = () => reject(request.error);
  });

  return candidates
    .map(item => ({
      ...item,
      __searchScore: scoreSearchSuggestion(item, p)
    }))
    .sort((a, b) => {
      if (b.__searchScore !== a.__searchScore) {
        return b.__searchScore - a.__searchScore;
      }

      if ((a.word || "").length !== (b.word || "").length) {
        return (a.word || "").length - (b.word || "").length;
      }

      return String(a.word || "").localeCompare(String(b.word || ""));
    })
    .slice(0, limit);
}

async function clearLemmaEntries() {
  const db = await openECDICTDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("lemmas", "readwrite");
    tx.objectStore("lemmas").clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function writeLemmaBatch(batch) {
  const db = await openECDICTDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction("lemmas", "readwrite");
    const store = tx.objectStore("lemmas");

    for (const item of batch) store.put(item);

    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Lemma transaction aborted"));
  });
}

async function getLemmaEntry(form) {
  const db = await openECDICTDatabase();
  const tx = db.transaction("lemmas", "readonly");
  return await idbRequest(tx.objectStore("lemmas").get(normalizeWord(form)));
}

function normalizeWord(word) {
  return word.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, "");
}

function findBuiltInBaseWord(word) {
  const w = normalizeWord(word);

  if (basicDictionary[w] || ieltsDictionary[w]) return w;

  const candidates = [];

  if (w.endsWith("ies") && w.length > 4) candidates.push(w.slice(0, -3) + "y");
  if (w.endsWith("es") && w.length > 3) candidates.push(w.slice(0, -2));
  if (w.endsWith("s") && w.length > 3) candidates.push(w.slice(0, -1));

  if (w.endsWith("ed") && w.length > 4) {
    candidates.push(w.slice(0, -2));
    candidates.push(w.slice(0, -1));
  }

  if (w.endsWith("ing") && w.length > 5) {
    candidates.push(w.slice(0, -3));
    candidates.push(w.slice(0, -3) + "e");
  }

  for (const c of candidates) {
    if (ieltsDictionary[c] || basicDictionary[c]) return c;
  }

  return w;
}

async function lookupWord(word) {
  const normalized = normalizeWord(word);
  const builtInBase = findBuiltInBaseWord(word);

  if (ieltsDictionary[builtInBase]) {
    return {
      ...ieltsDictionary[builtInBase],
      source: "IELTS 雅思增强词库",
      baseWord: builtInBase,
      queriedWord: normalized,
      relationText: builtInBase !== normalized ? `${normalized} → ${builtInBase}` : ""
    };
  }

  try {
    const direct = await getECDICTEntry(normalized);
    const lemmaHit = await getLemmaEntry(normalized);

    // 0.5.1：即使变形词本身在 ECDICT 有条目，也优先补出原形信息。
    if (lemmaHit && lemmaHit.lemma && lemmaHit.lemma !== normalized) {
      const lemmaEntry = await getECDICTEntry(lemmaHit.lemma);

      if (lemmaEntry) {
        return {
          phonetic: direct?.phonetic || lemmaEntry.phonetic || "",
          pos: direct?.pos || lemmaEntry.pos || "",
          meaning: lemmaEntry.translation || direct?.translation || "暂无中文释义",
          surfaceMeaning: direct?.translation || "",
          exchange: lemmaEntry.exchange || "",
          ielts: ((lemmaEntry.tag || direct?.tag || "").split(/\s+/).includes("ielts"))
            ? "这个词在 ECDICT 中带有 IELTS 标签。"
            : "",
          source: "ECDICT + Lemma 词形还原",
          baseWord: lemmaEntry.word,
          queriedWord: normalized,
          relationText: `${normalized} → ${lemmaEntry.word}`
        };
      }
    }

    if (direct) {
      return {
        phonetic: direct.phonetic || "",
        pos: direct.pos || "",
        meaning: direct.translation || "暂无中文释义",
        surfaceMeaning: "",
        exchange: direct.exchange || "",
        ielts: (direct.tag || "").split(/\s+/).includes("ielts")
          ? "这个词在 ECDICT 中带有 IELTS 标签。"
          : "",
        source: "ECDICT 离线词库",
        baseWord: direct.word,
        queriedWord: normalized,
        relationText: ""
      };
    }

    const candidates = [];
    if (normalized.endsWith("ies") && normalized.length > 4)
      candidates.push(normalized.slice(0, -3) + "y");
    if (normalized.endsWith("es") && normalized.length > 3)
      candidates.push(normalized.slice(0, -2));
    if (normalized.endsWith("s") && normalized.length > 3)
      candidates.push(normalized.slice(0, -1));
    if (normalized.endsWith("ed") && normalized.length > 4) {
      candidates.push(normalized.slice(0, -2));
      candidates.push(normalized.slice(0, -1));
    }
    if (normalized.endsWith("ing") && normalized.length > 5) {
      candidates.push(normalized.slice(0, -3));
      candidates.push(normalized.slice(0, -3) + "e");
    }

    for (const c of candidates) {
      const entry = await getECDICTEntry(c);
      if (entry) {
        return {
          phonetic: entry.phonetic || "",
          pos: entry.pos || "",
          meaning: entry.translation || "暂无中文释义",
          surfaceMeaning: "",
          exchange: entry.exchange || "",
          ielts: (entry.tag || "").split(/\s+/).includes("ielts")
            ? "这个词在 ECDICT 中带有 IELTS 标签。"
            : "",
          source: "ECDICT 离线词库（基础词尾还原）",
          baseWord: entry.word,
          queriedWord: normalized,
          relationText: `${normalized} → ${entry.word}`
        };
      }
    }
  } catch (error) {
    console.error("ECDICT lookup error:", error);
  }

  if (basicDictionary[builtInBase]) {
    return {
      ...basicDictionary[builtInBase],
      source: "内置基础词库",
      baseWord: builtInBase,
      queriedWord: normalized,
      relationText: builtInBase !== normalized ? `${normalized} → ${builtInBase}` : ""
    };
  }

  return null;
}

function formatExchange(exchange) {
  if (!exchange) return [];

  const labels = {
    p: "过去式",
    d: "过去分词",
    i: "现在分词",
    3: "第三人称单数",
    r: "比较级",
    t: "最高级",
    s: "复数",
    0: "原形"
  };

  return exchange.split("/").map(part => {
    const idx = part.indexOf(":");
    if (idx < 0) return null;
    const code = part.slice(0, idx);
    const value = part.slice(idx + 1);
    if (!value) return null;
    return `${labels[code] || code}：${value}`;
  }).filter(Boolean);
}

/* =========================
   流式 CSV 解析与导入
   ========================= */

class CSVStreamParser {
  constructor() {
    this.row = [];
    this.field = "";
    this.inQuotes = false;
    this.afterQuote = false;
    this.rowStarted = false;
  }

  feed(text, isFinal = false) {
    const completedRows = [];

    const finishField = () => {
      this.row.push(this.field);
      this.field = "";
    };

    const finishRow = () => {
      finishField();
      completedRows.push(this.row);
      this.row = [];
      this.rowStarted = false;
    };

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      if (this.inQuotes) {
        if (this.afterQuote) {
          if (ch === '"') {
            this.field += '"';
            this.afterQuote = false;
          } else {
            this.inQuotes = false;
            this.afterQuote = false;

            if (ch === ",") {
              finishField();
            } else if (ch === "\n") {
              finishRow();
            } else if (ch !== "\r") {
              throw new Error("CSV 格式错误：引号字段结束后出现了无效字符。");
            }
          }
        } else if (ch === '"') {
          this.afterQuote = true;
        } else {
          this.field += ch;
        }
      } else {
        if (ch === '"' && this.field.length === 0) {
          this.inQuotes = true;
          this.rowStarted = true;
        } else if (ch === ",") {
          this.rowStarted = true;
          finishField();
        } else if (ch === "\n") {
          finishRow();
        } else if (ch !== "\r") {
          this.rowStarted = true;
          this.field += ch;
        }
      }
    }

    if (isFinal) {
      if (this.afterQuote) {
        this.inQuotes = false;
        this.afterQuote = false;
      } else if (this.inQuotes) {
        throw new Error("CSV 格式错误：文件结束时仍有未闭合的引号字段。");
      }

      if (this.rowStarted || this.field.length || this.row.length) finishRow();
    }

    return completedRows;
  }
}

function setDictionaryProgress(percent, visible = true) {
  const progressWrap = document.getElementById("dictProgressWrap");
  const progressBar = document.getElementById("dictProgressBar");
  const value = Math.max(0, Math.min(100, Number(percent) || 0));

  progressWrap.style.display = visible ? "block" : "none";
  progressWrap.setAttribute("aria-valuenow", String(Math.round(value)));
  progressBar.style.width = value + "%";
}

function setDictionarySetupState(state, title, detail, options = {}) {
  const setup = document.getElementById("dictionarySetupStatus");
  const retryButton = document.getElementById("dictionaryRetryButton");
  const cancelButton = document.getElementById("dictionaryCancelButton");
  const manualButton = document.getElementById("dictionaryManualButton");
  const prepareButton = document.getElementById("dictionaryPrepareButton");
  const autoLoading = dictionaryTaskState === "auto-loading";

  setup.dataset.state = state;
  document.getElementById("dictionarySetupTitle").textContent = title;
  document.getElementById("dictionarySetupDetail").textContent = detail;
  retryButton.classList.toggle("show", Boolean(options.showRetry));
  cancelButton.classList.toggle(
    "show",
    options.showCancel ?? autoLoading
  );
  manualButton.classList.toggle(
    "show",
    options.showManual ?? autoLoading
  );
  prepareButton.classList.toggle("show", Boolean(options.showPrepare));
  retryButton.disabled = dictionaryTaskState !== "idle";
  cancelButton.disabled = !autoLoading || Boolean(dictionaryAutoAbortController?.signal.aborted);

  if (typeof options.progress === "number") {
    setDictionaryProgress(options.progress, true);
  } else if (options.hideProgress) {
    setDictionaryProgress(0, false);
  }
}

function setDictionaryGuideVisible(visible, manual = false) {
  const modal = document.getElementById("dictionaryGuideModal");
  const manualActions = document.getElementById("dictionaryGuideManualActions");
  if (!modal || !manualActions) return;

  modal.classList.toggle("show", visible);
  manualActions.classList.toggle("show", visible && manual);
}

function markDictionaryReadyLocally() {
  localStorage.setItem(DICTIONARY_WAS_READY_KEY, "1");
  localStorage.removeItem(DICTIONARY_GUIDE_DEFERRED_KEY);
  setDictionaryGuideVisible(false);
}

function getMissingDictionaryParts(integrity) {
  const missing = [];
  if (!integrity?.ecdict?.complete) missing.push("ECDICT");
  if (!integrity?.lemma?.complete) missing.push("Lemma");
  return missing;
}

function showDictionaryNeedsPreparation(integrity, options = {}) {
  const missing = getMissingDictionaryParts(integrity);
  const missingText = missing.length ? `${missing.join(" 和 ")} 尚未准备好。` : "离线词库尚未准备好。";
  const wasReady = localStorage.getItem(DICTIONARY_WAS_READY_KEY) === "1";
  const deferred = localStorage.getItem(DICTIONARY_GUIDE_DEFERRED_KEY) === "1";
  const forceGuide = Boolean(options.forceGuide || wasReady);

  if (wasReady) {
    localStorage.removeItem(DICTIONARY_GUIDE_DEFERRED_KEY);
    localStorage.removeItem(DICTIONARY_WAS_READY_KEY);
  }

  setDictionarySetupState(
    "needs-choice",
    "词库尚未加载",
    `${missingText} 你仍可阅读文章，需要查词时再准备词库。`,
    {
      showManual: true,
      showPrepare: !forceGuide && deferred,
      hideProgress: true
    }
  );

  if (forceGuide || !deferred) {
    setDictionaryGuideVisible(true, Boolean(options.manual));
  } else {
    setDictionaryGuideVisible(false);
  }
}

function openDictionaryGuide() {
  if (dictionaryIntegritySnapshot?.ecdict.complete && dictionaryIntegritySnapshot?.lemma.complete) {
    setDictionaryGuideVisible(false);
    return;
  }
  setDictionaryGuideVisible(true, false);
}

function deferDictionarySetup() {
  localStorage.setItem(DICTIONARY_GUIDE_DEFERRED_KEY, "1");
  setDictionaryGuideVisible(false);
  setDictionarySetupState(
    "needs-choice",
    "词库尚未加载",
    "可以继续阅读文章；需要查词时，点击“准备词库”即可继续。",
    { showManual: true, showPrepare: true, hideProgress: true }
  );
}

async function showDictionaryManualChoices() {
  if (dictionaryTaskState === "auto-loading") {
    await cancelAutomaticDictionarySetup();
  }

  if (dictionaryTaskState === "manual-importing") {
    setDictionarySetupState(
      "initializing",
      "正在手动导入词库…",
      "请等待当前文件导入完成。",
      { progress: Number(document.getElementById("dictProgressWrap")?.getAttribute("aria-valuenow") || 0) }
    );
    return;
  }

  setDictionaryGuideVisible(true, true);
}

async function requestManualDictionaryFile(kind, closeSettingsFirst = false) {
  if (closeSettingsFirst) closeModal("settingsModal");

  if (dictionaryTaskState === "auto-loading") {
    await cancelAutomaticDictionarySetup();
    setDictionaryGuideVisible(true, true);
    return;
  }

  if (dictionaryTaskState !== "idle") {
    setDictionarySetupState(
      "initializing",
      "词库任务正在进行…",
      "请等待当前词库任务安全结束后再选择文件。",
      { hideProgress: true }
    );
    return;
  }

  const input = document.getElementById(kind === "lemma" ? "lemmaFileInput" : "dictFileInput");
  setDictionaryGuideVisible(false);
  input?.click();
}

function normalizeCSVHeader(row) {
  return row.map((value, index) => {
    const text = String(value || "");
    return (index === 0 ? text.replace(/^\uFEFF/, "") : text).trim().toLowerCase();
  });
}

function getECDICTColumnIndexes(headers) {
  const indexes = {
    word: headers.indexOf("word"),
    phonetic: headers.indexOf("phonetic"),
    translation: headers.indexOf("translation"),
    pos: headers.indexOf("pos"),
    tag: headers.indexOf("tag"),
    exchange: headers.indexOf("exchange")
  };

  if (indexes.word < 0 || indexes.translation < 0) {
    throw new Error("没有识别到 ECDICT 的 CSV 表头。");
  }

  return indexes;
}

function makeECDICTEntry(row, indexes) {
  const rawWord = row[indexes.word] || "";
  const word = rawWord.trim().toLowerCase();
  if (!word) return null;

  return {
    word,
    phonetic: indexes.phonetic >= 0 ? (row[indexes.phonetic] || "") : "",
    translation: indexes.translation >= 0 ? (row[indexes.translation] || "") : "",
    pos: indexes.pos >= 0 ? (row[indexes.pos] || "") : "",
    tag: indexes.tag >= 0 ? (row[indexes.tag] || "") : "",
    exchange: indexes.exchange >= 0 ? (row[indexes.exchange] || "") : ""
  };
}

function headersMatch(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function importECDICTReadableStream(readable, options = {}) {
  if (!readable?.getReader) throw new Error("浏览器没有提供可读取的词典下载流。");

  const parser = new CSVStreamParser();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const reader = readable.getReader();
  let headers = null;
  let indexes = null;
  let batch = [];
  let imported = 0;
  let recordCount = 0;
  let bytesRead = 0;

  const flushBatch = async () => {
    if (!batch.length) return;
    throwIfDictionaryTaskAborted(options.signal);
    const pending = batch;
    batch = [];
    if (!options.validateOnly) {
      await (options.batchWriter || writeECDICTBatch)(pending);
    }
    throwIfDictionaryTaskAborted(options.signal);
    imported += pending.length;
    await new Promise(resolve => setTimeout(resolve, 0));
  };

  const consumeRows = async rows => {
    for (const row of rows) {
      if (!headers) {
        headers = normalizeCSVHeader(row);
        indexes = getECDICTColumnIndexes(headers);

        if (options.expectedHeader && !headersMatch(headers, options.expectedHeader)) {
          throw new Error("词典分片的 CSV 表头与其他分片不一致。");
        }
        continue;
      }

      recordCount++;
      const entry = makeECDICTEntry(row, indexes);
      if (entry) batch.push(entry);

      if (batch.length >= ECDICT_WRITE_BATCH_SIZE) await flushBatch();
    }
  };

  try {
    while (true) {
      throwIfDictionaryTaskAborted(options.signal);
      const { value, done } = await reader.read();
      throwIfDictionaryTaskAborted(options.signal);

      if (done) {
        await consumeRows(parser.feed(decoder.decode(), true));
        break;
      }

      bytesRead += value.byteLength;
      await consumeRows(parser.feed(decoder.decode(value, { stream: true }), false));
      options.onProgress?.({ bytesRead, imported: imported + batch.length, recordCount });
    }
  } catch (error) {
    try { await reader.cancel(); } catch {}
    throw error;
  }

  await flushBatch();

  if (!headers) throw new Error("没有读取到 ECDICT CSV 表头。");
  if (Number.isFinite(options.expectedRecordCount) && recordCount !== options.expectedRecordCount) {
    throw new Error(
      `词典分片记录数不一致：应为 ${options.expectedRecordCount.toLocaleString()} 条，` +
      `实际读取 ${recordCount.toLocaleString()} 条。`
    );
  }

  options.onProgress?.({ bytesRead, imported, recordCount });
  return { headers, imported, recordCount, bytesRead };
}

async function importECDICTCsv(file) {
  const status = document.getElementById("dictImportStatus");

  status.textContent = "ECDICT：准备手动导入…";
  setDictionarySetupState(
    "initializing",
    "正在更新离线词典…",
    "正在读取你选择的 ECDICT 文件。",
    { progress: 0 }
  );

  await setECDICTMetaValues({ ready: false, count: 0 });
  await clearECDICTEntries();

  const result = await importECDICTReadableStream(file.stream(), {
    onProgress: ({ bytesRead, imported }) => {
      const percent = Math.min(99, Math.round(bytesRead / file.size * 100));
      setDictionaryProgress(percent, true);
      status.textContent =
        `ECDICT：正在导入 ${percent}%（约 ${imported.toLocaleString()} 条）`;
    }
  });

  const actualCount = await countECDICTStore("entries");
  if (actualCount !== result.imported) {
    throw new Error(
      `ECDICT 写入校验失败：处理 ${result.imported.toLocaleString()} 条，` +
      `数据库中实际有 ${actualCount.toLocaleString()} 条。`
    );
  }

  await setECDICTMetaValues({
    ready: true,
    count: actualCount,
    dictionaryVersion: "manual",
    importedAt: new Date().toISOString(),
    source: "manual",
    filename: file.name,
    source_file_size: file.size
  }, ECDICT_AUTO_CHECKPOINT_KEYS);

  setDictionaryProgress(100, true);
  status.textContent =
    `✅ ECDICT 已导入：${actualCount.toLocaleString()} 条。现在可以离线查词。`;

  setTimeout(() => {
    setDictionaryProgress(0, false);
  }, 1200);
}

async function importLemmaReadableStream(readable, options = {}) {
  if (!readable?.getReader) throw new Error("浏览器没有提供可读取的词形库下载流。");

  const reader = readable.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let carry = "";
  let batch = [];
  let imported = 0;
  let bytesRead = 0;

  const flushBatch = async () => {
    if (!batch.length) return;
    throwIfDictionaryTaskAborted(options.signal);
    const pending = batch;
    batch = [];
    await writeLemmaBatch(pending);
    throwIfDictionaryTaskAborted(options.signal);
    imported += pending.length;
    await new Promise(resolve => setTimeout(resolve, 0));
  };

  const processLine = async rawLine => {
    const line = rawLine.trim();

    if (!line || line.startsWith(";")) return;

    const arrowIndex = line.indexOf("->");
    if (arrowIndex < 0) return;

    const left = line.slice(0, arrowIndex).trim();
    const right = line.slice(arrowIndex + 2).trim();

    const slashIndex = left.lastIndexOf("/");
    const lemmaRaw = (slashIndex >= 0 ? left.slice(0, slashIndex) : left).trim();
    const lemma = normalizeWord(lemmaRaw);

    if (!lemma) return;

    // 原形自己也保存一份，便于统一查询
    batch.push({ form: lemma, lemma });

    const forms = right.split(",");

    for (const formRaw of forms) {
      const form = normalizeWord(formRaw.trim());
      if (form) batch.push({ form, lemma });
    }

    if (batch.length >= LEMMA_WRITE_BATCH_SIZE) await flushBatch();
  };

  try {
    while (true) {
      throwIfDictionaryTaskAborted(options.signal);
      const { value, done } = await reader.read();
      throwIfDictionaryTaskAborted(options.signal);
      if (done) break;

      bytesRead += value.byteLength;
      carry += decoder.decode(value, { stream: true });
      const lines = carry.split(/\r?\n/);
      carry = lines.pop() || "";

      for (const line of lines) await processLine(line);
      options.onProgress?.({ bytesRead, imported: imported + batch.length });
    }
  } catch (error) {
    try { await reader.cancel(); } catch {}
    throw error;
  }

  carry += decoder.decode();
  if (carry.trim()) await processLine(carry);
  await flushBatch();
  options.onProgress?.({ bytesRead, imported });

  return { imported, bytesRead };
}

async function importLemmaFile(file) {
  const status = document.getElementById("lemmaImportStatus");

  status.textContent = "Lemma：准备手动导入…";
  setDictionarySetupState(
    "initializing",
    "正在更新离线词典…",
    "正在读取你选择的 lemma 文件。",
    { progress: 0 }
  );

  await setECDICTMetaValues({ lemma_ready: false, lemma_count: 0 });
  await clearLemmaEntries();

  await importLemmaReadableStream(file.stream(), {
    onProgress: ({ bytesRead, imported }) => {
      const percent = Math.min(99, Math.round(bytesRead / file.size * 100));
      setDictionaryProgress(percent, true);
      status.textContent =
        `Lemma：正在导入 ${percent}%（约 ${imported.toLocaleString()} 条映射）`;
    }
  });

  const actualCount = await countECDICTStore("lemmas");
  if (actualCount <= 0) throw new Error("Lemma 文件没有生成任何可用的词形映射。");

  await setECDICTMetaValues({
    lemma_ready: true,
    lemma_count: actualCount,
    lemma_dictionaryVersion: "manual",
    lemma_importedAt: new Date().toISOString(),
    lemma_source: "manual",
    lemma_filename: file.name,
    lemma_source_file_size: file.size
  });

  setDictionaryProgress(100, true);
  status.textContent =
    `✅ Lemma 已导入：${actualCount.toLocaleString()} 条词形映射。`;

  setTimeout(() => {
    setDictionaryProgress(0, false);
  }, 1200);
}

async function inspectDictionaryIntegrity() {
  const db = await openECDICTDatabase();
  const requiredStores = ["entries", "lemmas", "meta"];
  const missingStores = requiredStores.filter(name => !db.objectStoreNames.contains(name));

  if (missingStores.length) {
    throw new Error(
      `本地数据库缺少 ${missingStores.join("、")}。本次实现不会擅自升级数据库版本。`
    );
  }

  const keys = [
    "ready", "count", "dictionaryVersion", "importedAt", "source",
    "lemma_ready", "lemma_count", "lemma_dictionaryVersion", "lemma_importedAt", "lemma_source"
  ];
  const [meta, entriesCount, lemmasCount] = await Promise.all([
    getECDICTMetaValues(keys),
    countECDICTStore("entries"),
    countECDICTStore("lemmas")
  ]);

  const recordedEntries = Number(meta.count || 0);
  const recordedLemmas = Number(meta.lemma_count || 0);
  const managedECDICT = meta.source === "web-auto" || meta.source === "manual";
  const managedLemma = meta.lemma_source === "web-auto" || meta.lemma_source === "manual";
  const ecdictMetadataComplete = !managedECDICT || Boolean(
    meta.dictionaryVersion && meta.importedAt && meta.source
  );
  const lemmaMetadataComplete = !managedLemma || Boolean(
    meta.lemma_dictionaryVersion && meta.lemma_importedAt && meta.lemma_source
  );

  const ecdictComplete =
    meta.ready === true &&
    recordedEntries > 0 &&
    entriesCount > 0 &&
    entriesCount === recordedEntries &&
    ecdictMetadataComplete;

  // 旧版 Lemma 的 meta 记录的是写入尝试次数，重复 form 会覆盖，因此旧数据
  // 不强求 meta 与实际 store 数量相等；本版本产生的数据会记录实际唯一键数量。
  const lemmaCountValid = managedLemma
    ? lemmasCount === recordedLemmas
    : lemmasCount > 0;
  const lemmaComplete =
    meta.lemma_ready === true &&
    recordedLemmas > 0 &&
    lemmasCount > 0 &&
    lemmaCountValid &&
    lemmaMetadataComplete;

  return {
    ecdict: {
      complete: ecdictComplete,
      ready: meta.ready === true,
      recordedCount: recordedEntries,
      actualCount: entriesCount,
      dictionaryVersion: meta.dictionaryVersion || "",
      source: meta.source || "legacy"
    },
    lemma: {
      complete: lemmaComplete,
      ready: meta.lemma_ready === true,
      recordedCount: recordedLemmas,
      actualCount: lemmasCount,
      dictionaryVersion: meta.lemma_dictionaryVersion || "",
      source: meta.lemma_source || "legacy"
    }
  };
}

function renderDictionaryIntegrity(integrity) {
  const status = document.getElementById("dictImportStatus");
  const lemmaStatus = document.getElementById("lemmaImportStatus");

  status.textContent = integrity.ecdict.complete
    ? `✅ ECDICT 已就绪：${integrity.ecdict.actualCount.toLocaleString()} 条`
    : `ECDICT 需要恢复（本地实际 ${integrity.ecdict.actualCount.toLocaleString()} 条）`;

  lemmaStatus.textContent = integrity.lemma.complete
    ? `✅ Lemma 已就绪：${integrity.lemma.actualCount.toLocaleString()} 条映射`
    : `Lemma 需要恢复（本地实际 ${integrity.lemma.actualCount.toLocaleString()} 条映射）`;
}

async function refreshDictionaryStatus(options = {}) {
  const status = document.getElementById("dictImportStatus");
  const lemmaStatus = document.getElementById("lemmaImportStatus");

  if (!("indexedDB" in window)) {
    status.textContent = "当前浏览器不支持本地词库数据库。建议使用 Chrome。";
    lemmaStatus.textContent = "Lemma 无法使用。";
    return;
  }

  try {
    const integrity = await inspectDictionaryIntegrity();
    dictionaryIntegritySnapshot = integrity;
    renderDictionaryIntegrity(integrity);

    if (integrity.ecdict.complete && integrity.lemma.complete) {
      markDictionaryReadyLocally();
      setDictionarySetupState(
        "ready",
        "离线词典已就绪",
        `ECDICT ${integrity.ecdict.actualCount.toLocaleString()} 条 · ` +
          `Lemma ${integrity.lemma.actualCount.toLocaleString()} 条映射。日常查询无需联网。`,
        { showCancel: false, showManual: false, hideProgress: true }
      );
    } else {
      showDictionaryNeedsPreparation(integrity, {
        forceGuide: Boolean(options.forceGuide),
        manual: Boolean(options.manual)
      });
    }
  } catch (error) {
    console.error(error);
    status.textContent = "本地词库状态读取失败。";
    lemmaStatus.textContent = "词形库状态读取失败。";
    setDictionarySetupState(
      "error",
      "无法检查离线词典",
      error.message || "本地数据库读取失败。",
      { showManual: true, showPrepare: true, hideProgress: true }
    );
  }

  updateVocabBadges();
}

function validateDictionaryManifest(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("词典资源清单格式不正确。");
  }

  if (typeof manifest.dictionaryVersion !== "string" || !manifest.dictionaryVersion.trim()) {
    throw new Error("词典资源清单缺少 dictionaryVersion。");
  }

  const ecdict = manifest.ecdict;
  const chunks = ecdict?.chunks;
  if (!Number.isInteger(ecdict?.totalRecords) || ecdict.totalRecords <= 0) {
    throw new Error("词典资源清单中的 ECDICT 总记录数无效。");
  }
  if (!Array.isArray(chunks) || !chunks.length) {
    throw new Error("词典资源清单中没有 ECDICT 分片。");
  }
  if (ecdict.chunkCount != null && ecdict.chunkCount !== chunks.length) {
    throw new Error("词典资源清单中的分片数量不一致。");
  }

  const safeFilename = /^[A-Za-z0-9._-]+$/;
  const filenames = new Set();
  let chunkRecords = 0;

  for (const chunk of chunks) {
    if (!safeFilename.test(chunk?.filename || "") || filenames.has(chunk.filename)) {
      throw new Error("词典资源清单包含无效或重复的分片文件名。");
    }
    if (!Number.isInteger(chunk.recordCount) || chunk.recordCount < 0) {
      throw new Error(`词典分片 ${chunk.filename} 的记录数无效。`);
    }
    if (!Number.isInteger(chunk.sizeBytes) || chunk.sizeBytes <= 0) {
      throw new Error(`词典分片 ${chunk.filename} 的大小无效。`);
    }
    filenames.add(chunk.filename);
    chunkRecords += chunk.recordCount;
  }

  if (chunkRecords !== ecdict.totalRecords) {
    throw new Error("词典资源清单中的分片记录数之和与总记录数不一致。");
  }

  if (!safeFilename.test(manifest.lemma?.filename || "")) {
    throw new Error("词典资源清单中的 lemma 文件名无效。");
  }
  if (!Number.isInteger(manifest.lemma?.sizeBytes) || manifest.lemma.sizeBytes <= 0) {
    throw new Error("词典资源清单中的 lemma 文件大小无效。");
  }

  return manifest;
}

async function fetchDictionaryManifest(signal) {
  const requestedUrl = new URL(DICTIONARY_MANIFEST_PATH, document.baseURI);
  let response;

  try {
    response = await fetch(requestedUrl, { cache: "no-store", signal });
  } catch (error) {
    if (signal?.aborted || isDictionaryAbortError(error)) {
      throw createDictionaryAbortError();
    }
    throw new Error(`资源清单下载失败：${error.message || "网络连接中断"}`);
  }

  if (!response.ok) {
    throw new Error(`资源清单下载失败（HTTP ${response.status}）。`);
  }

  throwIfDictionaryTaskAborted(signal);
  let manifest;
  try {
    manifest = await response.json();
  } catch (error) {
    if (signal?.aborted || isDictionaryAbortError(error)) {
      throw createDictionaryAbortError();
    }
    throw new Error(`资源清单解析失败：${error.message || "不是有效的 JSON"}`);
  }
  throwIfDictionaryTaskAborted(signal);

  return {
    manifest: validateDictionaryManifest(manifest),
    resourceBaseUrl: new URL("./", response.url || requestedUrl.href)
  };
}

async function fetchDictionaryResource(url, label, signal) {
  let response;

  try {
    response = await fetch(url, { signal });
  } catch (error) {
    if (signal?.aborted || isDictionaryAbortError(error)) {
      throw createDictionaryAbortError();
    }
    throw new Error(`${label}下载失败：${error.message || "网络连接中断"}`);
  }

  if (!response.ok) {
    throw new Error(`${label}下载失败（HTTP ${response.status}）。`);
  }
  if (!response.body) {
    throw new Error(`${label}下载失败：浏览器没有提供响应数据。`);
  }

  return response;
}

async function downloadDictionaryChunkBlob(response, chunk, onProgress, signal) {
  const reader = response.body.getReader();
  const parts = [];
  let bytesRead = 0;

  try {
    while (true) {
      throwIfDictionaryTaskAborted(signal);
      const { value, done } = await reader.read();
      throwIfDictionaryTaskAborted(signal);
      if (done) break;

      parts.push(value);
      bytesRead += value.byteLength;
      onProgress?.(bytesRead);
    }
  } catch (error) {
    try { await reader.cancel(); } catch {}
    if (signal?.aborted || isDictionaryAbortError(error)) {
      throw createDictionaryAbortError();
    }
    throw new Error(`${chunk.filename} 下载中断：${error.message || "网络连接中断"}`);
  }

  if (bytesRead !== chunk.sizeBytes) {
    throw new Error(
      `${chunk.filename} 大小校验失败：应为 ${chunk.sizeBytes.toLocaleString()} bytes，` +
      `实际 ${bytesRead.toLocaleString()} bytes。`
    );
  }

  return new Blob(parts, { type: "text/csv" });
}

async function rollbackAutomaticECDICTChunk(blob, headers, recordCount) {
  await importECDICTReadableStream(blob.stream(), {
    expectedHeader: headers,
    expectedRecordCount: recordCount,
    batchWriter: deleteECDICTBatch
  });
}

function createAutomaticProgress(manifest, needsECDICT, needsLemma) {
  const ecdictBytes = needsECDICT
    ? manifest.ecdict.chunks.reduce((sum, chunk) => sum + chunk.sizeBytes, 0)
    : 0;
  const lemmaBytes = needsLemma ? manifest.lemma.sizeBytes : 0;

  return {
    totalBytes: ecdictBytes + lemmaBytes,
    completedBytes: 0
  };
}

function updateAutomaticProgress(progress, currentBytes, label, extra = "") {
  const processedBytes = Math.min(
    progress.totalBytes,
    progress.completedBytes + Math.max(0, currentBytes)
  );
  const percent = progress.totalBytes > 0
    ? Math.min(99, Math.floor(processedBytes / progress.totalBytes * 100))
    : 0;
  const suffix = extra ? ` · ${extra}` : "";

  setDictionarySetupState(
    "initializing",
    "正在准备离线词典…",
    `${label} · ${percent}% · ${formatBytes(processedBytes)} / ${formatBytes(progress.totalBytes)}${suffix}`,
    { progress: percent }
  );
}

function finishAutomaticProgressResource(progress, sizeBytes) {
  progress.completedBytes = Math.min(
    progress.totalBytes,
    progress.completedBytes + sizeBytes
  );
}

async function importAutomaticECDICT(manifest, resourceBaseUrl, progress, signal) {
  const status = document.getElementById("dictImportStatus");
  const chunks = manifest.ecdict.chunks;
  const sourceSize = chunks.reduce((sum, chunk) => sum + chunk.sizeBytes, 0);
  let expectedHeader = null;
  const checkpointMeta = await getECDICTMetaValues(ECDICT_AUTO_CHECKPOINT_KEYS);
  const checkpointChunks = Number(checkpointMeta[ECDICT_AUTO_CHUNKS_META]);
  const checkpointRecords = Number(checkpointMeta[ECDICT_AUTO_RECORDS_META]);
  const checkpointShapeValid =
    checkpointMeta[ECDICT_AUTO_VERSION_META] === manifest.dictionaryVersion &&
    Number.isInteger(checkpointChunks) &&
    checkpointChunks >= 0 &&
    checkpointChunks <= chunks.length &&
    Number.isInteger(checkpointRecords) &&
    checkpointRecords >= 0;
  const expectedCheckpointRecords = checkpointShapeValid
    ? chunks
        .slice(0, checkpointChunks)
        .reduce((sum, chunk) => sum + chunk.recordCount, 0)
    : -1;
  const actualEntries = await countECDICTStore("entries");
  const checkpointValid =
    checkpointShapeValid &&
    checkpointRecords === expectedCheckpointRecords &&
    actualEntries === expectedCheckpointRecords;

  let startIndex = 0;
  let importedTotal = 0;

  if (checkpointValid) {
    startIndex = checkpointChunks;
    importedTotal = checkpointRecords;
    progress.completedBytes = Math.min(
      progress.totalBytes,
      progress.completedBytes + chunks
        .slice(0, startIndex)
        .reduce((sum, chunk) => sum + chunk.sizeBytes, 0)
    );
    await setECDICTMetaValues({ ready: false, count: 0 });

    if (startIndex > 0) {
      status.textContent =
        `ECDICT：已恢复前 ${startIndex} 个分片，共 ${importedTotal.toLocaleString()} 条`;
    }
  } else {
    throwIfDictionaryTaskAborted(signal);
    await clearECDICTEntries();
    await setECDICTMetaValues({
      ready: false,
      count: 0,
      [ECDICT_AUTO_VERSION_META]: manifest.dictionaryVersion,
      [ECDICT_AUTO_CHUNKS_META]: 0,
      [ECDICT_AUTO_RECORDS_META]: 0
    });
  }

  for (let index = startIndex; index < chunks.length; index++) {
    throwIfDictionaryTaskAborted(signal);
    const chunk = chunks[index];
    const label = `第 ${index + 1} / ${chunks.length} 个词典分片`;
    status.textContent = `ECDICT：正在处理 ${label}`;
    updateAutomaticProgress(progress, 0, label);

    const response = await fetchDictionaryResource(
      new URL(chunk.filename, resourceBaseUrl),
      `词典分片 ${index + 1} / ${chunks.length} `,
      signal
    );

    const chunkBlob = await downloadDictionaryChunkBlob(response, chunk, bytesRead => {
      status.textContent = `ECDICT：${label} · 正在下载`;
      updateAutomaticProgress(
        progress,
        Math.min(bytesRead, chunk.sizeBytes),
        label,
        "正在下载"
      );
    }, signal);

    status.textContent = `ECDICT：${label} · 正在校验`;
    const validation = await importECDICTReadableStream(chunkBlob.stream(), {
      expectedHeader,
      expectedRecordCount: chunk.recordCount,
      validateOnly: true,
      signal
    });

    if (validation.bytesRead !== chunk.sizeBytes) {
      throw new Error(
        `${chunk.filename} 大小校验失败：应为 ${chunk.sizeBytes.toLocaleString()} bytes，` +
        `实际 ${validation.bytesRead.toLocaleString()} bytes。`
      );
    }

    if (validation.imported !== chunk.recordCount) {
      throw new Error(
        `${chunk.filename} 有效记录数校验失败：应为 ${chunk.recordCount.toLocaleString()} 条，` +
        `实际读取 ${validation.imported.toLocaleString()} 条。`
      );
    }

    if (!expectedHeader) expectedHeader = validation.headers;

    const nextImportedTotal = importedTotal + validation.imported;
    let currentChunkWriteStarted = false;

    try {
      const result = await importECDICTReadableStream(chunkBlob.stream(), {
        expectedHeader,
        expectedRecordCount: chunk.recordCount,
        signal,
        batchWriter: async batch => {
          currentChunkWriteStarted = true;
          await writeECDICTBatch(batch);
        },
        onProgress: ({ imported }) => {
          status.textContent =
            `ECDICT：${label} · 已写入 ${imported.toLocaleString()} 条`;
          updateAutomaticProgress(
            progress,
            chunk.sizeBytes,
            label,
            `正在写入 ${imported.toLocaleString()} 条`
          );
        }
      });

      if (result.bytesRead !== chunk.sizeBytes || result.imported !== chunk.recordCount) {
        throw new Error(`${chunk.filename} 写入后的分片校验失败。`);
      }

      const actualCount = await countECDICTStore("entries");
      if (actualCount !== nextImportedTotal) {
        throw new Error(
          `${chunk.filename} 写入校验失败：累计应为 ${nextImportedTotal.toLocaleString()} 条，` +
          `IndexedDB 中实际有 ${actualCount.toLocaleString()} 条。`
        );
      }

      await setECDICTMetaValues({
        [ECDICT_AUTO_VERSION_META]: manifest.dictionaryVersion,
        [ECDICT_AUTO_CHUNKS_META]: index + 1,
        [ECDICT_AUTO_RECORDS_META]: nextImportedTotal
      });
    } catch (error) {
      if (!currentChunkWriteStarted) {
        if (isDictionaryAbortError(error) || signal?.aborted) {
          throw createDictionaryAbortError();
        }
        throw error;
      }

      try {
        await rollbackAutomaticECDICTChunk(
          chunkBlob,
          expectedHeader,
          chunk.recordCount
        );

        const restoredCount = await countECDICTStore("entries");
        if (restoredCount !== importedTotal) {
          throw new Error(
            `回滚后应保留 ${importedTotal.toLocaleString()} 条，` +
            `实际有 ${restoredCount.toLocaleString()} 条。`
          );
        }
      } catch (rollbackError) {
        throw new Error(
          `${chunk.filename} 写入 IndexedDB 失败：${error.message || "写入事务失败"} ` +
          `当前分片回滚失败：${rollbackError.message || "未知错误"}`
        );
      }

      if (isDictionaryAbortError(error) || signal?.aborted) {
        throw createDictionaryAbortError();
      }

      throw new Error(
        `${chunk.filename} 写入 IndexedDB 失败：${error.message || "写入事务失败"} ` +
        "当前分片已移除，之前完成的分片仍然保留。"
      );
    }

    importedTotal = nextImportedTotal;
    finishAutomaticProgressResource(progress, chunk.sizeBytes);
  }

  throwIfDictionaryTaskAborted(signal);

  if (importedTotal !== manifest.ecdict.totalRecords) {
    throw new Error(
      `ECDICT 总记录数校验失败：应为 ${manifest.ecdict.totalRecords.toLocaleString()} 条，` +
      `实际导入 ${importedTotal.toLocaleString()} 条。`
    );
  }

  const actualCount = await countECDICTStore("entries");
  if (actualCount !== manifest.ecdict.totalRecords) {
    throw new Error(
      `IndexedDB ECDICT 校验失败：应为 ${manifest.ecdict.totalRecords.toLocaleString()} 条，` +
      `实际 ${actualCount.toLocaleString()} 条。`
    );
  }

  await setECDICTMetaValues(
    {
      ready: true,
      count: actualCount,
      dictionaryVersion: manifest.dictionaryVersion,
      importedAt: new Date().toISOString(),
      source: "web-auto",
      filename: "manifest.json",
      source_file_size: sourceSize
    },
    ECDICT_AUTO_CHECKPOINT_KEYS
  );

  status.textContent = `✅ ECDICT 已就绪：${actualCount.toLocaleString()} 条`;
}

async function importAutomaticLemma(manifest, resourceBaseUrl, progress, signal) {
  const status = document.getElementById("lemmaImportStatus");
  const label = "正在下载并导入 Lemma";

  throwIfDictionaryTaskAborted(signal);
  await setECDICTMetaValues({ lemma_ready: false, lemma_count: 0 });
  await clearLemmaEntries();
  status.textContent = "Lemma：正在自动恢复";
  updateAutomaticProgress(progress, 0, label);

  const response = await fetchDictionaryResource(
    new URL(manifest.lemma.filename, resourceBaseUrl),
    "Lemma ",
    signal
  );
  const result = await importLemmaReadableStream(response.body, {
    signal,
    onProgress: ({ bytesRead, imported }) => {
      status.textContent = `Lemma：正在导入（约 ${imported.toLocaleString()} 条映射）`;
      updateAutomaticProgress(
        progress,
        Math.min(bytesRead, manifest.lemma.sizeBytes),
        label,
        `约 ${imported.toLocaleString()} 条映射`
      );
    }
  });

  throwIfDictionaryTaskAborted(signal);

  if (result.bytesRead !== manifest.lemma.sizeBytes) {
    throw new Error(
      `Lemma 大小校验失败：应为 ${manifest.lemma.sizeBytes.toLocaleString()} bytes，` +
      `实际 ${result.bytesRead.toLocaleString()} bytes。`
    );
  }
  finishAutomaticProgressResource(progress, manifest.lemma.sizeBytes);

  const actualCount = await countECDICTStore("lemmas");
  if (actualCount <= 0) throw new Error("Lemma 导入完成后没有可用的词形映射。");

  await setECDICTMetaValues({
    lemma_ready: true,
    lemma_count: actualCount,
    lemma_dictionaryVersion: manifest.dictionaryVersion,
    lemma_importedAt: new Date().toISOString(),
    lemma_source: "web-auto",
    lemma_filename: manifest.lemma.filename,
    lemma_source_file_size: manifest.lemma.sizeBytes
  });

  status.textContent = `✅ Lemma 已就绪：${actualCount.toLocaleString()} 条映射`;
}

async function requestPersistentStorageBestEffort() {
  if (!navigator.storage) return false;

  try {
    const alreadyPersistent = typeof navigator.storage.persisted === "function"
      ? await navigator.storage.persisted()
      : false;
    if (alreadyPersistent) return true;

    return typeof navigator.storage.persist === "function"
      ? Boolean(await navigator.storage.persist())
      : false;
  } catch (error) {
    console.warn("Persistent storage request was not available:", error);
    return false;
  }
}

function describeDictionarySetupError(error) {
  if (error?.name === "QuotaExceededError") {
    return "浏览器分配给本站的存储空间不足。请释放空间后重试，或使用手动导入作为备用方案。";
  }
  return error?.message || "发生未知错误。";
}

async function runAutomaticDictionarySetup(signal) {
  if (!("indexedDB" in window)) {
    throw new Error("当前浏览器不支持 IndexedDB，无法保存离线词典。");
  }

  throwIfDictionaryTaskAborted(signal);
  const initialIntegrity = await inspectDictionaryIntegrity();
  dictionaryIntegritySnapshot = initialIntegrity;
  renderDictionaryIntegrity(initialIntegrity);

  if (initialIntegrity.ecdict.complete && initialIntegrity.lemma.complete) {
    markDictionaryReadyLocally();
    setDictionarySetupState(
      "ready",
      "离线词典已就绪",
      "已检测到完整的本地词典，本次没有下载任何词典资源。",
      { showCancel: false, showManual: false, hideProgress: true }
    );
    await requestPersistentStorageBestEffort();
    return initialIntegrity;
  }

  throwIfDictionaryTaskAborted(signal);
  setDictionarySetupState(
    "initializing",
    "正在准备离线词典…",
    "首次使用需要下载约 68 MB，完成后将保存在本机。正在获取资源清单…",
    { progress: 0 }
  );

  const { manifest, resourceBaseUrl } = await fetchDictionaryManifest(signal);
  const needsECDICT = !initialIntegrity.ecdict.complete;
  const needsLemma = !initialIntegrity.lemma.complete;
  const progress = createAutomaticProgress(manifest, needsECDICT, needsLemma);

  if (needsECDICT) {
    await importAutomaticECDICT(manifest, resourceBaseUrl, progress, signal);
  }
  if (needsLemma) {
    await importAutomaticLemma(manifest, resourceBaseUrl, progress, signal);
  }

  throwIfDictionaryTaskAborted(signal);
  const finalIntegrity = await inspectDictionaryIntegrity();
  dictionaryIntegritySnapshot = finalIntegrity;
  renderDictionaryIntegrity(finalIntegrity);
  if (!finalIntegrity.ecdict.complete || !finalIntegrity.lemma.complete) {
    throw new Error("自动恢复结束后，本地词典完整性校验没有通过。");
  }

  markDictionaryReadyLocally();
  setDictionarySetupState(
    "ready",
    "离线词典已就绪",
    `ECDICT ${finalIntegrity.ecdict.actualCount.toLocaleString()} 条 · ` +
      `Lemma ${finalIntegrity.lemma.actualCount.toLocaleString()} 条映射。日常查询无需联网。`,
    { progress: 100, showCancel: false, showManual: false }
  );
  await requestPersistentStorageBestEffort();
  return finalIntegrity;
}

function initializeDictionaryOnStartup() {
  if (dictionaryStartupCheckPromise) return dictionaryStartupCheckPromise;

  setDictionarySetupState(
    "checking",
    "正在检查离线词典…",
    "页面可以正常使用，检查会在后台完成。",
    { showCancel: false, showManual: false, hideProgress: true }
  );

  dictionaryStartupCheckPromise = inspectDictionaryIntegrity()
    .then(async integrity => {
      dictionaryIntegritySnapshot = integrity;
      renderDictionaryIntegrity(integrity);

      if (dictionaryTaskState !== "idle") return integrity;

      if (integrity.ecdict.complete && integrity.lemma.complete) {
        markDictionaryReadyLocally();
        setDictionarySetupState(
          "ready",
          "离线词典已就绪",
          `ECDICT ${integrity.ecdict.actualCount.toLocaleString()} 条 · ` +
            `Lemma ${integrity.lemma.actualCount.toLocaleString()} 条映射。日常查询无需联网。`,
          { showCancel: false, showManual: false, hideProgress: true }
        );
        await requestPersistentStorageBestEffort();
      } else {
        showDictionaryNeedsPreparation(integrity);
      }

      return integrity;
    })
    .catch(error => {
      console.error("Dictionary startup check failed:", error);
      setDictionarySetupState(
        "error",
        "无法检查离线词典",
        describeDictionarySetupError(error),
        { showManual: true, showPrepare: true, hideProgress: true }
      );
    })
    .finally(() => {
      dictionaryStartupCheckPromise = null;
    });

  return dictionaryStartupCheckPromise;
}

function startAutomaticDictionarySetup() {
  if (dictionaryTaskState === "auto-loading" && dictionaryInitializationPromise) {
    return dictionaryInitializationPromise;
  }

  if (dictionaryTaskState !== "idle") {
    setDictionarySetupState(
      "initializing",
      "词库任务正在进行…",
      "请等待当前手动导入安全结束后再开始自动加载。",
      { showCancel: false, showManual: false, hideProgress: true }
    );
    return Promise.resolve(null);
  }

  setDictionaryGuideVisible(false);
  dictionaryTaskState = "auto-loading";
  dictionaryAutoAbortController = new AbortController();
  const signal = dictionaryAutoAbortController.signal;

  dictionaryInitializationPromise = runAutomaticDictionarySetup(signal)
    .catch(async error => {
      try {
        const integrity = await inspectDictionaryIntegrity();
        dictionaryIntegritySnapshot = integrity;
        renderDictionaryIntegrity(integrity);
      } catch {}

      if (isDictionaryAbortError(error)) {
        setDictionarySetupState(
          "paused",
          "加载已暂停，可稍后继续",
          "已经完整完成的词典分片仍保存在本机；再次自动加载会从 checkpoint 继续。",
          {
            showRetry: true,
            showCancel: false,
            showManual: true,
            hideProgress: true
          }
        );
        return null;
      }

      console.error("Automatic dictionary setup failed:", error);
      setDictionarySetupState(
        "error",
        "离线词典准备失败",
        `${describeDictionarySetupError(error)} 已完成的分片仍会保留。`,
        {
          showRetry: true,
          showCancel: false,
          showManual: true,
          hideProgress: true
        }
      );
      return null;
    })
    .finally(() => {
      dictionaryTaskState = "idle";
      dictionaryAutoAbortController = null;
      dictionaryInitializationPromise = null;
      const retryButton = document.getElementById("dictionaryRetryButton");
      const cancelButton = document.getElementById("dictionaryCancelButton");
      if (retryButton) retryButton.disabled = false;
      if (cancelButton) cancelButton.disabled = true;
    });

  return dictionaryInitializationPromise;
}

async function cancelAutomaticDictionarySetup() {
  if (dictionaryTaskState !== "auto-loading" || !dictionaryInitializationPromise) return;

  dictionaryAutoAbortController?.abort();
  setDictionarySetupState(
    "initializing",
    "正在安全暂停词库加载…",
    "正在结束当前请求或回滚尚未完成的分片，请稍候。",
    { showCancel: false, showManual: false, hideProgress: true }
  );
  await dictionaryInitializationPromise;
}

function retryAutomaticDictionarySetup() {
  return startAutomaticDictionarySetup();
}

async function runManualDictionaryTask(task) {
  if (dictionaryTaskState === "auto-loading") {
    await cancelAutomaticDictionarySetup();
  }

  if (dictionaryTaskState !== "idle") {
    throw new Error("另一个词库任务正在进行，请稍后再试。");
  }

  dictionaryTaskState = "manual-importing";
  try {
    return await task();
  } finally {
    dictionaryTaskState = "idle";
  }
}

document.getElementById("dictFileInput").addEventListener(
  "change",
  async function(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
      await runManualDictionaryTask(() => importECDICTCsv(file));
      await refreshDictionaryStatus({ forceGuide: true, manual: true });
    } catch (error) {
      console.error(error);
      document.getElementById("dictImportStatus").textContent =
        "❌ 导入失败：" + (error.message || "未知错误");
      setDictionarySetupState(
        "error",
        "ECDICT 手动导入失败",
        error.message || "未知错误",
        { showRetry: true, showManual: true, hideProgress: true }
      );
    } finally {
      event.target.value = "";
    }
  }
);


/* =========================
   自动生词本
   ========================= */

const VOCAB_STORAGE_KEY = "EnglishReaderV05Vocab"; // 历史兼容：现在作为“查询记录”
const FAVORITES_STORAGE_KEY = "EnglishReaderV051Favorites";
const QUERY_EVENTS_KEY = "EnglishReaderV052QueryEvents";
const HISTORY_BASELINES_KEY = "EnglishReaderV052HistoryBaselines";
const DEVICE_ID_KEY = "EnglishReaderV052DeviceId";
const LAST_BACKUP_KEY = "EnglishReaderV052LastBackup";
const BACKUP_DISMISS_KEY = "EnglishReaderV052BackupDismiss";
const READING_PREFS_KEY = "EnglishReaderV052ReadingPrefs";


function makeId(prefix = "id") {
  if (crypto?.randomUUID) return `${prefix}:${crypto.randomUUID()}`;
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}:${Math.random().toString(36).slice(2)}`;
}

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = makeId("device");
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

function getQueryEvents() {
  try { return JSON.parse(localStorage.getItem(QUERY_EVENTS_KEY) || "{}"); }
  catch { return {}; }
}

function setQueryEvents(data) {
  localStorage.setItem(QUERY_EVENTS_KEY, JSON.stringify(data || {}));
}

function getHistoryBaselines() {
  try { return JSON.parse(localStorage.getItem(HISTORY_BASELINES_KEY) || "{}"); }
  catch { return {}; }
}

function setHistoryBaselines(data) {
  localStorage.setItem(HISTORY_BASELINES_KEY, JSON.stringify(data || {}));
}

function ensureHistoryMigration() {
  const baselines = getHistoryBaselines();

  if (!Object.keys(baselines).length) {
    const current = getVocabData();

    if (Object.keys(current).length) {
      const entries = Object.entries(current)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [
          key,
          Number(item?.count || 0),
          Number(item?.articleCount || 0),
          Number(item?.searchCount || 0),
          item?.firstSeen || "",
          item?.lastSeen || ""
        ]);

      const baselineId = `legacy-local:${simpleStableHash(JSON.stringify(entries))}`;
      baselines[baselineId] = {
        id: baselineId,
        createdAt: new Date().toISOString(),
        deviceId: "legacy-local",
        records: current
      };
      setHistoryBaselines(baselines);
    }
  }
}

function createQueryEvent(word, result, sourceType) {
  return {
    id: makeId("query"),
    deviceId: getDeviceId(),
    word: normalizeWord(result?.baseWord || word),
    displayWord: word,
    phonetic: result?.phonetic || "",
    pos: result?.pos || "",
    meaning: result?.meaning || "",
    dictionaryFound: Boolean(result),
    source: sourceType,
    timestamp: new Date().toISOString()
  };
}

function mergeQueryAggregate(target, incoming) {
  const key = incoming.word;
  if (!key) return;

  const old = target[key] || {
    word: key,
    count: 0,
    articleCount: 0,
    searchCount: 0,
    firstSeen: incoming.firstSeen || incoming.timestamp || new Date().toISOString()
  };

  old.count += Number(incoming.count || 0);
  old.articleCount += Number(incoming.articleCount || 0);
  old.searchCount += Number(incoming.searchCount || 0);

  const first = incoming.firstSeen || incoming.timestamp;
  const last = incoming.lastSeen || incoming.timestamp;

  if (first && (!old.firstSeen || new Date(first) < new Date(old.firstSeen))) old.firstSeen = first;
  if (last && (!old.lastSeen || new Date(last) > new Date(old.lastSeen))) old.lastSeen = last;

  if (incoming.displayWord) old.displayWord = incoming.displayWord;
  if (incoming.phonetic) old.phonetic = incoming.phonetic;
  if (incoming.pos) old.pos = incoming.pos;
  if (incoming.meaning) old.meaning = incoming.meaning;
  if (typeof incoming.dictionaryFound === "boolean") old.dictionaryFound = incoming.dictionaryFound;
  if (incoming.source) old.source = incoming.source;

  target[key] = old;
}

function rebuildVocabFromMergeData() {
  const rebuilt = {};
  const baselines = getHistoryBaselines();
  const events = getQueryEvents();

  for (const baseline of Object.values(baselines)) {
    for (const record of Object.values(baseline.records || {})) {
      mergeQueryAggregate(rebuilt, {
        ...record,
        count: Number(record.count || 0),
        articleCount: Number(record.articleCount || 0),
        searchCount: Number(record.searchCount || 0)
      });
    }
  }

  const sortedEvents = Object.values(events).sort((a,b) =>
    new Date(a.timestamp || 0) - new Date(b.timestamp || 0)
  );

  for (const event of sortedEvents) {
    mergeQueryAggregate(rebuilt, {
      ...event,
      count: 1,
      articleCount: event.source === "article" ? 1 : 0,
      searchCount: event.source === "search" ? 1 : 0,
      firstSeen: event.timestamp,
      lastSeen: event.timestamp
    });
  }

  setVocabData(rebuilt);
}

function recordQueryEvent(word, result, sourceType) {
  const events = getQueryEvents();
  const event = createQueryEvent(word, result, sourceType);
  events[event.id] = event;
  setQueryEvents(events);
}

function mergeUniqueMaps(current, incoming) {
  return { ...(current || {}), ...(incoming || {}) };
}

function getFavoriteType(item) {
  return item?.type === "phrase" ? "phrase" : "word";
}

function normalizePhraseText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getPhraseIdentity(text) {
  return normalizePhraseText(text)
    .toLowerCase()
    .replace(/’/g, "'");
}

function getPhraseFavoriteKey(text) {
  const identity = getPhraseIdentity(text);
  return identity ? `phrase:${identity}` : "";
}

function getCanonicalFavoriteMapKey(fallbackKey, item) {
  if (getFavoriteType(item) !== "phrase") return fallbackKey;

  const text = item?.word || item?.displayWord || String(fallbackKey || "").replace(/^phrase:/, "");
  return getPhraseFavoriteKey(text) || fallbackKey;
}

function mergeFavoriteRecords(a, b) {
  if (!a) return b;
  if (!b) return a;

  const aTime = new Date(a.updatedAt || a.createdAt || 0);
  const bTime = new Date(b.updatedAt || b.createdAt || 0);
  const newer = bTime >= aTime ? b : a;
  const older = newer === b ? a : b;

  let note = newer.note || "";
  const olderNote = older.note || "";
  if (olderNote && note && olderNote !== note && !note.includes(olderNote)) {
    note = `${note}\n\n—— 合并自另一设备 ——\n${olderNote}`;
  } else if (!note) {
    note = olderNote;
  }

  const tags = [...new Set([...(a.tags || []), ...(b.tags || [])])];
  const mergedType = a.type === "phrase" || b.type === "phrase"
    ? "phrase"
    : (newer.type || older.type || "");

  return {
    ...older,
    ...newer,
    ...(mergedType ? { type: mergedType } : {}),
    tags,
    mastered: Boolean(a.mastered || b.mastered),
    note,
    sentence: newer.sentence || older.sentence || "",
    meaning: newer.meaning || older.meaning || "",
    phonetic: newer.phonetic || older.phonetic || "",
    pos: newer.pos || older.pos || "",
    createdAt: [a.createdAt, b.createdAt].filter(Boolean)
      .sort((x,y) => new Date(x)-new Date(y))[0] || newer.createdAt,
    updatedAt: newer.updatedAt || older.updatedAt
  };
}

function mergeFavoritesMaps(current, incoming) {
  const result = {};

  for (const source of [current || {}, incoming || {}]) {
    for (const [key, value] of Object.entries(source)) {
      const targetKey = getCanonicalFavoriteMapKey(key, value);
      result[targetKey] = mergeFavoriteRecords(result[targetKey], value);
    }
  }

  return result;
}

function simpleStableHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function convertLegacyBackupToBaseline(data, file) {
  if (!data?.vocab || !Object.keys(data.vocab).length) return {};

  const vocabEntries = Object.entries(data.vocab)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [
      key,
      Number(item?.count || 0),
      Number(item?.articleCount || 0),
      Number(item?.searchCount || 0),
      item?.firstSeen || "",
      item?.lastSeen || ""
    ]);

  const signatureSource = JSON.stringify({
    createdAt: data.createdAt || "",
    vocab: vocabEntries
  });

  const stableId = `legacy-import:${simpleStableHash(signatureSource)}`;

  return {
    [stableId]: {
      id: stableId,
      createdAt: data.createdAt || new Date(file.lastModified || Date.now()).toISOString(),
      deviceId: "legacy-import",
      records: data.vocab
    }
  };
}

let currentLookupState = {
  word: "",
  result: null,
  sentence: "",
  source: ""
};

function getVocabData() {
  try {
    return JSON.parse(localStorage.getItem(VOCAB_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function setVocabData(data) {
  localStorage.setItem(VOCAB_STORAGE_KEY, JSON.stringify(data));
  updateVocabBadges();
}

function getFavoritesData() {
  try {
    return JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function setFavoritesData(data) {
  localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(data));
  updateVocabBadges();
  updateFavoriteButton();
}

function addToVocab(word, result, sourceType = "article") {
  if (!word) return;

  ensureHistoryMigration();
  recordQueryEvent(word, result, sourceType);

  const key = normalizeWord(result?.baseWord || word);
  if (!key) return;

  const data = getVocabData();
  const old = data[key] || {
    word: key,
    count: 0,
    firstSeen: new Date().toISOString(),
    articleCount: 0,
    searchCount: 0
  };

  old.count = (old.count || 0) + 1;
  old.lastSeen = new Date().toISOString();
  old.displayWord = word;
  old.phonetic = result?.phonetic || old.phonetic || "";
  old.pos = result?.pos || old.pos || "";
  old.meaning = result?.meaning || old.meaning || "";
  old.dictionaryFound = Boolean(result);

  if (sourceType === "search") {
    old.searchCount = (old.searchCount || 0) + 1;
  } else {
    old.articleCount = (old.articleCount || 0) + 1;
  }

  old.source = sourceType;

  data[key] = old;
  setVocabData(data);
}

function updateVocabBadges() {
  const historyCount = Object.keys(getVocabData()).length;
  const favoriteCount = Object.keys(getFavoritesData()).length;

  const a = document.getElementById("vocabCountBadge");
  const b = document.getElementById("vocabCountBadgeToolbar");
  const c = document.getElementById("favoriteCountBadge");
  const d = document.getElementById("favoriteCountBadgeToolbar");

  if (a) a.textContent = historyCount ? `(${historyCount})` : "";
  if (b) b.textContent = historyCount ? `(${historyCount})` : "";
  if (c) c.textContent = favoriteCount ? `(${favoriteCount})` : "";
  if (d) d.textContent = favoriteCount ? `(${favoriteCount})` : "";
}

function openVocabBook() {
  document.getElementById("vocabModal").classList.add("show");
  renderVocabBook();
}

function renderVocabBook() {
  const box = document.getElementById("vocabList");
  const filter = (document.getElementById("vocabFilterInput")?.value || "")
    .trim().toLowerCase();

  const sortMode = document.getElementById("vocabSortSelect")?.value || "recent";

  let data = Object.values(getVocabData())
    .filter(item => {
      if (!filter) return true;
      return (item.word || "").toLowerCase().includes(filter) ||
             (item.meaning || "").toLowerCase().includes(filter);
    });

  if (sortMode === "high") {
    data.sort((a, b) =>
      Number(b.count || 0) - Number(a.count || 0) ||
      new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0)
    );
  } else if (sortMode === "earliest") {
    data.sort((a, b) => new Date(a.firstSeen || 0) - new Date(b.firstSeen || 0));
  } else if (sortMode === "az") {
    data.sort((a, b) => String(a.word || "").localeCompare(String(b.word || "")));
  } else {
    data.sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0));
  }

  if (!data.length) {
    box.innerHTML =
      '<div class="searchEmpty">这里还没有查询记录。点击文章单词或使用搜索框后会自动记录。</div>';
    return;
  }

  box.innerHTML = data.map(item => {
    const articleCount = Number(item.articleCount || 0);
    const searchCount = Number(item.searchCount || 0);
    let sourceText = "";

    if (articleCount || searchCount) {
      const parts = [];
      if (articleCount) parts.push(`文章点击 ${articleCount} 次`);
      if (searchCount) parts.push(`搜索 ${searchCount} 次`);
      sourceText = parts.join(" · ");
    } else {
      sourceText = "早期版本记录";
    }

    return `
      <div class="vocabItem">
        <div>
          <div class="vocabWord">${escapeHtml(item.word || "")}
            <span style="font-weight:400;color:#8e8e93;font-size:13px">
              ${escapeHtml(item.phonetic || "")}
            </span>
          </div>
          <div class="vocabMeaning">${escapeHtml(item.meaning || "")}</div>
          <div class="vocabMeta">${escapeHtml(item.pos || "")}</div>
          <div class="querySourceMeta">${escapeHtml(sourceText)}</div>
          <div class="vocabMeta">
            首次：${formatLearningDate(item.firstSeen)} · 最近：${formatLearningDate(item.lastSeen)}
          </div>
        </div>

        <div class="vocabRight">
          查询 ${Number(item.count || 0)} 次
          <div class="historyItemActions">
            <button class="secondary compactButton historySpeakButton"
                    onclick="speakHistoryWord('${escapeJs(item.word || "")}', this)"
                    title="朗读 ${escapeHtml(item.word || "")}">
              🔊 发音
            </button>
            <button class="removeTiny" onclick="removeVocabWord('${escapeJs(item.word || "")}')">删除记录</button>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

function removeVocabWord(word) {
  const normalized = normalizeWord(word);
  if (!normalized) return;

  const events = getQueryEvents();
  for (const [id, event] of Object.entries(events)) {
    if (normalizeWord(event?.word || "") === normalized) {
      delete events[id];
    }
  }
  setQueryEvents(events);

  const baselines = getHistoryBaselines();
  for (const baseline of Object.values(baselines)) {
    if (baseline?.records && Object.prototype.hasOwnProperty.call(baseline.records, normalized)) {
      delete baseline.records[normalized];
    }
  }
  setHistoryBaselines(baselines);

  rebuildVocabFromMergeData();
  renderVocabBook();
}

function clearVocabBook() {
  if (!confirm("确定清空全部查询记录吗？收藏内容不会被删除。")) return;
  localStorage.removeItem(VOCAB_STORAGE_KEY);
  localStorage.removeItem(QUERY_EVENTS_KEY);
  localStorage.removeItem(HISTORY_BASELINES_KEY);
  updateVocabBadges();
  renderVocabBook();
}

function exportVocabCSV() {
  const items = Object.values(getVocabData());

  if (!items.length) {
    alert("查询记录还是空的。");
    return;
  }

  const rows = [
    ["word", "phonetic", "pos", "meaning", "count", "article_count", "search_count", "first_seen", "last_seen"]
  ];

  for (const item of items) {
    rows.push([
      item.word || "",
      item.phonetic || "",
      item.pos || "",
      item.meaning || "",
      item.count || 0,
      item.articleCount || 0,
      item.searchCount || 0,
      item.firstSeen || "",
      item.lastSeen || ""
    ]);
  }

  const csv = "\uFEFF" + rows.map(row =>
    row.map(csvEscape).join(",")
  ).join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "english-reader-query-history.csv";
  a.click();
  URL.revokeObjectURL(url);
}

function formatLearningDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
  });
}

function csvEscape(value) {
  const text = String(value ?? "");
  return '"' + text.replace(/"/g, '""') + '"';
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeJs(text) {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* =========================
   手动收藏
   ========================= */

function getFavoriteKey(word, result) {
  return normalizeWord(result?.baseWord || word);
}

function isFavorite(word, result) {
  const key = getFavoriteKey(word, result);
  return Boolean(key && getFavoritesData()[key]);
}

function updateFavoriteButton() {
  const btn = document.getElementById("favoriteCurrentButton");
  if (!btn) return;

  if (!currentLookupState.word) {
    btn.textContent = "☆ 收藏";
    btn.classList.remove("favoriteCardActive");
    btn.disabled = true;
    return;
  }

  btn.disabled = false;

  if (isFavorite(currentLookupState.word, currentLookupState.result)) {
    btn.textContent = "★ 已收藏";
    btn.classList.add("favoriteCardActive");
  } else {
    btn.textContent = "☆ 收藏";
    btn.classList.remove("favoriteCardActive");
  }
}

function saveCurrentFavorite() {
  const { word, result, sentence, source } = currentLookupState;
  if (!word) return;

  const key = getFavoriteKey(word, result);
  if (!key) return;

  const favorites = getFavoritesData();
  const existing = favorites[key];

  favorites[key] = {
    type: existing?.type || "word",
    word: key,
    displayWord: word,
    phonetic: result?.phonetic || existing?.phonetic || "",
    pos: result?.pos || existing?.pos || "",
    meaning: result?.meaning || existing?.meaning || "",
    sentence: existing?.sentence ?? sentence ?? "",
    note: existing?.note || "",
    tags: existing?.tags || [],
    mastered: Boolean(existing?.mastered),
    source: source || existing?.source || "",
    dictionaryFound: Boolean(result),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  setFavoritesData(favorites);
}

function findPhraseFavorite(favorites, text) {
  const identity = getPhraseIdentity(text);
  if (!identity) return null;

  const canonicalKey = getPhraseFavoriteKey(identity);
  if (favorites[canonicalKey] && getFavoriteType(favorites[canonicalKey]) === "phrase") {
    return { key: canonicalKey, item: favorites[canonicalKey] };
  }

  for (const [key, item] of Object.entries(favorites)) {
    if (getFavoriteType(item) !== "phrase") continue;
    if (getPhraseIdentity(item.word || item.displayWord || "") === identity) {
      return { key, item };
    }
  }

  return null;
}

function savePhraseFavorite(snapshot) {
  const text = normalizePhraseText(snapshot?.text || "");
  const canonicalKey = getPhraseFavoriteKey(text);
  if (!text || !canonicalKey) return { saved: false, existed: false, text: "" };

  const favorites = getFavoritesData();
  const match = findPhraseFavorite(favorites, text);
  const key = match?.key || canonicalKey;
  const existing = match?.item;
  const now = new Date().toISOString();

  favorites[key] = {
    ...existing,
    type: "phrase",
    word: text,
    displayWord: text,
    phonetic: existing?.phonetic || "",
    pos: existing?.pos || "",
    meaning: existing?.meaning || "",
    sentence: snapshot?.context || existing?.sentence || "",
    note: existing?.note || "",
    tags: existing?.tags || [],
    mastered: Boolean(existing?.mastered),
    source: "article-selection",
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };

  setFavoritesData(favorites);
  return { saved: true, existed: Boolean(existing), text };
}

function toggleCurrentFavorite() {
  const { word, result } = currentLookupState;
  if (!word) return;

  const key = getFavoriteKey(word, result);
  const favorites = getFavoritesData();

  if (favorites[key]) {
    if (!confirm(`取消收藏 “${key}” 吗？你写的释义、句子和备注也会一起删除。`)) return;
    delete favorites[key];
    setFavoritesData(favorites);
    return;
  }

  saveCurrentFavorite();
}

function openFavorites() {
  document.getElementById("favoritesModal").classList.add("show");
  renderFavorites();
}

function renderFavorites() {
  const box = document.getElementById("favoritesList");
  const filter = (document.getElementById("favoriteFilterInput")?.value || "")
    .trim().toLowerCase();
  const sortMode = document.getElementById("favoriteSortSelect")?.value || "recent";

  const masterFilter = document.getElementById("favoriteMasterFilter")?.value || "all";

  let items = Object.entries(getFavoritesData())
    .map(([favoriteKey, item]) => ({ ...item, __favoriteKey: favoriteKey }))
    .filter(item => {
      const matchesText = !filter ||
        (item.word || "").toLowerCase().includes(filter) ||
        (item.meaning || "").toLowerCase().includes(filter) ||
        (item.sentence || "").toLowerCase().includes(filter) ||
        (item.note || "").toLowerCase().includes(filter) ||
        (item.tags || []).some(tag => String(tag).toLowerCase().includes(filter));

      const matchesMaster =
        masterFilter === "all" ||
        (masterFilter === "mastered" && item.mastered) ||
        (masterFilter === "learning" && !item.mastered);

      return matchesText && matchesMaster;
    });

  if (sortMode === "az") {
    items.sort((a, b) => String(a.word || "").localeCompare(String(b.word || "")));
  } else if (sortMode === "mastered") {
    items.sort((a, b) => Number(Boolean(b.mastered)) - Number(Boolean(a.mastered)) ||
      new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  } else if (sortMode === "learning") {
    items.sort((a, b) => Number(Boolean(a.mastered)) - Number(Boolean(b.mastered)) ||
      new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  } else {
    items.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  }

  if (!items.length) {
    box.innerHTML =
      '<div class="searchEmpty">还没有收藏。点开单词可以收藏单词；划选多个英文单词可以收藏词组。</div>';
    return;
  }

  box.innerHTML = items.map(item => {
    const sentence = item.sentence || "";
    const note = item.note || "";
    const favoriteType = getFavoriteType(item);
    const favoriteKey = item.__favoriteKey || item.word || "";

    return `
      <div class="favoriteItem" data-favorite-key="${escapeHtml(favoriteKey)}">
        <div class="favoriteTop">
          <div>
            <div class="favoriteWord">
              <span class="favoriteTypeBadge ${favoriteType}">${favoriteType === "phrase" ? "PHRASE" : "WORD"}</span>
              ${escapeHtml(item.word || "")}
              <span class="favoritePhonetic">${escapeHtml(item.phonetic || "")}</span>
            </div>
            <div class="favoriteMeaning">
              ${item.meaning
                ? escapeHtml(item.meaning)
                : '<span style="color:#999">未填写释义</span>'}
            </div>
            <div class="vocabMeta">
              ${item.pos
                ? escapeHtml(item.pos)
                : '<span style="color:#aaa">词性 / 说明未填写</span>'}
            </div>
            ${favoriteType === "word" && item.dictionaryFound === false
              ? '<div class="querySourceMeta">个人词卡 · 本地词库未收录</div>'
              : ''}

            <div class="favoriteBadgeRow">
              <span class="masterBadge ${item.mastered ? 'mastered' : ''}">
                ${item.mastered ? '✓ 已掌握' : '学习中'}
              </span>
              ${(item.tags || []).map(tag => `<span class="tagBadge">#${escapeHtml(tag)}</span>`).join("")}
            </div>
          </div>

          <div class="favoriteTopActions">
            <button class="secondary compactButton favoriteSpeakButton"
                    onclick="event.stopPropagation(); speakFavoriteWord('${escapeJs(item.displayWord || item.word || "")}', this)"
                    title="朗读 ${escapeHtml(item.displayWord || item.word || "")}">
              🔊 发音
            </button>

            <button class="secondary compactButton editFavoriteButton"
                    onclick="editFavorite('${escapeJs(favoriteKey)}', this)">
              ✏️ 编辑
            </button>

            <button class="secondary compactButton favoriteCancelEditButton"
                    onclick="cancelFavoriteEdit(this)">
              收起
            </button>

            <button class="removeTiny"
                    onclick="removeFavorite('${escapeJs(favoriteKey)}')">
              取消收藏
            </button>
          </div>
        </div>

        <div class="favoritePreviewArea">
          ${sentence ? `
            <div class="favoritePreviewBlock">
              <div class="favoritePreviewLabel">上下文</div>
              <div class="favoritePreviewText">${escapeHtml(sentence)}</div>
            </div>
          ` : ""}

          ${note ? `
            <div class="favoritePreviewBlock favoriteNotePreview">
              <div class="favoritePreviewLabel">我的备注</div>
              <div class="favoritePreviewText">${escapeHtml(note)}</div>
            </div>
          ` : ""}

          <div class="favoriteCompactBottom">
            <div class="favoriteDate">收藏：${formatLearningDate(item.createdAt)}</div>
            ${note ? '<div class="favoriteDate">已有备注</div>' : ''}
          </div>
        </div>

        <div class="favoriteEditPanel">
          <div class="favoriteFieldGrid">
            <div>
              <div class="favoriteSectionLabel">音标 / 发音说明</div>
              <input class="favoriteInlineEditor phoneticEditor"
                     value="${escapeHtml(item.phonetic || "")}"
                     placeholder="可留空，例如 /dɪˈveləp/">
            </div>

            <div>
              <div class="favoriteSectionLabel">词性 / 说明</div>
              <input class="favoriteInlineEditor posEditor"
                     value="${escapeHtml(item.pos || "")}"
                     placeholder="例如 noun / verb / 专业术语">
            </div>
          </div>

          <div class="favoriteSectionLabel">中文释义 / 自定义解释</div>
          <textarea class="favoriteEditor meaningEditor"
                    placeholder="词库没有也没关系，这里可以自己填写释义。">${escapeHtml(item.meaning || "")}</textarea>

          <div class="favoriteFieldGrid favoriteMetaGrid">
            <div>
              <div class="favoriteSectionLabel">标签</div>
              <input class="favoriteInlineEditor tagsEditor"
                     value="${escapeHtml((item.tags || []).join(', '))}"
                     placeholder="例如 IELTS, 写作, 工作">
            </div>

            <label class="masterToggle">
              <input class="masteredEditor" type="checkbox" ${item.mastered ? "checked" : ""}>
              <span>标记为已掌握</span>
            </label>
          </div>

          <div class="favoriteSectionLabel">上下文句子（可修改）</div>
          <textarea class="favoriteEditor contextEditor">${escapeHtml(sentence)}</textarea>

          <div class="favoriteSectionLabel">我的备注</div>
          <textarea class="favoriteEditor note noteEditor"
                    placeholder="写下自己的理解、搭配、易错点、来源或复习提示…">${escapeHtml(note)}</textarea>

          <div class="favoriteBottom">
            <div class="favoriteDate">收藏：${formatLearningDate(item.createdAt)}</div>
            <div>
              <button class="secondary compactButton"
                      onclick="saveFavoriteEdit('${escapeJs(favoriteKey)}', this)">
                保存修改
              </button>
              <span class="favoriteSavedHint"></span>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

function editFavorite(key, button) {
  const card = button.closest(".favoriteItem");
  if (!card) return;

  // 一次只展开一个收藏，避免页面又被撑得很长
  document.querySelectorAll(".favoriteItem.editing").forEach(item => {
    if (item !== card) item.classList.remove("editing");
  });

  card.classList.add("editing");

  const noteEditor = card.querySelector(".noteEditor");
  if (noteEditor && !noteEditor.value.trim()) {
    noteEditor.focus();
  }
}

function cancelFavoriteEdit(button) {
  const card = button.closest(".favoriteItem");
  if (!card) return;

  // 取消编辑时重新渲染，丢弃尚未保存的修改
  renderFavorites();
}

function saveFavoriteEdit(key, button) {
  const card = button.closest(".favoriteItem");
  if (!card) return;

  const favorites = getFavoritesData();
  if (!favorites[key]) return;

  favorites[key].phonetic = card.querySelector(".phoneticEditor")?.value || "";
  favorites[key].pos = card.querySelector(".posEditor")?.value || "";
  favorites[key].meaning = card.querySelector(".meaningEditor")?.value || "";
  favorites[key].tags = (card.querySelector(".tagsEditor")?.value || "")
    .split(/[,，]/)
    .map(x => x.trim())
    .filter(Boolean)
    .filter((x, i, arr) => arr.indexOf(x) === i);
  favorites[key].mastered = Boolean(card.querySelector(".masteredEditor")?.checked);
  favorites[key].sentence = card.querySelector(".contextEditor")?.value || "";
  favorites[key].note = card.querySelector(".noteEditor")?.value || "";
  favorites[key].updatedAt = new Date().toISOString();

  setFavoritesData(favorites);

  const hint = card.querySelector(".favoriteSavedHint");
  if (hint) hint.textContent = "已保存";

  // 稍微停一下让用户看到保存成功，然后恢复紧凑浏览状态
  setTimeout(() => {
    renderFavorites();
  }, 450);
}

function removeFavorite(key) {
  const favorites = getFavoritesData();
  const label = favorites[key]?.word || key;
  if (!confirm(`确定取消收藏 “${label}” 吗？`)) return;

  delete favorites[key];
  setFavoritesData(favorites);
  renderFavorites();
}

function exportFavoritesCSV() {
  const items = Object.values(getFavoritesData());

  if (!items.length) {
    alert("收藏还是空的。");
    return;
  }

  const rows = [
    ["type", "word", "phonetic", "pos", "meaning", "tags", "mastered", "context_sentence", "note", "created_at", "updated_at"]
  ];

  for (const item of items) {
    rows.push([
      getFavoriteType(item).toUpperCase(),
      item.word || "",
      item.phonetic || "",
      item.pos || "",
      item.meaning || "",
      (item.tags || []).join("|"),
      item.mastered ? "yes" : "no",
      item.sentence || "",
      item.note || "",
      item.createdAt || "",
      item.updatedAt || ""
    ]);
  }

  const csv = "\uFEFF" + rows.map(row =>
    row.map(csvEscape).join(",")
  ).join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  downloadBlob(blob, "english-reader-favorites.csv");
}

/* =========================
   句子上下文提取
   ========================= */

const PHRASE_MIN_WORDS = 2;
const PHRASE_MAX_WORDS = 20;
const SENTENCE_ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "e.g", "i.e"
]);
const READING_PROGRESS_DEBOUNCE_MS = 700;
let currentArticleText = "";
let activeArticleId = null;
let currentArticle = null;
let articleDraftMode = "new";
let draftSource = { sourceType: "paste" };
let articleSavePromise = null;
let myArticlesRenderVersion = 0;
let myArticlesView = "active";
const myArticleOperations = new Set();
let readingProgressSaveTimer = null;
let readingProgressUIFrame = null;
let readingProgressWriteQueue = Promise.resolve(null);
let readingPositionRenderToken = 0;
let suppressReadingProgressSave = false;
let readingProgressSession = null;
let phraseSelectionSnapshot = null;
let phraseSelectionTimer = null;
let phraseSelectionFeedbackTimer = null;
let phraseSelectionFeedbackFrame = null;
let phraseSelectionPointerActive = false;
let suppressArticleWordClickUntil = 0;

function isSentenceEndingPeriod(text, index) {
  if (text[index] !== ".") return true;

  const previous = text.slice(Math.max(0, index - 18), index);
  const token = previous.match(/([A-Za-z]+(?:\.[A-Za-z]+)*)$/)?.[1]?.toLowerCase() || "";

  if (SENTENCE_ABBREVIATIONS.has(token)) return false;
  if (token && token.split(".").every(part => part.length === 1)) return false;
  if (/\d/.test(text[index - 1] || "") && /\d/.test(text[index + 1] || "")) return false;

  const nextLetter = text.slice(index + 1).match(/^\s*["“'‘(\[]*([A-Za-z])/i)?.[1];
  if (nextLetter && nextLetter === nextLetter.toLowerCase()) return false;

  return true;
}

function isSentenceBoundary(text, index) {
  const ch = text[index];
  if (ch === "\n" || "!?。！？".includes(ch)) return true;
  return ch === "." && isSentenceEndingPeriod(text, index);
}

function extractSentenceAt(text, wordIndex) {
  if (!text) return "";

  const sentenceBreaks = ".!?。！？\n";
  let start = 0;

  for (let i = wordIndex - 1; i >= 0; i--) {
    if (sentenceBreaks.includes(text[i])) {
      start = i + 1;
      break;
    }
  }

  let end = text.length;

  for (let i = wordIndex; i < text.length; i++) {
    if (sentenceBreaks.includes(text[i])) {
      end = i + 1;
      break;
    }
  }

  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function extractPhraseSentenceAt(text, wordIndex, rangeEnd) {
  if (!text) return "";

  let start = 0;

  for (let i = wordIndex - 1; i >= 0; i--) {
    if (isSentenceBoundary(text, i)) {
      start = i + 1;
      while (start < text.length && /["”'’\)\]]/.test(text[start])) start++;
      break;
    }
  }

  let end = text.length;

  for (let i = Math.max(wordIndex, rangeEnd - 1); i < text.length; i++) {
    if (isSentenceBoundary(text, i)) {
      end = i + 1;
      while (end < text.length && /["”'’\)\]]/.test(text[end])) end++;
      break;
    }
  }

  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function isNodeInsideArticle(article, node) {
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  return Boolean(element && (element === article || article.contains(element)));
}

function getArticleRangeOffsets(article, range) {
  const beforeStart = document.createRange();
  beforeStart.selectNodeContents(article);
  beforeStart.setEnd(range.startContainer, range.startOffset);

  const beforeEnd = document.createRange();
  beforeEnd.selectNodeContents(article);
  beforeEnd.setEnd(range.endContainer, range.endOffset);

  return {
    start: beforeStart.toString().length,
    end: beforeEnd.toString().length
  };
}

function getArticleParagraphIndex(text, offset) {
  return (text.slice(0, Math.max(0, offset)).match(/\n/g) || []).length;
}

function getValidPhraseSelectionSnapshot() {
  const article = document.getElementById("article");
  const selection = window.getSelection?.();

  if (!article || !selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;

  const range = selection.getRangeAt(0);
  if (!isNodeInsideArticle(article, range.startContainer) ||
      !isNodeInsideArticle(article, range.endContainer)) {
    return null;
  }

  const rawText = selection.toString();
  const text = normalizePhraseText(rawText);
  const words = text.match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) || [];
  if (words.length < PHRASE_MIN_WORDS || words.length > PHRASE_MAX_WORDS) return null;

  const offsets = getArticleRangeOffsets(article, range);
  const sourceText = currentArticleText || article.textContent || "";
  const leadingWhitespace = rawText.match(/^\s*/)?.[0].length || 0;
  const trailingWhitespace = rawText.match(/\s*$/)?.[0].length || 0;
  const selectionStart = offsets.start + leadingWhitespace;
  const selectionEnd = Math.max(selectionStart, offsets.end - trailingWhitespace);
  const endOffset = Math.max(selectionStart, selectionEnd - 1);

  if (getArticleParagraphIndex(sourceText, selectionStart) !==
      getArticleParagraphIndex(sourceText, endOffset)) {
    return null;
  }

  return {
    text,
    context: extractPhraseSentenceAt(sourceText, selectionStart, selectionEnd),
    wordCount: words.length,
    range: range.cloneRange()
  };
}

function positionPhraseSelectionToolbar() {
  const toolbar = document.getElementById("phraseSelectionToolbar");
  if (!toolbar?.classList.contains("show") || !phraseSelectionSnapshot?.range) return;

  const selectionRect = phraseSelectionSnapshot.range.getBoundingClientRect();
  if (!selectionRect.width && !selectionRect.height) return;

  const toolbarRect = toolbar.getBoundingClientRect();
  const viewportPadding = 8;
  const selectionGap = 10;
  let left = selectionRect.left + selectionRect.width / 2 - toolbarRect.width / 2;
  let top = selectionRect.top - toolbarRect.height - selectionGap;

  left = Math.max(
    viewportPadding,
    Math.min(window.innerWidth - toolbarRect.width - viewportPadding, left)
  );

  if (top < viewportPadding) top = selectionRect.bottom + selectionGap;
  if (top + toolbarRect.height > window.innerHeight - viewportPadding) {
    top = Math.max(viewportPadding, selectionRect.top - toolbarRect.height - selectionGap);
  }

  toolbar.style.left = `${Math.round(left)}px`;
  toolbar.style.top = `${Math.round(top)}px`;
}

function hidePhraseSelectionToolbar(clearSelection = false) {
  const toolbar = document.getElementById("phraseSelectionToolbar");
  toolbar?.classList.remove("show");
  toolbar?.setAttribute("aria-hidden", "true");
  phraseSelectionSnapshot = null;

  if (clearSelection) {
    try { window.getSelection?.().removeAllRanges(); } catch {}
  }
}

function showPhraseSelectionToolbar(snapshot) {
  const toolbar = document.getElementById("phraseSelectionToolbar");
  if (!toolbar) return;

  phraseSelectionSnapshot = snapshot;
  suppressArticleWordClickUntil = Date.now() + 600;
  toolbar.classList.add("show");
  toolbar.setAttribute("aria-hidden", "false");
  positionPhraseSelectionToolbar();
}

function refreshPhraseSelectionToolbar() {
  if (phraseSelectionPointerActive) return;

  const snapshot = getValidPhraseSelectionSnapshot();
  if (snapshot) showPhraseSelectionToolbar(snapshot);
  else hidePhraseSelectionToolbar(false);
}

function schedulePhraseSelectionRefresh(delay = 70) {
  clearTimeout(phraseSelectionTimer);
  phraseSelectionTimer = setTimeout(refreshPhraseSelectionToolbar, delay);
}

function showPhraseSelectionFeedback(message) {
  const feedback = document.getElementById("phraseSelectionFeedback");
  if (!feedback) return;

  clearTimeout(phraseSelectionFeedbackTimer);
  if (phraseSelectionFeedbackFrame !== null) {
    cancelAnimationFrame(phraseSelectionFeedbackFrame);
  }

  feedback.classList.remove("show");
  feedback.textContent = message;
  void feedback.offsetWidth;

  phraseSelectionFeedbackFrame = requestAnimationFrame(() => {
    phraseSelectionFeedbackFrame = null;
    feedback.classList.add("show");
    phraseSelectionFeedbackTimer = setTimeout(() => {
      feedback.classList.remove("show");
    }, 1800);
  });
}

function favoriteSelectedPhrase() {
  const snapshot = phraseSelectionSnapshot;
  if (!snapshot) return;

  const result = savePhraseFavorite(snapshot);
  hidePhraseSelectionToolbar(true);

  if (result.saved) {
    const message = result.existed
      ? `✓ 已收藏过：${result.text}`
      : `✓ 已收藏：${result.text}`;
    showPhraseSelectionFeedback(message);
  }
}

function speakSelectedPhrase(button) {
  const text = phraseSelectionSnapshot?.text;
  if (!text) return;

  try {
    speakWord(text);
    flashSpeechButton(button, true);
  } catch (error) {
    console.error("Phrase speech error:", error);
    flashSpeechButton(button, false);
  }
}

function consumePhraseSelectionWordClick() {
  const hasValidSelection = Boolean(getValidPhraseSelectionSnapshot());
  if (Date.now() < suppressArticleWordClickUntil || hasValidSelection) {
    suppressArticleWordClickUntil = 0;
    return true;
  }
  return false;
}

function setupPhraseSelection() {
  const article = document.getElementById("article");
  const toolbar = document.getElementById("phraseSelectionToolbar");
  const favoriteButton = document.getElementById("phraseFavoriteButton");
  const speakButton = document.getElementById("phraseSpeakButton");
  if (!article || !toolbar || !favoriteButton || !speakButton) return;

  toolbar.addEventListener("pointerdown", event => {
    event.preventDefault();
    event.stopPropagation();
  });

  favoriteButton.addEventListener("click", event => {
    event.stopPropagation();
    favoriteSelectedPhrase();
  });

  speakButton.addEventListener("click", event => {
    event.stopPropagation();
    speakSelectedPhrase(speakButton);
  });

  document.addEventListener("selectionchange", () => {
    if (!phraseSelectionPointerActive) schedulePhraseSelectionRefresh();
  });

  document.addEventListener("pointerdown", event => {
    if (toolbar.contains(event.target)) return;

    suppressArticleWordClickUntil = 0;
    phraseSelectionPointerActive = article.contains(event.target);
    hidePhraseSelectionToolbar(false);
  }, true);

  document.addEventListener("pointerup", () => {
    const wasSelectingArticle = phraseSelectionPointerActive;
    phraseSelectionPointerActive = false;
    if (wasSelectingArticle) refreshPhraseSelectionToolbar();
  }, true);

  document.addEventListener("pointercancel", () => {
    phraseSelectionPointerActive = false;
    schedulePhraseSelectionRefresh();
  }, true);

  document.addEventListener("touchend", () => {
    phraseSelectionPointerActive = false;
    schedulePhraseSelectionRefresh(120);
  }, { passive: true });

  window.addEventListener("resize", positionPhraseSelectionToolbar);
  window.addEventListener("scroll", positionPhraseSelectionToolbar, { passive: true });
}


/* =========================
   V0.5.2 阅读显示 / 快捷键 / 拖拽 / 进度
   ========================= */

function getReadingPreferences() {
  try {
    return JSON.parse(localStorage.getItem(READING_PREFS_KEY) || "{}");
  } catch {
    return {};
  }
}

function applyAppearance(mode) {
  let useDark = mode === "dark";
  if (mode === "system") {
    useDark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches || false;
  }
  document.body.classList.toggle("darkMode", useDark);
}

function applyReadingPreferences() {
  const prefs = {
    fontSize: "21",
    lineHeight: "2",
    appearance: "system",
    speechRate: "1",
    speechVoice: null,
    ...getReadingPreferences()
  };

  document.documentElement.style.setProperty("--reader-font-size", `${prefs.fontSize}px`);
  document.documentElement.style.setProperty("--reader-line-height", prefs.lineHeight);
  applyAppearance(prefs.appearance);

  ["readerFontSize", "readerFontSizeQuick"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = prefs.fontSize;
  });

  ["readerLineHeight", "readerLineHeightQuick"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = prefs.lineHeight;
  });

  ["appearanceMode", "appearanceModeQuick"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = prefs.appearance;
  });

  syncSpeechPreferenceControls();
}

function saveReadingPreferences() {
  const old = getReadingPreferences();
  const prefs = {
    ...old,
    fontSize: document.getElementById("readerFontSize")?.value || old.fontSize || "21",
    lineHeight: document.getElementById("readerLineHeight")?.value || old.lineHeight || "2",
    appearance: document.getElementById("appearanceMode")?.value || old.appearance || "system"
  };

  localStorage.setItem(READING_PREFS_KEY, JSON.stringify(prefs));
  applyReadingPreferences();
}

function syncQuickReadingSetting(type, value) {
  const prefs = { ...getReadingPreferences() };

  if (type === "font") prefs.fontSize = value;
  if (type === "line") prefs.lineHeight = value;
  if (type === "appearance") prefs.appearance = value;

  localStorage.setItem(READING_PREFS_KEY, JSON.stringify(prefs));
  applyReadingPreferences();
}

function openReadingSettings() {
  applyReadingPreferences();
  document.getElementById("readingSettingsModal").classList.add("show");
}

function openHelp() {
  document.getElementById("helpModal").classList.add("show");
}

function resetTxtImportUI() {
  const zone = document.getElementById("textDropZone");
  const fileInput = document.getElementById("fileInput");
  const title = zone?.querySelector(".dropZoneTitle");
  const hint = zone?.querySelector(".dropZoneHint");

  zone?.classList.remove("dragging");
  if (title) title.textContent = "拖拽 TXT 文件到这里";
  if (hint) hint.textContent = "或点击此区域选择文件";
  if (fileInput) fileInput.value = "";
}

async function loadTxtFile(file) {
  if (!file) return false;

  const name = String(file.name || "").toLowerCase();
  if (!name.endsWith(".txt") && file.type !== "text/plain") {
    alert("当前版本的文章文件导入只支持 TXT。");
    return false;
  }

  const text = await file.text();
  await startNewArticleDraft({
    sourceType: "txt",
    sourceTitle: file.name
  });
  document.getElementById("inputText").value = text;
  return true;
}

function setupTextDropZone() {
  const zone = document.getElementById("textDropZone");
  const fileInput = document.getElementById("fileInput");
  const inputText = document.getElementById("inputText");
  if (!zone || !fileInput) return;

  const title = zone.querySelector(".dropZoneTitle");
  const hint = zone.querySelector(".dropZoneHint");
  let dragDepth = 0;

  const showLoaded = file => {
    if (title) title.textContent = `已载入：${file.name}`;
    if (hint) hint.textContent = "现在点击“生成可点击文章”即可开始阅读";
  };

  zone.addEventListener("click", () => fileInput.click());

  zone.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInput.click();
    }
  });

  zone.addEventListener("dragenter", event => {
    event.preventDefault();
    dragDepth += 1;
    zone.classList.add("dragging");
    if (title) title.textContent = "松开即可导入 TXT";
    if (hint) hint.textContent = "文件只会先载入，不会自动生成文章";
  });

  zone.addEventListener("dragover", event => {
    event.preventDefault();
  });

  zone.addEventListener("dragleave", event => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      zone.classList.remove("dragging");
      resetTxtImportUI();
    }
  });

  zone.addEventListener("drop", async event => {
    event.preventDefault();
    dragDepth = 0;
    zone.classList.remove("dragging");

    const file = event.dataTransfer?.files?.[0];
    if (!file) {
      resetTxtImportUI();
      return;
    }

    const ok = await loadTxtFile(file);
    if (ok) showLoaded(file);
    else resetTxtImportUI();
  });

  fileInput.addEventListener("change", async event => {
    const file = event.target.files?.[0];
    if (!file) return;

    const ok = await loadTxtFile(file);
    if (ok) showLoaded(file);

    // 允许用户连续两次选择同一个文件
    event.target.value = "";
  });

  inputText?.addEventListener("input", () => {
    if (draftSource.sourceType !== "txt") return;
    draftSource = { sourceType: "paste" };
    resetTxtImportUI();
  });
}

function clampReadingProgress(value) {
  const progress = Number(value);
  if (!Number.isFinite(progress)) return 0;
  return Math.min(1, Math.max(0, progress));
}

function getReadingAnchorOffset() {
  return Math.min(240, Math.max(96, window.innerHeight * 0.28));
}

function getArticleReadingMetrics() {
  const layout = document.getElementById("readerLayout");
  const article = document.getElementById("article");
  if (!layout?.classList.contains("show") || !article) return null;

  const rect = article.getBoundingClientRect();
  if (!Number.isFinite(rect.height) || rect.height <= 0) return null;

  const articleTop = window.scrollY + rect.top;
  const articleBottom = articleTop + rect.height;
  const anchorOffset = getReadingAnchorOffset();
  const startY = articleTop - anchorOffset;
  const endY = Math.max(startY, articleBottom - window.innerHeight);
  const scrollRange = Math.max(1, endY - startY);

  return {
    article,
    articleTop,
    articleBottom,
    anchorOffset,
    startY,
    endY,
    scrollRange,
    progress: clampReadingProgress((window.scrollY - startY) / scrollRange)
  };
}

function getParagraphIndexAtReadingAnchor(article, anchorOffset) {
  const words = article.querySelectorAll(".word[data-paragraph-index]");
  if (!words.length) return 0;

  let closestIndex = 0;
  let closestDistance = Infinity;

  for (const word of words) {
    const rect = word.getBoundingClientRect();
    let distance = 0;
    if (anchorOffset < rect.top) distance = rect.top - anchorOffset;
    else if (anchorOffset > rect.bottom) distance = anchorOffset - rect.bottom;

    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = Number(word.dataset.paragraphIndex) || 0;
      if (distance === 0) break;
    }
  }

  return Math.max(0, Math.trunc(closestIndex));
}

function calculateArticleReadingSnapshot() {
  const metrics = getArticleReadingMetrics();
  if (!metrics || !activeArticleId || suppressReadingProgressSave) return null;

  return {
    articleId: activeArticleId,
    progress: Number(metrics.progress.toFixed(6)),
    paragraphIndex: getParagraphIndexAtReadingAnchor(
      metrics.article,
      metrics.anchorOffset
    )
  };
}

function updateReadingProgress() {
  const layout = document.getElementById("readerLayout");
  const progressBar = document.getElementById("readingProgress");
  const topButton = document.getElementById("backToTop");

  if (!layout?.classList.contains("show")) {
    if (progressBar) progressBar.style.width = "0%";
    if (topButton) topButton.classList.remove("show");
    return;
  }

  const metrics = getArticleReadingMetrics();
  const percent = (metrics?.progress || 0) * 100;

  if (progressBar) progressBar.style.width = `${percent}%`;
  if (topButton) topButton.classList.toggle("show", window.scrollY > 500);
}

function requestReadingProgressUIUpdate() {
  if (readingProgressUIFrame !== null) return;
  readingProgressUIFrame = requestAnimationFrame(() => {
    readingProgressUIFrame = null;
    updateReadingProgress();
  });
}

function cancelScheduledReadingSave() {
  clearTimeout(readingProgressSaveTimer);
  readingProgressSaveTimer = null;
}

function initializeReadingProgressSession(article) {
  cancelScheduledReadingSave();

  if (!article?.id) {
    readingProgressSession = null;
    return;
  }

  const progress = clampReadingProgress(article.reading?.progress);
  readingProgressSession = {
    articleId: article.id,
    farthest: {
      articleId: article.id,
      progress,
      paragraphIndex: Math.max(
        0,
        Math.trunc(Number(article.reading?.paragraphIndex) || 0)
      )
    },
    enqueuedProgress: progress,
    dirty: false
  };
}

function clearReadingProgressSession() {
  cancelScheduledReadingSave();
  readingProgressSession = null;
}

function captureFarthestReadingSnapshot(candidate) {
  const session = readingProgressSession;
  if (!candidate || !session || candidate.articleId !== session.articleId) return false;
  if (candidate.progress <= session.farthest.progress) return false;

  session.farthest = { ...candidate };
  session.dirty = true;
  return true;
}

function queueReadingProgressWrite(snapshot) {
  const reading = {
    progress: clampReadingProgress(snapshot.progress),
    paragraphIndex: Math.max(0, Math.trunc(snapshot.paragraphIndex)),
    updatedAt: new Date().toISOString()
  };

  readingProgressWriteQueue = readingProgressWriteQueue
    .then(async () => {
      const library = window.LingoFlowArticleLibrary;
      if (!library) throw new Error("文章数据层未加载，阅读进度无法保存。");

      const updatedArticle = await library.updateArticleReading(snapshot.articleId, reading);
      if (activeArticleId === updatedArticle.id && currentArticle?.id === updatedArticle.id) {
        currentArticle = {
          ...currentArticle,
          reading: updatedArticle.reading
        };
      }
      return updatedArticle;
    })
    .catch(error => {
      const session = readingProgressSession;
      if (session?.articleId === snapshot.articleId &&
          session.enqueuedProgress === snapshot.progress) {
        session.enqueuedProgress = clampReadingProgress(currentArticle?.reading?.progress);
        session.dirty = session.farthest.progress > session.enqueuedProgress;
      }
      console.error("Reading progress save error:", error);
      return null;
    });

  return readingProgressWriteQueue;
}

function flushReadingProgress() {
  cancelScheduledReadingSave();

  const session = readingProgressSession;
  if (!session?.dirty) return readingProgressWriteQueue;

  const snapshot = { ...session.farthest };
  if (snapshot.progress <= session.enqueuedProgress) {
    session.dirty = false;
    return readingProgressWriteQueue;
  }

  session.enqueuedProgress = snapshot.progress;
  session.dirty = false;
  return queueReadingProgressWrite(snapshot);
}

function scheduleReadingProgressSave() {
  if (suppressReadingProgressSave || !readingProgressSession?.dirty) return;

  cancelScheduledReadingSave();
  readingProgressSaveTimer = setTimeout(() => {
    readingProgressSaveTimer = null;
    void flushReadingProgress();
  }, READING_PROGRESS_DEBOUNCE_MS);
}

function handleReadingScroll() {
  requestReadingProgressUIUpdate();
  const candidate = calculateArticleReadingSnapshot();
  captureFarthestReadingSnapshot(candidate);
  scheduleReadingProgressSave();
}

function checkBackupReminder() {
  const total = Object.keys(getVocabData()).length + Object.keys(getFavoritesData()).length;
  const box = document.getElementById("backupReminder");
  if (!box || total < 10) return;

  const dismissed = localStorage.getItem(BACKUP_DISMISS_KEY);
  const today = new Date().toISOString().slice(0,10);
  if (dismissed === today) return;

  const last = localStorage.getItem(LAST_BACKUP_KEY);
  const overdue = !last || (Date.now() - new Date(last).getTime()) > 7 * 24 * 60 * 60 * 1000;

  box.classList.toggle("show", overdue);
}

function dismissBackupReminder() {
  localStorage.setItem(BACKUP_DISMISS_KEY, new Date().toISOString().slice(0,10));
  document.getElementById("backupReminder")?.classList.remove("show");
}

document.addEventListener("keydown", event => {
  const cmd = event.ctrlKey || event.metaKey;

  if (cmd && event.key.toLowerCase() === "k") {
    event.preventDefault();
    closeModal("settingsModal");
    closeModal("favoritesModal");
    closeModal("vocabModal");
    closeModal("myArticlesModal");
    const input = document.getElementById("directSearchInput");
    input?.focus();
    input?.select();
  }

  if (cmd && event.key.toLowerCase() === "f") {
    const readerShown = document.getElementById("readerLayout")?.classList.contains("show");
    if (readerShown) {
      event.preventDefault();
      const input = document.getElementById("articleFindInput");
      input?.focus();
      input?.select();
    }
  }
});

window.addEventListener("scroll", handleReadingScroll, { passive: true });

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void flushReadingProgress();
});

window.addEventListener("pagehide", () => {
  void flushReadingProgress();
});

if (window.matchMedia) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    if ((getReadingPreferences().appearance || "system") === "system") applyReadingPreferences();
  });
}

/* =========================
   直接搜索 + 自动补全
   ========================= */

let suggestionItems = [];
let suggestionIndex = -1;
let suggestionTimer = null;

async function isECDICTReadyForLookup() {
  if (dictionaryIntegritySnapshot?.ecdict.complete) return true;
  if (dictionaryTaskState === "auto-loading") return false;

  try {
    const integrity = await inspectDictionaryIntegrity();
    dictionaryIntegritySnapshot = integrity;
    return integrity.ecdict.complete;
  } catch {
    return false;
  }
}

function getDictionaryUnavailableMessage() {
  return dictionaryTaskState === "auto-loading"
    ? "离线词库正在准备中，完成后即可查词。"
    : "离线词库尚未加载。你可以继续阅读，需要时再准备词库。";
}

function getDictionaryPrepareButtonHtml() {
  return dictionaryTaskState === "auto-loading"
    ? ""
    : '<button class="secondary" onclick="openDictionaryGuide()">准备词库</button>';
}

async function directSearch(explicitWord = "") {
  const input = document.getElementById("directSearchInput");
  const word = (explicitWord || input.value).trim();

  if (!word) {
    input.focus();
    return;
  }

  input.value = word;
  hideSearchSuggestions();

  const resultBox = document.getElementById("directSearchResult");
  resultBox.innerHTML = '<div class="searchEmpty">正在查询本地词库…</div>';

  speakWord(word);
  if (!await isECDICTReadyForLookup()) {
    resultBox.innerHTML = `
      <div class="searchResultCard">
        <div class="searchResultWord">${escapeHtml(word)}</div>
        <div class="searchResultMeaning">${getDictionaryUnavailableMessage()}</div>
        <div style="margin-top:10px">${getDictionaryPrepareButtonHtml()}</div>
      </div>
    `;
    return;
  }

  const result = await lookupWord(word);

  if (!result) {
    addToVocab(word, null, "search");

    currentLookupState = {
      word,
      result: null,
      sentence: "",
      source: "search"
    };

    resultBox.innerHTML = `
      <div class="searchResultCard">
        <div class="searchResultWord">${escapeHtml(word)}</div>
        <div class="searchResultMeaning">
          本地词库没有查到这个词，但你仍然可以收藏并建立自己的个人词卡。
        </div>
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="secondary" onclick="speakWord('${escapeJs(word)}')">🔊 再听一次</button>
          <button class="secondary" onclick="favoriteDirectSearchUnknown('${escapeJs(word)}', this)">
            ${isFavorite(word, null) ? "★ 已收藏" : "☆ 收藏"}
          </button>
        </div>
      </div>
    `;
    return;
  }

  addToVocab(word, result, "search");

  currentLookupState = {
    word,
    result,
    sentence: "",
    source: "search"
  };

  const exchangeItems = formatExchange(result.exchange || "");

  resultBox.innerHTML = `
    <div class="searchResultCard">
      <div class="searchResultTop">
        <span class="searchResultWord">${escapeHtml(word)}</span>
        <span class="searchResultPhonetic">${escapeHtml(result.phonetic || "")}</span>
      </div>

      <div class="searchResultPos">${escapeHtml(result.pos || "词性未标注")}</div>
      <div class="searchResultMeaning">${escapeHtml(result.meaning || "暂无中文释义")}</div>

      ${result.baseWord && result.baseWord !== normalizeWord(word) ? `
        <div style="margin-top:11px;padding:10px;background:#fff;border-radius:8px;line-height:1.55">
          <b>词形关系：</b>${escapeHtml(normalizeWord(word))} → ${escapeHtml(result.baseWord)}
          ${result.surfaceMeaning ? `<div style="margin-top:5px;color:#666">当前词形释义：${escapeHtml(result.surfaceMeaning)}</div>` : ""}
        </div>
      ` : ""}

      ${exchangeItems.length ? `
        <div style="margin-top:9px;display:flex;flex-wrap:wrap;gap:5px">
          ${exchangeItems.map(x => `<span class="exchangeChip" style="background:#e9e9ee;color:#333">${escapeHtml(x)}</span>`).join("")}
        </div>
      ` : ""}

      ${result.ielts ? `
        <div style="margin-top:12px;padding:10px;background:#fff;border-radius:8px;line-height:1.55">
          <b>IELTS 提示：</b>${escapeHtml(result.ielts)}
        </div>
      ` : ""}

      <div class="searchResultMeta">
        来源：${escapeHtml(result.source || "")}
      </div>

      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="secondary" onclick="speakWord('${escapeJs(word)}')">🔊 再听一次</button>
        <button class="secondary" onclick="favoriteDirectSearch('${escapeJs(word)}')">
          ${isFavorite(word, result) ? "★ 已收藏" : "☆ 收藏"}
        </button>
      </div>
    </div>
  `;
}

function favoriteDirectSearchUnknown(word, button) {
  currentLookupState = {
    word,
    result: null,
    sentence: "",
    source: "search"
  };

  const key = getFavoriteKey(word, null);
  const favorites = getFavoritesData();

  if (!favorites[key]) {
    saveCurrentFavorite();
  }

  if (button) button.textContent = "★ 已收藏";
}

function favoriteDirectSearch(word) {
  if (!currentLookupState.result ||
      normalizeWord(currentLookupState.word) !== normalizeWord(word)) {
    return;
  }

  const key = getFavoriteKey(currentLookupState.word, currentLookupState.result);
  const favorites = getFavoritesData();

  if (!favorites[key]) {
    saveCurrentFavorite();
  }

  const buttons = document.getElementById("directSearchResult")
    .querySelectorAll("button");

  buttons.forEach(btn => {
    if (btn.textContent.includes("收藏")) {
      btn.textContent = "★ 已收藏";
    }
  });
}

async function refreshSearchSuggestions() {
  const input = document.getElementById("directSearchInput");
  const prefix = input.value.trim().toLowerCase();

  if (!prefix || prefix.length < 2) {
    hideSearchSuggestions();
    return;
  }

  try {
    suggestionItems = await getECDICTPrefix(prefix, 9);
    suggestionIndex = -1;
    renderSearchSuggestions();
  } catch (error) {
    console.error(error);
    hideSearchSuggestions();
  }
}

function renderSearchSuggestions() {
  const box = document.getElementById("searchSuggestions");

  if (!suggestionItems.length) {
    hideSearchSuggestions();
    return;
  }

  box.innerHTML = suggestionItems.map((item, index) => `
    <div class="suggestionItem ${index === suggestionIndex ? "active" : ""}"
         onmousedown="event.preventDefault(); chooseSuggestion(${index});">
      <span class="suggestionWord">${escapeHtml(item.word || "")}</span>
      <span class="suggestionMeaning">${escapeHtml((item.translation || "").split("\n")[0])}</span>
    </div>
  `).join("");

  box.classList.add("show");
}

function hideSearchSuggestions() {
  document.getElementById("searchSuggestions").classList.remove("show");
  suggestionIndex = -1;
}

function chooseSuggestion(index) {
  const item = suggestionItems[index];
  if (!item) return;
  directSearch(item.word);
}

const searchInput = document.getElementById("directSearchInput");

searchInput.addEventListener("input", () => {
  clearTimeout(suggestionTimer);
  suggestionTimer = setTimeout(refreshSearchSuggestions, 160);
});

searchInput.addEventListener("keydown", event => {
  if (event.key === "ArrowDown" && suggestionItems.length) {
    event.preventDefault();
    suggestionIndex = Math.min(suggestionItems.length - 1, suggestionIndex + 1);
    renderSearchSuggestions();
    return;
  }

  if (event.key === "ArrowUp" && suggestionItems.length) {
    event.preventDefault();
    suggestionIndex = Math.max(0, suggestionIndex - 1);
    renderSearchSuggestions();
    return;
  }

  if (event.key === "Escape") {
    hideSearchSuggestions();
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    if (suggestionIndex >= 0 && suggestionItems[suggestionIndex]) {
      chooseSuggestion(suggestionIndex);
    } else {
      directSearch();
    }
  }
});

searchInput.addEventListener("blur", () => {
  setTimeout(hideSearchSuggestions, 120);
});

/* =========================
   原文全文定位
   ========================= */

let articleMatches = [];
let articleMatchIndex = -1;

function updateArticleFind() {
  const input = document.getElementById("articleFindInput");
  const query = normalizeWord(input.value || "");
  const words = [...document.querySelectorAll("#article .word")];

  words.forEach(w => w.classList.remove("findMatch", "findCurrent"));
  articleMatches = [];
  articleMatchIndex = -1;

  if (!query) {
    document.getElementById("articleFindCount").textContent = "";
    return;
  }

  articleMatches = words.filter(w => normalizeWord(w.textContent) === query);
  articleMatches.forEach(w => w.classList.add("findMatch"));

  if (articleMatches.length) {
    articleMatchIndex = 0;
    focusArticleMatch();
  } else {
    document.getElementById("articleFindCount").textContent = "0 个";
  }
}

function focusArticleMatch() {
  articleMatches.forEach(w => w.classList.remove("findCurrent"));
  if (!articleMatches.length || articleMatchIndex < 0) return;

  const current = articleMatches[articleMatchIndex];
  current.classList.add("findCurrent");
  current.scrollIntoView({ behavior: "smooth", block: "center" });
  document.getElementById("articleFindCount").textContent =
    `${articleMatchIndex + 1}/${articleMatches.length}`;
}

function jumpArticleMatch(direction) {
  if (!articleMatches.length) {
    updateArticleFind();
    return;
  }

  articleMatchIndex =
    (articleMatchIndex + direction + articleMatches.length) % articleMatches.length;
  focusArticleMatch();
}

document.getElementById("articleFindInput").addEventListener("input", updateArticleFind);
document.getElementById("articleFindInput").addEventListener("keydown", event => {
  if (event.key === "Enter") jumpArticleMatch(event.shiftKey ? -1 : 1);
});

/* =========================
   模态框与设置
   ========================= */

function closeModal(id) {
  document.getElementById(id).classList.remove("show");
}

function modalBackdropClose(event, id) {
  if (event.target.id === id) closeModal(id);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "未知";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let i = 0;

  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }

  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function openSettings() {
  applyReadingPreferences();
  loadVoices();
  document.getElementById("settingsModal").classList.add("show");

  const ready = await getECDICTMeta("ready");
  const count = await getECDICTMeta("count");
  const lemmaReady = await getECDICTMeta("lemma_ready");
  const lemmaCount = await getECDICTMeta("lemma_count");

  document.getElementById("settingsDictStatus").textContent =
    ready?.value
      ? `已导入 · ${count ? Number(count.value).toLocaleString() : "未知"} 条`
      : "未导入";

  document.getElementById("settingsLemmaStatus").textContent =
    lemmaReady?.value
      ? `已导入 · ${lemmaCount ? Number(lemmaCount.value).toLocaleString() : "未知"} 条映射`
      : "未导入";

  const vocabCount = Object.keys(getVocabData()).length;
  const favoriteCount = Object.keys(getFavoritesData()).length;

  document.getElementById("settingsVocabCount").textContent =
    `${vocabCount.toLocaleString()} 条查询记录`;
  document.getElementById("settingsVocabSize").textContent =
    `约 ${formatBytes(getLocalStorageBytes(VOCAB_STORAGE_KEY))}`;

  document.getElementById("settingsFavoriteCount").textContent =
    `${favoriteCount.toLocaleString()} 个收藏`;
  document.getElementById("settingsFavoriteSize").textContent =
    `约 ${formatBytes(getLocalStorageBytes(FAVORITES_STORAGE_KEY))}`;

  const dictScan = await getECDICTMeta("scan_entries_bytes");
  const lemmaScan = await getECDICTMeta("scan_lemmas_bytes");
  const dictSource = await getECDICTMeta("source_file_size");
  const lemmaSource = await getECDICTMeta("lemma_source_file_size");

  document.getElementById("settingsDictSize").textContent = dictScan?.value
    ? `逻辑数据约 ${formatBytes(Number(dictScan.value))}`
    : dictSource?.value
      ? `导入源文件 ${formatBytes(Number(dictSource.value))}（可点“计算明细”）`
      : "旧版导入，点“计算明细”可估算";

  document.getElementById("settingsLemmaSize").textContent = lemmaScan?.value
    ? `逻辑数据约 ${formatBytes(Number(lemmaScan.value))}`
    : lemmaSource?.value
      ? `导入源文件 ${formatBytes(Number(lemmaSource.value))}（可点“计算明细”）`
      : "旧版导入，点“计算明细”可估算";

  const knownTotalBox = document.getElementById("settingsKnownTotal");
  const overheadBox = document.getElementById("settingsStorageOverhead");

  const vocabBytes = getLocalStorageBytes(VOCAB_STORAGE_KEY);
  const favoriteBytes = getLocalStorageBytes(FAVORITES_STORAGE_KEY);
  const learningBytes = vocabBytes + favoriteBytes;

  const cachedKnownBytes =
    Number(dictScan?.value || 0) +
    Number(lemmaScan?.value || 0) +
    learningBytes;

  knownTotalBox.textContent = cachedKnownBytes > learningBytes
    ? `已知数据合计：约 ${formatBytes(cachedKnownBytes)}`
    : `已知数据合计：至少 ${formatBytes(learningBytes)}（点“计算明细”统计词库）`;

  const storageBox = document.getElementById("settingsStorage");

  if (navigator.storage?.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      const usage = Number(estimate.usage || 0);

      storageBox.textContent =
        `${formatBytes(usage)} 已使用 / ${formatBytes(estimate.quota || 0)} 可用配额`;

      if (cachedKnownBytes > learningBytes && usage > 0) {
        const other = Math.max(0, usage - cachedKnownBytes);
        overheadBox.textContent =
          `数据库开销 / 其他：约 ${formatBytes(other)}（浏览器估算）`;
      } else {
        overheadBox.textContent =
          "数据库开销 / 其他：计算词库明细后可估算";
      }
    } catch {
      storageBox.textContent = "浏览器未提供精确估算";
      overheadBox.textContent = "数据库开销 / 其他：无法估算";
    }
  } else {
    storageBox.textContent = "当前浏览器不支持存储估算";
    overheadBox.textContent = "数据库开销 / 其他：无法估算";
  }
}


function getLocalStorageBytes(key) {
  const value = localStorage.getItem(key) || "";
  return new TextEncoder().encode(value).length;
}

async function estimateStoreBytes(storeName, onProgress) {
  const db = await openECDICTDatabase();
  const tx = db.transaction(storeName, "readonly");
  const store = tx.objectStore(storeName);

  return await new Promise((resolve, reject) => {
    let bytes = 0;
    let count = 0;
    const encoder = new TextEncoder();
    const req = store.openCursor();

    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve({ bytes, count });
        return;
      }

      const json = JSON.stringify(cursor.value);
      bytes += encoder.encode(json).length;
      count++;

      if (onProgress && count % 10000 === 0) onProgress(count);
      cursor.continue();
    };

    req.onerror = () => reject(req.error);
  });
}

async function scanStorageBreakdown() {
  const status = document.getElementById("storageScanStatus");
  const dictSize = document.getElementById("settingsDictSize");
  const lemmaSize = document.getElementById("settingsLemmaSize");

  try {
    status.textContent = "正在统计 ECDICT…";
    const dict = await estimateStoreBytes("entries", count => {
      status.textContent = `正在统计 ECDICT… ${count.toLocaleString()} 条`;
    });
    dictSize.textContent = `逻辑数据约 ${formatBytes(dict.bytes)} · ${dict.count.toLocaleString()} 条`;

    status.textContent = "正在统计 Lemma…";
    const lemma = await estimateStoreBytes("lemmas", count => {
      status.textContent = `正在统计 Lemma… ${count.toLocaleString()} 条`;
    });
    lemmaSize.textContent = `逻辑数据约 ${formatBytes(lemma.bytes)} · ${lemma.count.toLocaleString()} 条`;

    await setECDICTMeta("scan_entries_bytes", dict.bytes);
    await setECDICTMeta("scan_lemmas_bytes", lemma.bytes);

    const vocabBytes = getLocalStorageBytes(VOCAB_STORAGE_KEY);
    const favoriteBytes = getLocalStorageBytes(FAVORITES_STORAGE_KEY);
    const knownTotal = dict.bytes + lemma.bytes + vocabBytes + favoriteBytes;

    document.getElementById("settingsKnownTotal").textContent =
      `已知数据合计：约 ${formatBytes(knownTotal)}`;

    if (navigator.storage?.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        const usage = Number(estimate.usage || 0);
        const other = Math.max(0, usage - knownTotal);

        document.getElementById("settingsStorageOverhead").textContent =
          `数据库开销 / 其他：约 ${formatBytes(other)}（浏览器估算）`;

        document.getElementById("settingsStorage").textContent =
          `${formatBytes(usage)} 已使用 / ${formatBytes(estimate.quota || 0)} 可用配额`;
      } catch {
        document.getElementById("settingsStorageOverhead").textContent =
          "数据库开销 / 其他：无法估算";
      }
    }

    status.textContent =
      `统计完成：ECDICT + Lemma 逻辑数据约 ${formatBytes(dict.bytes + lemma.bytes)}`;
  } catch (error) {
    console.error(error);
    status.textContent = "统计失败，请稍后重试。";
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function exportLearningBackup() {
  const backup = {
    app: "EnglishReader",
    backupType: "learning",
    version: "0.5.2",
    createdAt: new Date().toISOString(),
    vocab: getVocabData(),
    favorites: getFavoritesData(),
    historyBaselines: getHistoryBaselines(),
    queryEvents: getQueryEvents(),
    preferences: {
      speed: getSpeechRate(),
      reading: getReadingPreferences()
    }
  };

  const blob = new Blob([JSON.stringify(backup, null, 2)], {
    type: "application/json;charset=utf-8"
  });

  downloadBlob(blob, `english-reader-learning-${new Date().toISOString().slice(0,10)}.json`);
  localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString());
  document.getElementById("backupReminder")?.classList.remove("show");
  document.getElementById("backupStatus").textContent = "✅ 学习数据已导出。";
}

async function appendStoreToBackupParts(storeName, type, parts, statusEl, batchSize = 600) {
  const db = await openECDICTDatabase();
  const tx = db.transaction(storeName, "readonly");
  const store = tx.objectStore(storeName);

  return await new Promise((resolve, reject) => {
    let lines = [];
    let count = 0;
    const req = store.openCursor();

    req.onsuccess = () => {
      const cursor = req.result;

      if (!cursor) {
        if (lines.length) parts.push(lines.join("\n") + "\n");
        resolve(count);
        return;
      }

      lines.push(JSON.stringify({ type, data: cursor.value }));
      count++;

      if (lines.length >= batchSize) {
        parts.push(lines.join("\n") + "\n");
        lines = [];
      }

      if (statusEl && count % 20000 === 0) {
        statusEl.textContent = `正在打包 ${type}… ${count.toLocaleString()} 条`;
      }

      cursor.continue();
    };

    req.onerror = () => reject(req.error);
  });
}

async function exportFullBackup() {
  const status = document.getElementById("backupStatus");

  if (!confirm("完整备份会包含整个 ECDICT 和 Lemma，文件可能很大，并且导出需要一些时间。继续吗？")) return;

  try {
    status.textContent = "正在准备完整备份，请不要关闭页面…";
    const parts = [];

    parts.push(JSON.stringify({
      type: "header",
      app: "EnglishReader",
      version: "0.5.2",
      createdAt: new Date().toISOString()
    }) + "\n");

    parts.push(JSON.stringify({ type: "vocab", data: getVocabData() }) + "\n");
    parts.push(JSON.stringify({ type: "favorites", data: getFavoritesData() }) + "\n");
    parts.push(JSON.stringify({ type: "historyBaselines", data: getHistoryBaselines() }) + "\n");
    parts.push(JSON.stringify({ type: "queryEvents", data: getQueryEvents() }) + "\n");
    parts.push(JSON.stringify({
      type: "preferences",
      data: {
        speed: getSpeechRate(),
        reading: getReadingPreferences()
      }
    }) + "\n");

    const entryCount = await appendStoreToBackupParts("entries", "entry", parts, status, 500);
    const lemmaCount = await appendStoreToBackupParts("lemmas", "lemma", parts, status, 1000);

    parts.push(JSON.stringify({
      type: "footer",
      entryCount,
      lemmaCount
    }) + "\n");

    status.textContent = "正在生成备份文件…";
    const blob = new Blob(parts, { type: "application/x-ndjson;charset=utf-8" });
    downloadBlob(blob, `english-reader-full-${new Date().toISOString().slice(0,10)}.erbackup`);
    localStorage.setItem(LAST_BACKUP_KEY, new Date().toISOString());
    document.getElementById("backupReminder")?.classList.remove("show");
    status.textContent = `✅ 完整备份已生成：ECDICT ${entryCount.toLocaleString()} 条，Lemma ${lemmaCount.toLocaleString()} 条。`;
  } catch (error) {
    console.error(error);
    status.textContent = "❌ 完整备份失败：" + (error.message || "未知错误");
  }
}

async function importBackupFile(file, expectedType = "auto") {
  const status = document.getElementById("backupStatus");

  // Small JSON learning backup
  if (file.name.toLowerCase().endsWith(".json")) {
    if (expectedType === "full") {
      throw new Error("这里请选择 .erbackup 完整备份文件，而不是学习数据 JSON。");
    }

    const text = await file.text();
    const data = JSON.parse(text);

    if (data.app !== "EnglishReader" || data.backupType !== "learning") {
      throw new Error("不是有效的 English Reader 学习数据备份。");
    }

    const mode = document.getElementById("learningImportMode")?.value || "merge";

    if (mode === "preview") {
      const incomingEventCount = Object.keys(data.queryEvents || {}).length;
      const incomingFavoriteCount = Object.keys(data.favorites || {}).length;
      const currentEventCount = Object.keys(getQueryEvents()).length;
      const currentFavoriteCount = Object.keys(getFavoritesData()).length;

      const ok = confirm(
        `准备智能合并：\n\n` +
        `当前：${currentEventCount} 条 V0.5.2 查询事件，${currentFavoriteCount} 个收藏\n` +
        `导入：${incomingEventCount} 条 V0.5.2 查询事件，${incomingFavoriteCount} 个收藏\n\n` +
        `相同事件 ID 会自动去重。继续吗？`
      );
      if (!ok) return;
    }

    if (mode === "overwrite") {
      if (!confirm("完全覆盖会替换当前查询记录和收藏。确定继续吗？")) return;

      setFavoritesData(data.favorites || {});
      setHistoryBaselines(data.historyBaselines || convertLegacyBackupToBaseline(data, file));
      setQueryEvents(data.queryEvents || {});
      if (!Object.keys(data.historyBaselines || {}).length && !Object.keys(data.queryEvents || {}).length) {
        setVocabData(data.vocab || {});
      } else {
        rebuildVocabFromMergeData();
      }
    } else {
      ensureHistoryMigration();

      const incomingBaselines = Object.keys(data.historyBaselines || {}).length
        ? data.historyBaselines
        : convertLegacyBackupToBaseline(data, file);

      setHistoryBaselines(mergeUniqueMaps(getHistoryBaselines(), incomingBaselines));
      setQueryEvents(mergeUniqueMaps(getQueryEvents(), data.queryEvents || {}));
      setFavoritesData(mergeFavoritesMaps(getFavoritesData(), data.favorites || {}));
      rebuildVocabFromMergeData();
    }

    if (data.preferences?.reading || data.preferences?.speed) {
      const importedReading = { ...(data.preferences?.reading || {}) };
      if (!importedReading.speechRate && data.preferences?.speed) {
        importedReading.speechRate = normalizeSpeechRate(data.preferences.speed);
      }
      localStorage.setItem(READING_PREFS_KEY, JSON.stringify({
        ...getReadingPreferences(),
        ...importedReading
      }));
      applyReadingPreferences();
    }

    const finalEventCount = Object.keys(getQueryEvents()).length;
    const finalFavoriteCount = Object.keys(getFavoritesData()).length;

    if (mode === "overwrite") {
      status.textContent =
        `✅ 已完全覆盖：当前 ${finalEventCount} 条查询事件，${finalFavoriteCount} 个收藏。`;
    } else {
      const incomingEventCount = Object.keys(data.queryEvents || {}).length;
      const incomingFavoriteCount = Object.keys(data.favorites || {}).length;

      status.textContent =
        `✅ 智能合并完成：导入包包含 ${incomingEventCount} 条查询事件、${incomingFavoriteCount} 个收藏；` +
        `合并后共有 ${finalEventCount} 条查询事件、${finalFavoriteCount} 个收藏。重复事件已自动去重。`;
    }
    return;
  }

  if (expectedType === "learning") {
    throw new Error("这里请选择由“导出学习数据”生成的 .json 文件。");
  }

  const preview = await file.slice(0, 4096).text();
  const firstLine = preview.split(/\r?\n/).find(line => line.trim());

  if (!firstLine) throw new Error("备份文件是空的。");

  let headerPreview;
  try {
    headerPreview = JSON.parse(firstLine);
  } catch {
    throw new Error("无法识别备份文件格式。");
  }

  if (headerPreview.type !== "header" || headerPreview.app !== "EnglishReader") {
    throw new Error("不是有效的 English Reader 完整备份。");
  }

  if (!confirm("恢复完整备份会覆盖当前 ECDICT、Lemma、查询记录和收藏。确定继续吗？")) return;

  status.textContent = "正在清空旧词库…";
  await clearECDICTEntries();
  await clearLemmaEntries();

  const reader = file.stream().getReader();
  const decoder = new TextDecoder("utf-8");
  let carry = "";
  let entryBatch = [];
  let lemmaBatch = [];
  let vocab = null;
  let favorites = null;
  let historyBaselines = null;
  let queryEvents = null;
  let importedPreferences = null;
  let entries = 0;
  let lemmas = 0;
  let sawHeader = false;

  async function flush() {
    if (entryBatch.length) {
      await writeECDICTBatch(entryBatch);
      entries += entryBatch.length;
      entryBatch = [];
    }

    if (lemmaBatch.length) {
      await writeLemmaBatch(lemmaBatch);
      lemmas += lemmaBatch.length;
      lemmaBatch = [];
    }
  }

  async function processLine(line) {
    if (!line.trim()) return;
    const obj = JSON.parse(line);

    if (obj.type === "header") {
      if (obj.app !== "EnglishReader") throw new Error("备份文件格式不正确。");
      sawHeader = true;
      return;
    }

    if (obj.type === "vocab") {
      vocab = obj.data || {};
      return;
    }

    if (obj.type === "favorites") {
      favorites = obj.data || {};
      return;
    }

    if (obj.type === "historyBaselines") {
      historyBaselines = obj.data || {};
      return;
    }

    if (obj.type === "queryEvents") {
      queryEvents = obj.data || {};
      return;
    }

    if (obj.type === "preferences") {
      importedPreferences = obj.data || {};
      return;
    }

    if (obj.type === "entry" && obj.data) entryBatch.push(obj.data);
    if (obj.type === "lemma" && obj.data) lemmaBatch.push(obj.data);

    if (entryBatch.length >= 1200 || lemmaBatch.length >= 2200) {
      await flush();
      status.textContent = `正在恢复… ECDICT ${entries.toLocaleString()} / Lemma ${lemmas.toLocaleString()}`;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    carry += decoder.decode(value, { stream: true });
    const lines = carry.split(/\r?\n/);
    carry = lines.pop() || "";

    for (const line of lines) await processLine(line);
  }

  carry += decoder.decode();
  if (carry.trim()) await processLine(carry);
  await flush();

  if (!sawHeader) throw new Error("没有找到备份文件头。文件可能损坏。");

  await setECDICTMeta("ready", entries > 0);
  await setECDICTMeta("count", entries);
  await setECDICTMeta("lemma_ready", lemmas > 0);
  await setECDICTMeta("lemma_count", lemmas);

  if (favorites) setFavoritesData(favorites);

  if (historyBaselines || queryEvents) {
    setHistoryBaselines(historyBaselines || {});
    setQueryEvents(queryEvents || {});
    rebuildVocabFromMergeData();
  } else if (vocab) {
    setVocabData(vocab);
    setHistoryBaselines({});
    ensureHistoryMigration();
  }

  if (importedPreferences?.reading || importedPreferences?.speed) {
    const restoredReading = { ...(importedPreferences?.reading || {}) };
    if (!restoredReading.speechRate && importedPreferences?.speed) {
      restoredReading.speechRate = normalizeSpeechRate(importedPreferences.speed);
    }
    localStorage.setItem(READING_PREFS_KEY, JSON.stringify(restoredReading));
    applyReadingPreferences();
  }

  await refreshDictionaryStatus();
  status.textContent = `✅ 恢复完成：ECDICT ${entries.toLocaleString()} 条，Lemma ${lemmas.toLocaleString()} 条。`;
}

document.getElementById("learningBackupFileInput").addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file) return;

  try {
    document.getElementById("backupStatus").textContent = "正在导入学习数据…";
    await importBackupFile(file, "learning");
  } catch (error) {
    console.error(error);
    document.getElementById("backupStatus").textContent =
      "❌ 学习数据导入失败：" + (error.message || "未知错误");
  } finally {
    event.target.value = "";
  }
});

document.getElementById("fullBackupFileInput").addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file) return;

  try {
    document.getElementById("backupStatus").textContent = "正在读取完整备份…";
    await runManualDictionaryTask(() => importBackupFile(file, "full"));
  } catch (error) {
    console.error(error);
    document.getElementById("backupStatus").textContent =
      "❌ 完整备份导入失败：" + (error.message || "未知错误");
  } finally {
    event.target.value = "";
  }
});

function openChangelog() {
  document.getElementById("changelogModal").classList.add("show");
}

async function deleteECDICTOnly() {
  if (!confirm("确定删除本地 ECDICT 词库吗？")) return;

  await runManualDictionaryTask(async () => {
    await clearECDICTEntries();
    await setECDICTMeta("ready", false);
    await setECDICTMeta("count", 0);
    await setECDICTMeta("scan_entries_bytes", 0);
  });

  await refreshDictionaryStatus();
  await openSettings();
}

async function deleteLemmaOnly() {
  if (!confirm("确定删除本地 Lemma 词形库吗？")) return;

  await runManualDictionaryTask(async () => {
    await clearLemmaEntries();
    await setECDICTMeta("lemma_ready", false);
    await setECDICTMeta("lemma_count", 0);
    await setECDICTMeta("scan_lemmas_bytes", 0);
  });

  await refreshDictionaryStatus();
  await openSettings();
}

async function deleteAllLocalDictionary() {
  if (!confirm("确定删除 ECDICT 和 Lemma 两个本地词库吗？查询记录和收藏都会保留。")) return;

  await runManualDictionaryTask(async () => {
    await clearECDICTEntries();
    await clearLemmaEntries();

    await setECDICTMeta("ready", false);
    await setECDICTMeta("count", 0);
    await setECDICTMeta("lemma_ready", false);
    await setECDICTMeta("lemma_count", 0);
    await setECDICTMeta("scan_entries_bytes", 0);
    await setECDICTMeta("scan_lemmas_bytes", 0);
  });

  await refreshDictionaryStatus();
  await openSettings();
}


document.getElementById("lemmaFileInput").addEventListener(
  "change",
  async function(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
      await runManualDictionaryTask(() => importLemmaFile(file));
      await refreshDictionaryStatus({ forceGuide: true, manual: true });
    } catch (error) {
      console.error(error);
      document.getElementById("lemmaImportStatus").textContent =
        "❌ Lemma 导入失败：" + (error.message || "未知错误");
      setDictionarySetupState(
        "error",
        "Lemma 手动导入失败",
        error.message || "未知错误",
        { showRetry: true, showManual: true, hideProgress: true }
      );
    } finally {
      event.target.value = "";
    }
  }
);

/* =========================
   单词卡片
   ========================= */

async function showWordCard(word, contextSentence = "", sourceType = "article") {
  const card = document.getElementById("wordCard");
  const emptySide = document.getElementById("emptySide");

  document.getElementById("currentWord").textContent = word;
  document.getElementById("phonetic").textContent = "";
  document.getElementById("partOfSpeech").textContent = "查询中";
  document.getElementById("meaning").textContent = "正在查询本地词库…";
  document.getElementById("ieltsBox").style.display = "none";
  document.getElementById("morphologyBox").classList.remove("show");
  document.getElementById("morphologyRelation").textContent = "";
  document.getElementById("surfaceMeaning").textContent = "";
  document.getElementById("exchangeList").innerHTML = "";
  document.getElementById("dictionaryStatus").textContent = "";
  currentLookupState = {
    word,
    result: null,
    sentence: contextSentence || "",
    source: sourceType
  };
  updateFavoriteButton();

  emptySide.style.display = "none";
  card.classList.add("show");

  if (!await isECDICTReadyForLookup()) {
    document.getElementById("partOfSpeech").textContent = "词库未准备";
    document.getElementById("meaning").textContent = getDictionaryUnavailableMessage();
    document.getElementById("dictionaryStatus").innerHTML = getDictionaryPrepareButtonHtml();
    return;
  }

  const result = await lookupWord(word);

  if (document.getElementById("currentWord").textContent !== word) return;

  if (result) {
    addToVocab(word, result, sourceType);

    currentLookupState = {
      word,
      result,
      sentence: contextSentence || "",
      source: sourceType
    };
    updateFavoriteButton();

    document.getElementById("phonetic").textContent = result.phonetic || "";
    document.getElementById("partOfSpeech").textContent =
      result.pos || "词性未标注";
    document.getElementById("meaning").textContent =
      result.meaning || "暂无中文释义";

    const exchangeItems = formatExchange(result.exchange || "");
    const hasMorphology =
      (result.baseWord && result.baseWord !== normalizeWord(word)) ||
      result.surfaceMeaning ||
      exchangeItems.length;

    if (hasMorphology) {
      document.getElementById("morphologyBox").classList.add("show");
      document.getElementById("morphologyRelation").textContent =
        result.baseWord && result.baseWord !== normalizeWord(word)
          ? `原形：${result.baseWord}（${normalizeWord(word)} → ${result.baseWord}）`
          : `词形变化：${result.baseWord || normalizeWord(word)}`;

      document.getElementById("surfaceMeaning").textContent =
        result.surfaceMeaning && result.surfaceMeaning !== result.meaning
          ? `当前词形释义：${result.surfaceMeaning}`
          : "";

      document.getElementById("exchangeList").innerHTML = exchangeItems
        .map(item => `<span class="exchangeChip">${escapeHtml(item)}</span>`)
        .join("");
    }

    document.getElementById("dictionaryStatus").textContent =
      "来源：" + result.source +
      (result.baseWord && result.baseWord !== normalizeWord(word)
        ? " · 原形：" + result.baseWord
        : "");

    if (result.ielts) {
      document.getElementById("ieltsBox").style.display = "block";
      document.getElementById("ieltsText").textContent = result.ielts;
    } else {
      document.getElementById("ieltsBox").style.display = "none";
    }
  } else {
    currentLookupState = {
      word,
      result: null,
      sentence: contextSentence || "",
      source: sourceType
    };
    updateFavoriteButton();

    addToVocab(word, null, sourceType);

    document.getElementById("phonetic").textContent = "";
    document.getElementById("partOfSpeech").textContent = "未收录";
    document.getElementById("meaning").textContent =
      "词库暂未收录。你仍然可以点“☆ 收藏”，之后在“我的收藏”里自己填写释义、词性、上下文和备注。";
    document.getElementById("ieltsBox").style.display = "none";
    document.getElementById("morphologyBox").classList.remove("show");
    document.getElementById("dictionaryStatus").textContent =
      "未命中本地词库 · 已记入查询记录 · 仍可建立个人词卡";
  }
}

function closeWordCard() {
  document.getElementById("wordCard").classList.remove("show");
  currentLookupState = { word: "", result: null, sentence: "", source: "" };
  updateFavoriteButton();

  if (window.innerWidth > 820) {
    document.getElementById("emptySide").style.display = "block";
  }

  document.querySelectorAll(".word").forEach(el => {
    el.classList.remove("active");
  });
}

/* =========================
   文章处理
   ========================= */

function normalizeDraftSource(source = {}) {
  const sourceType = ["paste", "txt", "library"].includes(source.sourceType)
    ? source.sourceType
    : "paste";
  const normalized = { sourceType };

  if (sourceType === "library" && String(source.sourceId || "").trim()) {
    normalized.sourceId = String(source.sourceId).trim();
  }
  if (String(source.sourceTitle || "").trim()) {
    normalized.sourceTitle = String(source.sourceTitle).trim();
  }
  if (String(source.sourceAttribution || "").trim()) {
    normalized.sourceAttribution = String(source.sourceAttribution).trim();
  }

  return normalized;
}

function getArticleSource(article) {
  return normalizeDraftSource({
    sourceType: article?.sourceType,
    sourceId: article?.sourceId,
    sourceTitle: article?.sourceTitle,
    sourceAttribution: article?.sourceAttribution
  });
}

function getArticleSourceLabel(article) {
  if (article?.sourceType === "txt") {
    const filename = String(article.sourceTitle || "").trim();
    return filename ? `TXT 导入 · ${filename}` : "TXT 导入";
  }
  if (article?.sourceType === "library") return "内置文章";
  return "粘贴文本";
}

function getArticleReadingLabel(article) {
  if (!article?.reading?.updatedAt) return "未开始";
  const percent = Math.round(clampReadingProgress(article.reading.progress) * 100);
  return `阅读 ${percent}%`;
}

function waitForReadingLayout() {
  return new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

async function restoreArticleReadingPosition(reading, renderToken) {
  await waitForReadingLayout();
  if (renderToken !== readingPositionRenderToken) return;

  const metrics = getArticleReadingMetrics();
  if (!metrics) {
    suppressReadingProgressSave = false;
    return;
  }

  const progress = clampReadingProgress(reading?.progress);
  let targetY = metrics.startY + progress * metrics.scrollRange;
  const paragraphIndex = Math.max(
    0,
    Math.trunc(Number(reading?.paragraphIndex) || 0)
  );
  const paragraphWord = reading?.updatedAt
    ? metrics.article.querySelector(`.word[data-paragraph-index="${paragraphIndex}"]`)
    : null;

  if (paragraphWord) {
    targetY = window.scrollY + paragraphWord.getBoundingClientRect().top - metrics.anchorOffset;
  }

  window.scrollTo({ top: Math.max(0, targetY), behavior: "auto" });
  await waitForReadingLayout();
  if (renderToken !== readingPositionRenderToken) return;

  updateReadingProgress();
  suppressReadingProgressSave = false;
}

function hasUnsavedArticleDraft() {
  const inputPanel = document.getElementById("inputPanel");
  const input = document.getElementById("inputText");
  if (!inputPanel || !input || inputPanel.style.display === "none") return false;

  if (articleDraftMode === "new") return Boolean(input.value.trim());
  if (articleDraftMode === "editing" && currentArticle) {
    return input.value !== currentArticle.content;
  }
  return false;
}

function confirmReplacingUnsavedDraft() {
  if (!hasUnsavedArticleDraft()) return true;
  return confirm("当前草稿还没有保存。继续后会放弃这些修改，是否继续？");
}

function updateMyArticlesViewUI() {
  const deletedView = myArticlesView === "deleted";
  const title = document.getElementById("myArticlesTitle");
  const subtitle = document.getElementById("myArticlesSubtitle");
  const viewButton = document.getElementById("myArticlesViewButton");
  const newDraftButton = document.getElementById("newDraftFromArticlesButton");

  if (title) title.textContent = deletedView ? "🗑️ 最近删除" : "📚 我的文章";
  if (subtitle) {
    subtitle.textContent = deletedView
      ? "这里保留已删除的文章，可以随时恢复。"
      : "从保存在本机的文章继续阅读，或开始一篇新草稿。";
  }
  if (viewButton) viewButton.textContent = deletedView ? "← 我的文章" : "最近删除";
  if (newDraftButton) newDraftButton.hidden = deletedView;
}

function toggleMyArticlesView() {
  myArticlesView = myArticlesView === "deleted" ? "active" : "deleted";
  updateMyArticlesViewUI();
  return renderMyArticles();
}

function setMyArticleBusy(articleId, item, busy) {
  if (busy) myArticleOperations.add(articleId);
  else myArticleOperations.delete(articleId);

  item?.classList.toggle("busy", busy);
  item?.querySelectorAll("button, input").forEach(control => {
    control.disabled = busy;
  });
}

function beginMyArticleOperation(articleId, item) {
  if (myArticleOperations.has(articleId)) return false;
  setMyArticleBusy(articleId, item, true);
  return true;
}

function setMyArticlesMessage(message, state, allowRetry = false) {
  const box = document.getElementById("myArticlesList");
  if (!box) return;

  box.dataset.state = state;
  const content = document.createElement("div");
  content.className = "searchEmpty";
  content.textContent = message;

  if (allowRetry) {
    const retry = document.createElement("button");
    retry.className = "secondary compactButton";
    retry.type = "button";
    retry.textContent = "重试";
    retry.addEventListener("click", () => void renderMyArticles());
    content.append(document.createElement("br"), retry);
  }

  box.replaceChildren(content);
}

function setMyArticleEditing(item, editing) {
  item.classList.toggle("editing", editing);
  const input = item.querySelector(".myArticleTitleInput");
  if (!editing || !input) return;

  input.setCustomValidity("");
  input.focus();
  input.select();
}

async function saveMyArticleTitle(articleId, item) {
  const input = item.querySelector(".myArticleTitleInput");
  if (!input) return;

  const title = input.value.trim();
  if (!title) {
    input.setCustomValidity("标题不能为空。");
    input.reportValidity();
    return;
  }

  if (!beginMyArticleOperation(articleId, item)) return;

  try {
    const library = window.LingoFlowArticleLibrary;
    if (!library) throw new Error("文章数据层未加载，请刷新页面后重试。");

    const updatedArticle = await library.updateArticle(articleId, { title });
    if (activeArticleId === updatedArticle.id && !updatedArticle.deletedAt) {
      currentArticle = updatedArticle;
    }
    await renderMyArticles();
  } catch (error) {
    setMyArticleBusy(articleId, item, false);
    input.setCustomValidity(error.message || "标题保存失败，请稍后重试。");
    input.reportValidity();
    return;
  }

  setMyArticleBusy(articleId, item, false);
}

async function deleteMyArticle(articleId, item) {
  const deletingCurrentArticle = activeArticleId === articleId;
  if (deletingCurrentArticle && !confirmReplacingUnsavedDraft()) return false;
  if (!beginMyArticleOperation(articleId, item)) return false;

  try {
    await flushReadingProgress();

    const library = window.LingoFlowArticleLibrary;
    if (!library) throw new Error("文章数据层未加载，请刷新页面后重试。");

    await library.updateArticle(articleId, {
      deletedAt: new Date().toISOString()
    });

    if (deletingCurrentArticle) {
      await startNewArticleDraft();
    }

    await renderMyArticles();
    return true;
  } catch (error) {
    alert(`文章删除失败：${error.message || "未知错误"}`);
    return false;
  } finally {
    setMyArticleBusy(articleId, item, false);
  }
}

async function restoreMyArticle(articleId, item) {
  if (!beginMyArticleOperation(articleId, item)) return false;

  try {
    const library = window.LingoFlowArticleLibrary;
    if (!library) throw new Error("文章数据层未加载，请刷新页面后重试。");

    await library.updateArticle(articleId, { deletedAt: null });
    await renderMyArticles();
    return true;
  } catch (error) {
    alert(`文章恢复失败：${error.message || "未知错误"}`);
    return false;
  } finally {
    setMyArticleBusy(articleId, item, false);
  }
}

function createMyArticleListItem(article, options = {}) {
  const deletedView = Boolean(options.deletedView);
  const item = document.createElement("div");
  item.className = "myArticleItem";
  item.dataset.articleId = article.id;

  const main = document.createElement("div");
  main.className = "myArticleMain";

  const summary = document.createElement("div");
  summary.className = "myArticleSummary";

  const title = document.createElement("div");
  title.className = "myArticleTitle";
  title.textContent = article.title || "未命名文章";

  const meta = document.createElement("div");
  meta.className = "myArticleMeta";
  meta.textContent = deletedView
    ? `${getArticleSourceLabel(article)} · 删除于：${formatLearningDate(article.deletedAt)}`
    : `${getArticleSourceLabel(article)} · ${getArticleReadingLabel(article)} · ` +
      `最近阅读：${formatLearningDate(article.lastReadAt)}`;
  summary.append(title, meta);

  if (deletedView) {
    main.append(summary);

    const actions = document.createElement("div");
    actions.className = "myArticleButtons";

    const restoreButton = document.createElement("button");
    restoreButton.className = "secondary compactButton";
    restoreButton.type = "button";
    restoreButton.textContent = "恢复";
    restoreButton.setAttribute("aria-label", `恢复文章：${article.title || "未命名文章"}`);
    restoreButton.addEventListener("click", () => {
      void restoreMyArticle(article.id, item);
    });

    actions.append(restoreButton);
    item.append(main, actions);
    return item;
  }

  const editor = document.createElement("div");
  editor.className = "myArticleTitleEditor";

  const input = document.createElement("input");
  input.className = "myArticleTitleInput";
  input.type = "text";
  input.value = article.title || "未命名文章";
  input.setAttribute("aria-label", `编辑标题：${article.title || "未命名文章"}`);
  input.addEventListener("input", () => input.setCustomValidity(""));

  const saveButton = document.createElement("button");
  saveButton.className = "compactButton";
  saveButton.type = "button";
  saveButton.textContent = "保存";
  saveButton.addEventListener("click", () => void saveMyArticleTitle(article.id, item));

  const cancelButton = document.createElement("button");
  cancelButton.className = "secondary compactButton";
  cancelButton.type = "button";
  cancelButton.textContent = "取消";
  cancelButton.addEventListener("click", () => {
    input.value = article.title || "未命名文章";
    setMyArticleEditing(item, false);
  });

  input.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveMyArticleTitle(article.id, item);
    } else if (event.key === "Escape") {
      event.stopPropagation();
      input.value = article.title || "未命名文章";
      setMyArticleEditing(item, false);
    }
  });

  editor.append(input, saveButton, cancelButton);
  main.append(summary, editor);

  const actions = document.createElement("div");
  actions.className = "myArticleButtons";

  const openButton = document.createElement("button");
  openButton.className = "secondary compactButton";
  openButton.type = "button";
  openButton.textContent = "打开";
  openButton.setAttribute("aria-label", `打开文章：${article.title || "未命名文章"}`);
  openButton.addEventListener("click", async () => {
    openButton.disabled = true;
    const opened = await openSavedArticle(article.id);
    if (!opened) openButton.disabled = false;
  });

  const editButton = document.createElement("button");
  editButton.className = "secondary compactButton";
  editButton.type = "button";
  editButton.textContent = "编辑标题";
  editButton.setAttribute("aria-label", `编辑文章标题：${article.title || "未命名文章"}`);
  editButton.addEventListener("click", () => setMyArticleEditing(item, true));

  const deleteButton = document.createElement("button");
  deleteButton.className = "secondary compactButton myArticleDeleteButton";
  deleteButton.type = "button";
  deleteButton.textContent = "删除";
  deleteButton.setAttribute("aria-label", `删除文章：${article.title || "未命名文章"}`);
  deleteButton.addEventListener("click", () => {
    void deleteMyArticle(article.id, item);
  });

  actions.append(openButton, editButton, deleteButton);
  item.append(main, actions);
  return item;
}

async function renderMyArticles() {
  const box = document.getElementById("myArticlesList");
  if (!box) return;

  const renderVersion = ++myArticlesRenderVersion;
  const renderView = myArticlesView;
  const deletedView = renderView === "deleted";
  setMyArticlesMessage("正在读取文章…", "loading");
  box.dataset.view = renderView;

  try {
    const library = window.LingoFlowArticleLibrary;
    if (!library) throw new Error("文章数据层未加载，请刷新页面后重试。");

    const articles = await library.listArticles(deletedView ? { deletedOnly: true } : {});
    if (renderVersion !== myArticlesRenderVersion || renderView !== myArticlesView) return;

    if (!articles.length) {
      setMyArticlesMessage(
        deletedView
          ? "最近删除中没有文章。"
          : "还没有文章。粘贴或导入 TXT 后，点击“生成可点击文章”会自动保存到这里。",
        "empty"
      );
      return;
    }

    const fragment = document.createDocumentFragment();
    articles.forEach(article => fragment.appendChild(
      createMyArticleListItem(article, { deletedView })
    ));
    box.dataset.state = "ready";
    box.replaceChildren(fragment);
  } catch (error) {
    if (renderVersion !== myArticlesRenderVersion || renderView !== myArticlesView) return;
    setMyArticlesMessage(
      `文章读取失败：${error.message || "未知错误"}`,
      "error",
      true
    );
  }
}

async function openMyArticles() {
  document.getElementById("myArticlesModal")?.classList.add("show");
  myArticlesView = "active";
  updateMyArticlesViewUI();
  setMyArticlesMessage("正在读取文章…", "loading");
  await flushReadingProgress();
  return renderMyArticles();
}

async function openSavedArticle(articleId) {
  if (!confirmReplacingUnsavedDraft()) return false;

  try {
    await flushReadingProgress();

    const library = window.LingoFlowArticleLibrary;
    if (!library) throw new Error("文章数据层未加载，请刷新页面后重试。");

    const article = await library.getArticle(articleId);
    if (!article || article.deletedAt) throw new Error("这篇文章已经不存在。");

    const openedArticle = await library.updateArticleReading(article.id, {
      lastReadAt: new Date().toISOString()
    });

    speechSynthesis.cancel();
    hidePhraseSelectionToolbar(true);
    closeWordCard();
    resetTxtImportUI();

    activeArticleId = openedArticle.id;
    currentArticle = openedArticle;
    articleDraftMode = "active";
    draftSource = getArticleSource(openedArticle);
    initializeReadingProgressSession(openedArticle);

    closeModal("myArticlesModal");
    await renderArticleText(openedArticle.content, {
      restoreReading: openedArticle.reading
    });
    return true;
  } catch (error) {
    alert(`无法打开文章：${error.message || "未知错误"}`);
    return false;
  }
}

async function startNewDraftFromMyArticles() {
  if (!confirmReplacingUnsavedDraft()) return false;
  await startNewArticleDraft();
  closeModal("myArticlesModal");
  return true;
}

function deriveArticleTitle(text, source) {
  if (source.sourceType === "txt" && source.sourceTitle) {
    const filenameTitle = source.sourceTitle.replace(/\.txt$/i, "").trim();
    if (filenameTitle) return filenameTitle;
  }

  const firstLine = String(text || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);
  return firstLine ? firstLine.slice(0, 80) : "未命名文章";
}

function getDraftArticlePayload(text) {
  const source = normalizeDraftSource(draftSource);
  const payload = {
    title: deriveArticleTitle(text, source),
    content: text,
    sourceType: source.sourceType
  };

  if (source.sourceId) payload.sourceId = source.sourceId;
  if (source.sourceTitle) payload.sourceTitle = source.sourceTitle;
  if (source.sourceAttribution) payload.sourceAttribution = source.sourceAttribution;
  return payload;
}

async function persistArticleDraft(text) {
  const library = window.LingoFlowArticleLibrary;
  if (!library) throw new Error("文章数据层未加载，请刷新页面后重试。");

  const now = new Date().toISOString();
  const editingCurrent = Boolean(
    activeArticleId &&
    currentArticle?.id === activeArticleId &&
    (articleDraftMode === "editing" || articleDraftMode === "active")
  );

  if (editingCurrent) {
    const changes = {
      title: currentArticle.title || deriveArticleTitle(text, getArticleSource(currentArticle)),
      content: text,
      lastReadAt: now
    };

    if (currentArticle.sourceType === "txt" && draftSource.sourceType === "paste") {
      changes.sourceType = "paste";
      changes.sourceTitle = "";
      changes.sourceAttribution = "";
    }

    return await library.updateArticle(activeArticleId, changes);
  }

  return await library.createArticle(getDraftArticlePayload(text));
}

async function renderArticleText(text, options = {}) {
  const article = document.getElementById("article");
  const renderToken = ++readingPositionRenderToken;

  suppressReadingProgressSave = true;
  cancelScheduledReadingSave();
  hidePhraseSelectionToolbar(true);
  currentArticleText = text;
  article.innerHTML = "";
  articleMatches = [];
  articleMatchIndex = -1;

  const findInput = document.getElementById("articleFindInput");
  if (findInput) findInput.value = "";

  const findCount = document.getElementById("articleFindCount");
  if (findCount) findCount.textContent = "";

  const regex = /[A-Za-z]+(?:['’][A-Za-z]+)*/g;

  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      article.appendChild(
        document.createTextNode(text.slice(lastIndex, match.index))
      );
    }

    const piece = match[0];
    const span = document.createElement("span");
    span.className = "word";
    span.textContent = piece;
    span.dataset.sentence = extractSentenceAt(text, match.index);
    span.dataset.paragraphIndex = String(getArticleParagraphIndex(text, match.index));

    span.addEventListener("click", function(event) {
      if (consumePhraseSelectionWordClick()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      document.querySelectorAll(".word").forEach(item => {
        item.classList.remove("active");
      });

      span.classList.add("active");
      speakWord(piece);
      showWordCard(piece, span.dataset.sentence || "", "article");
    });

    article.appendChild(span);
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    article.appendChild(
      document.createTextNode(text.slice(lastIndex))
    );
  }

  document.getElementById("inputPanel").style.display = "none";
  document.getElementById("readingToolbar").classList.add("show");
  document.getElementById("readerLayout").classList.add("show");

  if (options.restoreReading?.updatedAt) {
    await restoreArticleReadingPosition(options.restoreReading, renderToken);
    return;
  }

  window.scrollTo({ top: 0, behavior: "auto" });
  await waitForReadingLayout();
  if (renderToken !== readingPositionRenderToken) return;
  updateReadingProgress();
  suppressReadingProgressSave = false;
}

function generateArticle() {
  const input = document.getElementById("inputText");
  const text = input.value;
  const restoreExistingReading = Boolean(
    activeArticleId &&
    currentArticle?.id === activeArticleId &&
    articleDraftMode === "editing"
  );

  if (!text.trim()) {
    alert("请先粘贴英文文章。");
    return Promise.resolve(null);
  }

  if (articleSavePromise) return articleSavePromise;

  const startButton = document.querySelector('.controls button[onclick="generateArticle()"]');
  if (startButton) startButton.disabled = true;
  input.disabled = true;

  const savePromise = (async () => {
    try {
      const savedArticle = await persistArticleDraft(text);
      activeArticleId = savedArticle.id;
      currentArticle = savedArticle;
      articleDraftMode = "active";
      draftSource = getArticleSource(savedArticle);
      initializeReadingProgressSession(savedArticle);
      await renderArticleText(savedArticle.content, {
        restoreReading: restoreExistingReading ? savedArticle.reading : null
      });
      void requestPersistentStorageBestEffort();
      return savedArticle;
    } catch (error) {
      console.error("Article save error:", error);
      alert(
        "文章保存失败：" + (error.message || "未知错误") +
        "\n\n草稿仍保留在当前页面，请稍后重试。"
      );
      return null;
    } finally {
      input.disabled = false;
      if (startButton) startButton.disabled = false;
    }
  })();

  articleSavePromise = savePromise;
  savePromise.finally(() => {
    if (articleSavePromise === savePromise) articleSavePromise = null;
  });
  return savePromise;
}

async function editArticle() {
  await flushReadingProgress();
  readingPositionRenderToken += 1;
  suppressReadingProgressSave = false;
  speechSynthesis.cancel();
  hidePhraseSelectionToolbar(true);
  closeWordCard();

  if (currentArticle && activeArticleId === currentArticle.id) {
    articleDraftMode = "editing";
    draftSource = getArticleSource(currentArticle);
    document.getElementById("inputText").value = currentArticle.content;
  }

  document.getElementById("inputPanel").style.display = "block";
  document.getElementById("readingToolbar").classList.remove("show");
  document.getElementById("readerLayout").classList.remove("show");

  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function startNewArticleDraft(source = { sourceType: "paste" }) {
  await flushReadingProgress();
  clearReadingProgressSession();
  readingPositionRenderToken += 1;
  suppressReadingProgressSave = false;
  speechSynthesis.cancel();
  hidePhraseSelectionToolbar(true);
  closeWordCard();

  activeArticleId = null;
  currentArticle = null;
  currentArticleText = "";
  articleDraftMode = "new";
  draftSource = normalizeDraftSource(source);

  if (draftSource.sourceType !== "txt") {
    resetTxtImportUI();
  }

  document.getElementById("inputText").value = "";
  document.getElementById("inputPanel").style.display = "block";
  document.getElementById("readingToolbar").classList.remove("show");
  document.getElementById("readerLayout").classList.remove("show");
  updateReadingProgress();

  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* =========================
   TXT 导入
   ========================= */

/* Esc 键关闭释义卡 */
document.addEventListener("keydown", function(event) {
  if (event.key === "Escape") {
    hidePhraseSelectionToolbar(true);
    closeWordCard();
  }
});

ensureHistoryMigration();
initializeDictionaryOnStartup();
updateVocabBadges();
applyReadingPreferences();
initializeSpeechPreferences();
setupTextDropZone();
setupPhraseSelection();
checkBackupReminder();
updateReadingProgress();

document.addEventListener("keydown", function(event) {
  if (event.key === "Escape") {
    closeModal("vocabModal");
    closeModal("favoritesModal");
    closeModal("settingsModal");
    closeModal("readingSettingsModal");
    closeModal("helpModal");
    closeModal("changelogModal");
    closeModal("myArticlesModal");
    hideSearchSuggestions();
  }

  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    const search = document.getElementById("directSearchInput");
    void (async () => {
      if (document.getElementById("inputPanel").style.display === "none") {
        await editArticle();
      }
      search.focus();
      search.select();
      search.scrollIntoView({ behavior: "smooth", block: "center" });
    })();
  }
});
