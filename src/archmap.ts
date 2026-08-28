/**
 * M3 最小版 — 架构图生成器。
 *
 * 折叠规则（v0：目录即模块）：
 * - 文件按顶级目录聚类为模块（sgp_client/ → 模块 sgp_client）
 * - 文件级 imports 边聚合为模块级带权边
 * - 测试目录单独归组;根目录散文件归 "(root)"
 * 输出 Mermaid flowchart（GitHub 原生渲染），节点带文件数,边带依赖强度。
 *
 * 用法: bun run src/archmap.ts <graph.db> [--out report.md]
 */
import { Database } from "bun:sqlite";

const [dbPath] = process.argv.slice(2);
if (!dbPath) {
  console.error("usage: bun run src/archmap.ts <graph.db> [--out file.md]");
  process.exit(1);
}
const outFlag = process.argv.indexOf("--out");
const outPath = outFlag >= 0 ? process.argv[outFlag + 1] : undefined;

const db = new Database(dbPath, { readonly: true });

const TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$|__tests__\/|(^|\/)tests?\/|(^|\/)test_[^/]*\.py$|_test\.py$|conftest\.py$/;

const moduleOf = (file: string): string => {
  if (TEST_RE.test(file)) return "tests";
  const ix = file.indexOf("/");
  return ix < 0 ? "(root)" : file.slice(0, ix);
};

// 文件 → 模块归属；统计每模块文件数
const files = db.prepare("SELECT id, file FROM nodes WHERE kind = 'file'").all() as { id: string; file: string }[];
const fileCount = new Map<string, number>();
for (const f of files) {
  const m = moduleOf(f.file);
  fileCount.set(m, (fileCount.get(m) ?? 0) + 1);
}

// 文件级 imports → 模块级聚合边
const imports = db.prepare("SELECT src, dst FROM edges WHERE kind = 'imports'").all() as { src: string; dst: string }[];
const weight = new Map<string, number>();
for (const e of imports) {
  const ms = moduleOf(e.src);
  const md = moduleOf(e.dst);
  if (ms === md) continue;
  const key = `${ms}\u0000${md}`;
  weight.set(key, (weight.get(key) ?? 0) + 1);
}

// 盲区计数按模块归属（诚实呈现）
const blinds = db.prepare(
  `SELECT file,
     SUM(CASE WHEN reason LIKE 'dynamic%' OR reason LIKE 'subprocess%' OR reason LIKE 'star import%' OR reason LIKE 'unresolved self%' OR reason LIKE 'attribute call%' THEN 1 ELSE 0 END) dyn,
     SUM(CASE WHEN reason LIKE 'unresolved call%' THEN 1 ELSE 0 END) unres
   FROM blind_spots WHERE reason NOT LIKE 'test-global%' GROUP BY file`,
).all() as { file: string; dyn: number; unres: number }[];
const blindByModule = new Map<string, { dyn: number; unres: number }>();
for (const b of blinds) {
  const m = moduleOf(b.file);
  const cur = blindByModule.get(m) ?? { dyn: 0, unres: 0 };
  cur.dyn += b.dyn;
  cur.unres += b.unres;
  blindByModule.set(m, cur);
}

// Mermaid 输出
const alias = new Map<string, string>();
let seq = 0;
const idOf = (m: string): string => {
  let a = alias.get(m);
  if (!a) {
    a = `M${seq++}`;
    alias.set(m, a);
  }
  return a;
};

const lines: string[] = ["```mermaid", "flowchart TD"];
const sorted = [...fileCount.entries()].sort((a, b) => b[1] - a[1]);
for (const [m, count] of sorted) {
  const blind = blindByModule.get(m) ?? { dyn: 0, unres: 0 };
  const parts = [`${count} files`];
  if (blind.dyn > 0) parts.push(`${blind.dyn} dyn`);
  if (blind.unres > 0) parts.push(`${blind.unres} unres`);
  const label = `${m}<br/>${parts.join(" · ")}`;
  const shape = m === "tests" ? `${idOf(m)}[/"${label}"/]` : `${idOf(m)}["${label}"]`;
  lines.push(`    ${shape}`);
}
const sortedEdges = [...weight.entries()].sort((a, b) => b[1] - a[1]);
for (const [key, w] of sortedEdges) {
  const [ms, md] = key.split("\u0000");
  lines.push(`    ${idOf(ms)} -->|${w}| ${idOf(md)}`);
}
lines.push("```");

const summaryTable = [
  "",
  "| 模块 | 文件数 | 动态调用盲区 | 未解析调用 | 出边依赖 | 入边被依赖 |",
  "|---|---|---|---|---|",
];
const outDeg = new Map<string, number>();
const inDeg = new Map<string, number>();
for (const [key, w] of weight) {
  const [ms, md] = key.split("\u0000");
  outDeg.set(ms, (outDeg.get(ms) ?? 0) + w);
  inDeg.set(md, (inDeg.get(md) ?? 0) + w);
}
for (const [m, count] of sorted) {
  summaryTable.push(
    `| ${m} | ${count} | ${blindByModule.get(m)?.dyn ?? 0} | ${blindByModule.get(m)?.unres ?? 0} | ${outDeg.get(m) ?? 0} | ${inDeg.get(m) ?? 0} |`,
  );
}

const doc = [
  `# Architecture Map`,
  "",
  `> codeblast M3-v0（目录级折叠）· 节点=模块（含文件数/盲区数），边=import 依赖（数字=强度）`,
  `> 口径: **dyn** = 结构性动态调用（eval/动态import/子进程/属性链）,静态原理性不可达;`,
  `> **unres** = 调用目标解析失败（多为缺依赖或复杂表达式）,可能因环境不全而虚高。`,
  "",
  ...lines,
  ...summaryTable,
  "",
].join("\n");

if (outPath) {
  await Bun.write(outPath, doc);
  console.error(`written: ${outPath}`);
} else {
  console.log(doc);
}
