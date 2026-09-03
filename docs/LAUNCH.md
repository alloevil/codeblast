# 对外发声素材（草稿，未发布）

发不发、发哪里由你定。所有数字均可在 `eval/` 与 CI 记录中复现。

---

## Show HN 标题候选

1. `Show HN: codeblast – mutation-tested impact analysis for TypeScript monorepos`
2. `Show HN: codeblast – know what breaks before you merge (code graph with zero-miss recall)`
3. `Show HN: I built a code graph that refuses to guess – every edge carries file:line evidence`

推荐 1：`mutation-tested` 是最强的信任词，HN 读者对"又一个 AI 画图工具"免疫。

## Show HN 正文草稿

```
codeblast extracts a deterministic code graph (tsc API for TS, AST for Python) and
answers three questions before you merge:

- Impact: what breaks if I change this symbol — direct callers, transitive reach,
  affected tests, each with the file:line where the dependency actually occurs
- Change Map: what a PR structurally changed — symbols added/removed/renamed,
  dependency edges, signature and export-visibility changes
- Architecture Map: interactive module→file→symbol map with impact/diff overlays

The part I care about most is the acceptance method. The promise "no false negatives
within the statically analyzable range" is verified by mutation testing: inject a
fault into a function, run the full test suite, and compare the tests that actually
failed against what the tool predicted. Current benchmark (tRPC, 950 files):
recall 15/15 = 100%, call-channel precision 0.744.

That gate has already paid for itself twice. A barrel-file pruning optimization
made impact sets 80x smaller and looked perfect — mutation testing showed recall
had dropped from 100% to 53%, because `import { initTRPC }` means depending on that
symbol's entire execution closure, not just the name. Rolled back. Separately, a
crash in the orphan-file program silently dropped 115 files while still printing
normal statistics; the recall anomaly is what exposed it. Extraction now fails loud
with a non-zero exit.

Dynamic blind spots (eval, dynamic import, subprocess, duck typing) are recorded
explicitly and surfaced in reports — never silently dropped. Python is mixed-level:
named-import calls and type-inferable method calls resolve to functions, attribute
chains fall back to file level. The zero-miss claim is TypeScript-only.

There's a PR bot (GitHub Actions) that comments the structural change plus blast
radius, and stays silent when a PR has no structural impact. Its usefulness went
through three rounds of independent blind review: 25% → 75% after fixes.

Live demos: https://alloevil.github.io/codeblast/
Repo: https://github.com/alloevil/codeblast
Agent skill: npx skills add alloevil/codeblast
```

## r/typescript / r/programming 版本

同上，但开头换成具体场景：

```
I kept shipping regressions because "find all references" doesn't tell you which
tests to run. So I built a graph that does, and then spent most of the effort
proving it doesn't lie: ...
```

## 关键差异化话术（回帖时用）

- **有人说"这不就是 X 吗"**：X（Archify/CodeViz 等）的图是 LLM 读代码后画的，是模型的观点；codeblast 的图来自 tsc/AST，每条边可核对。用途互补：他们的图适合汇报，我们的适合决策。
- **有人质疑 100% 召回**：范围限定为"TypeScript 静态可分析部分"，方法是变异测试（附 arXiv:1812.06286），样本 15/30 变异，数据在 eval/。动态盲区显式标注，不假装覆盖。
- **有人问精确率低**：0.36 全量 / 0.744 调用链通道。这是刻意的交换——砍掉保守边可到 0.70 但召回率跌到 14%（有对照实验）。误报的代价是多跑几个测试，漏报的代价是回归进生产。
- **有人问跨服务**：v1 明确不做，图模型已预留节点类型。定义与实施顺序已写进 intent.md（HTTP 契约边优先，禁止 LLM 参与匹配）。

## 发布前检查清单

- [ ] `npm publish`（需要你的 npm 凭据；包名 codeblast 空闲，`npm pack` 已验证 21 文件/56kB）
- [ ] 确认 live demo 全部可打开（Pages 已 built）
- [ ] 首页 star 数为 0 时不必掩饰——HN 更在意方法论
- [ ] 发布时段：HN 美西周二至周四早 8-10 点转化最好

