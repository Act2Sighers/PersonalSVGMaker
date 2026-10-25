import type { App, Tool } from '../app';
import type { PointRef, Vec } from '../types';
import type { View } from '../view';
import { anchorKeys, deletePoints, findShape, getPoint, makeCorner, parseRef, pruneSelection, ref, selectableShapes, shapePrims, uid } from '../doc';
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
    // グループの図形が含まれていれば、グループ全体の選択に広げる
    this.app.sel = pruneSelection(this.app.doc, this.app.sel);
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
    for (const sh of selectableShapes(app.doc)) {
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
    const toggle = (refs: PointRef[]) => {
      if (this.additive) {
        const all = refs.every((r) => app.sel.has(r));
        refs.forEach((r) => (all ? app.sel.delete(r) : app.sel.add(r)));
      } else app.sel = new Set(refs);
    };
    if (pt) {
      const sh = findShape(app.doc, parseRef(pt)[0]);
      // グループの図形の点は単独では選べない（グループごと選ぶ）
      return toggle(sh?.group ? this.groupRefs(sh.group) : [pt]);
    }
    const w = app.view.toWorld(s);
    const hit = selectableShapes(app.doc)
      .map((sh) => ({ sh, d: Math.min(...shapePrims(sh).map((p) => distToPrim(w, p))) }))
      .filter((x) => x.d < app.tol * 0.8)
      .sort((a, b) => a.d - b.d)[0];
    if (hit) return toggle(hit.sh.group ? this.groupRefs(hit.sh.group) : anchorKeys(hit.sh).map((k) => ref(hit.sh.id, k)));
    if (!this.additive) app.sel.clear();
  }

  private groupRefs(g: string): PointRef[] {
    return selectableShapes(this.app.doc)
      .filter((x) => x.group === g)
      .flatMap((m) => anchorKeys(m).map((k) => ref(m.id, k)));
  }

  private selectBox(a: Vec, b: Vec) {
    const app = this.app;
    // 範囲は画面上の長方形（キャンバスが回っていても見た目どおりに選ぶ）
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    if (!this.additive) app.sel.clear();
    for (const sh of selectableShapes(app.doc))
      for (const k of anchorKeys(sh)) {
        const p = app.view.toScreen(getPoint(sh, k)!);
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
    return selectableShapes(this.app.doc).filter((s) => ids.has(s.id));
  }

  /** グループ化できるか（2つ以上の図形があり、既にあるグループと完全に同じではない） */
  private canGroup(shapes: Shape[]): boolean {
    if (shapes.length < 2) return false;
    const g = shapes[0].group;
    if (!g || shapes.some((s) => s.group !== g)) return true;
    return selectableShapes(this.app.doc).some((s) => s.group === g && !shapes.includes(s));
  }

  /** 選択した図形を1つのグループにする。中に含まれていた古いグループは、新しいグループに置き換わる。 */
  private group() {
    const shapes = this.selectedShapes();
    if (!this.canGroup(shapes)) return;
    const ids = new Set(shapes.map((s) => s.id));
    const g = uid();
    this.app.mutate((d) => selectableShapes(d).forEach((s) => { if (ids.has(s.id)) s.group = g; }));
    this.app.setStatus(`${ids.size}個の図形をグループにしました`);
  }

  private ungroup() {
    const groups = new Set(this.selectedShapes().map((s) => s.group).filter((g): g is string => !!g));
    if (!groups.size) return;
    this.app.mutate((d) => selectableShapes(d).forEach((s) => { if (s.group && groups.has(s.group)) delete s.group; }));
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
    const grouped = shapes.some((s) => s.group);
    const paste = () => app.clipboard && (app.tools.move as MoveTool).startPaste(app.clipboard);
    return [
      button('追加選択', () => { this.additive = !this.additive; app.refreshUI(); }, { active: this.additive, title: 'オンにすると、タップで選択に追加／解除します' }),
      button('全選択', () => {
        app.sel = new Set(selectableShapes(app.doc).flatMap((sh) => anchorKeys(sh).map((k) => ref(sh.id, k))));
        app.refreshUI();
      }),
      button('解除', () => { app.sel.clear(); app.refreshUI(); }, { disabled: !has }),
      separator(),
      button('移動へ', () => app.setTool('move'), { disabled: !has }),
      button('変形へ', () => app.setTool('transform'), { disabled: !has }),
      separator(),
      button('グループ化', () => this.group(), { disabled: !this.canGroup(shapes) }),
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
