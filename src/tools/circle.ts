import type { App, Tool } from '../app';
import type { Vec } from '../types';
import type { View } from '../view';
import { regularPolygon, uid } from '../doc';
import { dist } from '../geom';
import { COLORS } from '../render';
import { button, label, PointPicker, separator, stepper } from './common';

/** 円ツール：中心 → 半径の点 の順にタップ。多角形モードでは2点目が頂点の1つになる。 */
export class CircleTool implements Tool {
  id = 'circle' as const;
  polygon = false;
  sides = 6;
  private center: Vec | null = null;
  private picker: PointPicker;

  constructor(private app: App) {
    this.picker = new PointPicker(app);
  }

  reset() {
    this.center = null;
    this.picker.cancel();
  }

  down(s: Vec) {
    this.picker.begin(s, { extraPoints: this.center ? [this.center] : [] });
  }
  move(s: Vec) {
    this.picker.update(s);
    this.app.requestRender();
  }
  up() {
    const p = this.picker.end();
    if (!p) return;
    if (!this.center) this.center = p;
    else if (dist(p, this.center) > 1e-6) {
      const c = this.center;
      this.center = null;
      if (this.polygon)
        this.app.addShape({ id: uid(), type: 'path', closed: true, nodes: regularPolygon(c, p, this.sides).map((q) => ({ ...q, hin: null, hout: null })) });
      else this.app.addShape({ id: uid(), type: 'circle', cx: c.x, cy: c.y, r: dist(c, p) });
    }
    this.app.refreshUI();
  }
  cancelGesture() {
    this.picker.cancel();
    this.app.requestRender();
  }

  hint() {
    if (!this.center) return '中心をタップ';
    return this.polygon ? '頂点の位置をタップ（向きも決まります）' : '半径の位置をタップ';
  }

  options() {
    const set = (poly: boolean) => { this.polygon = poly; this.app.refreshUI(); };
    const items: HTMLElement[] = [
      button('真円', () => set(false), { active: !this.polygon }),
      button('多角形', () => set(true), { active: this.polygon }),
    ];
    if (this.polygon) items.push(label('辺の数'), stepper(this.sides, 3, 64, (n) => { this.sides = n; this.app.refreshUI(); }));
    items.push(separator(), button('取消', () => { this.reset(); this.app.refreshUI(); }, { disabled: !this.center }));
    return items;
  }

  overlay(ctx: CanvasRenderingContext2D, view: View) {
    const prev = this.picker.preview;
    if (this.center) {
      const c = view.toScreen(this.center);
      ctx.strokeStyle = COLORS.draft;
      ctx.lineWidth = 2;
      if (prev && dist(prev.p, this.center) > 1e-6) {
        const e = view.toScreen(prev.p);
        ctx.beginPath();
        if (this.polygon) {
          const pts = regularPolygon(this.center, prev.p, this.sides).map((q) => view.toScreen(q));
          pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
          ctx.closePath();
        } else ctx.arc(c.x, c.y, dist(c, e), 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(e.x, e.y); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = COLORS.draft;
      ctx.beginPath(); ctx.arc(c.x, c.y, 4, 0, Math.PI * 2); ctx.fill();
    }
    this.picker.draw(ctx, view);
  }

  focus() {
    return this.picker.preview?.p ?? null;
  }
}
