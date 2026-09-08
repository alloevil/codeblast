---
name: codeblast
description: Deterministic code-graph analysis for TypeScript and Python repositories. Use when the user asks what breaks if I change this, wants an impact analysis or blast radius before editing a symbol, asks for a repository architecture map grounded in real code, or wants to know what structurally changed between two git refs or in a PR. Unlike LLM-drawn diagrams, every node and edge is extracted by compiler-grade static analysis and carries file:line evidence; impact answers are conservative (no false negatives within the static analysis boundary; dynamic blind spots are explicitly reported, never silently dropped).
---

# codeblast — impact · change · architecture, with evidence on every edge

Three deterministic queries over a graph built by `tsc` (TypeScript, function-level) and the
Python AST (file-level with typed-call upgrades). Every result carries the `file:line` where the
dependency actually occurs. The graph comes from the code, not from a model's reading of it.

## When to run it

| Situation | Command | What you get back |
|---|---|---|
| About to edit an exported symbol | `codeblast impact <db> "<symbol>" --json` | The callsites you must review and the tests you must run |
| Finished a multi-file change; verifying scope | `codeblast change <repo> HEAD~1 HEAD --json` | Symbols and dependency edges added / removed / renamed |
| Need to understand an unfamiliar repo | `codeblast archmap <db> --out arch.html` | Module → file → symbol map with cycle detection |
| Reviewing a PR | `codeblast pr-comment <repo> <base> <head>` | Markdown review comment; empty output when nothing structural changed |

Prerequisites: Node ≥ 22.13 or Bun ≥ 1.0 (`npx codeblast` works with no install); `python3` for Python
repos; the target repo's dependencies installed (missing `node_modules` turns external calls into blind spots).

## Interpretation rules — read before running

These are the mistakes an agent makes with this tool. Each one has produced a wrong answer in practice.

1. **Never present the impact list as complete when `blind_spot_count > 0`.** A blind spot is any call or
   import static analysis could not resolve to an in-repo target: dynamic calls, unresolved calls, failed
   external resolution, subprocess boundaries, test-framework globals. Say "impact may be underestimated".
2. **Never drop the `file` channel to make the list shorter.** Items with `channel: "call"` are the
   high-confidence core (measured precision ≈ 0.70). Items with `channel: "file"` reach the target only
   through import / re-export edges. Cutting them raised precision but collapsed recall from 100% to 14%
   in a controlled run — tests often call the target from inside anonymous callbacks the call graph
   cannot see. Use `call` items as what to read first; use the full list as what to test.
3. **Never claim function-level precision for Python.** Python is file-level with typed-call upgrades;
   there is no zero-miss promise. Say so when reporting on a Python repo.
4. **`truncated: true` means the impact is wide** (over `--max`, default 500). Recommend the full test
   suite; do not enumerate a partial list as if it were the whole.
5. **`co_change_hints` are not impact.** They are files that historically changed together with the
   target but have no static edge (protocol pairs, config + consumer). Report them as "historically
   co-changed, worth a look", never as "affected".
6. **Cite `via_file:via_line`** when you tell the user something depends on the target. That is the
   real location of the dependency and can be opened to check.
7. **This is not a diagram generator.** `archmap` outputs facts for navigation. For a presentation
   diagram, feed its JSON to a rendering tool; do not ask codeblast to make it pretty.

## 1. Build the graph (required first; incremental afterwards)

```bash
codeblast index <repo-root> --db /tmp/graph.db
```

Auto-discovers every package `tsconfig.json` in a monorepo and ingests Python via AST. Re-running only
processes files whose content hash changed. Stdout is one JSON object — this is a real run of
`codeblast index` against [tRPC](https://github.com/trpc/trpc) at commit `66d0544` with codeblast 0.3.0
(timing is machine-dependent; the counts are not):

```json
{ "db": "/tmp/graph.db", "seconds": 5.2, "tsconfigs": 34, "files_indexed": 957, "files_skipped": 0,
  "nodes": 6248, "edges": 17072, "blind_spots": 14725, "failures": 0 }
```

Note that `blind_spots` is routinely large on a real TypeScript monorepo — it counts unresolved and
dynamic references, not errors. Judge graph health by `failures`, not by `blind_spots`.

Non-zero exit with `failures > 0` means the graph is incomplete — do not query it; report the failure.

## 2. Impact — what breaks if I change this

```bash
codeblast impact /tmp/graph.db "<symbol-name | full-id | file-path>" --json [--max 500]
```

Target forms: a bare symbol name (if ambiguous, the command lists candidates and exits 1 — pick the
full id and re-run), a full id `path/to/file.ts#Symbol` or `path/to/file.ts#Class.method`, or a file
path relative to the repo root.

Output (`--json`):

```ts
{
  target: string;                 // resolved full id
  truncated: boolean;             // hit --max; impact is wide
  blind_spot_count: number;       // unresolved calls/imports in the target's file (rule 1)
  items: Array<{
    id: string; name: string; kind: string; file: string; line: number;
    level: "direct" | "indirect" | "tests";   // 1 hop | 2+ hops | a test that reaches the target
    hops: number;
    confidence: "exact" | "conservative";     // weakest edge on the path; conservative = interface fan-out etc.
    channel: "call" | "file";                 // rule 2
    named_miss?: boolean;                     // file channel only: an import on the path did not name the target
    via_file: string; via_line: number;       // where the dependency occurs (rule 6)
  }>;
  co_change_hints: Array<{ file: string; co_commits: number; evidence: string }>;  // rule 5
}
```

How to use it: `items.filter(level === "direct")` is the callsite checklist. `items.filter(level ===
"tests")` de-duplicated by `file` is the test set to run. Test-directory fixtures are included
conservatively; estimate test cost by distinct files, not item count.

`co_change_hints` is populated only after `codeblast cochange <repo> /tmp/graph.db` (optional).

## 3. Change — what structurally changed between two refs

```bash
codeblast change <repo-root> <ref-a> <ref-b> --json
codeblast change --dbs <a.db> <b.db> --json        # two graphs already built
```

Output when nothing structural changed: `{ "range": "...", "structural_changes": 0 }`. Otherwise:

```ts
{
  range: string; structural_changes: number;
  nodes_added: Node[]; nodes_removed: Node[];          // Node = { id, kind, name, file, line }
  renamed: Array<{ from, to, file, kind }>;             // matched rename, not counted as add + remove
  edges_added: Edge[]; edges_removed: Edge[];           // Edge = { src, dst, kind, file, line }
  modules: Record<string, { added, removed, renamed, edgesIn, edgesOut }>;
  impact: Array<{ symbol, kind, impact_nodes, affected_tests, truncated }>;   // per added/renamed symbol
}
```

Self-check after an edit: an unexpected entry in `edges_added` is a new dependency the task did not call
for; a non-empty `nodes_removed` under a "pure refactor" means something was dropped.

## 4. Architecture map

```bash
codeblast mermaid /tmp/graph.db                                   # Mermaid, for PR descriptions / docs
codeblast archmap /tmp/graph.db --out arch.html --repo-url <github-blob-url>   # interactive HTML
codeblast archmap head.db --impact "<symbol>" --out impact.html   # blast radius painted on the map
codeblast archmap head.db --diff base.db --out change.html        # structural diff painted on the map
```

Modules collapse by top-level directory; circular dependencies are drawn as red dashed edges; each
module shows its blind-spot count. The HTML drills module → file → symbol, and symbols link to source
lines when `--repo-url` is given. `--overlay codeblast.overlay.json` renames / merges / hides modules
(the file is meant to be committed; the map's ✎ mode generates it).

## 5. PR comment (CI)

```bash
codeblast pr-comment <repo> <base-sha> <head-sha> [--repo-url <url>]
```

Exit 0 with empty stdout when there is nothing structural to say — the workflow template in
`.github/workflows-template/codeblast.yml` posts a sticky comment only when stdout is non-empty.
Replayed over 50 real commits: 42 stayed silent, 87.5% of the comments posted were judged useful.

## Precision, stated

- TypeScript, function level: **zero missed impact within statically analyzable scope**, checked by
  mutation testing (inject a fault, run the real test suite, compare failing tests to the prediction).
  Two benchmarks: tRPC (vitest, 950 files) 28/28, graphql-tools (jest, 353 files) 10/10 — precision
  0.33–0.36 overall, ≈ 0.70–0.92 on the call channel. Both are hard gates in the weekly acceptance
  workflow, which opens an issue if either drops below 100%.
- Conservative edges over-approximate on purpose (an interface method call fans out to every implementer).
- Python: file-level; typed calls (`b = Builder(); b.method()`, annotated parameters) are function-level;
  untyped attribute chains fall back to file level and are recorded as blind spots.
