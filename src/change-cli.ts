/**
 * M4 — Change Map CLI：
 *   codeblast change <repo> <ref-a> <ref-b> [--out report.md]
 *   codeblast change --dbs <a.db> <b.db>    （已有两份图谱直接 diff）
 *
 * 流程：worktree checkout 两个 ref → 各建图 → graphDiff → 模块折叠 →
 *       对每个变更节点跑 impact（新图上）→ Markdown 报告。
 * 呈现纪律（intent.md）：结构无变化 → 输出一行"无结构变化"，不生成长报告。
 */
import fs from "node:fs";
import { openDatabase, type Database } from "./db";
import { selfCommand, spawnSync } from "./proc";
import { graphDiff, foldToModules, type GraphDiff } from "./graph-diff";
import { impact } from "./impact";

const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const outPath = outFlag >= 0 ? args[outFlag + 1] : undefined;
const jsonMode = args.includes("--json");

async function buildGraphAt(repo: string, ref: string, db: string): Promise<void> {
  const wt = `/tmp/codeblast-wt-${ref.replace(/[^\w]/g, "_")}`;
  const sh = (cmd: string[]) => {
    const p = spawnSync(cmd, { cwd: repo });
    if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr.slice(0, 300)}`);
  };
  spawnSync(["git", "worktree", "remove", "--force", wt], { cwd: repo });
  sh(["git", "worktree", "add", "--detach", wt, ref]);
  try {
    const p = spawnSync(selfCommand("index", wt, "--db", db));
    if (p.exitCode !== 0) throw new Error(p.stderr.slice(0, 500));
  } finally {
    spawnSync(["git", "worktree", "remove", "--force", wt], { cwd: repo });
  }
}

let dbA: Database, dbB: Database, header: string;
if (args[0] === "--dbs") {
  dbA = openDatabase(args[1], { readonly: true });
  dbB = openDatabase(args[2], { readonly: true });
  header = `${args[1]} → ${args[2]}`;
} else {
  const [repo, refA, refB] = args;
  if (!repo || !refA || !refB) {
    console.error("usage: codeblast change <repo> <ref-a> <ref-b> [--out report.md] | --dbs <a.db> <b.db>");
    process.exit(1);
  }
  const pa = `/tmp/codeblast-diff-a.db`, pb = `/tmp/codeblast-diff-b.db`;
  for (const f of [pa, pb]) for (const s of ["", "-wal", "-shm"]) fs.rmSync(f + s, { force: true });
  console.error(`building graph @ ${refA} ...`);
  await buildGraphAt(repo, refA, pa);
  console.error(`building graph @ ${refB} ...`);
  await buildGraphAt(repo, refB, pb);
  dbA = openDatabase(pa, { readonly: true });
  dbB = openDatabase(pb, { readonly: true });
  header = `${refA} → ${refB}`;
}

const diff = graphDiff(dbA, dbB);
const total = diff.nodesAdded.length + diff.nodesRemoved.length + diff.renamed.length + diff.edgesAdded.length + diff.edgesRemoved.length;

if (total === 0) {
  if (jsonMode) {
    console.log(JSON.stringify({ range: header, structural_changes: 0 }));
    process.exit(0);
  }
  console.log("无结构变化。");
  process.exit(0);
}

// 变更符号的影响半径（新图上查;removed 节点在旧图上查）
const impactDetails: { symbol: string; kind: string; impact_nodes: number; affected_tests: number; truncated: boolean }[] = [];
const impactSummary: string[] = [];
const topChanged = [...diff.nodesAdded, ...diff.renamed.map((r) => ({ id: `${r.file}#${r.to}`, kind: r.kind, name: r.to, file: r.file, line: 0 }))].slice(0, 10);
for (const n of topChanged) {
  try {
    const r = impact(dbB, n.id, 2000);
    const tests = r.items.filter((i) => i.level === "tests").length;
    impactSummary.push(`| ${n.name} | ${n.kind} | ${r.items.length}${r.truncated ? "+" : ""} | ${tests} |`);
    impactDetails.push({ symbol: n.name, kind: n.kind, impact_nodes: r.items.length, affected_tests: tests, truncated: r.truncated });
  } catch { /* 节点可能不在图（模块级 id）——跳过 */ }
}

const folded = foldToModules(diff);
if (jsonMode) {
  console.log(JSON.stringify({
    range: header,
    structural_changes: total,
    modules: Object.fromEntries(folded),
    nodes_added: diff.nodesAdded,
    nodes_removed: diff.nodesRemoved,
    renamed: diff.renamed,
    edges_added: diff.edgesAdded,
    edges_removed: diff.edgesRemoved,
    impact: impactDetails,
  }));
  process.exit(0);
}
const lines: string[] = [
  `# Change Map`,
  ``,
  `> ${header} · 结构变更 ${total} 项`,
  ``,
  `## 模块级变化`,
  ``,
  `| 模块 | +符号 | -符号 | 重命名 | +依赖 | -依赖 |`,
  `|---|---|---|---|---|---|`,
];
for (const [m, v] of [...folded.entries()].sort((a, b) => (b[1].added + b[1].removed) - (a[1].added + a[1].removed))) {
  lines.push(`| ${m} | ${v.added} | ${v.removed} | ${v.renamed} | ${v.edgesIn} | ${v.edgesOut} |`);
}

if (diff.renamed.length > 0) {
  lines.push(``, `## 重命名`, ``);
  for (const r of diff.renamed.slice(0, 20)) lines.push(`- \`${r.from}\` → \`${r.to}\` (${r.kind}, ${r.file})`);
}
if (diff.nodesAdded.length > 0) {
  lines.push(``, `## 新增符号（前 20）`, ``);
  for (const n of diff.nodesAdded.slice(0, 20)) lines.push(`- \`${n.name}\` (${n.kind}) ${n.file}:${n.line}`);
}
if (diff.nodesRemoved.length > 0) {
  lines.push(``, `## 删除符号（前 20）`, ``);
  for (const n of diff.nodesRemoved.slice(0, 20)) lines.push(`- \`${n.name}\` (${n.kind}) ${n.file}`);
}
if (diff.edgesAdded.length > 0) {
  lines.push(``, `## 新增依赖（前 15）`, ``);
  for (const e of diff.edgesAdded.slice(0, 15)) lines.push(`- ${e.kind}: \`${e.src}\` → \`${e.dst}\` (${e.file}:${e.line})`);
}
if (diff.edgesRemoved.length > 0) {
  lines.push(``, `## 删除依赖（前 15）`, ``);
  for (const e of diff.edgesRemoved.slice(0, 15)) lines.push(`- ${e.kind}: \`${e.src}\` → \`${e.dst}\``);
}
if (impactSummary.length > 0) {
  lines.push(``, `## 变更符号的影响半径`, ``, `| 符号 | 类型 | 影响节点 | 受影响测试 |`, `|---|---|---|---|`, ...impactSummary);
}

const doc = lines.join("\n") + "\n";
if (outPath) {
  fs.writeFileSync(outPath, doc);
  console.error(`written: ${outPath}`);
} else {
  console.log(doc);
}
