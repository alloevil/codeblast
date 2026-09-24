#!/usr/bin/env node
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node eval/validate-safety.mjs result.json");
  process.exit(2);
}
const d = JSON.parse(fs.readFileSync(file, "utf8"));
const fail = (message) => { console.error(`invalid safety result: ${message}`); process.exit(1); };
if (d.schema_version !== "1") fail("unsupported schema_version");
if (typeof d.engine_version !== "string" || !d.engine_version) fail("missing engine_version");
if (!new Set(["safe-to-review", "targeted-review", "review"]).has(d.decision)) fail("invalid decision");
if (!new Set(["low", "medium", "high"]).has(d.risk)) fail("invalid risk");
if (!Array.isArray(d.reasons) || !Array.isArray(d.recommended_actions)) fail("invalid decision arrays");
if (!d.graph_health || !d.graph_health.base || !d.graph_health.head || !Array.isArray(d.graph_health.warnings)) fail("invalid graph_health");
for (const side of [d.graph_health.base, d.graph_health.head]) {
  for (const key of ["files", "nodes", "edges", "blind_spots"]) if (!Number.isInteger(side[key]) || side[key] < 0) fail(`invalid graph_health.${key}`);
}
if (!Number.isInteger(d.affected_test_files) || d.affected_test_files < 0) fail("invalid affected_test_files");
if (!Number.isInteger(d.blind_spot_count) || d.blind_spot_count < 0) fail("invalid blind_spot_count");
console.log("safety result valid");
