/**
 * 测试共用：内存 SQLite 图谱构造器。走 schema.ts 的真实 DDL,不复制表结构。
 */
import { Database } from "bun:sqlite";
import { openGraph } from "../src/schema";
import type { EdgeKind, NodeKind } from "../src/schema";

export interface N { id: string; kind?: NodeKind; name?: string; file?: string; line?: number; end_line?: number; exported?: 0 | 1; signature?: string; src_file?: string }
export interface E { src: string; dst: string; kind: EdgeKind; file?: string; line?: number; confidence?: "exact" | "conservative" | "blind"; src_file?: string }

/** 从 id 推断默认元数据：`a.ts#foo` → file=a.ts,name=foo,kind=function；`a.ts` → kind=file。 */
function defaults(n: N) {
  const hash = n.id.indexOf("#");
  const file = n.file ?? (hash < 0 ? n.id : n.id.slice(0, hash));
  const name = n.name ?? (hash < 0 ? file.split("/").pop()! : n.id.slice(hash + 1));
  const kind: NodeKind = n.kind ?? (hash < 0 ? "file" : "function");
  return { file, name, kind };
}

export function memGraph(nodes: N[], edges: E[] = []): Database {
  const db = openGraph(":memory:");
  const insNode = db.prepare(
    "INSERT OR REPLACE INTO nodes (id, kind, name, file, line, end_line, exported, signature, src_file) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insEdge = db.prepare(
    "INSERT OR REPLACE INTO edges (src, dst, kind, file, line, confidence, src_file) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const n of nodes) {
    const d = defaults(n);
    const line = n.line ?? 1;
    insNode.run(n.id, d.kind, d.name, d.file, line, n.end_line ?? line + 5, n.exported ?? 0, n.signature ?? "", n.src_file ?? d.file);
  }
  for (const e of edges) {
    const file = e.file ?? e.src.split("#")[0];
    insEdge.run(e.src, e.dst, e.kind, file, e.line ?? 1, e.confidence ?? "exact", e.src_file ?? file);
  }
  return db;
}

export function addBinding(db: Database, importer: string, imported: string, names: string, star: 0 | 1 = 0): void {
  db.prepare("INSERT OR REPLACE INTO import_bindings (importer, imported, names, star, src_file) VALUES (?, ?, ?, ?, ?)")
    .run(importer, imported, names, star, importer);
}

export function addBlind(db: Database, file: string, line: number, reason: string): void {
  db.prepare("INSERT OR REPLACE INTO blind_spots (file, line, reason, src_file) VALUES (?, ?, ?, ?)").run(file, line, reason, file);
}
