import type { App, Tool } from '../app';
import type { PathNode, Vec } from '../types';
import type { View } from '../view';
import { pathPrims, uid } from '../doc';
import { dist, sub } from '../geom';
import { COLORS, inWorld, tracePrims } from '../render';
import { button, PointPicker } from './common';

const TAP_PX = 8;

type Gesture = { kind: 'anchor' } | { kind: 'handle'; idx: number; downAt: Vec; dragged: boolean };

/**
 * 曲線ツール：
 *  1. タップで頂点を置く
 *  2. 置いた頂点から指をなぞると、その頂点の曲線ハンドルを引き出す
 *  3. 最後の頂点をもう一度タップで完了、始点をタップで閉じる
 */
export class BezierTool implements Tool {
  id = 'bezier' as const;
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
  deactivate() { this.finish(false); }

  private draft() {
    return { id: 'draft', type: 'path' as const, closed: false, nodes: this.nodes };
  }

  down(s: Vec) {
    const n = this.nodes.length;
    const near = (i: number) => i >= 0 && i < n && dist(this.app.view.toScreen(this.nodes[i]), s) < 22;
    const idx = near(n - 1) ? n - 1 : n >= 2 && near(0) ? 0 : -1;
    if (idx >= 0) {
      this.g = { kind: 'handle', idx, downAt: s, dragged: false };
      return;
    }
    this.g = { kind: 'anchor' };
    this.picker.begin(s, { extraPrims: pathPrims(this.draft()), extraPoints: this.nodes.map((p) => ({ x: p.x, y: p.y })) });
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
    if (!n) return '始点をタップ';
    return '次の頂点をタップ／置いた頂点からなぞるとハンドル／最後の頂点をタップで完了、始点をタップで閉じる';
  }

  options() {
    const n = this.nodes.length;
    return [
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
        if (prev) {
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
