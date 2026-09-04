import fs from "node:fs";

/**
 * M3 — overlay：架构图的用户修正层（intent.md：稳定坐标系 + 留存钩子）。
 *
 * 文件格式（codeblast.overlay.json，放目标仓根或随 --overlay 指定，进 git）：
 * {
 *   "modules": {
 *     "<目录名>": { "name": "人话名", "hidden": false, "mergeInto": null }
 *   }
 * }
 * - name:      显示名（LLM 初稿写入此处,用户可改——改了就是用户的）
 * - hidden:    true 则不出现在图上（如生成代码目录）
 * - mergeInto: 归并到另一模块（如 "srvcfg" 并入 "(root)"）
 *
 * 读取优先级：用户 overlay > LLM 初稿 > 目录名。
 */
export interface ModuleOverlay {
  name?: string;
  hidden?: boolean;
  mergeInto?: string | null;
}

export interface Overlay {
  modules: Record<string, ModuleOverlay>;
}

export async function loadOverlay(path: string): Promise<Overlay> {
  if (!fs.existsSync(path)) return { modules: {} };
  return JSON.parse(fs.readFileSync(path, "utf8")) as Overlay;
}

/** 应用 overlay：返回 目录名 → { display, effective }。effective 是归并后的模块 key。 */
export function applyOverlay(rawModules: string[], overlay: Overlay): Map<string, { display: string; effective: string; hidden: boolean }> {
  const out = new Map<string, { display: string; effective: string; hidden: boolean }>();
  for (const m of rawModules) {
    const o = overlay.modules[m] ?? {};
    let effective = m;
    // 归并链（最多 5 层防环）
    for (let i = 0; i < 5; i++) {
      const next = overlay.modules[effective]?.mergeInto;
      if (!next || next === effective) break;
      effective = next;
    }
    const display = overlay.modules[effective]?.name ?? effective;
    out.set(m, { display, effective, hidden: o.hidden ?? overlay.modules[effective]?.hidden ?? false });
  }
  return out;
}
