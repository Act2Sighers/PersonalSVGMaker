import type { App, Tool } from '../app';
import type { Vec } from '../types';
import type { View } from '../view';
import { button, PointPicker } from './common';

/** 位置を1点だけタップで指定させる一時ツール（グリッドの基準点、ミラーの軸など） */
export class PickTool implements Tool {
  id = 'pick' as const;
  private message = '';
  private onPick: (p: Vec) => void = () => {};
  private picker: PointPicker;

  constructor(private app: App) {
    this.picker = new PointPicker(app);
  }

  start(message: string, onPick: (p: Vec) => void) {
    this.message = message;
    this.onPick = onPick;
    this.app.setMode('pen');
    this.app.setTool('pick');
  }

  down(s: Vec) { this.picker.begin(s); }
  move(s: Vec) {
    this.picker.update(s);
    this.app.requestRender();
  }
  up() {
    const p = this.picker.end();
    if (!p) return;
    this.app.backToPrevTool();
    this.onPick(p);
  }
  cancelGesture() {
    this.picker.cancel();
    this.app.requestRender();
  }
  reset() { this.picker.cancel(); }
  hint() { return this.message; }
  options() { return [button('やめる', () => this.app.backToPrevTool())]; }
  overlay(ctx: CanvasRenderingContext2D, view: View) { this.picker.draw(ctx, view); }
  focus() { return this.picker.preview?.p ?? null; }
}
