(function() {
  "use strict";

  const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;
  const encoder = new TextEncoder();

  function normalizeCheckpoint(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (typeof value.progress !== "number" || !Number.isFinite(value.progress) ||
        value.progress < 0 || value.progress > 1 ||
        !Number.isInteger(value.paragraphIndex) || value.paragraphIndex < 0 ||
        typeof value.contentFingerprint !== "string" ||
        !FINGERPRINT_PATTERN.test(value.contentFingerprint) ||
        typeof value.updatedAt !== "string" || !value.updatedAt.trim() ||
        !Number.isFinite(Date.parse(value.updatedAt))) {
      return null;
    }
    return {
      progress: value.progress,
      paragraphIndex: value.paragraphIndex,
      contentFingerprint: value.contentFingerprint,
      updatedAt: value.updatedAt
    };
  }

  async function fingerprintContent(content) {
    if (typeof content !== "string") throw new TypeError("Article content must be text.");
    if (!window.crypto?.subtle?.digest) throw new Error("SHA-256 is unavailable.");
    const digest = await window.crypto.subtle.digest("SHA-256", encoder.encode(content));
    return "sha256:" + Array.from(new Uint8Array(digest), byte =>
      byte.toString(16).padStart(2, "0")
    ).join("");
  }

  function createCheckpoint(position, contentFingerprint, updatedAt = new Date().toISOString()) {
    const checkpoint = normalizeCheckpoint({
      progress: position?.progress,
      paragraphIndex: position?.paragraphIndex,
      contentFingerprint,
      updatedAt
    });
    if (!checkpoint) throw new Error("Resume checkpoint 无效。");
    return checkpoint;
  }

  function validForContent(reading, contentFingerprint) {
    const checkpoint = normalizeCheckpoint(reading?.resume);
    return checkpoint?.contentFingerprint === contentFingerprint ? checkpoint : null;
  }

  function positionChanged(left, right) {
    if (!left || !right) return false;
    return left.paragraphIndex !== right.paragraphIndex ||
      Math.abs(left.progress - right.progress) >= 0.002;
  }

  window.LingoFlowReadingResume = Object.freeze({
    normalizeCheckpoint,
    fingerprintContent,
    createCheckpoint,
    validForContent,
    positionChanged
  });
})();
