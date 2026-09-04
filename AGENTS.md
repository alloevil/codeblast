# AGENTS.md — codeblast 仓库的 agent 工作规范

> 供 AI coding agent（Claude Code / Cursor / Codex 等）在本仓库内工作时遵循。
> 使用 codeblast 分析其他仓库的方法见 [SKILL.md](SKILL.md)；产品共识见 [intent.md](intent.md)。

## 项目速览

确定性代码图谱引擎 + 三投影（Architecture / Change / Impact）。Bun + TypeScript，SQLite 存储，零框架。

```
src/schema.ts       L1 图谱 schema（nodes/edges/blind_spots；src_file 为增量失效键）
src/extract.ts      TS 提取器（tsc API；调用/继承/import 边；盲区记录）
src/py_extract.py   Python 提取器（stdlib AST；高置信边 only）
src/cli.ts          索引入口（monorepo tsconfig 发现、孤儿扫描、增量 hash）
src/impact.ts       Impact 反向 BFS（三级分级、双通道、co-change 提示）
src/graph-diff.ts   图级 diff（节点/边集合差 + 重命名匹配）
src/*-cli.ts        各查询 CLI；pr-comment.ts 为 PR bot 出口
src/cochange.ts     git 历史耦合挖掘
eval/               验收 harness（变异测试、PR 回放）——改核心逻辑后必跑
```

## 不可违背的设计红线

1. **L1 图谱零 LLM**：节点与边只来自静态分析。LLM 仅用于 L2 模块命名（name-modules.ts）。
2. **宁误报不漏报**（引擎层）：解析不确定 → 保守全连 + `confidence: "conservative"`；
   完全不可达 → 写 blind_spots，**禁止静默丢弃**。
3. **宁静默不刷屏**（呈现层，与引擎层方向相反勿混淆）：PR bot 对无结构变化必须零输出。
4. **每条结论带证据**：新增任何输出字段必须含 file:line 或等价可核对来源。
5. **承诺措辞带范围**："零漏报"永远限定"静态可分析范围内"；Python 永远"文件级"。

## 改动纪律

- **改 extract/impact/graph-diff 后必须跑验收**：
  ```bash
  # 基准环境不存在时（/tmp 被清）先重建: bash eval/setup_benchmarks.sh
  # 快速回归（tRPC 图已存在时 ~1min）
  bun run build && node dist/bin.js index /tmp/trpc --db /tmp/trpc-full.db   # 应大量 skip
  node dist/bin.js impact /tmp/trpc-full.db "createBuilder" --json | head -c 500
  # 完整验收（改了边提取逻辑时，~30min）
  python3 eval/mutation_check.py /tmp/trpc /tmp/trpc-full.db 10  # 召回率必须 100%
  ```
- **召回率 < 100% 的改动禁止合入**，无论带来多少性能/精度收益。
- schema 变更必须保持"按 src_file 增量失效"语义；新边类型需评估是否进
  graph-diff 的结构边集合（历史类边如 co_change 不进）。
- 新增 CLI 输出字段：同步更新 SKILL.md 契约描述与 README 示例。
- 提交信息格式：`M<里程碑>: <变更>` 或 `fix/docs/eval: <变更>`；验收数字写进提交信息。

## 常见陷阱（前人踩过）

- SQLite WAL：复制 .db 文件前必须 `PRAGMA wal_checkpoint(TRUNCATE)`（曾致幻影 diff）。
- 跨包符号是 Alias：`getSymbolAtLocation` 后必须 `getAliasedSymbol`（曾丢全部跨包 extends）。
- tsconfig include 之外的文件不进 program：cli.ts 的孤儿扫描兜底,别绕过它。
- 双运行时：源码用 `bun src/bin.ts <cmd>` 直跑；发布产物 `dist/bin.js` 由 `bun run build` 打包、node ≥22.13 运行（node:sqlite）。SQLite/子进程只经 `src/db.ts` / `src/proc.ts`，禁止直接 import bun:sqlite 或调 Bun.*。
- bun 在 /tmp 下运行脚本会解析错 node_modules——测试脚本放项目内跑。
- 验收基准仓在 /tmp/trpc（deps 已装）与 /tmp/tabby（脏仓）；重装 deps 后盲区数会变。
