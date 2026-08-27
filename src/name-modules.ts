/**
 * M3 — LLM 模块命名：生成 overlay 初稿。
 *
 * 纪律（intent.md）：LLM 只做翻译（起名/一句话职责），不决定节点归属。
 * 输入证据 = 每模块的文件清单 + 导出符号样本（确定性来自图谱）。
 * 输出写 codeblast.overlay.json 的 name 字段；已存在的用户 overlay 不覆盖。
 *
 * 用法: bun run src/name-modules.ts <graph.db> --overlay <path> [--model <cmd>]
 * LLM 调用通过环境命令（默认试 `omp -p` 风格不可用则跳过）：
 * 这里用最朴素的可插拔方式——stdin 进 prompt，stdout 出 JSON。
 */
import { Database } from "bun:sqlite";
import { loadOverlay, type Overlay } from "./overlay";

const [dbPath] = process.argv.slice(2);
const overlayFlag = process.argv.indexOf("--overlay");
const overlayPath = overlayFlag >= 0 ? process.argv[overlayFlag + 1] : "codeblast.overlay.json";
if (!dbPath) {
  console.error("usage: bun run src/name-modules.ts <graph.db> --overlay codeblast.overlay.json");
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$|__tests__\/|(^|\/)tests?\/|(^|\/)test_[^/]*\.py$|_test\.py$|conftest\.py$/;

// 每模块的证据包：文件名 + 导出符号（最多各 15 个）
const files = db.prepare("SELECT file FROM nodes WHERE kind='file'").all() as { file: string }[];
const byModule = new Map<string, string[]>();
for (const { file } of files) {
  const m = TEST_RE.test(file) ? "tests" : file.includes("/") ? file.slice(0, file.indexOf("/")) : "(root)";
  const list = byModule.get(m) ?? [];
  list.push(file);
  byModule.set(m, list);
}
const symStmt = db.prepare(
  "SELECT DISTINCT name FROM nodes WHERE exported=1 AND kind IN ('function','class','method') AND file LIKE ? LIMIT 15",
);

const evidence: Record<string, { files: string[]; exports: string[] }> = {};
for (const [mod, fs] of byModule) {
  const prefix = mod === "(root)" ? "" : mod + "/";
  const exports = mod === "(root)"
    ? []
    : (symStmt.all(prefix + "%") as { name: string }[]).map((r) => r.name);
  evidence[mod] = { files: fs.slice(0, 15).map((f) => f.replace(prefix, "")), exports };
}

const prompt = `你是代码架构分析器。基于每个模块的文件清单和导出符号，给出中文人话名（≤8字）和一句话职责（≤25字）。
只输出 JSON，格式：{"<模块目录名>": {"name": "<人话名>", "desc": "<职责>"}}
不要编造证据里看不到的功能。证据：
${JSON.stringify(evidence, null, 1)}`;

// LLM 调用：环境里有 OMP_COMPLETION_CMD 则用之；否则输出 prompt 供上游管道处理
const cmd = process.env.LLM_CMD;
if (!cmd) {
  // 无 LLM 环境：stdout 输出 prompt，由调用方（agent/CI）完成推理后用 --apply 写回
  const applyFlag = process.argv.indexOf("--apply");
  if (applyFlag >= 0) {
    const namesJson = JSON.parse(await Bun.file(process.argv[applyFlag + 1]).text()) as Record<string, { name: string; desc: string }>;
    const overlay: Overlay = await loadOverlay(overlayPath);
    for (const [mod, v] of Object.entries(namesJson)) {
      const existing = overlay.modules[mod];
      if (existing?.name) continue; // 用户已命名，不覆盖
      overlay.modules[mod] = { ...existing, name: `${v.name}`, ...(v.desc ? {} : {}) };
      (overlay.modules[mod] as Record<string, unknown>).desc = v.desc;
    }
    await Bun.write(overlayPath, JSON.stringify(overlay, null, 2));
    console.error(`overlay written: ${overlayPath}`);
  } else {
    console.log(prompt);
  }
} else {
  const proc = Bun.spawnSync(["sh", "-c", cmd], { stdin: Buffer.from(prompt) });
  const raw = proc.stdout.toString().trim();
  const jsonStart = raw.indexOf("{");
  const namesJson = JSON.parse(raw.slice(jsonStart)) as Record<string, { name: string; desc: string }>;
  const overlay: Overlay = await loadOverlay(overlayPath);
  for (const [mod, v] of Object.entries(namesJson)) {
    if (overlay.modules[mod]?.name) continue;
    overlay.modules[mod] = { ...overlay.modules[mod], name: v.name };
    (overlay.modules[mod] as Record<string, unknown>).desc = v.desc;
  }
  await Bun.write(overlayPath, JSON.stringify(overlay, null, 2));
  console.error(`overlay written: ${overlayPath}`);
}
