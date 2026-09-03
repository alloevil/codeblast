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
 * 用法: bun run src/archmap-html.ts <graph.db> --out arch.html
 */
import { Database } from "bun:sqlite";
import { loadOverlay, applyOverlay } from "./overlay";
import dagre from "@dagrejs/dagre";
import { impact } from "./impact";
import { graphDiff } from "./graph-diff";

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
  console.error("usage: bun run src/archmap-html.ts <graph.db> --out arch.html");
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
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
  const dbBase = new Database(diffBase, { readonly: true });
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
function blindLabel(b) {
  if (!b || (!b.dyn && !b.unres)) return "";
  const parts = [];
  if (b.dyn) parts.push(b.dyn + " dyn");
  if (b.unres) parts.push(b.unres + " unres");
  return " · " + parts.join(" · ");
}
const DATA = ${JSON.stringify(data)};
const svg = document.getElementById("svg"), vp = document.getElementById("viewport");
const detail = document.getElementById("detail"), crumbs = document.getElementById("crumbs");
let view = { scope: "modules", module: null };

// --- 简单布局：按度数排序的网格+分层 ---
function layout(nodes, edges) {
  const W = svg.clientWidth || 900, H = svg.clientHeight || 600;
  const inDeg = {}; edges.forEach(e => inDeg[e.dst] = (inDeg[e.dst]||0)+e.w);
  const outDeg = {}; edges.forEach(e => outDeg[e.src] = (outDeg[e.src]||0)+e.w);
  // 层级 = 依赖深度近似:被依赖多的沉底
  nodes.forEach(n => { n.score = (inDeg[n.id]||0) - (outDeg[n.id]||0); });
  const sorted = [...nodes].sort((a,b) => a.score - b.score);
  const layers = Math.max(2, Math.min(5, Math.ceil(Math.sqrt(nodes.length))));
  const perLayer = Math.ceil(nodes.length / layers);
  sorted.forEach((n, i) => {
    const layer = Math.floor(i / perLayer), pos = i % perLayer;
    const count = Math.min(perLayer, nodes.length - layer*perLayer);
    n.x = (W / (count+1)) * (pos+1);
    n.y = 80 + (H-160) * (layer / Math.max(1, layers-1));
  });
  return nodes;
}

function esc(s) { return s.replace(/&/g,"&amp;").replace(/</g,"&lt;"); }

function impactClass(id, isModule) {
  if (DATA.diff) {
    if (isModule) {
      const mc = DATA.diff.moduleCounts[id];
      if (!mc) return "";
      if (mc.added > mc.changed && mc.added >= mc.removed) return " chg-added";
      if (mc.removed > mc.added && mc.removed > mc.changed) return " chg-removed";
      return " chg-changed";
    }
    const st = DATA.diff.fileStates[id];
    return st ? " chg-" + st : "";
  }
  if (!DATA.impact) return "";
  if (isModule) {
    const mc = DATA.impact.moduleCounts[id];
    if (!mc) return "";
    if (mc.direct > 0) return " imp-direct";
    if (mc.tests > 0) return " imp-tests";
    return " imp-indirect";
  }
  if (id === DATA.impact.targetFile) return " imp-target";
  const lv = DATA.impact.fileLevels[id];
  return lv ? " imp-" + lv : "";
}
function buildView() {
  if (view.scope === "modules") {
    return {
      key: "__modules__",
      nodes: DATA.modules.filter(m => !edits.merges[m.name] && (editing || !edits.hidden[m.name])).map(m => ({
        id: m.name,
        label: displayName(m.name),
        meta: m.files + " files" + blindLabel(m.blind),
        test: m.name === "tests",
        cyc: DATA.modEdges.some(e => e.cyclic && (e.src === m.name || e.dst === m.name)),
      })),
      edges: DATA.modEdges
        .map(e => ({ src: edits.merges[e.src] ?? e.src, dst: edits.merges[e.dst] ?? e.dst, w: e.w, cyclic: e.cyclic }))
        .filter(e => e.src !== e.dst),
      crumb: "模块层 · " + DATA.modules.length + " modules",
    };
  }
  const fs = DATA.files.filter(f => f.module === view.module);
  const inSet = new Set(fs.map(f => f.path));
  const agg = {};
  DATA.fileEdges.forEach(e => {
    if (inSet.has(e.src) && inSet.has(e.dst) && e.src !== e.dst) { const k = e.src+"→"+e.dst; agg[k] = (agg[k]||0)+1; }
  });
  return {
    key: view.module,
    nodes: fs.map(f => ({ id: f.path, label: f.path.split("/").pop(), meta: f.symbols.length + " symbols" + blindLabel(f.blind), test: false })),
    edges: Object.entries(agg).map(([k,w]) => { const [src,dst] = k.split("→"); return { src, dst, w, cyclic: false }; }),
    crumb: '<span class="crumb" onclick="goHome()">模块层</span> › ' + esc(view.module) + " · " + fs.length + " files",
  };
}

function gridFallback(nodes) {
  const cols = Math.ceil(Math.sqrt(nodes.length));
  const out = {};
  nodes.forEach((n, i) => {
    out[n.id] = { x: 40 + (i % cols) * 240, y: 40 + Math.floor(i / cols) * 100, w: 210, h: 58 };
  });
  return out;
}

function render() {
  const v = buildView();
  crumbs.innerHTML = v.crumb;
  const laid = DATA.layouts[v.key];
  const fallback = !laid;
  const pos = {};
  const laidEdges = {};
  if (laid) {
    laid.nodes.forEach(n => pos[n.id] = n);
    laid.edges.forEach(e => { laidEdges[e.src + "→" + e.dst] = e.points; });
  } else {
    Object.assign(pos, gridFallback(v.nodes));
  }
  const cx = id => pos[id] ? pos[id].x + pos[id].w / 2 : 0;
  const cy = id => pos[id] ? pos[id].y + pos[id].h / 2 : 0;
  // 端点裁剪:让边精确落在矩形边界而非停在节点内部/中心
  function clipToRect(p, target, box) {
    const cx0 = box.x + box.w / 2, cy0 = box.y + box.h / 2;
    const dx = target.x - cx0, dy = target.y - cy0;
    if (!dx && !dy) return { x: cx0, y: cy0 };
    const sx = (box.w / 2 + 4) / Math.abs(dx || 1e-9), sy = (box.h / 2 + 4) / Math.abs(dy || 1e-9);
    const t = Math.min(sx, sy);
    return { x: cx0 + dx * t, y: cy0 + dy * t };
  }

  let g = "";
  v.edges.forEach(e => {
    if (!pos[e.src] || !pos[e.dst]) return;
    const pts = laidEdges[e.src + "→" + e.dst];
    let d;
    if (pts && pts.length >= 2) {
      const p2 = pts.slice();
      p2[0] = clipToRect(p2[0], p2[1], pos[e.src]);
      p2[p2.length - 1] = clipToRect(p2[p2.length - 1], p2[p2.length - 2], pos[e.dst]);
      // 平滑折线:Catmull-Rom 风格的二次样条串
      d = "M" + p2[0].x + "," + p2[0].y;
      for (let i = 1; i < p2.length - 1; i++) {
        const mx = (p2[i].x + p2[i + 1].x) / 2, my = (p2[i].y + p2[i + 1].y) / 2;
        d += " Q" + p2[i].x + "," + p2[i].y + " " + mx + "," + my;
      }
      d += " L" + p2[p2.length - 1].x + "," + p2[p2.length - 1].y;
    } else {
      const mx = (cx(e.src) + cx(e.dst)) / 2, my = (cy(e.src) + cy(e.dst)) / 2 - 20;
      d = "M" + cx(e.src) + "," + cy(e.src) + " Q" + mx + "," + my + " " + cx(e.dst) + "," + cy(e.dst);
    }
    const wClass = e.w >= 10 ? " heavy" : e.w >= 4 ? " mid" : "";
    const eid = (e.src + "→" + e.dst).replace(/["'<>&]/g, "_");
    g += '<path class="edge' + (e.cyclic ? " cyclic" : "") + wClass + (fallback ? " faint" : "") + '" data-src="' + esc(e.src) + '" data-dst="' + esc(e.dst) + '" d="' + d + '"/>';
    if (pts && pts.length >= 2) {
      const mp = pts[Math.floor(pts.length / 2)];
      g += '<text class="edge-label" x="' + (mp.x + 4) + '" y="' + (mp.y - 4) + '">' + e.w + '</text>';
    }
  });
  v.nodes.forEach(n => {
    const p = pos[n.id];
    if (!p) return;
    g += '<g class="node' + (n.test ? " test" : "") + (n.cyc ? " cyc" : "") + impactClass(n.id, view.scope === "modules") + (n.id === selected ? " sel" : "") + (edits.hidden[n.id] ? " hidden-mod" : "") + '" data-id="' + esc(n.id) + '" onclick="clickNode(\\'' + n.id.replace(/'/g, "\\\\'") + '\\')" onmouseenter="hl(\\'' + n.id.replace(/'/g, "\\\\'") + '\\',1)" onmouseleave="hl(\\'' + n.id.replace(/'/g, "\\\\'") + '\\',0)">'
       + '<rect x="' + p.x + '" y="' + p.y + '" width="' + p.w + '" height="' + p.h + '"/>'
       + '<rect class="accentbar" x="' + p.x + '" y="' + (p.y + 10) + '" width="3.5" height="' + (p.h - 20) + '"/>'
       + '<text x="' + (p.x + p.w / 2) + '" y="' + (p.y + 24) + '" text-anchor="middle">' + esc(n.label) + '</text>'
       + '<text class="meta" x="' + (p.x + p.w / 2) + '" y="' + (p.y + 42) + '" text-anchor="middle">' + esc(n.meta) + '</text></g>';
  });
  vp.innerHTML = g;
  if (laid) { lastDims = { w: laid.width, h: laid.height }; fitView(laid.width, laid.height); }
  else { scale = 1; tx = 0; ty = 0; apply(); lastDims = null; }
  renderSide();
}

function hl(id, on) {
  document.querySelectorAll(".edge").forEach(p => {
    const hit = p.dataset.src === id || p.dataset.dst === id;
    p.classList.toggle("hi", on && hit);
    p.classList.toggle("dim", on && !hit);
  });
  document.querySelectorAll(".node").forEach(nd => nd.classList.toggle("dimn", on && nd.dataset.id !== id && ![...document.querySelectorAll('.edge.hi')].some(e => e.dataset.src === nd.dataset.id || e.dataset.dst === nd.dataset.id)));
}

function fitView(w, h) {
  const vw = svg.clientWidth || 900, vh = svg.clientHeight || 600;
  // 初始缩放下限 0.72:超大图允许滚动而不是把标签缩到不可读
  scale = Math.max(0.55, Math.min(1, (vw - 60) / w, (vh - 60) / h));
  tx = Math.max(12, (vw - w * scale) / 2);
  ty = 24;
  apply();
}
let lastDims = null;
function toggleFit() {
  if (!lastDims) return;
  const vw = svg.clientWidth || 900, vh = svg.clientHeight || 600;
  const fitScale = Math.min(1, (vw - 60) / lastDims.w, (vh - 60) / lastDims.h);
  if (Math.abs(scale - fitScale) < 0.01) { scale = 1; tx = 12; ty = 24; }
  else { scale = fitScale; tx = Math.max(12, (vw - lastDims.w * scale) / 2); ty = 24; }
  apply();
}

function exportPNG() {
  const clone = svg.cloneNode(true);
  const style = document.createElement("style");
  style.textContent = document.querySelector("style").textContent;
  clone.insertBefore(style, clone.firstChild);
  const xml = new XMLSerializer().serializeToString(clone);
  const img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas");
    c.width = svg.clientWidth * 2; c.height = svg.clientHeight * 2;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#0d1117"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.scale(2, 2); ctx.drawImage(img, 0, 0);
    const a = document.createElement("a");
    a.download = "codeblast-arch.png"; a.href = c.toDataURL("image/png"); a.click();
  };
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
}

function renderSide() {
  if (view.scope === "modules") {
    const cyc = DATA.modEdges.filter(e => e.cyclic);
    let h = "";
    if (cyc.length) h += '<div class="cyclic-banner">⚠ 检测到循环依赖: ' + cyc.map(e => esc(e.src)+" ⇄ "+esc(e.dst)).filter((v,i,a)=>a.indexOf(v)===i).slice(0,3).join("; ") + '</div>';
    h += DATA.modules.map(m => '<div class="item" onclick="drill(\\''+m.name.replace(/'/g,"\\\\'")+'\\')"><span>'+esc(DATA.moduleMeta[m.name]?.display ?? m.name)+'</span>'+(DATA.moduleMeta[m.name]?.desc ? '<div class="kind">'+esc(DATA.moduleMeta[m.name].desc)+'</div>' : '')+'<span class="kind">'+m.files+' files'+'<span class="blind">'+blindLabel(m.blind)+'</span>'+'</span></div>').join("");
    detail.innerHTML = renderEditPanel() + h;
  }
}

function clickNode(id) {
  if (editing && view.scope === "modules") { selectForEdit(id); return; }
  if (view.scope === "modules") drill(id);
  else showFile(id);
}

// ---- overlay 编辑模式：图上改名/合并/隐藏,导出 codeblast.overlay.json ----
let editing = false;
let selected = null;
let mergeSource = null;
// 会话内编辑态（不改 DATA,渲染时叠加）
const edits = { names: {}, hidden: {}, merges: {} };

function toggleEdit() {
  editing = !editing;
  selected = null;
  document.body.classList.toggle("editing", editing);
  document.getElementById("editbtn").classList.toggle("on", editing);
  if (editing && view.scope !== "modules") goHome();
  else render();
}

function selectForEdit(id) {
  if (selected === id) { selected = null; render(); return; }
  // 合并意图：仅当上一个选中项处于"待合并"状态（用户按了合并按钮）才触发,
  // 避免单纯切换选中被误判为合并（实测 bug: 改完名切到别的模块 → 被合并掉）
  if (mergeSource && mergeSource !== id) {
    if (confirm(\`把「\${displayName(mergeSource)}」并入「\${displayName(id)}」?\`)) {
      edits.merges[mergeSource] = id;
      mergeSource = null;
      selected = id;
      render();
      return;
    }
    mergeSource = null;
  }
  selected = id;
  render();
}

function startMerge() {
  if (!selected) return;
  mergeSource = selected;
  render();
}

function displayName(m) {
  return edits.names[m] ?? DATA.moduleMeta[m]?.display ?? m;
}

function applyEditName() {
  if (!selected) return;
  const v = document.getElementById("editname").value.trim();
  if (v) edits.names[selected] = v; else delete edits.names[selected];
  render();
}

function toggleHidden() {
  if (!selected) return;
  if (edits.hidden[selected]) delete edits.hidden[selected];
  else edits.hidden[selected] = true;
  render();
}

function unmerge() {
  if (!selected) return;
  delete edits.merges[selected];
  for (const [k, v] of Object.entries(edits.merges)) if (v === selected) delete edits.merges[k];
  render();
}

function overlayJSON() {
  const modules = {};
  const keys = new Set([...Object.keys(edits.names), ...Object.keys(edits.hidden), ...Object.keys(edits.merges)]);
  for (const k of keys) {
    const o = {};
    if (edits.names[k]) o.name = edits.names[k];
    if (edits.hidden[k]) o.hidden = true;
    if (edits.merges[k]) o.mergeInto = edits.merges[k];
    modules[k] = o;
  }
  return JSON.stringify({ modules }, null, 2);
}

function copyOverlay() {
  const txt = overlayJSON();
  navigator.clipboard?.writeText(txt).then(
    () => alert("已复制 codeblast.overlay.json 内容,粘贴到仓库根同名文件即可持久化"),
    () => alert("复制失败,请手动从下方文本框复制"),
  );
}

function downloadOverlay() {
  const blob = new Blob([overlayJSON()], { type: "application/json" });
  const a = document.createElement("a");
  a.download = "codeblast.overlay.json";
  a.href = URL.createObjectURL(blob);
  a.click();
}

function renderEditPanel() {
  if (!editing) return "";
  const dirty = Object.keys(edits.names).length + Object.keys(edits.hidden).length + Object.keys(edits.merges).length;
  if (!selected) {
    return '<div id="editpanel"><h2>编辑模式</h2><p class="tip">点一个模块开始编辑;先点 A 再点 B = 把 A 并入 B。'
      + (dirty ? '<br/>已有 ' + dirty + ' 项修改。' : '') + '</p>'
      + (dirty ? '<div class="row"><button class="primary" onclick="copyOverlay()">复制 overlay JSON</button>'
        + '<button onclick="downloadOverlay()">下载文件</button></div><pre>' + esc(overlayJSON()) + '</pre>' : '')
      + '</div>';
  }
  const merged = Object.entries(edits.merges).filter(([, v]) => v === selected).map(([k]) => k);
  return '<div id="editpanel"><h2>' + esc(selected) + '</h2>'
    + '<label class="tip">显示名</label>'
    + '<input id="editname" value="' + esc(displayName(selected)) + '" onkeydown="if(event.key===\\'Enter\\')applyEditName()"/>'
    + '<div class="row"><button class="primary" onclick="applyEditName()">应用名称</button>'
    + '<button onclick="toggleHidden()">' + (edits.hidden[selected] ? "取消隐藏" : "隐藏此模块") + '</button></div>'
    + '<div class="row"><button onclick="startMerge()">' + (mergeSource === selected ? "▸ 点击目标模块完成合并" : "合并到…") + '</button></div>'
    + (edits.merges[selected] ? '<p class="tip">已并入 <b>' + esc(edits.merges[selected]) + '</b></p><div class="row"><button onclick="unmerge()">取消合并</button></div>' : '')
    + (merged.length ? '<p class="tip">已合入此模块: ' + merged.map(esc).join(", ") + '</p><div class="row"><button onclick="unmerge()">解除全部</button></div>' : '')
    + '<div class="row"><button class="primary" onclick="copyOverlay()">复制 overlay JSON</button><button onclick="downloadOverlay()">下载</button></div>'
    + '<pre>' + esc(overlayJSON()) + '</pre></div>';
}
function drill(mod) { view = { scope: "files", module: mod }; render(); }
function goHome() { view = { scope: "modules", module: null }; render(); }
function showFile(path) {
  const f = DATA.files.find(x => x.path === path); if (!f) return;
  detail.innerHTML = '<h2>' + esc(path) + '</h2>'
    + ((f.blind.dyn || f.blind.unres) ? '<div class="cyclic-banner">盲区: '+(f.blind.dyn||0)+' 动态调用（原理性不可达） + '+(f.blind.unres||0)+' 解析失败（可能因缺依赖虚高）— 影响可能被低估</div>' : '')
    + f.symbols.map(s => '<div class="item" '+(DATA.repoUrl?'onclick="window.open(\\''+DATA.repoUrl+'/'+path+'#L'+s.line+'\\')"':'')+'><span>'+esc(s.name)+'</span><span class="kind">'+s.kind+' :'+s.line+'</span></div>').join("");
}

// 缩放平移
let scale = 1, tx = 0, ty = 0, drag = null;
svg.addEventListener("wheel", e => { e.preventDefault(); scale = Math.max(.3, Math.min(3, scale * (e.deltaY<0?1.1:0.9))); apply(); });
svg.addEventListener("mousedown", e => drag = { x: e.clientX-tx, y: e.clientY-ty });
window.addEventListener("mousemove", e => { if (drag) { tx = e.clientX-drag.x; ty = e.clientY-drag.y; apply(); } });
window.addEventListener("mouseup", () => drag = null);
function apply() { vp.setAttribute("transform", "translate("+tx+","+ty+") scale("+scale+")"); }

render();
window.addEventListener("resize", render);
</script>
</body>
</html>`;

await Bun.write(outPath, html);
console.error(`written: ${outPath} (${(html.length / 1024).toFixed(0)}KB)`);
