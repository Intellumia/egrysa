# egrysa

A customer-owned AI egress boundary: it sits between your application and a model provider, detects
sensitive values, replaces them with surrogates before anything leaves your network, restores them
locally on the way back, and records a signed, content-free receipt for every request.

This package is a thin installer. It downloads the standalone binary published with the matching
GitHub release, verifies it against a SHA-256 hash taken from that release's signed checksum
manifest, and refuses to install on a mismatch. The binary is the same artefact the release evidence
covers; nothing in the data plane comes from npm.

```sh
npm install -g egrysa
egrysa --version
EGRYSA_CONFIG=./egrysa.json egrysa
```

An example configuration is installed beside the binary, inside this package's `config` directory.
The gateway needs that file and its own keys; both are described in the project documentation.

- Source, documentation and releases: https://github.com/Intellumia/egrysa
- Verify a release yourself: `tools/verify-release.sh <tag>` in the source tree
- Licence: Apache-2.0

This is an evaluation-only alpha. It is not certified, does not make an organisation compliant, and
does not anonymise data in any regulatory sense. Read the threat model and the detection coverage
document before relying on it.
