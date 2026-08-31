---
name: codeblast
description: Deterministic code-graph analysis for TypeScript and Python repositories. Use when the user asks what breaks if I change this, wants an impact analysis or blast radius before editing a symbol, asks for a repository architecture map grounded in real code, or wants to know what structurally changed between two git refs or in a PR. Unlike LLM-drawn diagrams, every node and edge is extracted by compiler-grade static analysis and carries file:line evidence; impact answers are conservative (no false negatives within the static analysis boundary; dynamic blind spots are explicitly reported, never silently dropped).
---

# codeblast — 图谱 · 影响 · 结构变更

三个确定性查询，全部基于编译器级静态分析（TS：tsc API；Python：AST，文件级），
每条结论带 file:line 证据。**不是** LLM 画图工具：图的内容来自代码事实，不来自模型理解。

## 前置

- 运行时：bun ≥1.0，python3（分析 Python 仓库时）
- 目标仓库依赖已安装（node_modules 缺失会让外部调用沦为盲区）

## 1. 建图（其余命令的前提）

```bash
bun run <codeblast>/src/cli.ts <repo-root> --db /tmp/graph.db
```

- TS monorepo 自动发现 packages/apps/libs 各包 tsconfig；Python 自动 AST 摄取
- 增量：重跑只处理 hash 变化的文件
- 输出 JSON 统计：files_indexed / nodes / edges / blind_spots

## 2. Impact —— 改这个会影响什么（改代码前必查）

```bash
bun run <codeblast>/src/impact-cli.ts /tmp/graph.db "<符号名或文件路径>" --json
```
目标可传：符号名（重名时列出候选并退出,从候选复制完整 id 重查）、
完整 id（`路径#符号` 或 `路径#类.方法`）、或文件相对路径。
`--json` 输出可能很大（数百 item），建议重定向或管道给 jq。

返回 `items[]`：每项含 `level`（direct=直接调用方 / indirect=传递可达 / tests=受影响测试）、
`hops`、`confidence`（exact / conservative）、`via_file:via_line`（依赖发生的证据行）。
每项还有 `channel`：`call`=全程函数级调用链可达（高置信,实测精确率 ~0.70）；
`file`=途经 import/re-export 文件级边（保守补充）。
**禁止只取 call 通道当完整清单**——实测砍掉 file 通道召回率从 100% 跌到 14%
（测试常在匿名回调里调用被测函数,函数级链路断裂）。正确用法：
call 通道 = 优先人工检查的核心项；完整清单 = 该跑的测试全集。
`tests` 级按测试路径惯例判定（`*.test.*`/`*.spec.*`/`tests/` 目录/`test_*.py`），
测试目录下的 fixture 也会被保守计入——按去重后的文件数估算测试成本。
顶层 `co_change_hints[]`：与目标文件历史上频繁一起变更、但静态图上无边的文件
（如 HTTP 协议两端、配置与消费者）。属提示不属影响集——转述给用户时说
"历史上常一起改,建议顺带检查"，不说"会被影响"。
需先跑 `bun run <codeblast>/src/cochange.ts <repo> <graph.db>` 挖掘（可选步骤）。

**Agent 用法**：改一个导出符号前先查 impact，把 direct 列表作为必须检查的
callsite 清单，把 tests 列表作为改完必须跑的测试集。`truncated=true` 表示
影响过广，建议全量测试。`blind_spot_count>0` 表示该文件有动态调用，清单可能不全。

**语义边界**：TS 为函数级零漏报（静态可分析范围内）。Python 为混合级：
具名导入调用/类型可推断的方法调用（`b = Builder(); b.method()`、参数注解）为函数级,
无类型信息的属性链调用仍为文件级兜底+盲区标注——Python 无零漏报承诺。
conservative 边可能误报（接口全连所有实现），但静态可分析范围内不漏报。

## 3. Change Map —— 两个 ref 之间结构变了什么（review PR / 验收 agent 改动）

```bash
bun run <codeblast>/src/change-cli.ts <repo-root> <ref-a> <ref-b> --json
```

返回：`nodes_added/removed`、`renamed`（重命名匹配,不算增删）、
`edges_added/removed`（新增/删除的调用与 import 依赖）、`modules`（模块级聚合）、
`impact[]`（每个新增符号的影响半径）。`structural_changes: 0` = 纯实现细节改动，无结构变化。

**Agent 用法**：agent 完成一次多文件修改后，用 HEAD~1..HEAD 自查——
`edges_added` 里出现意料之外的依赖 = 改动越界的信号；
声称"只是重构"但 `nodes_removed` 非空 = 丢了东西。

## 4. Architecture Map —— 仓库结构总览

```bash
bun run <codeblast>/src/archmap.ts /tmp/graph.db            # Mermaid（贴 PR/文档）
bun run <codeblast>/src/archmap-html.ts /tmp/graph.db --out arch.html --repo-url <github-blob-url>  # 交互 HTML
```
叠加模式（同一张图上画 ②③ 的结果）：
```bash
# Impact 叠加: 影响半径着色（红=直接/金=测试/紫=传递,目标发光）
bun run <codeblast>/src/archmap-html.ts head.db --impact "<符号>" --out impact.html
# Change 叠加: 两图 diff 着色（绿=新增/金=修改/紫=删除,顶栏带变更摘要）
bun run <codeblast>/src/archmap-html.ts head.db --diff base.db --out change.html
```

模块折叠图 + 循环依赖检测（红色虚线）+ 每模块盲区计数。
HTML 版支持模块→文件→符号三层下钻，符号点击跳 GitHub 源码行。
可选 `--overlay codeblast.overlay.json`：模块人话名/隐藏/归并（进 git，用户改过的名字不被覆盖）。

## 解读纪律（必须遵守）

1. 引用结论时带证据：impact 项的 `via_file:via_line` 是依赖发生的真实位置，可直接打开核对。
2. 盲区（blind_spots）= 静态分析原理性接不住的动态调用（eval/getattr/子进程/动态 import）。
   报告影响时如实转述"影响可能被低估"，禁止假装清单完整。
3. Python 仓库禁止宣称函数级精度——它是文件级的。
4. 不要用本工具做"架构美图"——它输出事实,不输出演示品；要精美演示图用 archify 一类渲染工具，
   但可以把本工具的 JSON 输出作为其事实输入。
