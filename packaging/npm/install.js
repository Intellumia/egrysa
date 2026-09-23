// Fetch the standalone binary for this platform from the GitHub release and
// refuse to install unless it hashes to the value in manifest.json.
//
// Those hashes come from the release's signed SHA256SUMS manifest, generated
// by tools/package_release.ts after tools/verify-release.sh has passed, so an
// install through npm pins the same artefact the release evidence covers.
// Nothing is executed during install, the download goes to this package's own
// directory, and a mismatch removes the file and fails the install rather
// than continuing.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");

const manifest = require("./manifest.json");
const key = `${process.platform}-${process.arch}`;
const entry = manifest.binaries[key];

if (!entry) {
  console.error(
    `egrysa: no published binary for ${key}. Supported: ${
      Object.keys(manifest.binaries).join(", ")
    }.\n` +
      "Run from source instead: https://github.com/Intellumia/egrysa#evaluate-without-a-model",
  );
  process.exit(1);
}

const target = path.join(__dirname, "bin", "egrysa");
const archive = path.join(__dirname, entry.file);

async function download(url, redirects = 5) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`downloading ${url} failed with ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

(async () => {
  const bytes = await download(entry.url);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== entry.sha256) {
    throw new Error(
      `egrysa: ${entry.file} hashed ${digest}, expected ${entry.sha256}. Refusing to install.`,
    );
  }
  fs.writeFileSync(archive, bytes);
  try {
    // The tarball holds egrysa/egrysa plus the example configurations.
    execFileSync("tar", ["-xzf", archive, "-C", __dirname], { stdio: "inherit" });
    fs.renameSync(path.join(__dirname, "egrysa", "egrysa"), target);
    fs.chmodSync(target, 0o755);
    const configs = path.join(__dirname, "egrysa", "config");
    if (fs.existsSync(configs)) {
      fs.rmSync(path.join(__dirname, "config"), { recursive: true, force: true });
      fs.renameSync(configs, path.join(__dirname, "config"));
    }
  } finally {
    fs.rmSync(archive, { force: true });
    fs.rmSync(path.join(__dirname, "egrysa"), { recursive: true, force: true });
  }
  console.log(`egrysa ${manifest.version} installed for ${key}`);
})().catch((error) => {
  fs.rmSync(archive, { force: true });
  console.error(String(error && error.message ? error.message : error));
  process.exit(1);
});
