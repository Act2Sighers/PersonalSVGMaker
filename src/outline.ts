import type { Layer, Paint, PathNode, PathShape, Shape, Vec } from './types';
import { newLayer, shapePrims, uid } from './doc';
import { add, cross, cubicAt, dist, distToPrim, dot, len, mul, sub, type Prim } from './geom';
import { fitCurve } from './fit';
import { computeFaces } from './regions';

/**
 * 線の生成（輪郭化）：ベクター線を、指定した太さでなぞった太い線の輪郭に置き換える。
 *  - 丸み：端は半円、角の外側は円弧
 *  - シャープ：端は直角に切り落とし、角の外側は2本の線を延ばして交わる所でとがらせる
 *    （とがった先が太さの4倍を超えて伸びる場合は、先を平らに切り落とす）
 * 輪郭でできた範囲のうち、元の線からの距離が太さの半分以内のものを塗る。
 */

export type JoinStyle = 'round' | 'sharp';

const MITER_LIMIT = 4; // 太さに対する、とがった先の長さの上限

const unit = (v: Vec): Vec => {
  const l = len(v);
  return l < 1e-12 ? { x: 1, y: 0 } : mul(v, 1 / l);
};
/** 進む向きに対して左（画面では y が下向きなので、見た目では右）の法線 */
const normal = (d: Vec): Vec => ({ x: -d.y, y: d.x });

/** 輪郭を少しずつ組み立てる */
class Builder {
  nodes: PathNode[] = [];
  private last(): PathNode | undefined {
    return this.nodes[this.nodes.length - 1];
  }
  moveTo(p: Vec) {
    this.nodes.push({ x: p.x, y: p.y, hin: null, hout: null });
  }
  lineTo(p: Vec) {
    const l = this.last();
    if (l && dist(l, p) < 1e-6) return;
    this.nodes.push({ x: p.x, y: p.y, hin: null, hout: null });
  }
  cubicTo(c1: Vec, c2: Vec, p: Vec) {
    const l = this.last()!;
    if (dist(l, c1) < 1e-9 && dist(c2, p) < 1e-9) return this.lineTo(p);
    l.hout = c1;
    this.nodes.push({ x: p.x, y: p.y, hin: c2, hout: null });
  }
  /** 中心 c・半径 r の円弧を、a0 から a1 へ（角度はラジアン、向きは a1 - a0 の符号のまま） */
  arc(c: Vec, r: number, a0: number, a1: number) {
    const sweep = a1 - a0;
    const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
    const d = sweep / n;
    const k = (4 / 3) * Math.tan(d / 4);
    for (let i = 0; i < n; i++) {
      const s = a0 + d * i, e = s + d;
      const ps = { x: c.x + r * Math.cos(s), y: c.y + r * Math.sin(s) };
      const pe = { x: c.x + r * Math.cos(e), y: c.y + r * Math.sin(e) };
      this.cubicTo(
        { x: ps.x - k * r * Math.sin(s), y: ps.y + k * r * Math.cos(s) },
        { x: pe.x + k * r * Math.sin(e), y: pe.y - k * r * Math.cos(e) },
        pe,
      );
    }
  }
  /** 閉じた図形にする（最後の点が始点と重なっていればまとめる） */
  close(): PathShape | null {
    const n = this.nodes;
    if (n.length > 2 && dist(n[0], n[n.length - 1]) < 1e-6) { n[0].hin = n[n.length - 1].hin; n.pop(); }
    return n.length >= 2 ? { id: uid(), type: 'path', closed: true, nodes: n } : null;
  }
}

/** 区間の向き：始点で進む向き・終点で進む向き */
function startDir(p: Prim): Vec {
  if (p.kind === 'line') return unit(sub(p.b, p.a));
  if (p.kind === 'cubic') {
    const d = sub(p.p1, p.p0);
    if (len(d) > 1e-9) return unit(d);
    const d2 = sub(p.p2, p.p0);
    return unit(len(d2) > 1e-9 ? d2 : sub(p.p3, p.p0));
  }
  return { x: 1, y: 0 };
}
function endDir(p: Prim): Vec {
  if (p.kind === 'line') return unit(sub(p.b, p.a));
  if (p.kind === 'cubic') {
    const d = sub(p.p3, p.p2);
    if (len(d) > 1e-9) return unit(d);
    const d2 = sub(p.p3, p.p1);
    return unit(len(d2) > 1e-9 ? d2 : sub(p.p3, p.p0));
  }
  return { x: 1, y: 0 };
}
const startPt = (p: Prim): Vec => (p.kind === 'line' ? p.a : p.kind === 'cubic' ? p.p0 : p.c);
const endPt = (p: Prim): Vec => (p.kind === 'line' ? p.b : p.kind === 'cubic' ? p.p3 : p.c);

/** 区間を、法線方向に off だけずらして輪郭に足す（始点はすでに置いてある前提） */
function offsetSegment(b: Builder, p: Prim, off: number) {
  if (p.kind === 'line') {
    b.lineTo(add(p.b, mul(normal(unit(sub(p.b, p.a))), off)));
    return;
  }
  if (p.kind !== 'cubic') return;
  // 曲線をずらした形は3次ベジェにならないので、細かく取った点に曲線を当てはめ直す
  const approxLen = dist(p.p0, p.p1) + dist(p.p1, p.p2) + dist(p.p2, p.p3);
  const n = Math.max(12, Math.min(200, Math.ceil(approxLen / 3)));
  const pts: Vec[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const q = cubicAt(p.p0, p.p1, p.p2, p.p3, t);
    const ta = Math.max(0, t - 1e-3), tb = Math.min(1, t + 1e-3);
    const dir = unit(sub(cubicAt(p.p0, p.p1, p.p2, p.p3, tb), cubicAt(p.p0, p.p1, p.p2, p.p3, ta)));
    pts.push(add(q, mul(normal(dir), off)));
  }
  pts[0] = add(p.p0, mul(normal(startDir(p)), off));
  pts[n] = add(p.p3, mul(normal(endDir(p)), off));
  const tol = Math.max(0.15, Math.abs(off) * 0.02);
  for (const c of fitCurve(pts, startDir(p), mul(endDir(p), -1), tol)) b.cubicTo(c[1], c[2], c[3]);
}

/** 頂点 v で、前の区間（向き da）から次の区間（向き db）へ、off 側の輪郭をつなぐ */
function join(b: Builder, v: Vec, da: Vec, db: Vec, off: number, style: JoinStyle) {
  const r = Math.abs(off);
  const na = mul(normal(da), off), nb = mul(normal(db), off);
  const pa = add(v, na), pb = add(v, nb);
  const turn = cross(da, db);
  // ほぼまっすぐなら、そのままつなぐ
  if (Math.abs(turn) < 1e-6 && dot(da, db) > 0) { b.lineTo(pb); return; }
  // off 側が曲がる内側なら、輪郭は重なり合うので短くつなぐだけ（重なった所も線の内側として塗られる）
  const inner = turn * off > 0;
  if (inner) { b.lineTo(v); b.lineTo(pb); return; }
  if (style === 'round') {
    let a0 = Math.atan2(na.y, na.x), a1 = Math.atan2(nb.y, nb.x);
    // 外側をまわる向きにする
    let sweep = a1 - a0;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
    a1 = a0 + sweep;
    b.arc(v, r, a0, a1);
    return;
  }
  // シャープ：2本のずらした線を延ばして交わる所
  const den = cross(da, db);
  const t = cross(sub(pb, pa), db) / den;
  const m = add(pa, mul(da, t));
  if (dist(m, v) > MITER_LIMIT * 2 * r) b.lineTo(pb);
  else { b.lineTo(m); b.lineTo(pb); }
}

/** 端の処理：丸みは半円、シャープは直角に切り落とす */
function cap(b: Builder, v: Vec, dir: Vec, off: number, style: JoinStyle) {
  const to = add(v, mul(normal(dir), -off));
  if (style === 'sharp') { b.lineTo(to); return; }
  const n = mul(normal(dir), off);
  const a0 = Math.atan2(n.y, n.x);
  // 進む向きの前方をまわる半円
  const fwd = Math.atan2(dir.y, dir.x);
  let mid = fwd - a0;
  while (mid > Math.PI) mid -= 2 * Math.PI;
  while (mid < -Math.PI) mid += 2 * Math.PI;
  b.arc(v, Math.abs(off), a0, a0 + (mid >= 0 ? Math.PI : -Math.PI));
}

function reversePrim(p: Prim): Prim {
  if (p.kind === 'line') return { ...p, a: p.b, b: p.a };
  if (p.kind === 'cubic') return { ...p, p0: p.p3, p1: p.p2, p2: p.p1, p3: p.p0 };
  return p;
}

/** 片側の輪郭を、区間の並びに沿って足していく（始点は置いてある前提）。closed なら最後に始点へのつなぎも足す */
function side(b: Builder, segs: Prim[], off: number, style: JoinStyle, closed: boolean) {
  segs.forEach((s, i) => {
    offsetSegment(b, s, off);
    const next = segs[i + 1] ?? (closed ? segs[0] : null);
    if (next) join(b, endPt(s), endDir(s), startDir(next), off, style);
  });
}

function outlinePath(s: PathShape, half: number, style: JoinStyle): Shape[] {
  const segs = shapePrims(s).filter((p) => p.kind !== 'circle' && dist(startPt(p), endPt(p)) + (p.kind === 'cubic' ? dist(p.p0, p.p1) + dist(p.p2, p.p3) : 0) > 1e-6);
  if (!segs.length) return [];
  if (s.closed) {
    // 閉じた線は、外側と内側の2本の輪郭になる
    const out: Shape[] = [];
    for (const off of [half, -half]) {
      const b = new Builder();
      b.moveTo(add(startPt(segs[0]), mul(normal(startDir(segs[0])), off)));
      side(b, segs, off, style, true);
      const c = b.close();
      if (c) out.push(c);
    }
    return out;
  }
  // 開いた線：片側 → 終点の端 → 反対側を戻る → 始点の端 で1周
  const b = new Builder();
  b.moveTo(add(startPt(segs[0]), mul(normal(startDir(segs[0])), half)));
  side(b, segs, half, style, false);
  const last = segs[segs.length - 1];
  cap(b, endPt(last), endDir(last), half, style);
  const back = segs.map(reversePrim).reverse();
  side(b, back, half, style, false);
  cap(b, endPt(back[back.length - 1]), endDir(back[back.length - 1]), half, style);
  const c = b.close();
  return c ? [c] : [];
}

export interface StrokeOptions {
  width: number;
  style: JoinStyle;
  color: string;
}

/** レイヤーの線から、太い線の輪郭と塗りを持つ新しいレイヤーを作る */
export function strokeLayer(src: Layer, opt: StrokeOptions): Layer | null {
  const half = opt.width / 2;
  if (!(half > 0)) return null;
  const shapes: Shape[] = [];
  for (const s of src.shapes) {
    if (s.type === 'circle') {
      shapes.push({ id: uid(), type: 'circle', cx: s.cx, cy: s.cy, r: s.r + half });
      if (s.r - half > 1e-6) shapes.push({ id: uid(), type: 'circle', cx: s.cx, cy: s.cy, r: s.r - half });
    } else shapes.push(...outlinePath(s, half, opt.style));
  }
  if (!shapes.length) return null;
  const layer = newLayer(`${src.name} の線`);
  layer.shapes = shapes;
  // 元の線から太さの半分以内にある範囲だけを塗る
  const prims = src.shapes.flatMap(shapePrims);
  const near = (p: Vec) => prims.some((pr) => distToPrim(p, pr) <= half + Math.max(0.5, half * 0.05));
  const paint: Paint = { type: 'solid', color: opt.color };
  for (const f of computeFaces(shapes)) if (near(f.interior)) layer.fills.push({ id: uid(), seed: f.interior, paint });
  return layer;
}
