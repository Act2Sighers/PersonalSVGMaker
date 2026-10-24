import type { App, Tool } from '../app';
import type { PointRef, Vec } from '../types';
import type { View } from '../view';
import { allShapes, anchorKeys, deletePoints, getPoint, makeCorner, ref, shapePrims, uid } from '../doc';
import { copyData, selectedShapeIds } from '../clipboard';
import type { MoveTool } from './move';
import type { Shape } from '../types';
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
    for (const sh of allShapes(app.doc, true, true)) {
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
    const hit = allShapes(app.doc, true, true)
      .map((sh) => ({ sh, d: Math.min(...shapePrims(sh).map((p) => distToPrim(w, p))) }))
      .filter((x) => x.d < app.tol * 0.8)
      .sort((a, b) => a.d - b.d)[0];
    if (hit) {
      // グループに入っていれば、一番外側のグループごと選ぶ
      const g = hit.sh.groups?.[0];
      const members = g ? allShapes(app.doc, true, true).filter((x) => x.groups?.[0] === g) : [hit.sh];
      const refs = members.flatMap((m) => anchorKeys(m).map((k) => ref(m.id, k)));
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
    for (const sh of allShapes(app.doc, true, true))
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

  private selectedShapes(): Shape[] {
    const ids = selectedShapeIds(this.app.sel);
    return allShapes(this.app.doc, true, true).filter((s) => ids.has(s.id));
  }

  private group() {
    const ids = new Set(this.selectedShapes().map((s) => s.id));
    if (ids.size < 2) return this.app.setStatus('2つ以上の図形を選んでください');
    const g = uid();
    this.app.mutate((d) => allShapes(d, false).forEach((s) => { if (ids.has(s.id)) s.groups = [g, ...(s.groups ?? [])]; }));
    // 選択も図形全体に広げる
    this.app.sel = new Set(allShapes(this.app.doc, false).filter((s) => ids.has(s.id)).flatMap((s) => anchorKeys(s).map((k) => ref(s.id, k))));
    this.app.setStatus(`${ids.size}個の図形をグループにしました`);
  }

  private ungroup() {
    const outer = new Set(this.selectedShapes().map((s) => s.groups?.[0]).filter((g): g is string => !!g));
    if (!outer.size) return this.app.setStatus('グループが選ばれていません');
    this.app.mutate((d) => allShapes(d, false).forEach((s) => {
      if (s.groups?.[0] && outer.has(s.groups[0])) {
        s.groups = s.groups.slice(1);
        if (!s.groups.length) delete s.groups;
      }
    }));
    this.app.setStatus('グループを解除しました');
  }

  private copy(): boolean {
    const clip = copyData(this.app.doc, selectedShapeIds(this.app.sel));
    if (!clip) return false;
    this.app.clipboard = clip;
    this.app.setStatus(`${clip.shapes.length}個の図形をコピーしました`);
    return true;
  }

  options() {
    const app = this.app;
    const has = app.sel.size > 0;
    const shapes = has ? this.selectedShapes() : [];
    const grouped = shapes.some((s) => s.groups?.length);
    const paste = () => app.clipboard && (app.tools.move as MoveTool).startPaste(app.clipboard);
    return [
      button('追加選択', () => { this.additive = !this.additive; app.refreshUI(); }, { active: this.additive, title: 'オンにすると、タップで選択に追加／解除します' }),
      button('全選択', () => {
        app.sel = new Set(allShapes(app.doc, true, true).flatMap((sh) => anchorKeys(sh).map((k) => ref(sh.id, k))));
        app.refreshUI();
      }),
      button('解除', () => { app.sel.clear(); app.refreshUI(); }, { disabled: !has }),
      separator(),
      button('移動へ', () => app.setTool('move'), { disabled: !has }),
      button('変形へ', () => app.setTool('transform'), { disabled: !has }),
      separator(),
      button('グループ化', () => this.group(), { disabled: shapes.length < 2 }),
      button('グループ解除', () => this.ungroup(), { disabled: !grouped }),
      separator(),
      button('コピー', () => { this.copy(); app.refreshUI(); }, { disabled: !has }),
      button('貼り付け', paste, { disabled: !app.clipboard }),
      button('複製', () => { if (this.copy()) paste(); }, { disabled: !has, title: 'コピーして、すぐに置く位置を指定します' }),
      separator(),
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
