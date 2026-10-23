import type { Vec } from './types';

/** 画面座標 = ワールド座標 * zoom + pan */
export class View {
  zoom = 1;
  panX = 0;
  panY = 0;

  toScreen(p: Vec): Vec {
    return { x: p.x * this.zoom + this.panX, y: p.y * this.zoom + this.panY };
  }
  toWorld(p: Vec): Vec {
    return { x: (p.x - this.panX) / this.zoom, y: (p.y - this.panY) / this.zoom };
  }
  /** 画面上の点 anchor を固定したまま拡大率を factor 倍 */
  zoomAt(anchor: Vec, factor: number) {
    const w = this.toWorld(anchor);
    this.zoom = Math.min(64, Math.max(0.05, this.zoom * factor));
    this.panX = anchor.x - w.x * this.zoom;
    this.panY = anchor.y - w.y * this.zoom;
  }
  fit(w: number, h: number, screenW: number, screenH: number, margin = 40) {
    this.zoom = Math.max(0.05, Math.min((screenW - margin * 2) / w, (screenH - margin * 2) / h));
    this.panX = (screenW - w * this.zoom) / 2;
    this.panY = (screenH - h * this.zoom) / 2;
  }
}
