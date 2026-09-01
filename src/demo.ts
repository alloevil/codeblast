#!/usr/bin/env bun
/**
 * 一键 smoke：建图 → 查一次 impact → 出交互图,全程打印可核对的数字。
 * 默认拿 codeblast 自己当靶子（自举）,也可 `codeblast demo <repo>`。
 */
import path from "node:path";
import { Database } from "bun:sqlite";

const repo = path.resolve(process.argv[2] ?? path.join(import.meta.dir, ".."));
const db = "/tmp/codeblast-demo.db";
const out = "/tmp/codeblast-demo-arch.html";
const here = import.meta.dir;

const run = (label: string, args: string[]): string => {
  console.log(`\n\x1b[36m▸ ${label}\x1b[0m`);
  console.log(`  $ ${args.join(" ")}`);
  const p = Bun.spawnSync(args, { cwd: here });
  const stdout = p.stdout.toString();
  const stderr = p.stderr.toString();
  if (p.exitCode !== 0) {
    console.error(stderr.slice(-800) || stdout.slice(-800));
    console.error(`\n\x1b[31m✗ step failed: ${label}\x1b[0m`);
    process.exit(p.exitCode ?? 1);
  }
  process.stdout.write(stdout.split("\n").slice(0, 14).map((l) => "  " + l).join("\n") + "\n");
  return stdout;
};

console.log(`codeblast demo — target: ${repo}`);
for (const f of [db, `${db}-wal`, `${db}-shm`]) Bun.spawnSync(["rm", "-f", f]);

run("1/4 build graph", ["bun", "run", path.join(here, "cli.ts"), repo, "--db", db]);
run("2/4 incremental rerun (should skip everything)", ["bun", "run", path.join(here, "cli.ts"), repo, "--db", db]);

// 挑一个被最多调用者依赖的导出符号来演示 impact
const conn = new Database(db, { readonly: true });
const pick = conn.prepare(
  `SELECT n.id, COUNT(DISTINCT e.src) c FROM nodes n
   JOIN edges e ON e.dst = n.id AND e.kind = 'calls'
   WHERE n.kind IN ('function','method','class') AND n.exported = 1
   GROUP BY n.id ORDER BY c DESC LIMIT 1`,
).get() as { id: string; c: number } | null;
conn.close();

if (pick) {
  run(`3/4 impact of the most-called export (${pick.id.split("#").pop()}, ${pick.c} callers)`,
    ["bun", "run", path.join(here, "impact-cli.ts"), db, pick.id]);
} else {
  console.log("\n▸ 3/4 impact — skipped: no exported symbol with callers in this repo");
}

run("4/4 interactive architecture map", ["bun", "run", path.join(here, "archmap-html.ts"), db, "--out", out]);

console.log(`\n\x1b[32m✓ demo complete\x1b[0m
  graph:  ${db}
  map:    ${out}   ← open this in a browser
  next:   codeblast impact ${db} "<symbol>"
          codeblast change <repo> HEAD~1 HEAD
  live demos: https://alloevil.github.io/codeblast/`);
