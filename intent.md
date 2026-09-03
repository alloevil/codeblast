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
2. ✅ 影响半径只报 call 通道（3e0e979 复验: 虚假 18/13 → 如实 0/0）
3. ✅ 函数体内改动检测: diff hunk 行号→函数节点（2c5b6a8 复验: 原静默 → 报出 apply @ createProxy.ts:35）

**M4 复评（2026-08-28,另一批 50 提交/12 评论,独立盲测 agent）: 9/12 = 75% ≥ 70% ✅ 达标**

**M4 终验（2026-08-28,第三窗口 skip=100/7 评论,独立盲测 agent）: 4/7 = 57% ❌ 回落**
三轮轨迹: 25% → 75% → 57%。结构分析:
- 核心价值稳固: 4 条 API 提交评论全部 useful、零 misleading、影响数逐条核实可信、静默抽查 5/5 正确
- 失效模式高度集中: 3 条 noise 全部是【辅助区脚本(www 站点/sponsors 同步)的 0 影响改动】——
  diff 规模感知门槛(<40 行)拦不住 100 行左右的辅助区提交,同类 1407ef9 被拦而 4217a73 放行,阈值行为不一致
- 新发现的口径盲区: 导出函数【新增参数】(签名变更=API 面变化)仍被归为"结构未变"(3 例)
结论: 有效率在 57-75% 区间震荡,均值≈围绕门槛。每轮按评审 case 修门槛有过拟合风险
(三轮评审的判定口径本身也在漂移)。遗留两个已知修复方向(签名变更检测、辅助区信号降权),
两项已修复(2026-08-28,用户拍板):
1. ✅ 参数级签名变更检测: nodes 表加 signature 列(参数列表文本),graph-diff 输出
   signatureChanged,评论新增"签名变更(公共 API 面)"段。复验: d92cc45 的
   buildConnectionMessage 加参 encoder: Encoder 从"结构未变"变为具名报出,差异点定位展示。
2. ✅ 辅助区降权: www/docs/examples 目录的 0 影响改动零信息(scripts/ 含构建入口不降权,
   e39a654 回归验证)。复验: 终验 3 条 noise(4217a73/d53645f/1051d21)全部转为静默,
   useful 大提交(7b6e624)保留。
修复按终验 case 复验通过;是否再跑第四窗口评审,与"过拟合回放循环"的顾虑一并留待
真实部署数据决策。
（上轮 25%）。评审确认三修复全部生效: 重命名正确识别为 ↻、影响数字逐条核实可信、
函数体检测成最大价值源（在 chore 提交里揪出 set-cookie 行为变更）。
剩余已知瑕疵（未阻塞验收,记录在案）:
- 测试文件内字面量方法被当结构符号并标"无测试覆盖"（f489af0/6ccaf04/dad1281）
- 微 diff 零增量复述（e870051）;仅 headline 无符号名的空洞评论（e472df1）
- 本提交新增测试经动态派发覆盖新符号时仍标"无测试覆盖"（盲区口径同源问题）
- 静默判定不一致 borderline: 62c6ab0 的 export 可见性变更被静默而同类 e472df1 出评论

## 约束条款

- 增量索引是 M0 需求，不是后期优化；schema 设计受其反向约束。
- 分析器（L0-L1）必须可完全在客户环境本地运行；源码不强制出客户边界，只上传 L2 折叠摘要。
- 引擎层宁误报不漏报；呈现层宁静默不刷屏（两层取舍方向相反，勿混淆）。
- Impact 影响集超阈值时折叠为"广泛影响，建议全量测试"，不输出无用的巨型清单。
- 每个仓从第一天埋点存"预测影响 vs 实际回归"配对数据（独家校准资产）。
- M4 开工前专项复查图级 diff 是否已有可用库（半天，当前判断"无"置信度中等）。

## 明确不做（v1）

- 跨服务/跨仓库边（图模型预留节点类型，边不填）
- 自由画布/协作画布（不与 CodeViz 拼画布交互）。【2026-09-03 更正】轻量 overlay 编辑
  （模块改名/合并/隐藏 → overlay JSON 落盘）已随 PR #12 上线,未按流程先改本条,记为流程违规。
- Java（TS 之后再议）
- Python 函数级 Impact（方案 B，2026-08-27 拍板）：Python 只建高置信边
  （import/类与函数定义/直接调用），支撑 Architecture Map 与文件级 Change Map；
  Impact 对 Python 明确标注"仅文件级"。函数级零漏报承诺仍为 TS 独有——
  鸭子类型/动态派发使 Python 上该承诺原理性不成立（sgp 实例：
  hasattr(solver,"solve") 派发,静态不可达）。
  【2026-08-31 升级】方案 B+: 增加具名导入调用解析与轻量类型推断
  （构造赋值/AnnAssign/参数注解 → 方法调用解析）,sgp 实测函数级调用边 109→446,
  抽查 5/5 属实,Impact 可达方法级。零漏报承诺仍为 TS 独有不变。
- 通用代码检索 MCP（不与 Augment 拼 context engine）
- 代码健康评分（CodeScene 地盘）
- 自研索引器（scip-typescript 不顺手则 wrap 或提 PR，fork 是最后手段，重写禁止）

## 2026-09-03 拍板：精确率与验收加固（A+B 全做）

目标（召回门 100% 不变,任一项使 30 变异召回 <100% 即回滚）:
- A1 精确率: 接口方法扇出按接收者窄类型收窄;barrel 仅纯 re-export 时按名剪枝（有副作用/顶层语句则保守）。
  验收: tRPC 30 变异,召回 30/30,call 通道精确率 0.744 → 目标 ≥0.80;全量 0.36 → ≥0.5。
  【2026-09-03 结果: 数据否决,引擎不改】离线复刻 BFS 在 15 变异集上实验:
  (1) 纯 re-export barrel（241 文件/907 imports 边,文件内零声明）按名剪枝 → router.ts#lazy 预测 139 < 真实失败 154,
      必然漏报 ≥15;原因同 PR #8: lazy 变异击穿 initTRPC 初始化链,名字绑定不描述执行依赖。
  (2) 接口扇出 conservative 边全库仅 3 条,收窄收益≈0。
  (3) call 通道低精确率三例（WsClient.close 0.027 等）的 FP 全经 testServerAndClientResource 等测试助手 hub 扇出（1 节点→196 测试）,
      是真实可达依赖;差距属"影响集 vs 变异杀伤集"固有,非图谱错误。结论: 精确率 0.744 为当前方法上界附近,不再以精确率为优化目标。
- A2 独立盲评重跑: 现模型任评审人,同一 50 提交窗口,数字如实记录（允许下降）。
  【2026-09-03 结果: 1/5 = 20% ❌ 四轮轨迹 25% → 75% → 57% → 20%】同窗口 skip=100（上次 7 评论 → 现 5 评论,
  scripts/辅助区修复使 2 条旧 noise 静默,静默抽查 4/5 正确,漏 4217a73 www/ 新增 import+函数）。
  （4217a73 静默为设计行为: www/ 属辅助区,上轮正因该类提交被评 noise 而降权,评审人未知此规则。）
  评级: useful 1（d92cc45 参数新增）、noise 1（41723ce packages/tests 助手 2 行标为"公共 API"）、
  misleading 3——全部同一根因,与上轮评审人口径不同（上轮不计类型面）:
  (a) 接口/类型字段增删不进 signature（bc215fe 4 个导出类型加 batchIndex、7b6e624 experimental_encoder）→ 报"↻0/无结构变更";
  (b) 参数类型拓宽不算签名变更（9d4b3b9 TRPCClientError.from opts 加 cause）;
  (c) `export const x: T = {…}` 对象常量不建节点（jsonEncoder 两处漏,已核 nodes 表）→ "client +0" 错误;
  (d) "公共 API 面"标题未按导出可达性限定;闭包局部函数（handle/originalOn）报为新依赖。
  30 余处 file:line 全部核实准确;调用链/受影响测试整数无锚点不可核。
  定性: 数字下降主因是评审口径迁移到"TS 库的接口字段即 API",暴露引擎既有口径盲区,非本轮回归。
  候选修复（待拍板）: 接口/类型别名成员文本进 signature;对象常量导出建 node;API 面标题按 exported 过滤。
- A3 archmap-html 客户端脚本拆出为独立文件,构建时内联;行为零变化,截图对拍。
  【2026-09-03 完成】src/archmap-html.ts 739→378 行,src/archmap-client.js 361 行;<script> 体除 DATA 行位置外字节相同;
  浏览器验证 tabby 16 节点→下钻 74,零 pageerror。5 个 showcase 已重生成。
- A4 bun test 快测 ≥20 条,每条对准一个已知 bug 或契约（scripts/ 非辅助区、WAL、forFiles 字段、重命名匹配、分级、静默判定）。
  【2026-09-03 完成】55 pass / 0 fail / 1.1s,5 文件;静默判定纯函数抽到 src/pr-silence.ts（决策字节不变）。
- B: 变异 harness 支持 jest 并接入第二基准仓;PR bot 工作流预构建产物;盲区图例口径澄清。
  【2026-09-03 结果】第二基准 ardatan/graphql-tools（npm workspaces + babel-jest,353 文件/2006 节点/9419 边）,
  10 变异召回 9/10 = 90%,mean precision 0.354（/tmp/mutation-2026-09-03-graphql-tools-n10.json）。
  漏报 1 例 executor.ts#execute,漏 4 个测试文件: 它们 import 第三方 `graphql-yoga`（node_modules）,
  该包内部 require("@graphql-tools/executor"),jest moduleNameMapper 把它映射回 packages/executor/src。
  路径 test → node_modules → 自发布包名 → 工作区源码,不经任何仓内 import 语句,引擎无此边。
  定性: 引擎既有盲区（非本轮改动引入,tRPC 15/15 不受影响）,超出"仓内静态可分析 TS"承诺口径。
  候选修复（待拍板,本轮不做）: 对外部包读取其 package.json dependencies,与工作区包名相交 → conservative imports 边。
明确不做: 跨服务边、Java、npm publish（需用户凭据）。
## 2026-09-03 拍板：类型面检测 + 外部包回流边（用户：「1、2 都做」）

目标: 修 A2 盲评暴露的口径盲区（20% 的 3 条 misleading）与 jest 基准 1 例漏报,不改评级/静默阈值本身。
- C1 类型面进图:
  - `export const x: T = {…}` / 顶层非函数 const（对象、字面量、调用结果）→ kind=`const` 节点,signature=声明类型标注或初始化器首 200 字符。
  - interface / type alias / enum 的 signature = 成员文本（去空白规范化,首 200 字符）;成员增删改 → signatureChanged。
  - 函数签名文本改为参数**含类型**的规范化文本（已含,参数类型拓宽已能检出——9d4b3b9 漏报根因是 `TRPCClientError.from` 是 `public static` 方法,exported 位取自方法自身修饰符=0）: 方法 exported 继承所属类。
  - "公共 API 面"标题仅对 exported=1 节点使用;非导出签名变更归入"函数体内改动"列。
- C2 外部包回流边: 对解析进 node_modules 的 import,读该包 package.json 的 dependencies/peerDependencies,与工作区包名相交 →
  importer → 工作区包入口 `imports` 边,confidence=conservative,line=import 行。仅一层,不递归。
验收: 15 变异 tRPC 召回 100%（红线）;graphql-tools 10 变异召回 10/10;bun test 全绿并新增对准每条的用例;
A2 同窗口 5 条评论重放,bc215fe/9d4b3b9/7b6e624 各出现对应类型面条目。
明确不做: 接口成员级 diff 展示（只报"成员变化"整体）;递归外部依赖链;修改静默阈值。
【2026-09-03 结果】
- bun test 61 pass / 0 fail（新增 6 条：接口/type 成员签名、导出 const 节点、方法 exported 继承类、外部包回流边、闭包局部变量不悬边、接口 signatureChanged）。
- tRPC 15 变异召回 13/13 = 100%（2 个未被测试杀死不计;/tmp/mutation-2026-09-03-trpc-n15.json）。方法 exported=1 从 0 → 164。
- graphql-tools 10 变异召回 10/10 = 100%（此前 90%）。修了两处：回流边（52 条 conservative imports,原漏报 executor#execute 的 4 个 yoga 测试现可达）;
  workspace 发现改读根 package.json `workspaces`（`packages/loaders/*` 三层深,盲扫漏掉 code-file-loader,边 9419 → 9644）。
- A2 同窗口重放（skip 100,50 commit）：5 评论 / 45 静默 / 0 失败,静默决策与 A2 逐条一致。
  bc215fe 出现 3 条接口"成员变化 … batchIndex"; 9d4b3b9 出现 `from` 公共 API 面 `cause?: Error` 拓宽;
  7b6e624 出现 `Encoder`(interface) / `jsonEncoder`(const) 新增符号,`handle`/`originalOn` 闭包局部依赖噪音 5 → 0;
  41723ce 标题从"公共 API 面"改为"测试助手签名变更"。
- 残余处理（用户：「残余的问题处理下」）：影响半径表加「位置」列（file:line 链接,与函数体内改动表同构）,7b6e624 两个 `jsonEncoder` 按 wsEncoder.ts:24 / wsClient/encoder.ts:5 区分;
  展示页按新引擎重生成 tabby/trpc/codeblast（sgp 为 Python,本轮不涉及）：仅新增 const 节点（17/323/5）,其余 kind 计数逐项一致,impact-demo 半径 direct 5 / indirect 302 / tests 228 与旧页一致。
  trpc-change-demo（7b6e624 vs 163ec4e）也重生成：+14 → +21 符号,变更文件 7 → 9（新增 wsClient/encoder.ts、server/trpc.ts 两个 const 文件）。

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
