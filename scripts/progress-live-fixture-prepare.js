#!/usr/bin/env node
"use strict";

// Test/LIVE tooling only. Import and plain CLI never inject real IO. Execution
// requires both environment gates AND an explicit per-invocation authorization.
const helper = require("../tests/progress-live-fixture-helpers");

const USAGE = `Usage: node scripts/progress-live-fixture-prepare.js [options]
  --help                         Print usage; no environment checks or IO
  --dedicated-test-account       Confirm the dedicated test account
  --execute-live-fixture         Authorize at most one Article setup + one seed
  --validate-only                Read-only readiness checks; no fixture writes
  --cdp <loopback-url>           Existing dedicated Chrome, e.g. http://127.0.0.1:9222/
  --runtime-url <url>            Existing http://127.0.0.1:4173/ page
  --journal <absolute-path>      Explicit recovery journal; otherwise private temp
  --article-id <fixture-id>      Optional strict ID; normally generated and frozen
Secrets are accepted only from the same Terminal environment, never argv.
Plain CLI has no real adapter. Preparation always stops before client UPDATE.
`;

function optionsFromArgs(args) {
  const options = { dedicatedTestAccount: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    if (seen.has(args[i])) throw new Error("invalid-fixture-options");
    seen.add(args[i]);
    if (args[i] === "--help") options.help = true;
    else if (args[i] === "--dedicated-test-account") options.dedicatedTestAccount = true;
    else if (args[i] === "--execute-live-fixture") options.executeLiveFixture = true;
    else if (args[i] === "--validate-only") options.validateOnly = true;
    else if (["--journal", "--article-id", "--cdp", "--runtime-url"].includes(args[i])) {
      const name = args[i], value = args[++i];
      if (!value || value.startsWith("--")) throw new Error("invalid-fixture-options");
      options[{ "--journal": "journalPath", "--article-id": "articleId",
        "--cdp": "cdpURL", "--runtime-url": "runtimeURL" }[name]] = value;
    } else throw new Error("invalid-fixture-options");
  }
  if ((options.executeLiveFixture && options.validateOnly) || (options.help && args.length !== 1)) {
    throw new Error("invalid-fixture-options");
  }
  return options;
}

// System temp / private directory only. Atomic snapshots, never a credential
// dump. An interrupted request stays marked attempted, forbidding a blind retry.
async function createJournalStore(file, { recoveryIdentity = null } = {}) {
  const fs = require("node:fs/promises");
  const syncFS = require("node:fs");
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
  let lock = null, journalIdentity = null, firstRead = true;
  const requireLock = () => { if (!lock) throw new Error("fixture-journal-lock-required"); };
  const sameFile = (a, b) => a?.ino === b?.ino && a?.dev === b?.dev;
  const verifyLock = () => {
    requireLock();
    const held = syncFS.fstatSync(lock.fd), current = syncFS.lstatSync(lockPath);
    if (!current.isFile() || current.isSymbolicLink() || !sameFile(held, current) ||
        current.uid !== process.getuid() || (current.mode & 0o077) !== 0) throw new Error("fixture-journal-lock-lost");
  };
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
      verifyLock();
      let handle;
      try {
        handle = await fs.open(target, flags);
        const info = await handle.stat();
        if (!info.isFile() || info.size > 65536 || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error("invalid-journal-file");
        if (firstRead && recoveryIdentity && !sameFile(info, recoveryIdentity)) throw new Error("recovery-journal-replaced");
        if (journalIdentity && !sameFile(info, journalIdentity)) throw new Error("recovery-journal-replaced");
        const value = helper.validateJournal(JSON.parse(await handle.readFile("utf8")));
        firstRead = false; journalIdentity = info;
        return value;
      } catch (error) {
        if (error.code === "ENOENT") { if (recoveryIdentity) throw new Error("recovery-journal-missing"); return null; }
        if (error.message === "recovery-journal-replaced") throw error;
        throw new Error("invalid-preparation-journal");
      }
      finally { await handle?.close(); }
    },
    writeJournal: async value => {
      verifyLock();
      const safe = helper.validateJournal(value);
      const temporary = path.join(parent, `.preparation-${require("node:crypto").randomUUID()}.tmp`);
      const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify(safe)); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(temporary, target);
      const directory = await fs.open(parent, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
      journalIdentity = await fs.lstat(target); firstRead = false;
    },
    // Synchronous, readonly NODE authority check before private page dispatch.
    // Identity + durable bytes are checked under our lock; the PAGE owns the
    // separate final runtime guard -> native fetch boundary (not cross-process atomicity).
    verifySendAuthority: expected => {
      let fd;
      try {
        verifyLock();
        fd = syncFS.openSync(target, flags);
        const info = syncFS.fstatSync(fd), current = syncFS.lstatSync(target);
        if (!sameFile(info, journalIdentity) || !sameFile(info, current) || current.isSymbolicLink() ||
            !info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || info.size > 65536) return false;
        const value = helper.validateJournal(JSON.parse(syncFS.readFileSync(fd, "utf8")));
        return JSON.stringify(value) === JSON.stringify(helper.validateJournal(expected));
      } catch { return false; }
      finally { if (fd !== undefined) syncFS.closeSync(fd); }
    }
  };
}

async function main(env = process.env, args = process.argv.slice(2), injection = null,
    write = text => process.stdout.write(text), dependencies = {}) {
  let options;
  try { options = optionsFromArgs(args); }
  catch { write('{"status":"NO-GO","reason":"invalid-fixture-options"}\n'); return 2; }
  if (options.help) { write(USAGE); return 0; }
  // Even an injected caller cannot authorize main() through environment alone.
  if (!options.executeLiveFixture && !options.validateOnly) {
    const result = await helper.runPreparation(env, options, null);
    write(JSON.stringify(result, null, 2) + "\n"); return 2;
  }
  let adapter;
  try {
    if (injection !== null) throw new Error("invalid-fixture-options"); // no unaccounted main() IO bypass
    const module = require("../tests/progress-live-fixture-adapter");
    // Factory checks all args/gates before filesystem/CDP/Auth/SQL/network IO.
    adapter = await module.createExecutionAdapter(env, options, dependencies);
    if (options.validateOnly) {
      const result = await adapter.validateOnly();
      write(JSON.stringify(result, null, 2) + "\n"); return 0;
    }
    const result = await adapter.execute(event => write(JSON.stringify(event) + "\n"));
    write(JSON.stringify(adapter.report(result), null, 2) + "\n");
    return result.status === "ready" ? 0 : 2;
  } catch (error) {
    const module = require("../tests/progress-live-fixture-adapter");
    write(JSON.stringify(adapter ? adapter.report({ status: "NO-GO", reason: module.safeReason(error) })
      : { status: "NO-GO", reason: module.safeReason(error), mutationCounts: module.zeroCounts() }) + "\n");
    return 2;
  }
}

module.exports = { main, optionsFromArgs, createJournalStore, USAGE };
if (require.main === module) main().then(code => { process.exitCode = code; }, () => {
  process.stderr.write("NO-GO: fixture preparation failed.\n"); process.exitCode = 2;
});
