import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const run = (cwd, command, args) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};
const commit = (repo, message) => {
  run(repo, "git", ["add", "."]);
  run(repo, "git", ["commit", "-qm", message]);
  return run(repo, "git", ["rev-parse", "HEAD"]);
};

export function createFixture(root, id) {
  const repo = path.join(root, id);
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "test"), { recursive: true });
  run(repo, "git", ["init", "-q"]);
  run(repo, "git", ["config", "user.email", "replay@example.com"]);
  run(repo, "git", ["config", "user.name", "offline replay"]);
  fs.writeFileSync(path.join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true }, include: ["src", "test"] }));
  fs.writeFileSync(path.join(repo, "src/api.ts"), "export function kept(x: string) { return x; }\nexport function removed() { return 1; }\n");
  fs.writeFileSync(path.join(repo, "src/tool.ts"), "export function valid(name: string) { return /^[A-Za-z0-9_-]{1,64}$/.test(name); }\n");
  fs.writeFileSync(path.join(repo, "test/tool.test.ts"), 'import { valid } from "../src/tool"; export function testValid() { return valid("x"); }\n');
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n");
  const base = commit(repo, "base");
  if (id === "tested-behavior-change") {
    fs.writeFileSync(path.join(repo, "src/tool.ts"), "export function valid(name: string) { return /^[A-Za-z0-9_-]{1,128}$/.test(name); }\n");
    fs.writeFileSync(path.join(repo, "test/tool.test.ts"), 'import { valid } from "../src/tool"; export function testValid() { return valid("x".repeat(128)); }\n');
  } else if (id === "public-api-removal") {
    fs.writeFileSync(path.join(repo, "src/api.ts"), "export function kept(x: string) { return x; }\n");
  } else if (id === "docs-only") {
    fs.writeFileSync(path.join(repo, "README.md"), "# fixture\nupdated docs\n");
  } else throw new Error(`unknown fixture: ${id}`);
  const head = commit(repo, "change");
  return { repo, base, head };
}
