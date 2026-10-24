import type { App, Tool } from '../app';
import type { Vec } from '../types';
import type { View } from '../view';
import { dist } from '../geom';
import { COLORS } from '../render';
import { fitStroke, resample, smooth, type FreehandMode } from '../fit';
import type { SnapResult } from '../snap';
import { button, label, separator } from './common';

const DETAIL: { id: string; label: string; px: number }[] = [
  { id: 'coarse', label: '粗い', px: 130 },
  { id: 'normal', label: '普通', px: 80 },
  { id: 'fine', label: '細かい', px: 45 },
];

/** 端や途中の点として吸着させてよい種類（グリッドや延長線には吸着させない） */
const STICKY = new Set<SnapResult['kind']>(['point', 'intersection', 'tangent', 'online']);

/**
 * 手描きツール：指でなぞった一筆書きの線を、直線・曲線（・円）に置き換える。
 *  - 等間隔：線の長さを同じくらいの長さに等分し、それぞれを直線か曲線にする（円にはしない）
 *  - 角で区切る：はっきりした角で区切り、それぞれを直線・曲線・円のどれかにする
 * 始点と終点は既存の点や線に吸着し、途中で既存の点や交点のすぐ近くを通ったら、そこを通る頂点にする。
 */
export class FreehandTool implements Tool {
  id = 'freehand' as const;
  mode: FreehandMode = 'corner';
  detail = 'normal';
  private raw: Vec[] = [];

  constructor(private app: App) {}

  reset() { this.raw = []; }

  down(s: Vec) {
    this.raw = [this.app.view.toWorld(s)];
  }
  move(s: Vec) {
    if (!this.raw.length) return;
    const w = this.app.view.toWorld(s);
    if (dist(w, this.raw[this.raw.length - 1]) * this.app.view.zoom >= 1.5) this.raw.push(w);
    this.app.requestRender();
  }
  up(s: Vec) {
    if (!this.raw.length) return;
    this.raw.push(this.app.view.toWorld(s));
    const raw = this.raw;
    this.raw = [];
    this.convert(raw);
    this.app.refreshUI();
  }
  cancelGesture() {
    this.raw = [];
    this.app.requestRender();
  }

  private convert(raw: Vec[]) {
    const app = this.app;
    const px = 1 / app.view.zoom;
    const length = raw.reduce((sum, p, i) => (i ? sum + dist(raw[i - 1], p) : 0), 0);
    if (length < 8 * px) return;

    const ctx = app.snapContext();
    const stick = (p: Vec): Vec | null => {
      const r = ctx.snap(p, app.tol);
      return STICKY.has(r.kind) ? r.p : null;
    };
    const pts = raw.slice();
    pts[0] = stick(pts[0]) ?? pts[0];
    const end = pts[pts.length - 1];
    // 始点の近くで描き終えたら閉じる
    pts[pts.length - 1] = dist(end, pts[0]) < app.tol && length > app.tol * 4 ? pts[0] : stick(end) ?? end;

    const p = smooth(resample(pts, 3 * px));
    const n = p.length;
    if (n < 2) return;

    // 途中で既存の点・交点のすぐ近くを通った所
    const forced: (Vec | null)[] = p.map(() => null);
    const margin = Math.max(2, Math.round((10 * px) / (3 * px)));
    for (const c of [...ctx.points, ...ctx.intersections, ...ctx.tangents]) {
      let best = -1, bestD = app.tol * 0.5;
      for (let i = margin; i < n - margin; i++) {
        const d = dist(p[i], c);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best < 0) continue;
      // 近すぎる区切りは作らない
      if (forced.some((f, i) => f && Math.abs(i - best) < margin)) continue;
      forced[best] = c;
    }

    // 必ず通る点へのずれを、前後の区切り（端や他の通る点）まで直線的に薄めながら全体を寄せる。
    // こうすると、まっすぐ描いた部分はまっすぐなまま、その点を通るようになる。
    const anchors = [0, ...forced.map((f, i) => (f ? i : -1)).filter((i) => i > 0), n - 1];
    const q = p.map((v) => ({ ...v }));
    for (let j = 1; j + 1 < anchors.length; j++) {
      const a = anchors[j - 1], i = anchors[j], b = anchors[j + 1];
      const d = { x: forced[i]!.x - p[i].x, y: forced[i]!.y - p[i].y };
      for (let m = a + 1; m < b; m++) {
        const w = m <= i ? (m - a) / (i - a) : (b - m) / (b - i);
        q[m].x += d.x * w;
        q[m].y += d.y * w;
      }
    }
    p.splice(0, n, ...q);

    const interval = (DETAIL.find((d) => d.id === this.detail)?.px ?? 80) * px;
    const shapes = fitStroke(p, { mode: this.mode, interval, px, forced });
    if (!shapes.length) return;
    app.addShapes(shapes);
    const parts = shapes.map((s) => (s.type === 'circle' ? '円' : `${s.closed ? '閉じた' : ''}線（頂点${s.nodes.length}個）`));
    app.setStatus(`${parts.join('・')}に変換しました`);
  }

  hint() {
    return this.mode === 'corner'
      ? '一筆書きでなぞってください。角で区切って、直線・曲線・円に置き換えます'
      : '一筆書きでなぞってください。同じくらいの長さに区切って、直線・曲線に置き換えます';
  }

  options() {
    const app = this.app;
    const items: HTMLElement[] = [
      button('角で区切る', () => { this.mode = 'corner'; app.refreshUI(); }, { active: this.mode === 'corner' }),
      button('等間隔', () => { this.mode = 'even'; app.refreshUI(); }, { active: this.mode === 'even' }),
    ];
    if (this.mode === 'even') {
      items.push(separator(), label('区切りの長さ'));
      for (const d of DETAIL) items.push(button(d.label, () => { this.detail = d.id; app.refreshUI(); }, { active: this.detail === d.id }));
    }
    return items;
  }

  overlay(ctx: CanvasRenderingContext2D, view: View) {
    if (this.raw.length < 2) return;
    ctx.strokeStyle = COLORS.draft;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    this.raw.forEach((w, i) => {
      const s = view.toScreen(w);
      if (i) ctx.lineTo(s.x, s.y);
      else ctx.moveTo(s.x, s.y);
    });
    ctx.stroke();
  }

  focus() {
    return null;
  }
}
