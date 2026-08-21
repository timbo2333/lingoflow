(function() {
  "use strict";

  const ARTICLE_RESULT_STATUSES = new Set([
    "restored",
    "unchanged",
    "conflict",
    "rejected"
  ]);

  function createAssessmentSummary(total = 0) {
    return {
      total,
      restorable: 0,
      unchanged: 0,
      conflicts: 0,
      rejected: 0
    };
  }

  function createRestoreSummary(total = 0) {
    return {
      total,
      restored: 0,
      unchanged: 0,
      conflicts: 0,
      rejected: 0,
      failed: 0,
      notAttempted: 0
    };
  }

  function createError(code, details = {}) {
    return {
      code,
      ...(Number.isInteger(details.index) ? { index: details.index } : {}),
      ...(details.articleId ? { articleId: details.articleId } : {}),
      ...(details.conflictingArticleId
        ? { conflictingArticleId: details.conflictingArticleId }
        : {}),
      ...(details.message ? { message: details.message } : {})
    };
  }

  function createBatchSnapshot(batch) {
    try {
      return {
        batch: structuredClone(batch),
        error: null
      };
    } catch (error) {
      return {
        batch: null,
        error: createError("invalid-batch", {
          message: error?.message || "Article 批次无法创建快照。"
        })
      };
    }
  }

  function validateBatch(batch) {
    if (!batch || typeof batch !== "object" || Array.isArray(batch)) {
      return {
        articles: [],
        errors: [createError("invalid-batch")]
      };
    }
    if (!Object.prototype.hasOwnProperty.call(batch, "articles")) {
      return {
        articles: [],
        errors: [createError("missing-articles")]
      };
    }
    if (!Array.isArray(batch.articles)) {
      return {
        articles: [],
        errors: [createError("invalid-articles")]
      };
    }

    const articles = batch.articles.slice();
    const errors = [];
    const ids = new Map();
    const sources = new Map();

    articles.forEach((article, index) => {
      const articleId = typeof article?.id === "string" ? article.id : null;
      if (articleId) {
        if (ids.has(articleId)) {
          errors.push(createError("duplicate-article-id", {
            index,
            articleId,
            conflictingArticleId: articleId
          }));
        } else {
          ids.set(articleId, index);
        }
      }

      if (article?.sourceType !== "library" ||
          typeof article.sourceId !== "string" ||
          !article.sourceId.trim() ||
          !articleId) {
        return;
      }

      const sourceKey = article.sourceId.trim();
      const existing = sources.get(sourceKey);
      if (existing && existing.articleId !== articleId) {
        errors.push(createError("duplicate-article-source", {
          index,
          articleId,
          conflictingArticleId: existing.articleId
        }));
      } else if (!existing) {
        sources.set(sourceKey, { articleId, index });
      }
    });

    return { articles, errors };
  }

  function getArticleLibrary() {
    const library = window.LingoFlowArticleLibrary;
    if (!library ||
        typeof library.assessArticleRestore !== "function" ||
        typeof library.restoreArticle !== "function") {
      return null;
    }
    return library;
  }

  function isArticleResult(result) {
    return Boolean(result) &&
      typeof result === "object" &&
      ARTICLE_RESULT_STATUSES.has(result.status);
  }

  function summarizeAssessment(total, items) {
    const summary = createAssessmentSummary(total);
    for (const item of items) {
      if (item.status === "restored") summary.restorable += 1;
      else if (item.status === "unchanged") summary.unchanged += 1;
      else if (item.status === "conflict") summary.conflicts += 1;
      else if (item.status === "rejected") summary.rejected += 1;
    }
    return summary;
  }

  function summarizeRestore(total, items) {
    const summary = createRestoreSummary(total);
    for (const item of items) {
      if (item.status === "restored" && item.written) summary.restored += 1;
      else if (item.status === "unchanged") summary.unchanged += 1;
      else if (item.status === "conflict") summary.conflicts += 1;
      else if (item.status === "rejected") summary.rejected += 1;
      else if (item.status === "failed") summary.failed += 1;
      else if (item.status === "not-attempted") summary.notAttempted += 1;
    }
    return summary;
  }

  function rejectAssessment(articles, errors, items = []) {
    const summary = summarizeAssessment(articles.length, items);
    if (!items.length && articles.length) summary.rejected = articles.length;
    return {
      status: "rejected",
      summary,
      items,
      errors
    };
  }

  async function assessArticles(batch) {
    const validation = validateBatch(batch);
    if (validation.errors.length) {
      return rejectAssessment(validation.articles, validation.errors);
    }

    const library = getArticleLibrary();
    if (!library) {
      return rejectAssessment(validation.articles, [
        createError("article-library-unavailable")
      ]);
    }

    const items = [];
    const errors = [];

    for (let index = 0; index < validation.articles.length; index += 1) {
      const article = validation.articles[index];
      try {
        const result = await library.assessArticleRestore(article);
        if (!isArticleResult(result)) {
          throw new Error("Article Library 返回了无效的评估结果。");
        }
        const item = { index, ...result };
        items.push(item);
        if (result.status === "rejected") {
          errors.push(createError(result.reason || "article-rejected", {
            index,
            articleId: result.articleId
          }));
        }
      } catch (error) {
        errors.push(createError("article-assessment-failed", {
          index,
          articleId: article?.id,
          message: error?.message || "Article 评估失败。"
        }));
        const summary = summarizeAssessment(validation.articles.length, items);
        summary.rejected += validation.articles.length - items.length;
        return {
          status: "rejected",
          summary,
          items,
          errors
        };
      }
    }

    const summary = summarizeAssessment(validation.articles.length, items);
    return {
      status: summary.rejected ? "rejected" : "ready",
      summary,
      items,
      errors
    };
  }

  function rejectedRestoreResult(assessment) {
    const summary = createRestoreSummary(assessment.summary.total);
    summary.rejected = Math.min(assessment.summary.total, assessment.summary.rejected);
    summary.notAttempted = assessment.summary.total - summary.rejected;
    return {
      status: "rejected",
      summary,
      items: assessment.items.map(item => item.status === "rejected"
        ? item
        : {
            ...item,
            assessmentStatus: item.status,
            status: "not-attempted",
            written: false
          }),
      errors: assessment.errors
    };
  }

  async function restoreArticles(batch) {
    const snapshot = createBatchSnapshot(batch);
    if (snapshot.error) {
      return rejectedRestoreResult(rejectAssessment([], [snapshot.error]));
    }

    const batchSnapshot = snapshot.batch;
    const assessment = await assessArticles(batchSnapshot);
    if (assessment.status === "rejected") {
      return rejectedRestoreResult(assessment);
    }

    const articles = batchSnapshot.articles.slice();
    const library = getArticleLibrary();
    if (!library) {
      const summary = createRestoreSummary(articles.length);
      summary.failed = articles.length ? 1 : 0;
      summary.notAttempted = Math.max(0, articles.length - summary.failed);
      return {
        status: "interrupted",
        summary,
        items: articles.map((article, index) => ({
          index,
          articleId: article?.id || null,
          status: index === 0 ? "failed" : "not-attempted",
          written: false
        })),
        errors: [createError("article-library-unavailable")]
      };
    }

    const items = [];
    const errors = [];

    for (let index = 0; index < articles.length; index += 1) {
      const article = articles[index];
      try {
        const result = await library.restoreArticle(article);
        if (!isArticleResult(result) ||
            (result.status === "restored" && !result.written)) {
          throw new Error("Article Library 返回了无效的恢复结果。");
        }
        items.push({ index, ...result });
        if (result.status === "rejected") {
          errors.push(createError(result.reason || "article-rejected", {
            index,
            articleId: result.articleId
          }));
        }
      } catch (error) {
        items.push({
          index,
          articleId: typeof article?.id === "string" ? article.id : null,
          status: "failed",
          written: false
        });
        errors.push(createError("article-restore-failed", {
          index,
          articleId: article?.id,
          message: error?.message || "Article 恢复失败。"
        }));

        for (let pendingIndex = index + 1; pendingIndex < articles.length; pendingIndex += 1) {
          items.push({
            index: pendingIndex,
            articleId: typeof articles[pendingIndex]?.id === "string"
              ? articles[pendingIndex].id
              : null,
            status: "not-attempted",
            written: false
          });
        }

        return {
          status: "interrupted",
          summary: summarizeRestore(articles.length, items),
          items,
          errors
        };
      }
    }

    const summary = summarizeRestore(articles.length, items);
    return {
      status: summary.conflicts || summary.rejected
        ? "completed-with-conflicts"
        : "completed",
      summary,
      items,
      errors
    };
  }

  window.LingoFlowBackupV2 = Object.freeze({
    assessArticles,
    restoreArticles
  });
})();
