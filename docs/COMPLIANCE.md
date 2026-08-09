# Control mapping

This is an engineering crosswalk, not a certification statement or legal opinion.

| Framework area                                                     | Relevant Egrysa evidence                                                                                             | Owner actions still required                                                              |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| NIST AI RMF 1.0 / NIST AI 600-1: Govern, Map, Measure, Manage      | threat model, policy decisions, provider inventory, eval corpus, receipts                                            | organizational risk tolerance, impact assessment, human oversight, incident governance    |
| NIST Privacy Framework: Identify-P, Govern-P, Control-P, Protect-P | minimization, local-only routing, no content persistence, access control                                             | data inventory, legal basis, notices, rights handling, retention schedule                 |
| NIST SP 800-53: AC, AU, CA, CM, IA, SC, SI families                | bearer authentication, content-minimized policy evidence, config review, TLS requirement, CI scanning                | enterprise IAM, key lifecycle, durable SIEM, control assessment, boundary authorization   |
| OWASP Top 10 for LLM Applications 2025                             | injection boundary, sensitive-information controls, supply-chain controls, excessive-agency prevention, input limits | application-specific red team, model behavior evaluation, downstream output handling      |
| SOC 2 Trust Services Criteria                                      | logical access, change controls, monitoring, confidentiality-oriented minimization                                   | operated control evidence, HR/vendor/incident/BCP controls, auditor assessment            |
| ISO/IEC 27001:2022                                                 | secure configuration, access restriction, logging minimization, supplier boundary, secure development                | ISMS scope, risk treatment, policies, people controls, internal audit, certification body |
| GDPR principles                                                    | minimization, purpose-bounded routing, no raw persistence by gateway                                                 | controller/processor roles, lawful basis, DPA, DPIA, data-subject rights, transfers       |
| HIPAA Security Rule, when applicable                               | deny selected identifiers, local routing, access boundary, content-minimized audit                                   | BAA, HIPAA-eligible provider features, full identifier coverage, risk analysis, policies  |
| PCI DSS, when applicable                                           | Luhn-valid payment cards denied                                                                                      | do not use this gateway to reduce cardholder-data scope without a QSA decision            |

## Measurement and human oversight evidence

Two framework areas above ask for measurement and for human oversight rather than for a control to
exist. Both now have concrete artefacts, and both are honest about their limits.

| Ask                                                                                          | Artefact                                                                                                                                                                               | Limit                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| NIST AI RMF **Measure**: characterise the system empirically                                 | [Detection coverage](DETECTION_COVERAGE.md), per-class precision and recall against an adversarial corpus, reproducible with `deno task eval:adversarial`                              | The corpus is maintainer-authored, so it is not the independent assessment the framework contemplates                                                                          |
| NIST AI RMF **Manage** and NIST Privacy **Govern-P**: human oversight of automated decisions | `policy.sensitivity: review` holds an ambiguous request and requires an explicit acknowledgement before it proceeds; the hold and the acknowledged retry each produce a signed receipt | The acknowledgement identifies the calling workload, not a named individual. Attributing a decision to a person requires the customer's identity layer in front of the gateway |
| SOC 2 / ISO 27001 change control over the enforcement policy                                 | Startup validation rejects an incomplete or conflicting taxonomy; the detector ruleset in force is recorded in each receipt as a detector version                                      | The policy file itself is not signed, and receipts record the ruleset rather than a policy version. Configuration change control remains the customer's                        |

## Current authoritative anchors

- NIST AI 600-1, _Artificial Intelligence Risk Management Framework: Generative Artificial
  Intelligence Profile_, July 2024: https://doi.org/10.6028/NIST.AI.600-1
- OWASP Top 10 for LLM Applications 2025:
  https://genai.owasp.org/resource/owasp-top-10-for-llm-applications-2025/
- SLSA specification 1.2: https://slsa.dev/spec/v1.2/
- OpenAI data controls: https://platform.openai.com/docs/models/default-usage-policies-by-endpoint
- Anthropic commercial data retention:
  https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data
- Deno security and permissions: https://docs.deno.com/runtime/fundamentals/security/

## Provider facts that must not be collapsed

Provider API content-use policy, abuse-monitoring retention, application-state retention, region,
BAA/DPA coverage, feature eligibility, and legal exceptions are distinct. A “not used for training”
statement does not mean zero retention. A `store:false` parameter does not create a ZDR agreement.
Revalidate all provider facts during procurement and before each new feature is enabled.
