# Planned issues

Drafted contributor issues held in the repository workspace. Each body file below contains the issue
text only, so it can be filed unmodified with `--body-file`.

The canonical repository is [`Intellumia/egrysa`](https://github.com/Intellumia/egrysa). Entry-point
links inside the body files use absolute URLs against that path, because GitHub resolves relative
links in issue bodies against the site root rather than the repository.

## Labels

All labels these issues reference already exist on the repository:

| Label                 | Status                                  |
| --------------------- | --------------------------------------- |
| `Performance`         | created                                 |
| `Core Infrastructure` | created                                 |
| `Security Engine`     | created                                 |
| `Networking`          | created                                 |
| `Feature`             | created                                 |
| `Help Wanted`         | pre-existing as lowercase `help wanted` |
| `Enhancement`         | pre-existing as lowercase `enhancement` |
| `good first issue`    | pre-existing                            |

GitHub treats label names as case-insensitive for uniqueness, so `Help Wanted` and `Enhancement`
resolve to the existing lowercase labels rather than creating duplicates.

The IPv6 issue also carries `good first issue`. It is the most self-contained of the three: the
accepted formats are defined by RFC 4291, the change is local to the classifier pattern table, and
the test location is unambiguous. GitHub surfaces that label in its contributor discovery pages.

## Filing

Run from the repository root, so the `--body-file` paths resolve:

```sh
gh issue create --repo Intellumia/egrysa \
  --title "Optimize streaming latency during local surrogate replacement" \
  --body-file .github/planned-issues/01-streaming-latency-surrogate-replacement.md \
  --label "Performance" --label "Core Infrastructure" --label "Help Wanted"

gh issue create --repo Intellumia/egrysa \
  --title "Expand deterministic classification engine to support IPv6 address formats" \
  --body-file .github/planned-issues/02-ipv6-classification-support.md \
  --label "Security Engine" --label "Enhancement" --label "Help Wanted" \
  --label "good first issue"

gh issue create --repo Intellumia/egrysa \
  --title "Implement localized buffering layer for emulated streaming architectures" \
  --body-file .github/planned-issues/03-localized-buffering-emulated-streaming.md \
  --label "Networking" --label "Feature" --label "Help Wanted"
```

Entry-point links point at `blob/main`, so file these after this branch merges to `main` or the
links will not resolve.

## Related roadmap entries

Issues 2 and 3 close exclusions recorded in the README and tracked under
[mid-to-long-term functional milestones](../../ROADMAP.md#mid-to-long-term-functional-milestones).
