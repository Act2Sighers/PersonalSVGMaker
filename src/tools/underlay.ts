import type { App, Tool } from '../app';
import type { Doc, UnderlayPlacement, Vec } from '../types';
import type { View } from '../view';
import { COLORS } from '../render';
import { button, label, separator } from './common';

/** 調整する下書き：作品の下書きか、クリップの下書き */
export type UnderlayTarget = { kind: 'doc'; id: string } | { kind: 'clip'; clip: string; id: string };

export function findPlacement(doc: Doc, t: UnderlayTarget): UnderlayPlacement | undefined {
  if (t.kind === 'doc') return doc.underlays.find((u) => u.id === t.id);
  return doc.animations.find((c) => c.id === t.clip)?.underlays.find((u) => u.id === t.id);
}

/** 下書きの位置合わせ：なぞって動かし、ボタンで大きさを変える */
export class UnderlayTool implements Tool {
  id = 'underlay' as const;
  private target: UnderlayTarget | null = null;
  private start: Vec | null = null;
  private preview: Vec | null = null;

  constructor(private app: App) {}

  begin(t: UnderlayTarget) {
    this.target = t;
    this.app.setMode('pen');
    this.app.setTool('underlay');
    this.app.refreshUI();
  }

  private place() {
    return this.target ? findPlacement(this.app.doc, this.target) : undefined;
  }

  private edit(fn: (u: UnderlayPlacement) => void) {
    const t = this.target;
    if (!t) return;
    this.app.mutate((d) => { const u = findPlacement(d, t); if (u) fn(u); });
  }

  down(s: Vec) {
    const u = this.place();
    if (!u) return;
    this.start = this.app.view.toWorld(s);
  }
  move(s: Vec) {
    if (!this.start) return;
    const w = this.app.view.toWorld(s);
    this.preview = { x: w.x - this.start.x, y: w.y - this.start.y };
    this.app.requestRender();
  }
  up() {
    const d = this.preview;
    this.start = null;
    this.preview = null;
    if (d && (d.x || d.y)) this.edit((u) => { u.x += d.x; u.y += d.y; });
    this.app.requestRender();
  }
  cancelGesture() {
    this.start = null;
    this.preview = null;
    this.app.requestRender();
  }

  private scale(k: number) {
    this.edit((u) => {
      const cx = u.x + u.w / 2, cy = u.y + u.h / 2;
      u.w *= k; u.h *= k;
      u.x = cx - u.w / 2; u.y = cy - u.h / 2;
    });
  }

  hint() { return '画面をなぞると下書きが動きます。大きさは上のボタンで変えられます'; }

  options() {
    const app = this.app;
    const u = this.place();
    const fit = () => this.edit((p) => {
      const k = Math.min(app.doc.width / p.w, app.doc.height / p.h);
      p.w *= k; p.h *= k;
      p.x = (app.doc.width - p.w) / 2; p.y = (app.doc.height - p.h) / 2;
    });
    return [
      label('大きさ'),
      button('−10%', () => this.scale(0.9)),
      button('−1%', () => this.scale(0.99)),
      button('+1%', () => this.scale(1.01)),
      button('+10%', () => this.scale(1.1)),
      button('キャンバスに合わせる', fit),
      separator(),
      label(u ? `幅 ${Math.round(u.w)} × 高さ ${Math.round(u.h)}` : ''),
      separator(),
      button('完了', () => app.backToPrevTool()),
    ];
  }

  overlay(ctx: CanvasRenderingContext2D, view: View) {
    const u = this.place();
    if (!u) return;
    const d = this.preview ?? { x: 0, y: 0 };
    const x = u.x + d.x, y = u.y + d.y;
    const cs = [{ x, y }, { x: x + u.w, y }, { x: x + u.w, y: y + u.h }, { x, y: y + u.h }].map((p) => view.toScreen(p));
    ctx.beginPath();
    cs.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.strokeStyle = COLORS.lineSel;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** 動かしている途中の位置（描画で使う） */
  offset(): Vec | null {
    return this.preview;
  }
  targetId(): string | null {
    return this.target?.id ?? null;
  }

  focus() { return null; }
}
