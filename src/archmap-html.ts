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

const [dbPath] = process.argv.slice(2);
const outFlag = process.argv.indexOf("--out");
const outPath = outFlag >= 0 ? process.argv[outFlag + 1] : "arch.html";
if (!dbPath) {
  console.error("usage: bun run src/archmap-html.ts <graph.db> --out arch.html");
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const TEST_RE = /\.(test|spec)\.[cm]?[jt]sx?$|__tests__\/|(^|\/)tests?\/|(^|\/)test_[^/]*\.py$|_test\.py$|conftest\.py$/;
const moduleOf = (file: string): string => {
  if (TEST_RE.test(file)) return "tests";
  const ix = file.indexOf("/");
  return ix < 0 ? "(root)" : file.slice(0, ix);
};

// ---- 数据装配 ----
interface FileInfo { path: string; module: string; blind: number; symbols: { name: string; kind: string; line: number }[] }

const files = db.prepare("SELECT file FROM nodes WHERE kind = 'file'").all() as { file: string }[];
const blindRows = db.prepare(
  "SELECT file, COUNT(*) c FROM blind_spots WHERE reason NOT LIKE 'test-global%' GROUP BY file",
).all() as { file: string; c: number }[];
const blindMap = new Map(blindRows.map((b) => [b.file, b.c]));
const symRows = db.prepare(
  "SELECT file, name, kind, line FROM nodes WHERE kind NOT IN ('file','module') ORDER BY file, line",
).all() as { file: string; name: string; kind: string; line: number }[];
const symsByFile = new Map<string, { name: string; kind: string; line: number }[]>();
for (const s of symRows) {
  const list = symsByFile.get(s.file) ?? [];
  list.push({ name: s.name, kind: s.kind, line: s.line });
  symsByFile.set(s.file, list);
}

const fileInfos: FileInfo[] = files.map((f) => ({
  path: f.file,
  module: moduleOf(f.file),
  blind: blindMap.get(f.file) ?? 0,
  symbols: symsByFile.get(f.file) ?? [],
}));

const importRows = db.prepare("SELECT src, dst, line FROM edges WHERE kind = 'imports'").all() as
  { src: string; dst: string; line: number }[];

// 模块聚合
const modules = new Map<string, { files: number; blind: number }>();
for (const fi of fileInfos) {
  const m = modules.get(fi.module) ?? { files: 0, blind: 0 };
  m.files++;
  m.blind += fi.blind;
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

const data = {
  generated: new Date().toISOString().slice(0, 16).replace("T", " "),
  modules: [...modules.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.files - a.files),
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
  #graph { flex: 1; position: relative; overflow: hidden; }
  svg { width: 100%; height: 100%; cursor: grab; }
  #side { width: 380px; border-left: 1px solid var(--border); background: var(--panel); overflow-y: auto; padding: 16px; }
  h1 { font-size: 15px; padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--panel); }
  h1 small { color: var(--dim); font-weight: normal; margin-left: 8px; }
  .node rect { fill: #1f6feb22; stroke: var(--accent); stroke-width: 1.2; rx: 8; cursor: pointer; }
  .node.test rect { stroke: var(--ok); fill: #3fb95011; }
  .node text { fill: var(--fg); font-size: 13px; pointer-events: none; }
  .node .meta { fill: var(--dim); font-size: 11px; }
  .edge { stroke: #58a6ff55; fill: none; marker-end: url(#arrow); }
  .edge.cyclic { stroke: var(--warn); stroke-dasharray: 5 3; }
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
  <div id="graph"><svg id="svg"><defs>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="#58a6ff88"/></marker>
  </defs><g id="viewport"></g></svg></div>
</div>
<div id="side"><h2>概览</h2><div id="detail"></div>
  <p class="hint">点击模块下钻到文件层;点击文件查看符号。红色虚线 = 循环依赖。滚轮缩放,拖拽平移。</p>
</div>
<script>
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

function render() {
  let nodes, edges;
  if (view.scope === "modules") {
    nodes = DATA.modules.map(m => ({ id: m.name, label: m.name, meta: m.files + " files" + (m.blind ? " · " + m.blind + " blind" : ""), test: m.name === "tests" }));
    edges = DATA.modEdges.map(e => ({ src: e.src, dst: e.dst, w: e.w, cyclic: e.cyclic }));
    crumbs.innerHTML = "模块层 · " + nodes.length + " modules";
  } else {
    const fs = DATA.files.filter(f => f.module === view.module);
    const inSet = new Set(fs.map(f => f.path));
    nodes = fs.map(f => ({ id: f.path, label: f.path.split("/").pop(), meta: f.symbols.length + " symbols" + (f.blind ? " · " + f.blind + " blind" : ""), test: false }));
    const agg = {};
    DATA.fileEdges.forEach(e => {
      if (inSet.has(e.src) && inSet.has(e.dst)) { const k = e.src+"→"+e.dst; agg[k] = (agg[k]||0)+1; }
    });
    edges = Object.entries(agg).map(([k,w]) => { const [src,dst] = k.split("→"); return { src, dst, w, cyclic: false }; });
    crumbs.innerHTML = '<span class="crumb" onclick="goHome()">模块层</span> › ' + esc(view.module) + " · " + nodes.length + " files";
  }
  layout(nodes, edges);
  const pos = {}; nodes.forEach(n => pos[n.id] = n);
  let g = "";
  edges.forEach(e => {
    const a = pos[e.src], b = pos[e.dst]; if (!a || !b) return;
    const mx = (a.x+b.x)/2, my = (a.y+b.y)/2 - 20;
    g += '<path class="edge'+(e.cyclic?" cyclic":"")+'" d="M'+a.x+','+a.y+' Q'+mx+','+my+' '+b.x+','+b.y+'"/>';
    g += '<text class="edge-label" x="'+mx+'" y="'+(my+4)+'">'+e.w+'</text>';
  });
  nodes.forEach(n => {
    const w = Math.max(120, n.label.length*8 + 30);
    g += '<g class="node'+(n.test?" test":"")+'" onclick="clickNode(\\''+n.id.replace(/'/g,"\\\\'")+'\\')">'
       + '<rect x="'+(n.x-w/2)+'" y="'+(n.y-24)+'" width="'+w+'" height="48"/>'
       + '<text x="'+n.x+'" y="'+(n.y-4)+'" text-anchor="middle">'+esc(n.label)+'</text>'
       + '<text class="meta" x="'+n.x+'" y="'+(n.y+14)+'" text-anchor="middle">'+esc(n.meta)+'</text></g>';
  });
  vp.innerHTML = g;
  renderSide();
}

function renderSide() {
  if (view.scope === "modules") {
    const cyc = DATA.modEdges.filter(e => e.cyclic);
    let h = "";
    if (cyc.length) h += '<div class="cyclic-banner">⚠ 检测到循环依赖: ' + cyc.map(e => esc(e.src)+" ⇄ "+esc(e.dst)).filter((v,i,a)=>a.indexOf(v)===i).slice(0,3).join("; ") + '</div>';
    h += DATA.modules.map(m => '<div class="item" onclick="drill(\\''+m.name.replace(/'/g,"\\\\'")+'\\')"><span>'+esc(m.name)+'</span><span class="kind">'+m.files+' files'+(m.blind?' <span class="blind">'+m.blind+' blind</span>':'')+'</span></div>').join("");
    detail.innerHTML = h;
  }
}

function clickNode(id) {
  if (view.scope === "modules") drill(id);
  else showFile(id);
}
function drill(mod) { view = { scope: "files", module: mod }; render(); }
function goHome() { view = { scope: "modules", module: null }; render(); }
function showFile(path) {
  const f = DATA.files.find(x => x.path === path); if (!f) return;
  detail.innerHTML = '<h2>' + esc(path) + '</h2>'
    + (f.blind ? '<div class="cyclic-banner">'+f.blind+' 个盲区（动态调用,影响可能被低估）</div>' : '')
    + f.symbols.map(s => '<div class="item"><span>'+esc(s.name)+'</span><span class="kind">'+s.kind+' :'+s.line+'</span></div>').join("");
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
