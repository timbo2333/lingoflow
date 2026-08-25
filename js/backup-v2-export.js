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

      const snapshotMatches = collectionsMatch(
        firstSnapshot.articles,
        verificationSnapshot.articles
      ) && collectionsMatch(
        firstSnapshot.favorites,
        verificationSnapshot.favorites
      ) && collectionsMatch(
        firstSnapshot.favoriteLearningStates,
        verificationSnapshot.favoriteLearningStates
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
        favoriteLearningStates: firstSnapshot.favoriteLearningStates
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
