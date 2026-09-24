#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeblast-agent-smoke-"));
try {
  const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, { ...options, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout;
  };
  run("git", ["init", "-q"], { cwd: root });
  run("git", ["config", "user.email", "smoke@example.com"], { cwd: root });
  run("git", ["config", "user.name", "codeblast smoke"], { cwd: root });
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022" }, include: ["src"] }));
  fs.writeFileSync(path.join(root, "src/api.ts"), "export function api(x: string) { return x; }\n");
  run("git", ["add", "."], { cwd: root });
  run("git", ["commit", "-qm", "base"], { cwd: root });
  fs.writeFileSync(path.join(root, "src/api.ts"), "export function api(x: string, y = 1) { return x + y; }\n");
  run("git", ["add", "."], { cwd: root });
  run("git", ["commit", "-qm", "change"], { cwd: root });
  const bin = process.env.CODEBLAST_BIN ?? path.join(process.cwd(), "dist", "bin.js");
  const result = JSON.parse(run(process.execPath, [bin, "check-change", root, "HEAD~1", "HEAD", "--json"], { cwd: process.cwd() }));
  if (result.schema_version !== "1" || !result.graph_health || !Array.isArray(result.recommended_actions)) throw new Error("safety contract mismatch");
  process.stdout.write(JSON.stringify({ ok: true, schema_version: result.schema_version, decision: result.decision, risk: result.risk }) + "\n");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
