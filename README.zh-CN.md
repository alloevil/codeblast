**codeblast** 是一个确定性代码图谱 CLI，面向 TypeScript / Python 仓库，让开发者和 AI agent 在合并之前就知道改动会炸到哪里。

<p align="center">
  <img src="assets/readme/hero.svg" width="100%" alt="codeblast — deterministic code graph: know what breaks before you merge"/>
</p>

<p align="center">
  <a href="README.md">English</a> | <b>简体中文</b>
</p>

<p align="center">
  <a href="#三个查询"><img src="https://img.shields.io/badge/TypeScript-函数级-3178c6?style=flat-square" alt="TypeScript function-level"/></a>
  <a href="#精度承诺有边界有证据"><img src="https://img.shields.io/badge/recall-28%2F28_%3D_100%25-3fb950?style=flat-square" alt="mutation-tested recall 100%"/></a>
  <a href="SKILL.md"><img src="https://img.shields.io/badge/Agent-Skill-7c3aed?style=flat-square" alt="agent skill"/></a>
  <img src="https://img.shields.io/badge/license-MIT-8b949e?style=flat-square" alt="MIT"/>
</p>

## 是什么

**codeblast 把仓库解析成一份确定性代码图谱，回答改代码前后最贵的三个问题：**
> 🔗 **[在线交互演示](https://alloevil.github.io/codeblast/)** — tRPC / Tabby / sgp 的实时架构图,点开即可三层下钻

| | 问题 | 命令 |
|---|---|---|
| 🎯 | **改这个会炸哪里？** | `impact` — 直接/传递/受影响测试三级清单 |
| 🔍 | **这个 PR 在结构上改了什么？** | `change` — 符号与依赖边的增删/重命名 |
| 🗺️ | **这个项目长什么样？** | `archmap` — 模块折叠图 + 循环依赖检测 |

给人看（CLI / 交互 HTML / PR 评论），也给 AI agent 用（[SKILL.md](SKILL.md)）——同一份图谱，两个出口。

## 安装

```bash
npx codeblast demo            # 给当前仓库建图、跑一次 impact 查询、导出架构图
npm i -g codeblast            # 或全局安装；需要 Node ≥ 22.13（内置 sqlite）或 Bun

# 作为 agent skill 安装（Claude Code、Codex、Cursor 等）
npx skills add alloevil/codeblast
```

## 为什么不是又一个 LLM 画图工具

```
LLM 画图:    代码 → 模型阅读理解 → 手写图 → 渲染        图 = 模型的观点，无法核对
codeblast:   代码 → tsc/AST 确定性解析 → 图谱 → 投影    图 = 可验证的事实
```

**每个节点、每条边、每句结论都带 `file:line` 证据**，可直接打开核对。
LLM 在管线里只做一件事：给模块起人话名字——节点归属和边永远来自静态分析。

## 三个查询

```bash
# 建图：TS monorepo / Python 自动识别，hash 增量更新（tRPC 950 文件全量 ~20s）
codeblast index <repo> --db graph.db

# ① Impact —— 改动前查影响半径
codeblast impact graph.db "createOrder" --json
#    → direct 清单 = 必须检查的 callsite；tests 清单 = 必须跑的测试
#    → 双通道：调用链可达（精确率 ~0.70,优先看）+ import 可达（保守补充,勿跳过）

# ② Change Map —— 两个 ref 之间的结构 diff
codeblast change <repo> main~5 main --json
#    → 意料之外的 edges_added = 改动越界信号

# ③ Architecture Map —— 交互 HTML：模块→文件→符号三层下钻，符号跳源码行
codeblast archmap graph.db --out arch.html --repo-url <github-url>

# 可选：git 历史耦合挖掘（协议两端、配置与消费者——静态分析看不见的边）
codeblast cochange <repo> graph.db
```

### PR bot（CI 内跑，宁静默不刷屏）

复制 [`.github/workflows-template/codeblast.yml`](.github/workflows-template/codeblast.yml) 到目标仓库：
每个 PR 自动评论结构变化 + 影响半径 + 无测试覆盖的新增符号；**无结构变化的 PR 零评论**。
50 个真实提交回放：42 个正确静默。评论有效率是诚实的弱项——四轮独立盲评为 25% / 75% / 57% / 20%，
而作者 agent 自评同一批 8 条评论为 7/8 = 87.5%；两个数字与每轮之后的修复都记在 [intent.md](intent.md)。

## 精度承诺（有边界，有证据）

- **TypeScript 函数级，静态可分析范围内零漏报。** 验收方法：变异测试对照
  （真实仓库注入变异 → 全量测试得真实影响集 → 对比预测）。当前基准（tRPC，950 文件）：
  **28/28 变异召回率 100%**，平均精确率 0.36——宁误报不漏报是刻意交换：
  对照实验中砍掉保守边可将精确率提到 0.70，但召回率跌至 14%。数据在 [`eval/`](eval/)。
- **盲区显式标注。** 盲区 = 静态无法解析到仓内目标的调用/导入（含动态调用、未解析调用、外部依赖解析失败、子进程边界、测试框架全局），并非只有动态调用；
  一律记入 blind_spots 并提示"影响可能被低估"，绝不静默丢弃。
- **Python 为文件级。** 动态类型使函数级零漏报原理性不成立，不假装做到。

## 什么时候用它

- 你要改 monorepo 里某个导出符号，想在动手**之前**拿到 callsite 清单和必须跑的测试清单，而不是等 CI 红。
- 你是在改代码的 AI agent：改前 `impact --json` 把 callsite 送进上下文，改后 `change --json` 自查越界与误删。
- 你在评审 PR，想把结构变化（新增边、重命名符号、无测试覆盖的新符号）从格式噪音里分离出来。
- 你刚接手一个陌生的 TS / Python 仓库，想要一张每个框每条边都能点开核对源码行的地图。
- 你需要结论能被不信任本工具的人复核。

## 什么时候不要用它

- **你要 Python 的函数级保证。** Python 是文件级 + 类型化调用增强；鸭子类型使函数级零漏报原理性不成立，我们不假装做到。
- **你要一份短而准的影响清单。** 全量平均精确率 0.33–0.36（call 通道 ≈0.70–0.92）。引擎刻意过近似：`call` 通道优先读，全量清单当作"要跑的测试"。
- **你的依赖主要走静态分析看不见的路径** —— 动态 `require`、`eval`、子进程边界、未安装的 `node_modules`、测试框架全局。这些一律记入 `blind_spots` 不静默丢弃，但这样的仓库只会得到一张稀疏的图。
- **你要的是演示用图或协作画布。** `archmap` 输出的是用于导航的事实；要好看的图请把它的 JSON 喂给渲染工具。
- **你要跨服务 / 跨仓库边，或者 Java。** 图模型预留了节点类型但 v1 不填这些边，Java 明确未实现（见 [intent.md](intent.md)）。
- **你想让 PR bot 代替评审人。** 它是结构变化信号，独立盲评的有效率在 20%–75% 之间波动。

## 给 AI Agent 用

```
改前:  impact "symbol" --json   → callsite 清单进上下文，防漏改
改后:  change HEAD~1 HEAD --json → 自查结构越界与意外删除
```

完整契约与解读纪律（含"禁止假装盲区清单完整"）见 [SKILL.md](SKILL.md)。
Agent 规范另见 [AGENTS.md](AGENTS.md)。

## 常见问题

**零漏报承诺的边界到底是什么？** 在"仓内静态可分析的 TypeScript"范围内，预测的受影响测试文件集是真实失败测试集的超集。验收方式是两个独立仓库上的变异测试——trpc/trpc 28/28 被杀死变异、ardatan/graphql-tools 10/10——并由每周的 [`acceptance`](.github/workflows/acceptance.yml) 工作流把守：召回率低于 100% 即失败并自动开 issue。任何静态无法解析的东西都记入盲区，且项目规则禁止使用无限定的"零漏报"表述。

**精确率这么低是 bug 吗？** 不是，是被测量过的取舍。tRPC 30 变异集上平均精确率 0.358，graphql-tools 10 变异集上 0.331，即多数被预测的测试并不会失败。对照实验中只保留调用链边可把 call 通道精确率提到 0.702，但召回率跌到 14 个被杀死变异中的 2 个。后来一次"剪纯 re-export barrel + 收窄接口扇出"的精确率优化被自己的数据否决（必然产生漏报），因此精确率不再作为优化目标。

**支持 Python 吗？** 支持，文件级，并带类型化调用增强（具名导入调用、构造赋值/注解推断出的方法调用），足以支撑架构图与文件级 Change Map。函数级零漏报承诺仍为 TypeScript 独有。Python 实例见 [sgp 架构图](https://alloevil.github.io/codeblast/sgp-arch.html)，其中检出了 `sgp_utils ⇄ solver_transfer` 循环依赖。

**怎么让 AI agent 用它？** 用 `npx skills add alloevil/codeblast` 装成 skill，改前跑 `codeblast impact <db> "<symbol>" --json`，改后跑 `codeblast change <repo> HEAD~1 HEAD --json`。[SKILL.md](SKILL.md) 写明了关键解读纪律：`blind_spot_count > 0` 时禁止声称清单完整、禁止为了缩短清单砍掉 `file` 通道、禁止对 Python 声称函数级精度、`truncated: true` 要建议跑全量测试、`co_change_hints` 不等于影响。

**可核对的数字在哪里？** 带指标、方法、复现命令和证据路径的机器可读清单发布在 [claims.json](https://alloevil.github.io/codeblast/claims.json)；原始变异与 PR 回放数据在 [`eval/`](eval/)；包含每次降级与被否决优化的验收台账是 [intent.md](intent.md)。

## 状态与路线

M0 图谱引擎 → M1 Impact → M3 架构图 → M4 图 diff + PR bot → M5 精度扩展，**全部验收通过**（每项含可复现验收脚本）。方案与验收标准的单一事实源：[intent.md](intent.md)。

MIT © 2026

---

<p align="center">
  <a href="https://github.com/oil-oil/beautify-github-readme"><img src="./assets/readme/made-with-beautify.svg" width="300" alt="README made with beautify-github-readme"></a>
</p>
