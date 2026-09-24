import fs from "node:fs";
import { openDatabase, type Database } from "./db";
import { selfCommand, spawnSync } from "./proc";
import { graphDiff, type GraphDiff } from "./graph-diff";
import { impact } from "./impact";
import { reviewDecision } from "./pr-decision";
import { AUX_RE, TEST_RE, bodySignalCount, coreNamedCount, structuralTotal, type BodyChange } from "./pr-silence";

const [repo, baseSha, headSha] = process.argv.slice(2);
if (!repo || !baseSha || !headSha) {
  console.error("usage: codeblast check-change <repo> <base-sha> <head-sha> --json");
  process.exit(1);
}

function buildGraphAt(ref: string, db: string): void {
  const wt = `/tmp/codeblast-check-${ref.replace(/[^\w]/g, "_")}`;
  spawnSync(["git", "worktree", "remove", "--force", wt], { cwd: repo });
  const add = spawnSync(["git", "worktree", "add", "--detach", wt, ref], { cwd: repo });
  if (add.exitCode !== 0) throw new Error(add.stderr.slice(0, 300));
  try {
    const built = spawnSync(selfCommand("index", wt, "--db", db));
    if (built.exitCode !== 0) throw new Error(built.stderr.slice(0, 500));
  } finally {
    spawnSync(["git", "worktree", "remove", "--force", wt], { cwd: repo });
  }
}

const dbAPath = "/tmp/codeblast-check-base.db";
const dbBPath = "/tmp/codeblast-check-head.db";
for (const f of [dbAPath, dbBPath]) for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(f + suffix, { force: true });
buildGraphAt(baseSha, dbAPath);
buildGraphAt(headSha, dbBPath);
const dbA = openDatabase(dbAPath, { readonly: true });
const dbB = openDatabase(dbBPath, { readonly: true });
const graphHealth = (db: Database) => ({
  files: Number((db.prepare("SELECT COUNT(*) c FROM files").get() as { c: number }).c),
  nodes: Number((db.prepare("SELECT COUNT(*) c FROM nodes").get() as { c: number }).c),
  edges: Number((db.prepare("SELECT COUNT(*) c FROM edges").get() as { c: number }).c),
  blind_spots: Number((db.prepare("SELECT COUNT(*) c FROM blind_spots").get() as { c: number }).c),
});
const healthBase = graphHealth(dbA);
const healthHead = graphHealth(dbB);
const diff: GraphDiff = graphDiff(dbA, dbB);
const healthWarnings = [
  ...(healthHead.files === 0 || healthHead.nodes === 0 ? ["graph_empty"] : []),
  ...(healthHead.nodes < healthBase.nodes / 2 ? ["graph_node_count_dropped_sharply"] : []),
];
const prodNodesAdded = diff.nodesAdded.filter((n) => !TEST_RE.test(n.file));
const bodyChanged: BodyChange[] = [];
const total = structuralTotal(diff);
let affectedTests = 0;
let truncated = false;
let blindSpots = 0;
for (const node of [...diff.nodesAdded, ...diff.renamed.map((r) => ({ id: `${r.file}#${r.to}`, kind: r.kind, name: r.to, file: r.file, line: 0 }))].slice(0, 15)) {
  try {
    const result = impact(dbB, node.id, 2000);
    affectedTests += new Set(result.items.filter((item) => item.level === "tests").map((item) => item.file)).size;
    truncated ||= result.truncated;
    blindSpots += result.blind_spot_count;
  } catch { /* module-level rename has no node to query */ }
}
const diffLineCount = spawnSync(["git", "diff", "--numstat", baseSha, headSha], { cwd: repo }).stdout.split("\n").reduce((sum, line) => {
  const match = line.match(/^(\d+)\t(\d+)\t/);
  return sum + (match ? Number(match[1]) + Number(match[2]) : 0);
}, 0);
const decision = reviewDecision({ diff, prodNodesAdded, bodyChanged, affectedTests, truncated, blindSpotCount: blindSpots });
if (healthWarnings.length > 0) {
  decision.risk = "high";
  decision.reasons.push(...healthWarnings);
  decision.recommendedActions.unshift("Rebuild or inspect the graph before relying on this decision.");
}
const output = {
  range: `${baseSha}..${headSha}`,
  decision: decision.risk === "high" ? "review" : decision.risk === "medium" ? "targeted-review" : "safe-to-review",
  risk: decision.risk,
  summary: decision.summary,
  reasons: decision.reasons,
  recommended_actions: decision.recommendedActions,
  structural_changes: total,
  affected_test_files: affectedTests,
  blind_spot_count: blindSpots,
  graph_health: { base: healthBase, head: healthHead, warnings: healthWarnings },
  truncated,
  signals: {
    core_named: coreNamedCount(diff, prodNodesAdded),
    body: bodySignalCount(bodyChanged, diffLineCount, () => false),
    aux_only: total > 0 && coreNamedCount(diff, prodNodesAdded) === 0 && bodyChanged.length === 0,
  },
  diff,
};
console.log(JSON.stringify(output));
dbA.close();
dbB.close();
