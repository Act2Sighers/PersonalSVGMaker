import type { App, Tool } from '../app';
import type { Vec } from '../types';
import type { View } from '../view';
import { button, PointPicker } from './common';

/** グリッドの基準点をタップで指定する一時ツール */
export class OriginTool implements Tool {
  id = 'origin' as const;
  private picker: PointPicker;

  constructor(private app: App) {
    this.picker = new PointPicker(app);
  }

  down(s: Vec) { this.picker.begin(s); }
  move(s: Vec) {
    this.picker.update(s);
    this.app.requestRender();
  }
  up() {
    const p = this.picker.end();
    if (!p) return;
    this.app.mutate((d) => { d.grid.originX = p.x; d.grid.originY = p.y; });
    this.app.backToPrevTool();
  }
  cancelGesture() {
    this.picker.cancel();
    this.app.requestRender();
  }
  reset() { this.picker.cancel(); }
  hint() { return 'グリッドの基準点にする位置をタップ'; }
  options() { return [button('やめる', () => this.app.backToPrevTool())]; }
  overlay(ctx: CanvasRenderingContext2D, view: View) { this.picker.draw(ctx, view); }
  focus() { return this.picker.preview?.p ?? null; }
}
