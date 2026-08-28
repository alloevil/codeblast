/**
 * CLI: bun run src/impact-cli.ts <graph.db> <node-id-or-name> [--max 500]
 * name 匹配多个节点时列出候选退出。
 */
import { Database } from "bun:sqlite";
import { impact } from "./impact";

const [dbPath, query] = process.argv.slice(2);
if (!dbPath || !query) {
  console.error("usage: bun run src/impact-cli.ts <graph.db> <node-id-or-name> [--max 500]");
  process.exit(1);
}
const maxFlag = process.argv.indexOf("--max");
const maxNodes = maxFlag >= 0 ? Number(process.argv[maxFlag + 1]) : 500;

const db = new Database(dbPath, { readonly: true });

let targetId = query;
const exact = db.prepare("SELECT id FROM nodes WHERE id = ?").get(query);
if (!exact) {
  const candidates = db.prepare(
    "SELECT id, kind, file, line FROM nodes WHERE name = ? AND kind != 'file' LIMIT 20",
  ).all(query) as { id: string; kind: string; file: string; line: number }[];
  if (candidates.length === 0) {
    console.error(`no node matches: ${query}`);
    process.exit(1);
  }
  if (candidates.length > 1) {
    console.error(`ambiguous name, ${candidates.length} candidates:`);
    for (const c of candidates) console.error(`  ${c.id}  (${c.kind} @ ${c.file}:${c.line})`);
    process.exit(1);
  }
  targetId = candidates[0].id;
}

const t0 = performance.now();
const result = impact(db, targetId, maxNodes);
const ms = (performance.now() - t0).toFixed(0);
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(result));
  process.exit(0);
}

const byLevel = { direct: 0, indirect: 0, tests: 0 };
for (const it of result.items) byLevel[it.level]++;
const callItems = result.items.filter((it) => it.channel === "call");
const fileCount = result.items.length - callItems.length;

console.log(`target: ${result.target}`);
console.log(`impact: ${result.items.length} nodes (direct=${byLevel.direct} indirect=${byLevel.indirect} tests=${byLevel.tests})${result.truncated ? " [TRUNCATED — 广泛影响，建议全量测试]" : ""}`);
console.log(`  ├─ 调用链可达（高置信）: ${callItems.length}`);
console.log(`  └─ 经 import/re-export 可达（保守补充,勿跳过）: ${fileCount}`);
if (result.blind_spot_count > 0) console.log(`blind spots in target file: ${result.blind_spot_count} (影响可能被低估)`);
if (result.co_change_hints.length > 0) {
  console.log(`历史耦合提示（静态图无边,但常一起改）:`);
  for (const h of result.co_change_hints) console.log(`  ~ ${h.file} (${h.co_commits} 次共同提交, ${h.evidence})`);
}
console.log(`query: ${ms}ms\n`);

const ordered = [...callItems, ...result.items.filter((it) => it.channel !== "call")];
for (const it of ordered.slice(0, 40)) {
  const conf = it.confidence === "conservative" ? " ~" : "";
  const ch = it.channel === "file" ? " ·import" : "";
  console.log(`  [${it.level}${conf}${ch}] ${it.id}  (${it.kind}, ${it.hops} hop, via ${it.via_file}:${it.via_line})`);
}
if (ordered.length > 40) console.log(`  ... and ${ordered.length - 40} more`);
