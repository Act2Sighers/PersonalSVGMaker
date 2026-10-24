import type { PathNode, Shape, Vec } from './types';
import { add, cubicAt, dist, distToSegment, dot, len, mul, sub } from './geom';
import { uid } from './doc';

/**
 * 手描きの線を直線・曲線・円に置き換える。
 * 単位はすべてワールド座標。px は「画面上の1px がワールドでいくつか」で、指の大きさに合わせた許容誤差に使う。
 */

export type FreehandMode = 'even' | 'corner';

export interface FitOptions {
  mode: FreehandMode;
  /** 等間隔モードの区切りの長さ（ワールド座標） */
  interval: number;
  px: number;
  /** 線が必ず通る点（既存の点や交点）。null でない位置で区切る */
  forced: (Vec | null)[];
}

const unit = (v: Vec): Vec => {
  const l = len(v);
  return l < 1e-12 ? { x: 1, y: 0 } : mul(v, 1 / l);
};

/** 近すぎる点を除き、指定間隔で並べ直す */
export function resample(pts: Vec[], step: number): Vec[] {
  if (pts.length < 2) return pts.slice();
  const out: Vec[] = [pts[0]];
  let prev = pts[0];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    let a = prev;
    const b = pts[i];
    let d = dist(a, b);
    while (carry + d >= step) {
      const t = (step - carry) / d;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      out.push(p);
      a = p;
      d = dist(a, b);
      carry = 0;
    }
    carry += d;
    prev = b;
  }
  const last = pts[pts.length - 1];
  if (dist(out[out.length - 1], last) > step * 0.3) out.push(last);
  else out[out.length - 1] = last;
  return out;
}

/** 指の震えを抑える軽い平滑化（端は動かさない） */
export function smooth(pts: Vec[], passes = 2): Vec[] {
  let p = pts;
  for (let k = 0; k < passes; k++) {
    p = p.map((q, i) => (i === 0 || i === p.length - 1 ? q : { x: (p[i - 1].x + 2 * q.x + p[i + 1].x) / 4, y: (p[i - 1].y + 2 * q.y + p[i + 1].y) / 4 }));
  }
  return p;
}

function turnAngle(a: Vec, b: Vec, c: Vec): number {
  const u = sub(b, a), v = sub(c, b);
  if (len(u) < 1e-9 || len(v) < 1e-9) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot(u, v) / (len(u) * len(v)))));
}

/**
 * 角の検出。狭い幅と広い幅で曲がる角度を測り、
 * 狭い幅でも大きく曲がっていて（50°以上）、広い幅でもあまり増えない所を角とする。
 * カーブは幅を広げるほど曲がる角度が増えるので、角と区別できる。
 */
export function findCorners(p: Vec[], k: number): number[] {
  const n = p.length;
  const turn = (i: number, w: number) => turnAngle(p[Math.max(0, i - w)], p[i], p[Math.min(n - 1, i + w)]);
  const cand: { i: number; t: number }[] = [];
  for (let i = k; i < n - k; i++) {
    const t1 = turn(i, k);
    if (t1 < (50 * Math.PI) / 180) continue;
    const t2 = turn(i, 2 * k);
    if (t1 >= t2 * 0.7) cand.push({ i, t: t1 });
  }
  // 近くの候補からは、一番鋭い所だけを残す
  const out: number[] = [];
  for (const c of cand.sort((a, b) => b.t - a.t)) if (out.every((j) => Math.abs(j - c.i) > k * 1.5)) out.push(c.i);
  return out.sort((a, b) => a - b);
}

function chordParams(pts: Vec[]): number[] {
  const u = [0];
  for (let i = 1; i < pts.length; i++) u.push(u[i - 1] + dist(pts[i - 1], pts[i]));
  const total = u[u.length - 1] || 1;
  return u.map((x) => x / total);
}

/** 曲線上で、点 p に最も近いパラメータへ近づける（ニュートン法を1回） */
function newton(c: Vec[], p: Vec, t: number): number {
  const [p0, p1, p2, p3] = c;
  const u = 1 - t;
  const q = cubicAt(p0, p1, p2, p3, t);
  const d1 = add(add(mul(sub(p1, p0), 3 * u * u), mul(sub(p2, p1), 6 * u * t)), mul(sub(p3, p2), 3 * t * t));
  const d2 = add(mul(add(sub(p2, mul(p1, 2)), p0), 6 * u), mul(add(sub(p3, mul(p2, 2)), p1), 6 * t));
  const diff = sub(q, p);
  const den = dot(d1, d1) + dot(diff, d2);
  if (Math.abs(den) < 1e-12) return t;
  return Math.max(0, Math.min(1, t - dot(diff, d1) / den));
}

/** 両端と両端の接線方向を固定して、点列に最も合う3次ベジェを求める（Schneider の方法） */
function fitCubicFixed(pts: Vec[], t1: Vec, t2: Vec): { c: Vec[]; err: number; worst: number } {
  const p0 = pts[0], p3 = pts[pts.length - 1];
  const segLen = dist(p0, p3);
  let u = chordParams(pts);
  let best: { c: Vec[]; err: number; worst: number } | null = null;
  for (let iter = 0; iter < 4; iter++) {
    let c11 = 0, c12 = 0, c22 = 0, x1 = 0, x2 = 0;
    for (let i = 0; i < pts.length; i++) {
      const t = u[i], s = 1 - t;
      const b0 = s * s * s, b1 = 3 * s * s * t, b2 = 3 * s * t * t, b3 = t * t * t;
      const a1 = mul(t1, b1), a2 = mul(t2, b2);
      c11 += dot(a1, a1); c12 += dot(a1, a2); c22 += dot(a2, a2);
      const tmp = sub(pts[i], add(mul(p0, b0 + b1), mul(p3, b2 + b3)));
      x1 += dot(tmp, a1); x2 += dot(tmp, a2);
    }
    const det = c11 * c22 - c12 * c12;
    let al1 = Math.abs(det) > 1e-12 ? (x1 * c22 - x2 * c12) / det : 0;
    let al2 = Math.abs(det) > 1e-12 ? (c11 * x2 - c12 * x1) / det : 0;
    if (al1 < segLen * 1e-3 || al2 < segLen * 1e-3) al1 = al2 = segLen / 3;
    const c = [p0, add(p0, mul(t1, al1)), add(p3, mul(t2, al2)), p3];
    let err = 0, worst = Math.floor(pts.length / 2);
    for (let i = 1; i < pts.length - 1; i++) {
      const d = dist(cubicAt(c[0], c[1], c[2], c[3], u[i]), pts[i]);
      if (d > err) { err = d; worst = i; }
    }
    if (!best || err < best.err) best = { c, err, worst };
    u = u.map((t, i) => newton(c, pts[i], t));
  }
  return best!;
}

function tangentAt(p: Vec[], i: number, k: number): Vec {
  return unit(sub(p[Math.min(p.length - 1, i + k)], p[Math.max(0, i - k)]));
}

const isStraight = (pts: Vec[], tol: number) => {
  const a = pts[0], b = pts[pts.length - 1];
  return pts.every((q) => distToSegment(q, a, b) <= tol);
};

/** 最小二乗法で円を当てはめる */
function fitCircle(pts: Vec[]): { c: Vec; r: number; rms: number } | null {
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n, my = pts.reduce((s, p) => s + p.y, 0) / n;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of pts) {
    const u = p.x - mx, v = p.y - my;
    suu += u * u; svv += v * v; suv += u * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-12) return null;
  const r1 = (suuu + suvv) / 2, r2 = (svvv + svuu) / 2;
  const uc = (r1 * svv - r2 * suv) / det, vc = (suu * r2 - suv * r1) / det;
  const c = { x: uc + mx, y: vc + my };
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  const rms = Math.sqrt(pts.reduce((s, p) => s + (dist(p, c) - r) ** 2, 0) / n);
  return { c, r, rms };
}

/** 閉じていて、ほぼ一周する円か */
function asCircle(pts: Vec[], px: number): { c: Vec; r: number } | null {
  if (pts.length < 12) return null;
  const length = pts.reduce((s, p, i) => (i ? s + dist(pts[i - 1], p) : 0), 0);
  if (dist(pts[0], pts[pts.length - 1]) > Math.max(20 * px, length * 0.12)) return null;
  const f = fitCircle(pts);
  if (!f || f.r < 4 * px || f.rms > f.r * 0.09) return null;
  // 中心のまわりを回った角度
  let sweep = 0;
  for (let i = 1; i < pts.length; i++) {
    let a = Math.atan2(pts[i].y - f.c.y, pts[i].x - f.c.x) - Math.atan2(pts[i - 1].y - f.c.y, pts[i - 1].x - f.c.x);
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    sweep += a;
  }
  return Math.abs(sweep) > Math.PI * 1.65 ? f : null;
}

/** 曲線を誤差が収まるまで分割しながら当てはめる。区間の内部のつなぎ目は滑らかにする。 */
function fitCurveRecursive(pts: Vec[], t1: Vec, t2: Vec, tol: number, k: number, depth = 0): Vec[][] {
  const f = fitCubicFixed(pts, t1, t2);
  if (f.err <= tol || pts.length < 8 || depth > 6) return [f.c];
  const m = Math.max(3, Math.min(pts.length - 4, f.worst));
  const tm = tangentAt(pts, m, Math.max(1, Math.min(k, m, pts.length - 1 - m)));
  return [
    ...fitCurveRecursive(pts.slice(0, m + 1), t1, mul(tm, -1), tol, k, depth + 1),
    ...fitCurveRecursive(pts.slice(m), tm, t2, tol, k, depth + 1),
  ];
}

type Piece = { kind: 'line'; a: Vec; b: Vec } | { kind: 'cubic'; c: Vec[] };

/** 区切った部分の並びを、1本のパスの頂点列にする */
function piecesToNodes(pieces: Piece[]): PathNode[] {
  const nodes: PathNode[] = [];
  for (const pc of pieces) {
    const a = pc.kind === 'line' ? pc.a : pc.c[0];
    const b = pc.kind === 'line' ? pc.b : pc.c[3];
    if (!nodes.length) nodes.push({ x: a.x, y: a.y, hin: null, hout: null });
    const last = nodes[nodes.length - 1];
    if (pc.kind === 'cubic') last.hout = pc.c[1];
    nodes.push({ x: b.x, y: b.y, hin: pc.kind === 'cubic' ? pc.c[2] : null, hout: null });
  }
  return nodes;
}

function nodesToShape(nodes: PathNode[], px: number): Shape | null {
  if (nodes.length < 2) return null;
  const first = nodes[0], last = nodes[nodes.length - 1];
  // 始点に戻っていれば閉じた図形にする
  if (nodes.length > 2 && dist(first, last) < 2 * px) {
    first.hin = last.hin ? add(last.hin, sub(first, last)) : null;
    nodes.pop();
    return { id: uid(), type: 'path', closed: true, nodes };
  }
  return { id: uid(), type: 'path', closed: false, nodes };
}

/**
 * 手描きの点列を図形に変換する。
 * pts は既に平滑化・等間隔化したもの。forced[i] があれば、pts[i] の位置でそこを通るように区切る。
 */
export function fitStroke(pts: Vec[], opt: FitOptions): Shape[] {
  const n = pts.length;
  if (n < 2) return [];
  const px = opt.px;
  const step = dist(pts[0], pts[1]) || px;
  const k = Math.max(2, Math.round((12 * px) / step));
  const lineTol = (a: Vec[]) => Math.max(3 * px, 0.035 * dist(a[0], a[a.length - 1]));
  const curveTol = 2.5 * px;

  // 必ず通る点の位置に揃える
  const p = pts.map((q, i) => opt.forced[i] ?? q);
  const forcedIdx = opt.forced.map((f, i) => (f ? i : -1)).filter((i) => i > 0 && i < n - 1);

  if (opt.mode === 'corner') {
    const corners = new Set(findCorners(p, k));
    const cuts = [...new Set([0, ...corners, ...forcedIdx, n - 1])].sort((a, b) => a - b);
    const shapes: Shape[] = [];
    let pieces: Piece[] = [];
    const flush = () => {
      const s = nodesToShape(piecesToNodes(pieces), px);
      if (s) shapes.push(s);
      pieces = [];
    };
    for (let j = 0; j + 1 < cuts.length; j++) {
      const i0 = cuts[j], i1 = cuts[j + 1];
      const seg = p.slice(i0, i1 + 1);
      if (seg.length < 2) continue;
      const circ = asCircle(seg, px);
      if (circ) {
        flush();
        // 区切りの点を円が通るようにして、前後の線とつながるようにする
        const through = cuts.length > 2 ? seg[0] : null;
        shapes.push({ id: uid(), type: 'circle', cx: circ.c.x, cy: circ.c.y, r: through ? dist(circ.c, through) : circ.r });
        continue;
      }
      if (isStraight(seg, lineTol(seg))) { pieces.push({ kind: 'line', a: seg[0], b: seg[seg.length - 1] }); continue; }
      // 角では接線を合わせない。必ず通る点（角ではない所）では、前後を滑らかにつなぐ。
      const smoothStart = forcedIdx.includes(i0) && !corners.has(i0);
      const smoothEnd = forcedIdx.includes(i1) && !corners.has(i1);
      const w = Math.max(1, Math.min(k, Math.floor((seg.length - 1) / 3)));
      const t1 = smoothStart ? tangentAt(p, i0, k) : unit(sub(seg[w], seg[0]));
      const t2 = smoothEnd ? mul(tangentAt(p, i1, k), -1) : unit(sub(seg[seg.length - 1 - w], seg[seg.length - 1]));
      for (const c of fitCurveRecursive(seg, t1, t2, curveTol, k)) pieces.push({ kind: 'cubic', c });
    }
    flush();
    return shapes;
  }

  // 等間隔モード：必ず通る点の間を、決めた長さに近い長さで等分する
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + dist(p[i - 1], p[i]));
  const anchors = [0, ...forcedIdx, n - 1];
  const cuts: number[] = [0];
  for (let j = 0; j + 1 < anchors.length; j++) {
    const a = anchors[j], b = anchors[j + 1];
    const L = cum[b] - cum[a];
    const parts = Math.max(1, Math.round(L / opt.interval));
    let idx = a;
    for (let q = 1; q < parts; q++) {
      const target = cum[a] + (L * q) / parts;
      while (idx < b && cum[idx] < target) idx++;
      if (idx > cuts[cuts.length - 1] + 1 && idx < b) cuts.push(idx);
    }
    if (b > cuts[cuts.length - 1]) cuts.push(b);
  }
  const segs = cuts.slice(0, -1).map((c, j) => p.slice(c, cuts[j + 1] + 1));
  const straight = segs.map((s) => isStraight(s, lineTol(s)));
  // 区切り点ごとの接線：直線に接していればその向き、そうでなければ描いた線の向き
  const closed = dist(p[0], p[n - 1]) < 2 * px;
  const tangents = cuts.map((ci, j) => {
    const before = j > 0 ? segs[j - 1] : closed ? segs[segs.length - 1] : null;
    const after = j < segs.length ? segs[j] : closed ? segs[0] : null;
    const bi = j > 0 ? j - 1 : segs.length - 1, ai = j < segs.length ? j : 0;
    if (before && straight[bi]) return unit(sub(before[before.length - 1], before[0]));
    if (after && straight[ai]) return unit(sub(after[after.length - 1], after[0]));
    if (j === 0 && !closed) return unit(sub(p[Math.min(n - 1, k)], p[0]));
    if (j === cuts.length - 1 && !closed) return unit(sub(p[n - 1], p[Math.max(0, n - 1 - k)]));
    return closed && (j === 0 || j === cuts.length - 1) ? unit(sub(p[Math.min(n - 1, k)], p[Math.max(0, n - 1 - k)])) : tangentAt(p, ci, k);
  });
  const pieces: Piece[] = segs.map((s, j) =>
    straight[j] ? { kind: 'line', a: s[0], b: s[s.length - 1] } : { kind: 'cubic', c: fitCubicFixed(s, tangents[j], mul(tangents[j + 1], -1)).c },
  );
  const shape = nodesToShape(piecesToNodes(pieces), px);
  return shape ? [shape] : [];
}
