(function() {
  "use strict";

  const MAX_ARTICLE_SYNC_CONTENT_BYTES = 1024 * 1024;
  const encoder = new TextEncoder();

  function getArticleContentUtf8Bytes(content) {
    if (typeof content !== "string") throw new TypeError("Article content must be text.");
    return encoder.encode(content).byteLength;
  }

  function validateArticleCloudSyncSize(article) {
    const bytes = getArticleContentUtf8Bytes(article?.content);
    return bytes <= MAX_ARTICLE_SYNC_CONTENT_BYTES
      ? { status: "valid", bytes }
      : { status: "article-too-large", bytes, limit: MAX_ARTICLE_SYNC_CONTENT_BYTES };
  }

  window.LingoFlowArticleSyncSize = Object.freeze({
    MAX_ARTICLE_SYNC_CONTENT_BYTES,
    getArticleContentUtf8Bytes,
    validateArticleCloudSyncSize
  });
})();
