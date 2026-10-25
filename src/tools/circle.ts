import type { App, Tool } from '../app';
import type { Vec } from '../types';
import type { View } from '../view';
import { regularPolygon, uid } from '../doc';
import { circumcenter, dist, lerp } from '../geom';
import { COLORS } from '../render';
import { button, label, PointPicker, separator, stepper } from './common';

type Method = 'center' | 'diameter' | 'three';

const METHODS: { id: Method; label: string; count: number }[] = [
  { id: 'center', label: '中心と半径', count: 2 },
  { id: 'diameter', label: '直径（2点）', count: 2 },
  { id: 'three', label: '3点を通る', count: 3 },
];

/**
 * 円ツール
 *  - 中心と半径：1点目が中心、2点目までの距離が半径
 *  - 直径：1点目と2点目を直径の両端にする
 *  - 3点を通る：3点すべてを通る円
 * 多角形のときは、中心以外で最初に置いた点が頂点の1つになる。
 */
export class CircleTool implements Tool {
  id = 'circle' as const;
  polygon = false;
  sides = 6;
  method: Method = 'center';
  private pts: Vec[] = [];
  private picker: PointPicker;

  constructor(private app: App) {
    this.picker = new PointPicker(app);
  }

  reset() {
    this.pts = [];
    this.picker.cancel();
  }

  down(s: Vec) {
    this.picker.begin(s, { extraPoints: this.pts, ref: this.pts[this.pts.length - 1] });
  }
  move(s: Vec) {
    this.picker.update(s);
    this.app.requestRender();
  }
  up() {
    const p = this.picker.end();
    if (!p) return;
    if (this.pts.some((q) => dist(q, p) < 1e-6)) {
      this.app.setStatus('同じ位置には置けません');
      return;
    }
    this.pts.push(p);
    const need = METHODS.find((m) => m.id === this.method)!.count;
    if (this.pts.length === need) {
      const g = this.geometry(this.pts);
      this.pts = [];
      if (!g) this.app.setStatus('3点が一直線上にあるため、円を作れません');
      else if (this.polygon)
        this.app.addShape({ id: uid(), type: 'path', closed: true, nodes: regularPolygon(g.c, g.v, this.sides).map((q) => ({ ...q, hin: null, hout: null })) });
      else this.app.addShape({ id: uid(), type: 'circle', cx: g.c.x, cy: g.c.y, r: dist(g.c, g.v) });
    }
    this.app.refreshUI();
  }
  /** 2本指タップ：最後の点を取り消す（残り1点なら作図をやめる） */
  stepBack() {
    if (!this.pts.length) return false;
    if (this.pts.length > 1) this.pts.pop();
    else this.reset();
    this.app.refreshUI();
    return true;
  }

  cancelGesture() {
    this.picker.cancel();
    this.app.requestRender();
  }

  /** 置いた点から中心 c と、円周上の点 v（多角形の頂点）を求める */
  private geometry(pts: Vec[]): { c: Vec; v: Vec } | null {
    if (this.method === 'center' && pts.length >= 2) return { c: pts[0], v: pts[1] };
    if (this.method === 'diameter' && pts.length >= 2) return { c: lerp(pts[0], pts[1], 0.5), v: pts[0] };
    if (this.method === 'three' && pts.length >= 3) {
      const c = circumcenter(pts[0], pts[1], pts[2]);
      return c ? { c, v: pts[0] } : null;
    }
    return null;
  }

  hint() {
    const n = this.pts.length;
    if (this.method === 'center') return n ? (this.polygon ? '頂点の位置をタップ（向きも決まります）' : '半径の位置をタップ') : '中心をタップ';
    if (this.method === 'diameter') return n ? '直径のもう一方の端をタップ' : '直径の一方の端をタップ';
    return ['円が通る1点目をタップ', '2点目をタップ', '3点目をタップ'][n];
  }

  options() {
    const refresh = () => this.app.refreshUI();
    const items: HTMLElement[] = [
      button('真円', () => { this.polygon = false; refresh(); }, { active: !this.polygon }),
      button('多角形', () => { this.polygon = true; refresh(); }, { active: this.polygon }),
    ];
    if (this.polygon) items.push(label('辺の数'), stepper(this.sides, 3, 64, (n) => { this.sides = n; refresh(); }));
    items.push(separator());
    for (const m of METHODS)
      items.push(button(m.label, () => { this.method = m.id; this.reset(); refresh(); }, { active: this.method === m.id }));
    items.push(separator(), button('取消', () => { this.reset(); refresh(); }, { disabled: !this.pts.length }));
    return items;
  }

  overlay(ctx: CanvasRenderingContext2D, view: View) {
    const prev = this.picker.preview;
    const pts = prev && !this.pts.some((q) => dist(q, prev.p) < 1e-6) ? [...this.pts, prev.p] : this.pts;
    const g = this.geometry(pts);
    ctx.strokeStyle = COLORS.draft;
    ctx.lineWidth = 2;
    if (g) {
      const c = view.toScreen(g.c);
      ctx.beginPath();
      if (this.polygon) {
        regularPolygon(g.c, g.v, this.sides)
          .map((q) => view.toScreen(q))
          .forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
        ctx.closePath();
      } else ctx.arc(c.x, c.y, dist(g.c, g.v) * view.zoom, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = COLORS.draft;
      ctx.beginPath(); ctx.arc(c.x, c.y, 3, 0, Math.PI * 2); ctx.fill();
    }
    // 置いた点どうしを補助線で結ぶ
    if (pts.length >= 2) {
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      pts.map((q) => view.toScreen(q)).forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const q of this.pts) {
      const s = view.toScreen(q);
      ctx.fillStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.rect(s.x - 4, s.y - 4, 8, 8); ctx.fill(); ctx.stroke();
    }
    this.picker.draw(ctx, view);
  }

  focus() {
    return this.picker.preview?.p ?? null;
  }
}
