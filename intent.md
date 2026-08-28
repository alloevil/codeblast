# intent.md — codeblast：代码图谱三投影产品

> 共识基准文件。变更方案先改此文件。
> 状态：M0-M5 全部完成（2026-08-28）。本文件曾长期未随执行偏离更新（违反自身条款），
> 2026-08-28 审计后对齐现实；偏离记录见文末"执行偏离台账"。

## 一句话定位

确定性代码图谱引擎 + 可修正的架构折叠层 + 三个投影（Architecture Map / Change Map / Impact Map），
**人和 agent 是并列的一等消费者**：人走 PR bot + Web 三张图，agent 走 MCP 三个 tool，消费同一份图谱。
首发 TypeScript monorepo。

## 差异化承诺（唯一）

1. 每个框、每条边、每句结论可下钻到 file:line 代码证据。
2. Impact 在静态可分析范围内**零漏报**（保守过近似，宁误报不漏报）；动态盲区（any、动态 require、eval）显式标注，绝不静默丢弃。
3. 承诺措辞永远带范围限定，禁止无限定的 "zero-miss" 表述。

## 架构五层

```
L0 采集   tsc API + Python stdlib AST（原计划 scip-typescript,实做时 tsc API 已够,未引入 scip）
L1 图谱   SQLite 单文件：函数级节点+边，每条挂 file:line 证据；无 LLM 成分；
          schema 支持按文件增量失效；预留 service/API/queue 节点类型（v1 不填边）
L2 折叠   社区发现聚类 → LLM 命名 → C4 三层（系统/模块/函数）下钻；
          用户修正持久化为 overlay 文件（进 git）= 稳定坐标系 + 留存钩子
L3 投影   ① Architecture = 折叠结果
          ② Change    = 图级 diff（节点/边增删 + 重命名匹配），折叠到用户坐标系【自研点 1】
          ③ Impact    = 函数级可达遍历 + 三级分级（直接/间接/测试）+ 动态派发保守全连【自研点 2】
L4 出口   人:    PR bot（GitHub App 评论 ②+③ 摘要；无结构变化必须静默）+ Web 三张图（同一画布：下钻/着色/跳代码）
                    agent: SKILL.md 契约 + 各 CLI --json 出口（原计划 MCP,用户叫停后改为 skill 分发形态,
          借鉴 archify;三能力不变: impact / change --json / archmap）
```

设计裁决依据：
- L1 确定性、L2 才允许 LLM —— arXiv:2601.08773（AST 图谱 vs LLM 提取图谱实证）+ CodeRadius LLM 焊边不可验证的教训。
- Impact 给 agent 有效 —— arXiv:2603.17973 (TDAD)。
- 纯算法聚类不可信、必须可人工修正 —— SAR 领域结论（ASE'13 / ICSE'15）。
- 引擎不达精度不见客户 —— Arbor（getarbor.dev）主动停售的教训。

## 里程碑与验收状态（2026-08-28 对齐）

| # | 交付 | 原定验收 → 实际执行 | 状态 |
|---|---|---|---|
| M0 | 图谱引擎 + 增量更新 | 基准仓改为 tRPC + tabby + 自举（cal.com/novu 体积与安装成本过高）；50 条调用边=脚本窗口匹配 49/50 + 1 条人工复核（非逐条人工）；增量: 单文件 7.2s（含 program 重建） | ✅ 达成,口径如实修正 |
| M1 | Impact 引擎 | 变异测试（arXiv:1812.06286 法）：初跑 50%→10% 召回,修 5 个真 bug 后 10/10=100% | ✅ |
| M2 | agent 出口 | MCP 被叫停 → SKILL.md 形态；原控变量实验未做,以盲测 agent 走通全流程（verdict: usable,2 条证据行核对属实）替代 | ✅ 形态变更,验证方式降级 |
| M3 | 折叠层 + Architecture Map | 浏览器实测三层下钻/循环依赖/LLM 命名渲染；**"陌生工程师 10 分钟 5 问"与 SemArc 对齐度均未执行** | ⚠️ 功能完成,原定验收未跑 |
| M4 | Change Map + PR bot | 50 真实提交回放：42 正确静默、评论有效率 7/8=87.5%（评审人=本 agent,非独立第三方）；WAL 缓存 bug 被回放拦截 | ✅ 有效率判定主体需注明 |
| M5 | 精度扩展 | 30 变异: 28/28 召回 100%,精确率 0.358；channel 双通道对照实验（call-only 召回 14%）先于 SWARM-JS 完成并解决同一问题,SWARM-JS 降级为可选未执行；co-change 上线（tRPC 13 对,含 client↔server 协议耦合）；脏仓 tabby 修出 3 个真 bug | ✅ SWARM-JS 项未按原文执行 |

## 验收债补做结果（2026-08-28,独立盲测 agent 执行）

| 项 | 结果 | 结论 |
|---|---|---|
| M3 陌生工程师 5 问 | **4/5**（3 分钟,全部经源码复核）。失败题:"盲区密度"指标语义误导（盲区含外部 import 解析失败,非纯动态调用） | ✅ 通过;盲区口径需在图例澄清（已知债） |
| M3 SemArc 对齐度 | 未做（数据集为 Java 仓,与 TS 基准不匹配,放弃该项） | ➖ 作废,理由入册 |
| M4 独立评审 | **2/8 有效（25%),未达 70%**。事实准确 7/8,但:影响半径多处退化为文件级均值;492bacf 纯重命名被误报 +67/-60（misleading);2c5b6a8 函数体内行为修复被静默——"符号粒度≠评审重要性"系统性错配 | ❌ 未达标。自评 87.5% vs 独立评审 25% 的差距=评审人偏差的实证 |
| M2 控变量实验 | 4 符号改名 × 带/不带图谱 × 独立 worktree,sonic agent,禁 LSP。真漏改（人工分诊同名异符号/路径字符串后）: **ctrl=1, graph=0**（createFlatProxy 的 re-export 别名 ctrl 漏改,graph 组因图谱列出 shared.ts 证据行而命中） | ✅ 方向性有效但样本小;graph 组在 re-export 场景显示优势 |

M4 未达标的修复方向（已开工/待做）:
1. ✅ 跨文件重命名匹配（492bacf 复验: +67−60 → ↻59 + 真实 +8−1）
2. 影响半径禁用文件级均值回退——新符号无调用边时如实报 0 而非文件中心度（待做）
3. 函数体内改动的行为信号（体内 diff 行数/被改函数的 impact）纳入评论,弥补符号粒度盲区（待做,方案需评估）

## 约束条款

- 增量索引是 M0 需求，不是后期优化；schema 设计受其反向约束。
- 分析器（L0-L1）必须可完全在客户环境本地运行；源码不强制出客户边界，只上传 L2 折叠摘要。
- 引擎层宁误报不漏报；呈现层宁静默不刷屏（两层取舍方向相反，勿混淆）。
- Impact 影响集超阈值时折叠为"广泛影响，建议全量测试"，不输出无用的巨型清单。
- 每个仓从第一天埋点存"预测影响 vs 实际回归"配对数据（独家校准资产）。
- M4 开工前专项复查图级 diff 是否已有可用库（半天，当前判断"无"置信度中等）。

## 明确不做（v1）

- 跨服务/跨仓库边（图模型预留节点类型，边不填）
- 图编辑器 / 协作画布（不与 CodeViz 拼画布交互）
- Java（TS 之后再议）
- Python 函数级 Impact（方案 B，2026-08-27 拍板）：Python 只建高置信边
  （import/类与函数定义/直接调用），支撑 Architecture Map 与文件级 Change Map；
  Impact 对 Python 明确标注"仅文件级"。函数级零漏报承诺仍为 TS 独有——
  鸭子类型/动态派发使 Python 上该承诺原理性不成立（sgp 实例：
  hasattr(solver,"solve") 派发,静态不可达）。
- 通用代码检索 MCP（不与 Augment 拼 context engine）
- 代码健康评分（CodeScene 地盘）
- 自研索引器（scip-typescript 不顺手则 wrap 或提 PR，fork 是最后手段，重写禁止）

## 风险前三

1. 增量索引性能不达标 → PR 场景不可用（CodeRadius 2k 函数 5 分钟为反面教材）。M0 直接面对。
2. 在位者（Augment / CodeRabbit / Sourcegraph）补齐三投影 → M0-M2 走最短路径先立住 Impact。
3. 动态盲区被打脸 → 盲区显式标注 + 承诺措辞纪律（见约束条款）。

## 参考文献落点

- 协议/基建：SCIP（github.com/scip-code/scip）、Joern CPG（schema 参考）、dependency-cruiser（文件级边参考）
- Impact：Li et al. CIA 综述（STVR'12）、arXiv:1812.06286（变异测试验收法）、TDAD arXiv:2603.17973
- Change：GumTree（ASE'14，匹配思路）、Sem（Ataraxy Labs，实体级 diff 参照）
- Architecture：ASE'13/ICSE'15 SAR 对比、ArchAgent arXiv:2601.13007、SemArc 数据集（github.com/xjtu-enre/TSE2025SemArc）
- 竞品坐标：CodeRadius（同赛道 alpha）、Arbor（停售教训）、kratai（人机同图先例）、CodeSee（尸检：纯可视化必死）
## 执行偏离台账（audit 2026-08-28）

记录"做的与写的不一致"，防共识漂移复发：

1. L0 选型：scip-typescript → 纯 tsc API。理由：tsc 已提供符号+类型解析,scip 反成中间层。未回写即执行。
2. L4 agent 出口：MCP → SKILL.md（用户 2026-08-27 叫停 MCP;archify 调研后确定 skill 形态）。
3. 基准仓：cal.com/novu/twenty → tRPC/tabby/sgp。理由：克隆与依赖安装成本;tabby 充当"脏仓"。
4. M5 SWARM-JS：未执行,被 channel 对照实验替代（agent 单方面 scope 调整,本次审计追认）。
5. 新增未在原计划中的交付：Python 支持（方案 B,已拍板入册）、co-change 边、
   PR bot GitHub Actions 模板、README 视觉系统、AGENTS.md。
6. 仓库可见性 private → public,变更来源不明（非 agent 操作,待用户确认）。
