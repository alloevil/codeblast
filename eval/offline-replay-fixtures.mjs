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
  const result = spawnSync("git", ["commit", "-qm", message, "--allow-empty"], { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git commit: ${result.stderr}`);
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
  fs.mkdirSync(path.join(repo, "examples"), { recursive: true });
  fs.writeFileSync(path.join(repo, "examples/demo.ts"), "export const demo = 1;\n");
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n");
  if (id === "graph-node-drop") {
    fs.writeFileSync(path.join(repo, "src/many.ts"), Array.from({ length: 12 }, (_, i) => `export function f${i}() { return ${i}; }`).join("\n") + "\n");
  }
  const base = commit(repo, "base");
  if (id === "tested-behavior-change" || id === "tested-behavior-repeat") {
    fs.writeFileSync(path.join(repo, "src/tool.ts"), "export function valid(name: string) { return /^[A-Za-z0-9_-]{1,128}$/.test(name); }\n");
    fs.writeFileSync(path.join(repo, "test/tool.test.ts"), 'import { valid } from "../src/tool"; export function testValid() { return valid("x".repeat(128)); }\n');
  } else if (id === "public-api-removal") {
    fs.writeFileSync(path.join(repo, "src/api.ts"), "export function kept(x: string) { return x; }\n");
  } else if (id === "docs-only") {
    fs.writeFileSync(path.join(repo, "README.md"), "# fixture\nupdated docs\n");
  } else if (id === "signature-widening") {
    fs.writeFileSync(path.join(repo, "src/api.ts"), "export function kept(x: string, limit?: number) { return x.slice(0, limit); }\nexport function removed() { return 1; }\n");
  } else if (id === "visibility-contraction") {
    fs.writeFileSync(path.join(repo, "src/api.ts"), "function kept(x: string) { return x; }\nexport function removed() { return 1; }\n");
  } else if (id === "pure-rename") {
    fs.writeFileSync(path.join(repo, "src/api.ts"), "export function renamed(x: string) { return x; }\nexport function removed() { return 1; }\n");
  } else if (id === "test-only") {
    fs.writeFileSync(path.join(repo, "test/tool.test.ts"), 'import { valid } from "../src/tool"; export function testValid() { return valid("updated"); }\n');
  } else if (id === "aux-only") {
    fs.writeFileSync(path.join(repo, "examples/demo.ts"), "export const demo = 2;\n");
  } else if (id === "blind-spot-target") {
    fs.writeFileSync(path.join(repo, "src/tool.ts"), "export function valid(name: string, handlers: Record<string, () => boolean>) { return handlers[name](); }\n");
    fs.writeFileSync(path.join(repo, "test/tool.test.ts"), 'import { valid } from "../src/tool"; export function testValid() { return valid("x", { x: () => true }); }\n');
  } else if (id === "graph-node-drop") {
    fs.rmSync(path.join(repo, "src/many.ts"));
    fs.writeFileSync(path.join(repo, "src/api.ts"), "export function kept(x: string) { return x; }\n");
  } else if (id === "graph-empty") {
    fs.rmSync(path.join(repo, "src"), { recursive: true });
    fs.rmSync(path.join(repo, "test"), { recursive: true });
    fs.rmSync(path.join(repo, "examples"), { recursive: true });
    fs.writeFileSync(path.join(repo, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", strict: true }, include: ["missing"] }));
  } else throw new Error(`unknown fixture: ${id}`);
  const head = commit(repo, "change");
  return { repo, base, head };
}
