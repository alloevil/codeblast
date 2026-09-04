/**
 * M5 — co-change 边：git 历史中的隐式耦合（CodeScene 验证过的信号）。
 *
 * 规则（保守，防噪音）：
 * - 取近 N 个非 merge 提交，每个提交的改动文件集（超大提交跳过——批量格式化无耦合信号）。
 * - 文件对 (a,b) 共同出现 ≥ MIN_CO 次，且 P(b|a) 或 P(a|b) ≥ MIN_RATIO → co_change 边。
 * - 只对"静态图上无任何边"的文件对产出（静态可达的耦合已有更准的边,不重复）。
 * - confidence 一律 "conservative"；存证据：共同提交次数与最近一次 sha。
 *
 * 用法: codeblast cochange <repo> <graph.db> [--commits 500]
 */
import { openDatabase, transaction } from "./db";
import { spawnSync } from "./proc";

const [repo, dbPath] = process.argv.slice(2);
if (!repo || !dbPath) {
  console.error("usage: codeblast cochange <repo> <graph.db> [--commits 500]");
  process.exit(1);
}
const cFlag = process.argv.indexOf("--commits");
const N_COMMITS = cFlag >= 0 ? Number(process.argv[cFlag + 1]) : 500;
const MIN_CO = 3;        // 至少 3 次一起改
const MIN_RATIO = 0.5;   // 且条件概率 ≥ 50%
const MAX_FILES_PER_COMMIT = 20; // 超过视为批量操作，无耦合信号

const db = openDatabase(dbPath);

// 图中已知文件集（只为图内文件建边）
const known = new Set(
  (db.prepare("SELECT path FROM files").all() as { path: string }[]).map((r) => r.path),
);

// git log 解析：每提交的文件清单
const log = spawnSync(
  ["git", "log", "--no-merges", `-${N_COMMITS}`, "--name-only", "--format=%x01%h"],
  { cwd: repo, maxBuffer: 64 * 1024 * 1024 },
);
if (log.exitCode !== 0) {
  console.error(log.stderr.slice(0, 300));
  process.exit(1);
}

interface Commit { sha: string; files: string[] }
const commits: Commit[] = [];
for (const block of log.stdout.split("\u0001")) {
  if (!block.trim()) continue;
  const lines = block.trim().split("\n");
  const sha = lines[0].trim();
  const files = lines.slice(1).map((l) => l.trim()).filter((f) => f && known.has(f));
  if (files.length >= 2 && files.length <= MAX_FILES_PER_COMMIT) commits.push({ sha, files });
}

// 计数
const fileFreq = new Map<string, number>();
const pairFreq = new Map<string, { count: number; lastSha: string }>();
for (const c of commits) {
  for (const f of c.files) fileFreq.set(f, (fileFreq.get(f) ?? 0) + 1);
  const sorted = [...c.files].sort();
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const key = `${sorted[i]}\u0000${sorted[j]}`;
      const e = pairFreq.get(key) ?? { count: 0, lastSha: c.sha };
      e.count++;
      e.lastSha = c.sha;
      pairFreq.set(key, e);
    }
  }
}

// 静态边已覆盖的文件对（双向、任意 kind ≠ co_change）
const staticPairs = new Set<string>();
for (const r of db.prepare(
  "SELECT DISTINCT src, dst FROM edges WHERE kind != 'co_change'",
).all() as { src: string; dst: string }[]) {
  const fa = r.src.split("#")[0];
  const fb = r.dst.split("#")[0];
  if (fa === fb) continue;
  staticPairs.add([fa, fb].sort().join("\u0000"));
}

// 产出边
db.prepare("DELETE FROM edges WHERE kind = 'co_change'").run();
const insert = db.prepare(
  "INSERT OR REPLACE INTO edges (src, dst, kind, file, line, confidence, src_file) VALUES (?, ?, 'co_change', ?, ?, 'conservative', ?)",
);
let emitted = 0;
const samples: string[] = [];
const writeAll = transaction(db, () => {
  for (const [key, e] of pairFreq) {
    if (e.count < MIN_CO) continue;
    const [a, b] = key.split("\u0000");
    if (staticPairs.has(key)) continue;
    const ratio = Math.max(e.count / fileFreq.get(a)!, e.count / fileFreq.get(b)!);
    if (ratio < MIN_RATIO) continue;
    // 双向边（耦合无方向）；line 存共同提交数（证据度量）,src_file 存证据 sha
    insert.run(a, b, a, e.count, `git:${e.lastSha}`);
    insert.run(b, a, b, e.count, `git:${e.lastSha}`);
    emitted += 2;
    if (samples.length < 10) samples.push(`${a} <-> ${b} (${e.count}x, ${(ratio * 100).toFixed(0)}%, ${e.lastSha})`);
  }
});
writeAll();

console.log(JSON.stringify({ commits_scanned: commits.length, pairs_considered: pairFreq.size, edges_emitted: emitted }, null, 2));
for (const s of samples) console.error("  " + s);
