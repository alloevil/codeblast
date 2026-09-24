#!/usr/bin/env node
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node eval/validate-feedback.mjs receipt.json");
  process.exit(2);
}
const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
const kinds = new Set(["false-positive", "missed-impact", "noise", "incorrect-silence", "incorrect-recommendation"]);
const outcomes = new Set(["correct", "needed-correction", "insufficient-information"]);
if (receipt.schema_version !== "1" || !kinds.has(receipt.kind) || !outcomes.has(receipt.outcome) || receipt.public_evidence !== true) {
  console.error("invalid feedback receipt: schema_version, kind, outcome, and public_evidence are required");
  process.exit(1);
}
if (receipt.notes !== undefined && (typeof receipt.notes !== "string" || receipt.notes.length > 2000)) {
  console.error("invalid feedback receipt: notes must be at most 2000 characters");
  process.exit(1);
}
console.log("feedback receipt valid");
