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
import type { ImportBindingRow } from "./schema";
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
  // 递归找全部 tsconfig.json（深度 ≤3，跳过噪音目录）——覆盖 packages/* 与 tabby-*/ 这类平铺布局
  const SKIP: Record<string, true> = { node_modules: true, ".git": true, dist: true, build: true, coverage: true };
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory() && !SKIP[entry.name] && !entry.name.startsWith(".")) walk(p, depth + 1);
      else if (entry.name === "tsconfig.json" && p !== rootConfig) found.push(p);
    }
  };
  walk(repoRoot, 1);
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
  console.error("proceeding: python-only ingestion");
}
console.error(`repo root: ${repoRoot}`);
console.error(`tsconfigs: ${tsconfigs.length}`);

const t0 = performance.now();
const db = openGraph(dbPath);

const insertNode = db.prepare(
  "INSERT OR REPLACE INTO nodes (id, kind, name, file, line, end_line, exported, signature, src_file) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
);
const insertEdge = db.prepare(
  "INSERT OR REPLACE INTO edges (src, dst, kind, file, line, confidence, src_file) VALUES (?, ?, ?, ?, ?, ?, ?)",
);
const insertBlind = db.prepare(
  "INSERT OR REPLACE INTO blind_spots (file, line, reason, src_file) VALUES (?, ?, ?, ?)",
);
const insertBinding = db.prepare(
  "INSERT OR REPLACE INTO import_bindings (importer, imported, names, star, src_file) VALUES (?, ?, ?, ?, ?)",
);
const upsertFile = db.prepare("INSERT OR REPLACE INTO files (path, hash) VALUES (?, ?)");
const getHash = db.prepare("SELECT hash FROM files WHERE path = ?");

const writeBatch = db.transaction(
  (relPath: string, hash: string, nodes: NodeRow[], edges: EdgeRow[], blind: BlindSpotRow[], bindings: ImportBindingRow[] = []) => {
    invalidateFile(db, relPath);
    for (const n of nodes) insertNode.run(n.id, n.kind, n.name, n.file, n.line, n.end_line, n.exported, n.signature ?? "", n.src_file);
    for (const e of edges) insertEdge.run(e.src, e.dst, e.kind, e.file, e.line, e.confidence, e.src_file);
    for (const b of blind) insertBlind.run(b.file, b.line, b.reason, b.src_file);
    for (const ib of bindings) insertBinding.run(ib.importer, ib.imported, ib.names, ib.star, ib.src_file);
    upsertFile.run(relPath, hash);
  },
);

let indexed = 0, skipped = 0, nodeCount = 0, edgeCount = 0, blindCount = 0;
const seenFiles = new Set<string>(); // 跨包去重：同一文件只归属第一个索引它的 program

function indexProgram(extractor: Extractor): void {
  extractor.collectImplementers();
  for (const sf of extractor.sourceFiles()) {
    const relPath = extractor.rel(sf.fileName);
    if (relPath.startsWith("..") || seenFiles.has(relPath)) continue;
    seenFiles.add(relPath);

    const hash = createHash("sha1").update(sf.text).digest("hex");
    const existing = getHash.get(relPath) as { hash: string } | null;
    if (existing?.hash === hash) {
      skipped++;
      continue;
    }
    const { nodes, edges, blindSpots, bindings } = extractor.extractFile(sf);
    writeBatch(relPath, hash, nodes, edges, blindSpots, bindings);
    indexed++;
    nodeCount += nodes.length;
    edgeCount += edges.length;
    blindCount += blindSpots.length;
  }
}

for (const tsconfigPath of tsconfigs) {
  let extractor: Extractor;
  try {
    extractor = new Extractor(tsconfigPath, repoRoot);
  } catch (err) {
    console.error(`skip ${path.relative(repoRoot, tsconfigPath)}: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
    continue;
  }
  // 廉价预检：该包全部文件 hash 未变 → 跳过整个 program 构建（增量场景的大头收益）
  const names = extractor.fileNames();
  let anyChanged = names.length === 0; // 空包走完整路径兜底
  for (const abs of names) {
    const rel = path.relative(repoRoot, abs);
    if (rel.startsWith("..") || seenFiles.has(rel)) continue;
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      anyChanged = true;
      break;
    }
    const hash = createHash("sha1").update(text).digest("hex");
    const existing = getHash.get(rel) as { hash: string } | null;
    if (existing?.hash !== hash) {
      anyChanged = true;
      break;
    }
  }
  if (!anyChanged) {
    for (const abs of names) {
      const rel = path.relative(repoRoot, abs);
      if (!rel.startsWith("..") && !seenFiles.has(rel)) {
        seenFiles.add(rel);
        skipped++;
      }
    }
    continue;
  }
  indexProgram(extractor);
}

// 孤儿扫描：源码树里存在、但未被任何 tsconfig program 覆盖的 ts/tsx 文件（tsconfig include 之外的测试等）
const orphans: string[] = [];
const SKIP_DIRS: Record<string, true> = { node_modules: true, ".git": true, dist: true, build: true, coverage: true, ".next": true };
function sweep(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS[entry.name]) sweep(path.join(dir, entry.name));
    } else if (/\.[cm]?tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(repoRoot, abs);
      if (!seenFiles.has(rel)) orphans.push(abs);
    }
  }
}
sweep(repoRoot);
if (tsconfigs.length > 0 && orphans.length > 0) {
  console.error(`orphan files (outside all tsconfigs): ${orphans.length}`);
  // 同样的廉价预检：孤儿文件全部未变则跳过兜底 program
  let orphanChanged = false;
  for (const abs of orphans) {
    const rel = path.relative(repoRoot, abs);
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      orphanChanged = true;
      break;
    }
    const hash = createHash("sha1").update(text).digest("hex");
    const existing = getHash.get(rel) as { hash: string } | null;
    if (existing?.hash !== hash) {
      orphanChanged = true;
      break;
    }
  }
  if (orphanChanged) {
  indexProgram(Extractor.forFiles(orphans, tsconfigs[0], repoRoot));
  } else {
    for (const abs of orphans) {
      seenFiles.add(path.relative(repoRoot, abs));
      skipped++;
    }
  }
}
// Python 摄取（方案 B：高置信边 only，Impact 仅文件级）
const pyProbe = Bun.spawnSync(["python3", path.join(import.meta.dir, "py_extract.py"), repoRoot]);
if (pyProbe.exitCode === 0) {
  const payload = JSON.parse(pyProbe.stdout.toString()) as {
    files: { path: string; hash: string; nodes: NodeRow[]; edges: EdgeRow[]; blind_spots: BlindSpotRow[] }[];
  };
  for (const f of payload.files) {
    if (seenFiles.has(f.path)) continue;
    seenFiles.add(f.path);
    const existing = getHash.get(f.path) as { hash: string } | null;
    if (existing?.hash === f.hash && f.hash !== "") {
      skipped++;
      continue;
    }
    writeBatch(f.path, f.hash, f.nodes, f.edges, f.blind_spots);
    indexed++;
    nodeCount += f.nodes.length;
    edgeCount += f.edges.length;
    blindCount += f.blind_spots.length;
  }
  const pyFiles = payload.files.length;
  if (pyFiles > 0) console.error(`python files ingested: ${pyFiles}`);
}

const dt = ((performance.now() - t0) / 1000).toFixed(1);
console.log(JSON.stringify({
  db: dbPath, seconds: Number(dt), tsconfigs: tsconfigs.length,
  files_indexed: indexed, files_skipped: skipped,
  nodes: nodeCount, edges: edgeCount, blind_spots: blindCount,
}, null, 2));
