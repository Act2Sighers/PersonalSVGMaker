import type { App } from '../app';
import type { Vec } from '../types';
import type { View } from '../view';
import { SNAP_LABEL, type SnapContext, type SnapOptions, type SnapResult } from '../snap';
import { drawSnap } from '../render';

/**
 * 指を置いて動かしている間はスナップ先を表示し、指を離した位置で点を確定する。
 * 指で隠れる位置はルーペで確認する。
 */
export class PointPicker {
  preview: SnapResult | null = null;
  private ctx: SnapContext | null = null;

  constructor(private app: App) {}

  begin(screen: Vec, opts?: SnapOptions) {
    this.ctx = this.app.snapContext(opts);
    this.update(screen);
  }
  update(screen: Vec) {
    if (!this.ctx) return;
    this.preview = this.ctx.snap(this.app.view.toWorld(screen), this.app.tol);
    const p = this.preview.p;
    const label = SNAP_LABEL[this.preview.kind];
    this.app.setStatus(`x ${fmt(p.x)}, y ${fmt(p.y)}${label ? `（${label}）` : ''}`);
  }
  /** 確定した点を返して終了 */
  end(): Vec | null {
    const p = this.preview?.p ?? null;
    this.cancel();
    return p;
  }
  cancel() {
    this.preview = null;
    this.ctx = null;
    this.app.setStatus('');
  }
  get active() {
    return this.preview !== null;
  }
  draw(ctx: CanvasRenderingContext2D, view: View) {
    if (this.preview) drawSnap(ctx, view, this.preview);
  }
}

export const fmt = (n: number) => String(Math.round(n * 100) / 100);

export function button(label: string, onClick: () => void, opts: { active?: boolean; disabled?: boolean; title?: string } = {}) {
  const b = document.createElement('button');
  b.className = 'opt-btn' + (opts.active ? ' active' : '');
  b.textContent = label;
  if (opts.title) b.title = opts.title;
  b.disabled = !!opts.disabled;
  b.addEventListener('click', onClick);
  return b;
}

export function separator() {
  const s = document.createElement('span');
  s.className = 'opt-sep';
  return s;
}

export function label(text: string) {
  const s = document.createElement('span');
  s.className = 'opt-label';
  s.textContent = text;
  return s;
}

/** - [数値] + の入力 */
export function stepper(value: number, min: number, max: number, onChange: (v: number) => void) {
  const wrap = document.createElement('span');
  wrap.className = 'stepper';
  const val = document.createElement('span');
  val.className = 'stepper-val';
  val.textContent = String(value);
  wrap.append(
    button('−', () => onChange(Math.max(min, value - 1)), { disabled: value <= min }),
    val,
    button('+', () => onChange(Math.min(max, value + 1)), { disabled: value >= max }),
  );
  return wrap;
}
