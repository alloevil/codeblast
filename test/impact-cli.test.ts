/**
 * impact CLI 的进程级契约：--json 是机器消费者的入口,输出必须完整且可解析。
 *
 * 回归背景：`console.log(...); process.exit(0)` 在管道上会截断 —— stdout 是异步的,
 * exit 丢掉还在缓冲区里的部分,Linux 管道上恰好停在 65536 字节。tRPC 上
 * `impact packages/server/src/index.ts` 的输出是 140KB,消费者拿到的是坏 JSON;
 * eval/mutation_check.py 就死在这里。这里用一个足够大的图在真实子进程上验。
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { transaction } from "../src/db";
import { openGraph } from "../src/schema";

// dist/bin.js if built (fast); otherwise run the TS entry through this same runtime.
const DIST = path.join(import.meta.dirname, "..", "dist", "bin.js");
const CLI = fs.existsSync(DIST) ? DIST : path.join(import.meta.dirname, "..", "src", "bin.ts");

/** 一个 target 被 n 个调用者依赖的图；n 大到 JSON 输出超过 64KB 管道缓冲。 */
function bigGraph(dbPath: string, callers: number): void {
  const db = openGraph(dbPath);
  const insNode = db.prepare(
    "INSERT OR REPLACE INTO nodes (id, kind, name, file, line, end_line, exported, signature, src_file) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insEdge = db.prepare(
    "INSERT OR REPLACE INTO edges (src, dst, kind, file, line, confidence, src_file) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  // 一次事务：逐条 autocommit 在 600 行上要 7 秒(每条一次 fsync)
  transaction(db, () => {
    insNode.run("src/target.ts#target", "function", "target", "src/target.ts", 1, 9, 1, "", "src/target.ts");
    for (let i = 0; i < callers; i++) {
      // 长路径：每项在 JSON 里约 250 字节,600 项 ≈ 150KB
      const file = `packages/some-workspace-package-${i}/src/deeply/nested/module/consumer-${i}.ts`;
      const id = `${file}#consumerFunctionWithALongName${i}`;
      insNode.run(id, "function", `consumerFunctionWithALongName${i}`, file, i + 1, i + 20, 1, "", file);
      insEdge.run(id, "src/target.ts#target", "calls", file, i + 1, "exact", file);
    }
  })();
  db.close();
}

describe("impact --json (subprocess)", () => {
  test("a 100KB+ result reaches a piped consumer as complete, parseable JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeblast-cli-"));
    const dbPath = path.join(dir, "graph.db");
    try {
      bigGraph(dbPath, 600);
      const p = spawnSync(process.execPath, [CLI, "impact", dbPath, "src/target.ts#target", "--json", "--max", "100000"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      expect(p.status).toBe(0);
      expect(p.stdout.length).toBeGreaterThan(100_000);
      const parsed = JSON.parse(p.stdout) as { target: string; items: unknown[] };
      expect(parsed.target).toBe("src/target.ts#target");
      expect(parsed.items).toHaveLength(600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("human output folds import-channel items by default and lists them under --all", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeblast-cli-"));
    const dbPath = path.join(dir, "graph.db");
    try {
      const db = openGraph(dbPath);
      const insNode = db.prepare(
        "INSERT OR REPLACE INTO nodes (id, kind, name, file, line, end_line, exported, signature, src_file) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const insEdge = db.prepare(
        "INSERT OR REPLACE INTO edges (src, dst, kind, file, line, confidence, src_file) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      insNode.run("src/target.ts#target", "function", "target", "src/target.ts", 1, 9, 1, "", "src/target.ts");
      // call 通道的直接调用者
      insNode.run("src/caller.ts#caller", "function", "caller", "src/caller.ts", 1, 9, 1, "", "src/caller.ts");
      insEdge.run("src/caller.ts#caller", "src/target.ts#target", "calls", "src/caller.ts", 3, "exact", "src/caller.ts");
      // import 通道：文件级边,非测试 → 默认折叠
      insNode.run("src/importer.ts", "file", "importer.ts", "src/importer.ts", 1, 1, 0, "", "src/importer.ts");
      insEdge.run("src/importer.ts", "src/target.ts", "imports", "src/importer.ts", 1, "conservative", "src/importer.ts");
      insNode.run("src/target.ts", "file", "target.ts", "src/target.ts", 1, 1, 0, "", "src/target.ts");
      insEdge.run("src/target.ts", "src/target.ts#target", "contains", "src/target.ts", 1, "exact", "src/target.ts");
      db.close();

      const run = (extra: string[]) =>
        spawnSync(process.execPath, [CLI, "impact", dbPath, "src/target.ts#target", ...extra], { encoding: "utf8" }).stdout;

      const def = run([]);
      expect(def).toContain("src/caller.ts#caller"); // call 通道始终列出
      expect(def).not.toContain("[direct ~ ·import] src/importer.ts");
      expect(def).toMatch(/conservative items across 1 files reachable only via imports/);
      expect(def).toContain("--all to list them");

      const all = run(["--all"]);
      expect(all).toContain("src/importer.ts");
      expect(all).not.toContain("--all to list them");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
