import type { App, Tool } from '../app';
import type { PointRef, Vec } from '../types';
import type { View } from '../view';
import { allShapes, anchorKeys, deletePoints, getPoint, makeCorner, ref, shapePrims } from '../doc';
import { dist, distToPrim } from '../geom';
import { button, separator } from './common';

const DRAG_START_PX = 8;

export class SelectTool implements Tool {
  id = 'select' as const;
  additive = false;
  private downAt: Vec | null = null;
  private cur: Vec | null = null;
  private boxing = false;

  constructor(private app: App) {}

  down(s: Vec) {
    this.downAt = s;
    this.cur = s;
    this.boxing = false;
  }
  move(s: Vec) {
    if (!this.downAt) return;
    this.cur = s;
    if (!this.boxing && dist(s, this.downAt) > DRAG_START_PX) this.boxing = true;
    this.app.requestRender();
  }
  up(s: Vec) {
    if (!this.downAt) return;
    if (this.boxing) this.selectBox(this.downAt, s);
    else this.tap(s);
    this.cancelGesture();
    this.app.refreshUI();
  }
  cancelGesture() {
    this.downAt = null;
    this.cur = null;
    this.boxing = false;
    this.app.requestRender();
  }

  /** 選択可能な点（頂点・中心・四分点と、選択中頂点のハンドル） */
  private pickPoint(s: Vec): PointRef | null {
    const app = this.app;
    let best: PointRef | null = null;
    let bestD = 22;
    for (const sh of allShapes(app.doc)) {
      const keys = anchorKeys(sh);
      if (sh.type === 'path')
        sh.nodes.forEach((_, i) => {
          if ([`n${i}`, `i${i}`, `o${i}`].some((k) => app.sel.has(ref(sh.id, k)))) keys.push(`i${i}`, `o${i}`);
        });
      for (const k of keys) {
        const p = getPoint(sh, k);
        if (!p) continue;
        const d = dist(app.view.toScreen(p), s);
        if (d < bestD) { bestD = d; best = ref(sh.id, k); }
      }
    }
    return best;
  }

  private tap(s: Vec) {
    const app = this.app;
    const pt = this.pickPoint(s);
    if (pt) {
      if (this.additive) app.sel.has(pt) ? app.sel.delete(pt) : app.sel.add(pt);
      else app.sel = new Set([pt]);
      return;
    }
    const w = app.view.toWorld(s);
    const hit = allShapes(app.doc)
      .map((sh) => ({ sh, d: Math.min(...shapePrims(sh).map((p) => distToPrim(w, p))) }))
      .filter((x) => x.d < app.tol * 0.8)
      .sort((a, b) => a.d - b.d)[0];
    if (hit) {
      const refs = anchorKeys(hit.sh).map((k) => ref(hit.sh.id, k));
      if (this.additive) {
        const all = refs.every((r) => app.sel.has(r));
        refs.forEach((r) => (all ? app.sel.delete(r) : app.sel.add(r)));
      } else app.sel = new Set(refs);
      return;
    }
    if (!this.additive) app.sel.clear();
  }

  private selectBox(a: Vec, b: Vec) {
    const app = this.app;
    const wa = app.view.toWorld(a), wb = app.view.toWorld(b);
    const x0 = Math.min(wa.x, wb.x), x1 = Math.max(wa.x, wb.x), y0 = Math.min(wa.y, wb.y), y1 = Math.max(wa.y, wb.y);
    if (!this.additive) app.sel.clear();
    for (const sh of allShapes(app.doc))
      for (const k of anchorKeys(sh)) {
        const p = getPoint(sh, k)!;
        if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1) app.sel.add(ref(sh.id, k));
      }
  }

  hint() {
    return this.app.sel.size
      ? `${this.app.sel.size}点を選択中。線をタップで図形ごと、点をタップで1点、空白をなぞると範囲選択`
      : '線をタップで図形を選択、点をタップで1点を選択、空白をなぞると範囲選択';
  }

  options() {
    const app = this.app;
    const has = app.sel.size > 0;
    return [
      button('追加選択', () => { this.additive = !this.additive; app.refreshUI(); }, { active: this.additive, title: 'オンにすると、タップで選択に追加／解除します' }),
      button('全選択', () => {
        app.sel = new Set(allShapes(app.doc).flatMap((sh) => anchorKeys(sh).map((k) => ref(sh.id, k))));
        app.refreshUI();
      }),
      button('解除', () => { app.sel.clear(); app.refreshUI(); }, { disabled: !has }),
      separator(),
      button('移動へ', () => app.setTool('move'), { disabled: !has }),
      button('角にする', () => app.mutate((d) => makeCorner(d, app.sel)), { disabled: !has, title: '選択した頂点の曲線ハンドルを消します' }),
      button('削除', () => app.mutate((d) => deletePoints(d, app.sel)), { disabled: !has }),
    ];
  }

  overlay(ctx: CanvasRenderingContext2D, _view: View) {
    if (!this.boxing || !this.downAt || !this.cur) return;
    const a = this.downAt, b = this.cur;
    ctx.fillStyle = 'rgba(47,107,255,0.08)';
    ctx.strokeStyle = 'rgba(47,107,255,0.8)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    ctx.setLineDash([]);
  }

  focus() {
    return null;
  }
}
