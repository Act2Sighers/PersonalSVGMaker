import type { Vec } from './types';

/** 画面座標 = (ワールド座標を rot だけ回して) * zoom + pan */
export class View {
  zoom = 1;
  /** 回転（ラジアン） */
  rot = 0;
  panX = 0;
  panY = 0;

  /** 画面座標への変換行列 [a, b, c, d, e, f]（Canvas の setTransform と同じ並び） */
  matrix(): [number, number, number, number, number, number] {
    const c = Math.cos(this.rot) * this.zoom, s = Math.sin(this.rot) * this.zoom;
    return [c, s, -s, c, this.panX, this.panY];
  }
  /** ワールドの向き v が画面でどちらを向くか（長さはそのまま） */
  dirToScreen(v: Vec): Vec {
    const c = Math.cos(this.rot), s = Math.sin(this.rot);
    return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
  }
  toScreen(p: Vec): Vec {
    const r = this.dirToScreen(p);
    return { x: r.x * this.zoom + this.panX, y: r.y * this.zoom + this.panY };
  }
  toWorld(p: Vec): Vec {
    const x = (p.x - this.panX) / this.zoom, y = (p.y - this.panY) / this.zoom;
    const c = Math.cos(this.rot), s = Math.sin(this.rot);
    return { x: x * c + y * s, y: -x * s + y * c };
  }
  /** ワールドの点 w が画面の点 s に来るように pan を決める */
  pin(w: Vec, s: Vec) {
    const r = this.dirToScreen(w);
    this.panX = s.x - r.x * this.zoom;
    this.panY = s.y - r.y * this.zoom;
  }
  /** 画面上の点 anchor を固定したまま拡大率を factor 倍 */
  zoomAt(anchor: Vec, factor: number) {
    const w = this.toWorld(anchor);
    this.zoom = Math.min(64, Math.max(0.05, this.zoom * factor));
    this.pin(w, anchor);
  }
  /** 画面上の点 anchor を固定したまま da だけ回す */
  rotateAt(anchor: Vec, da: number) {
    const w = this.toWorld(anchor);
    this.rot = normAngle(this.rot + da);
    this.pin(w, anchor);
  }
  /** 全体表示（回転も元に戻す） */
  fit(w: number, h: number, screenW: number, screenH: number, margin = 40) {
    this.rot = 0;
    this.zoom = Math.max(0.05, Math.min((screenW - margin * 2) / w, (screenH - margin * 2) / h));
    this.panX = (screenW - w * this.zoom) / 2;
    this.panY = (screenH - h * this.zoom) / 2;
  }
}

/** -π〜π に収める */
export function normAngle(a: number) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}
