/**
 * CLI: codeblast impact <graph.db> <node-id-or-name> [--max 500]
 * name 匹配多个节点时列出候选退出。
 */
import { openDatabase } from "./db";
import { impact } from "./impact";

const [dbPath, query] = process.argv.slice(2);
if (!dbPath || !query) {
  console.error("usage: codeblast impact <graph.db> <node-id-or-name> [--max 500]");
  process.exit(1);
}
const maxFlag = process.argv.indexOf("--max");
const maxNodes = maxFlag >= 0 ? Number(process.argv[maxFlag + 1]) : 500;

const db = openDatabase(dbPath, { readonly: true });

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
const fileNamed = result.items.filter((it) => it.channel === "file" && !it.named_miss);
const fileUnnamed = result.items.filter((it) => it.channel === "file" && it.named_miss);

console.log(`target: ${result.target}`);
console.log(`impact: ${result.items.length} nodes (direct=${byLevel.direct} indirect=${byLevel.indirect} tests=${byLevel.tests})${result.truncated ? " [TRUNCATED — wide impact, run the full suite]" : ""}`);
console.log(`  ├─ call-graph reachable (high confidence): ${callItems.length}`);
console.log(`  ├─ reachable via named import: ${fileNamed.length}`);
console.log(`  └─ reachable via unnamed import (execution closure, conservative — do not skip): ${fileUnnamed.length}`);
if (result.blind_spot_count > 0) console.log(`blind spots in target file: ${result.blind_spot_count} (impact may be underestimated)`);
if (result.co_change_hints.length > 0) {
  console.log(`co-change hints (no static edge, but historically changed together):`);
  for (const h of result.co_change_hints) console.log(`  ~ ${h.file} (${h.co_commits}  co-commits, ${h.evidence})`);
}
console.log(`query: ${ms}ms\n`);

const ordered = [...callItems, ...fileNamed, ...fileUnnamed];
for (const it of ordered.slice(0, 40)) {
  const conf = it.confidence === "conservative" ? " ~" : "";
  const ch = it.channel === "file" ? (it.named_miss ? " ·closure" : " ·import") : "";
  console.log(`  [${it.level}${conf}${ch}] ${it.id}  (${it.kind}, ${it.hops} hop, via ${it.via_file}:${it.via_line})`);
}
if (ordered.length > 40) console.log(`  ... and ${ordered.length - 40} more`);
