import type { App, Tool } from '../app';
import type { AnimProp, LayerNode, Vec } from '../types';
import type { View } from '../view';
import { findNode, layerEntries, shapePrims } from '../doc';
import { applyAffine, dist, distToPrim } from '../geom';
import { invert, newClip, nodeStates, parentState, pivotOf, restPose, setKey, type Pose } from '../anim';
import { layerFaces } from '../fills';
import { faceAt } from '../regions';
import { COLORS } from '../render';
import { button, PointPicker, separator } from './common';

type Mode = 'rotate' | 'move' | 'scale' | 'pivot';
type ScaleAxis = 'both' | 'x' | 'y';

const TAP_PX = 8;

/**
 * ポーズツール（アニメーション中だけ使う）：
 *  - パーツをタップして選ぶ（レイヤー一覧でフォルダーを選べば、フォルダーごと動かせる）
 *  - なぞって回転・移動・拡大縮小する。指を離すと、今の時刻にキーが打たれる
 *  - 中心点モードでは、描いたままの状態を表示して、回転・拡大縮小の中心をタップで置く
 */
export class PoseTool implements Tool {
  id = 'pose' as const;
  mode: Mode = 'rotate';
  axis: ScaleAxis = 'both';
  private start: Vec | null = null;
  private startScreen: Vec | null = null;
  private dragging = false;
  private base: Pose | null = null;
  private picker: PointPicker;

  constructor(private app: App) {
    this.picker = new PointPicker(app);
  }

  activate() { this.setMode(this.mode); }
  deactivate() { this.app.anim.rest = false; this.reset(); }
  reset() {
    this.start = this.startScreen = null;
    this.dragging = false;
    this.base = null;
    this.app.anim.override = null;
    this.picker.cancel();
  }

  private setMode(m: Mode) {
    this.mode = m;
    this.app.anim.rest = m === 'pivot';
    this.reset();
    this.app.refreshUI();
  }

  private node(): LayerNode | null {
    return findNode(this.app.doc, this.app.doc.activeId)?.node ?? null;
  }

  /** パーツの中心点の、今のポーズでの画面上の位置 */
  private pivotWorld(n: LayerNode): Vec {
    const st = nodeStates(this.app.doc, this.app.poses()).get(n.id);
    const pv = pivotOf(n);
    return st ? applyAffine(st.m, pv) : pv;
  }

  /** タップした所にあるパーツ（一番手前のレイヤー） */
  private pickLayer(s: Vec): string | null {
    const app = this.app;
    const w = app.view.toWorld(s);
    const states = nodeStates(app.doc, app.poses());
    const entries = layerEntries(app.doc).filter((e) => e.visible).reverse();
    for (const e of entries) {
      const st = states.get(e.layer.id);
      const local = st ? applyAffine(invert(st.m), w) : w;
      const faces = layerFaces(e.layer);
      const face = e.layer.fills.length ? faceAt(faces, local) : null;
      const onFill = !!face && e.layer.fills.some((f) => faceAt(faces, f.seed) === face);
      const onLine = e.layer.shapes.some((sh) => shapePrims(sh).some((p) => distToPrim(local, p) < app.tol * 0.6));
      if (onFill || onLine) return e.layer.id;
    }
    return null;
  }

  private currentPose(id: string): Pose {
    return { ...(this.app.poses().get(id) ?? restPose()) };
  }

  down(s: Vec) {
    if (this.mode === 'pivot') {
      this.picker.begin(s);
      return;
    }
    this.start = this.app.view.toWorld(s);
    this.startScreen = s;
    this.dragging = false;
    const n = this.node();
    this.base = n ? this.currentPose(n.id) : null;
  }

  move(s: Vec) {
    const app = this.app;
    if (this.mode === 'pivot') { this.picker.update(s); app.requestRender(); return; }
    if (!this.start || !this.startScreen) return;
    if (!this.dragging && dist(s, this.startScreen) > TAP_PX) this.dragging = true;
    const n = this.node();
    if (!this.dragging || !n || !this.base) return;
    const cur = app.view.toWorld(s);
    const c = this.pivotWorld(n);
    const p = { ...this.base };
    if (this.mode === 'rotate') {
      const a0 = Math.atan2(this.start.y - c.y, this.start.x - c.x), a1 = Math.atan2(cur.y - c.y, cur.x - c.x);
      let d = ((a1 - a0) * 180) / Math.PI;
      while (d > 180) d -= 360;
      while (d < -180) d += 360;
      p.rotate = +(this.base.rotate + d).toFixed(2);
    } else if (this.mode === 'move') {
      // 親が回転・拡大していても、指の動きどおりに動くように親の座標系へ直す
      const pm = invert(parentState(app.doc, nodeStates(app.doc, app.poses()), n.id).m);
      const dx = cur.x - this.start.x, dy = cur.y - this.start.y;
      p.x = +(this.base.x + pm.a * dx + pm.c * dy).toFixed(2);
      p.y = +(this.base.y + pm.b * dx + pm.d * dy).toFixed(2);
    } else {
      const r0 = dist(this.start, c), r1 = dist(cur, c);
      const k = r0 > 1e-6 ? r1 / r0 : 1;
      if (this.axis !== 'y') p.scaleX = +(this.base.scaleX * k).toFixed(4);
      if (this.axis !== 'x') p.scaleY = +(this.base.scaleY * k).toFixed(4);
    }
    app.anim.override = new Map([[n.id, p]]);
    const label = this.mode === 'rotate' ? `回転 ${p.rotate}°` : this.mode === 'move' ? `移動 ${p.x}, ${p.y}` : `大きさ ${p.scaleX} × ${p.scaleY}`;
    app.setStatus(label);
    app.requestRender();
  }

  up(s: Vec) {
    const app = this.app;
    if (this.mode === 'pivot') {
      const p = this.picker.end();
      const n = this.node();
      if (p && n) app.mutate((d) => { const x = findNode(d, n.id)?.node; if (x) x.pivot = p; });
      return;
    }
    if (!this.dragging) {
      // タップ：パーツを選ぶ
      const id = this.pickLayer(s);
      this.reset();
      if (id && id !== app.doc.activeId) { app.doc.activeId = id; app.scheduleSave(); }
      app.refreshUI();
      return;
    }
    const n = this.node();
    const pose = app.anim.override?.get(n?.id ?? '');
    this.reset();
    if (!n || !pose) return;
    const props: AnimProp[] = this.mode === 'rotate' ? ['rotate'] : this.mode === 'move' ? ['x', 'y'] : ['scaleX', 'scaleY'];
    this.commitKeys(n.id, pose, props);
  }

  /** 今の時刻にキーを打つ（クリップがなければ作る） */
  commitKeys(node: string, pose: Pose, props: AnimProp[]) {
    const app = this.app;
    app.mutate((d) => {
      let clip = d.animations.find((c) => c.id === app.anim.clipId) ?? d.animations[0];
      if (!clip) { clip = newClip('待機'); d.animations.push(clip); }
      app.anim.clipId = clip.id;
      for (const pr of props) setKey(clip, node, pr, +app.anim.time.toFixed(3), pose[pr]);
    });
    app.setStatus(`${app.anim.time.toFixed(2)}秒にキーを打ちました`);
  }

  cancelGesture() {
    this.reset();
    this.app.requestRender();
  }

  hint() {
    const n = this.node();
    const name = n ? `「${n.name}」` : 'パーツ';
    if (this.mode === 'pivot') return `${name}の回転・拡大縮小の中心をタップ（描いたままの状態で表示しています）`;
    const verb = this.mode === 'rotate' ? '回転' : this.mode === 'move' ? '移動' : '拡大縮小';
    return `${name}をなぞって${verb}（指を離すと今の時刻にキー）／タップでパーツを選ぶ`;
  }

  options() {
    const app = this.app;
    const items: HTMLElement[] = [
      button('回転', () => this.setMode('rotate'), { active: this.mode === 'rotate' }),
      button('移動', () => this.setMode('move'), { active: this.mode === 'move' }),
      button('拡大縮小', () => this.setMode('scale'), { active: this.mode === 'scale' }),
      button('中心点を置く', () => this.setMode('pivot'), { active: this.mode === 'pivot' }),
    ];
    if (this.mode === 'scale') {
      items.push(separator());
      for (const [id, label] of [['both', '縦横'], ['x', '横だけ'], ['y', '縦だけ']] as const)
        items.push(button(label, () => { this.axis = id; app.refreshUI(); }, { active: this.axis === id }));
    }
    const at = findNode(app.doc, app.doc.activeId);
    items.push(separator(), button('親のフォルダーを選ぶ', () => {
      if (!at?.parent) return;
      app.doc.activeId = at.parent.id;
      app.refreshUI();
    }, { disabled: !at?.parent, title: 'フォルダーを選ぶと、中のパーツをまとめて動かせます' }));
    if (this.mode === 'pivot' && at?.node.pivot)
      items.push(button('中心点を自動に戻す', () => app.mutate((d) => { const x = findNode(d, at.node.id)?.node; if (x) delete x.pivot; })));
    return items;
  }

  overlay(ctx: CanvasRenderingContext2D, view: View) {
    const n = this.node();
    if (n) {
      const states = nodeStates(this.app.doc, this.app.poses());
      // 選んでいるパーツの中心点
      const st = states.get(n.id);
      const c = view.toScreen(st ? applyAffine(st.m, pivotOf(n)) : pivotOf(n));
      ctx.strokeStyle = COLORS.origin;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 8, 0, Math.PI * 2);
      ctx.moveTo(c.x - 13, c.y); ctx.lineTo(c.x + 13, c.y);
      ctx.moveTo(c.x, c.y - 13); ctx.lineTo(c.x, c.y + 13);
      ctx.stroke();
      if (this.dragging && this.start && this.mode !== 'move') {
        const s = view.toScreen(this.start);
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = COLORS.draft;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(s.x, s.y); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    this.picker.draw(ctx, view);
  }

  focus() {
    return this.picker.preview?.p ?? null;
  }
}
