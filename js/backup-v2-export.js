(function() {
  "use strict";

  function getArticleLibrary() {
    const library = window.LingoFlowArticleLibrary;
    return library && typeof library.listArticles === "function"
      ? library
      : null;
  }

  function getBackupSchema() {
    const schema = window.LingoFlowBackupV2Schema;
    return schema && typeof schema.validateArticles === "function"
      ? schema
      : null;
  }

  function getBackupEnvelope() {
    const envelope = window.LingoFlowBackupV2Envelope;
    return envelope && typeof envelope.buildEnvelope === "function"
      ? envelope
      : null;
  }

  function getFavoriteBackupExport() {
    const favoriteExport = window.LingoFlowFavoriteBackupExport;
    return favoriteExport && typeof favoriteExport.exportFavorites === "function"
      ? favoriteExport
      : null;
  }

  function getFavoriteLearningBackupExport() {
    const learningExport = window.LingoFlowFavoriteLearningBackupExport;
    return learningExport &&
      typeof learningExport.exportFavoriteLearningStates === "function"
      ? learningExport
      : null;
  }

  function getQueryEventBackupExport() {
    const queryEventExport = window.LingoFlowQueryEventBackupExport;
    return queryEventExport &&
      typeof queryEventExport.exportQueryEvents === "function"
      ? queryEventExport
      : null;
  }

  function getHistoryBaselineBackupExport() {
    const historyBaselineExport = window.LingoFlowHistoryBaselineBackupExport;
    return historyBaselineExport &&
      typeof historyBaselineExport.exportHistoryBaselines === "function"
      ? historyBaselineExport
      : null;
  }

  function getPreferencesBackupExport() {
    const preferencesExport = window.LingoFlowPreferencesBackupExport;
    return preferencesExport &&
      typeof preferencesExport.exportPreferences === "function"
      ? preferencesExport
      : null;
  }

  function getReadyCollection(result, entity) {
    if (!result || result.status !== "ready" ||
        !result.payload || !Array.isArray(result.payload[entity])) {
      return null;
    }
    return result.payload[entity];
  }

  function cloneCollection(collection) {
    return structuredClone(collection);
  }

  function canonicalizeJson(value) {
    if (value === null || typeof value !== "object") {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map(canonicalizeJson).join(",")}]`;
    }
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`)
      .join(",")}}`;
  }

  function collectionsMatch(first, second) {
    if (first.length !== second.length) return false;
    const firstRecords = first.map(canonicalizeJson).sort();
    const secondRecords = second.map(canonicalizeJson).sort();
    return firstRecords.every((record, index) => record === secondRecords[index]);
  }

  function findUnresolvedFavoriteIds(favorites, favoriteLearningStates) {
    const favoriteIds = new Set(favorites.map(favorite => favorite.id));
    return Array.from(new Set(
      favoriteLearningStates
        .filter(state => !favoriteIds.has(state.favoriteId))
        .map(state => state.favoriteId)
    ));
  }

  function createSnapshotReadFailure(result, entity) {
    const rejected = result?.status === "rejected";
    return {
      status: rejected ? "rejected" : "failed",
      payload: null,
      reason: rejected
        ? "inconsistent-export-snapshot"
        : "export-snapshot-verification-failed",
      entity
    };
  }

  async function exportArticles() {
    const library = getArticleLibrary();
    const schema = getBackupSchema();
    if (!library || !schema) {
      return { status: "failed", payload: null };
    }

    try {
      const articles = await library.listArticles({ includeDeleted: true });
      const validation = schema.validateArticles(articles);
      if (!validation || validation.status !== "valid") {
        return { status: "rejected", payload: null };
      }

      return {
        status: "ready",
        payload: { articles: validation.articles }
      };
    } catch (error) {
      return { status: "failed", payload: null };
    }
  }

  async function exportBackup() {
    const articleExport = await exportArticles();
    if (articleExport.status !== "ready") return articleExport;
    const exportedArticles = getReadyCollection(articleExport, "articles");
    if (!exportedArticles) {
      return { status: "failed", payload: null };
    }

    const favoriteExport = getFavoriteBackupExport();
    if (!favoriteExport) {
      return { status: "failed", payload: null };
    }

    let learningExport;
    let queryEventExport;
    let historyBaselineExport;
    let preferencesExport;
    let firstSnapshot;
    try {
      firstSnapshot = {
        articles: cloneCollection(exportedArticles)
      };
      const favoritesResult = await favoriteExport.exportFavorites();
      if (favoritesResult?.status === "rejected" ||
          favoritesResult?.status === "failed") {
        return { status: favoritesResult.status, payload: null };
      }
      const exportedFavorites = getReadyCollection(favoritesResult, "favorites");
      if (!exportedFavorites) {
        return { status: "failed", payload: null };
      }
      firstSnapshot.favorites = cloneCollection(exportedFavorites);

      learningExport = getFavoriteLearningBackupExport();
      if (!learningExport) {
        return { status: "failed", payload: null };
      }
      const learningResult = await learningExport.exportFavoriteLearningStates();
      if (learningResult?.status === "rejected" || learningResult?.status === "failed") {
        return { status: learningResult.status, payload: null };
      }
      const exportedLearningStates = getReadyCollection(
        learningResult,
        "favoriteLearningStates"
      );
      if (!exportedLearningStates) {
        return { status: "failed", payload: null };
      }
      firstSnapshot.favoriteLearningStates = cloneCollection(exportedLearningStates);

      queryEventExport = getQueryEventBackupExport();
      if (!queryEventExport) {
        return { status: "failed", payload: null };
      }
      const queryEventResult = await queryEventExport.exportQueryEvents();
      if (queryEventResult?.status === "rejected" ||
          queryEventResult?.status === "failed") {
        return { status: queryEventResult.status, payload: null };
      }
      const exportedQueryEvents = getReadyCollection(
        queryEventResult,
        "queryEvents"
      );
      if (!exportedQueryEvents) {
        return { status: "failed", payload: null };
      }
      firstSnapshot.queryEvents = cloneCollection(exportedQueryEvents);

      historyBaselineExport = getHistoryBaselineBackupExport();
      if (!historyBaselineExport) {
        return { status: "failed", payload: null };
      }
      const historyBaselineResult = await historyBaselineExport
        .exportHistoryBaselines();
      if (historyBaselineResult?.status === "rejected" ||
          historyBaselineResult?.status === "failed") {
        return { status: historyBaselineResult.status, payload: null };
      }
      const exportedHistoryBaselines = getReadyCollection(
        historyBaselineResult,
        "historyBaselines"
      );
      if (!exportedHistoryBaselines) {
        return { status: "failed", payload: null };
      }
      firstSnapshot.historyBaselines = cloneCollection(
        exportedHistoryBaselines
      );

      preferencesExport = getPreferencesBackupExport();
      if (!preferencesExport) {
        return { status: "failed", payload: null };
      }
      const preferencesResult = await preferencesExport.exportPreferences();
      if (preferencesResult?.status === "rejected" ||
          preferencesResult?.status === "failed") {
        return { status: preferencesResult.status, payload: null };
      }
      const exportedPreferences = getReadyCollection(
        preferencesResult,
        "preferences"
      );
      if (!exportedPreferences) {
        return { status: "failed", payload: null };
      }
      firstSnapshot.preferences = cloneCollection(exportedPreferences);
    } catch (error) {
      return { status: "failed", payload: null };
    }

    const unresolvedFavoriteIds = findUnresolvedFavoriteIds(
      firstSnapshot.favorites,
      firstSnapshot.favoriteLearningStates
    );
    if (unresolvedFavoriteIds.length) {
      return {
        status: "rejected",
        payload: null,
        reason: "unresolved-favorite-reference",
        unresolvedFavoriteIds
      };
    }

    try {
      const verificationSnapshot = {};
      const articleVerification = await exportArticles();
      const verifiedArticles = getReadyCollection(articleVerification, "articles");
      if (!verifiedArticles) {
        return createSnapshotReadFailure(articleVerification, "articles");
      }
      verificationSnapshot.articles = cloneCollection(verifiedArticles);

      const favoriteVerification = await favoriteExport.exportFavorites();
      const verifiedFavorites = getReadyCollection(favoriteVerification, "favorites");
      if (!verifiedFavorites) {
        return createSnapshotReadFailure(favoriteVerification, "favorites");
      }
      verificationSnapshot.favorites = cloneCollection(verifiedFavorites);

      const learningVerification = await learningExport.exportFavoriteLearningStates();
      const verifiedLearningStates = getReadyCollection(
        learningVerification,
        "favoriteLearningStates"
      );
      if (!verifiedLearningStates) {
        return createSnapshotReadFailure(
          learningVerification,
          "favoriteLearningStates"
        );
      }
      verificationSnapshot.favoriteLearningStates = cloneCollection(
        verifiedLearningStates
      );

      const queryEventVerification = await queryEventExport.exportQueryEvents();
      const verifiedQueryEvents = getReadyCollection(
        queryEventVerification,
        "queryEvents"
      );
      if (!verifiedQueryEvents) {
        return createSnapshotReadFailure(queryEventVerification, "queryEvents");
      }
      verificationSnapshot.queryEvents = cloneCollection(verifiedQueryEvents);

      const historyBaselineVerification = await historyBaselineExport
        .exportHistoryBaselines();
      const verifiedHistoryBaselines = getReadyCollection(
        historyBaselineVerification,
        "historyBaselines"
      );
      if (!verifiedHistoryBaselines) {
        return createSnapshotReadFailure(
          historyBaselineVerification,
          "historyBaselines"
        );
      }
      verificationSnapshot.historyBaselines = cloneCollection(
        verifiedHistoryBaselines
      );

      const preferencesVerification = await preferencesExport.exportPreferences();
      const verifiedPreferences = getReadyCollection(
        preferencesVerification,
        "preferences"
      );
      if (!verifiedPreferences) {
        return createSnapshotReadFailure(
          preferencesVerification,
          "preferences"
        );
      }
      verificationSnapshot.preferences = cloneCollection(verifiedPreferences);

      const snapshotMatches = collectionsMatch(
        firstSnapshot.articles,
        verificationSnapshot.articles
      ) && collectionsMatch(
        firstSnapshot.favorites,
        verificationSnapshot.favorites
      ) && collectionsMatch(
        firstSnapshot.favoriteLearningStates,
        verificationSnapshot.favoriteLearningStates
      ) && collectionsMatch(
        firstSnapshot.queryEvents,
        verificationSnapshot.queryEvents
      ) && collectionsMatch(
        firstSnapshot.historyBaselines,
        verificationSnapshot.historyBaselines
      ) && collectionsMatch(
        firstSnapshot.preferences,
        verificationSnapshot.preferences
      );
      if (!snapshotMatches) {
        return {
          status: "rejected",
          payload: null,
          reason: "inconsistent-export-snapshot"
        };
      }
    } catch (error) {
      return {
        status: "failed",
        payload: null,
        reason: "export-snapshot-verification-failed"
      };
    }

    const envelope = getBackupEnvelope();
    if (!envelope) {
      return { status: "failed", payload: null };
    }

    try {
      const result = envelope.buildEnvelope({
        articles: firstSnapshot.articles,
        favorites: firstSnapshot.favorites,
        favoriteLearningStates: firstSnapshot.favoriteLearningStates,
        queryEvents: firstSnapshot.queryEvents,
        historyBaselines: firstSnapshot.historyBaselines,
        preferences: firstSnapshot.preferences
      });
      if (result?.status === "rejected") {
        return { status: "rejected", payload: null };
      }
      if (!result || result.status !== "ready" || !result.envelope) {
        return { status: "failed", payload: null };
      }
      return { status: "ready", payload: result.envelope };
    } catch (error) {
      return { status: "failed", payload: null };
    }
  }

  window.LingoFlowBackupV2Export = Object.freeze({
    exportArticles,
    exportBackup
  });
})();
