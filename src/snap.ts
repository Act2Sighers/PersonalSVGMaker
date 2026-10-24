import type { Doc, Settings, Vec } from './types';
import { allShapes, anchorKeys, getPoint, shapePrims } from './doc';
import { closestOnPrim, dedupe, dist, intersect, lineLineInfinite, perpendicularFeet, projectToLine, type Prim } from './geom';

export type SnapKind = 'point' | 'intersection' | 'perp' | 'online' | 'extension' | 'grid' | 'free';

export interface SnapResult {
  p: Vec;
  kind: SnapKind;
  /** 延長線や垂線のとき表示する補助線 */
  guides: { a: Vec; b: Vec }[];
}

export const SNAP_LABEL: Record<SnapKind, string> = {
  point: '端点',
  intersection: '交点',
  perp: '垂線・接点',
  online: '線上',
  extension: '延長線',
  grid: 'グリッド',
  free: '',
};

export interface SnapOptions {
  /** 作図中の線など、doc にまだ入っていない要素 */
  extraPrims?: Prim[];
  extraPoints?: Vec[];
  /** 直前に置いた点。ここから各線へ下ろした垂線の足（円なら接点）に吸着する */
  ref?: Vec | null;
}

/** ジェスチャー開始時に1回作り、指の移動中はこれを使い回す */
export class SnapContext {
  points: Vec[] = [];
  intersections: Vec[] = [];
  feet: Vec[] = [];
  lines: { a: Vec; b: Vec }[] = [];
  prims: Prim[] = [];
  private ref: Vec | null;

  constructor(private doc: Doc, private settings: Settings, opts: SnapOptions = {}) {
    for (const s of allShapes(doc)) {
      for (const k of anchorKeys(s)) {
        const p = getPoint(s, k);
        if (p) this.points.push(p);
      }
      this.prims.push(...shapePrims(s));
    }
    this.prims.push(...(opts.extraPrims ?? []));
    this.points.push(...(opts.extraPoints ?? []));
    this.ref = opts.ref ?? null;

    if (settings.snapIntersections) {
      const pts: Vec[] = [];
      for (let i = 0; i < this.prims.length; i++)
        for (let j = i + 1; j < this.prims.length; j++) pts.push(...intersect(this.prims[i], this.prims[j]));
      // 端点と同じ位置の交点（隣り合う線分のつなぎ目）は端点として扱う
      this.intersections = dedupe(pts).filter((p) => !this.points.some((q) => dist(p, q) < 1e-4));
    }
    if (settings.snapPerp && this.ref) {
      const r = this.ref;
      this.feet = dedupe(this.prims.flatMap((pr) => perpendicularFeet(r, pr))).filter((p) => dist(p, r) > 1e-6);
    }
    for (const pr of this.prims) if (pr.kind === 'line' && dist(pr.a, pr.b) > 1e-6) this.lines.push({ a: pr.a, b: pr.b });
  }

  snap(w: Vec, tol: number): SnapResult {
    const st = this.settings;
    let best = null as SnapResult | null;
    let bestD = tol;
    const consider = (p: Vec, kind: SnapKind, weight: number, guides: SnapResult['guides'] = []) => {
      const d = dist(p, w) * weight;
      if (d < bestD) { bestD = d; best = { p, kind, guides }; }
    };
    if (st.snapPoints) for (const p of this.points) consider(p, 'point', 0.85); // 端点を少し優先
    for (const p of this.intersections) consider(p, 'intersection', 1);
    if (this.ref) for (const p of this.feet) consider(p, 'perp', 0.95, [{ a: this.ref, b: p }]);
    if (best) return best;

    // 線上・延長線はグリッドより明らかに近いときだけ優先する（密なグリッドで線に吸われ過ぎないように）
    const gp = st.snapGrid ? this.gridPoint(w) : null;
    const dg = gp ? dist(gp, w) : Infinity;

    if (st.snapOnLine) {
      let near: { p: Vec; pr: Prim; d: number } | null = null;
      for (const pr of this.prims) {
        const p = closestOnPrim(w, pr);
        const d = dist(p, w);
        if (d < tol * 0.6 && (!near || d < near.d)) near = { p, pr, d };
      }
      if (near) {
        // グリッド点がちょうどその線の上にあれば、そちらを使う
        if (gp && dg < tol && dist(closestOnPrim(gp, near.pr), gp) < 1e-6) return { p: gp, kind: 'online', guides: [] };
        return { p: near.p, kind: 'online', guides: [] };
      }
    }

    if (st.snapExtensions) {
      const near = this.lines
        .map((l) => ({ l, d: dist(projectToLine(w, l.a, l.b), w) }))
        .filter((x) => x.d < tol * 0.7)
        .sort((a, b) => a.d - b.d);
      if (near.length >= 2) {
        // 2本の延長線の交点
        for (let i = 1; i < near.length; i++) {
          const x = lineLineInfinite(near[0].l.a, near[0].l.b, near[i].l.a, near[i].l.b);
          if (x && dist(x, w) < tol && dist(x, w) < dg * 1.5)
            return { p: x, kind: 'extension', guides: [guide(near[0].l, x), guide(near[i].l, x)] };
        }
      }
      if (near.length >= 1 && near[0].d * 2 < dg) {
        const l = near[0].l;
        const p = projectToLine(w, l.a, l.b);
        return { p, kind: 'extension', guides: [guide(l, p)] };
      }
      // グリッド点がちょうど延長線上にあれば補助線も表示
      const on = gp && near.find((n) => dist(projectToLine(gp, n.l.a, n.l.b), gp) < 1e-6);
      if (gp && on) return { p: gp, kind: 'extension', guides: [guide(on.l, gp)] };
    }
    if (gp) return { p: gp, kind: 'grid', guides: [] };
    return { p: w, kind: 'free', guides: [] };
  }

  gridPoint(w: Vec): Vec {
    const g = this.doc.grid;
    const s = g.spacing;
    return {
      x: g.originX + Math.round((w.x - g.originX) / s) * s,
      y: g.originY + Math.round((w.y - g.originY) / s) * s,
    };
  }
}

/** 線分の近い方の端から点 p までを補助線にする */
function guide(l: { a: Vec; b: Vec }, p: Vec) {
  return { a: dist(l.a, p) < dist(l.b, p) ? l.a : l.b, b: p };
}
