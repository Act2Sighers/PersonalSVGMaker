import type { App } from './app';
import type { Vec } from './types';
import { dist } from './geom';
import { normAngle } from './view';

interface Pair {
  /** 2点の中点 */
  c: Vec;
  /** 2点の距離 */
  d: number;
  /** 2点を結ぶ向き（ラジアン） */
  a: number;
}

const TAP_MS = 350;
const TAP_MOVE_PX = 12;
/** 2本指の回転を、0°・90°・180°・270° に吸い寄せる幅 */
const ROT_SNAP = (4 * Math.PI) / 180;

/**
 * キャンバスの指操作：
 *  - ペン状態: 1本指 = ツール操作
 *  - ハンド状態: 1本指 = キャンバス移動
 *  - どちらでも: 2本指 = 移動・回転・ズーム（2点の位置に合わせる）、2本指タップ = 作図中なら点を1つ取り消し／それ以外は元に戻す、3本指タップ = やり直し
 */
export function attachInput(canvas: HTMLCanvasElement, app: App) {
  const pts = new Map<number, Vec>();
  let state: 'idle' | 'tool' | 'pan' | 'multi' = 'idle';
  let toolPointer = -1;
  let startTime = 0;
  let maxCount = 0;
  let moved = false;
  let last: Pair | null = null;
  let first: Pair | null = null;
  /** 2本指を置いたときの、キャンバスの回転 */
  let baseRot = 0;
  let panLast: Vec | null = null;

  const pos = (e: PointerEvent): Vec => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const pair = (): Pair => {
    const [a, b] = [...pts.values()];
    return { c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, d: Math.max(1, dist(a, b)), a: Math.atan2(b.y - a.y, b.x - a.x) };
  };
  const beginPair = () => {
    last = first = pair();
    baseRot = app.view.rot;
  };

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = pos(e);
    pts.set(e.pointerId, p);
    if (pts.size === 1) {
      startTime = performance.now();
      maxCount = 1;
      moved = false;
      if (app.mode === 'hand' || e.button === 1) {
        state = 'pan';
        panLast = p;
      } else {
        state = 'tool';
        toolPointer = e.pointerId;
        app.fingerAt = p;
        app.tool.down(p);
      }
      return;
    }
    if (state === 'tool') {
      app.tool.cancelGesture();
      app.fingerAt = null;
    }
    state = 'multi';
    maxCount = Math.max(maxCount, pts.size);
    beginPair();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = pos(e);
    pts.set(e.pointerId, p);
    if (state === 'tool' && e.pointerId === toolPointer) {
      app.fingerAt = p;
      app.tool.move(p);
    } else if (state === 'pan' && panLast) {
      app.view.panX += p.x - panLast.x;
      app.view.panY += p.y - panLast.y;
      panLast = p;
      app.requestRender();
    } else if (state === 'multi' && pts.size >= 2 && last) {
      const cur = pair();
      app.view.panX += cur.c.x - last.c.x;
      app.view.panY += cur.c.y - last.c.y;
      app.view.zoomAt(cur.c, cur.d / last.d);
      if (first) {
        // 置いたときからの回転量で決める（直角の近くでは吸い寄せる）
        let target = baseRot + normAngle(cur.a - first.a);
        const q = Math.round(target / (Math.PI / 2)) * (Math.PI / 2);
        if (Math.abs(target - q) < ROT_SNAP) target = q;
        app.view.rotateAt(cur.c, normAngle(target - app.view.rot));
        const arc = Math.abs(normAngle(cur.a - first.a)) * cur.d / 2;
        if (dist(cur.c, first.c) > TAP_MOVE_PX || Math.abs(cur.d - first.d) > TAP_MOVE_PX || arc > TAP_MOVE_PX) moved = true;
      }
      last = cur;
      app.requestRender();
      app.onUI();
    }
  });

  const end = (e: PointerEvent, cancelled: boolean) => {
    if (!pts.has(e.pointerId)) return;
    const p = pos(e);
    pts.delete(e.pointerId);
    if (state === 'tool' && e.pointerId === toolPointer) {
      app.fingerAt = null;
      if (cancelled) app.tool.cancelGesture();
      else app.tool.up(p);
      state = 'idle';
    } else if (state === 'pan') {
      state = 'idle';
    } else if (state === 'multi') {
      if (pts.size >= 2) beginPair();
      if (pts.size === 0) {
        if (!moved && !cancelled && performance.now() - startTime < TAP_MS) {
          // 作図中なら点を1つ取り消し、そうでなければ元に戻す
          if (maxCount === 2) { if (!app.tool.stepBack?.()) app.undo(); }
          else if (maxCount === 3) app.redo();
        }
        state = 'idle';
      }
    }
    app.requestRender();
  };
  canvas.addEventListener('pointerup', (e) => end(e, false));
  canvas.addEventListener('pointercancel', (e) => end(e, true));

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const anchor = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (e.ctrlKey || !e.deltaX) app.view.zoomAt(anchor, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
      else { app.view.panX -= e.deltaX; app.view.panY -= e.deltaY; }
      app.requestRender();
      app.onUI();
    },
    { passive: false },
  );
}
