import type { Shape, Vec } from './types';
import { shapePrims } from './doc';
import {
  closestOnPrim, cubicAt, dedupe, dist, distToPrim, intersect, paramOnPrim, subCubic, tangentPoints, type Prim,
} from './geom';

/**
 * 線で囲まれた範囲（面）を求める。
 * すべての線を交点・接点で切り分けて平面グラフを作り、各頂点で辺を角度順に並べて
 * 「右に一番きつく曲がる」ように辿ると、各面の境界が1周ずつ得られる。
 */

export type Seg =
  | { kind: 'line'; a: Vec; b: Vec }
  | { kind: 'cubic'; p0: Vec; p1: Vec; p2: Vec; p3: Vec }
  /** 角度 a0 から a1（a1 > a0）へ向かう円弧 */
  | { kind: 'arc'; c: Vec; r: number; a0: number; a1: number };

interface Edge {
  u: number;
  v: number;
  seg: Seg;
  /** この辺の元になった線（`図形ID:区間番号`）。重なった線はまとめる。 */
  src: string[];
}

/** 辺を向き付きで辿ったもの */
export interface Step {
  seg: Seg;
  rev: boolean;
}

export interface Ring {
  steps: Step[];
  poly: Vec[];
  area: number; // 符号付き
}

export interface Face {
  outer: Ring;
  holes: Ring[];
  area: number;
  /** 境界になっている線の集合（形が変わったときの対応付けに使う） */
  sig: Set<string>;
  interior: Vec;
  centroid: Vec;
}

const TAU = Math.PI * 2;
const WELD = 1e-5;

export function segAt(s: Seg, t: number): Vec {
  if (s.kind === 'line') return { x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t };
  if (s.kind === 'cubic') return cubicAt(s.p0, s.p1, s.p2, s.p3, t);
  const a = s.a0 + (s.a1 - s.a0) * t;
  return { x: s.c.x + Math.cos(a) * s.r, y: s.c.y + Math.sin(a) * s.r };
}

function segLength(s: Seg): number {
  if (s.kind === 'line') return dist(s.a, s.b);
  if (s.kind === 'arc') return s.r * (s.a1 - s.a0);
  let l = 0, prev = s.p0;
  for (let i = 1; i <= 16; i++) { const p = segAt(s, i / 16); l += dist(prev, p); prev = p; }
  return l;
}

/** 向きを考慮して辺を折れ線にする（始点は含めない） */
function flattenStep(st: Step, out: Vec[]) {
  const s = st.seg;
  const n = s.kind === 'line' ? 1 : s.kind === 'arc' ? Math.max(4, Math.ceil(((s.a1 - s.a0) / TAU) * 96)) : 24;
  for (let i = 1; i <= n; i++) out.push(segAt(s, st.rev ? 1 - i / n : i / n));
}

function signedArea(poly: Vec[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j].x * poly[i].y - poly[i].x * poly[j].y);
  return a / 2;
}

function polyCentroid(poly: Vec[]): Vec {
  let cx = 0, cy = 0, a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const f = poly[j].x * poly[i].y - poly[i].x * poly[j].y;
    a += f;
    cx += (poly[j].x + poly[i].x) * f;
    cy += (poly[j].y + poly[i].y) * f;
  }
  if (Math.abs(a) < 1e-12) return poly[0] ?? { x: 0, y: 0 };
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

export function pointInPoly(p: Vec, poly: Vec[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function pointInFace(p: Vec, f: Face): boolean {
  return pointInPoly(p, f.outer.poly) && !f.holes.some((h) => pointInPoly(p, h.poly));
}

/** 面の内側にある点（横方向の走査線で一番広く空いている所の中央） */
function interiorPoint(rings: Vec[][]): Vec {
  const all = rings.flat();
  const y0 = Math.min(...all.map((p) => p.y)), y1 = Math.max(...all.map((p) => p.y));
  let best: Vec = all[0], bestW = -1;
  for (const f of [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9, 0.45, 0.55]) {
    const y = y0 + (y1 - y0) * f;
    const xs: number[] = [];
    for (const poly of rings)
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if (a.y > y !== b.y > y) xs.push(((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x);
      }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const w = xs[k + 1] - xs[k];
      if (w > bestW) { bestW = w; best = { x: (xs[k] + xs[k + 1]) / 2, y }; }
    }
  }
  return best;
}

interface SrcPrim { pr: Prim; src: string }

function splitParams(items: SrcPrim[]): number[][] {
  const params: number[][] = items.map(() => []);
  const ends = (pr: Prim): Vec[] => (pr.kind === 'line' ? [pr.a, pr.b] : pr.kind === 'cubic' ? [pr.p0, pr.p3] : []);
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i].pr, b = items[j].pr;
      const pts = dedupe([...intersect(a, b), ...tangentPoints(a, b)], 1e-6);
      // 端点が相手の線の上に乗っている（T字につながっている）場合も切る
      for (const e of ends(a)) if (distToPrim(e, b) < 1e-6) pts.push(closestOnPrim(e, b));
      for (const e of ends(b)) if (distToPrim(e, a) < 1e-6) pts.push(closestOnPrim(e, a));
      for (const p of pts) {
        params[i].push(paramOnPrim(a, p));
        params[j].push(paramOnPrim(b, p));
      }
    }
  return params;
}

function buildEdges(shapes: Shape[]) {
  const items: SrcPrim[] = shapes.flatMap((s) => shapePrims(s).map((pr, i) => ({ pr, src: `${s.id}:${i}` })));
  const params = splitParams(items);

  const verts: Vec[] = [];
  const vid = (p: Vec) => {
    for (let i = 0; i < verts.length; i++) if (dist(verts[i], p) < WELD) return i;
    verts.push(p);
    return verts.length - 1;
  };

  const edges: Edge[] = [];
  const addEdge = (seg: Seg, src: string) => {
    const a = segAt(seg, 0), b = segAt(seg, 1);
    if (segLength(seg) < 1e-6) return;
    const u = vid(a), v = vid(b);
    const mid = segAt(seg, 0.5);
    // 同じ所を通る辺（重なった線）は1本にまとめる
    const dup = edges.find((e) => ((e.u === u && e.v === v) || (e.u === v && e.v === u)) && dist(segAt(e.seg, 0.5), mid) < 1e-4);
    if (dup) { if (!dup.src.includes(src)) dup.src.push(src); return; }
    edges.push({ u, v, seg, src: [src] });
  };

  items.forEach(({ pr, src }, i) => {
    if (pr.kind === 'circle') {
      const ts = [...new Set(params[i].map((t) => +t.toFixed(9)))].sort((a, b) => a - b);
      if (!ts.length) ts.push(0);
      for (let k = 0; k < ts.length; k++) {
        const a0 = ts[k], a1 = k + 1 < ts.length ? ts[k + 1] : ts[0] + TAU;
        addEdge({ kind: 'arc', c: pr.c, r: pr.r, a0, a1 }, src);
      }
      return;
    }
    const ts = [0, 1, ...params[i]].filter((t) => t >= 0 && t <= 1).sort((a, b) => a - b);
    const uniq = ts.filter((t, k) => k === 0 || t - ts[k - 1] > 1e-9);
    for (let k = 0; k + 1 < uniq.length; k++) {
      const t0 = uniq[k], t1 = uniq[k + 1];
      if (pr.kind === 'line') addEdge({ kind: 'line', a: segAt({ kind: 'line', a: pr.a, b: pr.b }, t0), b: segAt({ kind: 'line', a: pr.a, b: pr.b }, t1) }, src);
      else {
        const [p0, p1, p2, p3] = subCubic(pr.p0, pr.p1, pr.p2, pr.p3, t0, t1);
        addEdge({ kind: 'cubic', p0, p1, p2, p3 }, src);
      }
    }
  });
  return { verts, edges };
}

/** 半辺 h（偶数 = 順方向、奇数 = 逆方向）の出発方向の角度 */
function outAngle(e: Edge, rev: boolean, origin: Vec): number {
  const len = segLength(e.seg);
  const t = Math.min(0.05, 2 / Math.max(len, 1e-9));
  const p = segAt(e.seg, rev ? 1 - t : t);
  return Math.atan2(p.y - origin.y, p.x - origin.x);
}

const cache = new Map<string, Face[]>();

/** 図形の集合から面を求める（結果はキャッシュする） */
export function computeFaces(shapes: Shape[]): Face[] {
  const key = JSON.stringify(shapes);
  const hit = cache.get(key);
  if (hit) return hit;
  const faces = computeFacesUncached(shapes);
  if (cache.size > 64) cache.clear();
  cache.set(key, faces);
  return faces;
}

function computeFacesUncached(shapes: Shape[]): Face[] {
  const { verts, edges } = buildEdges(shapes);
  if (!edges.length) return [];

  // 各頂点から出る半辺を角度順に並べる
  const around: number[][] = verts.map(() => []);
  const angle: number[] = [];
  edges.forEach((e, i) => {
    around[e.u].push(2 * i);
    angle[2 * i] = outAngle(e, false, verts[e.u]);
    around[e.v].push(2 * i + 1);
    angle[2 * i + 1] = outAngle(e, true, verts[e.v]);
  });
  for (const list of around) list.sort((a, b) => angle[a] - angle[b]);
  const pos = new Map<number, number>();
  around.forEach((list) => list.forEach((h, k) => pos.set(h, k)));

  const head = (h: number) => (h % 2 === 0 ? edges[h >> 1].v : edges[h >> 1].u);
  const next = (h: number) => {
    const twin = h ^ 1;
    const list = around[head(h)];
    return list[(pos.get(twin)! - 1 + list.length) % list.length];
  };

  // 連結成分（穴の判定に使う）
  const comp = verts.map((_, i) => i);
  const find = (i: number): number => (comp[i] === i ? i : (comp[i] = find(comp[i])));
  for (const e of edges) comp[find(e.u)] = find(e.v);

  const seen = new Set<number>();
  const rings: { ring: Ring; comp: number; sig: Set<string> }[] = [];
  for (let h0 = 0; h0 < edges.length * 2; h0++) {
    if (seen.has(h0)) continue;
    const steps: Step[] = [];
    const sig = new Set<string>();
    const start = verts[h0 % 2 === 0 ? edges[h0 >> 1].u : edges[h0 >> 1].v];
    const poly: Vec[] = [start];
    let h = h0;
    for (let guard = 0; guard < edges.length * 2 + 1 && !seen.has(h); guard++) {
      seen.add(h);
      const e = edges[h >> 1];
      const st = { seg: e.seg, rev: h % 2 === 1 };
      steps.push(st);
      e.src.forEach((s) => sig.add(s));
      flattenStep(st, poly);
      h = next(h);
    }
    poly.pop(); // 始点に戻った点
    rings.push({ ring: { steps, poly, area: signedArea(poly) }, comp: find(edges[h0 >> 1].u), sig });
  }

  // この辿り方では、内側の面は正の面積、連結成分の外周は負の面積になる
  const outers = rings.filter((r) => r.ring.area > 1e-6);
  const holes = rings.filter((r) => r.ring.area < -1e-6);
  const faces = outers.map((r) => ({ r, holes: [] as Ring[] }));
  for (const h of holes) {
    const p = h.ring.poly[0];
    let best: (typeof faces)[number] | null = null;
    for (const f of faces)
      if (f.r.comp !== h.comp && pointInPoly(p, f.r.ring.poly) && (!best || f.r.ring.area < best.r.ring.area)) best = f;
    if (best) best.holes.push(h.ring);
  }
  return faces.map(({ r, holes }) => {
    const area = r.ring.area - holes.reduce((s, h) => s + Math.abs(h.area), 0);
    return {
      outer: r.ring,
      holes,
      area,
      sig: r.sig,
      interior: interiorPoint([r.ring.poly, ...holes.map((h) => h.poly)]),
      centroid: polyCentroid(r.ring.poly),
    };
  });
}

/** 点を含む面（重なる場合は一番小さい面） */
export function faceAt(faces: Face[], p: Vec): Face | null {
  let best: Face | null = null;
  for (const f of faces) if (pointInFace(p, f) && (!best || f.area < best.area)) best = f;
  return best;
}

// ── 描画・書き出し

export function traceFace(ctx: CanvasRenderingContext2D | Path2D, f: Face) {
  for (const ring of [f.outer, ...f.holes]) {
    const s0 = ring.steps[0];
    const p0 = segAt(s0.seg, s0.rev ? 1 : 0);
    ctx.moveTo(p0.x, p0.y);
    for (const st of ring.steps) {
      const s = st.seg;
      if (s.kind === 'line') { const b = st.rev ? s.a : s.b; ctx.lineTo(b.x, b.y); }
      else if (s.kind === 'cubic') {
        if (st.rev) ctx.bezierCurveTo(s.p2.x, s.p2.y, s.p1.x, s.p1.y, s.p0.x, s.p0.y);
        else ctx.bezierCurveTo(s.p1.x, s.p1.y, s.p2.x, s.p2.y, s.p3.x, s.p3.y);
      } else if (st.rev) ctx.arc(s.c.x, s.c.y, s.r, s.a1, s.a0, true);
      else ctx.arc(s.c.x, s.c.y, s.r, s.a0, s.a1, false);
    }
    ctx.closePath();
  }
}

const n3 = (n: number) => String(+n.toFixed(3));

export function faceToPathData(f: Face): string {
  let d = '';
  for (const ring of [f.outer, ...f.holes]) {
    const s0 = ring.steps[0];
    const p0 = segAt(s0.seg, s0.rev ? 1 : 0);
    d += `M${n3(p0.x)} ${n3(p0.y)}`;
    for (const st of ring.steps) {
      const s = st.seg;
      if (s.kind === 'line') { const b = st.rev ? s.a : s.b; d += `L${n3(b.x)} ${n3(b.y)}`; }
      else if (s.kind === 'cubic') {
        const [c1, c2, e] = st.rev ? [s.p2, s.p1, s.p0] : [s.p1, s.p2, s.p3];
        d += `C${n3(c1.x)} ${n3(c1.y)} ${n3(c2.x)} ${n3(c2.y)} ${n3(e.x)} ${n3(e.y)}`;
      } else {
        // SVG の円弧は1つで一周を描けないので、半分ずつに分ける
        const sweep = s.a1 - s.a0;
        const parts = sweep > Math.PI ? 2 : 1;
        for (let k = 1; k <= parts; k++) {
          const t = k / parts;
          const e = segAt(s, st.rev ? 1 - t : t);
          d += `A${n3(s.r)} ${n3(s.r)} 0 0 ${st.rev ? 0 : 1} ${n3(e.x)} ${n3(e.y)}`;
        }
      }
    }
    d += 'Z';
  }
  return d;
}
