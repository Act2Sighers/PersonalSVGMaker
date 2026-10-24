import type { App, Tool } from '../app';
import type { PathNode, Vec } from '../types';
import type { View } from '../view';
import { curveThrough3, pathPrims, uid } from '../doc';
import { dist, sub } from '../geom';
import { COLORS, inWorld, tracePrims } from '../render';
import { button, PointPicker, separator } from './common';

const TAP_PX = 8;

type Gesture = { kind: 'anchor' } | { kind: 'handle'; idx: number; downAt: Vec; dragged: boolean };

/**
 * 曲線ツール
 * ハンドルモード：
 *  1. タップで頂点を置く
 *  2. 置いた頂点から指をなぞると、その頂点の曲線ハンドルを引き出す
 *  3. 最後の頂点をもう一度タップで完了、始点をタップで閉じる
 * 3点モード：始点 → 通過点 → 終点 の順にタップすると、3点を通る曲線になる
 */
export class BezierTool implements Tool {
  id = 'bezier' as const;
  threePoint = false;
  private nodes: PathNode[] = [];
  private g: Gesture | null = null;
  private picker: PointPicker;

  constructor(private app: App) {
    this.picker = new PointPicker(app);
  }

  reset() {
    this.nodes = [];
    this.g = null;
    this.picker.cancel();
  }
  deactivate() {
    if (this.threePoint) this.reset();
    else this.finish(false);
  }

  private draft() {
    return { id: 'draft', type: 'path' as const, closed: false, nodes: this.threePoint ? [] : this.nodes };
  }

  private setThreePoint(on: boolean) {
    this.reset();
    this.threePoint = on;
    this.app.refreshUI();
  }

  down(s: Vec) {
    const n = this.nodes.length;
    const near = (i: number) => i >= 0 && i < n && dist(this.app.view.toScreen(this.nodes[i]), s) < 22;
    const idx = this.threePoint ? -1 : near(n - 1) ? n - 1 : n >= 2 && near(0) ? 0 : -1;
    if (idx >= 0) {
      this.g = { kind: 'handle', idx, downAt: s, dragged: false };
      return;
    }
    this.g = { kind: 'anchor' };
    const last = this.nodes[n - 1];
    this.picker.begin(s, {
      extraPrims: pathPrims(this.draft()),
      extraPoints: this.nodes.map((p) => ({ x: p.x, y: p.y })),
      ref: last ? { x: last.x, y: last.y } : null,
    });
  }

  move(s: Vec) {
    const g = this.g;
    if (!g) return;
    if (g.kind === 'anchor') this.picker.update(s);
    else {
      if (!g.dragged && dist(s, g.downAt) > TAP_PX) {
        g.dragged = true;
        this.picker.begin(s);
      }
      if (g.dragged) {
        this.picker.update(s);
        this.setHandle(g.idx, this.picker.preview!.p);
      }
    }
    this.app.requestRender();
  }

  private setHandle(idx: number, h: Vec) {
    const node = this.nodes[idx];
    const d = sub(h, node);
    if (Math.hypot(d.x, d.y) < 1e-6) { node.hin = node.hout = null; return; }
    node.hout = { x: node.x + d.x, y: node.y + d.y };
    node.hin = { x: node.x - d.x, y: node.y - d.y };
  }

  up() {
    const g = this.g;
    this.g = null;
    if (!g) return;
    if (g.kind === 'anchor') {
      const p = this.picker.end();
      if (p) this.nodes.push({ x: p.x, y: p.y, hin: null, hout: null });
      if (this.threePoint && this.nodes.length === 3) {
        const [a, b, c] = this.nodes;
        const nodes = curveThrough3(a, b, c);
        this.reset();
        if (nodes) this.app.addShape({ id: uid(), type: 'path', closed: false, nodes });
        else this.app.setStatus('同じ位置に点が重なっているため、曲線を作れません');
      }
    } else if (g.dragged) {
      this.picker.end();
    } else {
      // 頂点のタップ
      return this.finish(g.idx === 0 && this.nodes.length >= 2);
    }
    this.app.refreshUI();
  }

  cancelGesture() {
    this.g = null;
    this.picker.cancel();
    this.app.requestRender();
  }

  private finish(closed: boolean) {
    const nodes = this.nodes;
    this.reset();
    if (nodes.length >= 2) this.app.addShape({ id: uid(), type: 'path', closed, nodes });
    this.app.refreshUI();
  }

  hint() {
    const n = this.nodes.length;
    if (this.threePoint) return ['始点をタップ', '曲線が通る点をタップ', '終点をタップ'][n];
    if (!n) return '始点をタップ';
    return '次の頂点をタップ／置いた頂点からなぞるとハンドル／最後の頂点をタップで完了、始点をタップで閉じる';
  }

  options() {
    const n = this.nodes.length;
    const modes = [
      button('ハンドル', () => this.setThreePoint(false), { active: !this.threePoint, title: '頂点を置き、なぞってハンドルを引き出します' }),
      button('3点を通る', () => this.setThreePoint(true), { active: this.threePoint, title: '始点・通過点・終点をタップします' }),
      separator(),
    ];
    if (this.threePoint)
      return [
        ...modes,
        button('1点戻す', () => { this.nodes.pop(); this.app.refreshUI(); }, { disabled: !n }),
        button('取消', () => { this.reset(); this.app.refreshUI(); }, { disabled: !n }),
      ];
    return [
      ...modes,
      button('完了', () => this.finish(false), { disabled: n < 2 }),
      button('閉じる', () => this.finish(true), { disabled: n < 2 }),
      button('1点戻す', () => { this.nodes.pop(); this.app.refreshUI(); }, { disabled: !n }),
      button('取消', () => { this.reset(); this.app.refreshUI(); }, { disabled: !n }),
    ];
  }

  overlay(ctx: CanvasRenderingContext2D, view: View) {
    const nodes = this.nodes;
    const prev = this.g?.kind === 'anchor' ? this.picker.preview : null;
    if (nodes.length) {
      inWorld(ctx, view, () => {
        ctx.beginPath();
        tracePrims(ctx, pathPrims(this.draft()));
        ctx.strokeStyle = COLORS.draft;
        ctx.lineWidth = 2 / view.zoom;
        ctx.stroke();
        if (prev && this.threePoint) {
          const pts = [...nodes.map((q) => ({ x: q.x, y: q.y })), prev.p];
          const curve = pts.length === 3 ? curveThrough3(pts[0], pts[1], pts[2]) : null;
          ctx.beginPath();
          if (curve) tracePrims(ctx, pathPrims({ id: 'p', type: 'path', closed: false, nodes: curve }));
          else { ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y); }
          ctx.setLineDash([6 / view.zoom, 4 / view.zoom]);
          ctx.stroke();
        } else if (prev) {
          const last = nodes[nodes.length - 1];
          ctx.beginPath();
          ctx.moveTo(last.x, last.y);
          const c = last.hout ?? last;
          ctx.bezierCurveTo(c.x, c.y, prev.p.x, prev.p.y, prev.p.x, prev.p.y);
          ctx.setLineDash([6 / view.zoom, 4 / view.zoom]);
          ctx.stroke();
        }
      });
      for (const n of nodes) {
        const a = view.toScreen(n);
        for (const h of [n.hin, n.hout]) {
          if (!h) continue;
          const hs = view.toScreen(h);
          ctx.strokeStyle = COLORS.handle;
          ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(hs.x, hs.y); ctx.stroke();
          ctx.fillStyle = '#fff';
          ctx.beginPath(); ctx.arc(hs.x, hs.y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        }
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = COLORS.draft;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.rect(a.x - 4, a.y - 4, 8, 8); ctx.fill(); ctx.stroke();
      }
    }
    this.picker.draw(ctx, view);
  }

  focus() {
    return this.picker.preview?.p ?? null;
  }
}
