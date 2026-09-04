#!/usr/bin/env node
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
 *
 * 运行时：node ≥ 22.13（node:sqlite）或 bun ≥ 1.0（bun:sqlite）。同一份源码，两种运行时。
 * 子命令模块以顶层脚本形式读取 process.argv——这里先把 argv 整理成子命令视角再动态 import。
 */

const ROUTES: Record<string, () => Promise<unknown>> = {
  index: () => import("./cli"),
  impact: () => import("./impact-cli"),
  change: () => import("./change-cli"),
  archmap: () => import("./archmap-html"),
  mermaid: () => import("./archmap"),
  cochange: () => import("./cochange"),
  "pr-comment": () => import("./pr-comment"),
  demo: () => import("./demo"),
  "name-modules": () => import("./name-modules"),
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

// 子命令脚本按 process.argv.slice(2) 取参：去掉子命令名，让它们看到自己的参数。
process.argv.splice(2, 1);
await ROUTES[cmd]();

export {};
