#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeblast-incremental-"));
const bin = path.join(process.cwd(), "dist", "bin.js");
const incrementalDb = path.join(root, "incremental.db");
const fullDb = path.join(root, "full.db");
const runIndex = (db) => {
  const start = performance.now();
  const result = spawnSync(process.execPath, [bin, "index", root, "--db", db], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return { ms: Math.round(performance.now() - start), output: JSON.parse(result.stdout) };
};
const rows = (dbPath, table, columns) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare(`SELECT ${columns} FROM ${table} ORDER BY ${columns}`).all(); }
  finally { db.close(); }
};
try {
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "packages", "core", "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fixture", workspaces: ["packages/*"] }));
  fs.writeFileSync(path.join(root, "packages/core/package.json"), JSON.stringify({ name: "@fixture/core" }));
  fs.writeFileSync(path.join(root, "packages/core/src/index.ts"), "export const core = 1;\n");
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true }, include: ["src", "packages"] }));
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(root, "src", `unchanged-${i}.ts`), `export const unchanged${i} = ${i};\n`);
  fs.writeFileSync(path.join(root, "src/a.ts"), "import { core } from '@fixture/core'; export function a() { return core; }\n");
  fs.writeFileSync(path.join(root, "src/b.ts"), 'import { a } from "./a"; export function b() { return a(); }\n');
  const initial = runIndex(incrementalDb);
  fs.writeFileSync(path.join(root, "src/a.ts"), "export function a() { return 2; }\nexport function added() { return 3; }\n");
  fs.renameSync(path.join(root, "src/b.ts"), path.join(root, "src/renamed.ts"));
  fs.writeFileSync(path.join(root, "src/renamed.ts"), 'import { added } from "./a"; export function renamed() { return added(); }\n');
  fs.writeFileSync(path.join(root, "src/c.ts"), 'import { added } from "./a"; export function c() { return added(); }\n');
  const incremental = runIndex(incrementalDb);
  const fresh = runIndex(fullDb);
  const tables = [
    ["nodes", "id,kind,name,file,line,end_line,exported,signature,src_file"],
    ["edges", "src,dst,kind,file,line,confidence,src_file"],
    ["blind_spots", "file,line,reason,src_file"],
  ];
  const equality = Object.fromEntries(tables.map(([table, columns]) => [table, JSON.stringify(rows(incrementalDb, table, columns)) === JSON.stringify(rows(fullDb, table, columns))]));
  const staleRemoved = !rows(incrementalDb, "nodes", "id").some((row) => String(row.id).startsWith("src/b.ts"));
  const passed = Object.values(equality).every(Boolean) && staleRemoved && incremental.output.files_skipped >= 30;
  const score = { passed, initial_ms: initial.ms, incremental_ms: incremental.ms, fresh_ms: fresh.ms, speedup: Number((fresh.ms / incremental.ms).toFixed(2)), equality, stale_removed: staleRemoved, indexed: incremental.output.files_indexed, skipped: incremental.output.files_skipped };
  if (process.env.CODEBLAST_INCREMENTAL_OUT) fs.writeFileSync(process.env.CODEBLAST_INCREMENTAL_OUT, JSON.stringify(score, null, 2) + "\n");
  console.log(JSON.stringify(score));
  if (!passed) process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
