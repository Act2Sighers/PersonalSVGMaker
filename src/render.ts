import type { App } from './app';
import type { View } from './view';
import type { Layer, Paint, Shape, Vec } from './types';
import { layerFaces } from './fills';
import { faceAt, traceFace, type Face } from './regions';
import { allShapes, anchorKeys, layerEntries, selectableShapes, getPoint, ref, shapePrims } from './doc';
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
  ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.panX, dpr * view.panY);
}

/** 画面座標系の上にワールド座標系を重ねて fn を実行（ツールの重ね描き用） */
export function inWorld(ctx: CanvasRenderingContext2D, view: View, fn: () => void) {
  ctx.save();
  ctx.transform(view.zoom, 0, 0, view.zoom, view.panX, view.panY);
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
  const tl = view.toWorld({ x: 0, y: 0 }), br = view.toWorld({ x: w, y: h });
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

  for (const e of layerEntries(app.doc)) if (e.visible) drawFills(ctx, e.layer);

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
  if (mirror.axis !== 'none' && (app.toolId === 'line' || app.toolId === 'bezier' || app.toolId === 'circle')) {
    const o = view.toScreen({ x: mirror.x, y: mirror.y });
    ctx.save();
    ctx.globalAlpha = 0.45;
    if (mirror.axis === 'vertical') ctx.setTransform(-dpr, 0, 0, dpr, 2 * o.x * dpr, 0);
    else ctx.setTransform(dpr, 0, 0, -dpr, 0, 2 * o.y * dpr);
    app.tool.overlay(ctx, view);
    ctx.restore();
  }
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
  if (m.axis === 'vertical') { ctx.moveTo(o.x, 0); ctx.lineTo(o.x, h); }
  else { ctx.moveTo(0, o.y); ctx.lineTo(w, o.y); }
  ctx.stroke();
  ctx.restore();
}
