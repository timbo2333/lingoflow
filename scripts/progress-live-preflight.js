#!/usr/bin/env node
"use strict";

// Read-only Node runner, NOT the older mutation LIVE suite. No dotenv, artifacts,
// recordings, browser startup/navigation, or automatic first UPDATE.
const { runPreflight, verifyOwner, inspectServer } = require("../tests/progress-live-preflight-helpers");
const { openRuntimeSession, loopbackURL } = require("../tests/progress-live-runtime-inspector");

function optionsFromArgs(args) {
  const options = { dedicatedTestAccount: false };
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (name === "--dedicated-test-account") options.dedicatedTestAccount = true;
    else if (["--cdp", "--runtime-url"].includes(name)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error("invalid-preflight-options");
      loopbackURL(value, name === "--runtime-url");
      options[name === "--cdp" ? "cdpURL" : "runtimeURL"] = value;
    } else throw new Error("invalid-preflight-options");
  }
  return options;
}

async function main(env = process.env, args = process.argv.slice(2), write = value => process.stdout.write(value)) {
  if (env.LF_PROGRESS_LIVE_TEST !== "1") {
    const report = await runPreflight(env, {}, {});
    write(JSON.stringify(report, null, 2) + "\n"); return 2;
  }
  let options;
  try { options = optionsFromArgs(args); }
  catch { write(JSON.stringify({ decision: "NO-GO", reason: "invalid-preflight-options" }) + "\n"); return 2; }
  const report = await runPreflight(env, options, { verifyOwner, inspectServer,
    openRuntime: scope => openRuntimeSession(scope, options) });
  write(JSON.stringify(report, null, 2) + "\n");
  return report.decision === "GO" ? 0 : 2;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }, () => {
    // Never print raw exceptions, CLI output, token, headers, session or body.
    process.stderr.write("NO-GO: read-only preflight failed.\n"); process.exitCode = 2;
  });
}
module.exports = { main, optionsFromArgs };
