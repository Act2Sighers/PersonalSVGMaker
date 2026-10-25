import type { App } from './app';
import type { View } from './view';
import type { Layer, LayerNode, Paint, Shape, UnderlayPlacement, Vec } from './types';
import { layerFaces } from './fills';
import { faceAt, traceFace, type Face } from './regions';
import { nodeStates, type NodeState, type Pose } from './anim';
import { currentFrame, getImage } from './underlay';
import { allShapes, anchorKeys, selectableShapes, getPoint, ref, shapePrims } from './doc';
import type { Prim } from './geom';
import type { SnapResult } from './snap';

export const COLORS = {
  bg: '#3a3c42',
  board: '#ffffff',
  boardEdge: '#8a8d96',
  gridMinor: 'rgba(60,90,160,0.13)',
  gridMajor: 'rgba(60,90,160,0.32)',
  origin: '#e2533a',
  line: '#1d1f24',
  lineSel: '#2f6bff',
  point: '#555a66',
  pointSel: '#2f6bff',
  handle: '#9b59ff',
  draft: '#ff7a1a',
  ghost: 'rgba(47,107,255,0.75)',
  snap: '#ff3d7f',
  guide: 'rgba(255,61,127,0.65)',
  mirror: '#16a89a',
};

/** ワールド座標で描くための変換を設定 */
export function worldTransform(ctx: CanvasRenderingContext2D, view: View, dpr: number) {
  const [a, b, c, d, e, f] = view.matrix();
  ctx.setTransform(dpr * a, dpr * b, dpr * c, dpr * d, dpr * e, dpr * f);
}

/** 画面座標系の上にワールド座標系を重ねて fn を実行（ツールの重ね描き用） */
export function inWorld(ctx: CanvasRenderingContext2D, view: View, fn: () => void) {
  ctx.save();
  ctx.transform(...view.matrix());
  fn();
  ctx.restore();
}

export function tracePrims(ctx: CanvasRenderingContext2D, prims: Prim[]) {
  let last: Vec | null = null;
  for (const p of prims) {
    if (p.kind === 'circle') {
      ctx.moveTo(p.c.x + p.r, p.c.y);
      ctx.arc(p.c.x, p.c.y, p.r, 0, Math.PI * 2);
      last = null;
      continue;
    }
    const a = p.kind === 'line' ? p.a : p.p0;
    if (!last || last.x !== a.x || last.y !== a.y) ctx.moveTo(a.x, a.y);
    if (p.kind === 'line') { ctx.lineTo(p.b.x, p.b.y); last = p.b; }
    else { ctx.bezierCurveTo(p.p1.x, p.p1.y, p.p2.x, p.p2.y, p.p3.x, p.p3.y); last = p.p3; }
  }
}

export function strokeShapes(ctx: CanvasRenderingContext2D, view: View, shapes: Shape[], color: string, widthPx = 1.5) {
  ctx.beginPath();
  for (const s of shapes) tracePrims(ctx, shapePrims(s));
  ctx.strokeStyle = color;
  ctx.lineWidth = widthPx / view.zoom;
  ctx.stroke();
}

function drawGrid(ctx: CanvasRenderingContext2D, app: App, view: View, w: number, h: number) {
  const g = app.doc.grid;
  if (!g.visible || g.spacing <= 0) return;
  // 画面が回っていてもよいように、画面の四隅を含むワールドの範囲を求める
  const cs = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: 0, y: h }, { x: w, y: h }].map((p) => view.toWorld(p));
  const tl = { x: Math.min(...cs.map((p) => p.x)), y: Math.min(...cs.map((p) => p.y)) };
  const br = { x: Math.max(...cs.map((p) => p.x)), y: Math.max(...cs.map((p) => p.y)) };
  const minorPx = g.spacing * view.zoom;
  const majorPx = minorPx * Math.max(1, g.majorEvery);
  if (majorPx < 6) return;
  const showMinor = minorPx >= 6;
  const i0 = Math.floor((tl.x - g.originX) / g.spacing), i1 = Math.ceil((br.x - g.originX) / g.spacing);
  const j0 = Math.floor((tl.y - g.originY) / g.spacing), j1 = Math.ceil((br.y - g.originY) / g.spacing);
  const lw = 1 / view.zoom;
  const pass = (major: boolean) => {
    ctx.beginPath();
    for (let i = i0; i <= i1; i++) {
      const isMajor = g.majorEvery > 0 && i % g.majorEvery === 0;
      if (isMajor !== major || (!major && !showMinor)) continue;
      const x = g.originX + i * g.spacing;
      ctx.moveTo(x, tl.y); ctx.lineTo(x, br.y);
    }
    for (let j = j0; j <= j1; j++) {
      const isMajor = g.majorEvery > 0 && j % g.majorEvery === 0;
      if (isMajor !== major || (!major && !showMinor)) continue;
      const y = g.originY + j * g.spacing;
      ctx.moveTo(tl.x, y); ctx.lineTo(br.x, y);
    }
    ctx.strokeStyle = major ? COLORS.gridMajor : COLORS.gridMinor;
    ctx.lineWidth = lw;
    ctx.stroke();
  };
  pass(false);
  pass(true);
}

function drawOrigin(ctx: CanvasRenderingContext2D, app: App, view: View) {
  const g = app.doc.grid;
  if (!g.visible) return;
  const o = view.toScreen({ x: g.originX, y: g.originY });
  ctx.strokeStyle = COLORS.origin;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(o.x - 9, o.y); ctx.lineTo(o.x + 9, o.y);
  ctx.moveTo(o.x, o.y - 9); ctx.lineTo(o.x, o.y + 9);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(o.x, o.y, 4, 0, Math.PI * 2);
  ctx.stroke();
}

/** 画面座標で描く（dpr のみ適用） */
export function screenTransform(ctx: CanvasRenderingContext2D, dpr: number) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

export function drawMarker(ctx: CanvasRenderingContext2D, s: Vec, kind: 'square' | 'circle' | 'diamond', size: number, fill: string | null, stroke: string) {
  ctx.beginPath();
  if (kind === 'square') ctx.rect(s.x - size, s.y - size, size * 2, size * 2);
  else if (kind === 'circle') ctx.arc(s.x, s.y, size, 0, Math.PI * 2);
  else { ctx.moveTo(s.x, s.y - size); ctx.lineTo(s.x + size, s.y); ctx.lineTo(s.x, s.y + size); ctx.lineTo(s.x - size, s.y); ctx.closePath(); }
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

/** スナップ位置の表示（画面座標系で呼ぶ） */
export function drawSnap(ctx: CanvasRenderingContext2D, view: View, r: SnapResult) {
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = COLORS.guide;
  ctx.lineWidth = 1;
  for (const g of r.guides) {
    const a = view.toScreen(g.a), b = view.toScreen(g.b);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.restore();
  const s = view.toScreen(r.p);
  ctx.strokeStyle = COLORS.snap;
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (r.kind === 'point') ctx.rect(s.x - 7, s.y - 7, 14, 14);
  else if (r.kind === 'intersection') { ctx.moveTo(s.x - 7, s.y - 7); ctx.lineTo(s.x + 7, s.y + 7); ctx.moveTo(s.x + 7, s.y - 7); ctx.lineTo(s.x - 7, s.y + 7); }
  else if (r.kind === 'extension') { ctx.arc(s.x, s.y, 7, 0, Math.PI * 2); }
  else if (r.kind === 'tangent') { ctx.arc(s.x, s.y - 4, 4, 0, Math.PI * 2); ctx.moveTo(s.x - 9, s.y); ctx.lineTo(s.x + 9, s.y); }
  else if (r.kind === 'online') { ctx.moveTo(s.x, s.y - 8); ctx.lineTo(s.x + 8, s.y); ctx.lineTo(s.x, s.y + 8); ctx.lineTo(s.x - 8, s.y); ctx.closePath(); }
  else if (r.kind === 'perp') { ctx.moveTo(s.x - 8, s.y + 6); ctx.lineTo(s.x + 8, s.y + 6); ctx.moveTo(s.x, s.y + 6); ctx.lineTo(s.x, s.y - 9); }
  else if (r.kind === 'grid') { ctx.moveTo(s.x - 8, s.y); ctx.lineTo(s.x + 8, s.y); ctx.moveTo(s.x, s.y - 8); ctx.lineTo(s.x, s.y + 8); }
  else { ctx.arc(s.x, s.y, 3, 0, Math.PI * 2); }
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(s.x, s.y, 1.8, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.snap;
  ctx.fill();
}

export function canvasPaint(ctx: CanvasRenderingContext2D, p: Paint): string | CanvasGradient {
  if (p.type === 'solid') return p.color;
  const g = ctx.createLinearGradient(p.x1, p.y1, p.x2, p.y2);
  g.addColorStop(0, p.color);
  g.addColorStop(1, p.color2);
  return g;
}

/** ワールド座標系で、範囲を指定の塗りで塗る */
export function paintFace(ctx: CanvasRenderingContext2D, face: Face, paint: Paint) {
  ctx.beginPath();
  traceFace(ctx, face);
  ctx.fillStyle = canvasPaint(ctx, paint);
  ctx.fill('evenodd');
}

function drawFills(ctx: CanvasRenderingContext2D, layer: Layer) {
  if (!layer.fills.length) return;
  const faces = layerFaces(layer);
  for (const f of layer.fills) {
    const face = faceAt(faces, f.seed);
    if (face) paintFace(ctx, face, f.paint);
  }
}

/** 半透明のフォルダーを描くための作業用キャンバス（入れ子の深さごとに使い回す） */
const offscreens: HTMLCanvasElement[] = [];
function offscreen(depth: number, o: DrawOpts): CanvasRenderingContext2D {
  const c = (offscreens[depth] ??= document.createElement('canvas'));
  const w = Math.round(o.w * o.dpr), h = Math.round(o.h * o.dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const ctx = c.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

/**
 * レイヤーの木を描く。不透明度はレイヤー・フォルダーそのものの値に、アニメーションの値を掛け合わせる。
 * 半透明のフォルダーは、中身をまとめて描いてから薄くする（中で重なった所が二重に透けないように）。
 */
function drawTree(ctx: CanvasRenderingContext2D, view: View, nodes: LayerNode[], poses: Map<string, Pose>, states: Map<string, NodeState> | null, lines: boolean, o: DrawOpts, depth: number) {
  for (const n of nodes) {
    if (!n.visible) continue;
    const own = Math.max(0, Math.min(1, (n.opacity ?? 1) * (poses.get(n.id)?.opacity ?? 1)));
    if (own <= 0) continue;
    if (n.kind === 'folder') {
      if (own >= 0.999) { drawTree(ctx, view, n.children, poses, states, lines, o, depth); continue; }
      const off = offscreen(depth, o);
      off.setTransform(ctx.getTransform());
      drawTree(off, view, n.children, poses, states, lines, o, depth + 1);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = own;
      ctx.drawImage(off.canvas, 0, 0);
      ctx.restore();
      continue;
    }
    ctx.save();
    const st = states?.get(n.id);
    if (st) ctx.transform(st.m.a, st.m.b, st.m.c, st.m.d, st.m.e, st.m.f);
    ctx.globalAlpha = own;
    drawFills(ctx, n);
    if (lines) strokeShapes(ctx, view, n.shapes, COLORS.line);
    ctx.restore();
  }
}

/** 下書き画像（形の編集中は作品の下書き、アニメーション中はクリップの下書きがあればそちら） */
function drawUnderlays(ctx: CanvasRenderingContext2D, app: App) {
  const list: UnderlayPlacement[] = [];
  const frame = app.anim.active ? currentFrame(app.currentClip(), app.anim.time) : null;
  if (frame) list.push(frame);
  else for (const u of app.doc.underlays) if (u.visible) list.push(u);
  // 位置合わせ中は、動かしている途中の位置で表示する
  const ut = app.toolId === 'underlay' ? (app.tools.underlay as unknown as { offset(): Vec | null; targetId(): string | null }) : null;
  for (const u of list) {
    const img = getImage(u.image, () => app.requestRender());
    if (!img) continue;
    const d = ut && ut.targetId() === u.id ? ut.offset() : null;
    ctx.save();
    ctx.globalAlpha = u.opacity;
    ctx.drawImage(img, u.x + (d?.x ?? 0), u.y + (d?.y ?? 0), u.w, u.h);
    ctx.restore();
  }
}

export interface DrawOpts {
  dpr: number;
  w: number;
  h: number;
}

export function drawScene(ctx: CanvasRenderingContext2D, app: App, view: View, o: DrawOpts) {
  const { dpr, w, h } = o;
  screenTransform(ctx, dpr);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, w, h);

  worldTransform(ctx, view, dpr);
  ctx.fillStyle = COLORS.board;
  ctx.fillRect(0, 0, app.doc.width, app.doc.height);
  drawGrid(ctx, app, view, w, h);
  ctx.strokeStyle = COLORS.boardEdge;
  ctx.lineWidth = 1 / view.zoom;
  ctx.strokeRect(0, 0, app.doc.width, app.doc.height);

  drawUnderlays(ctx, app);

  if (app.anim.active) {
    // アニメーション中：パーツごとにポーズの変換と不透明度をかけて描く
    const poses = app.poses();
    drawTree(ctx, view, app.doc.layers, poses, nodeStates(app.doc, poses), app.settings.showLines, o, 0);
    screenTransform(ctx, dpr);
    app.tool.overlay(ctx, view);
    return;
  }

  drawTree(ctx, view, app.doc.layers, new Map(), null, false, o, 0);

  const shapes = allShapes(app.doc);
  const sel = app.sel;
  const fullySelected = (s: Shape) => anchorKeys(s).every((k) => sel.has(ref(s.id, k)));
  if (app.settings.showLines) strokeShapes(ctx, view, shapes.filter((s) => !fullySelected(s)), COLORS.line);
  strokeShapes(ctx, view, shapes.filter(fullySelected), COLORS.lineSel, 2);

  screenTransform(ctx, dpr);
  drawOrigin(ctx, app, view);
  drawMirrorAxis(ctx, app, view, w, h);
  const showPoints = app.toolId === 'select' || app.toolId === 'move' || app.toolId === 'transform';
  if (showPoints) {
    for (const s of selectableShapes(app.doc)) {
      for (const k of anchorKeys(s)) {
        const p = getPoint(s, k)!;
        const isSel = sel.has(ref(s.id, k));
        const sp = view.toScreen(p);
        if (s.type === 'circle' && k === 'c') drawMarker(ctx, sp, 'diamond', isSel ? 5 : 4, isSel ? COLORS.pointSel : '#fff', isSel ? COLORS.pointSel : COLORS.point);
        else drawMarker(ctx, sp, 'square', isSel ? 4 : 3, isSel ? COLORS.pointSel : '#fff', isSel ? COLORS.pointSel : COLORS.point);
      }
      // 選択中の頂点のハンドル
      if (s.type === 'path') {
        s.nodes.forEach((n, i) => {
          if (!sel.has(ref(s.id, `n${i}`)) && !sel.has(ref(s.id, `i${i}`)) && !sel.has(ref(s.id, `o${i}`))) return;
          const a = view.toScreen(n);
          for (const [h, key] of [[n.hin, `i${i}`], [n.hout, `o${i}`]] as const) {
            if (!h) continue;
            const hs = view.toScreen(h);
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(hs.x, hs.y);
            ctx.strokeStyle = COLORS.handle; ctx.lineWidth = 1; ctx.stroke();
            const hsel = sel.has(ref(s.id, key));
            drawMarker(ctx, hs, 'circle', 4, hsel ? COLORS.handle : '#fff', COLORS.handle);
          }
        });
      }
    }
  }
  app.tool.overlay(ctx, view);

  // ミラー描画：作図中の線を軸の反対側にも薄く表示する
  const mirror = app.doc.mirror;
  if (mirror.axis !== 'none' && (app.toolId === 'line' || app.toolId === 'bezier' || app.toolId === 'circle' || app.toolId === 'freehand')) {
    const o = view.toScreen({ x: mirror.x, y: mirror.y });
    ctx.save();
    ctx.globalAlpha = 0.45;
    // 画面上で、軸の向き u の線について折り返す
    const u = mirrorDir(view, mirror.axis);
    const ra = 2 * u.x * u.x - 1, rb = 2 * u.x * u.y, rd = 2 * u.y * u.y - 1;
    ctx.setTransform(dpr * ra, dpr * rb, dpr * rb, dpr * rd, dpr * (o.x - ra * o.x - rb * o.y), dpr * (o.y - rb * o.x - rd * o.y));
    app.tool.overlay(ctx, view);
    ctx.restore();
  }
}

/** ミラーの軸が画面で向いている向き */
function mirrorDir(view: View, axis: 'vertical' | 'horizontal'): Vec {
  return view.dirToScreen(axis === 'vertical' ? { x: 0, y: 1 } : { x: 1, y: 0 });
}

function drawMirrorAxis(ctx: CanvasRenderingContext2D, app: App, view: View, w: number, h: number) {
  const m = app.doc.mirror;
  if (m.axis === 'none') return;
  const o = view.toScreen({ x: m.x, y: m.y });
  ctx.save();
  ctx.strokeStyle = COLORS.mirror;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([10, 4, 2, 4]);
  ctx.beginPath();
  const u = mirrorDir(view, m.axis), l = w + h;
  ctx.moveTo(o.x - u.x * l, o.y - u.y * l);
  ctx.lineTo(o.x + u.x * l, o.y + u.y * l);
  ctx.stroke();
  ctx.restore();
}
