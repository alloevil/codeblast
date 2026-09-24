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
