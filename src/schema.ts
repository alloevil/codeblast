/**
 * L1 图谱 schema — SQLite 单文件。
 *
 * 设计约束（intent.md）：
 * - 每条节点/边记录挂 file:line 证据。
 * - 按文件增量失效：所有行都带 `src_file`（该记录由哪个文件的分析产出），
 *   文件变更时 DELETE WHERE src_file = ? 后仅重索引该文件。
 * - 无 LLM 成分。
 * - 预留 service/api/queue 节点类型（v1 不产出）。
 */
import { Database } from "bun:sqlite";

export const NODE_KINDS = [
  "function",
  "method",
  "class",
  "interface",
  "file",
  "module", // L2 折叠层产出，L1 不写
  "test",
  // v1 预留，不填：
  "service",
  "api",
  "queue",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = [
  "calls", //     函数/方法 → 函数/方法
  "implements", // class → interface
  "extends", //   class → class / interface → interface
  "imports", //   file → file
  "contains", //  file → function/class（下钻用）
  "tests", //     test → function（测试覆盖映射）
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

/** 边置信度：exact = 类型解析唯一目标；conservative = 保守过近似（接口全连）；blind = 盲区。 */
export type Confidence = "exact" | "conservative" | "blind";

export interface NodeRow {
  id: string; // 稳定 id：<relpath>#<qualified-name>；file 节点 = <relpath>
  kind: NodeKind;
  name: string;
  file: string; // 相对仓库根
  line: number; // 1-based
  end_line: number;
  exported: 0 | 1;
  src_file: string; // 增量失效键
}

export interface EdgeRow {
  src: string;
  dst: string;
  kind: EdgeKind;
  file: string; // 证据位置（引用发生处）
  line: number;
  confidence: Confidence;
  src_file: string;
}

/** 盲区：静态分析放弃的位置，显式记录，绝不静默丢弃。 */
export interface BlindSpotRow {
  file: string;
  line: number;
  reason: string; // e.g. "dynamic import with non-literal argument"
  src_file: string;
}

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,      -- 相对仓库根
  hash TEXT NOT NULL          -- 内容 hash，增量判断
);
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  exported INTEGER NOT NULL DEFAULT 0,
  src_file TEXT NOT NULL,
  PRIMARY KEY (id)
);
CREATE INDEX IF NOT EXISTS idx_nodes_src_file ON nodes(src_file);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE TABLE IF NOT EXISTS edges (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  kind TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'exact',
  src_file TEXT NOT NULL,
  PRIMARY KEY (src, dst, kind, file, line)
);
CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
CREATE INDEX IF NOT EXISTS idx_edges_src_file ON edges(src_file);
CREATE TABLE IF NOT EXISTS blind_spots (
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  reason TEXT NOT NULL,
  src_file TEXT NOT NULL,
  PRIMARY KEY (file, line, reason)
);
CREATE INDEX IF NOT EXISTS idx_blind_src_file ON blind_spots(src_file);
`;

export function openGraph(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(DDL);
  return db;
}

/** 增量失效：删除某文件产出的全部记录。 */
export function invalidateFile(db: Database, relPath: string): void {
  db.prepare("DELETE FROM nodes WHERE src_file = ?").run(relPath);
  db.prepare("DELETE FROM edges WHERE src_file = ?").run(relPath);
  db.prepare("DELETE FROM blind_spots WHERE src_file = ?").run(relPath);
  db.prepare("DELETE FROM files WHERE path = ?").run(relPath);
}
