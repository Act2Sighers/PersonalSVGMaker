import type { Vec } from './types';

export const v = (x: number, y: number): Vec => ({ x, y });
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s });
export const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y;
export const cross = (a: Vec, b: Vec) => a.x * b.y - a.y * b.x;
export const len = (a: Vec) => Math.hypot(a.x, a.y);
export const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Vec, b: Vec, t: number): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** 図形を構成する基本要素。keys はこの要素に影響する点の参照（スナップ除外判定用）。 */
export type Prim =
  | { kind: 'line'; a: Vec; b: Vec; keys: string[] }
  | { kind: 'cubic'; p0: Vec; p1: Vec; p2: Vec; p3: Vec; keys: string[] }
  | { kind: 'circle'; c: Vec; r: number; keys: string[] };

export function cubicAt(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t: number): Vec {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

export function flattenCubic(p0: Vec, p1: Vec, p2: Vec, p3: Vec, n = 48): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i <= n; i++) out.push(cubicAt(p0, p1, p2, p3, i / n));
  return out;
}

export function distToSegment(p: Vec, a: Vec, b: Vec): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 === 0) return dist(p, a);
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return dist(p, add(a, mul(ab, t)));
}

export function distToPrim(p: Vec, pr: Prim): number {
  if (pr.kind === 'line') return distToSegment(p, pr.a, pr.b);
  if (pr.kind === 'circle') return Math.abs(dist(p, pr.c) - pr.r);
  const pts = flattenCubic(pr.p0, pr.p1, pr.p2, pr.p3, 48);
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) best = Math.min(best, distToSegment(p, pts[i], pts[i + 1]));
  return best;
}

/** 無限直線への射影 */
export function projectToLine(p: Vec, a: Vec, b: Vec): Vec {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 === 0) return a;
  return add(a, mul(ab, dot(sub(p, a), ab) / l2));
}

/** 無限直線どうしの交点 */
export function lineLineInfinite(a1: Vec, b1: Vec, a2: Vec, b2: Vec): Vec | null {
  const d1 = sub(b1, a1), d2 = sub(b2, a2);
  const den = cross(d1, d2);
  if (Math.abs(den) < 1e-9) return null;
  const t = cross(sub(a2, a1), d2) / den;
  return add(a1, mul(d1, t));
}

const EPS = 1e-9;

function segSeg(a1: Vec, b1: Vec, a2: Vec, b2: Vec): Vec[] {
  const d1 = sub(b1, a1), d2 = sub(b2, a2);
  const den = cross(d1, d2);
  if (Math.abs(den) < EPS) return [];
  const w = sub(a2, a1);
  const t = cross(w, d2) / den;
  const u = cross(w, d1) / den;
  if (t < -1e-7 || t > 1 + 1e-7 || u < -1e-7 || u > 1 + 1e-7) return [];
  return [add(a1, mul(d1, t))];
}

function segCircle(a: Vec, b: Vec, c: Vec, r: number): Vec[] {
  const d = sub(b, a), f = sub(a, c);
  const A = dot(d, d), B = 2 * dot(f, d), C = dot(f, f) - r * r;
  if (A < EPS) return [];
  const disc = B * B - 4 * A * C;
  if (disc < 0) return [];
  const s = Math.sqrt(disc);
  const out: Vec[] = [];
  for (const t of disc === 0 ? [-B / (2 * A)] : [(-B - s) / (2 * A), (-B + s) / (2 * A)]) {
    if (t >= -1e-7 && t <= 1 + 1e-7) out.push(add(a, mul(d, t)));
  }
  return out;
}

function circleCircle(c1: Vec, r1: number, c2: Vec, r2: number): Vec[] {
  const d = dist(c1, c2);
  if (d < EPS || d > r1 + r2 || d < Math.abs(r1 - r2)) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const m = add(c1, mul(sub(c2, c1), a / d));
  const off = { x: (-(c2.y - c1.y) * h) / d, y: ((c2.x - c1.x) * h) / d };
  return h < 1e-9 ? [m] : [add(m, off), sub(m, off)];
}

/** 3次ベジェと符号付き関数 f の零点を、サンプリング＋二分法で求める */
function cubicRoots(p0: Vec, p1: Vec, p2: Vec, p3: Vec, f: (p: Vec) => number): number[] {
  const N = 96;
  const ts: number[] = [];
  let prevT = 0, prevV = f(p0);
  if (Math.abs(prevV) < 1e-9) ts.push(0);
  for (let i = 1; i <= N; i++) {
    const t = i / N;
    const val = f(cubicAt(p0, p1, p2, p3, t));
    if (Math.abs(val) < 1e-9) ts.push(t);
    else if (prevV * val < 0) {
      let lo = prevT, hi = t, flo = prevV;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        const fm = f(cubicAt(p0, p1, p2, p3, mid));
        if (flo * fm <= 0) hi = mid;
        else { lo = mid; flo = fm; }
      }
      ts.push((lo + hi) / 2);
    }
    prevT = t; prevV = val;
  }
  return ts;
}

function cubicSeg(c: Extract<Prim, { kind: 'cubic' }>, a: Vec, b: Vec): Vec[] {
  const d = sub(b, a);
  const l2 = dot(d, d);
  if (l2 < EPS) return [];
  const ts = cubicRoots(c.p0, c.p1, c.p2, c.p3, (p) => cross(d, sub(p, a)));
  const out: Vec[] = [];
  for (const t of ts) {
    const p = cubicAt(c.p0, c.p1, c.p2, c.p3, t);
    const u = dot(sub(p, a), d) / l2;
    if (u >= -1e-6 && u <= 1 + 1e-6) out.push(p);
  }
  return out;
}

function cubicCircle(c: Extract<Prim, { kind: 'cubic' }>, cc: Vec, r: number): Vec[] {
  return cubicRoots(c.p0, c.p1, c.p2, c.p3, (p) => dist(p, cc) - r).map((t) => cubicAt(c.p0, c.p1, c.p2, c.p3, t));
}

type Bez = [Vec, Vec, Vec, Vec];
function splitBez(b: Bez): [Bez, Bez] {
  const [p0, p1, p2, p3] = b;
  const a = lerp(p0, p1, 0.5), m = lerp(p1, p2, 0.5), c = lerp(p2, p3, 0.5);
  const d = lerp(a, m, 0.5), e = lerp(m, c, 0.5), f = lerp(d, e, 0.5);
  return [[p0, a, d, f], [f, e, c, p3]];
}
function bbox(b: Bez) {
  const xs = b.map((p) => p.x), ys = b.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function cubicCubic(a: Bez, b: Bez): Vec[] {
  const out: Vec[] = [];
  const rec = (p: Bez, q: Bez, depth: number) => {
    if (out.length > 16) return;
    const A = bbox(p), B = bbox(q);
    if (A.x1 < B.x0 || B.x1 < A.x0 || A.y1 < B.y0 || B.y1 < A.y0) return;
    const sizeA = Math.max(A.x1 - A.x0, A.y1 - A.y0), sizeB = Math.max(B.x1 - B.x0, B.y1 - B.y0);
    if ((sizeA < 1e-3 && sizeB < 1e-3) || depth > 40) {
      // 最終段は線分近似で交点を確定
      const hit = segSeg(p[0], p[3], q[0], q[3]);
      out.push(hit[0] ?? lerp(p[0], p[3], 0.5));
      return;
    }
    if (sizeA >= sizeB) {
      const [p1, p2] = splitBez(p);
      rec(p1, q, depth + 1); rec(p2, q, depth + 1);
    } else {
      const [q1, q2] = splitBez(q);
      rec(p, q1, depth + 1); rec(p, q2, depth + 1);
    }
  };
  rec(a, b, 0);
  return out;
}

export function intersect(p: Prim, q: Prim): Vec[] {
  if (p.kind === 'line' && q.kind === 'line') return segSeg(p.a, p.b, q.a, q.b);
  if (p.kind === 'line' && q.kind === 'circle') return segCircle(p.a, p.b, q.c, q.r);
  if (p.kind === 'circle' && q.kind === 'line') return segCircle(q.a, q.b, p.c, p.r);
  if (p.kind === 'circle' && q.kind === 'circle') return circleCircle(p.c, p.r, q.c, q.r);
  if (p.kind === 'cubic' && q.kind === 'line') return cubicSeg(p, q.a, q.b);
  if (p.kind === 'line' && q.kind === 'cubic') return cubicSeg(q, p.a, p.b);
  if (p.kind === 'cubic' && q.kind === 'circle') return cubicCircle(p, q.c, q.r);
  if (p.kind === 'circle' && q.kind === 'cubic') return cubicCircle(q, p.c, p.r);
  if (p.kind === 'cubic' && q.kind === 'cubic') return cubicCubic([p.p0, p.p1, p.p2, p.p3], [q.p0, q.p1, q.p2, q.p3]);
  return [];
}

/** 重複を除いた点集合 */
export function dedupe(pts: Vec[], tol = 1e-4): Vec[] {
  const out: Vec[] = [];
  for (const p of pts) if (!out.some((o) => dist(o, p) < tol)) out.push(p);
  return out;
}

function refineCubic(c: Extract<Prim, { kind: 'cubic' }>, lo: number, hi: number, f: (p: Vec) => number, maximize = false): number {
  // 三分探索で区間内の極値を求める
  for (let k = 0; k < 50; k++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    const f1 = f(cubicAt(c.p0, c.p1, c.p2, c.p3, m1)), f2 = f(cubicAt(c.p0, c.p1, c.p2, c.p3, m2));
    if (maximize ? f1 > f2 : f1 < f2) hi = m2;
    else lo = m1;
  }
  return (lo + hi) / 2;
}

/** 要素上で p に最も近い点 */
export function closestOnPrim(p: Vec, pr: Prim): Vec {
  if (pr.kind === 'line') {
    const ab = sub(pr.b, pr.a);
    const l2 = dot(ab, ab);
    if (l2 === 0) return pr.a;
    return add(pr.a, mul(ab, Math.max(0, Math.min(1, dot(sub(p, pr.a), ab) / l2))));
  }
  if (pr.kind === 'circle') {
    const d = sub(p, pr.c);
    const l = len(d);
    return l < 1e-12 ? { x: pr.c.x + pr.r, y: pr.c.y } : add(pr.c, mul(d, pr.r / l));
  }
  const N = 48;
  let bestT = 0, bestD = Infinity;
  for (let i = 0; i <= N; i++) {
    const d = dist(p, cubicAt(pr.p0, pr.p1, pr.p2, pr.p3, i / N));
    if (d < bestD) { bestD = d; bestT = i / N; }
  }
  const t = refineCubic(pr, Math.max(0, bestT - 1 / N), Math.min(1, bestT + 1 / N), (q) => dist(p, q));
  return cubicAt(pr.p0, pr.p1, pr.p2, pr.p3, t);
}

/**
 * 点 r から要素へ下ろした垂線の足（距離が極小・極大になる点）。
 * 円なら r を中心とする円がその要素に接する点になる。
 */
export function perpendicularFeet(r: Vec, pr: Prim): Vec[] {
  if (pr.kind === 'line') {
    const ab = sub(pr.b, pr.a);
    const l2 = dot(ab, ab);
    if (l2 === 0) return [];
    const t = dot(sub(r, pr.a), ab) / l2;
    return t >= -1e-9 && t <= 1 + 1e-9 ? [add(pr.a, mul(ab, t))] : [];
  }
  if (pr.kind === 'circle') {
    const d = sub(r, pr.c);
    const l = len(d);
    if (l < 1e-9) return [];
    const u = mul(d, pr.r / l);
    return [add(pr.c, u), sub(pr.c, u)];
  }
  const N = 96;
  const f = (q: Vec) => dist(r, q);
  const ds: number[] = [];
  for (let i = 0; i <= N; i++) ds.push(f(cubicAt(pr.p0, pr.p1, pr.p2, pr.p3, i / N)));
  const out: Vec[] = [];
  for (let i = 1; i < N; i++) {
    const isMin = ds[i] <= ds[i - 1] && ds[i] <= ds[i + 1];
    const isMax = ds[i] >= ds[i - 1] && ds[i] >= ds[i + 1];
    if (!isMin && !isMax) continue;
    const t = refineCubic(pr, (i - 1) / N, (i + 1) / N, f, isMax && !isMin);
    out.push(cubicAt(pr.p0, pr.p1, pr.p2, pr.p3, t));
  }
  return dedupe(out, 1e-6);
}

/** 3点を通る円の中心（一直線上なら null） */
export function circumcenter(a: Vec, b: Vec, c: Vec): Vec | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = dot(a, a), b2 = dot(b, b), c2 = dot(c, c);
  return {
    x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d,
    y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d,
  };
}

const TANGENT_EPS = 1e-3;

/**
 * 2つの要素が接している点（交わらずに触れている点）。
 * 接するように描いた図形でも計算誤差で交点が出ないことがあるため、少しの隙間は許容する。
 */
export function tangentPoints(p: Prim, q: Prim): Vec[] {
  if (p.kind === 'circle' && q.kind === 'line') return tangentPoints(q, p);
  if (p.kind === 'line' && q.kind === 'circle') {
    const ab = sub(p.b, p.a);
    const l2 = dot(ab, ab);
    if (l2 < 1e-12) return [];
    const t = dot(sub(q.c, p.a), ab) / l2;
    if (t < -1e-9 || t > 1 + 1e-9) return [];
    const foot = add(p.a, mul(ab, t));
    return Math.abs(dist(foot, q.c) - q.r) < TANGENT_EPS ? [foot] : [];
  }
  if (p.kind === 'circle' && q.kind === 'circle') {
    const d = dist(p.c, q.c);
    if (d < 1e-9) return [];
    const u = mul(sub(q.c, p.c), 1 / d);
    if (Math.abs(d - (p.r + q.r)) < TANGENT_EPS) return [add(p.c, mul(u, p.r))]; // 外接
    if (Math.abs(d - Math.abs(p.r - q.r)) < TANGENT_EPS) return [p.r > q.r ? add(p.c, mul(u, p.r)) : sub(q.c, mul(u, q.r))]; // 内接
    return [];
  }
  if (q.kind === 'cubic' && p.kind !== 'cubic') return tangentPoints(q, p);
  if (p.kind === 'cubic' && q.kind !== 'cubic') {
    // 曲線上の点から相手までの距離が、ほぼ 0 の極小になる所
    const N = 64;
    const f = (pt: Vec) => dist(pt, closestOnPrim(pt, q));
    const ds: number[] = [];
    for (let i = 0; i <= N; i++) ds.push(f(cubicAt(p.p0, p.p1, p.p2, p.p3, i / N)));
    const out: Vec[] = [];
    for (let i = 1; i < N; i++) {
      if (!(ds[i] <= ds[i - 1] && ds[i] <= ds[i + 1]) || ds[i] > 1) continue;
      const t = refineCubic(p, (i - 1) / N, (i + 1) / N, f);
      const pt = cubicAt(p.p0, p.p1, p.p2, p.p3, t);
      if (f(pt) < TANGENT_EPS) out.push(pt);
    }
    return out;
  }
  return [];
}

/** 要素上の点 pt のパラメータ（線分・曲線は 0〜1、円は角度 0〜2π） */
export function paramOnPrim(pr: Prim, pt: Vec): number {
  if (pr.kind === 'line') {
    const ab = sub(pr.b, pr.a);
    const l2 = dot(ab, ab);
    return l2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(pt, pr.a), ab) / l2));
  }
  if (pr.kind === 'circle') {
    const a = Math.atan2(pt.y - pr.c.y, pt.x - pr.c.x);
    return a < 0 ? a + Math.PI * 2 : a;
  }
  const N = 64;
  let bestT = 0, bestD = Infinity;
  for (let i = 0; i <= N; i++) {
    const d = dist(pt, cubicAt(pr.p0, pr.p1, pr.p2, pr.p3, i / N));
    if (d < bestD) { bestD = d; bestT = i / N; }
  }
  return refineCubic(pr, Math.max(0, bestT - 1 / N), Math.min(1, bestT + 1 / N), (q) => dist(pt, q));
}

/** 3次ベジェの t0〜t1 の部分 */
export function subCubic(p0: Vec, p1: Vec, p2: Vec, p3: Vec, t0: number, t1: number): [Vec, Vec, Vec, Vec] {
  const split = (a: Vec, b: Vec, c: Vec, d: Vec, t: number): [[Vec, Vec, Vec, Vec], [Vec, Vec, Vec, Vec]] => {
    const ab = lerp(a, b, t), bc = lerp(b, c, t), cd = lerp(c, d, t);
    const abc = lerp(ab, bc, t), bcd = lerp(bc, cd, t), m = lerp(abc, bcd, t);
    return [[a, ab, abc, m], [m, bcd, cd, d]];
  };
  const [, right] = split(p0, p1, p2, p3, t0);
  if (t1 >= 1) return right;
  const [left] = split(...right, (t1 - t0) / (1 - t0));
  return left;
}
