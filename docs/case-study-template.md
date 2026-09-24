# External codeblast case study template

Use this template only with a public repository and the maintainer's permission.

## Repository and commit

- Repository:
- Base commit:
- Head commit:
- codeblast version:

## Reproduction

```bash
codeblast index <repo> --db /tmp/graph.db
codeblast check-change <repo> <base> <head> --json
```

## Evidence

Record these fields without pasting proprietary source:

- `graph_health.base` and `graph_health.head`;
- `graph_health.warnings`;
- `risk` and `decision`;
- affected test files or their count;
- blind-spot count;

For structured reviewer feedback, use [`../eval/reviewer-feedback-schema.json`](../eval/reviewer-feedback-schema.json).
It is deliberately limited to public links, redacted notes, outcome labels, and version fields; it is
not a telemetry envelope.

### Maintainer intake checklist

- [ ] Maintainer approved the public case study.
- [ ] Base and head commits are public and reproducible.
- [ ] The exact codeblast version is recorded.
- [ ] No private source, credentials, secrets, or user data are included.
- [ ] Graph health and blind spots are reported separately.
- [ ] Human review outcome is recorded, including disagreement if any.
- [ ] Claims are limited to this run and do not generalize beyond its evidence.
- public `file:line` links supporting the reviewer decision.

## Human outcome

- Was the recommendation correct?
- Which tests did the maintainer run?
- Did the report change the review decision?
- What blind spot or false positive should become a regression fixture?

## Privacy boundary

Do not include secrets, private source, proprietary diffs, credentials, full logs containing user data,
or any repository contents not already public. A case study is not a telemetry export and must not
claim more accuracy than the evidence supports.
