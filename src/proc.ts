/**
 * 子进程与自调用：node:child_process 在 bun / node 下行为一致，替代 Bun.spawnSync。
 */
import { spawnSync as nodeSpawnSync } from "node:child_process";

export interface SpawnResult { exitCode: number; stdout: string; stderr: string }

export function spawnSync(
  cmd: string[],
  opts: { cwd?: string; input?: string; maxBuffer?: number } = {},
): SpawnResult {
  const p = nodeSpawnSync(cmd[0], cmd.slice(1), {
    cwd: opts.cwd,
    input: opts.input,
    maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
    encoding: "utf8",
  });
  if (p.error) return { exitCode: 127, stdout: p.stdout ?? "", stderr: p.error.message };
  return { exitCode: p.status ?? 1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

/** 透传 stdio 运行，用于 demo 之外无需捕获输出的场景。 */
export function spawnInherit(cmd: string[], cwd?: string): number {
  const p = nodeSpawnSync(cmd[0], cmd.slice(1), { cwd, stdio: "inherit" });
  return p.status ?? 1;
}

/**
 * 以同一运行时、同一入口再启动一个 codeblast 子命令：
 * `bun src/bin.ts index …` 或 `node dist/bin.js index …` 都成立。
 * 子命令（change / pr-comment / demo）需要独立进程建图——tsc Program 内存隔离，且复用 index 的全部逻辑。
 */
export function selfCommand(cmd: string, ...args: string[]): string[] {
  return [process.execPath, process.argv[1], cmd, ...args];
}
