function blindLabel(b) {
  if (!b || (!b.dyn && !b.unres)) return "";
  const parts = [];
  if (b.dyn) parts.push(b.dyn + " dyn");
  if (b.unres) parts.push(b.unres + " unres");
  return " · " + parts.join(" · ");
}
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
    g += '<g class="node' + (n.test ? " test" : "") + (n.cyc ? " cyc" : "") + impactClass(n.id, view.scope === "modules") + (n.id === selected ? " sel" : "") + (edits.hidden[n.id] ? " hidden-mod" : "") + '" data-id="' + esc(n.id) + '" onclick="clickNode(\'' + n.id.replace(/'/g, "\\'") + '\')" onmouseenter="hl(\'' + n.id.replace(/'/g, "\\'") + '\',1)" onmouseleave="hl(\'' + n.id.replace(/'/g, "\\'") + '\',0)">'
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
    h += DATA.modules.map(m => '<div class="item" onclick="drill(\''+m.name.replace(/'/g,"\\'")+'\')"><span>'+esc(DATA.moduleMeta[m.name]?.display ?? m.name)+'</span>'+(DATA.moduleMeta[m.name]?.desc ? '<div class="kind">'+esc(DATA.moduleMeta[m.name].desc)+'</div>' : '')+'<span class="kind">'+m.files+' files'+'<span class="blind">'+blindLabel(m.blind)+'</span>'+'</span></div>').join("");
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
    if (confirm(`把「${displayName(mergeSource)}」并入「${displayName(id)}」?`)) {
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
    + '<input id="editname" value="' + esc(displayName(selected)) + '" onkeydown="if(event.key===\'Enter\')applyEditName()"/>'
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
    + ((f.blind.dyn || f.blind.unres) ? '<div class="cyclic-banner">盲区（静态无法解析到仓内目标的调用/导入，并非只有动态调用）: '+(f.blind.dyn||0)+' 动态/子进程/外部依赖解析失败 + '+(f.blind.unres||0)+' 未解析调用 — 影响可能被低估</div>' : '')
    + f.symbols.map(s => '<div class="item" '+(DATA.repoUrl?'onclick="window.open(\''+DATA.repoUrl+'/'+path+'#L'+s.line+'\')"':'')+'><span>'+esc(s.name)+'</span><span class="kind">'+s.kind+' :'+s.line+'</span></div>').join("");
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
