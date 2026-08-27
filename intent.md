# intent.md — 代码图谱三投影产品

> 共识基准文件。变更方案先改此文件。
> 状态：方案已拍板（2026-08-27），待建仓开工 M0。

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
L0 采集   scip-typescript + tsc API（纯组装，零自研）
L1 图谱   SQLite 单文件：函数级节点+边，每条挂 file:line 证据；无 LLM 成分；
          schema 支持按文件增量失效；预留 service/API/queue 节点类型（v1 不填边）
L2 折叠   社区发现聚类 → LLM 命名 → C4 三层（系统/模块/函数）下钻；
          用户修正持久化为 overlay 文件（进 git）= 稳定坐标系 + 留存钩子
L3 投影   ① Architecture = 折叠结果
          ② Change    = 图级 diff（节点/边增删 + 重命名匹配），折叠到用户坐标系【自研点 1】
          ③ Impact    = 函数级可达遍历 + 三级分级（直接/间接/测试）+ 动态派发保守全连【自研点 2】
L4 出口   人:    PR bot（GitHub App 评论 ②+③ 摘要；无结构变化必须静默）+ Web 三张图（同一画布：下钻/着色/跳代码）
          agent: MCP 三个 tool — impact(symbol) / context(task) / graph_diff(ref_a, ref_b)
```

设计裁决依据：
- L1 确定性、L2 才允许 LLM —— arXiv:2601.08773（AST 图谱 vs LLM 提取图谱实证）+ CodeRadius LLM 焊边不可验证的教训。
- Impact 给 agent 有效 —— arXiv:2603.17973 (TDAD)。
- 纯算法聚类不可信、必须可人工修正 —— SAR 领域结论（ASE'13 / ICSE'15）。
- 引擎不达精度不见客户 —— Arbor（getarbor.dev）主动停售的教训。

## 里程碑与硬验收

| # | 交付 | 硬验收 |
|---|---|---|
| M0 | 图谱引擎 + 增量更新 | 3 个真实 TS monorepo（cal.com / novu / twenty 候选，含 1 个"脏"仓）建图；抽样 50 条调用边人工核对正确率 100%，含证据行号；单文件变更增量更新 < 数秒级 |
| M1 | Impact 引擎 | 变异测试对照（方法照 arXiv:1812.06286）：**召回率 100% 硬门槛**，精确率报实数。不达标不进 M2 |
| M2 | MCP 出口 | 控变量：同 agent 同 20 个 task，带/不带图谱，漏改 callsite 率与回归数对比出数字 |
| M3 | 折叠层 + Architecture Map | 未修正初稿给陌生工程师：10 分钟答对 5 个架构问题；SemArc 数据集方法对齐度报数 |
| M4 | Change Map + PR bot | 回放 50 个真实 merged PR：评论有效率 ≥ 70%；结构无变化的 PR 零评论 |
| M5 | 精度扩展 | SWARM-JS 基准实测 LLM/GNN 补动态边水平后，决定是否引入低置信边层级；co-change 边上线 |

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
- Java / Python（TS 之后再议）
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
