#!/usr/bin/env node
import fs from "node:fs";

const file = process.argv[2] ?? "eval/pilot-2026-09-24.json";
const d = JSON.parse(fs.readFileSync(file, "utf8"));
const impact = d.impact;
if (!impact) process.exit(1);
const stable = Array.isArray(impact.warnings) && impact.warnings.every((x) => typeof x === "string") &&
  [impact.review_first, impact.test_files].every((x) => Number.isInteger(x) && x >= 0);
if (!stable) process.exit(1);
console.log(JSON.stringify({ stable: true, sample: file, review_first: impact.review_first, test_files: impact.test_files, warnings: impact.warnings.length }));
