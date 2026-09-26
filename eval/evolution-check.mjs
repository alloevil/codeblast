#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const claimsRoot = process.env.VERIFY_CLAIMS_ROOT ?? path.resolve(process.cwd(), "../verify-claims");
const replayPath = path.join(process.env.RUNNER_TEMP ?? "/tmp", "codeblast-evolution-replay.json");
const incrementalPath = path.join(process.env.RUNNER_TEMP ?? "/tmp", "codeblast-evolution-incremental.json");
const run = (name, command, args, extraEnv = {}) => {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd: process.cwd(), env: { ...process.env, PYTHONPATH: [claimsRoot, process.env.PYTHONPATH].filter(Boolean).join(":"), ...extraEnv }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { name, ok: result.status === 0, exit: result.status ?? 2, ms: Date.now() - started, output: output.trim().slice(-2000) };
};
const checks = [
  run("build", "bun", ["run", "build"]),
  run("tests", "bun", ["test"]),
  run("typecheck", "bun", ["run", "typecheck"]),
  run("offline-replay", "bun", ["run", "offline-replay"], { CODEBLAST_REPLAY_OUT: replayPath }),
  run("incremental-equivalence", "bun", ["run", "incremental-equivalence"], { CODEBLAST_INCREMENTAL_OUT: incrementalPath }),
  run("claims", "python3", ["-m", "verify_claims", "--root", ".", "run"]),
];
const readOptional = (file) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
const scorecard = {
  schema_version: "1",
  passed: checks.every((check) => check.ok),
  checks: Object.fromEntries(checks.map((check) => [check.name, { ok: check.ok, exit: check.exit, ms: check.ms }])),
  evidence: { offline_replay: readOptional(replayPath), incremental_equivalence: readOptional(incrementalPath) },
  failures: checks.filter((check) => !check.ok).map((check) => ({ name: check.name, output: check.output })),
};
const output = JSON.stringify(scorecard, null, 2);
console.log(output);
if (process.env.CODEBLAST_EVOLUTION_OUT) fs.writeFileSync(process.env.CODEBLAST_EVOLUTION_OUT, output + "\n");
if (process.env.CODEBLAST_EVOLUTION_SCORECARD) {
  const source = JSON.parse(fs.readFileSync(process.env.CODEBLAST_EVOLUTION_SCORECARD, "utf8"));
  source.evolution_check = scorecard;
  fs.writeFileSync(process.env.CODEBLAST_EVOLUTION_SCORECARD, JSON.stringify(source, null, 2) + "\n");
}
if (!scorecard.passed) process.exitCode = 1;
