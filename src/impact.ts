/**
 * M1 — Impact 投影：从任意节点做反向可达性遍历，三级分级。
 *
 * 分级（intent.md）：
 * - direct:   直接调用者 / 直接依赖者（1 跳）
 * - indirect: 传递可达的调用者（2+ 跳）
 * - tests:    覆盖受影响节点的测试
 *
 * 精度纪律：
 * - 反向遍历 calls/implements/extends/imports 边；保守边(conservative)一并走，
 *   结果项带 confidence，由呈现层决定折叠。宁误报不漏报。
 * - 影响集超阈值 → truncated=true，呈现层显示"广泛影响，建议全量测试"。
 */
import { Database } from "bun:sqlite";

export interface ImpactItem {
  id: string;
  name: string;
  kind: string;
  file: string;
  line: number;
  level: "direct" | "indirect" | "tests";
  hops: number;
  /** 该路径上最弱的置信度：exact > conservative */
  confidence: "exact" | "conservative";
  /** 到达此节点的证据边：调用发生处 */
  via_file: string;
  via_line: number;
}

export interface ImpactResult {
  target: string;
  items: ImpactItem[];
  truncated: boolean;
  blind_spot_count: number; // 目标文件的盲区数量：诚实提示
}

const IMPACT_EDGE_KINDS = ["calls", "implements", "extends", "imports", "contains"] as const;
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$|__tests__\/|(^|\/)tests?\/|(^|\/)test_[^/]*\.py$|_test\.py$|conftest\.py$/;

export function impact(db: Database, targetId: string, maxNodes = 500): ImpactResult {
  const targetRow = db.prepare("SELECT id, file FROM nodes WHERE id = ?").get(targetId) as
    | { id: string; file: string }
    | null;
  if (!targetRow) throw new Error(`node not found: ${targetId}`);

  // 反向邻接：谁指向我。一次性查代替 N 次查询（大仓性能）。
  const incoming = db.prepare(
    `SELECT src, dst, kind, confidence, file, line FROM edges
     WHERE kind IN (${IMPACT_EDGE_KINDS.map(() => "?").join(",")})`,
  ).all(...IMPACT_EDGE_KINDS) as {
    src: string; dst: string; kind: string;
    confidence: "exact" | "conservative" | "blind";
    file: string; line: number;
  }[];
  const byDst = new Map<string, typeof incoming>();
  for (const e of incoming) {
    const list = byDst.get(e.dst) ?? [];
    list.push(e);
    byDst.set(e.dst, list);
  }

  // BFS
  const visited = new Map<string, { hops: number; confidence: "exact" | "conservative"; via_file: string; via_line: number }>();
  let frontier = [targetId];
  visited.set(targetId, { hops: 0, confidence: "exact", via_file: targetRow.file, via_line: 0 });
  let truncated = false;

  while (frontier.length > 0 && !truncated) {
    const next: string[] = [];
    for (const cur of frontier) {
      const curInfo = visited.get(cur)!;
      for (const e of byDst.get(cur) ?? []) {
        if (visited.has(e.src)) continue;
        const conf = e.confidence === "conservative" || curInfo.confidence === "conservative" ? "conservative" : "exact";
        visited.set(e.src, { hops: curInfo.hops + 1, confidence: conf, via_file: e.file, via_line: e.line });
        next.push(e.src);
        if (visited.size > maxNodes) { truncated = true; break; }
      }
      if (truncated) break;
    }
    frontier = next;
  }
  visited.delete(targetId);

  // 节点元数据 + 分级
  const getNode = db.prepare("SELECT id, name, kind, file, line FROM nodes WHERE id = ?");
  const testEdges = db.prepare("SELECT DISTINCT src FROM edges WHERE kind = 'tests' AND dst = ?");
  const items: ImpactItem[] = [];
  const affectedTests = new Set<string>();

  for (const [id, info] of visited) {
    const n = getNode.get(id) as { id: string; name: string; kind: string; file: string; line: number } | null;
    if (!n) continue; // 悬空边目标（保守全连生成的 id 可能无节点）：跳过但不计入漏报——它本身就是保守猜测
    if (n.kind === "file" && n.file === targetRow.file) continue; // 目标自身所在文件：对 callsite 清单是噪音
    const level = n.kind === "test" || TEST_FILE_RE.test(n.file) ? "tests" : info.hops === 1 ? "direct" : "indirect";
    if (level === "tests") affectedTests.add(id);
    items.push({
      id: n.id, name: n.name, kind: n.kind, file: n.file, line: n.line,
      level, hops: info.hops, confidence: info.confidence,
      via_file: info.via_file, via_line: info.via_line,
    });
  }

  // 受影响节点的 tests 边补充（不在调用可达集内的测试覆盖）
  for (const it of items) {
    if (it.level === "tests") continue;
    for (const t of testEdges.all(it.id) as { src: string }[]) {
      if (visited.has(t.src) || affectedTests.has(t.src)) continue;
      const n = getNode.get(t.src) as { id: string; name: string; kind: string; file: string; line: number } | null;
      if (!n) continue;
      affectedTests.add(t.src);
      items.push({
        id: n.id, name: n.name, kind: n.kind, file: n.file, line: n.line,
        level: "tests", hops: it.hops + 1, confidence: it.confidence,
        via_file: n.file, via_line: n.line,
      });
    }
  }
  // 目标自身的直接测试覆盖
  for (const t of testEdges.all(targetId) as { src: string }[]) {
    if (affectedTests.has(t.src) || visited.has(t.src)) continue;
    const n = getNode.get(t.src) as { id: string; name: string; kind: string; file: string; line: number } | null;
    if (!n) continue;
    items.push({
      id: n.id, name: n.name, kind: n.kind, file: n.file, line: n.line,
      level: "tests", hops: 1, confidence: "exact", via_file: n.file, via_line: n.line,
    });
  }
  // 盲区可达测试：含子进程/非字面量动态 import 的测试文件，静态边接不上但可能执行任意仓内代码
  // → 保守纳入每个影响集（confidence=conservative）。宁误报不漏报。
  const blindReachTests = db.prepare(
    `SELECT DISTINCT file FROM blind_spots
     WHERE (reason LIKE 'subprocess spawn%' OR reason LIKE 'dynamic import%')`,
  ).all() as { file: string }[];
  const includedFiles = new Set(items.filter((it) => it.level === "tests").map((it) => it.file));
  for (const { file } of blindReachTests) {
    if (!TEST_FILE_RE.test(file) || includedFiles.has(file)) continue;
    const bs = db.prepare(
      "SELECT line, reason FROM blind_spots WHERE file = ? AND (reason LIKE 'subprocess spawn%' OR reason LIKE 'dynamic import%') LIMIT 1",
    ).get(file) as { line: number; reason: string };
    includedFiles.add(file);
    items.push({
      id: file, name: `${file} (${bs.reason})`, kind: "file", file, line: bs.line,
      level: "tests", hops: 99, confidence: "conservative", via_file: file, via_line: bs.line,
    });
  }

  const blindCount = (db.prepare(
    "SELECT COUNT(*) c FROM blind_spots WHERE file = ? AND reason NOT LIKE 'test-global%'",
  ).get(targetRow.file) as { c: number }).c;

  items.sort((a, b) => a.hops - b.hops || a.id.localeCompare(b.id));
  return { target: targetId, items, truncated, blind_spot_count: blindCount };
}
