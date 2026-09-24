#!/usr/bin/env node
import fs from "node:fs";

const file = process.argv[2] ?? "eval/pilot-2026-09-24.json";
const d = JSON.parse(fs.readFileSync(file, "utf8"));
const index = d.index;
const impact = d.impact;
if (!index || !impact || index.failures !== 0) process.exit(1);
console.log(JSON.stringify({
  repository: d.repository,
  package: d.package,
  graph: { files: index.files_indexed, nodes: index.nodes, edges: index.edges, blind_spots: index.blind_spots, failures: index.failures },
  impact: { items: impact.items, target_blind_spots: impact.target_blind_spots, review_first: impact.review_first, test_files: impact.test_files, warnings: impact.warnings },
  interpretation: d.interpretation,
}));
