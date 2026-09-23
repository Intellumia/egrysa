// The version this build reports. It equals the tag it is released under,
// without the leading "v", and equals info.version in api/openapi.yaml; a
// compatibility test holds the two together, and the release checklist bumps
// them before tagging. A compiled binary has no repository to read, so the
// number has to live in the source it is compiled from.
export const EGRYSA_VERSION = "0.1.0-alpha.7";
