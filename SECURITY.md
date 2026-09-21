# Security policy

## Reporting

Do not open a public issue for a suspected vulnerability. Use **Security → Report a vulnerability**
in the GitHub repository to create a private security advisory. GitHub private vulnerability
reporting is enabled. The non-maintainer reporting gate was completed on 2026-07-17 through a
closed, unpublished test advisory submitted by `ksundeep9211`; it contained no vulnerability or
customer data.

Include only synthetic reproduction data. Do not include customer data, provider keys, client keys,
prompts, responses, or surrogate maps. If private reporting is unavailable, do not send sensitive
details through an issue, discussion, chat, or unsolicited email; notify the maintainer publicly
only that the private reporting channel is unavailable.

## Supported versions

| Version           | Support                                                      |
| ----------------- | ------------------------------------------------------------ |
| Unreleased `main` | Best-effort security fixes; no production SLA                |
| `0.1.x-alpha`     | 90-day critical-fix window after the first announced release |

No version currently receives a production security-support commitment.

## Response targets

- Acknowledge a private report within three business days.
- Provide an initial severity assessment within seven business days.
- Coordinate disclosure after a fix is available; timing depends on severity and downstream risk.

## Handling rules

- Use synthetic values for reports and tests.
- Revoke any exposed credential before sharing evidence.
- Treat bypasses of `deny`, cross-tenant receipt access, SSRF, raw-content logging, signature
  forgery, and provider-key disclosure as high severity.
- Allow maintainers reasonable time to reproduce and remediate before disclosure.

## Safe deployment

Read `docs/THREAT_MODEL.md` and `docs/OPERATIONS.md`. Production use requires an independent
security assessment, enterprise identity, durable audited key management, rate limiting, provider
contract review, and an operating compliance program.

The gateway rate-limits each workload with a per-process token bucket when `policy.rateLimit` is
set, globally or per workload. It is an accountability control for the keys the gateway itself
issues: with several replicas the effective rate multiplies by the replica count, and
unauthenticated traffic is refused before the limiter runs but still costs a request. Deploy behind
an ingress or API-management rate limiter whenever workloads are untrusted or adjacent to untrusted
callers.
