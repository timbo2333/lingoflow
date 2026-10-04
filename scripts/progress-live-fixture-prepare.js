#!/usr/bin/env node
"use strict";

// Foundation only: CLI has NO real adapter. Even with both LIVE gates set it
// cannot write a server. A separately reviewed future caller must inject IO.
const helper = require("../tests/progress-live-fixture-helpers");

function optionsFromArgs(args) {
  const options = { dedicatedTestAccount: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dedicated-test-account") options.dedicatedTestAccount = true;
    else if (["--journal", "--article-id"].includes(args[i])) {
      const name = args[i], value = args[++i];
      if (!value || value.startsWith("--")) throw new Error("invalid-fixture-options");
      options[name === "--journal" ? "journalPath" : "articleId"] = value;
    } else throw new Error("invalid-fixture-options");
  }
  return options;
}

// System temp / private directory only. Atomic snapshots, never a credential
// dump. An interrupted request stays marked attempted, forbidding a blind retry.
async function createJournalStore(file) {
  const fs = require("node:fs/promises");
  const path = require("node:path");
  const os = require("node:os");
  const { constants } = require("node:fs");
  if (typeof file !== "string" || !path.isAbsolute(file) || path.basename(file) !== "preparation.json") throw new Error("invalid-journal-path");
  const parent = await fs.realpath(path.dirname(file));
  const roots = await Promise.all([os.tmpdir(), "/tmp"].map(p => fs.realpath(p)));
  const stat = await fs.stat(parent);
  if (!/^lingoflow-progress-fixture-[a-zA-Z0-9_-]+$/.test(path.basename(parent)) ||
      !roots.some(root => parent.startsWith(root + path.sep)) || !stat.isDirectory() ||
      (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) throw new Error("invalid-journal-directory");
  const target = path.join(parent, "preparation.json");
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW;
  const lockPath = path.join(parent, ".preparation.lock");
  let lock = null;
  const requireLock = () => { if (!lock) throw new Error("fixture-journal-lock-required"); };
  return {
    acquireJournalLock: async () => {
      if (lock) throw new Error("fixture-journal-busy");
      let opened;
      try {
        opened = await fs.open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await opened.sync(); lock = opened;
      } catch {
        await opened?.close(); // Keep a crash/IO-failed lock for operator verification.
        throw new Error("fixture-journal-busy");
      }
    },
    releaseJournalLock: async () => {
      if (!lock) return;
      const held = lock; lock = null;
      try {
        const own = await held.stat(), current = await fs.lstat(lockPath);
        if (own.ino === current.ino && own.dev === current.dev) await fs.unlink(lockPath);
      } finally { await held.close(); }
    },
    readJournal: async () => {
      requireLock();
      let handle;
      try {
        handle = await fs.open(target, flags);
        const info = await handle.stat();
        if (!info.isFile() || info.size > 65536 || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error("invalid-journal-file");
        return helper.validateJournal(JSON.parse(await handle.readFile("utf8")));
      } catch (error) { if (error.code === "ENOENT") return null; throw new Error("invalid-preparation-journal"); }
      finally { await handle?.close(); }
    },
    writeJournal: async value => {
      requireLock();
      const safe = helper.validateJournal(value);
      const temporary = path.join(parent, `.preparation-${require("node:crypto").randomUUID()}.tmp`);
      const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify(safe)); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, target);
      const directory = await fs.open(parent, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    }
  };
}

async function main(env = process.env, args = process.argv.slice(2), injection = null,
    write = text => process.stdout.write(text)) {
  let options;
  try { options = optionsFromArgs(args); }
  catch { write('{"status":"NO-GO","reason":"invalid-fixture-options"}\n'); return 2; }
  // No automatic filesystem or network adapter; all caller IO remains absent
  // unless deliberately injected. The normal CLI always stops before writes.
  const result = await helper.runPreparation(env, options, injection);
  write(JSON.stringify(result, null, 2) + "\n");
  return result.status === "ready" ? 0 : 2;
}

if (require.main === module) main().then(code => { process.exitCode = code; }, () => {
  process.stderr.write("NO-GO: fixture preparation failed.\n"); process.exitCode = 2;
});
module.exports = { main, optionsFromArgs, createJournalStore };
