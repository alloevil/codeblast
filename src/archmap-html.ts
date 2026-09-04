/**
 * M3 — 交互式架构图：单文件 HTML（自包含，无外部依赖运行时）。
 *
 * 三层下钻（C4 风格）：模块 → 文件 → 符号。
 * - 模块层：目录折叠 + import 聚合边（M3-v0 同规则）
 * - 文件层：点模块展开其文件与文件间依赖
 * - 符号层：点文件列出函数/类,每项带 file:line
 * - 循环依赖高亮；盲区计数展示
 * 数据内嵌 JSON;渲染用内嵌 SVG（无 CDN 依赖,离线可用）。
 *
 * 用法: codeblast archmap <graph.db> --out arch.html
 */
import fs from "node:fs";
import { openDatabase } from "./db";
import { loadOverlay, applyOverlay } from "./overlay";
import dagre from "@dagrejs/dagre";
import { impact } from "./impact";
import { graphDiff } from "./graph-diff";
// 前端脚本独立成文件,构建期内联(DATA 声明仍由本文件输出)
const CLIENT_JS = fs.readFileSync(new URL("./archmap-client.js", import.meta.url), "utf8");
if (CLIENT_JS.includes("</script>")) throw new Error("archmap-client.js must not contain </script>");

const [dbPath] = process.argv.slice(2);
const outFlag = process.argv.indexOf("--out");
const outPath = outFlag >= 0 ? process.argv[outFlag + 1] : "arch.html";
const overlayFlag = process.argv.indexOf("--overlay");
const overlayPath = overlayFlag >= 0 ? process.argv[overlayFlag + 1] : undefined;
const repoFlag = process.argv.indexOf("--repo-url");
const repoUrl = repoFlag >= 0 ? process.argv[repoFlag + 1] : undefined; // e.g. https://github.com/o/r/blob/main
const impactFlag = process.argv.indexOf("--impact");
const impactTarget = impactFlag >= 0 ? process.argv[impactFlag + 1] : undefined;
const diffFlag = process.argv.indexOf("--diff");
const diffBase = diffFlag >= 0 ? process.argv[diffFlag + 1] : undefined; // base graph.db 路径
if (!dbPath) {
  console.error("usage: codeblast archmap <graph.db> --out arch.html");
  process.exit(1);
}

const db = openDatabase(dbPath, { readonly: true });
const overlay = overlayPath ? await loadOverlay(overlayPath) : { modules: {} };
const TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$|__tests__\/|(^|\/)tests?\/|(^|\/)test_[^/]*\.py$|_test\.py$|conftest\.py$/;
const moduleOf = (file: string): string => {
  if (TEST_RE.test(file)) return "tests";
  const ix = file.indexOf("/");
  return ix < 0 ? "(root)" : file.slice(0, ix);
};

// ---- 数据装配 ----
interface FileInfo { path: string; module: string; blind: { dyn: number; unres: number }; symbols: { name: string; kind: string; line: number }[] }

const files = db.prepare("SELECT file FROM nodes WHERE kind = 'file'").all() as { file: string }[];
const blindRows = db.prepare(
  `SELECT file,
     SUM(CASE WHEN reason LIKE 'unresolved call%' THEN 0 ELSE 1 END) dyn,
     SUM(CASE WHEN reason LIKE 'unresolved call%' THEN 1 ELSE 0 END) unres
   FROM blind_spots WHERE reason NOT LIKE 'test-global%' GROUP BY file`,
).all() as { file: string; dyn: number; unres: number }[];
const blindMap = new Map(blindRows.map((b) => [b.file, { dyn: b.dyn, unres: b.unres }]));
const symRows = db.prepare(
  "SELECT file, name, kind, line FROM nodes WHERE kind NOT IN ('file','module') ORDER BY file, line",
).all() as { file: string; name: string; kind: string; line: number }[];
const symsByFile = new Map<string, { name: string; kind: string; line: number }[]>();
for (const s of symRows) {
  const list = symsByFile.get(s.file) ?? [];
  list.push({ name: s.name, kind: s.kind, line: s.line });
  symsByFile.set(s.file, list);
}

let fileInfos: FileInfo[] = files.map((f) => ({
  path: f.file,
  module: moduleOf(f.file),
  blind: blindMap.get(f.file) ?? { dyn: 0, unres: 0 },
  symbols: symsByFile.get(f.file) ?? [],
}));

const importRows = db.prepare("SELECT src, dst, line FROM edges WHERE kind = 'imports'").all() as
  { src: string; dst: string; line: number }[];

// 模块聚合
const rawModuleNames = [...new Set(fileInfos.map((f) => f.module))];
const ovMap = applyOverlay(rawModuleNames, overlay);
const effModule = (m: string): string => ovMap.get(m)?.effective ?? m;
for (const fi of fileInfos) fi.module = effModule(fi.module);
const hiddenModules = new Set([...ovMap.values()].filter((v) => v.hidden).map((v) => v.effective));
fileInfos = fileInfos.filter((f) => !hiddenModules.has(f.module));
const modules = new Map<string, { files: number; blind: { dyn: number; unres: number } }>();
for (const fi of fileInfos) {
  const m = modules.get(fi.module) ?? { files: 0, blind: { dyn: 0, unres: 0 } };
  m.files++;
  m.blind.dyn += fi.blind.dyn;
  m.blind.unres += fi.blind.unres;
  modules.set(fi.module, m);
}
const modEdges = new Map<string, number>();
for (const e of importRows) {
  const ms = moduleOf(e.src);
  const md = moduleOf(e.dst);
  if (ms !== md) modEdges.set(`${ms}→${md}`, (modEdges.get(`${ms}→${md}`) ?? 0) + 1);
}
// 循环检测（模块级，两两互指即环）
const cycles = new Set<string>();
for (const key of modEdges.keys()) {
  const [a, b] = key.split("→");
  if (modEdges.has(`${b}→${a}`)) {
    cycles.add(key);
    cycles.add(`${b}→${a}`);
  }
}

// ---- dagre 布局预计算（构建期跑,坐标嵌入;前端零布局依赖）
// 注: 首选 elkjs,但其 GWT worker 在 bun 下模块导出为空,弃用;dagre 纯 JS 分层布局等效。

interface LaidNode { id: string; x: number; y: number; w: number; h: number }
interface LaidEdge { src: string; dst: string; points: { x: number; y: number }[] }
interface Layout { nodes: LaidNode[]; edges: LaidEdge[]; width: number; height: number }

async function layoutGraph(
  nodes: { id: string; label: string; meta?: string }[],
  edges: { src: string; dst: string }[],
): Promise<Layout> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 36, ranksep: 70, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) {
    // 宽度同时容纳标题(13.5px 粗体 ~8.5px/字符)与 meta 行(11px mono ~6.8px/字符)
    g.setNode(n.id, { width: Math.max(150, n.label.length * 8.5 + 56, (n.meta ?? "").length * 6.8 + 40), height: 58 });
  }
  for (const e of edges) {
    if (e.src !== e.dst) g.setEdge(e.src, e.dst);
  }
  dagre.layout(g);
  const gd = g.graph();
  return {
    width: gd.width ?? 900,
    height: gd.height ?? 600,
    nodes: g.nodes().map((id) => {
      const n = g.node(id);
      return { id, x: n.x - n.width / 2, y: n.y - n.height / 2, w: n.width, h: n.height };
    }),
    edges: edges.filter((e) => e.src !== e.dst).map((e) => ({
      src: e.src, dst: e.dst,
      points: g.edge(e.src, e.dst)?.points ?? [],
    })),
  };
}

const layouts: Record<string, Layout> = {};
// 模块层
layouts["__modules__"] = await layoutGraph(
  [...modules.keys()].map((m) => {
    const o = overlay.modules[m] as { name?: string } | undefined;
    const b = modules.get(m)!.blind;
    const metaParts = [`${modules.get(m)!.files} files`];
    if (b.dyn > 0) metaParts.push(`${b.dyn} dyn`);
    if (b.unres > 0) metaParts.push(`${b.unres} unres`);
    return { id: m, label: o?.name ?? m, meta: metaParts.join(" · ") };
  }),
  [...modEdges.keys()].map((key) => {
    const [src, dst] = key.split("→");
    return { src, dst };
  }),
);
// 各模块的文件层（文件数 ≤ 80 才预计算,超大模块回退网格）
for (const [mod] of modules) {
  const fs = fileInfos.filter((f) => f.module === mod);
  if (fs.length === 0 || fs.length > 80) continue;
  const inSet = new Set(fs.map((f) => f.path));
  const agg = new Map<string, { src: string; dst: string }>();
  for (const e of importRows) {
    if (inSet.has(e.src) && inSet.has(e.dst) && e.src !== e.dst) {
      agg.set(`${e.src}→${e.dst}`, { src: e.src, dst: e.dst });
    }
  }
  layouts[mod] = await layoutGraph(
    fs.map((f) => ({
      id: f.path,
      label: f.path.split("/").pop() ?? f.path,
      meta: `${f.symbols.length} symbols`,
    })),
    [...agg.values()],
  );
}
// Impact overlay: --impact <symbol> 时计算影响集,按文件/模块聚合供着色
interface ImpactOverlay {
  target: string;
  targetFile: string;
  fileLevels: Record<string, "direct" | "indirect" | "tests">;
  moduleCounts: Record<string, { direct: number; indirect: number; tests: number }>;
}
let impactOverlay: ImpactOverlay | null = null;
// Change overlay: --diff <base.db> 时对比两图,文件级变更着色
interface DiffOverlay {
  fileStates: Record<string, "added" | "removed" | "changed">;
  moduleCounts: Record<string, { added: number; removed: number; changed: number; renamed: number }>;
  summary: string;
}
let diffOverlay: DiffOverlay | null = null;
if (diffBase) {
  const dbBase = openDatabase(diffBase, { readonly: true });
  const d = graphDiff(dbBase, db);
  const fileStates: DiffOverlay["fileStates"] = {};
  const moduleCounts: DiffOverlay["moduleCounts"] = {};
  const bump = (file: string, key: "added" | "removed" | "changed" | "renamed") => {
    const m = moduleOf(file);
    const mc = moduleCounts[m] ?? { added: 0, removed: 0, changed: 0, renamed: 0 };
    mc[key]++;
    moduleCounts[m] = mc;
  };
  for (const n of d.nodesAdded) { fileStates[n.file] ??= "added"; bump(n.file, "added"); }
  for (const n of d.nodesRemoved) { fileStates[n.file] = fileStates[n.file] === "added" ? "changed" : (fileStates[n.file] ?? "removed"); bump(n.file, "removed"); }
  for (const r of d.renamed) { fileStates[r.file] = "changed"; bump(r.file, "renamed"); }
  for (const s of d.signatureChanged) { fileStates[s.file] = "changed"; bump(s.file, "changed"); }
  for (const v of d.visibilityChanged) { fileStates[v.file] = "changed"; bump(v.file, "changed"); }
  const total = d.nodesAdded.length + d.nodesRemoved.length + d.renamed.length + d.signatureChanged.length + d.visibilityChanged.length;
  diffOverlay = { fileStates, moduleCounts, summary: `符号 +${d.nodesAdded.length} −${d.nodesRemoved.length} ↻${d.renamed.length} · 签名/可见性 ${d.signatureChanged.length + d.visibilityChanged.length} · 共 ${total} 项` };
  dbBase.close();
}
if (impactTarget) {
  let targetId = impactTarget;
  const exact = db.prepare("SELECT id, file FROM nodes WHERE id = ?").get(impactTarget) as { id: string; file: string } | null;
  let targetFile = exact?.file ?? "";
  if (!exact) {
    const cands = db.prepare("SELECT id, file FROM nodes WHERE name = ? AND kind != 'file' LIMIT 2").all(impactTarget) as { id: string; file: string }[];
    if (cands.length !== 1) {
      console.error(`--impact: ${cands.length === 0 ? "no match" : "ambiguous"}: ${impactTarget}`);
      process.exit(1);
    }
    targetId = cands[0].id;
    targetFile = cands[0].file;
  }
  const r = impact(db, targetId, 100000);
  const fileLevels: ImpactOverlay["fileLevels"] = {};
  const moduleCounts: ImpactOverlay["moduleCounts"] = {};
  const RANK: Record<string, number> = { direct: 3, tests: 2, indirect: 1 };
  for (const it of r.items) {
    const prev = fileLevels[it.file];
    if (!prev || RANK[it.level] > RANK[prev]) fileLevels[it.file] = it.level;
    const m = moduleOf(it.file);
    const mc = moduleCounts[m] ?? { direct: 0, indirect: 0, tests: 0 };
    mc[it.level]++;
    moduleCounts[m] = mc;
  }
  impactOverlay = { target: targetId, targetFile, fileLevels, moduleCounts };
}

const data = {
  generated: new Date().toISOString().slice(0, 16).replace("T", " "),
  layouts,
  impact: impactOverlay,
  diff: diffOverlay,
  repoUrl: repoUrl ?? null,
  modules: [...modules.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.files - a.files),
  moduleMeta: Object.fromEntries(
    [...modules.keys()].map((m) => {
      const o = overlay.modules[m] as { name?: string; desc?: string } | undefined;
      return [m, { display: o?.name ?? m, desc: o?.desc ?? "" }];
    }),
  ),
  modEdges: [...modEdges.entries()].map(([key, w]) => {
    const [src, dst] = key.split("→");
    return { src, dst, w, cyclic: cycles.has(key) };
  }),
  files: fileInfos,
  fileEdges: importRows,
};

// ---- HTML（内嵌数据 + 原生 SVG 力导布局的简化版：分层圆环布局，零依赖） ----
const html = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>codeblast · Architecture Map</title>
<style>
  :root { --bg:#0d1117; --panel:#161b22; --border:#30363d; --fg:#e6edf3; --dim:#8b949e;
          --accent:#58a6ff; --warn:#f85149; --ok:#3fb950; }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, "Segoe UI", sans-serif; display: flex; height: 100vh; }
  #graph { background:
    radial-gradient(ellipse 80% 60% at 50% -10%, #1f6feb14, transparent),
    radial-gradient(#30363d55 1px, transparent 1px);
    background-size: auto, 26px 26px; }
  #graph { flex: 1; position: relative; overflow: hidden; }
  svg { width: 100%; height: 100%; cursor: grab; }
  #side { width: 380px; border-left: 1px solid var(--border); background: var(--panel); overflow-y: auto; padding: 16px; }
  h1 { font-size: 15px; padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--panel); }
  h1 small { color: var(--dim); font-weight: normal; margin-left: 8px; }
  .node rect { fill: url(#nodeFill); stroke: var(--c, var(--accent)); stroke-width: 1.4; rx: 10;
    cursor: pointer; filter: drop-shadow(0 2px 6px #010409aa); transition: filter .15s; }
  .node:hover rect { filter: drop-shadow(0 0 8px var(--c, var(--accent))) drop-shadow(0 2px 6px #010409aa); }
  .node .accentbar { fill: var(--c, var(--accent)); rx: 2; pointer-events: none; }
  .node.test { --c: var(--ok); }
  .node.cyc { --c: var(--warn); }
  .node.imp-direct { --c: #f85149; } .node.imp-direct rect { stroke-width: 2.2; }
  .node.imp-tests { --c: #d29922; }
  .node.imp-indirect { --c: #8957e5; }
  .node.imp-target rect { stroke: #f85149; stroke-width: 3; filter: drop-shadow(0 0 12px #f8514988); }
  .node.chg-added { --c: var(--ok); } .node.chg-added rect { stroke-width: 2.2; }
  .node.chg-removed { --c: #6e40c9; opacity: 0.65; }
  .node.chg-changed { --c: #d29922; } .node.chg-changed rect { stroke-width: 2.2; }
  #impactbar { padding: 8px 16px; background: #f8514915; border-bottom: 1px solid #f8514944;
    font-size: 13px; display: flex; gap: 18px; align-items: center; }
  #impactbar .sw { display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; }
  .node text { fill: var(--fg); font-size: 13.5px; font-weight: 600; pointer-events: none; }
  .node .meta { fill: var(--dim); font-size: 11px; font-weight: 400; font-family: ui-monospace, Menlo, monospace; }
  .edge { stroke: #58a6ff55; fill: none; marker-end: url(#arrow); }
  .edge.mid { stroke-width: 1.8; stroke: #58a6ff77; }
  .edge.heavy { stroke-width: 2.6; stroke: #58a6ffaa; }
  .edge.cyclic { stroke: var(--warn); stroke-dasharray: 5 3; stroke-width: 2;
    animation: cycflow 1.2s linear infinite; }
  @keyframes cycflow { to { stroke-dashoffset: -16; } }
  .edge.hi { stroke: #d29922 !important; stroke-width: 2.6; stroke-opacity: 1; }
  .edge.dim { stroke-opacity: 0.1; }
  .edge.faint { stroke-opacity: 0.06; }
  .node.dimn { opacity: 0.3; }
  #graph { position: relative; }
  #toolbar { position: absolute; top: 12px; right: 12px; }
  #toolbar button { background: var(--panel); color: var(--fg); border: 1px solid var(--border);
    border-radius: 8px; padding: 6px 14px; cursor: pointer; font-size: 13px; }
  #toolbar button:hover { border-color: var(--accent); }
  #toolbar button.on { border-color: var(--accent); background: #1f6feb33; }
  body.editing .node rect { cursor: text; }
  body.editing .node.sel rect { stroke: #d29922; stroke-width: 3; }
  .node.hidden-mod { opacity: 0.35; }
  .node.hidden-mod rect { stroke-dasharray: 4 3; }
  #editpanel { border-top: 1px solid var(--border); padding: 12px 0; margin-top: 12px; }
  #editpanel input { width: 100%; background: #0d1117; color: var(--fg); border: 1px solid var(--border);
    border-radius: 6px; padding: 6px 8px; font-size: 13px; margin: 4px 0 8px; }
  #editpanel .row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  #editpanel button { flex: 1; background: var(--panel); color: var(--fg); border: 1px solid var(--border);
    border-radius: 6px; padding: 6px 8px; cursor: pointer; font-size: 12.5px; }
  #editpanel button:hover { border-color: var(--accent); }
  #editpanel button.primary { background: #1f6feb33; border-color: var(--accent); }
  #editpanel pre { background: #0d1117; border: 1px solid var(--border); border-radius: 6px;
    padding: 8px; font-size: 11px; max-height: 180px; overflow: auto; white-space: pre-wrap; }
  #editpanel .tip { color: var(--dim); font-size: 12px; }
  .edge-label { fill: var(--dim); font-size: 10px; }
  .crumb { color: var(--accent); cursor: pointer; }
  #side h2 { font-size: 14px; margin: 8px 0; }
  #side .item { padding: 6px 8px; border-radius: 6px; cursor: pointer; display: flex; justify-content: space-between; }
  #side .item:hover { background: #21262d; }
  #side .kind { color: var(--dim); font-size: 12px; }
  #side .blind { color: var(--warn); font-size: 12px; }
  .hint { color: var(--dim); font-size: 12px; margin-top: 12px; }
  .cyclic-banner { background: #f8514922; border: 1px solid var(--warn); border-radius: 6px; padding: 8px 10px; margin-bottom: 10px; font-size: 13px; }
</style>
</head>
<body>
<div style="display:flex;flex-direction:column;flex:1">
  <h1 id="title">Architecture Map <small id="crumbs"></small></h1>
  ${data.impact ? `<div id="impactbar"><strong>Impact: ${data.impact.target.split("#").pop()}</strong>
    <span><span class="sw" style="background:#f85149"></span>直接影响</span>
    <span><span class="sw" style="background:#d29922"></span>受影响测试</span>
    <span><span class="sw" style="background:#8957e5"></span>传递影响</span>
    <span style="color:var(--dim)">未着色 = 不受影响</span></div>` : ""}
  ${data.diff ? `<div id="impactbar" style="background:#3fb95012;border-color:#3fb95044"><strong>Change Map</strong>
    <span>${data.diff.summary}</span>
    <span><span class="sw" style="background:#3fb950"></span>新增</span>
    <span><span class="sw" style="background:#d29922"></span>修改</span>
    <span><span class="sw" style="background:#6e40c9"></span>删除</span></div>` : ""}
  <div id="graph"><svg id="svg"><defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#58a6ff88"/></marker>
    <linearGradient id="nodeFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1c2430"/><stop offset="1" stop-color="#151b23"/>
    </linearGradient>
  </defs><g id="viewport"></g></svg>
  <div id="toolbar"><button id="editbtn" onclick="toggleEdit()">✎ 编辑模块</button> <button onclick="toggleFit()">适配 / 100%</button> <button onclick="exportPNG()">导出 PNG</button></div></div>
</div>
<div id="side"><h2>概览</h2><div id="detail"></div>
  <p class="hint">点击模块下钻到文件层;点击文件查看符号。红色虚线 = 循环依赖。滚轮缩放,拖拽平移。</p>
</div>
<script>
const DATA = ${JSON.stringify(data)};
${CLIENT_JS}</script>
</body>
</html>`;

fs.writeFileSync(outPath, html);
console.error(`written: ${outPath} (${(html.length / 1024).toFixed(0)}KB)`);
