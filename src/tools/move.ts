import type { App, Tool } from '../app';
import type { Doc, Shape, Vec } from '../types';
import type { View } from '../view';
import { allShapes, parseRef, translatePoints } from '../doc';
import { sub } from '../geom';
import { COLORS, inWorld, strokeShapes } from '../render';
import { button, PointPicker } from './common';

/** CAD式の移動：基準点 → 移動先 の順にタップする。一部の点だけを選んでいれば、その点だけが動く（ストレッチ）。 */
export class MoveTool implements Tool {
  id = 'move' as const;
  private base: Vec | null = null;
  private picker: PointPicker;

  constructor(private app: App) {
    this.picker = new PointPicker(app);
  }

  activate() { this.reset(); }
  reset() {
    this.base = null;
    this.picker.cancel();
  }

  down(s: Vec) {
    if (!this.app.sel.size) return;
    // 移動先は、動かす図形自身の端点や交点（移動前の位置）にも吸着する
    this.picker.begin(s, { ref: this.base });
  }
  move(s: Vec) {
    this.picker.update(s);
    this.app.requestRender();
  }
  up() {
    const p = this.picker.end();
    if (!p) return;
    if (!this.base) {
      this.base = p;
    } else {
      const delta = sub(p, this.base);
      this.base = null;
      if (delta.x || delta.y) this.app.mutate((d) => translatePoints(d, this.app.sel, delta));
    }
    this.app.refreshUI();
  }
  cancelGesture() {
    this.picker.cancel();
    this.app.requestRender();
  }

  hint() {
    if (!this.app.sel.size) return '先に「選択」ツールで動かす点や図形を選んでください';
    if (!this.base) return '基準点をタップ（指を離した位置で確定）';
    return '移動先をタップ';
  }

  options() {
    return [
      button('基準点からやり直す', () => { this.reset(); this.app.refreshUI(); }, { disabled: !this.base }),
      button('選択に戻る', () => this.app.setTool('select')),
    ];
  }

  /** 移動後の形をプレビュー */
  private ghost(delta: Vec): Shape[] {
    const ids = new Set([...this.app.sel].map((r) => parseRef(r)[0]));
    const shapes = allShapes(this.app.doc).filter((s) => ids.has(s.id)).map((s) => structuredClone(s));
    const tmp = { layers: [{ shapes }] } as unknown as Doc;
    translatePoints(tmp, this.app.sel, delta);
    return shapes;
  }

  overlay(ctx: CanvasRenderingContext2D, view: View) {
    const prev = this.picker.preview;
    if (this.base) {
      const b = view.toScreen(this.base);
      if (prev) {
        inWorld(ctx, view, () => strokeShapes(ctx, view, this.ghost(sub(prev.p, this.base!)), COLORS.ghost, 1.5));
        const e = view.toScreen(prev.p);
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = COLORS.draft;
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(e.x, e.y); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = COLORS.draft;
      ctx.beginPath(); ctx.arc(b.x, b.y, 5, 0, Math.PI * 2); ctx.fill();
    }
    this.picker.draw(ctx, view);
  }

  focus() {
    return this.picker.preview?.p ?? null;
  }
}
