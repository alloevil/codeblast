#!/usr/bin/env node
import fs from "node:fs";

const file = process.argv[2] ?? "eval/compatibility-sample-2026-09-25.json";
const d = JSON.parse(fs.readFileSync(file, "utf8"));
const fail = (message) => { console.error(`invalid compatibility sample: ${message}`); process.exit(1); };
if (typeof d.as_of !== "string" || typeof d.tool_version !== "string" || typeof d.repository !== "string") fail("missing identity");
if (!d.graph_health || d.graph_health.failures !== 0) fail("graph failures must be zero");
for (const key of ["files", "nodes", "edges", "blind_spots"]) if (!Number.isInteger(d.graph_health[key]) || d.graph_health[key] < 0) fail(`invalid graph_health.${key}`);
if (!d.impact || !Number.isInteger(d.impact.items) || !Number.isInteger(d.impact.review_first) || !Number.isInteger(d.impact.test_files)) fail("invalid impact summary");
if (!Array.isArray(d.impact.warnings)) fail("invalid warnings");
console.log("compatibility sample valid");
