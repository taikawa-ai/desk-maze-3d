// 机とベニヤの迷路づくり
// 単位は cm。図面の座標は 原点=教室の左上、x=右、y=下。
// 壁 = 机を並べた列(厚み=机の奥行き) + 片側の面に立てたベニヤ。
// 決まり: ベニヤ1枚に机1か所。机は2段(上の机は逆さにして天板どうしを合わせる)。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';

const STORE_KEY = 'deskmaze.v1';
const SNAP = 5;          // 壁を動かすときは5cm刻み
const DRAW_SNAP = 30;    // 描くときは30cm刻み(ベニヤ90・机60がそろう)
const MIN_LEN = 30;      // これより短いドラッグは壁にしない
const STACK = 2;

// ---------- 見本(学校で最初に描いた図面) ----------
const SAMPLE = {
  room: { w: 655, d: 825, h: 250, door: { side: 'right', pos: 10, w: 100 } },
  rule: { panelW: 90, panelH: 180, deskW: 60, deskD: 40, deskH: 70 },
  walls: [
    [0, 140, 90, 'h'], [140, 140, 90, 'h'], [230, 85, 180, 'v'], [520, 85, 180, 'v'],
    [230, 265, 180, 'h'], [470, 265, 90, 'h'], [230, 390, 180, 'h'], [470, 390, 90, 'h'],
    [230, 430, 180, 'v'], [520, 430, 180, 'v'], [0, 565, 90, 'h'], [140, 565, 90, 'h'],
    [0, 690, 655, 'h'],
  ].map(([x, y, len, dir], i) => ({ id: i + 1, x, y, len, dir, face: 'a', name: '' })),
  bg: null,
};

let state = load() || structuredClone(SAMPLE);
let selId = null;
let mode = 'draw';
const undoStack = [];

function load() {
  try { const s = localStorage.getItem(STORE_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch {   // 写真が大きくて入らないときは写真ぬきで残す
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ ...state, bg: null })); } catch {}
  }
}
function snapshot() {
  undoStack.push(JSON.stringify(state));
  if (undoStack.length > 60) undoStack.shift();
}
function undo() {
  const s = undoStack.pop();
  if (!s) return;
  state = JSON.parse(s);
  if (!state.walls.some(w => w.id === selId)) selId = null;
  changed(false);
}
const nextId = () => state.walls.reduce((m, w) => Math.max(m, w.id), 0) + 1;
const snap = v => Math.round(v / SNAP) * SNAP;
const snapD = v => Math.round(v / DRAW_SNAP) * DRAW_SNAP;
const sel = () => state.walls.find(w => w.id === selId) || null;
const wallLabel = w => w.name || `壁${state.walls.indexOf(w) + 1}`;

// ---------- 壁から部品を割り出す ----------
function wallRect(w) {
  const t = state.rule.deskD;
  return w.dir === 'h' ? { x: w.x, y: w.y, w: w.len, h: t } : { x: w.x, y: w.y, w: t, h: w.len };
}
// ベニヤ: 90で割り切れない壁は、最後の1枚を端にそろえて重ねる。90より短い壁は1枚を切る。
function panelsOf(w) {
  const P = state.rule.panelW;
  if (w.len <= P) return [{ s: 0, w: w.len }];
  const n = Math.ceil(w.len / P - 1e-9);
  return Array.from({ length: n }, (_, j) => ({ s: Math.min(j * P, w.len - P), w: P }));
}
// 机: ベニヤ1枚の真ん中に1か所。前の机とぶつかる所は置かない。
function desksOf(w) {
  const D = state.rule.deskW, out = [];
  let skipped = 0;
  for (const p of panelsOf(w)) {
    if (p.w < D) { skipped++; continue; }
    const d = p.s + (p.w - D) / 2;
    if (out.length && d < out[out.length - 1] + D - 0.01) { skipped++; continue; }
    out.push(d);
  }
  return { starts: out, skipped };
}
function deskRects(w) {
  const { deskW: D, deskD: T } = state.rule;
  return desksOf(w).starts.map(d => w.dir === 'h'
    ? { x: w.x + d, y: w.y, w: D, h: T } : { x: w.x, y: w.y + d, w: T, h: D });
}
const overlap = (a, b) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;

function analyze() {
  const { panelW: P } = state.rule;
  const rows = [], warns = [], bad = new Set();
  let spots = 0, panels = 0;
  for (const w of state.walls) {
    const ps = panelsOf(w), ds = desksOf(w);
    spots += ds.starts.length; panels += ps.length;
    rows.push({ w, panels: ps.length, spots: ds.starts.length });
    const name = wallLabel(w);
    if (w.len < P) warns.push([w.id, `${name}(${w.len}cm): ベニヤ1枚を ${w.len}cm に切る必要があります。`]);
    else if (w.len % P) warns.push([w.id, `${name}(${w.len}cm): ${P}で割り切れません。最後のベニヤを ${P - (w.len % P)}cm 重ねて貼る形にしています。`]);
    if (ds.skipped) warns.push([w.id, `${name}: 机を置けないベニヤが ${ds.skipped} 枚あります(机がぶつかる・幅が足りない)。`]);
    const r = wallRect(w), R = state.room;
    if (r.x < 0 || r.y < 0 || r.x + r.w > R.w + 0.5 || r.y + r.h > R.d + 0.5) warns.push([w.id, `${name}: 教室からはみ出しています。`]);
  }
  // 別の壁どうしで机がぶつかっていないか
  const all = state.walls.flatMap(w => deskRects(w).map(r => ({ r, w })));
  const hit = new Set();
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    if (all[i].w.id !== all[j].w.id && overlap(all[i].r, all[j].r)) {
      const k = [all[i].w.id, all[j].w.id].sort().join('-');
      if (!hit.has(k)) { hit.add(k); warns.push([all[i].w.id, `${wallLabel(all[i].w)} と ${wallLabel(all[j].w)} の机がぶつかっています。`]); bad.add(all[j].w.id); }
    }
  }
  warns.forEach(([id]) => bad.add(id));
  return { rows, warns, bad, spots, desks: spots * STACK, panels };
}

// ---------- 図面(2D) ----------
const planCv = document.getElementById('plan');
const pctx = planCv.getContext('2d');
const view = { s: 1, ox: 20, oy: 20 };   // 画面 = o + 図面 * s
let bgImg = null;
let drawing = null, dragging = null, panning = null, pinch = null;
const pointers = new Map();

function sizeCanvas(cv) {
  const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; return true; }
  return false;
}
function fitPlan() {
  const r = planCv.getBoundingClientRect();
  if (!r.width) return;
  const pad = 30, top = 60;
  view.s = Math.min((r.width - pad * 2) / state.room.w, (r.height - top - pad - 50) / state.room.d);
  view.ox = (r.width - state.room.w * view.s) / 2;
  view.oy = top + 10;
  drawPlan();
}
const toWorld = (sx, sy) => ({ x: (sx - view.ox) / view.s, y: (sy - view.oy) / view.s });
function localPt(e) { const r = planCv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

function renderPlan(ctx, v, opt = {}) {
  const { s, ox, oy } = v, R = state.room, rule = state.rule;
  const X = x => ox + x * s, Y = y => oy + y * s;
  const res = analyze();
  // 写真
  if (bgImg && state.bg && !opt.noBg) {
    const b = state.bg, w = b.w * s, h = w * bgImg.height / bgImg.width;
    ctx.globalAlpha = b.op; ctx.drawImage(bgImg, X(-b.x), Y(-b.y), w, h); ctx.globalAlpha = 1;
  }
  // 方眼
  const step = s * 30 < 6 ? 90 : 30;   // 方眼は描く刻み(30cm)、濃い線はベニヤ1枚(90cm)
  ctx.lineWidth = 1;
  for (let x = 0; x <= R.w; x += step) { ctx.strokeStyle = x % 90 ? '#eee' : '#ccc'; ctx.beginPath(); ctx.moveTo(X(x), Y(0)); ctx.lineTo(X(x), Y(R.d)); ctx.stroke(); }
  for (let y = 0; y <= R.d; y += step) { ctx.strokeStyle = y % 90 ? '#eee' : '#ccc'; ctx.beginPath(); ctx.moveTo(X(0), Y(y)); ctx.lineTo(X(R.w), Y(y)); ctx.stroke(); }
  ctx.fillStyle = '#999'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
  for (let x = 0; x <= R.w; x += 90) ctx.fillText(x, X(x), Y(0) - 4);
  ctx.textAlign = 'right';
  for (let y = 90; y <= R.d; y += 90) ctx.fillText(y, X(0) - 4, Y(y) + 4);
  // 教室の壁と入口
  ctx.strokeStyle = '#444'; ctx.lineWidth = 4;
  ctx.strokeRect(X(0), Y(0), R.w * s, R.d * s);
  const dr = doorSeg();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 6;
  ctx.beginPath(); ctx.moveTo(X(dr.x0), Y(dr.y0)); ctx.lineTo(X(dr.x1), Y(dr.y1)); ctx.stroke();
  ctx.fillStyle = '#2e7d32'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('入口', X((dr.x0 + dr.x1) / 2) + (R.door.side === 'right' ? -20 : R.door.side === 'left' ? 20 : 0),
    Y((dr.y0 + dr.y1) / 2) + (R.door.side === 'top' ? 16 : R.door.side === 'bottom' ? -8 : 4));
  // 壁
  for (const w of state.walls) {
    const r = wallRect(w), isSel = w.id === selId && !opt.noSel;
    ctx.fillStyle = isSel ? '#f3c98b' : '#ead6b2';
    ctx.fillRect(X(r.x), Y(r.y), r.w * s, r.h * s);
    ctx.fillStyle = '#c9b48f';
    for (const d of deskRects(w)) ctx.fillRect(X(d.x) + 2, Y(d.y) + 2, d.w * s - 4, d.h * s - 4);
    ctx.lineWidth = isSel ? 3 : 1.2;
    ctx.strokeStyle = res.bad.has(w.id) ? '#c0392b' : isSel ? '#b5732d' : '#7a6a50';
    ctx.strokeRect(X(r.x), Y(r.y), r.w * s, r.h * s);
    // ベニヤの面(太い線)と継ぎ目
    ctx.strokeStyle = '#8a5a1e'; ctx.lineWidth = 4;
    for (const p of panelsOf(w)) {
      ctx.beginPath();
      if (w.dir === 'h') { const y = w.face === 'a' ? r.y : r.y + r.h; ctx.moveTo(X(w.x + p.s) + 1, Y(y)); ctx.lineTo(X(w.x + p.s + p.w) - 1, Y(y)); }
      else { const x = w.face === 'a' ? r.x : r.x + r.w; ctx.moveTo(X(x), Y(w.y + p.s) + 1); ctx.lineTo(X(x), Y(w.y + p.s + p.w) - 1); }
      ctx.stroke();
    }
    ctx.fillStyle = '#333'; ctx.font = `${Math.max(10, Math.min(14, s * 14))}px sans-serif`; ctx.textAlign = 'center';
    ctx.fillText(w.len, X(r.x + r.w / 2), Y(r.y + r.h / 2) + 5);
  }
  // 描いている途中の壁
  if (drawing && drawing.w && !opt.noSel) {
    const w = drawing.w, r = wallRect(w);
    ctx.fillStyle = '#b5732d55'; ctx.fillRect(X(r.x), Y(r.y), r.w * s, r.h * s);
    ctx.fillStyle = '#b5732d'; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(`${w.len} cm`, drawing.sx, drawing.sy - 40);
  }
  return res;
}
function doorSeg() {
  const { w, d, door } = state.room, a = door.pos, b = door.pos + door.w;
  return { top: { x0: a, y0: 0, x1: b, y1: 0 }, bottom: { x0: a, y0: d, x1: b, y1: d },
    left: { x0: 0, y0: a, x1: 0, y1: b }, right: { x0: w, y0: a, x1: w, y1: b } }[door.side];
}
function drawPlan() {
  sizeCanvas(planCv);
  const dpr = window.devicePixelRatio || 1;
  pctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  pctx.clearRect(0, 0, planCv.width, planCv.height);
  renderPlan(pctx, view);
}

function wallAt(p) {
  for (let i = state.walls.length - 1; i >= 0; i--) {
    const r = wallRect(state.walls[i]), m = 8 / view.s;   // 指で押しやすいよう少し広めに当たる
    if (p.x >= r.x - m && p.x <= r.x + r.w + m && p.y >= r.y - m && p.y <= r.y + r.h + m) return state.walls[i];
  }
  return null;
}

planCv.addEventListener('pointerdown', e => {
  planCv.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, localPt(e));
  if (pointers.size === 2) {           // 2本指: 拡大縮小と移動
    drawing = dragging = panning = null;
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, v: { ...view } };
    drawPlan(); return;
  }
  if (pointers.size > 2) return;
  const p = localPt(e), wp = toWorld(p.x, p.y);
  if (mode === 'draw') drawing = { start: { x: snapD(wp.x), y: snapD(wp.y) }, sx: p.x, sy: p.y, w: null, moved: false };
  else if (mode === 'select') {
    const w = wallAt(wp);
    if (w) { selId = w.id; dragging = { w, p0: wp, x0: w.x, y0: w.y, moved: false }; updateUI(); }
    else { selId = null; panning = { p0: p, v: { ...view } }; updateUI(); }
  } else panning = { p0: p, v: { ...view } };
  drawPlan();
});
planCv.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId)) {   // マウスを動かしただけ: 位置を表示
    const p = localPt(e), wp = toWorld(p.x, p.y);
    const f = mode === 'draw' ? snapD : snap;
    setHint(`左から ${f(wp.x)} cm ・ 上から ${f(wp.y)} cm`);
    return;
  }
  pointers.set(e.pointerId, localPt(e));
  const p = localPt(e);
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const k = d / pinch.d, s = Math.min(20, Math.max(0.2, pinch.v.s * k));
    const wx = (pinch.m.x - pinch.v.ox) / pinch.v.s, wy = (pinch.m.y - pinch.v.oy) / pinch.v.s;
    view.s = s; view.ox = m.x - wx * s; view.oy = m.y - wy * s;
    drawPlan(); return;
  }
  const wp = toWorld(p.x, p.y);
  if (drawing) {
    const st = drawing.start, dx = snapD(wp.x) - st.x, dy = snapD(wp.y) - st.y;
    drawing.sx = p.x; drawing.sy = p.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) >= MIN_LEN) drawing.moved = true;
    if (drawing.moved) {
      const h = Math.abs(dx) >= Math.abs(dy);
      drawing.w = h ? { x: Math.min(st.x, st.x + dx), y: st.y, len: Math.abs(dx), dir: 'h', face: 'a' }
                    : { x: st.x, y: Math.min(st.y, st.y + dy), len: Math.abs(dy), dir: 'v', face: 'a' };
      setHint(`長さ ${drawing.w.len} cm(${h ? '横' : '縦'})・指を離すと壁になります`);
    }
    drawPlan();
  } else if (dragging) {
    const nx = snap(dragging.x0 + wp.x - dragging.p0.x), ny = snap(dragging.y0 + wp.y - dragging.p0.y);
    if (!dragging.moved && (nx !== dragging.x0 || ny !== dragging.y0)) { snapshot(); dragging.moved = true; }
    if (dragging.moved) { dragging.w.x = nx; dragging.w.y = ny; setHint(`左から ${nx} cm ・ 上から ${ny} cm`); drawPlan(); }
  } else if (panning) {
    view.ox = panning.v.ox + p.x - panning.p0.x; view.oy = panning.v.oy + p.y - panning.p0.y; drawPlan();
  }
});
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pinch) { if (pointers.size < 2) pinch = null; return; }
  if (drawing) {
    if (drawing.w && drawing.w.len >= MIN_LEN) {
      snapshot();
      const w = { id: nextId(), name: '', ...drawing.w };
      state.walls.push(w); selId = w.id;
      drawing = null; changed();
    } else {
      // ほとんど動かさずに離した = タップ。壁の上なら選ぶ
      const w = wallAt(drawing.start);
      selId = w ? w.id : null; drawing = null; updateUI();
    }
  }
  if (dragging) { const m = dragging.moved; dragging = null; if (m) changed(false); }
  panning = null;
  drawPlan();
}
planCv.addEventListener('pointerup', endPointer);
planCv.addEventListener('pointercancel', endPointer);
planCv.addEventListener('wheel', e => {
  e.preventDefault();
  const p = localPt(e), wp = toWorld(p.x, p.y);
  view.s = Math.min(20, Math.max(0.2, view.s * Math.exp(-e.deltaY * 0.0015)));
  view.ox = p.x - wp.x * view.s; view.oy = p.y - wp.y * view.s; drawPlan();
}, { passive: false });

const HINTS = {
  draw: '指でなぞると壁になります(30cm刻み・横か縦にそろいます)。2本指で拡大・移動。',
  select: '壁をタップで選び、ドラッグで動かします。何もない所をドラッグすると図面が動きます。2本指で拡大。',
};
function setHint(t) { document.getElementById('hint').textContent = t; }
function setMode(m) {
  mode = m;
  document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  setHint(HINTS[m]);
}

// ---------- 3D ----------
const threeCv = document.getElementById('three');
const renderer = new THREE.WebGLRenderer({ canvas: threeCv, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.shadowMap.enabled = true;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#e9edf2');
const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 100);
const controls = new OrbitControls(camera, threeCv);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2 - 0.02;
scene.add(new THREE.HemisphereLight('#ffffff', '#8a8070', 1.6));
const sun = new THREE.DirectionalLight('#ffffff', 1.6);
sun.position.set(-4, 9, 6); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8 });
scene.add(sun); scene.add(sun.target);

const M = {
  ply: new THREE.MeshStandardMaterial({ color: '#d7b98a', roughness: 0.8 }),
  top: new THREE.MeshStandardMaterial({ color: '#e4d2b0', roughness: 0.7 }),
  pipe: new THREE.MeshStandardMaterial({ color: '#7d8088', roughness: 0.5, metalness: 0.4 }),
  floor: new THREE.MeshStandardMaterial({ color: '#c9c6bd', roughness: 0.9 }),
  room: new THREE.MeshStandardMaterial({ color: '#f4f2ec', roughness: 0.9, transparent: true, opacity: 0.35, depthWrite: false }),
};
let model = null;   // 単位 m のグループ(書き出しにも使う)
let roomGroup = null;

function box(g, name, x, y, z, sx, sy, sz, mat) {
  // 図面座標(cm): x右, y下, z上 → three(m): x右, y上, z手前
  const m = new THREE.Mesh(new THREE.BoxGeometry(sx / 100, sz / 100, sy / 100), mat);
  m.position.set((x + sx / 2) / 100, (z + sz / 2) / 100, (y + sy / 2) / 100);
  m.name = name; m.castShadow = m.receiveShadow = true;
  g.add(m); return m;
}
function addDesk(g, name, x, y, alongX, flip) {
  const { deskW, deskD, deskH: H } = state.rule;
  const w = alongX ? deskW : deskD, d = alongX ? deskD : deskW;
  const z = (z0, h) => flip ? 2 * H - (z0 + h) : z0;   // 上の机は H を境に上下を反転
  box(g, name + '_天板', x, y, z(H - 2, 2), w, d, 2, M.top);
  box(g, name + '_物入れ', x + 3, y + 3, z(H - 14, 1), w - 6, d - 6, 1, M.pipe);
  const p = 2.5;
  for (const [ix, iy] of [[0, 0], [1, 0], [0, 1], [1, 1]])
    box(g, name + '_脚', x + 2 + ix * (w - 4 - p), y + 2 + iy * (d - 4 - p), z(0, H - 2), p, p, H - 2, M.pipe);
}
function build3D() {
  if (model) { scene.remove(model); model.traverse(o => o.geometry && o.geometry.dispose()); }
  if (roomGroup) { scene.remove(roomGroup); roomGroup.traverse(o => o.geometry && o.geometry.dispose()); }
  model = new THREE.Group(); model.name = '迷路';
  const R = state.room, { panelH, deskD } = state.rule, T = 1.2;
  const floor = box(model, '床', 0, 0, -1, R.w, R.d, 1, M.floor); floor.castShadow = false;
  for (const w of state.walls) {
    const nm = wallLabel(w);
    desksOf(w).starts.forEach((ds, i) => {
      for (let k = 0; k < STACK; k++) {
        if (w.dir === 'h') addDesk(model, `${nm}_机${i + 1}_${k + 1}段`, w.x + ds, w.y, true, k === 1);
        else addDesk(model, `${nm}_机${i + 1}_${k + 1}段`, w.x, w.y + ds, false, k === 1);
      }
    });
    panelsOf(w).forEach((p, j) => {
      const n = `${nm}_ベニヤ${j + 1}`;
      if (w.dir === 'h') box(model, n, w.x + p.s + 0.2, w.face === 'a' ? w.y - T : w.y + deskD, 0, p.w - 0.4, T, panelH, M.ply);
      else box(model, n, w.face === 'a' ? w.x - T : w.x + deskD, w.y + p.s + 0.2, 0, T, p.w - 0.4, panelH, M.ply);
    });
  }
  scene.add(model);
  // 教室の壁(入口は開ける)
  roomGroup = new THREE.Group(); roomGroup.name = '教室';
  const t = 10, H = R.h, dr = R.door, DH = 200;
  const side = (nm, horiz, fixed, len, along0) => {   // 1辺を入口で切って作る
    const segs = dr.side === nm ? [[0, dr.pos], [dr.pos + dr.w, len]] : [[0, len]];
    for (const [a, b] of segs) if (b - a > 0.5) {
      if (horiz) box(roomGroup, `教室_${nm}`, a, fixed, 0, b - a, t, H, M.room);
      else box(roomGroup, `教室_${nm}`, fixed, a, 0, t, b - a, H, M.room);
    }
    if (dr.side === nm) {
      if (horiz) box(roomGroup, `教室_${nm}_入口の上`, dr.pos, fixed, DH, dr.w, t, H - DH, M.room);
      else box(roomGroup, `教室_${nm}_入口の上`, fixed, dr.pos, DH, t, dr.w, H - DH, M.room);
    }
  };
  side('top', true, -t, R.w); side('bottom', true, R.d, R.w);
  side('left', false, -t, R.d); side('right', false, R.w, R.d);
  roomGroup.traverse(o => { if (o.isMesh) o.castShadow = false; });
  roomGroup.visible = document.getElementById('showRoom').checked;
  scene.add(roomGroup);
  sun.target.position.set(R.w / 200, 0, R.d / 200);
  sun.position.set(R.w / 200 - 4, 9, R.d / 200 + 6);
}

let walk = null;  // { yaw, pitch }
const center = () => new THREE.Vector3(state.room.w / 200, 0.6, state.room.d / 200);
function setFov(f) { camera.fov = f; camera.updateProjectionMatrix(); }
function viewOrbit() {
  setFov(50); walk = null; controls.enabled = true; showWalkPad(false);
  const c = center(), r = Math.max(state.room.w, state.room.d) / 100;
  camera.position.set(c.x - r * 0.55, r * 1.15, c.z + r * 0.95);
  controls.target.copy(c); controls.update(); markView('viewOrbit');
}
function viewTop() {
  setFov(50); walk = null; controls.enabled = true; showWalkPad(false);
  const c = center(), r = Math.max(state.room.w, state.room.d) / 100;
  camera.position.set(c.x, r * 1.9, c.z + 0.001);
  controls.target.copy(c); controls.update(); markView('viewTop');
}
function viewWalk() {
  // 入口の内側に立って、教室の中を向く
  const R = state.room, d = R.door, m = d.pos + d.w / 2, inset = 50;
  const p = { top: [m, inset], bottom: [m, R.d - inset], left: [inset, m], right: [R.w - inset, m] }[d.side];
  const yaw = { top: Math.PI, bottom: 0, left: -Math.PI / 2, right: Math.PI / 2 }[d.side];
  camera.position.set(p[0] / 100, 1.5, p[1] / 100);
  walk = { yaw, pitch: -0.1 }; setFov(75);
  controls.enabled = false; showWalkPad(true); applyWalk(); markView('viewWalk');
}
function applyWalk() {
  const { yaw, pitch } = walk;
  const dir = new THREE.Vector3(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
  camera.lookAt(camera.position.clone().add(dir));
}
function showWalkPad(on) { document.getElementById('walkPad').hidden = !on; }
function markView(id) { ['viewOrbit', 'viewTop', 'viewWalk'].forEach(k => document.getElementById(k).classList.toggle('on', k === id)); }

// 歩く: ボタンを押している間 進む/回る。画面をドラッグで見回す。
const held = new Set();
document.querySelectorAll('#walkPad button').forEach(b => {
  const k = b.dataset.walk;
  b.addEventListener('pointerdown', e => { e.preventDefault(); held.add(k); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev => b.addEventListener(ev, () => held.delete(k)));
});
let look = null;
threeCv.addEventListener('pointerdown', e => { if (walk) { look = { x: e.clientX, y: e.clientY, yaw: walk.yaw, pitch: walk.pitch }; threeCv.setPointerCapture(e.pointerId); } });
threeCv.addEventListener('pointermove', e => {
  if (!walk || !look) return;
  walk.yaw = look.yaw + (e.clientX - look.x) * 0.005;
  walk.pitch = Math.max(-1.2, Math.min(1.2, look.pitch + (e.clientY - look.y) * 0.005));
  applyWalk();
});
['pointerup', 'pointercancel'].forEach(ev => threeCv.addEventListener(ev, () => { look = null; }));

let last = performance.now();
function tick(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  if (walk && held.size) {
    if (held.has('left')) walk.yaw += 1.6 * dt;
    if (held.has('right')) walk.yaw -= 1.6 * dt;
    const v = (held.has('fwd') ? 1 : 0) - (held.has('back') ? 1 : 0);
    camera.position.x += -Math.sin(walk.yaw) * v * 1.2 * dt;
    camera.position.z += -Math.cos(walk.yaw) * v * 1.2 * dt;
    applyWalk();
  }
  if (!walk) controls.update();
  if (sizeCanvas(threeCv)) {
    renderer.setSize(threeCv.width / renderer.getPixelRatio(), threeCv.height / renderer.getPixelRatio(), false);
    camera.aspect = threeCv.width / threeCv.height; camera.updateProjectionMatrix();
  }
  if (threeCv.offsetParent !== null) renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

// ---------- 画面の表示 ----------
function updateCounts(res) {
  document.getElementById('totals').innerHTML =
    `<div class="stat"><b>${res.desks}</b><span>机(台)</span></div>` +
    `<div class="stat"><b>${res.panels}</b><span>ベニヤ(枚)</span></div>` +
    `<div class="stat"><b>${res.spots}</b><span>机を置く場所(2段)</span></div>` +
    `<div class="stat"><b>${state.walls.length}</b><span>壁</span></div>`;
  const wl = document.getElementById('warnings');
  wl.innerHTML = res.warns.length ? '' : '<li class="ok">✓ 気になる所はありません</li>';
  for (const [id, t] of res.warns) {
    const li = document.createElement('li'); li.textContent = t;
    li.onclick = () => { selId = id; updateUI(); setTab('plan'); };
    wl.appendChild(li);
  }
  const tb = document.getElementById('countTable');
  tb.innerHTML = '<tr><th>壁</th><th>長さ</th><th>ベニヤ</th><th>机の場所</th><th>机</th></tr>' +
    res.rows.map(r => `<tr><td>${esc(wallLabel(r.w))}</td><td>${r.w.len}</td><td>${r.panels}</td><td>${r.spots}</td><td>${r.spots * STACK}</td></tr>`).join('') +
    `<tr><th>合計</th><th></th><th>${res.panels}</th><th>${res.spots}</th><th>${res.desks}</th></tr>`;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function updateUI() {
  const w = sel();
  document.getElementById('selBar').hidden = !w;
  document.getElementById('selFields').hidden = !w;
  document.getElementById('selNone').hidden = !!w;
  if (w) {
    document.getElementById('selLabel').textContent = `${wallLabel(w)}  ${w.dir === 'h' ? '横' : '縦'} ${w.len}cm`;
    document.querySelectorAll('#selFields [data-f]').forEach(el => {
      if (document.activeElement !== el) el.value = w[el.dataset.f] ?? '';
    });
  }
  const ol = document.getElementById('wallList');
  ol.innerHTML = '';
  state.walls.forEach(x => {
    const li = document.createElement('li');
    li.textContent = `${x.name || ''} ${x.dir === 'h' ? '横' : '縦'} ${x.len}cm(左から${x.x}・上から${x.y})`;
    li.className = x.id === selId ? 'sel' : '';
    li.onclick = () => { selId = x.id; updateUI(); };
    ol.appendChild(li);
  });
  updateCounts(analyze());
  drawPlan();
}
let buildTimer = null;
function changed(push = false) {
  if (push) snapshot();
  save(); updateUI();
  clearTimeout(buildTimer); buildTimer = setTimeout(build3D, 120);
}

function setTab(t) {
  document.body.dataset.tab = t;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  requestAnimationFrame(() => { drawPlan(); });
}

// ---------- 入力欄 ----------
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => setTab(b.dataset.tab));
document.querySelectorAll('#modes button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
document.getElementById('fitPlan').onclick = fitPlan;
document.getElementById('undo').onclick = undo;

document.querySelectorAll('#selFields [data-f]').forEach(el => {
  el.addEventListener('focus', () => snapshot());
  el.addEventListener('input', () => {
    const w = sel(); if (!w) return;
    const f = el.dataset.f;
    if (['x', 'y', 'len'].includes(f)) { const v = Number(el.value); if (!Number.isFinite(v) || (f === 'len' && v <= 0)) return; w[f] = v; }
    else w[f] = el.value;
    changed();
  });
});
document.getElementById('selRotate').onclick = () => { const w = sel(); if (!w) return; snapshot(); w.dir = w.dir === 'h' ? 'v' : 'h'; changed(); };
document.getElementById('selFace').onclick = () => { const w = sel(); if (!w) return; snapshot(); w.face = w.face === 'a' ? 'b' : 'a'; changed(); };
document.getElementById('selDup').onclick = () => {
  const w = sel(); if (!w) return; snapshot();
  const c = { ...w, id: nextId(), name: '' };
  if (w.dir === 'h') c.y += state.rule.deskD + 60; else c.x += state.rule.deskD + 60;
  state.walls.push(c); selId = c.id; changed();
};
document.getElementById('selDel').onclick = () => {
  const w = sel(); if (!w) return; snapshot();
  state.walls = state.walls.filter(x => x !== w); selId = null; changed();
};
document.getElementById('addWall').onclick = () => {
  const f = n => document.querySelector(`#addForm [name=${n}]`).value;
  const len = Number(f('len'));
  if (!(len > 0)) return alert('長さを入れてください');
  snapshot();
  const w = { id: nextId(), name: '', x: Number(f('x')) || 0, y: Number(f('y')) || 0, len, dir: f('dir'), face: f('face') };
  state.walls.push(w); selId = w.id; changed();
};

// 教室・材料
const getPath = (o, p) => p.split('.').reduce((a, k) => a[k], o);
function setPath(o, p, v) { const ks = p.split('.'), last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; }
function fillRoomFields() {
  document.querySelectorAll('[data-r]').forEach(el => el.value = getPath(state, el.dataset.r));
  const b = state.bg || { w: state.room.w, op: 0.5, x: 0, y: 0 };
  bgW.value = b.w; bgOp.value = b.op; bgX.value = b.x; bgY.value = b.y;
}
document.querySelectorAll('[data-r]').forEach(el => {
  el.addEventListener('focus', () => snapshot());
  el.addEventListener('input', () => {
    const v = el.tagName === 'SELECT' ? el.value : Number(el.value);
    if (el.tagName !== 'SELECT' && !(v >= 0)) return;
    setPath(state, el.dataset.r, v); changed();
  });
});

// 下書きの写真
const bgW = document.getElementById('bgW'), bgOp = document.getElementById('bgOp');
const bgX = document.getElementById('bgX'), bgY = document.getElementById('bgY');
function loadBgImage() {
  bgImg = null;
  if (!state.bg) return drawPlan();
  const im = new Image(); im.onload = () => { bgImg = im; drawPlan(); }; im.src = state.bg.src;
}
document.getElementById('bgFile').addEventListener('change', e => {
  const file = e.target.files[0]; if (!file) return;
  const im = new Image(), url = URL.createObjectURL(file);
  im.onload = () => {   // 端末に残せるよう縮めて保存
    const k = Math.min(1, 1600 / Math.max(im.width, im.height));
    const c = document.createElement('canvas'); c.width = im.width * k; c.height = im.height * k;
    c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
    state.bg = { src: c.toDataURL('image/jpeg', 0.8), w: Number(bgW.value) || state.room.w, op: Number(bgOp.value) || 0.5, x: Number(bgX.value) || 0, y: Number(bgY.value) || 0 };
    URL.revokeObjectURL(url); save(); loadBgImage(); setTab('plan');
  };
  im.src = url;
});
[bgW, bgOp, bgX, bgY].forEach(el => el.addEventListener('input', () => {
  if (!state.bg) return;
  state.bg.w = Number(bgW.value) || state.room.w; state.bg.op = Number(bgOp.value);
  state.bg.x = Number(bgX.value) || 0; state.bg.y = Number(bgY.value) || 0;
  save(); drawPlan();
}));
document.getElementById('bgClear').onclick = () => { state.bg = null; save(); loadBgImage(); };

// 保存・書き出し
function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const stamp = () => new Date().toISOString().slice(0, 10);
document.getElementById('saveJson').onclick = () =>
  download(new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' }), `迷路の図面_${stamp()}.json`);
document.getElementById('loadJson').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const s = JSON.parse(await f.text());
    if (!Array.isArray(s.walls) || !s.room) throw new Error();
    snapshot(); state = { ...structuredClone(SAMPLE), ...s, rule: { ...SAMPLE.rule, ...s.rule } };
    selId = null; fillRoomFields(); loadBgImage(); changed(); fitPlan(); viewOrbit();
  } catch { alert('このファイルは図面として読めませんでした'); }
  e.target.value = '';
});
document.getElementById('exportPng').onclick = () => {
  const s = 1.2, pad = 50, R = state.room;
  const c = document.createElement('canvas');
  c.width = Math.round(R.w * s + pad * 2); c.height = Math.round(R.d * s + pad * 2 + 70);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  const res = renderPlan(ctx, { s, ox: pad, oy: pad }, { noSel: true, noBg: true });
  ctx.fillStyle = '#222'; ctx.font = 'bold 18px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(`机 ${res.desks}台(${res.spots}か所×2段)  ベニヤ ${res.panels}枚  壁 ${state.walls.length}`, pad, c.height - 40);
  ctx.font = '13px sans-serif'; ctx.fillStyle = '#666';
  ctx.fillText(`教室 ${R.w}×${R.d}cm ・ 太い茶色の線=ベニヤの面 ・ 濃い四角=机`, pad, c.height - 18);
  c.toBlob(b => download(b, `迷路_上から_${stamp()}.png`));
};
document.getElementById('exportGlb').onclick = () => {
  const g = new THREE.Group(); g.add(model.clone()); if (roomGroup.visible) g.add(roomGroup.clone());
  new GLTFExporter().parse(g, buf => download(new Blob([buf], { type: 'model/gltf-binary' }), `迷路_${stamp()}.glb`),
    err => alert('書き出しに失敗しました: ' + err), { binary: true });
};
document.getElementById('exportObj').onclick = () => {
  const txt = new OBJExporter().parse(model);   // OBJ は迷路だけ(単位 m)
  download(new Blob([txt], { type: 'text/plain' }), `迷路_${stamp()}.obj`);
};
document.getElementById('loadSample').onclick = () => {
  if (!confirm('今の図面を見本に置きかえます(「戻す」で元に戻せます)')) return;
  snapshot(); state = structuredClone(SAMPLE); selId = null; fillRoomFields(); loadBgImage(); changed(); fitPlan(); viewOrbit();
};
document.getElementById('clearAll').onclick = () => {
  if (!confirm('壁を全部消します(「戻す」で元に戻せます)')) return;
  snapshot(); state.walls = []; selId = null; changed();
};
document.getElementById('showRoom').onchange = e => { roomGroup.visible = e.target.checked; };
document.getElementById('viewOrbit').onclick = viewOrbit;
document.getElementById('viewTop').onclick = viewTop;
document.getElementById('viewWalk').onclick = viewWalk;

// ---------- 開始 ----------
new ResizeObserver(() => drawPlan()).observe(planCv);
let fitted = false;
new ResizeObserver(() => { if (!fitted && planCv.getBoundingClientRect().width) { fitted = true; fitPlan(); } }).observe(planCv);
setTab(window.matchMedia('(min-width: 1000px)').matches ? 'wall' : 'plan');
setMode('draw');
fillRoomFields(); loadBgImage();
build3D(); viewOrbit(); updateUI();
requestAnimationFrame(tick);
