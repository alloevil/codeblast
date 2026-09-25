#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createFixture } from "./offline-replay-fixtures.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeblast-offline-replay-"));
const manifest = JSON.parse(fs.readFileSync(new URL("./offline-replay-manifest.json", import.meta.url), "utf8"));
const bin = path.join(process.cwd(), "dist", "bin.js");
const results = [];
const run = (args, cwd) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
try {
  for (const sample of manifest.samples) {
    const fixture = createFixture(root, sample.id);
    const safetyRun = run(["check-change", fixture.repo, fixture.base, fixture.head, "--json"], process.cwd());
    if (![0, 1].includes(safetyRun.status)) throw new Error(`${sample.id}: safety failed: ${safetyRun.stderr}`);
    const safety = JSON.parse(safetyRun.stdout);
    const commentRun = run(["pr-comment", fixture.repo, fixture.base, fixture.head, "--repo-url", "https://example.invalid/replay"], process.cwd());
    if (commentRun.status !== 0) throw new Error(`${sample.id}: comment failed: ${commentRun.stderr}`);
    const emitted = commentRun.stdout.trim().length > 0;
    const fileSet = new Set(runGit(fixture.repo, ["diff", "--name-only", fixture.base, fixture.head]).split("\n").filter(Boolean));
    const evidenceValid = sample.oracle.evidence_file ? fileSet.has(sample.oracle.evidence_file) && commentRun.stdout.includes(sample.oracle.evidence_file) : true;
    const passed = safety.decision === sample.oracle.decision && emitted === (sample.oracle.comment === "emit") && evidenceValid;
    results.push({ id: sample.id, decision: safety.decision, comment_emitted: emitted, evidence_valid: evidenceValid, passed });
  }
  const scorecard = {
    schema_version: "1",
    samples: results.length,
    passed: results.filter((x) => x.passed).length,
    failed: results.filter((x) => !x.passed).length,
    incorrect_silence: results.filter((x) => !x.comment_emitted && x.id !== "docs-only").length,
    invalid_evidence: results.filter((x) => !x.evidence_valid).length,
    results,
  };
  process.stdout.write(JSON.stringify(scorecard) + "\n");
  if (scorecard.failed > 0) process.exitCode = 1;
  if (process.env.CODEBLAST_REPLAY_OUT) {
    fs.writeFileSync(process.env.CODEBLAST_REPLAY_OUT, JSON.stringify(scorecard, null, 2) + "\n");
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
