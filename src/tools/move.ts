import type { App, Tool } from '../app';
import type { Doc, Shape, Vec } from '../types';
import type { View } from '../view';
import { allShapes, anchorKeys, getPoint, parseRef, shapePrims, transformPoints, transformShape } from '../doc';
import { sub, translateM } from '../geom';
import { COLORS, inWorld, strokeShapes } from '../render';
import { copyData, placeClip, selectedShapeIds, transformSelection, type ClipData } from '../clipboard';
import { button, PointPicker, separator } from './common';

/**
 * CAD式の移動：基準点 → 移動先 の順にタップする。一部の点だけを選んでいれば、その点だけが動く（ストレッチ）。
 * 「コピーして移動」では元を残して複製を置く。貼り付けもこのツールで置き場所を決める。
 */
export class MoveTool implements Tool {
  id = 'move' as const;
  copy = false;
  /** 貼り付け中なら、置く図形 */
  private paste: ClipData | null = null;
  private base: Vec | null = null;
  private picker: PointPicker;

  constructor(private app: App) {
    this.picker = new PointPicker(app);
  }

  activate() { this.base = null; this.picker.cancel(); }
  deactivate() { this.reset(); }
  reset() {
    this.base = null;
    this.paste = null;
    this.picker.cancel();
  }

  /** 貼り付けを始める（基準点 → 置く位置 を指定させる） */
  startPaste(clip: ClipData) {
    this.app.setTool('move');
    this.paste = clip;
    this.base = null;
    this.app.refreshUI();
  }

  private ready() {
    return !!this.paste || this.app.sel.size > 0;
  }

  down(s: Vec) {
    if (!this.ready()) return;
    // 貼り付けの基準点は、これから置く図形の点にも吸着させる
    const extra = this.paste && !this.base ? this.paste.shapes : [];
    this.picker.begin(s, {
      ref: this.base,
      extraPrims: extra.flatMap(shapePrims),
      extraPoints: extra.flatMap((sh) => anchorKeys(sh).map((k) => getPoint(sh, k)!)),
    });
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
      this.app.refreshUI();
      return;
    }
    const m = translateM(sub(p, this.base));
    this.base = null;
    if (this.paste) {
      if (placeClip(this.app, this.paste, m)) this.paste = null;
    } else if (this.copy) {
      const clip = copyData(this.app.doc, selectedShapeIds(this.app.sel));
      if (clip) placeClip(this.app, clip, m);
    } else if (m.e || m.f) transformSelection(this.app, m);
    this.app.refreshUI();
  }
  cancelGesture() {
    this.picker.cancel();
    this.app.requestRender();
  }

  hint() {
    if (this.paste) return this.base ? '貼り付ける位置をタップ' : '貼り付ける図形の基準点をタップ（元の図形の位置で指定します）';
    if (!this.app.sel.size) return '先に「選択」ツールで動かす点や図形を選んでください';
    if (!this.base) return '基準点をタップ（指を離した位置で確定）';
    return this.copy ? 'コピーを置く位置をタップ' : '移動先をタップ';
  }

  options() {
    const app = this.app;
    if (this.paste)
      return [
        button('基準点からやり直す', () => { this.base = null; app.refreshUI(); }, { disabled: !this.base }),
        button('貼り付けをやめる', () => { this.reset(); app.setTool('select'); }),
      ];
    return [
      button('コピーして移動', () => { this.copy = !this.copy; app.refreshUI(); }, { active: this.copy, title: 'オンにすると、元を残して複製を置きます' }),
      separator(),
      button('基準点からやり直す', () => { this.base = null; app.refreshUI(); }, { disabled: !this.base }),
      button('選択に戻る', () => app.setTool('select')),
    ];
  }

  /** 移動後の形をプレビュー */
  private ghost(delta: Vec): Shape[] {
    const m = translateM(delta);
    if (this.paste) return this.paste.shapes.map((s) => { const c = structuredClone(s); transformShape(c, m); return c; });
    const ids = new Set([...this.app.sel].map((r) => parseRef(r)[0]));
    const shapes = allShapes(this.app.doc).filter((s) => ids.has(s.id)).map((s) => structuredClone(s));
    if (this.copy) { shapes.forEach((s) => transformShape(s, m)); return shapes; }
    const tmp = { layers: [{ kind: 'layer', visible: true, shapes }] } as unknown as Doc;
    transformPoints(tmp, this.app.sel, m);
    return shapes;
  }

  overlay(ctx: CanvasRenderingContext2D, view: View) {
    const prev = this.picker.preview;
    if (this.paste && !this.base) inWorld(ctx, view, () => strokeShapes(ctx, view, this.paste!.shapes, COLORS.ghost, 1.5));
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
