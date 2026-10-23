import type { Doc, PointRef, Settings, Vec } from './types';
import { allShapes, anchorKeys, getPoint, ref, shapePrims } from './doc';
import { dedupe, dist, distToPrim, intersect, lineLineInfinite, projectToLine, type Prim } from './geom';

export type SnapKind = 'point' | 'intersection' | 'extension' | 'grid' | 'free';

export interface SnapResult {
  p: Vec;
  kind: SnapKind;
  /** 延長線スナップのとき表示する補助線 */
  guides: { a: Vec; b: Vec }[];
}

export const SNAP_LABEL: Record<SnapKind, string> = {
  point: '端点',
  intersection: '交点',
  extension: '延長線',
  grid: 'グリッド',
  free: '',
};

export interface SnapOptions {
  /** スナップ対象から外す点（動かしている最中の点など） */
  exclude?: Set<PointRef>;
  /** 作図中の線など、doc にまだ入っていない要素 */
  extraPrims?: Prim[];
  extraPoints?: Vec[];
}

/** ジェスチャー開始時に1回作り、指の移動中はこれを使い回す */
export class SnapContext {
  points: Vec[] = [];
  intersections: Vec[] = [];
  lines: { a: Vec; b: Vec }[] = [];
  prims: Prim[];

  constructor(private doc: Doc, private settings: Settings, opts: SnapOptions = {}) {
    const ex = opts.exclude ?? new Set<PointRef>();
    const prims: Prim[] = [];
    for (const s of allShapes(doc)) {
      for (const k of anchorKeys(s)) {
        if (ex.has(ref(s.id, k))) continue;
        const p = getPoint(s, k);
        if (p) this.points.push(p);
      }
      for (const pr of shapePrims(s)) if (!pr.keys.some((k) => ex.has(k))) prims.push(pr);
    }
    prims.push(...(opts.extraPrims ?? []));
    this.points.push(...(opts.extraPoints ?? []));

    if (settings.snapIntersections) {
      const pts: Vec[] = [];
      for (let i = 0; i < prims.length; i++)
        for (let j = i + 1; j < prims.length; j++) pts.push(...intersect(prims[i], prims[j]));
      // 端点と同じ位置の交点（隣り合う線分のつなぎ目）は端点として扱う
      this.intersections = dedupe(pts).filter((p) => !this.points.some((q) => dist(p, q) < 1e-4));
    }
    for (const pr of prims) if (pr.kind === 'line' && dist(pr.a, pr.b) > 1e-6) this.lines.push({ a: pr.a, b: pr.b });
    this.prims = prims;
  }

  snap(w: Vec, tol: number): SnapResult {
    const st = this.settings;
    let best: SnapResult | null = null;
    let bestD = tol;
    if (st.snapPoints)
      for (const p of this.points) {
        const d = dist(p, w) * 0.85; // 端点を少し優先
        if (d < bestD) { bestD = d; best = { p, kind: 'point', guides: [] }; }
      }
    for (const p of this.intersections) {
      const d = dist(p, w);
      if (d < bestD) { bestD = d; best = { p, kind: 'intersection', guides: [] }; }
    }
    if (best) return best;

    // 延長線はグリッドより明らかに近いときだけ優先する（密なグリッドで線に吸われ過ぎないように）
    const gp = st.snapGrid ? this.gridPoint(w) : null;
    const dg = gp ? dist(gp, w) : Infinity;
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
        return { p: projectToLine(w, l.a, l.b), kind: 'extension', guides: [guide(l, projectToLine(w, l.a, l.b))] };
      }
      // グリッド点がちょうど延長線上にあれば補助線も表示
      if (gp && near.some((n) => dist(projectToLine(gp, n.l.a, n.l.b), gp) < 1e-6)) {
        const l = near.find((n) => dist(projectToLine(gp, n.l.a, n.l.b), gp) < 1e-6)!.l;
        return { p: gp, kind: 'extension', guides: [guide(l, gp)] };
      }
    }
    if (gp) return { p: gp, kind: 'grid', guides: [] };
    return { p: w, kind: 'free', guides: [] };
  }

  /** 線（図形）上にあるか（ヒットテスト用） */
  nearPrim(w: Vec, tol: number) {
    return this.prims.some((p) => distToPrim(w, p) < tol);
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
