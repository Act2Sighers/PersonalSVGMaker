import type { App } from './app';
import type { Doc, Paint, PointRef, Shape, Vec } from './types';
import { allLayers, anchorKeys, cloneShapes, parseRef, ref, transformPoints, transformShape } from './doc';
import { applyFill, layerFaces, transformPaint, type TransformHint } from './fills';
import { applyAffine, type Affine } from './geom';
import { faceAt } from './regions';

/** コピーした図形と、その図形だけで囲まれた範囲の塗り */
export interface ClipData {
  shapes: Shape[];
  fills: { seed: Vec; paint: Paint }[];
}

/** 選択した点を含む図形（図形ごと） */
export function selectedShapeIds(sel: Set<PointRef>): Set<string> {
  return new Set([...sel].map((r) => parseRef(r)[0]));
}

/** 全部の点が選ばれている図形 */
export function wholeSelectedShapes(doc: Doc, sel: Set<PointRef>): Set<string> {
  const out = new Set<string>();
  for (const l of allLayers(doc)) for (const s of l.shapes) if (anchorKeys(s).every((k) => sel.has(ref(s.id, k)))) out.add(s.id);
  return out;
}

export function copyData(doc: Doc, ids: Set<string>): ClipData | null {
  const shapes: Shape[] = [];
  const fills: ClipData['fills'] = [];
  for (const l of allLayers(doc)) {
    const picked = l.shapes.filter((s) => ids.has(s.id));
    if (!picked.length) continue;
    shapes.push(...structuredClone(picked));
    const faces = layerFaces(l);
    for (const f of l.fills) {
      const face = faceAt(faces, f.seed);
      if (face && [...face.sig].every((src) => ids.has(src.slice(0, src.lastIndexOf(':'))))) fills.push({ seed: f.seed, paint: f.paint });
    }
  }
  return shapes.length ? { shapes, fills } : null;
}

/** コピーした図形を変換 m をかけて描画先のレイヤーに置き、置いた図形を選択する */
export function placeClip(app: App, clip: ClipData, m: Affine): boolean {
  const layer = app.drawLayer();
  if (!layer) return false;
  const shapes = cloneShapes(clip.shapes);
  shapes.forEach((s) => transformShape(s, m));
  app.mutate(() => layer.shapes.push(...shapes), {
    after: () => {
      for (const f of clip.fills) applyFill(layer, applyAffine(m, f.seed), transformPaint(f.paint, m));
    },
  });
  app.sel = new Set(shapes.flatMap((s) => anchorKeys(s).map((k) => ref(s.id, k))));
  app.refreshUI();
  return true;
}

/** 選択した点を変換する。全体が選ばれた図形の塗り（グラデーション）も一緒に変換する。 */
export function transformSelection(app: App, m: Affine) {
  const hint: TransformHint = { m, shapes: wholeSelectedShapes(app.doc, app.sel) };
  app.mutate((d) => transformPoints(d, app.sel, m), { hint });
}
