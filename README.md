# codeblast

**Know what breaks before you merge.**

确定性代码图谱 + 三个投影：Architecture Map / Change Map / Impact Map。
给人看，也给 AI agent 用——同一份图谱，两个出口。

## 与 LLM 画图工具的本质区别

```
LLM 画图（archify 等）:  代码 → LLM 阅读理解 → 手写图 JSON → 渲染   （图 = 模型的观点）
codeblast:              代码 → tsc/AST 确定性解析 → 图谱 → 投影    （图 = 可验证的事实）
```

每个节点、每条边、每句结论都带 `file:line` 证据，可直接打开核对。
LLM 在本工具中只做一件事：给模块起人话名字——**节点归属和边永远来自静态分析**。

## 三个查询

```bash
# 建图（TS monorepo / Python 自动识别，增量更新）
bun run src/cli.ts <repo> --db graph.db

# ① Impact：改这个符号会波及哪里（直接/传递/受影响测试 三级 + 证据行）
bun run src/impact-cli.ts graph.db "createOrder" --json

# ② Change Map：两个 git ref 之间结构变了什么（新增/删除/重命名符号，依赖边变化）
bun run src/change-cli.ts <repo> main~5 main --json

# ③ Architecture Map：模块折叠图 + 循环依赖检测 + 三层下钻交互 HTML
bun run src/archmap-html.ts graph.db --out arch.html
```

## 精度承诺（有边界，有证据）

- **TypeScript 函数级，静态可分析范围内零漏报**：验收方法为变异测试对照
  （对真实仓库注入变异 → 全量测试得真实影响集 → 对比预测），当前基准
  （tRPC，950 文件）：**28/28 变异召回率 100%（30 变异、2 未被测试杀死）**，精确率 0.36（保守过近似的代价，如实报出）。
- **动态盲区显式标注**：eval / 动态 import / 子进程 / 鸭子类型调用——静态分析
  接不住的，记入 blind_spots 并在结果中提示"影响可能被低估"，绝不静默丢弃。
- **Python 为文件级**（方案 B）：动态类型使函数级零漏报原理性不成立，不假装做到。

## 给 AI Agent 用

见 [SKILL.md](SKILL.md)。核心场景：
- agent 改导出符号前查 impact → direct 清单 = 必须检查的 callsite，tests 清单 = 必须跑的测试
- agent 改完自查 change map → 意料之外的 `edges_added` = 越界信号

## 状态

早期开发中。已验收：图谱引擎（M0）、Impact（M1，变异测试 100% 召回）、
架构图（M3，含 LLM 命名 + overlay 修正）、图级 diff（M4 核心）。
路线图见 [intent.md](intent.md)。
