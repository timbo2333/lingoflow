"use strict";

// DOM/script-loading simulation only: no CDN request or claim that mock bytes
// pass browser SRI. Native SRI is independently smoke-checked with audited bytes.
async function installPinnedSdkMock(page) {
  await page.addInitScript(() => {
    const src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js";
    const integrity = "sha256-WdOUh8NYmEO0EDItij1WLOAiq6HlzLFomO8/sqDaLs0=";
    // At init-script time document.head may not yet exist. Patch the prototype,
    // but intercept only the exact SDK element appended to the actual head.
    const nativeAppend = Node.prototype.appendChild;
    Node.prototype.appendChild = function(node) {
      if (this !== document.head || node.tagName !== "SCRIPT" || node.src !== src) {
        return nativeAppend.call(this, node);
      }
      if (node.integrity !== integrity || node.crossOrigin !== "anonymous") {
        throw new Error("Pinned SDK mock requires exact pre-append SRI/CORS");
      }
      window.__pinnedSdkMockLoadCount = (window.__pinnedSdkMockLoadCount || 0) + 1;
      queueMicrotask(() => {
        const descriptor = Object.getOwnPropertyDescriptor(document, "currentScript");
        Object.defineProperty(document, "currentScript", { configurable: true, value: node });
        try {
          window.supabase = window.__pinnedSdkMockFactory();
        } finally {
          if (descriptor) Object.defineProperty(document, "currentScript", descriptor);
          else delete document.currentScript;
        }
        node.onload?.(new Event("load"));
      });
      return node;
    };
  });
}

module.exports = { installPinnedSdkMock };
