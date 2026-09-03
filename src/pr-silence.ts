/**
 * PR bot 静默判定（呈现层纪律：宁静默不刷屏）。纯函数,无 git/DB 依赖,便于测试。
 * 从 pr-comment.ts 原样搬出;阈值与判定顺序与原实现一致。两道门在 pr-comment.ts：
 *   1. structuralTotal(diff) === 0 && bodyChanged.length === 0 → 静默
 *   2. coreNamedCount(...) + bodySignalCount(...) === 0        → 静默
 */
import type { GraphDiff, NodeDelta } from "./graph-diff";

export const TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$|__tests__\/|(^|\/)tests?\//;
/** 辅助区：0 影响改动一律零信息（终验 3 条 noise 全在 www/）;scripts/ 含构建入口(e39a654)不降权。 */
export const AUX_RE = /^(www|docs|examples)\//;
/** 核心区函数体改动只在大 diff（≥ 该行数,导航价值）时有信号。 */
export const BIG_DIFF_LINES = 40;

export interface BodyChange { id: string; name: string; kind: string; file: string; line: number }

export function structuralTotal(diff: GraphDiff): number {
  return diff.nodesAdded.length + diff.nodesRemoved.length + diff.renamed.length + diff.edgesAdded.length
    + diff.edgesRemoved.length + diff.visibilityChanged.length + diff.signatureChanged.length;
}

/**
 * 函数体改动信号数：有调用链影响 → 永远有信号;否则核心区且大 diff 才有信号。
 * 独立评审 e870051/e472df1：0 影响 0 测试的孤立脚本改动 diff 一眼可见,不值一条评论;
 * 但大 diff 里定位"唯一的行为变更"本身有价值（e39a654）。
 */
export function bodySignalCount(
  bodyChanged: readonly BodyChange[],
  diffLineCount: number,
  hasCallImpact: (fn: BodyChange) => boolean,
): number {
  let n = 0;
  for (const fn of bodyChanged) {
    if (hasCallImpact(fn)) n++;
    else if (!AUX_RE.test(fn.file) && diffLineCount >= BIG_DIFF_LINES) n++;
  }
  return n;
}

/** 具名结构变化按核心区计数——辅助区新组件/依赖边（4217a73: www 106 行）无评审价值。 */
export function coreNamedCount(diff: GraphDiff, prodNodesAdded: readonly NodeDelta[]): number {
  return diff.edgesAdded.filter((e) => !AUX_RE.test(e.file)).length
    + prodNodesAdded.filter((n) => !AUX_RE.test(n.file)).length
    + diff.renamed.filter((r) => !AUX_RE.test(r.file)).length
    + diff.visibilityChanged.filter((v) => !AUX_RE.test(v.file)).length
    + diff.signatureChanged.filter((s) => !AUX_RE.test(s.file)).length;
}
