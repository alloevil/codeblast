/**
 * M4 — 图级 diff：两份图谱（同仓两个版本）的结构差。
 *
 * 输出（自研点，市面无现成库）：
 * - 节点：added / removed / renamed（同文件同 kind、名字变但行号邻近 → rename 候选）
 * - 边：  added / removed（calls/imports/implements/extends）
 * - 模块级聚合：折叠到目录模块，给 Change Map 用
 *
 * 重命名匹配（GumTree 思路简化）：removed ∩ added 中，
 * 同文件 + 同 kind + 行号差 ≤ 30 → 判 rename（保守，误差记 add+remove 不算错）。
 */
import { Database } from "bun:sqlite";

export interface NodeDelta { id: string; kind: string; name: string; file: string; line: number }
export interface RenameDelta { from: string; to: string; file: string; kind: string }
export interface EdgeDelta { src: string; dst: string; kind: string; file: string; line: number }

export interface GraphDiff {
  nodesAdded: NodeDelta[];
  nodesRemoved: NodeDelta[];
  renamed: RenameDelta[];
  edgesAdded: EdgeDelta[];
  edgesRemoved: EdgeDelta[];
  /** export 可见性变化：同一符号 exported 位翻转（API 面变化,静默不一致案例 62c6ab0） */
  visibilityChanged: { id: string; name: string; kind: string; file: string; line: number; nowExported: boolean }[];
}

interface NodeRow { id: string; kind: string; name: string; file: string; line: number; exported: number }
interface EdgeRow { src: string; dst: string; kind: string; file: string; line: number }

const STRUCTURAL_EDGE_KINDS = "('calls','imports','implements','extends')";

export function graphDiff(dbA: Database, dbB: Database): GraphDiff {
  const q = "SELECT id, kind, name, file, line, exported FROM nodes WHERE kind NOT IN ('file')";
  const nodesA = new Map((dbA.prepare(q).all() as NodeRow[]).map((n) => [n.id, n]));
  const nodesB = new Map((dbB.prepare(q).all() as NodeRow[]).map((n) => [n.id, n]));

  const rawAdded: NodeRow[] = [];
  const rawRemoved: NodeRow[] = [];
  for (const [id, n] of nodesB) if (!nodesA.has(id)) rawAdded.push(n);
  for (const [id, n] of nodesA) if (!nodesB.has(id)) rawRemoved.push(n);
  const visibilityChanged: GraphDiff["visibilityChanged"] = [];
  for (const [id, b] of nodesB) {
    const a = nodesA.get(id);
    if (a && a.exported !== b.exported) {
      visibilityChanged.push({ id, name: b.name, kind: b.kind, file: b.file, line: b.line, nowExported: b.exported === 1 });
    }
  }

  // 重命名匹配
  const renamed: RenameDelta[] = [];
  const usedAdded = new Set<string>();
  const usedRemoved = new Set<string>();
  for (const r of rawRemoved) {
    const candidate = rawAdded.find(
      (a) => !usedAdded.has(a.id) && a.file === r.file && a.kind === r.kind && Math.abs(a.line - r.line) <= 30,
    );
    if (candidate) {
      renamed.push({ from: r.name, to: candidate.name, file: r.file, kind: r.kind });
      usedAdded.add(candidate.id);
      usedRemoved.add(r.id);
    }
  }
  // 跨文件重命名（文件被改名/移动）：同名 + 同 kind + 行号邻近 → 视为文件级 rename,非增删
  // （独立评审 492bacf 案例：22 个纯文件改名被误报为 +67/-60 符号）
  for (const r of rawRemoved) {
    if (usedRemoved.has(r.id)) continue;
    const candidate = rawAdded.find(
      (a) => !usedAdded.has(a.id) && a.name === r.name && a.kind === r.kind && Math.abs(a.line - r.line) <= 5,
    );
    if (candidate) {
      renamed.push({ from: `${r.file}#${r.name}`, to: `${candidate.file}#${candidate.name}`, file: candidate.file, kind: r.kind });
      usedAdded.add(candidate.id);
      usedRemoved.add(r.id);
    }
  }

  const eq = `SELECT src, dst, kind, file, line FROM edges WHERE kind IN ${STRUCTURAL_EDGE_KINDS}`;
  const edgeKey = (e: EdgeRow) => `${e.src}\u0000${e.dst}\u0000${e.kind}`;
  const edgesA = new Map((dbA.prepare(eq).all() as EdgeRow[]).map((e) => [edgeKey(e), e]));
  const edgesB = new Map((dbB.prepare(eq).all() as EdgeRow[]).map((e) => [edgeKey(e), e]));

  const edgesAdded: EdgeDelta[] = [];
  const edgesRemoved: EdgeDelta[] = [];
  for (const [k, e] of edgesB) if (!edgesA.has(k)) edgesAdded.push(e);
  for (const [k, e] of edgesA) if (!edgesB.has(k)) edgesRemoved.push(e);

  return {
    nodesAdded: rawAdded.filter((n) => !usedAdded.has(n.id)),
    nodesRemoved: rawRemoved.filter((n) => !usedRemoved.has(n.id)),
    renamed,
    edgesAdded,
    edgesRemoved,
    visibilityChanged,
  };
}

/** 模块级聚合：Change Map 的画布数据。 */
export function foldToModules(diff: GraphDiff): Map<string, { added: number; removed: number; renamed: number; edgesIn: number; edgesOut: number }> {
  const TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$|__tests__\/|(^|\/)tests?\/|(^|\/)test_[^/]*\.py$|_test\.py$|conftest\.py$/;
  const moduleOf = (file: string): string => {
    if (TEST_RE.test(file)) return "tests";
    // monorepo：packages/<pkg>/... → <pkg>
    const wsMatch = file.match(/^(?:packages|apps|libs)\/([^/]+)\//);
    if (wsMatch) return wsMatch[1];
    const ix = file.indexOf("/");
    return ix < 0 ? "(root)" : file.slice(0, ix);
  };
  const out = new Map<string, { added: number; removed: number; renamed: number; edgesIn: number; edgesOut: number }>();
  const bump = (m: string, key: "added" | "removed" | "renamed" | "edgesIn" | "edgesOut") => {
    const v = out.get(m) ?? { added: 0, removed: 0, renamed: 0, edgesIn: 0, edgesOut: 0 };
    v[key]++;
    out.set(m, v);
  };
  for (const n of diff.nodesAdded) bump(moduleOf(n.file), "added");
  for (const n of diff.nodesRemoved) bump(moduleOf(n.file), "removed");
  for (const r of diff.renamed) bump(moduleOf(r.file), "renamed");
  for (const e of diff.edgesAdded) bump(moduleOf(e.file), "edgesIn");
  for (const e of diff.edgesRemoved) bump(moduleOf(e.file), "edgesOut");
  return out;
}
