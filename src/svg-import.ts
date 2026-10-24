import type { Folder, Layer, LayerNode, Paint, PathNode, Shape, Vec } from './types';
import { newFolder, newLayer, shapePrims, transformShape, uid } from './doc';
import { applyAffine, type Affine } from './geom';
import { computeFaces } from './regions';
import { joinColor } from './color';

/**
 * 外部の SVG を取り込む。
 *  - <g> の木はフォルダーとレイヤーにする（<g> を含む <g> はフォルダー、それ以外の <g> はレイヤー）
 *  - path / rect / circle / ellipse / line / polyline / polygon の輪郭を線にする
 *  - 線でできた範囲ごとに、元の SVG でいちばん上に見えている塗りを付ける（重なった図形の見た目を再現する）
 *  - 線の太さ・色、文字、画像、<use> などは取り込まない
 */

export interface ImportResult {
  width: number;
  height: number;
  nodes: LayerNode[];
  shapes: number;
  fills: number;
  skipped: string[];
}

const GEOMETRY = new Set(['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);
const CONTAINERS = new Set(['g', 'a', 'switch']);
const UNSUPPORTED: Record<string, string> = {
  text: '文字', image: '画像', use: '<use>（複製参照）', foreignObject: 'HTML', video: '動画',
};

/** 安全のため、スクリプトや外部の読み込みにつながるものを取り除く */
function sanitize(root: Element) {
  root.querySelectorAll('script, foreignObject, iframe, image, audio, video, animate, animateTransform, animateMotion, set').forEach((e) => e.remove());
  const walk = (el: Element) => {
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (n.startsWith('on')) el.removeAttribute(a.name);
      if ((n === 'href' || n === 'xlink:href') && !a.value.trim().startsWith('#')) el.removeAttribute(a.name);
    }
    for (const c of el.children) walk(c);
  };
  walk(root);
}

// ── パスデータ

type Sub = { nodes: PathNode[]; closed: boolean };

function arcToCubics(x1: number, y1: number, rx: number, ry: number, phiDeg: number, fa: number, fs: number, x2: number, y2: number): Vec[][] {
  if (rx === 0 || ry === 0) return [[{ x: x1, y: y1 }, { x: x2, y: y2 }, { x: x2, y: y2 }]];
  const phi = (phiDeg * Math.PI) / 180;
  const cs = Math.cos(phi), sn = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const xp = cs * dx + sn * dy, yp = -sn * dx + cs * dy;
  rx = Math.abs(rx); ry = Math.abs(ry);
  const lam = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const den = rx * rx * yp * yp + ry * ry * xp * xp;
  const co = (fa === fs ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * yp) / ry, cyp = (-co * ry * xp) / rx;
  const cx = cs * cxp - sn * cyp + (x1 + x2) / 2, cy = sn * cxp + cs * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let dt = ang((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!fs && dt > 0) dt -= 2 * Math.PI;
  if (fs && dt < 0) dt += 2 * Math.PI;
  const segs = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2)));
  const d = dt / segs;
  const k = (4 / 3) * Math.tan(d / 4);
  const pt = (t: number) => ({ x: cx + rx * Math.cos(t) * cs - ry * Math.sin(t) * sn, y: cy + rx * Math.cos(t) * sn + ry * Math.sin(t) * cs });
  const der = (t: number) => ({ x: -rx * Math.sin(t) * cs - ry * Math.cos(t) * sn, y: -rx * Math.sin(t) * sn + ry * Math.cos(t) * cs });
  const out: Vec[][] = [];
  for (let i = 0; i < segs; i++) {
    const a = t1 + i * d, b = a + d;
    const pa = pt(a), pb = pt(b), da = der(a), db = der(b);
    out.push([{ x: pa.x + k * da.x, y: pa.y + k * da.y }, { x: pb.x - k * db.x, y: pb.y - k * db.y }, pb]);
  }
  return out;
}

export function parsePathData(d: string): Sub[] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const subs: Sub[] = [];
  let cur: Sub | null = null;
  let i = 0, cmd = '';
  let x = 0, y = 0, sx = 0, sy = 0;
  let lastC: Vec | null = null, lastQ: Vec | null = null;
  const num = () => Number(tokens[i++]);
  const isNum = () => i < tokens.length && !/[a-zA-Z]/.test(tokens[i]);
  const start = (px: number, py: number) => {
    cur = { nodes: [{ x: px, y: py, hin: null, hout: null }], closed: false };
    subs.push(cur);
  };
  const ensure = () => { if (!cur) start(x, y); return cur!; };
  const lineTo = (px: number, py: number) => {
    ensure().nodes.push({ x: px, y: py, hin: null, hout: null });
    x = px; y = py;
  };
  const cubicTo = (c1: Vec, c2: Vec, p: Vec) => {
    const s = ensure();
    s.nodes[s.nodes.length - 1].hout = c1;
    s.nodes.push({ x: p.x, y: p.y, hin: c2, hout: null });
    x = p.x; y = p.y;
  };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    let wasC = false, wasQ = false;
    if (C === 'M') {
      if (!isNum()) continue;
      x = ox + num(); y = oy + num();
      sx = x; sy = y;
      start(x, y);
      cmd = rel ? 'l' : 'L'; // 続く座標は直線
    } else if (C === 'L') { if (!isNum()) continue; const px = ox + num(), py = oy + num(); lineTo(px, py); }
    else if (C === 'H') { if (!isNum()) continue; lineTo((rel ? x : 0) + num(), y); }
    else if (C === 'V') { if (!isNum()) continue; lineTo(x, (rel ? y : 0) + num()); }
    else if (C === 'C') {
      if (!isNum()) continue;
      const c1 = { x: ox + num(), y: oy + num() }, c2 = { x: ox + num(), y: oy + num() }, p = { x: ox + num(), y: oy + num() };
      cubicTo(c1, c2, p); lastC = c2; wasC = true;
    } else if (C === 'S') {
      if (!isNum()) continue;
      const c1 = lastC ? { x: 2 * x - lastC.x, y: 2 * y - lastC.y } : { x, y };
      const c2 = { x: ox + num(), y: oy + num() }, p = { x: ox + num(), y: oy + num() };
      cubicTo(c1, c2, p); lastC = c2; wasC = true;
    } else if (C === 'Q' || C === 'T') {
      if (!isNum()) continue;
      const q: Vec = C === 'Q' ? { x: ox + num(), y: oy + num() } : lastQ ? { x: 2 * x - lastQ.x, y: 2 * y - lastQ.y } : { x, y };
      const p = { x: ox + num(), y: oy + num() };
      cubicTo({ x: x + ((q.x - x) * 2) / 3, y: y + ((q.y - y) * 2) / 3 }, { x: p.x + ((q.x - p.x) * 2) / 3, y: p.y + ((q.y - p.y) * 2) / 3 }, p);
      lastQ = q; wasQ = true;
    } else if (C === 'A') {
      if (!isNum()) continue;
      const rx = num(), ry = num(), rot = num(), fa = num(), fs = num();
      const px = ox + num(), py = oy + num();
      for (const [c1, c2, p] of arcToCubics(x, y, rx, ry, rot, fa, fs, px, py)) cubicTo(c1, c2, p);
    } else if (C === 'Z') {
      if (cur) {
        const s: Sub = cur;
        s.closed = true;
        x = sx; y = sy;
        cur = null;
      }
    } else { i++; continue; }
    if (!wasC) lastC = null;
    if (!wasQ) lastQ = null;
  }
  // 閉じた図形で最後の点が始点と重なっていれば1つにまとめる
  for (const s of subs) {
    const n = s.nodes;
    if (s.closed && n.length > 1) {
      const a = n[0], b = n[n.length - 1];
      if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) { a.hin = b.hin; n.pop(); }
    }
  }
  return subs.filter((s) => s.nodes.length >= 2);
}

// ── 基本図形

const K = 0.5522847498;

function ellipseSub(cx: number, cy: number, rx: number, ry: number): Sub {
  const N = (x: number, y: number, hin: Vec, hout: Vec): PathNode => ({ x, y, hin, hout });
  return {
    closed: true,
    nodes: [
      N(cx + rx, cy, { x: cx + rx, y: cy - K * ry }, { x: cx + rx, y: cy + K * ry }),
      N(cx, cy + ry, { x: cx + K * rx, y: cy + ry }, { x: cx - K * rx, y: cy + ry }),
      N(cx - rx, cy, { x: cx - rx, y: cy + K * ry }, { x: cx - rx, y: cy - K * ry }),
      N(cx, cy - ry, { x: cx - K * rx, y: cy - ry }, { x: cx + K * rx, y: cy - ry }),
    ],
  };
}

function rectSub(x: number, y: number, w: number, h: number, rx: number, ry: number): Sub {
  if (rx <= 0 && ry <= 0) {
    const P = (px: number, py: number): PathNode => ({ x: px, y: py, hin: null, hout: null });
    return { closed: true, nodes: [P(x, y), P(x + w, y), P(x + w, y + h), P(x, y + h)] };
  }
  rx = Math.min(rx || ry, w / 2); ry = Math.min(ry || rx, h / 2);
  const n: PathNode[] = [];
  const add = (px: number, py: number, hin: Vec | null, hout: Vec | null) => n.push({ x: px, y: py, hin, hout });
  add(x + rx, y, { x: x + rx - K * rx, y }, null);
  add(x + w - rx, y, null, { x: x + w - rx + K * rx, y });
  add(x + w, y + ry, { x: x + w, y: y + ry - K * ry }, null);
  add(x + w, y + h - ry, null, { x: x + w, y: y + h - ry + K * ry });
  add(x + w - rx, y + h, { x: x + w - rx + K * rx, y: y + h }, null);
  add(x + rx, y + h, null, { x: x + rx - K * rx, y: y + h });
  add(x, y + h - ry, { x, y: y + h - ry + K * ry }, null);
  add(x, y + ry, null, { x, y: y + ry - K * ry });
  return { closed: true, nodes: n };
}

function pointsSub(attr: string, closed: boolean): Sub | null {
  const v = (attr.match(/[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? []).map(Number);
  const nodes: PathNode[] = [];
  for (let i = 0; i + 1 < v.length; i += 2) nodes.push({ x: v[i], y: v[i + 1], hin: null, hout: null });
  return nodes.length >= 2 ? { nodes, closed } : null;
}

const len = (a: SVGAnimatedLength) => a.baseVal.value;

/** 要素の図形を、要素自身の座標系で求める */
function elementSubs(el: SVGElement): { subs: Sub[]; circle?: { cx: number; cy: number; r: number } } {
  switch (el.tagName) {
    case 'path': return { subs: parsePathData(el.getAttribute('d') ?? '') };
    case 'rect': {
      const r = el as SVGRectElement;
      const w = len(r.width), h = len(r.height);
      if (w <= 0 || h <= 0) return { subs: [] };
      const rx = r.hasAttribute('rx') ? len(r.rx) : 0, ry = r.hasAttribute('ry') ? len(r.ry) : 0;
      return { subs: [rectSub(len(r.x), len(r.y), w, h, rx, ry)] };
    }
    case 'circle': {
      const c = el as SVGCircleElement;
      const r = len(c.r);
      if (r <= 0) return { subs: [] };
      return { subs: [ellipseSub(len(c.cx), len(c.cy), r, r)], circle: { cx: len(c.cx), cy: len(c.cy), r } };
    }
    case 'ellipse': {
      const e = el as SVGEllipseElement;
      const rx = len(e.rx), ry = len(e.ry);
      if (rx <= 0 || ry <= 0) return { subs: [] };
      const circle = Math.abs(rx - ry) < 1e-9 ? { cx: len(e.cx), cy: len(e.cy), r: rx } : undefined;
      return { subs: [ellipseSub(len(e.cx), len(e.cy), rx, ry)], circle };
    }
    case 'line': {
      const l = el as SVGLineElement;
      const P = (x: number, y: number): PathNode => ({ x, y, hin: null, hout: null });
      return { subs: [{ closed: false, nodes: [P(len(l.x1), len(l.y1)), P(len(l.x2), len(l.y2))] }] };
    }
    case 'polyline':
    case 'polygon': {
      const s = pointsSub(el.getAttribute('points') ?? '', el.tagName === 'polygon');
      return { subs: s ? [s] : [] };
    }
  }
  return { subs: [] };
}

// ── 色

let colorCtx: CanvasRenderingContext2D | null = null;
/** CSS の色を #rrggbb（半透明なら #rrggbbaa）にする。透明なら null。opacity は別に指定された不透明度 */
function normalizeColor(c: string, opacity = 1): string | null {
  colorCtx ??= document.createElement('canvas').getContext('2d');
  if (!colorCtx) return null;
  colorCtx.fillStyle = '#000000';
  colorCtx.fillStyle = c;
  const v = String(colorCtx.fillStyle);
  let hex: string, alpha = 1;
  if (v.startsWith('#')) hex = v.slice(0, 7);
  else {
    const m = v.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a] = m[1].split(',').map((x) => Number(x.trim()));
    hex = '#' + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('');
    if (Number.isFinite(a)) alpha = a;
  }
  alpha *= Number.isFinite(opacity) ? opacity : 1;
  if (alpha <= 0) return null;
  return joinColor(hex, alpha);
}

const toAffine = (m: DOMMatrix): Affine => ({ a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f });

/** 塗りの指定を、このツールの塗りに置き換える（グラデーションは最初と最後の色の線形にする） */
function resolvePaint(el: SVGGraphicsElement, fill: string, m: Affine, root: SVGSVGElement, fillOpacity: number): Paint | null {
  if (!fill || fill === 'none') return null;
  const url = fill.match(/url\(["']?#([^"')]+)["']?\)/);
  if (!url) {
    const c = normalizeColor(fill, fillOpacity);
    return c ? { type: 'solid', color: c } : null;
  }
  let g = root.querySelector(`[id="${CSS.escape(url[1])}"]`) as SVGGradientElement | null;
  if (!g) return null;
  // 色の段（stop）は href で参照先から引き継げる
  let stopsFrom: SVGGradientElement | null = g;
  for (let k = 0; stopsFrom && !stopsFrom.querySelector('stop') && k < 8; k++) {
    const href: string | null = stopsFrom.getAttribute('href') ?? stopsFrom.getAttribute('xlink:href');
    stopsFrom = href ? (root.querySelector(`[id="${CSS.escape(href.slice(1))}"]`) as SVGGradientElement | null) : null;
  }
  const stops = [...(stopsFrom?.querySelectorAll('stop') ?? [])];
  if (!stops.length) return null;
  const color = (s: Element) => {
    const cs = getComputedStyle(s);
    return normalizeColor(cs.stopColor, Number(cs.stopOpacity) * fillOpacity) ?? '#00000000';
  };
  const c1 = color(stops[0]), c2 = color(stops[stops.length - 1]);
  if (g.tagName !== 'linearGradient' || stops.length === 1) return { type: 'solid', color: c1 };
  const lg = g as SVGLinearGradientElement;
  const bbox = (lg.getAttribute('gradientUnits') ?? 'objectBoundingBox') === 'objectBoundingBox';
  const coord = (name: string, def: number) => {
    const v = lg.getAttribute(name);
    if (!v) return def;
    return v.trim().endsWith('%') ? parseFloat(v) / 100 : parseFloat(v);
  };
  let p1 = { x: coord('x1', 0), y: coord('y1', 0) }, p2 = { x: coord('x2', 1), y: coord('y2', 0) };
  const gt = lg.gradientTransform.baseVal.consolidate()?.matrix;
  if (gt) { p1 = applyAffine(toAffine(gt), p1); p2 = applyAffine(toAffine(gt), p2); }
  if (bbox) {
    const b = el.getBBox();
    p1 = { x: b.x + p1.x * b.width, y: b.y + p1.y * b.height };
    p2 = { x: b.x + p2.x * b.width, y: b.y + p2.y * b.height };
  }
  p1 = applyAffine(m, p1);
  p2 = applyAffine(m, p2);
  return { type: 'linear', color: c1, color2: c2, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
}

/** 変換が回転・一様な拡大縮小・反転だけか（円を円のまま残せるか） */
function isSimilarity(m: Affine): boolean {
  const s1 = Math.hypot(m.a, m.b), s2 = Math.hypot(m.c, m.d);
  return Math.abs(s1 - s2) < 1e-6 * Math.max(1, s1) && Math.abs(m.a * m.c + m.b * m.d) < 1e-6 * Math.max(1, s1 * s2);
}

interface Source { shapes: Shape[]; rule: CanvasFillRule; paint: Paint }

function sourcePath(shapes: Shape[]): Path2D {
  const p = new Path2D();
  for (const s of shapes) {
    let first = true;
    for (const pr of shapePrims(s)) {
      if (pr.kind === 'circle') { p.moveTo(pr.c.x + pr.r, pr.c.y); p.arc(pr.c.x, pr.c.y, pr.r, 0, Math.PI * 2); continue; }
      const a = pr.kind === 'line' ? pr.a : pr.p0;
      if (first) { p.moveTo(a.x, a.y); first = false; }
      if (pr.kind === 'line') p.lineTo(pr.b.x, pr.b.y);
      else p.bezierCurveTo(pr.p1.x, pr.p1.y, pr.p2.x, pr.p2.y, pr.p3.x, pr.p3.y);
    }
    p.closePath();
  }
  return p;
}

export function importSvg(text: string): ImportResult {
  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
  const src = parsed.documentElement;
  if (src.tagName !== 'svg' || parsed.querySelector('parsererror')) throw new Error('SVG として読み込めませんでした');
  sanitize(src);

  // 実際に配置して、ブラウザに座標変換とスタイル（class 指定など）を計算させる
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';
  const root = document.importNode(src, true) as unknown as SVGSVGElement;
  const vb = root.viewBox.baseVal;
  const hasVB = !!root.getAttribute('viewBox') && vb.width > 0 && vb.height > 0;
  const width = hasVB ? vb.width : parseFloat(root.getAttribute('width') ?? '') || 512;
  const height = hasVB ? vb.height : parseFloat(root.getAttribute('height') ?? '') || 512;
  const minX = hasVB ? vb.x : 0, minY = hasVB ? vb.y : 0;
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  holder.append(root);
  document.body.append(holder);

  const skipped = new Map<string, number>();
  const skip = (what: string) => skipped.set(what, (skipped.get(what) ?? 0) + 1);
  let shapeCount = 0, fillCount = 0;
  const hit = document.createElement('canvas').getContext('2d')!;

  try {
    const rootInv = root.getScreenCTM()?.inverse();
    const matrixOf = (el: SVGGraphicsElement): Affine => {
      const sc = el.getScreenCTM();
      if (!sc || !rootInv) return { a: 1, b: 0, c: 0, d: 1, e: -minX, f: -minY };
      const m = rootInv.multiply(sc);
      return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e - minX, f: m.f - minY };
    };
    let layerNo = 0, folderNo = 0;
    const nameOf = (el: Element, fallback: () => string) =>
      el.getAttribute('data-name') || el.getAttribute('inkscape:label') || el.getAttributeNS('http://www.inkscape.org/namespaces/inkscape', 'label') || el.getAttribute('id') || fallback();
    const hidden = (el: Element) => {
      const cs = getComputedStyle(el);
      return cs.display === 'none' || cs.visibility === 'hidden';
    };

    /** 1つのレイヤーに、要素の図形と塗りを集める */
    const fillLayer = (layer: Layer, els: Element[]) => {
      const sources: Source[] = [];
      const visit = (el: Element) => {
        if (hidden(el)) return;
        const tag = el.tagName;
        if (CONTAINERS.has(tag)) { for (const c of el.children) visit(c); return; }
        if (UNSUPPORTED[tag]) { skip(UNSUPPORTED[tag]); return; }
        if (!GEOMETRY.has(tag)) return;
        const g = el as SVGGraphicsElement;
        const m = matrixOf(g);
        const cs = getComputedStyle(g);
        const paint = resolvePaint(g, cs.fill, m, root, Number(cs.fillOpacity));
        const { subs, circle } = elementSubs(g);
        const shapes: Shape[] = [];
        if (circle && isSimilarity(m)) {
          const s: Shape = { id: uid(), type: 'circle', cx: circle.cx, cy: circle.cy, r: circle.r };
          transformShape(s, m);
          shapes.push(s);
        } else
          for (const sub of subs) {
            // 塗る図形は、閉じていなくても閉じたものとして塗られるので、閉じておく
            const s: Shape = { id: uid(), type: 'path', closed: sub.closed || (!!paint && sub.nodes.length >= 3), nodes: sub.nodes };
            transformShape(s, m);
            shapes.push(s);
          }
        layer.shapes.push(...shapes);
        shapeCount += shapes.length;
        if (paint && shapes.length) sources.push({ shapes, rule: cs.fillRule === 'evenodd' ? 'evenodd' : 'nonzero', paint });
      };
      els.forEach(visit);
      // 範囲ごとに、いちばん上に描かれている塗りを付ける
      if (!sources.length) return;
      const paths = sources.map((s) => sourcePath(s.shapes));
      for (const face of computeFaces(layer.shapes)) {
        const p = face.interior;
        for (let k = sources.length - 1; k >= 0; k--) {
          if (hit.isPointInPath(paths[k], p.x, p.y, sources[k].rule)) {
            layer.fills.push({ id: uid(), seed: p, paint: sources[k].paint });
            fillCount++;
            break;
          }
        }
      }
    };

    const build = (parent: Element): LayerNode[] => {
      const out: LayerNode[] = [];
      let loose: Element[] = [];
      const flushLoose = () => {
        if (!loose.length) return;
        const l = newLayer(`レイヤー ${++layerNo}`);
        fillLayer(l, loose);
        if (l.shapes.length) out.push(l);
        loose = [];
      };
      for (const el of [...parent.children]) {
        if (el.tagName === 'g' && !hidden(el)) {
          flushLoose();
          const hasGroups = [...el.children].some((c) => c.tagName === 'g');
          // <g opacity> はレイヤー・フォルダーの不透明度にする
          const op = Number(el.getAttribute('opacity') ?? (el as SVGElement).style?.opacity ?? '');
          const opacity = Number.isFinite(op) && op > 0 && op < 1 ? op : undefined;
          if (hasGroups) {
            const f: Folder = { ...newFolder(nameOf(el, () => `フォルダー ${++folderNo}`)), children: build(el), ...(opacity ? { opacity } : {}) };
            if (f.children.length) out.push(f);
          } else {
            const l = newLayer(nameOf(el, () => `レイヤー ${++layerNo}`));
            if (opacity) l.opacity = opacity;
            fillLayer(l, [...el.children]);
            if (l.shapes.length) out.push(l);
          }
        } else if (GEOMETRY.has(el.tagName) || CONTAINERS.has(el.tagName) || UNSUPPORTED[el.tagName]) loose.push(el);
      }
      flushLoose();
      return out;
    };

    const nodes = build(root);
    return { width, height, nodes, shapes: shapeCount, fills: fillCount, skipped: [...skipped].map(([k, n]) => `${k} ${n}個`) };
  } finally {
    holder.remove();
  }
}
