/**
 * CLI: codeblast impact <graph.db> <node-id-or-name> [--max 500] [--all] [--json]
 *
 * name 匹配多个节点时列出候选退出。
 * 人读输出默认只列 call 通道 + 受影响测试（实测精确率 ~0.70）；--all 展开 import 通道的
 * 保守项（召回所需，但精确率 ~0.36，逐条读是噪音）。--json 不受影响,始终是完整集合 ——
 * 机器消费者要的是全集,人要的是能立刻读完的清单。
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
const showAll = process.argv.includes("--all");

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
  // process.exit() right after a write truncates it: stdout is async when piped, and node
  // discards whatever is still buffered (>64KB on Linux pipes). Big impact sets used to
  // reach consumers as invalid JSON — the mutation harness hit exactly this. Let the
  // process end on its own so the buffer drains.
  process.stdout.write(JSON.stringify(result) + "\n");
  db.close();
  process.exitCode = 0;
} else {
  printHuman();
}

function printHuman(): void {
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
    for (const h of result.co_change_hints) console.log(`  ~ ${h.file} (${h.co_commits} co-commits, ${h.evidence})`);
  }
  console.log(`query: ${ms}ms\n`);

  // 默认清单：call 通道（要人工过的 callsite）+ 全部受影响测试（要跑的东西,不论通道）。
  // import 通道的非测试项属于"宁误报不漏报"的保守补充,数量大且精确率低,默认折叠。
  const testItems = result.items.filter((it) => it.level === "tests");
  const callNonTest = callItems.filter((it) => it.level !== "tests");
  const fileNonTest = [...fileNamed, ...fileUnnamed].filter((it) => it.level !== "tests");
  const shown = showAll ? [...callItems, ...fileNamed, ...fileUnnamed] : [...callNonTest, ...testItems];
  const LIMIT = 40;
  for (const it of shown.slice(0, LIMIT)) {
    const conf = it.confidence === "conservative" ? " ~" : "";
    const ch = it.channel === "file" ? (it.named_miss ? " ·closure" : " ·import") : "";
    console.log(`  [${it.level}${conf}${ch}] ${it.id}  (${it.kind}, ${it.hops} hop, via ${it.via_file}:${it.via_line})`);
  }
  if (shown.length > LIMIT) console.log(`  ... and ${shown.length - LIMIT} more`);
  if (!showAll && fileNonTest.length > 0) {
    const files = new Set(fileNonTest.map((it) => it.file)).size;
    console.log(`\n  + ${fileNonTest.length} conservative items across ${files} files reachable only via imports — --all to list them.`);
    console.log(`    They are part of the no-false-negative promise: run the tests above, do not treat this list as noise.`);
  }
}
