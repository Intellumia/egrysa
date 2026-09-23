#!/usr/bin/env node
// Hand control to the standalone binary the install step verified and placed
// beside this file. The wrapper adds nothing to the data plane: it execs the
// same binary the release publishes, with this process's arguments, streams,
// and exit code.
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");

const binary = path.join(__dirname, "egrysa");
if (!fs.existsSync(binary)) {
  // Many installs run with scripts disabled, which skips the postinstall step
  // that fetches and verifies the binary. Do it now rather than leaving a
  // package that only fails when someone tries to use it.
  const installer = path.join(__dirname, "..", "install.js");
  const install = spawnSync(process.execPath, [installer], { stdio: "inherit" });
  if (install.status !== 0 || !fs.existsSync(binary)) {
    console.error(
      "egrysa: the binary could not be installed. Fetch it yourself from\n" +
        "  https://github.com/Intellumia/egrysa/releases\n" +
        "or run from source: https://github.com/Intellumia/egrysa",
    );
    process.exit(1);
  }
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  console.error(String(result.error.message));
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
