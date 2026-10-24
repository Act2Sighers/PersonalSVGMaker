import type { App, Tool } from '../app';
import type { Vec } from '../types';
import type { View } from '../view';
import { uid } from '../doc';
import { dist, type Prim } from '../geom';
import { COLORS } from '../render';
import { button, PointPicker, separator } from './common';

/** 直線ツール：タップした点を順に結ぶ。始点をタップで閉じ、最後の点をもう一度タップで完了。 */
export class LineTool implements Tool {
  id = 'line' as const;
  single = false;
  private pts: Vec[] = [];
  private picker: PointPicker;

  constructor(private app: App) {
    this.picker = new PointPicker(app);
  }

  reset() {
    this.pts = [];
    this.picker.cancel();
  }
  deactivate() { this.finish(false); }

  private draftPrims(): Prim[] {
    const out: Prim[] = [];
    for (let i = 0; i < this.pts.length - 1; i++) out.push({ kind: 'line', a: this.pts[i], b: this.pts[i + 1], keys: [] });
    return out;
  }

  down(s: Vec) {
    this.picker.begin(s, { extraPrims: this.draftPrims(), extraPoints: this.pts, ref: this.pts[this.pts.length - 1] });
  }
  move(s: Vec) {
    this.picker.update(s);
    this.app.requestRender();
  }
  up() {
    const p = this.picker.end();
    if (!p) return;
    const n = this.pts.length;
    if (n >= 3 && dist(p, this.pts[0]) < 1e-6) return this.finish(true);
    if (n >= 1 && dist(p, this.pts[n - 1]) < 1e-6) return this.finish(false);
    this.pts.push(p);
    if (this.single && this.pts.length === 2) return this.finish(false);
    this.app.refreshUI();
  }
  cancelGesture() {
    this.picker.cancel();
    this.app.requestRender();
  }

  private finish(closed: boolean) {
    const pts = this.pts;
    this.reset();
    if (pts.length >= 2)
      this.app.addShape({ id: uid(), type: 'path', closed: closed && pts.length >= 3, nodes: pts.map((p) => ({ ...p, hin: null, hout: null })) });
    this.app.refreshUI();
  }

  hint() {
    if (!this.pts.length) return '始点をタップ（指を離した位置で確定）';
    if (this.single) return '終点をタップ';
    return '次の点をタップ。最後の点をもう一度タップで完了、始点をタップで閉じる';
  }

  options() {
    const n = this.pts.length;
    return [
      button('1本ずつ', () => { this.single = !this.single; this.app.refreshUI(); }, { active: this.single, title: 'オンにすると、2点ごとに1本の線として確定します' }),
      separator(),
      button('完了', () => this.finish(false), { disabled: n < 2 }),
      button('閉じる', () => this.finish(true), { disabled: n < 3 }),
      button('1点戻す', () => { this.pts.pop(); this.app.refreshUI(); }, { disabled: !n }),
      button('取消', () => { this.reset(); this.app.refreshUI(); }, { disabled: !n }),
    ];
  }

  overlay(ctx: CanvasRenderingContext2D, view: View) {
    const pts = this.pts.map((p) => view.toScreen(p));
    const prev = this.picker.preview;
    ctx.strokeStyle = COLORS.draft;
    ctx.lineWidth = 2;
    if (pts.length) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.stroke();
      if (prev) {
        const e = view.toScreen(prev.p);
        ctx.setLineDash([6, 4]);
        ctx.beginPath(); ctx.moveTo(pts[pts.length - 1].x, pts[pts.length - 1].y); ctx.lineTo(e.x, e.y); ctx.stroke();
        ctx.setLineDash([]);
      }
      for (const p of pts) {
        ctx.fillStyle = '#fff';
        ctx.beginPath(); ctx.rect(p.x - 3.5, p.y - 3.5, 7, 7); ctx.fill(); ctx.stroke();
      }
    }
    this.picker.draw(ctx, view);
  }

  focus() {
    return this.picker.preview?.p ?? null;
  }
}
