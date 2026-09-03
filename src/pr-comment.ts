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
import type { GraphDiff } from "./graph-diff";
import { impact } from "./impact";
import { AUX_RE, TEST_RE, bodySignalCount, coreNamedCount, structuralTotal, type BodyChange } from "./pr-silence";

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
const total = structuralTotal(diff);

// 函数体内改动检测（独立评审 2c5b6a8 案例：行为修复因符号粒度盲区被静默）
// git diff hunk 行号 → dbB 中所属函数节点；排除已计入结构变化的符号与测试文件
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
// 导出符号签名变更 = API 面变化（终验盲区: 加参被记"结构未变";盲评: 接口字段/类型拓宽/对象常量）。
// "公共 API 面"标题只给非测试目录（41723ce: packages/tests 助手被标公共 API 是 noise）。
const sigView = (s: GraphDiff["signatureChanged"][number]): string => {
  // 从首个差异点展示,避免公共前缀截断导致 from/to 显示相同
  let d = 0;
  while (d < s.from.length && d < s.to.length && s.from[d] === s.to[d]) d++;
  const ctx = Math.max(0, d - 15);
  const clip = (t: string) => (ctx > 0 ? "…" : "") + t.slice(ctx, ctx + 70).replace(/`/g, "'") + (t.length > ctx + 70 ? "…" : "");
  // 可调用体显示为参数列表 (…);类型面（interface/const）显示成员/类型文本
  const wrap = s.kind === "interface" || s.kind === "const" ? (t: string) => t : (t: string) => `(${t})`;
  const what = s.kind === "interface" ? "成员变化" : s.kind === "const" ? "类型变化" : "";
  return `- \`${s.name}\`${what ? ` ${what}` : ""}: \`${wrap(clip(s.from))}\` → \`${wrap(clip(s.to))}\` （${link(s.file, s.line)}）`;
};
const apiSig = diff.signatureChanged.filter((s) => !TEST_RE.test(s.file));
const testSig = diff.signatureChanged.filter((s) => TEST_RE.test(s.file));
if (apiSig.length > 0) {
  lines.push(`### 签名变更（公共 API 面）`, ``, ...apiSig.slice(0, 10).map(sigView));
  if (apiSig.length > 10) lines.push(`- …及另外 ${apiSig.length - 10} 项`);
  lines.push(``);
}
if (testSig.length > 0) {
  lines.push(`### 测试助手签名变更`, ``, ...testSig.slice(0, 5).map(sigView), ``);
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
    impactRows.push(`| \`${n.name}\` | ${n.kind} | ${callItems.length} | ${tests} | ${link(n.file, n.line)} |`);
    // 目标所在文件有盲区时,"无覆盖"可能是动态派发接不上（新增测试经回调覆盖）——降级为存疑
    const blind = r.blind_spot_count > 0;
    if (tests === 0 && n.kind !== "interface" && n.kind !== "const") {
      uncovered.push(`- \`${n.name}\` （${link(n.file, n.line)}）${blind ? " — 所在文件含动态调用,覆盖可能未被静态识别" : ""}`);
    }
  } catch { /* 模块级 id 无节点 */ }
}
if (impactRows.length > 0) {
  lines.push(`### 新增符号的影响半径（仅调用链可达,不含 import 粗粒度）`, ``, `| 符号 | 类型 | 调用链影响 | 受影响测试 | 位置 |`, `|---|---|---|---|---|`, ...impactRows, ``);
}
if (uncovered.length > 0) {
  lines.push(`### ⚠️ 无测试覆盖的新增符号`, ``, ...uncovered, ``);
}
// 最小信息量门槛：除 headline 外没有任何具名内容（无依赖/无影响行/无函数体改动）→ 静默。
// 判定规则、阈值与案例见 pr-silence.ts。
const diffLineCount = Bun.spawnSync(
  ["git", "diff", "--numstat", baseSha, headSha],
  { cwd: repo, maxBuffer: 16 * 1024 * 1024 },
).stdout.toString().split("\n").reduce((sum, l) => {
  const m = l.match(/^(\d+)\t(\d+)\t/);
  return sum + (m ? Number(m[1]) + Number(m[2]) : 0);
}, 0);
const bodySignal = bodySignalCount(bodyChanged, diffLineCount, (fn) => {
  try {
    return impact(dbB, fn.id, 2000).items.some((i) => i.channel === "call");
  } catch { return false; /* 节点缺失跳过 */ }
});
const coreNamed = coreNamedCount(diff, prodNodesAdded);
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
