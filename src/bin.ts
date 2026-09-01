#!/usr/bin/env bun
/**
 * 统一 CLI 入口：codeblast <command> [args]
 *
 *   codeblast index <repo> [--db graph.db]
 *   codeblast impact <graph.db> <symbol> [--json]
 *   codeblast change <repo> <ref-a> <ref-b> [--json]
 *   codeblast archmap <graph.db> --out arch.html [--impact <sym>] [--diff <base.db>]
 *   codeblast cochange <repo> <graph.db>
 *   codeblast pr-comment <repo> <base-sha> <head-sha>
 *   codeblast demo [repo]
 */
import path from "node:path";

const ROUTES: Record<string, string> = {
  index: "cli.ts",
  impact: "impact-cli.ts",
  change: "change-cli.ts",
  archmap: "archmap-html.ts",
  mermaid: "archmap.ts",
  cochange: "cochange.ts",
  "pr-comment": "pr-comment.ts",
  demo: "demo.ts",
  "name-modules": "name-modules.ts",
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === "--help" || cmd === "-h" || !ROUTES[cmd]) {
  console.log(`codeblast — deterministic code graph: architecture, change & impact maps

usage: codeblast <command> [args]

  index     <repo> [--db graph.db]              build/update the graph (incremental)
  impact    <graph.db> <symbol> [--json]        blast radius of a change
  change    <repo> <ref-a> <ref-b> [--json]     structural diff between two refs
  archmap   <graph.db> --out arch.html          interactive architecture map
            [--impact <sym>] [--diff <base.db>]   ...with impact / change overlay
  mermaid   <graph.db>                          module map as mermaid
  cochange  <repo> <graph.db>                   mine git history coupling
  pr-comment <repo> <base-sha> <head-sha>       PR review comment (silent if no change)
  demo      [repo]                              build + query + map in one shot

docs: https://github.com/alloevil/codeblast · demos: https://alloevil.github.io/codeblast/`);
  process.exit(cmd && !ROUTES[cmd] ? 1 : 0);
}

const target = path.join(import.meta.dir, ROUTES[cmd]);
const proc = Bun.spawnSync(["bun", "run", target, ...rest], { stdio: ["inherit", "inherit", "inherit"] });
process.exit(proc.exitCode ?? 0);
