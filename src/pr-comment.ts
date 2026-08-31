/**
 * M4 — PR bot 出口：CI 内运行，输出 PR 评论 Markdown。
 *
 * 用法（GitHub Actions 内）:
 *   bun run src/pr-comment.ts <repo> <base-sha> <head-sha> [--repo-url https://github.com/o/r]
 *
 * 呈现纪律（intent.md）：
 * - 结构无变化 → exit 0 且无输出（调用方跳过评论）——宁静默不刷屏。
 * - 有变化 → stdout 输出评论 Markdown：结构摘要 + 影响半径 + 无测试覆盖警告。
 */
import { Database } from "bun:sqlite";
import path from "node:path";
import { graphDiff, foldToModules } from "./graph-diff";
import { impact } from "./impact";

const args = process.argv.slice(2);
const [repo, baseSha, headSha] = args;
if (!repo || !baseSha || !headSha) {
  console.error("usage: pr-comment.ts <repo> <base-sha> <head-sha> [--repo-url <url>]");
  process.exit(1);
}
const urlFlag = args.indexOf("--repo-url");
const repoUrl = urlFlag >= 0 ? args[urlFlag + 1] : undefined;

async function buildGraphAt(ref: string, db: string): Promise<void> {
  // sha 级缓存：同一 commit 的图确定性相同，回放/连续 PR 更新时直接复用
  const shaProc = Bun.spawnSync(["git", "rev-parse", ref], { cwd: repo });
  const sha = shaProc.exitCode === 0 ? shaProc.stdout.toString().trim() : null;
  const cache = sha ? `/tmp/codeblast-cache-${sha}.db` : null;
  if (cache && (await Bun.file(cache).exists())) {
    Bun.spawnSync(["cp", cache, db]);
    return;
  }
  const wt = `/tmp/codeblast-pr-${ref.slice(0, 12)}`;
  Bun.spawnSync(["git", "worktree", "remove", "--force", wt], { cwd: repo });
  const add = Bun.spawnSync(["git", "worktree", "add", "--detach", wt, ref], { cwd: repo });
  if (add.exitCode !== 0) throw new Error(add.stderr.toString().slice(0, 300));
  try {
    const p = Bun.spawnSync(["bun", "run", path.join(import.meta.dir, "cli.ts"), wt, "--db", db]);
    if (p.exitCode !== 0) throw new Error(p.stderr.toString().slice(0, 500));
    // WAL checkpoint：否则 cp 只带走 .db 主文件，未合并事务全部丢失（幻影 diff 之源）
    const ck = new Database(db);
    ck.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    ck.close();
    if (cache) Bun.spawnSync(["cp", db, cache]);
  } finally {
    Bun.spawnSync(["git", "worktree", "remove", "--force", wt], { cwd: repo });
  }
}

const dbPathA = "/tmp/codeblast-pr-base.db";
const dbPathB = "/tmp/codeblast-pr-head.db";
for (const f of [dbPathA, dbPathB]) Bun.spawnSync(["rm", "-f", f, f + "-wal", f + "-shm"]);
await buildGraphAt(baseSha, dbPathA);
await buildGraphAt(headSha, dbPathB);

const dbA = new Database(dbPathA, { readonly: true });
const dbB = new Database(dbPathB, { readonly: true });
const diff = graphDiff(dbA, dbB);
const total = diff.nodesAdded.length + diff.nodesRemoved.length + diff.renamed.length + diff.edgesAdded.length + diff.edgesRemoved.length + diff.visibilityChanged.length + diff.signatureChanged.length;

// 函数体内改动检测（独立评审 2c5b6a8 案例：行为修复因符号粒度盲区被静默）
// git diff hunk 行号 → dbB 中所属函数节点；排除已计入结构变化的符号与测试文件
const TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$|__tests__\/|(^|\/)tests?\//;
interface BodyChange { id: string; name: string; kind: string; file: string; line: number }
const structuralIds = new Set([...diff.nodesAdded.map((n) => n.id), ...diff.renamed.map((r) => `${r.file}#${r.to}`)]);
const bodyChanged: BodyChange[] = [];
{
  const diffOut = Bun.spawnSync(
    ["git", "diff", "--unified=0", baseSha, headSha, "--", "*.ts", "*.tsx"],
    { cwd: repo, maxBuffer: 64 * 1024 * 1024 },
  ).stdout.toString();
  const findFn = dbB.prepare(
    "SELECT id, name, kind, file, line FROM nodes WHERE file = ? AND kind IN ('function','method') AND line <= ? AND end_line >= ? ORDER BY (end_line - line) ASC LIMIT 1",
  );
  let curFile = "";
  const seen = new Set<string>();
  for (const ln of diffOut.split("\n")) {
    const fm = ln.match(/^\+\+\+ b\/(.+)$/);
    if (fm) { curFile = fm[1]; continue; }
    const hm = ln.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!hm || !curFile || TEST_RE.test(curFile)) continue;
    const start = Number(hm[1]);
    const count = hm[2] === undefined ? 1 : Number(hm[2]);
    for (const probe of [start, start + Math.max(0, count - 1)]) {
      const fn = findFn.get(curFile, probe, probe) as BodyChange | null;
      if (fn && !structuralIds.has(fn.id) && !seen.has(fn.id)) {
        seen.add(fn.id);
        bodyChanged.push(fn);
      }
    }
  }
}

if (total === 0 && bodyChanged.length === 0) process.exit(0); // 静默：既无结构变化也无源码函数体改动

const link = (file: string, line: number): string =>
  repoUrl ? `[${file}:${line}](${repoUrl}/blob/${headSha}/${file}#L${line})` : `${file}:${line}`;

const lines: string[] = [
  `## 🧭 codeblast · 结构变更分析`,
  ``,
  `**${total} 项结构变更**（符号 +${diff.nodesAdded.length} −${diff.nodesRemoved.length} ↻${diff.renamed.length}，依赖边 +${diff.edgesAdded.length} −${diff.edgesRemoved.length}）`,
  ``,
];

// 模块摘要（仅有变化的模块）
const folded = foldToModules(diff);
if (folded.size > 1) {
  lines.push(`| 模块 | 符号变化 | 依赖变化 |`, `|---|---|---|`);
  for (const [m, v] of folded) {
    lines.push(`| ${m} | +${v.added} −${v.removed} ↻${v.renamed} | +${v.edgesIn} −${v.edgesOut} |`);
  }
  lines.push(``);
}

// 重命名具名列出（独立评审 e472df1: 只有 headline 的 ↻1 是空洞评论）
if (diff.renamed.length > 0) {
  lines.push(`### 重命名`, ``);
  for (const r of diff.renamed.slice(0, 10)) {
    lines.push(`- \`${r.from}\` → \`${r.to}\` (${r.kind})`);
  }
  if (diff.renamed.length > 10) lines.push(`- …及另外 ${diff.renamed.length - 10} 项`);
  lines.push(``);
}
// export 可见性变化 = 公共 API 面变化（静默一致性: 62c6ab0 案例）
if (diff.visibilityChanged.length > 0) {
  lines.push(`### 可见性变化（公共 API 面）`, ``);
  for (const v of diff.visibilityChanged.slice(0, 10)) {
    lines.push(`- \`${v.name}\` (${v.kind}) ${v.nowExported ? "转为导出" : "**不再导出**"} （${link(v.file, v.line)}）`);
  }
  lines.push(``);
}
// 导出函数签名变更 = API 面变化（终验盲区: 加参被记"结构未变"）
if (diff.signatureChanged.length > 0) {
  lines.push(`### 签名变更（公共 API 面）`, ``);
  for (const s of diff.signatureChanged.slice(0, 10)) {
    // 从首个差异点展示,避免公共前缀截断导致 from/to 显示相同
    let d = 0;
    while (d < s.from.length && d < s.to.length && s.from[d] === s.to[d]) d++;
    const ctx = Math.max(0, d - 15);
    const fromView = (ctx > 0 ? "…" : "") + s.from.slice(ctx, ctx + 70) + (s.from.length > ctx + 70 ? "…" : "");
    const toView = (ctx > 0 ? "…" : "") + s.to.slice(ctx, ctx + 70) + (s.to.length > ctx + 70 ? "…" : "");
    lines.push(`- \`${s.name}\`: \`(${fromView})\` → \`(${toView})\` （${link(s.file, s.line)}）`);
  }
  lines.push(``);
}

if (diff.edgesAdded.length > 0) {
  lines.push(`### 新增依赖`, ``);
  for (const e of diff.edgesAdded.slice(0, 10)) {
    const srcName = e.src.split("#").pop();
    const dstName = e.dst.split("#").pop();
    lines.push(`- \`${srcName}\` → \`${dstName}\` （${link(e.file, e.line)}）`);
  }
  if (diff.edgesAdded.length > 10) lines.push(`- …及另外 ${diff.edgesAdded.length - 10} 条`);
  lines.push(``);
}

// 影响半径 + 无测试覆盖警告
const uncovered: string[] = [];
const impactRows: string[] = [];
// 测试文件内的符号（describe 回调里的字面量方法等）不属结构变更重点,更不该标"无覆盖"
const prodNodesAdded = diff.nodesAdded.filter((n) => !TEST_RE.test(n.file));
for (const n of prodNodesAdded.slice(0, 15)) {
  try {
    const r = impact(dbB, n.id, 2000);
    // 只报 call 通道——文件级均值会给全新符号报出虚假的巨大半径（独立评审 3e0e979 案例）
    const callItems = r.items.filter((i) => i.channel === "call");
    const tests = callItems.filter((i) => i.level === "tests").length;
    impactRows.push(`| \`${n.name}\` | ${n.kind} | ${callItems.length} | ${tests} |`);
    // 目标所在文件有盲区时,"无覆盖"可能是动态派发接不上（新增测试经回调覆盖）——降级为存疑
    const blind = r.blind_spot_count > 0;
    if (tests === 0 && n.kind !== "interface") {
      uncovered.push(`- \`${n.name}\` （${link(n.file, n.line)}）${blind ? " — 所在文件含动态调用,覆盖可能未被静态识别" : ""}`);
    }
  } catch { /* 模块级 id 无节点 */ }
}
if (impactRows.length > 0) {
  lines.push(`### 新增符号的影响半径（仅调用链可达,不含 import 粗粒度）`, ``, `| 符号 | 类型 | 调用链影响 | 受影响测试 |`, `|---|---|---|---|`, ...impactRows, ``);
}
if (uncovered.length > 0) {
  lines.push(`### ⚠️ 无测试覆盖的新增符号`, ``, ...uncovered, ``);
}
// 最小信息量门槛：除 headline 外没有任何具名内容（无依赖/无影响行/无函数体改动）→ 静默。
// 独立评审 e870051/e472df1 案例：零增量复述与空洞 headline 比沉默更差。
// 函数体改动只有在"有调用链影响"时才算有信息量——0 影响 0 测试的孤立脚本改动 diff 一眼可见。
// 但在大 diff 里定位"唯一的行为变更"本身就是价值（e39a654: 15k 行提交里揪出 generateEntrypoints）。
// 终验修订: 辅助区（www/scripts/docs/examples）的 0 影响改动一律零信息（3 条终验 noise 全是此类）;
// 核心区 0 影响改动仅在大 diff（≥40 行,导航价值）时有信号。
const AUX_RE = /^(www|docs|examples)\//; // 终验 3 条 noise 全在 www/;scripts/ 含构建入口(e39a654)不降权
const diffLineCount = Bun.spawnSync(
  ["git", "diff", "--numstat", baseSha, headSha],
  { cwd: repo, maxBuffer: 16 * 1024 * 1024 },
).stdout.toString().split("\n").reduce((sum, l) => {
  const m = l.match(/^(\d+)\t(\d+)\t/);
  return sum + (m ? Number(m[1]) + Number(m[2]) : 0);
}, 0);
let bodySignal = 0;
for (const fn of bodyChanged) {
  let hasImpact = false;
  try {
    const r = impact(dbB, fn.id, 2000);
    hasImpact = r.items.some((i) => i.channel === "call");
  } catch { /* 节点缺失跳过 */ }
  if (hasImpact) bodySignal++;                                        // 有调用链影响 → 永远有信号
  else if (!AUX_RE.test(fn.file) && diffLineCount >= 40) bodySignal++; // 核心区大 diff 导航价值
}
// 具名结构变化同样按核心区计数——辅助区新组件/依赖边（4217a73: www 106 行）无评审价值
const coreNamed = diff.edgesAdded.filter((e) => !AUX_RE.test(e.file)).length
  + prodNodesAdded.filter((n) => !AUX_RE.test(n.file)).length
  + diff.renamed.filter((r) => !AUX_RE.test(r.file)).length
  + diff.visibilityChanged.filter((v) => !AUX_RE.test(v.file)).length
  + diff.signatureChanged.filter((s) => !AUX_RE.test(s.file)).length;
if (coreNamed + bodySignal === 0) process.exit(0);
// 函数体内改动：结构不变但行为可能变——按既有函数的调用链影响排序,评审重点
if (bodyChanged.length > 0) {
  const rows: string[] = [];
  for (const fn of bodyChanged.slice(0, 12)) {
    try {
      const r = impact(dbB, fn.id, 2000);
      const callItems = r.items.filter((i) => i.channel === "call");
      const tests = callItems.filter((i) => i.level === "tests").length;
      rows.push(`| \`${fn.name}\` | ${callItems.length} | ${tests} | ${link(fn.file, fn.line)} |`);
    } catch { /* 节点缺失跳过 */ }
  }
  if (rows.length > 0) {
    lines.push(`### 函数体内改动（结构未变,行为可能变）`, ``, `| 函数 | 调用链影响 | 受影响测试 | 位置 |`, `|---|---|---|---|`, ...rows, ``);
  }
  if (bodyChanged.length > 12) lines.push(`…及另外 ${bodyChanged.length - 12} 个函数`, ``);
}

// 标题行在有函数体改动时也成立
if (total === 0 && bodyChanged.length > 0) {
  lines[2] = `**无结构变更**,但有 ${bodyChanged.length} 个函数体内改动（见下）`;
}

lines.push(`<sub>由 [codeblast](https://github.com/alloevil/codeblast) 生成 · 每条结论基于静态分析,含证据链接 · 动态调用盲区不在本报告内 · 评论不准?[30 秒反馈](https://github.com/alloevil/codeblast/issues/new?template=bot-feedback.yml&title=${encodeURIComponent(`[feedback] ${baseSha.slice(0, 7)}..${headSha.slice(0, 7)}`)})</sub>`);
console.log(lines.join("\n"));
