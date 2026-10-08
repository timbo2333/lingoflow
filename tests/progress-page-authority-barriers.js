"use strict";

// Serializable, test-tooling-only utility. It has NO fetch/permit capability.
// Each native readonly transaction owns one pending request until final() has
// returned. No network, timer, crypto or Promise is awaited inside a request
// callback. Two independent DB locks, NOT a cross-DB atomic transaction.
function withPageAuthorityBarriers(syncDB, libraryDB, expected, current, final, notAfter) {
  return new Promise(resolve => {
    let finished = false, sync, library;
    const alive = { sync: false, library: false };
    const facts = { binding: null, workspace: null, transitionChecked: false };
    const stop = result => {
      if (finished) return;
      finished = true;
      try { sync?.abort(); } catch { /* readonly lock already released */ }
      try { library?.abort(); } catch { /* readonly lock already released */ }
      resolve(result);
    };
    const blocked = () => stop({ invoked: false, reason: "page-authority-invalid" });
    const valid = () => !finished && performance.now() < notAfter && current() === true;
    const attach = (tx, name) => {
      alive[name] = true;
      tx.oncomplete = tx.onabort = tx.onerror = () => {
        alive[name] = false;
        if (!finished) blocked();
      };
    };
    const marker = () => {
      if (!facts.binding || !facts.workspace || !facts.transitionChecked) return;
      if (!alive.sync || !alive.library || !valid()) { blocked(); return; }
      // final is the private sender's synchronous guard + native invocation,
      // NOT caller input, an async helper or a returned continuation.
      let result;
      try { result = final(); } catch { result = { invoked: true, reason: "page-send-unknown" }; }
      stop(result); // Never hold either transaction for the HTTP response.
    };
    const readLibrary = () => {
      library = libraryDB.transaction("progressControl", "readonly");
      attach(library, "library");
      const store = library.objectStore("progressControl");
      const next = () => {
        const request = store.get("workspace");
        request.onerror = blocked;
        request.onsuccess = () => {
          if (!valid()) { blocked(); return; }
          const value = request.result;
          if (value?.ownerId !== expected.ownerId || value.bindingId !== expected.bindingId ||
              value.scopeToken !== expected.scopeToken) { blocked(); return; }
          facts.workspace = value;
          const transition = store.get("workspace-transition");
          transition.onerror = blocked;
          transition.onsuccess = () => {
            if (!valid() || transition.result !== undefined) { blocked(); return; }
            facts.transitionChecked = true;
            next(); // Pending native request preserves the Library lock.
            marker();
          };
        };
      };
      next();
    };
    try {
      if (!valid()) { blocked(); return; }
      sync = syncDB.transaction("control", "readonly");
      attach(sync, "sync");
      const store = sync.objectStore("control");
      const next = () => {
        const request = store.get("workspace-binding");
        request.onerror = blocked;
        request.onsuccess = () => {
          if (!valid()) { blocked(); return; }
          const value = request.result;
          if (value?.ownerId !== expected.ownerId || value.bindingId !== expected.bindingId) { blocked(); return; }
          facts.binding = value;
          next(); // Pending native request preserves the Sync lock.
          if (!library) readLibrary();
          marker();
        };
      };
      next();
    } catch { blocked(); }
  });
}

module.exports = { withPageAuthorityBarriers };
