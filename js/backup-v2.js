(function() {
  "use strict";

  const ARTICLE_RESULT_STATUSES = new Set([
    "restored",
    "unchanged",
    "conflict",
    "rejected"
  ]);
  const ENTITY_ORDER = [
    "articles",
    "favorites",
    "favoriteLearningStates",
    "queryEvents",
    "historyBaselines"
  ];
  const QUERY_HISTORY_ENTITIES = new Set([
    "queryEvents",
    "historyBaselines"
  ]);
  const ENTITY_IDENTITY_FIELDS = Object.freeze({
    articles: "articleId",
    favorites: "favoriteId",
    favoriteLearningStates: "favoriteId",
    queryEvents: "queryEventId",
    historyBaselines: "historyBaselineId"
  });
  const BATCH_RESTORE_STATUSES = new Set([
    "completed",
    "completed-with-conflicts",
    "rejected",
    "interrupted"
  ]);
  const RESTORE_ITEM_STATUSES = new Set([
    "restored",
    "unchanged",
    "conflict",
    "rejected",
    "failed",
    "not-attempted"
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
      ...(details.favoriteId ? { favoriteId: details.favoriteId } : {}),
      ...(details.queryEventId ? { queryEventId: details.queryEventId } : {}),
      ...(details.historyBaselineId
        ? { historyBaselineId: details.historyBaselineId }
        : {}),
      ...(details.entity ? { entity: details.entity } : {}),
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

  function createJsonSnapshot(value, ancestors = new WeakSet()) {
    if (value === null || ["string", "boolean"].includes(typeof value)) return value;
    if (typeof value === "number") {
      if (Number.isFinite(value)) return value;
      throw new TypeError("Backup input contains a non-finite number.");
    }
    if (typeof value !== "object") {
      throw new TypeError("Backup input is not JSON-safe.");
    }

    const isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!isArray && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Backup input contains a non-plain object.");
    }
    if (ancestors.has(value)) throw new TypeError("Backup input contains a cycle.");
    ancestors.add(value);

    const target = isArray ? new Array(value.length) : {};
    const expectedIndexes = isArray
      ? new Set(Array.from({ length: value.length }, (_, index) => String(index)))
      : null;
    for (const key of Reflect.ownKeys(value)) {
      if (isArray && key === "length") continue;
      if (typeof key !== "string" || (isArray && !expectedIndexes.has(key))) {
        ancestors.delete(value);
        throw new TypeError("Backup input contains an invalid property.");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor ||
          !descriptor.enumerable ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
        ancestors.delete(value);
        throw new TypeError("Backup input contains an accessor or hidden property.");
      }
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: createJsonSnapshot(descriptor.value, ancestors)
      });
      if (expectedIndexes) expectedIndexes.delete(key);
    }
    ancestors.delete(value);
    if (expectedIndexes?.size) throw new TypeError("Backup input contains a sparse array.");
    return target;
  }

  function validateBatchStructure(batch) {
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

    return {
      articles: batch.articles.slice(),
      errors: []
    };
  }

  function validateArticleBatch(articles) {
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

  function validateBatch(batch) {
    const validation = validateBatchStructure(batch);
    if (validation.errors.length) return validation;
    return validateArticleBatch(validation.articles);
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

  function getBackupSchema() {
    const schema = window.LingoFlowBackupV2Schema;
    if (!schema || typeof schema.validateArticles !== "function") {
      return null;
    }
    return schema;
  }

  function getBackupEnvelope() {
    const envelope = window.LingoFlowBackupV2Envelope;
    if (!envelope ||
        typeof envelope.validateEnvelope !== "function" ||
        typeof envelope.unwrapEnvelope !== "function") {
      return null;
    }
    return envelope;
  }

  function getFavoriteBackupSchema() {
    const schema = window.LingoFlowFavoriteBackupSchema;
    return schema && typeof schema.validateFavorites === "function"
      ? schema
      : null;
  }

  function getFavoriteLearningBackupSchema() {
    const schema = window.LingoFlowFavoriteLearningBackupSchema;
    return schema && typeof schema.validateFavoriteLearningStates === "function"
      ? schema
      : null;
  }

  function getQueryEventBackupSchema() {
    const schema = window.LingoFlowQueryEventBackupSchema;
    return schema && typeof schema.validateQueryEvents === "function"
      ? schema
      : null;
  }

  function getHistoryBaselineBackupSchema() {
    const schema = window.LingoFlowHistoryBaselineBackupSchema;
    return schema && typeof schema.validateHistoryBaselines === "function"
      ? schema
      : null;
  }

  function getFavoriteRepository() {
    const repository = window.LingoFlowFavoriteRepository;
    return repository && typeof repository === "object"
      ? repository
      : null;
  }

  function getFavoriteLearningRepository() {
    const repository = window.LingoFlowFavoriteLearningRepository;
    return repository &&
      typeof repository.assessBackupRestore === "function" &&
      typeof repository.restoreBackupRecords === "function"
      ? repository
      : null;
  }

  function getQueryEventRepository() {
    const repository = window.LingoFlowQueryEventRepository;
    return repository &&
      typeof repository.list === "function" &&
      typeof repository.assessBackupRestore === "function" &&
      typeof repository.restoreBackupRecords === "function"
      ? repository
      : null;
  }

  function getHistoryBaselineRepository() {
    const repository = window.LingoFlowHistoryBaselineRepository;
    return repository &&
      typeof repository.list === "function" &&
      typeof repository.assessBackupRestore === "function" &&
      typeof repository.restoreBackupRecords === "function"
      ? repository
      : null;
  }

  function getQueryHistoryMigrationCoordinator() {
    const coordinator = window.LingoFlowQueryHistoryMigrationCoordinator;
    return coordinator &&
      typeof coordinator.prepare === "function" &&
      typeof coordinator.finalize === "function"
      ? coordinator
      : null;
  }

  function getQueryHistoryProjector() {
    const projector = window.LingoFlowQueryHistoryProjector;
    return projector && typeof projector.project === "function"
      ? projector
      : null;
  }

  function getQueryData() {
    const queryData = window.LingoFlowLocalData?.QueryData;
    return queryData && typeof queryData.setVocab === "function"
      ? queryData
      : null;
  }

  function isArticleResult(result) {
    return Boolean(result) &&
      typeof result === "object" &&
      ARTICLE_RESULT_STATUSES.has(result.status);
  }

  function isArticleRestoreResult(result, articleId) {
    if (!isArticleResult(result) ||
        Array.isArray(result) ||
        result.articleId !== articleId ||
        typeof result.written !== "boolean") {
      return false;
    }
    return result.status === "restored"
      ? result.written === true
      : result.written === false;
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

  async function assessValidatedArticles(articles, articleLibrary = null) {
    const library = articleLibrary || getArticleLibrary();
    if (!library) {
      return rejectAssessment(articles, [
        createError("article-library-unavailable")
      ]);
    }

    const items = [];
    const errors = [];

    for (let index = 0; index < articles.length; index += 1) {
      const article = articles[index];
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
        const summary = summarizeAssessment(articles.length, items);
        summary.rejected += articles.length - items.length;
        return {
          status: "rejected",
          summary,
          items,
          errors
        };
      }
    }

    const summary = summarizeAssessment(articles.length, items);
    return {
      status: summary.rejected ? "rejected" : "ready",
      summary,
      items,
      errors
    };
  }

  async function assessArticles(batch) {
    const snapshot = createBatchSnapshot(batch);
    if (snapshot.error) {
      return rejectAssessment([], [snapshot.error]);
    }

    const validation = validateBatchStructure(snapshot.batch);
    if (validation.errors.length) {
      return rejectAssessment(validation.articles, validation.errors);
    }

    const schema = getBackupSchema();
    if (!schema) {
      return rejectAssessment(validation.articles, [
        createError("backup-schema-unavailable")
      ]);
    }

    let schemaValidation;
    try {
      schemaValidation = schema.validateArticles(validation.articles);
    } catch (error) {
      return rejectAssessment(validation.articles, [
        createError("backup-schema-validation-failed", {
          message: error?.message || "Backup Schema 验证失败。"
        })
      ]);
    }
    if (!schemaValidation || schemaValidation.status !== "valid") {
      const errors = Array.isArray(schemaValidation?.errors) &&
        schemaValidation.errors.length
        ? schemaValidation.errors.slice()
        : [createError("backup-schema-validation-failed")];
      return rejectAssessment(validation.articles, errors);
    }

    const batchValidation = validateArticleBatch(validation.articles);
    if (batchValidation.errors.length) {
      return rejectAssessment(batchValidation.articles, batchValidation.errors);
    }

    return assessValidatedArticles(batchValidation.articles);
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

  function rejectedSchemaRestoreResult(articles, validation, fallbackErrors = []) {
    const sourceItems = Array.isArray(validation?.items) ? validation.items : [];
    const items = sourceItems.map((item, index) => {
      const status = item?.status === "rejected" ? "rejected" : "not-attempted";
      return {
        ...item,
        index: Number.isInteger(item?.index) ? item.index : index,
        status,
        written: false
      };
    });

    for (let index = items.length; index < articles.length; index += 1) {
      items.push({
        index,
        articleId: typeof articles[index]?.id === "string" ? articles[index].id : null,
        status: "not-attempted",
        written: false
      });
    }

    const summary = createRestoreSummary(articles.length);
    summary.rejected = items.filter(item => item.status === "rejected").length;
    summary.notAttempted = articles.length - summary.rejected;
    return {
      status: "rejected",
      summary,
      items,
      errors: Array.isArray(validation?.errors)
        ? validation.errors.slice()
        : fallbackErrors
    };
  }

  function rejectedEnvelopeRestoreResult(errors) {
    return {
      status: "rejected",
      summary: createRestoreSummary(0),
      items: [],
      errors: Array.isArray(errors) ? errors.slice() : []
    };
  }

  async function restoreAssessedArticles(articles, articleLibrary = null) {
    const library = articleLibrary || getArticleLibrary();
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
        if (!isArticleRestoreResult(result, article.id)) {
          throw new Error("Article Library 返回了无效的恢复结果。");
        }
        items.push({ ...result, index });
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

  async function restoreArticles(batch) {
    const snapshot = createBatchSnapshot(batch);
    if (snapshot.error) {
      return rejectedRestoreResult(rejectAssessment([], [snapshot.error]));
    }

    const batchSnapshot = snapshot.batch;
    const snapshotArticles = batchSnapshot &&
      typeof batchSnapshot === "object" &&
      !Array.isArray(batchSnapshot)
      ? batchSnapshot.articles
      : undefined;
    const schema = getBackupSchema();
    if (!schema) {
      return rejectedSchemaRestoreResult(
        Array.isArray(snapshotArticles) ? snapshotArticles : [],
        null,
        [createError("backup-schema-unavailable")]
      );
    }

    let schemaValidation;
    try {
      schemaValidation = schema.validateArticles(snapshotArticles);
    } catch (error) {
      return rejectedSchemaRestoreResult(
        Array.isArray(snapshotArticles) ? snapshotArticles : [],
        null,
        [createError("backup-schema-validation-failed", {
          message: error?.message || "Backup Schema 验证失败。"
        })]
      );
    }
    if (!schemaValidation || schemaValidation.status !== "valid") {
      return rejectedSchemaRestoreResult(
        Array.isArray(snapshotArticles) ? snapshotArticles : [],
        schemaValidation,
        [createError("backup-schema-validation-failed")]
      );
    }

    const batchValidation = validateBatch(batchSnapshot);
    if (batchValidation.errors.length) {
      return rejectedRestoreResult(rejectAssessment(
        batchValidation.articles,
        batchValidation.errors
      ));
    }

    const assessment = await assessValidatedArticles(batchValidation.articles);
    if (assessment.status === "rejected") {
      return rejectedRestoreResult(assessment);
    }

    return restoreAssessedArticles(batchSnapshot.articles.slice());
  }

  function hasEntity(data, entity) {
    return Boolean(data) &&
      typeof data === "object" &&
      Object.prototype.hasOwnProperty.call(data, entity);
  }

  function getEntityIdentity(entity, record) {
    switch (entity) {
      case "articles":
        return { articleId: typeof record?.id === "string" ? record.id : null };
      case "favorites":
        return { favoriteId: typeof record?.id === "string" ? record.id : null };
      case "favoriteLearningStates":
        return {
          favoriteId: typeof record?.favoriteId === "string"
            ? record.favoriteId
            : null
        };
      case "queryEvents":
        return { queryEventId: typeof record?.id === "string" ? record.id : null };
      case "historyBaselines":
        return {
          historyBaselineId: typeof record?.id === "string" ? record.id : null
        };
      default:
        return null;
    }
  }

  function identityMatches(entity, record, result) {
    const identityField = ENTITY_IDENTITY_FIELDS[entity];
    const identity = getEntityIdentity(entity, record);
    return Boolean(identityField && identity) &&
      result?.[identityField] === identity[identityField];
  }

  function tagEntityErrors(entity, errors, fallbackCode) {
    const sourceErrors = Array.isArray(errors) && errors.length
      ? errors
      : [createError(fallbackCode)];
    return sourceErrors.map(error => ({
      ...error,
      entity
    }));
  }

  function schemaFailureCode(entity, unavailable = false) {
    const codes = {
      articles: ["backup-schema-validation-failed", "backup-schema-unavailable"],
      favorites: [
        "favorite-backup-schema-validation-failed",
        "favorite-backup-schema-unavailable"
      ],
      favoriteLearningStates: [
        "favorite-learning-backup-schema-validation-failed",
        "favorite-learning-backup-schema-unavailable"
      ],
      queryEvents: [
        "query-event-backup-schema-validation-failed",
        "query-event-backup-schema-unavailable"
      ],
      historyBaselines: [
        "history-baseline-backup-schema-validation-failed",
        "history-baseline-backup-schema-unavailable"
      ]
    };
    const entityCodes = codes[entity];
    return entityCodes
      ? entityCodes[unavailable ? 1 : 0]
      : "unsupported-entity";
  }

  function getSchemaValidator(entity) {
    switch (entity) {
      case "articles": {
        const schema = getBackupSchema();
        return schema ? records => schema.validateArticles(records) : null;
      }
      case "favorites": {
        const schema = getFavoriteBackupSchema();
        return schema ? records => schema.validateFavorites(records) : null;
      }
      case "favoriteLearningStates": {
        const schema = getFavoriteLearningBackupSchema();
        return schema
          ? records => schema.validateFavoriteLearningStates(records)
          : null;
      }
      case "queryEvents": {
        const schema = getQueryEventBackupSchema();
        return schema ? records => schema.validateQueryEvents(records) : null;
      }
      case "historyBaselines": {
        const schema = getHistoryBaselineBackupSchema();
        return schema ? records => schema.validateHistoryBaselines(records) : null;
      }
      default:
        return null;
    }
  }

  function collectRejectedValidationItems(entity, validation) {
    if (!Array.isArray(validation?.items)) return [];
    return validation.items
      .filter(item => item?.status === "rejected")
      .map((item, fallbackIndex) => ({
        entity,
        index: Number.isInteger(item.index) ? item.index : fallbackIndex,
        reason: "schema-rejected"
      }));
  }

  function validateBackupEntitySchemas(data, entities) {
    const collections = Object.create(null);
    const errors = [];
    const rejectedItems = [];

    for (const entity of entities) {
      const records = data[entity];
      const validate = getSchemaValidator(entity);
      if (!validate) {
        errors.push(createError(schemaFailureCode(entity, true), { entity }));
        continue;
      }

      let validation;
      try {
        validation = validate(records);
      } catch (error) {
        errors.push(createError(schemaFailureCode(entity), {
          entity,
          message: error?.message || `${entity} Schema 验证失败。`
        }));
        continue;
      }

      const validatedRecords = validation?.[entity];
      if (!validation || validation.status !== "valid" || !Array.isArray(validatedRecords)) {
        errors.push(...tagEntityErrors(
          entity,
          validation?.errors,
          schemaFailureCode(entity)
        ));
        rejectedItems.push(...collectRejectedValidationItems(entity, validation));
        continue;
      }

      if (entity === "articles") {
        const batchValidation = validateArticleBatch(validatedRecords);
        if (batchValidation.errors.length) {
          errors.push(...tagEntityErrors(
            entity,
            batchValidation.errors,
            "backup-schema-validation-failed"
          ));
          const rejectedIndexes = new Set(
            batchValidation.errors
              .filter(error => Number.isInteger(error.index))
              .map(error => error.index)
          );
          for (const index of rejectedIndexes) {
            rejectedItems.push({ entity, index, reason: "schema-rejected" });
          }
          continue;
        }
      }

      collections[entity] = validatedRecords.slice();
    }

    return {
      status: errors.length ? "rejected" : "valid",
      collections,
      errors,
      rejectedItems
    };
  }

  function buildRejectedMultiRestore(data, entities, errors, rejectedItems = []) {
    const rejectedByIdentity = new Map();
    for (const item of rejectedItems) {
      if (!item || !ENTITY_ORDER.includes(item.entity) || !Number.isInteger(item.index)) {
        continue;
      }
      const key = `${item.entity}:${item.index}`;
      if (!rejectedByIdentity.has(key)) rejectedByIdentity.set(key, item);
    }

    const items = [];
    for (const entity of entities) {
      const records = Array.isArray(data[entity]) ? data[entity] : [];
      records.forEach((record, index) => {
        const rejected = rejectedByIdentity.get(`${entity}:${index}`);
        const identity = getEntityIdentity(entity, record);
        if (!rejected) {
          items.push({
            entity,
            index,
            ...identity,
            status: "not-attempted",
            written: false
          });
          return;
        }

        const {
          entity: ignoredEntity,
          index: ignoredIndex,
          status: ignoredStatus,
          written: ignoredWritten,
          ...details
        } = rejected;
        items.push({
          entity,
          index,
          ...identity,
          ...details,
          status: "rejected",
          written: false
        });
      });
    }

    return {
      status: "rejected",
      summary: summarizeRestore(items.length, items),
      items,
      errors: Array.isArray(errors) ? errors.slice() : []
    };
  }

  async function validateLearningRelationships(collections, entities) {
    if (!entities.includes("favoriteLearningStates")) {
      return { status: "valid", errors: [], rejectedItems: [] };
    }

    const learningStates = collections.favoriteLearningStates;
    const resolvableFavoriteIds = new Set(
      entities.includes("favorites")
        ? collections.favorites.map(favorite => favorite.id)
        : []
    );
    const candidatesForLocalResolution = learningStates
      .map((state, index) => ({ state, index }))
      .filter(({ state }) => !resolvableFavoriteIds.has(state.favoriteId));

    if (candidatesForLocalResolution.length) {
      const favoriteRepository = getFavoriteRepository();
      if (!favoriteRepository || typeof favoriteRepository.list !== "function") {
        return {
          status: "rejected",
          errors: [createError("favorite-repository-unavailable", {
            entity: "favoriteLearningStates"
          })],
          rejectedItems: candidatesForLocalResolution.map(({ index }) => ({
            entity: "favoriteLearningStates",
            index,
            reason: "favorite-relationship-check-failed"
          }))
        };
      }

      let localFavorites;
      try {
        localFavorites = await favoriteRepository.list({ includeDeleted: true });
        if (!Array.isArray(localFavorites)) {
          throw new Error("Favorite Repository 返回了无效的列表。");
        }
      } catch (error) {
        return {
          status: "rejected",
          errors: [createError("favorite-relationship-check-failed", {
            entity: "favoriteLearningStates",
            message: error?.message || "Favorite 关联检查失败。"
          })],
          rejectedItems: candidatesForLocalResolution.map(({ index }) => ({
            entity: "favoriteLearningStates",
            index,
            reason: "favorite-relationship-check-failed"
          }))
        };
      }

      for (const favorite of localFavorites) {
        if (typeof favorite?.id === "string") {
          resolvableFavoriteIds.add(favorite.id);
        }
      }
    }

    const unresolved = learningStates
      .map((state, index) => ({ state, index }))
      .filter(({ state }) => !resolvableFavoriteIds.has(state.favoriteId));
    if (!unresolved.length) {
      return { status: "valid", errors: [], rejectedItems: [] };
    }

    return {
      status: "rejected",
      errors: unresolved.map(({ state, index }) => createError(
        "unresolved-favorite-reference",
        {
          entity: "favoriteLearningStates",
          index,
          favoriteId: state.favoriteId
        }
      )),
      rejectedItems: unresolved.map(({ state, index }) => ({
        entity: "favoriteLearningStates",
        index,
        favoriteId: state.favoriteId,
        reason: "unresolved-favorite-reference",
        relationshipStatus: "unresolved"
      }))
    };
  }

  function resolveDomainDependencies(entities) {
    const dependencies = Object.create(null);
    const errors = [];

    dependencies.articles = getArticleLibrary();
    if (!dependencies.articles) {
      errors.push(createError("article-library-unavailable", {
        entity: "articles"
      }));
    }

    if (entities.includes("favorites")) {
      const repository = getFavoriteRepository();
      if (!repository ||
          typeof repository.assessBackupRestore !== "function" ||
          typeof repository.restoreBackupRecords !== "function") {
        errors.push(createError("favorite-repository-unavailable", {
          entity: "favorites"
        }));
      } else {
        dependencies.favorites = repository;
      }
    }

    if (entities.includes("favoriteLearningStates")) {
      const repository = getFavoriteLearningRepository();
      if (!repository) {
        errors.push(createError("favorite-learning-repository-unavailable", {
          entity: "favoriteLearningStates"
        }));
      } else {
        dependencies.favoriteLearningStates = repository;
      }
    }

    const includesQueryHistory = entities.some(entity => QUERY_HISTORY_ENTITIES.has(entity));
    if (includesQueryHistory) {
      const repository = getQueryEventRepository();
      if (!repository && entities.includes("queryEvents")) {
        errors.push(createError("query-event-repository-unavailable", {
          entity: "queryEvents"
        }));
      }
      dependencies.queryEvents = repository;
    }

    if (includesQueryHistory) {
      const repository = getHistoryBaselineRepository();
      if (!repository && entities.includes("historyBaselines")) {
        errors.push(createError("history-baseline-repository-unavailable", {
          entity: "historyBaselines"
        }));
      }
      dependencies.historyBaselines = repository;
    }

    if (includesQueryHistory) {
      dependencies.queryHistoryMigrationCoordinator =
        getQueryHistoryMigrationCoordinator();
    }

    return { dependencies, errors };
  }

  async function assessRepositoryRecords(entity, records, repository) {
    const items = [];
    const errors = [];
    const isQueryHistory = QUERY_HISTORY_ENTITIES.has(entity);
    const allowedStatuses = isQueryHistory
      ? new Set(["restorable", "unchanged", "conflict", "rejected", "failed"])
      : ARTICLE_RESULT_STATUSES;

    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      try {
        const result = await repository.assessBackupRestore(record);
        if (!result ||
            typeof result !== "object" ||
            Array.isArray(result) ||
            !allowedStatuses.has(result.status) ||
            result.written !== false ||
            !identityMatches(entity, record, result)) {
          throw new Error(`${entity} Repository 返回了无效的评估结果。`);
        }
        items.push({ index, ...result });
        if (["rejected", "failed"].includes(result.status)) {
          const identity = getEntityIdentity(entity, record);
          errors.push(createError(result.reason || `${entity}-rejected`, {
            entity,
            index,
            ...identity
          }));
        }
      } catch (error) {
        const identity = getEntityIdentity(entity, record);
        items.push({
          index,
          ...identity,
          status: isQueryHistory ? "failed" : "rejected",
          written: false,
          reason: `${entity}-assessment-failed`
        });
        errors.push(createError(`${entity}-assessment-failed`, {
          entity,
          index,
          ...identity,
          message: error?.message || `${entity} 评估失败。`
        }));
      }
    }

    return {
      status: items.some(item => item.status === "rejected")
        ? "rejected"
        : items.some(item => item.status === "failed")
          ? "blocked"
          : "ready",
      summary: summarizeAssessment(records.length, items.map(item => (
        item.status === "restorable" ? { ...item, status: "restored" } : item
      ))),
      items,
      errors
    };
  }

  function collectRejectedAssessmentItems(entity, assessment) {
    const items = Array.isArray(assessment?.items) ? assessment.items : [];
    const rejected = items
      .filter(item => item?.status === "rejected")
      .map((item, fallbackIndex) => ({
        ...item,
        entity,
        index: Number.isInteger(item.index) ? item.index : fallbackIndex
      }));

    const knownIndexes = new Set(rejected.map(item => item.index));
    for (const error of assessment?.errors || []) {
      if (!Number.isInteger(error?.index) || knownIndexes.has(error.index)) continue;
      knownIndexes.add(error.index);
      rejected.push({
        entity,
        index: error.index,
        reason: error.code || `${entity}-rejected`
      });
    }
    return rejected;
  }

  function isReadyDomainAssessment(entity, records, assessment) {
    if (!assessment ||
        assessment.status !== "ready" ||
        !Array.isArray(assessment.items) ||
        assessment.items.length !== records.length ||
        !Array.isArray(assessment.errors) ||
        assessment.errors.length) {
      return false;
    }

    return assessment.items.every((item, index) => {
      if (!item ||
          item.index !== index ||
          item.written !== false) {
        return false;
      }
      const allowedStatuses = QUERY_HISTORY_ENTITIES.has(entity)
        ? ["restorable", "unchanged", "conflict"]
        : ["restored", "unchanged", "conflict"];
      return allowedStatuses.includes(item.status) &&
        identityMatches(entity, records[index], item);
    });
  }

  function invalidDomainAssessment(entity, records) {
    const identity = records.length ? getEntityIdentity(entity, records[0]) : {};
    return {
      status: "rejected",
      summary: summarizeAssessment(records.length, records.length ? [{
        status: "rejected"
      }] : []),
      items: records.length ? [{
        index: 0,
        ...identity,
        status: "rejected",
        written: false,
        reason: `${entity}-assessment-failed`
      }] : [],
      errors: [createError(`${entity}-assessment-failed`, {
        entity,
        ...identity,
        message: `${entity} Domain 返回了无效的评估结果。`
      })]
    };
  }

  function blockedDomainAssessment(entity, records, assessment = null) {
    const sourceItems = Array.isArray(assessment?.items) ? assessment.items : [];
    return {
      status: "blocked",
      summary: assessment?.summary || summarizeAssessment(records.length, []),
      items: records.map((record, index) => ({
        index,
        ...getEntityIdentity(entity, record),
        status: sourceItems[index]?.status === "failed" ? "failed" : "not-attempted",
        written: false,
        ...(sourceItems[index]?.reason ? { reason: sourceItems[index].reason } : {})
      })),
      errors: Array.isArray(assessment?.errors) && assessment.errors.length
        ? assessment.errors.slice()
        : [createError(`${entity}-assessment-failed`, { entity })]
    };
  }

  async function assessAllDomains(collections, entities, dependencies) {
    const assessments = Object.create(null);
    const errors = [];
    const rejectedItems = [];

    for (const entity of entities) {
      let assessment;
      if (entity === "articles") {
        assessment = await assessValidatedArticles(
          collections.articles,
          dependencies.articles
        );
      } else {
        assessment = await assessRepositoryRecords(
          entity,
          collections[entity],
          dependencies[entity]
        );
      }
      if (assessment?.status === "ready" &&
          !isReadyDomainAssessment(entity, collections[entity], assessment)) {
        assessment = QUERY_HISTORY_ENTITIES.has(entity)
          ? blockedDomainAssessment(entity, collections[entity])
          : invalidDomainAssessment(entity, collections[entity]);
      } else if (assessment?.status === "blocked") {
        assessment = blockedDomainAssessment(entity, collections[entity], assessment);
      } else if (!assessment || !["ready", "rejected"].includes(assessment.status)) {
        assessment = QUERY_HISTORY_ENTITIES.has(entity)
          ? blockedDomainAssessment(entity, collections[entity], assessment)
          : invalidDomainAssessment(entity, collections[entity]);
      }
      assessments[entity] = assessment;

      if (assessment.status === "rejected") {
        errors.push(...tagEntityErrors(
          entity,
          assessment.errors,
          `${entity}-assessment-rejected`
        ));
        rejectedItems.push(...collectRejectedAssessmentItems(entity, assessment));
      } else if (assessment.status === "blocked") {
        errors.push(...tagEntityErrors(
          entity,
          assessment.errors,
          `${entity}-assessment-failed`
        ));
      }
    }

    return {
      status: Object.values(assessments).some(item => item.status === "rejected")
        ? "rejected"
        : Object.values(assessments).some(item => item.status === "blocked")
          ? "blocked"
          : "ready",
      assessments,
      errors,
      rejectedItems
    };
  }

  function isBatchRestoreItem(entity, record, item, index) {
    if (!item ||
        typeof item !== "object" ||
        item.index !== index ||
        !RESTORE_ITEM_STATUSES.has(item.status)) {
      return false;
    }
    if (item.status === "restored"
      ? item.written !== true
      : item.written !== false) {
      return false;
    }

    return identityMatches(entity, record, item);
  }

  function isBatchRestoreResult(result, entity, records) {
    if (!result ||
        typeof result !== "object" ||
        !BATCH_RESTORE_STATUSES.has(result.status) ||
        !Array.isArray(result.items) ||
        result.items.length !== records.length ||
        !Array.isArray(result.errors) ||
        !result.items.every((item, index) => (
          isBatchRestoreItem(entity, records[index], item, index)
        ))) {
      return false;
    }

    const summary = summarizeRestore(records.length, result.items);
    if (result.status === "completed") {
      return !summary.conflicts &&
        !summary.rejected &&
        !summary.failed &&
        !summary.notAttempted;
    }
    if (result.status === "completed-with-conflicts") {
      return Boolean(summary.conflicts || summary.rejected) &&
        !summary.failed &&
        !summary.notAttempted;
    }
    return true;
  }

  function addEntityContext(entity, result) {
    return {
      ...result,
      items: result.items.map(item => ({ ...item, entity })),
      errors: result.errors.map(error => ({ ...error, entity }))
    };
  }

  function createPendingEntityResult(entity, records) {
    return {
      status: "interrupted",
      items: records.map((record, index) => ({
        entity,
        index,
        ...getEntityIdentity(entity, record),
        status: "not-attempted",
        written: false
      })),
      errors: []
    };
  }

  function createFailedEntityResult(entity, records, error) {
    const items = records.map((record, index) => ({
      entity,
      index,
      ...getEntityIdentity(entity, record),
      status: index === 0 ? "failed" : "not-attempted",
      written: false
    }));
    return {
      status: "interrupted",
      items,
      errors: [createError(`${entity}-restore-failed`, {
        entity,
        ...(records.length ? getEntityIdentity(entity, records[0]) : {}),
        message: error?.message || `${entity} 恢复失败。`
      })]
    };
  }

  function createMalformedEntityResult(entity, records, result) {
    const sourceItems = Array.isArray(result?.items) ? result.items : [];
    const items = [];
    let malformedIndex = null;

    for (let index = 0; index < records.length; index += 1) {
      const item = sourceItems[index];
      if (malformedIndex === null && isBatchRestoreItem(entity, records[index], item, index)) {
        items.push({ ...item, entity });
        continue;
      }
      if (malformedIndex === null) malformedIndex = index;
      items.push({
        entity,
        index,
        ...getEntityIdentity(entity, records[index]),
        status: index === malformedIndex ? "failed" : "not-attempted",
        written: false,
        ...(index === malformedIndex ? { reason: `${entity}-restore-result-invalid` } : {})
      });
    }

    const errors = Array.isArray(result?.errors)
      ? result.errors.map(error => ({ ...error, entity }))
      : [];
    errors.push(createError(`${entity}-restore-failed`, {
      entity,
      ...(malformedIndex !== null
        ? {
            index: malformedIndex,
            ...getEntityIdentity(entity, records[malformedIndex])
          }
        : {}),
      message: `${entity} Domain 返回了无效的恢复结果。`
    }));
    return { status: "interrupted", items, errors };
  }

  function aggregateMultiRestore(entityResults, forcedStatus = null) {
    const items = entityResults.flatMap(result => result.items);
    const errors = entityResults.flatMap(result => result.errors);
    const summary = summarizeRestore(items.length, items);
    return {
      status: forcedStatus || (summary.failed || summary.notAttempted
        ? "interrupted"
        : summary.conflicts || summary.rejected
          ? "completed-with-conflicts"
          : "completed"),
      summary,
      items,
      errors
    };
  }

  async function writeAssessedDomains(collections, entities, dependencies) {
    const entityResults = [];

    for (let entityIndex = 0; entityIndex < entities.length; entityIndex += 1) {
      const entity = entities[entityIndex];
      const records = collections[entity];
      let result;
      try {
        switch (entity) {
          case "articles":
            result = await restoreAssessedArticles(records, dependencies.articles);
            break;
          case "favorites":
            result = await dependencies.favorites.restoreBackupRecords(records);
            break;
          case "favoriteLearningStates":
            result = await dependencies.favoriteLearningStates
              .restoreBackupRecords(records);
            break;
          case "queryEvents":
            result = await dependencies.queryEvents.restoreBackupRecords(records);
            break;
          case "historyBaselines":
            result = await dependencies.historyBaselines.restoreBackupRecords(records);
            break;
          default:
            throw new Error(`不支持的 Backup entity：${entity}`);
        }
        if (!isBatchRestoreResult(result, entity, records)) {
          result = createMalformedEntityResult(entity, records, result);
        } else {
          result = addEntityContext(entity, result);
        }
      } catch (error) {
        result = createFailedEntityResult(entity, records, error);
      }
      entityResults.push(result);

      if (["rejected", "interrupted"].includes(result.status)) {
        for (let pendingIndex = entityIndex + 1;
          pendingIndex < entities.length;
          pendingIndex += 1) {
          const pendingEntity = entities[pendingIndex];
          entityResults.push(createPendingEntityResult(
            pendingEntity,
            collections[pendingEntity]
          ));
        }
        return aggregateMultiRestore(entityResults, "interrupted");
      }
    }

    return aggregateMultiRestore(entityResults);
  }

  function createMigrationPhase(status, result = null, backupWritesStarted = false) {
    return {
      status,
      outcome: result?.outcome || null,
      baselineWritten: Boolean(result?.baselineWritten),
      migrationStateWritten: Boolean(result?.migrationStateWritten),
      historyBaselineId: result?.historyBaselineId || null,
      legacyVocabStatus: result?.legacyVocabStatus || null,
      reason: result?.reason || null,
      backupWritesStarted,
      errors: Array.isArray(result?.errors)
        ? result.errors.map(error => ({ ...error }))
        : []
    };
  }

  function getOwnResultValue(value, key) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { exists: false, value: undefined };
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor &&
      descriptor.enumerable &&
      Object.prototype.hasOwnProperty.call(descriptor, "value")
      ? { exists: true, value: descriptor.value }
      : { exists: false, value: undefined };
  }

  function isMigrationCoordinatorResult(result, expectedStatus) {
    const status = getOwnResultValue(result, "status");
    const outcome = getOwnResultValue(result, "outcome");
    const baselineWritten = getOwnResultValue(result, "baselineWritten");
    const migrationStateWritten = getOwnResultValue(result, "migrationStateWritten");
    const historyBaselineId = getOwnResultValue(result, "historyBaselineId");
    const legacyVocabStatus = getOwnResultValue(result, "legacyVocabStatus");
    const reason = getOwnResultValue(result, "reason");
    const errors = getOwnResultValue(result, "errors");
    const nullableString = field => field.exists && (
      field.value === null || typeof field.value === "string"
    );

    return status.exists && status.value === expectedStatus &&
      outcome.exists && typeof outcome.value === "string" && Boolean(outcome.value) &&
      baselineWritten.exists && typeof baselineWritten.value === "boolean" &&
      migrationStateWritten.exists && typeof migrationStateWritten.value === "boolean" &&
      nullableString(historyBaselineId) &&
      nullableString(legacyVocabStatus) &&
      nullableString(reason) &&
      errors.exists && Array.isArray(errors.value) &&
      (expectedStatus === "failed" || (
        reason.value === null && errors.value.length === 0
      ));
  }

  async function verifyMigrationStateCompleted() {
    const queryData = window.LingoFlowLocalData?.QueryData;
    if (!queryData || typeof queryData.readHistoryMigrationState !== "function") {
      return {
        status: "failed",
        reason: "query-history-migration-state-reader-unavailable",
        errors: [{ code: "query-history-migration-state-reader-unavailable" }]
      };
    }
    try {
      const state = await queryData.readHistoryMigrationState();
      if (!state || state.status !== "completed") {
        throw new Error("Query History Migration State 未完成。");
      }
      return { status: "completed", errors: [] };
    } catch (error) {
      const code = error?.code || "query-history-migration-state-not-completed";
      return {
        status: "failed",
        reason: code,
        errors: [{
          code,
          ...(error?.message ? { message: error.message } : {})
        }]
      };
    }
  }

  async function prepareQueryHistoryMigration(coordinator) {
    if (!coordinator) {
      return {
        status: "failed",
        token: null,
        phase: createMigrationPhase("failed", {
          reason: "query-history-migration-coordinator-unavailable",
          errors: [{ code: "query-history-migration-coordinator-unavailable" }]
        })
      };
    }
    try {
      const result = await coordinator.prepare();
      if (isMigrationCoordinatorResult(result, "completed")) {
        return {
          status: "completed",
          token: null,
          phase: createMigrationPhase("completed", result)
        };
      }
      const token = getOwnResultValue(result, "token");
      if (isMigrationCoordinatorResult(result, "ready") &&
          token.exists && token.value && typeof token.value === "object") {
        return {
          status: "ready",
          token: token.value,
          phase: createMigrationPhase("prepared", result)
        };
      }
      const failedResult = isMigrationCoordinatorResult(result, "failed")
        ? result
        : {
            reason: "query-history-migration-prepare-result-invalid",
            errors: [{ code: "query-history-migration-prepare-result-invalid" }]
          };
      return {
        status: "failed",
        token: null,
        phase: createMigrationPhase("failed", failedResult)
      };
    } catch (error) {
      const code = error?.code || "query-history-migration-prepare-failed";
      return {
        status: "failed",
        token: null,
        phase: createMigrationPhase("failed", {
          reason: code,
          errors: [{
            code,
            ...(error?.message ? { message: error.message } : {})
          }]
        })
      };
    }
  }

  async function finalizeQueryHistoryMigration(coordinator, preparation) {
    if (preparation.status === "completed") {
      const state = await verifyMigrationStateCompleted();
      return state.status === "completed"
        ? preparation.phase
        : createMigrationPhase("failed", {
            ...preparation.phase,
            reason: state.reason,
            errors: state.errors
          });
    }
    try {
      const result = await coordinator.finalize(preparation.token);
      if (isMigrationCoordinatorResult(result, "completed")) {
        const phase = createMigrationPhase("completed", {
          ...preparation.phase,
          ...result,
          baselineWritten: preparation.phase.baselineWritten || result.baselineWritten,
          historyBaselineId: result.historyBaselineId ||
            preparation.phase.historyBaselineId
        });
        const state = await verifyMigrationStateCompleted();
        return state.status === "completed"
          ? phase
          : createMigrationPhase("failed", {
              ...phase,
              reason: state.reason,
              errors: state.errors
            });
      }
      const failedResult = isMigrationCoordinatorResult(result, "failed")
        ? result
        : {
            ...preparation.phase,
            reason: "query-history-migration-finalize-result-invalid",
            errors: [{ code: "query-history-migration-finalize-result-invalid" }]
          };
      return createMigrationPhase("failed", {
        ...failedResult,
        baselineWritten: preparation.phase.baselineWritten || failedResult.baselineWritten,
        historyBaselineId: preparation.phase.historyBaselineId ||
          failedResult.historyBaselineId
      });
    } catch (error) {
      const code = error?.code || "query-history-migration-finalize-failed";
      return createMigrationPhase("failed", {
        ...preparation.phase,
        reason: code,
        errors: [{
          code,
          ...(error?.message ? { message: error.message } : {})
        }]
      });
    }
  }

  async function readLocalQueryHistoryFacts(dependencies) {
    try {
      const queryEvents = await dependencies.queryEvents.list();
      if (!Array.isArray(queryEvents)) {
        throw new Error("QueryEvent Repository 返回了无效的列表。");
      }
      const historyBaselines = await dependencies.historyBaselines.list();
      if (!Array.isArray(historyBaselines)) {
        throw new Error("History Baseline Repository 返回了无效的列表。");
      }
      return { status: "ready", queryEvents, historyBaselines, errors: [] };
    } catch (error) {
      const code = error?.code || "query-history-local-facts-read-failed";
      return {
        status: "failed",
        queryEvents: null,
        historyBaselines: null,
        errors: [{
          code,
          ...(error?.message ? { message: error.message } : {})
        }]
      };
    }
  }

  function buildInterruptedMultiRestore(data, entities, errors, migration = null) {
    const entityResults = entities.map(entity => createPendingEntityResult(
      entity,
      Array.isArray(data[entity]) ? data[entity] : []
    ));
    const result = aggregateMultiRestore(entityResults, "interrupted");
    result.errors = Array.isArray(errors) ? errors.map(error => ({ ...error })) : [];
    if (migration) result.migration = migration;
    return result;
  }

  function buildBlockedAssessmentRestore(data, entities, assessments, errors) {
    const entityResults = entities.map(entity => {
      const records = Array.isArray(data[entity]) ? data[entity] : [];
      const assessedItems = Array.isArray(assessments?.[entity]?.items)
        ? assessments[entity].items
        : [];
      return {
        status: "interrupted",
        items: records.map((record, index) => {
          const assessed = assessedItems[index];
          const failed = assessed?.status === "failed";
          return {
            entity,
            index,
            ...getEntityIdentity(entity, record),
            status: failed ? "failed" : "not-attempted",
            written: false,
            ...(failed && assessed.reason ? { reason: assessed.reason } : {})
          };
        }),
        errors: []
      };
    });
    const result = aggregateMultiRestore(entityResults, "interrupted");
    result.errors = Array.isArray(errors) ? errors.map(error => ({ ...error })) : [];
    return result;
  }

  async function rebuildQueryHistoryVocab(dependencies) {
    const projector = getQueryHistoryProjector();
    const queryData = getQueryData();
    if (!projector || !queryData) {
      const code = !projector
        ? "query-history-projector-unavailable"
        : "query-history-vocab-persistence-unavailable";
      return {
        status: "failed",
        reason: code,
        errors: [{ code }]
      };
    }

    const facts = await readLocalQueryHistoryFacts(dependencies);
    if (facts.status !== "ready") {
      return {
        status: "failed",
        reason: facts.errors[0]?.code || "query-history-local-facts-read-failed",
        errors: facts.errors
      };
    }

    try {
      const vocab = projector.project(facts.queryEvents, facts.historyBaselines);
      queryData.setVocab(vocab);
      return {
        status: "rebuilt",
        vocabCount: Object.keys(vocab).length,
        errors: []
      };
    } catch (error) {
      const code = error?.code || "query-history-vocab-rebuild-failed";
      return {
        status: "failed",
        reason: code,
        errors: [{
          code,
          ...(error?.message ? { message: error.message } : {})
        }]
      };
    }
  }

  function hasWrittenQueryHistoryFact(result) {
    return Array.isArray(result?.items) && result.items.some(item => (
      QUERY_HISTORY_ENTITIES.has(item.entity) &&
      item.status === "restored" &&
      item.written === true
    ));
  }

  function hasAnyBackupFactWrite(result) {
    return Array.isArray(result?.items) && result.items.some(item => item.written === true);
  }

  async function attachQueryHistoryPhases(result, migration, dependencies, shouldRebuild) {
    const backupWritesStarted = hasAnyBackupFactWrite(result);
    const migrationPhase = {
      ...migration,
      backupWritesStarted
    };
    const vocabRebuild = migrationPhase.status === "completed" && shouldRebuild
      ? await rebuildQueryHistoryVocab(dependencies)
      : { status: "not-attempted", errors: [] };
    const errors = result.errors.slice();
    if (vocabRebuild.status === "failed") {
      errors.push(...vocabRebuild.errors.map(error => ({
        ...error,
        phase: "vocabRebuild"
      })));
    }
    return {
      ...result,
      status: vocabRebuild.status === "failed" &&
        ["completed", "completed-with-conflicts"].includes(result.status)
        ? "completed-with-derived-view-failure"
        : result.status,
      errors,
      migration: migrationPhase,
      vocabRebuild
    };
  }

  async function restoreMultiEntityBackup(data, entities) {
    const includesQueryHistory = entities.some(entity => QUERY_HISTORY_ENTITIES.has(entity));
    const schemaValidation = validateBackupEntitySchemas(data, entities);
    if (schemaValidation.status !== "valid") {
      const rejected = buildRejectedMultiRestore(
        data,
        entities,
        schemaValidation.errors,
        schemaValidation.rejectedItems
      );
      if (includesQueryHistory) {
        rejected.migration = createMigrationPhase("not-attempted");
        rejected.vocabRebuild = { status: "not-attempted", errors: [] };
      }
      return rejected;
    }

    const relationshipValidation = await validateLearningRelationships(
      schemaValidation.collections,
      entities
    );
    if (relationshipValidation.status !== "valid") {
      const rejected = buildRejectedMultiRestore(
        data,
        entities,
        relationshipValidation.errors,
        relationshipValidation.rejectedItems
      );
      if (includesQueryHistory) {
        rejected.migration = createMigrationPhase("not-attempted");
        rejected.vocabRebuild = { status: "not-attempted", errors: [] };
      }
      return rejected;
    }

    const dependencyResolution = resolveDomainDependencies(entities);
    if (dependencyResolution.errors.length) {
      const rejected = buildRejectedMultiRestore(
        data,
        entities,
        dependencyResolution.errors
      );
      if (includesQueryHistory) {
        rejected.migration = createMigrationPhase("not-attempted");
        rejected.vocabRebuild = { status: "not-attempted", errors: [] };
      }
      return rejected;
    }

    if (includesQueryHistory && (
      !dependencyResolution.dependencies.queryEvents ||
      !dependencyResolution.dependencies.historyBaselines ||
      !dependencyResolution.dependencies.queryHistoryMigrationCoordinator
    )) {
      const code = !dependencyResolution.dependencies.queryEvents
        ? "query-event-repository-unavailable"
        : !dependencyResolution.dependencies.historyBaselines
          ? "history-baseline-repository-unavailable"
          : "query-history-migration-coordinator-unavailable";
      const migration = createMigrationPhase("failed", {
        reason: code,
        errors: [{ code }]
      });
      const interrupted = buildInterruptedMultiRestore(
        schemaValidation.collections,
        entities,
        migration.errors.map(error => ({ ...error, phase: "migration" })),
        migration
      );
      return attachQueryHistoryPhases(
        interrupted,
        migration,
        dependencyResolution.dependencies,
        false
      );
    }

    let migrationPreparation = null;
    let migrationPhase = includesQueryHistory
      ? createMigrationPhase("not-attempted")
      : createMigrationPhase("not-required");
    if (includesQueryHistory) {
      migrationPreparation = await prepareQueryHistoryMigration(
        dependencyResolution.dependencies.queryHistoryMigrationCoordinator
      );
      migrationPhase = migrationPreparation.phase;
      if (migrationPreparation.status === "failed") {
        const interrupted = buildInterruptedMultiRestore(
          schemaValidation.collections,
          entities,
          migrationPhase.errors.map(error => ({ ...error, phase: "migration" })),
          migrationPhase
        );
        return attachQueryHistoryPhases(
          interrupted,
          migrationPhase,
          dependencyResolution.dependencies,
          migrationPhase.baselineWritten
        );
      }

      const localFacts = await readLocalQueryHistoryFacts(
        dependencyResolution.dependencies
      );
      if (localFacts.status !== "ready") {
        const interrupted = buildInterruptedMultiRestore(
          schemaValidation.collections,
          entities,
          localFacts.errors.map(error => ({ ...error, phase: "assessment" })),
          migrationPhase
        );
        return attachQueryHistoryPhases(
          interrupted,
          migrationPhase,
          dependencyResolution.dependencies,
          migrationPhase.baselineWritten
        );
      }
    }

    const domainAssessment = await assessAllDomains(
      schemaValidation.collections,
      entities,
      dependencyResolution.dependencies
    );
    if (domainAssessment.status === "rejected") {
      const rejected = buildRejectedMultiRestore(
        data,
        entities,
        domainAssessment.errors,
        domainAssessment.rejectedItems
      );
      if (!includesQueryHistory) return rejected;
      return attachQueryHistoryPhases(
        rejected,
        migrationPhase,
        dependencyResolution.dependencies,
        migrationPhase.baselineWritten
      );
    }
    if (domainAssessment.status === "blocked") {
      const interrupted = buildBlockedAssessmentRestore(
        schemaValidation.collections,
        entities,
        domainAssessment.assessments,
        domainAssessment.errors
      );
      if (!includesQueryHistory) return interrupted;
      return attachQueryHistoryPhases(
        interrupted,
        migrationPhase,
        dependencyResolution.dependencies,
        migrationPhase.baselineWritten
      );
    }

    if (includesQueryHistory) {
      migrationPhase = await finalizeQueryHistoryMigration(
        dependencyResolution.dependencies.queryHistoryMigrationCoordinator,
        migrationPreparation
      );
      if (migrationPhase.status !== "completed") {
        const interrupted = buildInterruptedMultiRestore(
          schemaValidation.collections,
          entities,
          migrationPhase.errors.map(error => ({ ...error, phase: "migration" })),
          migrationPhase
        );
        return attachQueryHistoryPhases(
          interrupted,
          migrationPhase,
          dependencyResolution.dependencies,
          migrationPhase.baselineWritten
        );
      }
    }

    const restored = await writeAssessedDomains(
      schemaValidation.collections,
      entities,
      dependencyResolution.dependencies
    );
    if (!includesQueryHistory) return restored;

    const shouldRebuild = ["completed", "completed-with-conflicts"].includes(
      restored.status
    ) || migrationPhase.baselineWritten || hasWrittenQueryHistoryFact(restored);
    return attachQueryHistoryPhases(
      restored,
      migrationPhase,
      dependencyResolution.dependencies,
      shouldRebuild
    );
  }

  async function restoreBackup(envelopeValue) {
    const envelope = getBackupEnvelope();
    if (!envelope) {
      return rejectedEnvelopeRestoreResult([
        createError("backup-envelope-unavailable")
      ]);
    }

    let envelopeSnapshot;
    try {
      envelopeSnapshot = createJsonSnapshot(envelopeValue);
    } catch (error) {
      return rejectedEnvelopeRestoreResult([
        createError("backup-envelope-snapshot-failed", {
          message: error?.message || "Backup Envelope 无法创建安全快照。"
        })
      ]);
    }

    let validation;
    try {
      validation = envelope.validateEnvelope(envelopeSnapshot);
    } catch (error) {
      return rejectedEnvelopeRestoreResult([
        createError("backup-envelope-validation-failed", {
          message: error?.message || "Backup Envelope 验证失败。"
        })
      ]);
    }
    if (!validation || validation.status !== "valid") {
      return rejectedEnvelopeRestoreResult(
        validation?.errors || [createError("backup-envelope-validation-failed")]
      );
    }

    let unwrapped;
    try {
      unwrapped = envelope.unwrapEnvelope(envelopeSnapshot);
    } catch (error) {
      return rejectedEnvelopeRestoreResult([
        createError("backup-envelope-unpack-failed", {
          message: error?.message || "Backup Envelope 解包失败。"
        })
      ]);
    }
    if (!unwrapped || unwrapped.status !== "valid") {
      return rejectedEnvelopeRestoreResult(
        unwrapped?.errors || [createError("backup-envelope-unpack-failed")]
      );
    }

    const data = unwrapped.data;
    const unknownEntities = Object.keys(data)
      .filter(entity => !ENTITY_ORDER.includes(entity));
    if (unknownEntities.length) {
      return rejectedEnvelopeRestoreResult(unknownEntities.map(entity => ({
        code: "unsupported-entity",
        path: `data.${entity}`,
        entity
      })));
    }

    const entities = ENTITY_ORDER.filter(entity => hasEntity(data, entity));
    if (entities.length === 1 && entities[0] === "articles") {
      return restoreArticles(data);
    }
    return restoreMultiEntityBackup(data, entities);
  }

  window.LingoFlowBackupV2 = Object.freeze({
    assessArticles,
    restoreArticles,
    restoreBackup
  });
})();
