import type { App, Tool } from '../app';
import type { Doc, Shape, Vec } from '../types';
import type { View } from '../view';
import { allShapes, findShape, parseRef, transformPoints, transformShape } from '../doc';
import { dist, reflectM, rotateM, scaleM, type Affine } from '../geom';
import { COLORS, inWorld, strokeShapes } from '../render';
import { copyData, placeClip, selectedShapeIds, transformSelection } from '../clipboard';
import { getPoint } from '../doc';
import { button, fmt, label, PointPicker, separator } from './common';

type Mode = 'scale' | 'rotate' | 'flip';

/**
 * 変形ツール
 *  - 拡大縮小／回転：基準点 → 参照点 → 参照点の行き先 の順にタップ。数値でも指定できる。
 *  - 反転：基準点を通る縦・横の軸で反転するか、2点で軸を指定する。
 * 基準点は変形のあとも残るので、同じ中心で続けて回転コピーなどができる。
 */
export class TransformTool implements Tool {
  id = 'transform' as const;
  mode: Mode = 'rotate';
  copy = false;
  angleStep = false;
  private pivot: Vec | null = null;
  private refPt: Vec | null = null;
  /** 反転の軸を2点で指定しているときの1点目 */
  private axisA: Vec | null = null;
  private axisMode = false;
  private numScale = 200;
  private numAngle = 90;
  private picker: PointPicker;

  constructor(private app: App) {
    this.picker = new PointPicker(app);
  }

  activate() { this.refPt = null; this.axisA = null; this.picker.cancel(); }
  reset() {
    this.pivot = null;
    this.refPt = null;
    this.axisA = null;
    this.axisMode = false;
    this.picker.cancel();
  }

  private selCenter(): Vec | null {
    const pts: Vec[] = [];
    for (const r of this.app.sel) {
      const [id, key] = parseRef(r);
      const s = findShape(this.app.doc, id);
      const p = s && getPoint(s, key);
      if (p) pts.push(p);
      if (s?.type === 'circle') pts.push({ x: s.cx - s.r, y: s.cy - s.r }, { x: s.cx + s.r, y: s.cy + s.r });
    }
    if (!pts.length) return null;
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  }

  /** 今の入力から変換を求める */
  private matrix(dest: Vec | null): Affine | null {
    const pv = this.pivot;
    if (!pv) return null;
    if (this.mode === 'flip') return this.axisA && dest && dist(this.axisA, dest) > 1e-9 ? reflectM(this.axisA, dest) : null;
    if (!this.refPt || !dest) return null;
    if (this.mode === 'scale') {
      const r = dist(pv, this.refPt);
      return r > 1e-9 ? scaleM(pv, dist(pv, dest) / r) : null;
    }
    let a = Math.atan2(dest.y - pv.y, dest.x - pv.x) - Math.atan2(this.refPt.y - pv.y, this.refPt.x - pv.x);
    if (this.angleStep) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
    return rotateM(pv, a);
  }

  private apply(m: Affine) {
    const app = this.app;
    if (this.copy) {
      const clip = copyData(app.doc, selectedShapeIds(app.sel));
      if (clip) placeClip(app, clip, m);
    } else transformSelection(app, m);
  }

  down(s: Vec) {
    if (!this.app.sel.size) return;
    const ref = this.mode === 'flip' ? this.axisA : this.refPt ?? this.pivot;
    this.picker.begin(s, { ref });
  }
  move(s: Vec) {
    this.picker.update(s);
    this.app.requestRender();
  }
  up() {
    const p = this.picker.end();
    if (!p) return;
    if (this.mode === 'flip') {
      if (!this.axisMode) this.pivot = p;
      else if (!this.axisA) this.axisA = p;
      else {
        if (dist(this.axisA, p) > 1e-9) this.apply(reflectM(this.axisA, p));
        this.axisA = null;
        this.axisMode = false;
      }
    } else if (!this.pivot) this.pivot = p;
    else if (!this.refPt) {
      if (dist(p, this.pivot) > 1e-9) this.refPt = p;
      else this.app.setStatus('参照点は基準点と別の位置にしてください');
    } else {
      const m = this.matrix(p);
      this.refPt = null;
      if (m) this.apply(m);
    }
    this.app.refreshUI();
  }
  cancelGesture() {
    this.picker.cancel();
    this.app.requestRender();
  }

  hint() {
    if (!this.app.sel.size) return '先に「選択」ツールで変形する点や図形を選んでください';
    if (this.mode === 'flip') {
      if (this.axisMode) return this.axisA ? '反転の軸の2点目をタップ' : '反転の軸の1点目をタップ';
      return this.pivot ? '反転する向きを選んでください（基準点を通る軸で反転します）' : '基準点をタップするか、反転する向きを選んでください（選択の中心で反転します）';
    }
    if (!this.pivot) return `${this.mode === 'scale' ? '拡大縮小' : '回転'}の基準点をタップ`;
    if (!this.refPt) return '参照点をタップ（数値で指定することもできます）';
    return this.mode === 'scale' ? '参照点の行き先をタップ（基準点からの距離の比で拡大縮小）' : '参照点の行き先をタップ（基準点のまわりに回転）';
  }

  options() {
    const app = this.app;
    const refresh = () => app.refreshUI();
    const setMode = (m: Mode) => { this.mode = m; this.refPt = null; this.axisA = null; this.axisMode = false; refresh(); };
    const has = app.sel.size > 0;
    const items: HTMLElement[] = [
      button('拡大縮小', () => setMode('scale'), { active: this.mode === 'scale' }),
      button('回転', () => setMode('rotate'), { active: this.mode === 'rotate' }),
      button('反転', () => setMode('flip'), { active: this.mode === 'flip' }),
      separator(),
      button('コピーを作る', () => { this.copy = !this.copy; refresh(); }, { active: this.copy, title: 'オンにすると、元を残して変形した複製を作ります' }),
      separator(),
    ];
    if (this.mode === 'flip') {
      const center = () => this.pivot ?? this.selCenter();
      const flip = (vertical: boolean) => {
        const c = center();
        if (!c) return;
        this.apply(vertical ? reflectM(c, { x: c.x, y: c.y + 1 }) : reflectM(c, { x: c.x + 1, y: c.y }));
        refresh();
      };
      items.push(
        button('左右反転', () => flip(true), { disabled: !has }),
        button('上下反転', () => flip(false), { disabled: !has }),
        button('軸を2点で指定', () => { this.axisMode = !this.axisMode; this.axisA = null; refresh(); }, { active: this.axisMode, disabled: !has }),
      );
    } else if (this.pivot) {
      const isScale = this.mode === 'scale';
      const input = document.createElement('input');
      input.type = 'number';
      input.inputMode = 'decimal';
      input.className = 'num-input';
      input.id = isScale ? 'transform-scale' : 'transform-angle';
      input.value = String(isScale ? this.numScale : this.numAngle);
      input.addEventListener('input', () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) isScale ? (this.numScale = v) : (this.numAngle = v);
      });
      items.push(
        label(isScale ? '倍率 %' : '角度 °'),
        input,
        button('適用', () => {
          const pv = this.pivot!;
          if (isScale && this.numScale > 0) this.apply(scaleM(pv, this.numScale / 100));
          else if (!isScale) this.apply(rotateM(pv, (this.numAngle * Math.PI) / 180));
          refresh();
        }, { disabled: !has }),
      );
      if (!isScale) items.push(button('15°刻み', () => { this.angleStep = !this.angleStep; refresh(); }, { active: this.angleStep }));
    }
    if (this.mode !== 'flip' || this.pivot) {
      items.push(separator());
      const c = this.selCenter();
      items.push(button('選択の中心を基準点に', () => { if (c) { this.pivot = c; this.refPt = null; refresh(); } }, { disabled: !c }));
      if (this.pivot) items.push(button('基準点を変える', () => { this.pivot = null; this.refPt = null; refresh(); }));
    }
    return items;
  }

  private ghost(m: Affine): Shape[] {
    const app = this.app;
    const ids = selectedShapeIds(app.sel);
    const shapes = allShapes(app.doc).filter((s) => ids.has(s.id)).map((s) => structuredClone(s));
    if (this.copy) { shapes.forEach((s) => transformShape(s, m)); return shapes; }
    const tmp = { layers: [{ kind: 'layer', visible: true, shapes }] } as unknown as Doc;
    transformPoints(tmp, app.sel, m);
    return shapes;
  }

  overlay(ctx: CanvasRenderingContext2D, view: View) {
    const prev = this.picker.preview;
    const m = this.matrix(prev?.p ?? null);
    if (m) inWorld(ctx, view, () => strokeShapes(ctx, view, this.ghost(m), COLORS.ghost, 1.5));
    const mark = (p: Vec, color: string) => {
      const s = view.toScreen(p);
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(s.x, s.y, 5, 0, Math.PI * 2); ctx.fill();
    };
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = COLORS.draft;
    ctx.lineWidth = 1.2;
    const lineTo = (a: Vec, b: Vec) => {
      const sa = view.toScreen(a), sb = view.toScreen(b);
      ctx.beginPath(); ctx.moveTo(sa.x, sa.y); ctx.lineTo(sb.x, sb.y); ctx.stroke();
    };
    if (this.pivot && this.refPt) lineTo(this.pivot, this.refPt);
    if (this.pivot && this.refPt && prev) lineTo(this.pivot, prev.p);
    if (this.axisA && prev) lineTo(this.axisA, prev.p);
    ctx.setLineDash([]);
    if (this.pivot) mark(this.pivot, COLORS.origin);
    if (this.refPt) mark(this.refPt, COLORS.draft);
    if (this.axisA) mark(this.axisA, COLORS.draft);
    if (this.pivot && this.refPt && prev && this.mode !== 'flip') {
      const pv = this.pivot;
      const val = this.mode === 'scale'
        ? `${fmt((dist(pv, prev.p) / dist(pv, this.refPt)) * 100)}%`
        : `${fmt((((Math.atan2(prev.p.y - pv.y, prev.p.x - pv.x) - Math.atan2(this.refPt.y - pv.y, this.refPt.x - pv.x)) * 180) / Math.PI + 540) % 360 - 180)}°`;
      const s = view.toScreen(prev.p);
      ctx.font = '13px -apple-system, sans-serif';
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 3;
      ctx.strokeText(val, s.x + 14, s.y - 14);
      ctx.fillText(val, s.x + 14, s.y - 14);
    }
    this.picker.draw(ctx, view);
  }

  focus() {
    return this.picker.preview?.p ?? null;
  }
}
