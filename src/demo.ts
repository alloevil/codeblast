/**
 * 一键 smoke：建图 → 查一次 impact → 出交互图,全程打印可核对的数字。
 * 默认拿 codeblast 自己当靶子（自举）,也可 `codeblast demo <repo>`。
 */
import fs from "node:fs";
import path from "node:path";
import { openDatabase } from "./db";
import { selfCommand, spawnSync } from "./proc";

const repo = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".."));
const db = "/tmp/codeblast-demo.db";
const out = "/tmp/codeblast-demo-arch.html";

const run = (label: string, args: string[]): string => {
  console.log(`\n\x1b[36m▸ ${label}\x1b[0m`);
  console.log(`  $ codeblast ${args.slice(2).join(" ")}`);
  const p = spawnSync(args);
  if (p.exitCode !== 0) {
    console.error(p.stderr.slice(-800) || p.stdout.slice(-800));
    console.error(`\n\x1b[31m✗ step failed: ${label}\x1b[0m`);
    process.exit(p.exitCode);
  }
  process.stdout.write(p.stdout.split("\n").slice(0, 14).map((l) => "  " + l).join("\n") + "\n");
  return p.stdout;
};

console.log(`codeblast demo — target: ${repo}`);
for (const s of ["", "-wal", "-shm"]) fs.rmSync(db + s, { force: true });

run("1/4 build graph", selfCommand("index", repo, "--db", db));
run("2/4 incremental rerun (should skip everything)", selfCommand("index", repo, "--db", db));

// 挑一个被最多调用者依赖的导出符号来演示 impact
const conn = openDatabase(db, { readonly: true });
const pick = conn.prepare(
  `SELECT n.id, COUNT(DISTINCT e.src) c FROM nodes n
   JOIN edges e ON e.dst = n.id AND e.kind = 'calls'
   WHERE n.kind IN ('function','method','class') AND n.exported = 1
   GROUP BY n.id ORDER BY c DESC LIMIT 1`,
).get() as { id: string; c: number } | undefined;
conn.close();

if (pick) {
  run(`3/4 impact of the most-called export (${pick.id.split("#").pop()}, ${pick.c} callers)`,
    selfCommand("impact", db, pick.id));
} else {
  console.log("\n▸ 3/4 impact — skipped: no exported symbol with callers in this repo");
}

run("4/4 interactive architecture map", selfCommand("archmap", db, "--out", out));

console.log(`\n\x1b[32m✓ demo complete\x1b[0m
  graph:  ${db}
  map:    ${out}   ← open this in a browser
  next:   codeblast impact ${db} "<symbol>"
          codeblast change <repo> HEAD~1 HEAD
  live demos: https://alloevil.github.io/codeblast/`);
