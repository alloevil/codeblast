#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeblast-release-smoke-"));
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { ...options, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
};
try {
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", root], { cwd: process.cwd() });
  const tarball = fs.readdirSync(root).find((name) => name.startsWith("codeblast-") && name.endsWith(".tgz"));
  if (!tarball) throw new Error("npm pack produced no tarball");
  const consumer = path.join(root, "consumer");
  fs.mkdirSync(consumer);
  run("npm", ["init", "-y"], { cwd: consumer, stdio: "ignore" });
  run("npm", ["install", "--ignore-scripts", path.join(root, tarball)], { cwd: consumer, stdio: "ignore" });
  const help = run(process.execPath, [path.join(consumer, "node_modules", "codeblast", "dist", "bin.js"), "--help"], { cwd: consumer });
  if (!help.includes("check-change")) throw new Error("published executable missing check-change");
  console.log("local release smoke passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
