/**
 * CLI: bun run src/cli.ts <repo-root-or-tsconfig> [--db <path>]
 *
 * - 参数是 tsconfig.json → 单 program 索引。
 * - 参数是目录 → 发现 monorepo 内全部包级 tsconfig（顶层 + packages/apps/libs 一级子目录），
 *   逐包建 program，节点 id 统一相对仓库根。
 * - 增量：文件 hash 未变则跳过（失效见 schema.invalidateFile）。
 */
import path from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { openGraph, invalidateFile, type NodeRow, type EdgeRow, type BlindSpotRow } from "./schema";
import { Extractor } from "./extract";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: bun run src/cli.ts <repo-root-or-tsconfig> [--db graph.db]");
  process.exit(1);
}

const target = path.resolve(args[0]);
const dbFlag = args.indexOf("--db");
const dbPath = dbFlag >= 0 ? args[dbFlag + 1] : path.join(process.cwd(), "graph.db");

/** monorepo tsconfig 发现：仓库根 + 常见 workspace 目录的一级子目录。 */
function discoverTsconfigs(repoRoot: string): string[] {
  const found: string[] = [];
  const rootConfig = path.join(repoRoot, "tsconfig.json");
  const wsDirs = ["packages", "apps", "libs"]
    .map((d) => path.join(repoRoot, d))
    .filter((d) => fs.existsSync(d) && fs.statSync(d).isDirectory());
  for (const wsDir of wsDirs) {
    for (const entry of fs.readdirSync(wsDir)) {
      const candidate = path.join(wsDir, entry, "tsconfig.json");
      if (fs.existsSync(candidate)) found.push(candidate);
    }
  }
  // 非 monorepo（无 workspace 包）时才用根 tsconfig，避免文件被双重索引
  if (found.length === 0 && fs.existsSync(rootConfig)) found.push(rootConfig);
  return found;
}

let repoRoot: string;
let tsconfigs: string[];
if (target.endsWith(".json")) {
  repoRoot = path.dirname(target);
  tsconfigs = [target];
} else {
  repoRoot = target;
  tsconfigs = discoverTsconfigs(target);
}
if (tsconfigs.length === 0) {
  console.error(`no tsconfig.json found under: ${target}`);
  process.exit(1);
}
console.error(`repo root: ${repoRoot}`);
console.error(`tsconfigs: ${tsconfigs.length}`);

const t0 = performance.now();
const db = openGraph(dbPath);

const insertNode = db.prepare(
  "INSERT OR REPLACE INTO nodes (id, kind, name, file, line, end_line, exported, src_file) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
);
const insertEdge = db.prepare(
  "INSERT OR REPLACE INTO edges (src, dst, kind, file, line, confidence, src_file) VALUES (?, ?, ?, ?, ?, ?, ?)",
);
const insertBlind = db.prepare(
  "INSERT OR REPLACE INTO blind_spots (file, line, reason, src_file) VALUES (?, ?, ?, ?)",
);
const upsertFile = db.prepare("INSERT OR REPLACE INTO files (path, hash) VALUES (?, ?)");
const getHash = db.prepare("SELECT hash FROM files WHERE path = ?");

const writeBatch = db.transaction(
  (relPath: string, hash: string, nodes: NodeRow[], edges: EdgeRow[], blind: BlindSpotRow[]) => {
    invalidateFile(db, relPath);
    for (const n of nodes) insertNode.run(n.id, n.kind, n.name, n.file, n.line, n.end_line, n.exported, n.src_file);
    for (const e of edges) insertEdge.run(e.src, e.dst, e.kind, e.file, e.line, e.confidence, e.src_file);
    for (const b of blind) insertBlind.run(b.file, b.line, b.reason, b.src_file);
    upsertFile.run(relPath, hash);
  },
);

let indexed = 0, skipped = 0, nodeCount = 0, edgeCount = 0, blindCount = 0;
const seenFiles = new Set<string>(); // 跨包去重：同一文件只归属第一个索引它的 program

for (const tsconfigPath of tsconfigs) {
  let extractor: Extractor;
  try {
    extractor = new Extractor(tsconfigPath, repoRoot);
  } catch (err) {
    console.error(`skip ${path.relative(repoRoot, tsconfigPath)}: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
    continue;
  }
  extractor.collectImplementers();

  for (const sf of extractor.sourceFiles()) {
    const relPath = extractor.rel(sf.fileName);
    if (relPath.startsWith("..") || seenFiles.has(relPath)) continue; // 仓库外或已被其他包索引
    seenFiles.add(relPath);

    const hash = createHash("sha1").update(sf.text).digest("hex");
    const existing = getHash.get(relPath) as { hash: string } | null;
    if (existing?.hash === hash) {
      skipped++;
      continue;
    }
    const { nodes, edges, blindSpots } = extractor.extractFile(sf);
    writeBatch(relPath, hash, nodes, edges, blindSpots);
    indexed++;
    nodeCount += nodes.length;
    edgeCount += edges.length;
    blindCount += blindSpots.length;
  }
}

const dt = ((performance.now() - t0) / 1000).toFixed(1);
console.log(JSON.stringify({
  db: dbPath, seconds: Number(dt), tsconfigs: tsconfigs.length,
  files_indexed: indexed, files_skipped: skipped,
  nodes: nodeCount, edges: edgeCount, blind_spots: blindCount,
}, null, 2));
