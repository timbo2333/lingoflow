(function() {
  "use strict";

  function getLegacyFavoriteData() {
    const favoriteData = window.LingoFlowLocalData?.FavoriteData;
    if (!favoriteData ||
        typeof favoriteData.getAll !== "function" ||
        typeof favoriteData.setAll !== "function") {
      throw new Error("Legacy Favorite backup storage is unavailable.");
    }
    return favoriteData;
  }

  function getLegacyFavoriteType(item) {
    return item?.type === "phrase" ? "phrase" : "word";
  }

  function normalizeLegacyPhraseText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getLegacyPhraseIdentity(text) {
    return normalizeLegacyPhraseText(text)
      .toLowerCase()
      .replace(/’/g, "'");
  }

  function getLegacyPhraseMapKey(text) {
    const identity = getLegacyPhraseIdentity(text);
    return identity ? `phrase:${identity}` : "";
  }

  function getCanonicalLegacyMapKey(fallbackKey, item) {
    if (getLegacyFavoriteType(item) !== "phrase") return fallbackKey;

    const text = item?.word || item?.displayWord ||
      String(fallbackKey || "").replace(/^phrase:/, "");
    return getLegacyPhraseMapKey(text) || fallbackKey;
  }

  function mergeLegacyRecords(a, b) {
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
        .sort((x, y) => new Date(x) - new Date(y))[0] || newer.createdAt,
      updatedAt: newer.updatedAt || older.updatedAt
    };
  }

  function readSnapshot() {
    return getLegacyFavoriteData().getAll();
  }

  function replaceSnapshot(snapshot) {
    getLegacyFavoriteData().setAll(snapshot || {});
  }

  function mergeSnapshots(current, incoming) {
    const result = {};

    for (const source of [current || {}, incoming || {}]) {
      for (const [key, value] of Object.entries(source)) {
        const targetKey = getCanonicalLegacyMapKey(key, value);
        result[targetKey] = mergeLegacyRecords(result[targetKey], value);
      }
    }

    return result;
  }

  function countSnapshot(snapshot = undefined) {
    const value = snapshot === undefined ? readSnapshot() : snapshot;
    return Object.keys(value || {}).length;
  }

  window.LingoFlowLegacyFavoriteBackup = Object.freeze({
    readSnapshot,
    replaceSnapshot,
    mergeSnapshots,
    countSnapshot
  });
})();
