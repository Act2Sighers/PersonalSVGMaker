import type { App, Tool } from '../app';
import type { Paint, Vec } from '../types';
import type { View } from '../view';
import { applyFill, fillFace, layerFaces } from '../fills';
import { faceAt, traceFace, type Face } from '../regions';
import { COLORS, inWorld, paintFace } from '../render';
import { button, label, PointPicker, separator } from './common';

type Mode = 'solid' | 'linear' | 'pick' | 'erase';

const RECENT_KEY = 'psm:recentColors';
const DEFAULT_SWATCHES = ['#ffffff', '#000000', '#f2c9a0', '#e2533a', '#f5b83d', '#4caf6a', '#3d8bf5', '#8e5cf5'];

function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? 'null');
    return Array.isArray(v) ? v.slice(0, 8) : DEFAULT_SWATCHES;
  } catch {
    return DEFAULT_SWATCHES;
  }
}

/**
 * 塗りつぶしツール：線で閉じた範囲をタップして塗る。
 * グラデーションは、範囲をタップ → 始点 → 終点 の順にタップする。
 */
export class FillTool implements Tool {
  id = 'fill' as const;
  mode: Mode = 'solid';
  color = '#f2c9a0';
  color2 = '#e2533a';
  private recent = loadRecent();
  private hover: Face | null = null;
  /** グラデーションで選んだ範囲の内側の点と、始点 */
  private target: Vec | null = null;
  private start: Vec | null = null;
  private picker: PointPicker;

  constructor(private app: App) {
    this.picker = new PointPicker(app);
  }

  reset() {
    this.target = null;
    this.start = null;
    this.hover = null;
    this.picker.cancel();
  }
  deactivate() { this.reset(); }

  private layer() {
    return this.app.activeLayer();
  }
  private faceAtScreen(s: Vec): Face | null {
    return faceAt(layerFaces(this.layer()), this.app.view.toWorld(s));
  }
  private choosingEnds() {
    return this.mode === 'linear' && this.target !== null;
  }

  down(s: Vec) {
    if (this.choosingEnds()) this.picker.begin(s, { ref: this.start });
    else this.hover = this.faceAtScreen(s);
    this.app.requestRender();
  }
  move(s: Vec) {
    if (this.choosingEnds()) this.picker.update(s);
    else this.hover = this.faceAtScreen(s);
    this.app.requestRender();
  }
  up(s: Vec) {
    const app = this.app;
    if (this.choosingEnds()) {
      const p = this.picker.end();
      if (!p) return;
      if (!this.start) this.start = p;
      else {
        const target = this.target!, start = this.start;
        this.reset();
        const paint: Paint = { type: 'linear', color: this.color, color2: this.color2, x1: start.x, y1: start.y, x2: p.x, y2: p.y };
        app.mutate(() => applyFill(this.layer(), target, paint));
        this.remember(this.color);
        this.remember(this.color2);
      }
      app.refreshUI();
      return;
    }
    this.hover = null;
    const w = app.view.toWorld(s);
    const face = faceAt(layerFaces(this.layer()), w);
    if (!face) {
      app.setStatus('ここは線で閉じた範囲ではありません');
      app.requestRender();
      return;
    }
    if (this.mode === 'solid') {
      app.mutate(() => applyFill(this.layer(), w, { type: 'solid', color: this.color }));
      this.remember(this.color);
    } else if (this.mode === 'erase') {
      app.mutate(() => applyFill(this.layer(), w, null));
    } else if (this.mode === 'pick') {
      const f = this.layer().fills.find((x) => fillFace(this.layer(), x) === face);
      if (!f) app.setStatus('この範囲はまだ塗られていません');
      else {
        this.color = f.paint.color;
        if (f.paint.type === 'linear') this.color2 = f.paint.color2;
        this.mode = f.paint.type === 'linear' ? 'linear' : 'solid';
      }
    } else {
      this.target = face.interior;
    }
    app.refreshUI();
  }
  cancelGesture() {
    this.hover = null;
    this.picker.cancel();
    this.app.requestRender();
  }

  private remember(c: string) {
    this.recent = [c, ...this.recent.filter((x) => x !== c)].slice(0, 8);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(this.recent)); } catch { /* 保存できない環境 */ }
  }

  hint() {
    if (this.mode === 'linear') {
      if (!this.target) return 'グラデーションをかける範囲をタップ';
      return (this.start ? `終点（${this.color2} になる位置）をタップ` : `始点（${this.color} になる位置）をタップ`);
    }
    if (this.mode === 'pick') return '色を取りたい塗りをタップ';
    if (this.mode === 'erase') return '塗りを消す範囲をタップ';
    return '塗る範囲をタップ';
  }

  options() {
    const app = this.app;
    const setMode = (m: Mode) => { this.mode = m; this.reset(); app.refreshUI(); };
    const items: HTMLElement[] = [
      button('単色', () => setMode('solid'), { active: this.mode === 'solid' }),
      button('グラデーション', () => setMode('linear'), { active: this.mode === 'linear' }),
      button('スポイト', () => setMode('pick'), { active: this.mode === 'pick' }),
      button('塗りを消す', () => setMode('erase'), { active: this.mode === 'erase' }),
      separator(),
    ];
    if (this.mode !== 'erase') {
      const two = this.mode === 'linear';
      items.push(colorInput(two ? '始点' : '色', this.color, (c) => { this.color = c; app.requestRender(); }));
      if (two) items.push(colorInput('終点', this.color2, (c) => { this.color2 = c; app.requestRender(); }));
      const sw = document.createElement('span');
      sw.className = 'swatches';
      for (const c of this.recent) {
        const b = document.createElement('button');
        b.className = 'swatch';
        b.style.background = c;
        b.title = c;
        b.addEventListener('click', () => { this.color = c; if (this.mode === 'pick') this.mode = 'solid'; app.refreshUI(); });
        sw.append(b);
      }
      items.push(sw);
    }
    if (this.mode === 'linear' && this.target) items.push(separator(), button('範囲を選び直す', () => { this.reset(); app.refreshUI(); }));
    items.push(separator(), button('線を表示', () => app.updateSettings({ showLines: !app.settings.showLines }), { active: app.settings.showLines, title: 'オフにすると、塗りだけの仕上がりを確認できます' }));
    return items;
  }

  overlay(ctx: CanvasRenderingContext2D, view: View) {
    const outline = (face: Face, color: string) =>
      inWorld(ctx, view, () => {
        ctx.beginPath();
        traceFace(ctx, face);
        ctx.strokeStyle = color;
        ctx.lineWidth = 3 / view.zoom;
        ctx.setLineDash([8 / view.zoom, 5 / view.zoom]);
        ctx.stroke();
        ctx.setLineDash([]);
      });
    if (this.target) {
      const face = faceAt(layerFaces(this.layer()), this.target);
      if (face) {
        const prev = this.picker.preview;
        if (this.start && prev)
          inWorld(ctx, view, () =>
            paintFace(ctx, face, { type: 'linear', color: this.color, color2: this.color2, x1: this.start!.x, y1: this.start!.y, x2: prev.p.x, y2: prev.p.y }),
          );
        outline(face, COLORS.lineSel);
      }
      if (this.start) {
        const a = view.toScreen(this.start);
        const prev = this.picker.preview;
        if (prev) {
          const b = view.toScreen(prev.p);
          ctx.strokeStyle = COLORS.draft;
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          dot(ctx, b, this.color2);
        }
        dot(ctx, a, this.color);
      }
    } else if (this.hover) outline(this.hover, COLORS.draft);
    this.picker.draw(ctx, view);
  }

  focus() {
    return this.picker.preview?.p ?? null;
  }
}

function dot(ctx: CanvasRenderingContext2D, p: Vec, color: string) {
  ctx.beginPath();
  ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
}

/** 色の入力。色を選んでいる最中に作り直されないよう、input では再描画だけ行う */
function colorInput(text: string, value: string, onInput: (c: string) => void) {
  const wrap = document.createElement('label');
  wrap.className = 'color-field';
  const input = document.createElement('input');
  input.type = 'color';
  input.value = value;
  input.addEventListener('input', () => onInput(input.value));
  wrap.append(label(text), input);
  return wrap;
}
