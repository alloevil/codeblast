<p align="center">
  <img src="assets/readme/hero.svg" width="100%" alt="codeblast — deterministic code graph: know what breaks before you merge"/>
</p>

<p align="center">
  <b>English</b> | <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="#the-three-queries"><img src="https://img.shields.io/badge/TypeScript-function--level-3178c6?style=flat-square" alt="TypeScript function-level"/></a>
  <a href="#the-precision-promise-bounded-and-evidence-backed"><img src="https://img.shields.io/badge/recall-28%2F28_%3D_100%25-3fb950?style=flat-square" alt="mutation-tested recall 100%"/></a>
  <a href="SKILL.md"><img src="https://img.shields.io/badge/Agent-Skill-7c3aed?style=flat-square" alt="agent skill"/></a>
  <img src="https://img.shields.io/badge/license-MIT-8b949e?style=flat-square" alt="MIT"/>
</p>

**codeblast parses your repository into a deterministic code graph and answers the three most expensive questions around any code change:**
> 🔗 **[Live interactive demo](https://alloevil.github.io/codeblast/)** — real architecture maps of tRPC / Tabby / sgp, with three-level drill-down

| | Question | Command |
|---|---|---|
| 🎯 | **What breaks if I change this?** | `impact` — direct / transitive / affected-tests, in three tiers |
| 🔍 | **What did this PR structurally change?** | `change` — symbols and dependency edges added, removed, renamed |
| 🗺️ | **What does this project look like?** | `archmap` — collapsible module map + circular-dependency detection |

Built for humans (CLI / interactive HTML / PR comments) and for AI agents ([SKILL.md](SKILL.md)) — one graph, two front-ends.

## Why not yet another LLM diagram tool

```
LLM diagrams:  code → model reads it → hand-drawn graph → render     graph = the model's opinion, unverifiable
codeblast:     code → deterministic tsc/AST parse → graph → project  graph = checkable facts
```

**Every node, every edge, every claim carries `file:line` evidence** you can open and verify.
The LLM does exactly one job in the pipeline: giving modules human-readable names — node membership and edges always come from static analysis.

## The three queries

```bash
# Build the graph: auto-detects TS monorepos / Python, hash-based incremental updates
# (full build of tRPC, 950 files, in ~20s)
bun run src/cli.ts <repo> --db graph.db

# ① Impact — check the blast radius before you change anything
bun run src/impact-cli.ts graph.db "createOrder" --json
#    → direct list = callsites you must review; tests list = tests you must run
#    → two channels: call-graph reachable (precision ~0.70, read first)
#      + import reachable (conservative supplement, don't skip)

# ② Change Map — structural diff between two refs
bun run src/change-cli.ts <repo> main~5 main --json
#    → unexpected edges_added = a signal the change is out of scope

# ③ Architecture Map — interactive HTML: module → file → symbol drill-down,
#    symbols link to source lines
bun run src/archmap-html.ts graph.db --out arch.html --repo-url <github-url>

# Optional: mine git co-change coupling (protocol pairs, config + consumers —
# edges static analysis can't see)
bun run src/cochange.ts <repo> graph.db
```

### PR bot (runs in CI, stays quiet by default)

Copy [`.github/workflows-template/codeblast.yml`](.github/workflows-template/codeblast.yml) into your repo:
every PR gets an automatic comment with structural changes + blast radius + new symbols with no test coverage; **PRs with no structural change get zero comments**.
Replayed against 50 real commits: 42 correctly stayed silent, 87.5% of comments were useful.

## The precision promise (bounded, and evidence-backed)

- **TypeScript at function level: zero missed impact within statically analyzable scope.** Verified by mutation testing:
  inject mutations into a real repo → run the full test suite to get the ground-truth impact set → compare against predictions.
  Current benchmark (tRPC, 950 files): **28/28 mutations, 100% recall**, average precision 0.36 — favoring
  false positives over false negatives is a deliberate trade: in a controlled experiment, dropping the conservative edges
  raises precision to 0.70 but recall collapses to 14%. Data lives in [`eval/`](eval/).
- **Dynamic blind spots are explicitly flagged.** `eval` / dynamic imports / subprocesses / duck typing — anything
  static analysis can't catch is recorded in `blind_spots` with an "impact may be underestimated" warning, never silently dropped.
- **Python is file-level.** Dynamic typing makes function-level zero-miss guarantees impossible in principle, and we don't pretend otherwise.

## For AI agents

```
before editing:  impact "symbol" --json    → callsite list into context, so nothing gets missed
after editing:   change HEAD~1 HEAD --json → self-check for scope creep and accidental deletions
```

The full contract and interpretation discipline (including "never pretend the blind-spot list is complete") is in [SKILL.md](SKILL.md).
Agent conventions: [AGENTS.md](AGENTS.md).

## Status & roadmap

M0 graph engine → M1 Impact → M3 architecture map → M4 graph diff + PR bot → M5 precision extensions — **all milestones accepted** (each with a reproducible acceptance script). Single source of truth for design and acceptance criteria: [intent.md](intent.md).

MIT © 2026
