# Release-image SBOM advisory triage

Review date: 2026-07-15

## Scope and evidence

This historical review covers the image built by private release dry run
[`29397265834`](https://github.com/Intellumia/egrysa/actions/runs/29397265834) from commit
`97838f95bf1578a6ea56c1f4de38f10c3eca2c0b`. Later data-plane changes mean its package findings are
context rather than evidence for the current release. Every announced tag must rebuild, rescan, and
publish its own retained CycloneDX document.

- CycloneDX document: 11 components, 14 unique advisories, and 17 affected-package occurrences.
- Retained artifact digest:
  `sha256:6f20f944340a6a5aa8764a1fddbec57a4b7299e5ff94d156529859886581c089`.
- Extracted SBOM digest: `sha256:1cc84bb53b686f7e1c953322acc929dc2690c0b90bd2008467acbda282511a15`.
- Trivy's Debian-vendor-prioritized result: four medium, ten low, and no selected high or critical
  advisories.
- The scan reported no fixed Debian Bookworm version for these package findings. Alternative scoring
  sources assign higher ratings to some entries, so selected severity alone is not the disposition.

## Disposition

| Advisories                                                                                                                                                                                                                                           | Package and affected path                                                  | Egrysa exposure                                                                                                                                                                 | Alpha disposition                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| [CVE-2026-5435](https://security-tracker.debian.org/tracker/CVE-2026-5435), [CVE-2026-6238](https://security-tracker.debian.org/tracker/CVE-2026-6238)                                                                                               | `libc6`; deprecated DNS record-printing/debug functions                    | Egrysa does not invoke these functions. Debian states that they are not in the resolver execution path.                                                                         | Accept and monitor. Debian marks these as minor issues without a Bookworm DSA.                                                             |
| [CVE-2026-5450](https://security-tracker.debian.org/tracker/CVE-2026-5450)                                                                                                                                                                           | `libc6`; `scanf` `%mc` with an explicit width greater than 1024            | Egrysa code does not call the C `scanf` family or accept a format string.                                                                                                       | Accept and monitor. Debian marks this as a minor issue without a Bookworm DSA.                                                             |
| [CVE-2026-5928](https://security-tracker.debian.org/tracker/CVE-2026-5928)                                                                                                                                                                           | `libc6`; `ungetwc` with overlapping single- and multibyte encodings        | Egrysa handles request text through Deno and does not select such a C wide-character encoding. The reported spurious-match case does not occur with standard Unicode encodings. | Accept and monitor. Debian marks this as a minor issue without a Bookworm DSA.                                                             |
| [CVE-2026-42767](https://security-tracker.debian.org/tracker/CVE-2026-42767)                                                                                                                                                                         | `libssl3`; OpenSSL CMP/CRMF client parsing                                 | Egrysa does not implement CMP or process CRMF messages.                                                                                                                         | Accept and monitor. Debian marks this as a minor issue without a Bookworm DSA.                                                             |
| [CVE-2025-27587](https://security-tracker.debian.org/tracker/CVE-2025-27587)                                                                                                                                                                         | `libssl3`; PowerPC timing side channel                                     | The reviewed artifact and current workflow build use GitHub's x64 runner; PowerPC is not configured.                                                                            | Not architecture-applicable. Debian marks the issue unimportant and records the upstream dispute.                                          |
| [CVE-2022-27943](https://security-tracker.debian.org/tracker/CVE-2022-27943)                                                                                                                                                                         | GCC runtime packages; `libiberty` Rust demangler demonstrated through `nm` | The distroless runtime does not run `nm` or demangle attacker-supplied symbols. The single advisory accounts for four package occurrences.                                      | Accept and monitor. Debian marks the issue unimportant with negligible security impact.                                                    |
| [CVE-2010-4756](https://security-tracker.debian.org/tracker/CVE-2010-4756)                                                                                                                                                                           | `libc6`; crafted POSIX glob expression resource exhaustion                 | Egrysa does not expose attacker-controlled filesystem globbing.                                                                                                                 | Accept and monitor. Debian marks the issue unimportant and requires applications that use globbing to impose limits.                       |
| [CVE-2018-20796](https://security-tracker.debian.org/tracker/CVE-2018-20796), [CVE-2019-9192](https://security-tracker.debian.org/tracker/CVE-2019-9192)                                                                                             | `libc6`; crafted patterns reaching glibc `regexec` recursion               | Egrysa's TypeScript patterns execute in the Deno/V8 regular-expression engine, not glibc `regexec`, and users cannot supply policy regexes through the request API.             | Accept and monitor. Debian marks both issues unimportant; upstream disputes treating these cases as vulnerabilities.                       |
| [CVE-2019-1010022](https://security-tracker.debian.org/tracker/CVE-2019-1010022), [CVE-2019-1010024](https://security-tracker.debian.org/tracker/CVE-2019-1010024), [CVE-2019-1010025](https://security-tracker.debian.org/tracker/CVE-2019-1010025) | `libc6`; stack-guard, ASLR, or address-disclosure mitigation behavior      | These are defense-in-depth findings that require another memory-corruption or local observation path. No direct remote Egrysa trigger was identified.                           | Accept as residual alpha risk and monitor. Debian marks them unimportant and records that upstream does not treat them as security issues. |
| [CVE-2019-1010023](https://security-tracker.debian.org/tracker/CVE-2019-1010023)                                                                                                                                                                     | `libc6`; running `ldd` on attacker-supplied ELF files                      | The distroless runtime does not contain an operator path that runs `ldd`, and Egrysa does not accept ELF files.                                                                 | Accept and monitor. Debian marks the issue unimportant and records that upstream does not treat it as a security issue.                    |

## Alpha decision and recheck policy

The findings are accepted as monitored residual risk for a narrow, non-production public alpha. This
is not a claim that the packages are unaffected, that the advisories are fixed, or that the image
has no known vulnerabilities. The image still contains the packages Trivy identified.

Before each announced alpha tag:

1. rebuild from the protected release commit and regenerate the SBOM;
2. rerun the full vendor-prioritized scan and retain its machine-readable result;
3. adopt a patched Distroless/Debian base digest when one becomes available and passes regression
   testing; and
4. stop the release for any selected high or critical finding, any newly demonstrated remotely
   reachable path, or any material change in vendor disposition.
