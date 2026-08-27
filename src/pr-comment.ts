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
  const wt = `/tmp/codeblast-pr-${ref.slice(0, 12)}`;
  Bun.spawnSync(["git", "worktree", "remove", "--force", wt], { cwd: repo });
  const add = Bun.spawnSync(["git", "worktree", "add", "--detach", wt, ref], { cwd: repo });
  if (add.exitCode !== 0) throw new Error(add.stderr.toString().slice(0, 300));
  try {
    const p = Bun.spawnSync(["bun", "run", path.join(import.meta.dir, "cli.ts"), wt, "--db", db]);
    if (p.exitCode !== 0) throw new Error(p.stderr.toString().slice(0, 500));
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
const total = diff.nodesAdded.length + diff.nodesRemoved.length + diff.renamed.length + diff.edgesAdded.length + diff.edgesRemoved.length;

if (total === 0) process.exit(0); // 静默：无结构变化不评论

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

// 新增依赖 = review 重点
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
for (const n of diff.nodesAdded.slice(0, 15)) {
  try {
    const r = impact(dbB, n.id, 2000);
    const tests = r.items.filter((i) => i.level === "tests").length;
    impactRows.push(`| \`${n.name}\` | ${n.kind} | ${r.items.length}${r.truncated ? "+" : ""} | ${tests} |`);
    if (tests === 0 && n.kind !== "interface") uncovered.push(`- \`${n.name}\` （${link(n.file, n.line)}）`);
  } catch { /* 模块级 id 无节点 */ }
}
if (impactRows.length > 0) {
  lines.push(`### 新增符号的影响半径`, ``, `| 符号 | 类型 | 影响节点 | 受影响测试 |`, `|---|---|---|---|`, ...impactRows, ``);
}
if (uncovered.length > 0) {
  lines.push(`### ⚠️ 无测试覆盖的新增符号`, ``, ...uncovered, ``);
}

lines.push(`<sub>由 [codeblast](https://github.com/alloevil/codeblast) 生成 · 每条结论基于静态分析,含证据链接 · 动态调用盲区不在本报告内</sub>`);
console.log(lines.join("\n"));
